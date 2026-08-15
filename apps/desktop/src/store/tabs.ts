import { store } from "@simplestack/store";
import { pathEquals } from "../lib/filePath";
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
