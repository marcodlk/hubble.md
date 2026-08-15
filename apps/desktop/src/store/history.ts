import { isChangelogPath } from "../lib/changelogNote";
import { pathInFolder, replacePathPrefix } from "../lib/filePath";
import {
	currentPathStore,
	type HistoryStack,
	type HistoryState,
	historyStore,
	MAX_HISTORY,
} from "./state";
import { activeTabId } from "./tabs";

/**
 * Per-tab back/forward stacks over opened file paths.
 *
 * Each tab navigates on its own, like a browser tab, so the stack is keyed by
 * tab id rather than by workspace. Switching workspaces resets the tabs, which
 * drops their stacks with them.
 *
 * This module owns reads and writes of `historyStore`. Navigation itself
 * (save current doc, load target) lives in actions.ts to avoid an import
 * cycle with `loadPath`.
 */

/** Clamps a persisted or edited stack so `index` always points at an entry. */
export function normalizeStack(stack?: HistoryStack): HistoryStack {
	if (!stack || stack.entries.length === 0) {
		return { entries: [], index: -1 };
	}
	return {
		entries: stack.entries,
		index: Math.min(Math.max(stack.index, 0), stack.entries.length - 1),
	};
}

function stackFor(history: HistoryState, tabId: string) {
	return normalizeStack(history.byTab[tabId]);
}

/** The active tab's stack. */
export function activeHistory() {
	return stackFor(historyStore.get(), activeTabId());
}

/** Replaces the active tab's stack. */
export function setHistory(stack: HistoryStack) {
	const key = activeTabId();
	historyStore.set((state) => ({
		...state,
		byTab: { ...state.byTab, [key]: stack },
	}));
}

/**
 * Records a visit: drops any forward entries, appends `path`, and trims to
 * `MAX_HISTORY`. No-op when `path` is already the current entry.
 */
export function pushHistory(path: string) {
	const stack = activeHistory();
	if (stack.entries[stack.index] === path) return;
	const entries = [...stack.entries.slice(0, stack.index + 1), path].slice(
		-MAX_HISTORY,
	);
	setHistory({ entries, index: entries.length - 1 });
}

/** Empties the active tab's stack. */
export function clearHistory() {
	setHistory({ entries: [], index: -1 });
}

/** Forgets a closed tab's stack. */
export function dropTabHistory(tabId: string) {
	historyStore.set((state) => {
		if (!(tabId in state.byTab)) return state;
		const byTab = { ...state.byTab };
		delete byTab[tabId];
		return { ...state, byTab };
	});
}

/** Empties every tab's stack. */
export function resetHistory() {
	historyStore.set((state) => ({ ...state, byTab: {} }));
}

/** Applies `update` to every tab's stack, normalizing around it. */
function mapHistory(update: (stack: HistoryStack) => HistoryStack) {
	historyStore.set((state) => ({
		...state,
		byTab: Object.fromEntries(
			Object.entries(state.byTab).map(([key, stack]) => [
				key,
				normalizeStack(update(normalizeStack(stack))),
			]),
		),
	}));
}

/**
 * Points history at a file's new location after a rename or move so back and
 * forward keep working. With `isFolder`, rewrites the path prefix of every
 * entry inside the folder. Runs across all tabs because a rename can touch
 * paths recorded in another tab's stack.
 */
export function rewriteHistory(
	fromPath: string,
	toPath: string,
	isFolder = false,
) {
	mapHistory((stack) => ({
		...stack,
		entries: stack.entries.map((entry) =>
			isFolder
				? replacePathPrefix(entry, fromPath, toPath)
				: entry === fromPath
					? toPath
					: entry,
		),
	}));
}

/**
 * Drops a deleted file (or with `isFolder`, a folder's contents) from every
 * stack. Keeps the index on the current entry when it survives; otherwise
 * clamps toward the nearest remaining entry.
 */
export function pruneHistory(path: string, isFolder = false) {
	mapHistory((stack) => {
		const current = stack.entries[stack.index];
		const entries = stack.entries.filter((entry) =>
			isFolder ? !pathInFolder(entry, path) : entry !== path,
		);
		const keptIndex = current ? entries.indexOf(current) : -1;
		return {
			entries,
			index:
				keptIndex >= 0 ? keptIndex : Math.min(stack.index, entries.length - 1),
		};
	});
}

export function canGoBack(
	history = historyStore.get(),
	tabId = activeTabId(),
	onChangelog = isChangelogPath(currentPathStore.get()),
) {
	const stack = stackFor(history, tabId);
	// The changelog note is never pushed, so back means "return to the current
	// entry" and stays enabled whenever one exists.
	if (onChangelog) return stack.index >= 0;
	return stack.index > 0;
}

export function canGoForward(
	history = historyStore.get(),
	tabId = activeTabId(),
	onChangelog = isChangelogPath(currentPathStore.get()),
) {
	if (onChangelog) return false;
	const { index, entries } = stackFor(history, tabId);
	return index >= 0 && index < entries.length - 1;
}
