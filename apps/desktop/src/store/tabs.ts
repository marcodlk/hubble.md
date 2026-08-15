import { store } from "@simplestack/store";
import { isChangelogPath } from "../lib/changelogNote";
import { isEditableFile, pathEquals, replacePathPrefix } from "../lib/filePath";
import type { OpenTabsRecord } from "./persistence";
import {
	currentPathStore,
	type DocumentState,
	emptyDoc,
	getBaseline,
	viewerStore,
	workspaceStore,
} from "./state";

/**
 * Open notes as tabs, one visible at a time.
 *
 * The active tab has no buffer of its own: its document lives in
 * `appStore.document` (`viewerStore`), which stays the single source of truth
 * for everything the editor, toolbar and watchers read. Background tabs hold
 * their whole stashed `DocumentState` instead, so switching is a swap between
 * the active slice and a buffer.
 *
 * This module owns the bookkeeping only. Anything that has to save or load a
 * file (switching, closing) lives in actions.ts, the same way history.ts keeps
 * clear of `loadPath`.
 *
 * Invariant: a path is open in at most one tab.
 */

export type Tab = {
	id: string;
	/** `null` for the active tab, whose document lives in `viewerStore`. */
	buffer: DocumentState | null;
};

export type TabsState = {
	tabs: Tab[];
	activeTabId: string;
};

function createTabId() {
	return crypto.randomUUID();
}

function freshTab(): Tab {
	return { id: createTabId(), buffer: null };
}

const initialTab = freshTab();

// Not persisted as such: only the open paths are, per workspace, through
// `openTabsByWorkspace` below. Drafts and buffers never leave memory.
export const tabsStore = store<TabsState>({
	tabs: [initialTab],
	activeTabId: initialTab.id,
});

export const activeTabIdStore = tabsStore.select("activeTabId");

export function activeTabId() {
	return tabsStore.get().activeTabId;
}

/** The document a tab shows: the live active slice, or the tab's stash. */
export function documentForTab(id: string): DocumentState | null {
	const state = tabsStore.get();
	if (state.activeTabId === id) return viewerStore.get();
	return state.tabs.find((tab) => tab.id === id)?.buffer ?? null;
}

/** The tab holding `path`, or `null` when it is not open anywhere. */
export function tabForPath(path: string): string | null {
	const state = tabsStore.get();
	for (const tab of state.tabs) {
		const currentPath =
			tab.id === state.activeTabId
				? viewerStore.get().currentPath
				: (tab.buffer?.currentPath ?? null);
		if (currentPath && pathEquals(currentPath, path)) return tab.id;
	}
	return null;
}

export function isPathOpenInAnyTab(path: string): boolean {
	return tabForPath(path) !== null;
}

/**
 * The document showing `path`, wherever it lives: the active slice when the
 * focused tab holds it, otherwise the background tab's stash. Callers that
 * work on "the note at this path" use this instead of reading `viewerStore`,
 * so backgrounded notes stay first-class.
 */
export function getDocumentForPath(path: string): DocumentState | null {
	const active = viewerStore.get();
	if (active.currentPath && pathEquals(active.currentPath, path)) return active;
	const state = tabsStore.get();
	for (const tab of state.tabs) {
		if (tab.id === state.activeTabId) continue;
		const buffer = tab.buffer;
		if (buffer?.currentPath && pathEquals(buffer.currentPath, path)) {
			return buffer;
		}
	}
	return null;
}

/**
 * Rewrites whichever document shows `path`. The path is re-resolved at write
 * time, so a tab switch during an in-flight save lands the result on the tab
 * that now holds the note rather than on a stale slot.
 */
export function updateDocumentForPath(
	path: string,
	update: (document: DocumentState) => DocumentState,
) {
	const active = viewerStore.get();
	if (active.currentPath && pathEquals(active.currentPath, path)) {
		viewerStore.set((state) =>
			state.currentPath && pathEquals(state.currentPath, path)
				? update(state)
				: state,
		);
		return;
	}
	tabsStore.set((state) => {
		let changed = false;
		const tabs = state.tabs.map((tab) => {
			if (tab.id === state.activeTabId) return tab;
			const buffer = tab.buffer;
			if (!buffer?.currentPath || !pathEquals(buffer.currentPath, path)) {
				return tab;
			}
			changed = true;
			return { ...tab, buffer: update(buffer) };
		});
		return changed ? { ...state, tabs } : state;
	});
}

/** Every open tab's document: the active slice plus each background stash. */
export function openDocuments(): DocumentState[] {
	const state = tabsStore.get();
	return state.tabs.flatMap((tab) =>
		tab.id === state.activeTabId
			? [viewerStore.get()]
			: tab.buffer
				? [tab.buffer]
				: [],
	);
}

/** Every path open in a tab, in tab order. */
export function openTabPaths(): string[] {
	return openDocuments().flatMap((document) =>
		document.currentPath ? [document.currentPath] : [],
	);
}

/** Every background tab's path, in tab order. */
export function backgroundTabPaths(state = tabsStore.get()): string[] {
	return state.tabs.flatMap((tab) =>
		tab.id !== state.activeTabId && tab.buffer?.currentPath
			? [tab.buffer.currentPath]
			: [],
	);
}

/**
 * Points background stashes at a note's new location after a rename or move,
 * the way the active document's paths are rewritten in place. With `isFolder`,
 * rewrites the prefix of every path inside the folder.
 */
export function rewriteTabBufferPaths(
	fromPath: string,
	toPath: string,
	isFolder = false,
) {
	const rewrite = (path: string | null) => {
		if (!path) return path;
		if (isFolder) return replacePathPrefix(path, fromPath, toPath);
		return pathEquals(path, fromPath) ? toPath : path;
	};
	tabsStore.set((state) => {
		let changed = false;
		const tabs = state.tabs.map((tab) => {
			const buffer = tab.buffer;
			if (tab.id === state.activeTabId || !buffer) return tab;
			const currentPath = rewrite(buffer.currentPath);
			const lastOpenedPath = rewrite(buffer.lastOpenedPath);
			if (
				currentPath === buffer.currentPath &&
				lastOpenedPath === buffer.lastOpenedPath
			) {
				return tab;
			}
			changed = true;
			return { ...tab, buffer: { ...buffer, currentPath, lastOpenedPath } };
		});
		return changed ? { ...state, tabs } : state;
	});
}

/** Every background tab's stashed document, paired with its tab id. */
export function backgroundBuffers(): { id: string; buffer: DocumentState }[] {
	const state = tabsStore.get();
	return state.tabs.flatMap((tab) =>
		tab.id === state.activeTabId || !tab.buffer
			? []
			: [{ id: tab.id, buffer: tab.buffer }],
	);
}

/** Appends an empty tab without activating it. Returns its id. */
export function addTab(): string {
	const tab = freshTab();
	tabsStore.set((state) => ({ ...state, tabs: [...state.tabs, tab] }));
	return tab.id;
}

/**
 * Stashes the active document into its tab and restores `id`'s document into
 * the active slice. Returns the restored document, or `null` when `id` is
 * already active or unknown.
 */
export function activateTab(id: string): DocumentState | null {
	const state = tabsStore.get();
	if (state.activeTabId === id) return null;
	const target = state.tabs.find((tab) => tab.id === id);
	if (!target) return null;

	const outgoing = viewerStore.get();
	const restored = target.buffer ?? emptyDoc(outgoing.lastOpenedPath);
	tabsStore.set({
		activeTabId: id,
		tabs: state.tabs.map((tab) =>
			tab.id === state.activeTabId
				? { ...tab, buffer: outgoing }
				: tab.id === id
					? { ...tab, buffer: null }
					: tab,
		),
	});
	viewerStore.set(restored);
	return restored;
}

/**
 * Whether a document's text can be written back to its file. Read-only notes
 * (the changelog, images, PDFs) have no draft to save, and a conflicted note
 * needs the user to resolve it before anything is written.
 */
export function isSavableDoc(doc: DocumentState): doc is DocumentState & {
	currentPath: string;
} {
	return (
		doc.currentPath !== null &&
		!isChangelogPath(doc.currentPath) &&
		isEditableFile(doc.currentPath) &&
		doc.externalChange.kind !== "conflict"
	);
}

/** What a tab advertises about its document beside the file name. */
export type TabIndicator = "none" | "dirty" | "conflict";

/**
 * The badge a tab shows for its document. A conflict outranks a dirty draft:
 * the note changed on disk *and* in the editor, and the conflict is the state
 * the user has to resolve.
 */
export function documentIndicator(
	document: DocumentState | null | undefined,
): TabIndicator {
	if (!document) return "none";
	if (document.externalChange.kind === "conflict") return "conflict";
	// Read-only notes have no draft to lose, so they never look dirty.
	if (!isSavableDoc(document)) return "none";
	return document.content === getBaseline(document) ? "none" : "dirty";
}

/**
 * The tab `offset` places from the active one, wrapping at both ends. Returns
 * `null` when there is nothing to move to.
 */
export function tabIdAtOffset(
	offset: number,
	state = tabsStore.get(),
): string | null {
	const { tabs, activeTabId } = state;
	if (tabs.length < 2) return null;
	const index = tabs.findIndex((tab) => tab.id === activeTabId);
	if (index === -1) return null;
	const next = (index + (offset % tabs.length) + tabs.length) % tabs.length;
	return tabs[next].id;
}

/**
 * The tab a number shortcut selects. Slots are 1-based, and slot 9 means "the
 * last tab" however many are open, the way browsers treat Cmd+9.
 */
export function tabIdForSlot(
	slot: number,
	state = tabsStore.get(),
): string | null {
	const { tabs } = state;
	if (slot === 9) return tabs[tabs.length - 1]?.id ?? null;
	return tabs[slot - 1]?.id ?? null;
}

export type TabRemoval = {
	/** The tab left active afterwards. */
	activeTabId: string;
	/** Set when the active slice was replaced, so callers can react to it. */
	restored: DocumentState | null;
};

/**
 * Removes a tab. Closing the active tab activates its right neighbor, or its
 * left one at the end. Closing the last tab keeps a single empty tab so the app
 * lands on the open-file/welcome state rather than a tabless void.
 */
export function removeTab(id: string): TabRemoval | null {
	const state = tabsStore.get();
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index === -1) return null;
	const wasActive = state.activeTabId === id;
	const remaining = state.tabs.filter((tab) => tab.id !== id);

	if (remaining.length === 0) {
		const tab = freshTab();
		const restored = emptyDoc(viewerStore.get().lastOpenedPath);
		tabsStore.set({ tabs: [tab], activeTabId: tab.id });
		viewerStore.set(restored);
		return { activeTabId: tab.id, restored };
	}

	if (!wasActive) {
		tabsStore.set({ ...state, tabs: remaining });
		return { activeTabId: state.activeTabId, restored: null };
	}

	const next = remaining[Math.min(index, remaining.length - 1)];
	const restored = next.buffer ?? emptyDoc(viewerStore.get().lastOpenedPath);
	tabsStore.set({
		activeTabId: next.id,
		tabs: remaining.map((tab) =>
			tab.id === next.id ? { ...tab, buffer: null } : tab,
		),
	});
	viewerStore.set(restored);
	return { activeTabId: next.id, restored };
}

/**
 * Drops every tab for a single fresh one. Buffers are discarded, so callers
 * that could lose edits must save first.
 */
export function resetTabs(): string {
	const tab = freshTab();
	tabsStore.set({ tabs: [tab], activeTabId: tab.id });
	return tab.id;
}

/**
 * Replaces the tab set with one tab per document, in order, showing the one at
 * `activeIndex`. Used to rebuild a recorded tab set at startup or on a
 * workspace switch; the caller owns the histories and the disk reads.
 * Returns the new tab ids, in the same order as `documents`.
 */
export function installTabs(
	documents: DocumentState[],
	activeIndex: number,
): string[] {
	if (documents.length === 0) return [resetTabs()];
	const index = Math.min(Math.max(activeIndex, 0), documents.length - 1);
	const tabs = documents.map((document, position) => ({
		id: createTabId(),
		buffer: position === index ? null : document,
	}));
	tabsStore.set({ tabs, activeTabId: tabs[index].id });
	viewerStore.set(documents[index]);
	return tabs.map((tab) => tab.id);
}

// ── Per-workspace open tab sets ─────────────────────────────────────
//
// The open paths of the current workspace are mirrored into the persisted
// `workspace.openTabsByWorkspace` so a relaunch, or a return to the workspace,
// reopens the same notes. A subscription recomputes the record from the tabs
// rather than each mutation reporting itself: renames, folder moves and
// deletes already rewrite buffers and the active document, so a recompute
// picks all of them up with no seam left to forget.

/**
 * The paths open right now, and which of them is on screen. A tab showing
 * nothing to reopen (an empty tab, the changelog) leaves the record pointing at
 * the first tab instead.
 */
function currentOpenTabsRecord(): OpenTabsRecord {
	const state = tabsStore.get();
	const paths: string[] = [];
	let activeIndex = 0;
	for (const tab of state.tabs) {
		const isActive = tab.id === state.activeTabId;
		const path = isActive
			? viewerStore.get().currentPath
			: (tab.buffer?.currentPath ?? null);
		// Empty tabs and the virtual changelog are not files to reopen.
		if (!path || isChangelogPath(path)) continue;
		if (isActive) activeIndex = paths.length;
		paths.push(path);
	}
	return { paths, activeIndex };
}

function sameRecord(a: OpenTabsRecord | undefined, b: OpenTabsRecord) {
	return (
		a !== undefined &&
		a.activeIndex === b.activeIndex &&
		a.paths.length === b.paths.length &&
		a.paths.every((path, index) => path === b.paths[index])
	);
}

// Recording starts off. Between module load and the app settling onto its
// opening tab set, the tabs on screen are the app booting, not the user's
// session: recording them would erase the very record startup restores from.
let recordingSuppressed = true;

/**
 * Writes the current tab set into the active workspace's record. Loose files
 * opened without a workspace are not recorded: `lastOpenedPath` already brings
 * the single note back.
 */
export function recordOpenTabs() {
	if (recordingSuppressed) return;
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	const record = currentOpenTabsRecord();
	workspaceStore.set((state) => {
		if (state.workspacePath !== workspacePath) return state;
		const existing = state.openTabsByWorkspace[workspacePath];
		if (record.paths.length === 0) {
			if (!existing) return state;
			// No open notes is not a tab set worth restoring: forget it so the
			// workspace falls back to its last opened note.
			const { [workspacePath]: _dropped, ...rest } = state.openTabsByWorkspace;
			return { ...state, openTabsByWorkspace: rest };
		}
		if (sameRecord(existing, record)) return state;
		return {
			...state,
			openTabsByWorkspace: {
				...state.openTabsByWorkspace,
				[workspacePath]: record,
			},
		};
	});
}

/**
 * Declares the tabs on screen to be the user's session, and records them.
 * Called once the app has settled onto its opening tab set, and again whenever
 * a workspace switch has settled onto the next one.
 */
export function beginOpenTabsRecording() {
	recordingSuppressed = false;
	recordOpenTabs();
}

/**
 * Runs a workspace transition with recording off. Tearing the tabs down and
 * building the next workspace's back up passes through states that belong to
 * neither workspace, and recording those would overwrite the record the
 * transition is about to restore from.
 */
export async function withOpenTabsRecordingSuppressed<T>(
	run: () => Promise<T>,
): Promise<T> {
	const wasSuppressed = recordingSuppressed;
	recordingSuppressed = true;
	try {
		return await run();
	} finally {
		recordingSuppressed = wasSuppressed;
	}
}

let recordScheduled = false;

/**
 * Records on a microtask so a multi-step change (stash a buffer, then swap the
 * active document) is written once, and so the write happens outside the
 * subscription that triggered it rather than inside the store's own graph.
 */
function scheduleRecordOpenTabs() {
	if (recordScheduled) return;
	recordScheduled = true;
	queueMicrotask(() => {
		recordScheduled = false;
		recordOpenTabs();
	});
}

// Both halves of a tab's identity move independently: the active note changes
// in `viewerStore`, everything else in `tabsStore`.
tabsStore.subscribe(scheduleRecordOpenTabs);
currentPathStore.subscribe(scheduleRecordOpenTabs);
