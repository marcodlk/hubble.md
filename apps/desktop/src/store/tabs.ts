import { store } from "@simplestack/store";
import { pathEquals, replacePathPrefix } from "../lib/filePath";
import { type DocumentState, emptyDoc, viewerStore } from "./state";

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

// Not persisted: a relaunch restores the last active note only (slice 1).
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
