import { useStoreValue } from "@simplestack/store/react";
import { isChangelogPath } from "../lib/changelogNote";
import { isEditableFile } from "../lib/filePath";
import { canGoBack, canGoForward } from "./history";
import { currentPathStore, historyStore } from "./state";
import { activeTabIdStore, backgroundTabPaths, tabsStore } from "./tabs";

// Back/forward enablement depends on two stores: the history stacks and the
// active tab that picks the stack. Boolean selectors re-render callers only
// when enablement actually flips.
export function useHistoryNav() {
	const activeTabId = useStoreValue(activeTabIdStore);
	const onChangelog = useStoreValue(currentPathStore, isChangelogPath);
	return {
		canGoBack: useStoreValue(historyStore, (history) =>
			canGoBack(history, activeTabId, onChangelog),
		),
		canGoForward: useStoreValue(historyStore, (history) =>
			canGoForward(history, activeTabId, onChangelog),
		),
	};
}

/** Only editable text files participate in external-change conflict handling. */
function isWatchable(path: string | null | undefined): path is string {
	return !!path && !isChangelogPath(path) && isEditableFile(path);
}

export const WATCHED_PATH_SEPARATOR = "\n";

/**
 * Sorted and de-duplicated, so the key names the *set* of watched notes rather
 * than an arrangement of it. Switching tabs only moves a path between the
 * active slice and a buffer, which must not read as a different set.
 */
function watchedPathsKey(paths: (string | null | undefined)[]): string {
	return [...new Set(paths.filter(isWatchable))]
		.sort()
		.join(WATCHED_PATH_SEPARATOR);
}

/**
 * Every open tab's watchable note path. Returned as one separator-joined
 * string rather than an array so the watcher effect compares by value and
 * re-subscribes only when the set of notes itself changes, not on every tab
 * switch: tearing down every watcher to rebuild the same ones leaves a window
 * where an external edit goes unseen.
 */
export function useWatchedPathsKey(): string {
	const activePath = useStoreValue(currentPathStore);
	const backgroundKey = useStoreValue(tabsStore, (state) =>
		watchedPathsKey(backgroundTabPaths(state)),
	);
	return watchedPathsKey([
		activePath,
		...(backgroundKey ? backgroundKey.split(WATCHED_PATH_SEPARATOR) : []),
	]);
}
