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
 * Every open tab's watchable note path, active tab first. Returned as one
 * separator-joined string rather than an array so the watcher effect compares
 * by value and re-subscribes only when the set of notes itself changes.
 */
export function useWatchedPathsKey(): string {
	const activePath = useStoreValue(currentPathStore);
	const backgroundKey = useStoreValue(tabsStore, (state) =>
		backgroundTabPaths(state).filter(isWatchable).join(WATCHED_PATH_SEPARATOR),
	);
	const active = isWatchable(activePath) ? activePath : null;
	return [active, backgroundKey]
		.filter((part) => !!part)
		.join(WATCHED_PATH_SEPARATOR);
}
