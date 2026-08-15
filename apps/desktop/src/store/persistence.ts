import { type CommandBindings, cleanCommandBindings } from "@hubble.md/editor";
import type { ThemePreference } from "../theme";
import { DEFAULT_CHAT_COMMAND } from "./settings";
import {
	emptyDoc,
	type FileEntry,
	type FolderEntry,
	type SortMode,
} from "./state";

/**
 * A workspace's open tabs, as paths only. Drafts, conflicts and per-tab history
 * stay in memory: a relaunch reopens the notes, not the unsaved session.
 */
export type OpenTabsRecord = {
	paths: string[];
	activeIndex: number;
};

type WorkspaceState = {
	workspacePath: string | null;
	recentWorkspaces: string[];
	lastOpenedPaths: Record<string, string>;
	openTabsByWorkspace: Record<string, OpenTabsRecord>;
	sortMode: SortMode;
	files: FileEntry[];
	folders: FolderEntry[];
	pinnedNotes: string[];
};

type DocumentState = ReturnType<typeof emptyDoc>;

export type TerminalPosition = "bottom" | "right";

type UiState = {
	sidebarOpen: boolean;
	isSwitcherOpen: boolean;
	isTerminalOpen: boolean;
	terminalPosition: TerminalPosition;
	pendingTerminalCommand: string | null;
};

type SettingsState = {
	chatCommand: string;
	codeFileOpenMode: CodeFileOpenMode;
	lastSeenVersion: string | null;
	shortcutBindings: CommandBindings;
	theme: ThemePreference;
};

export type CodeFileOpenMode = "hubble" | "default-app";

export type DesktopState = {
	workspace: WorkspaceState;
	document: DocumentState;
	ui: UiState;
	settings: SettingsState;
};

type Persisted = {
	workspace?: {
		workspacePath?: string | null;
		recentWorkspaces?: string[];
		lastOpenedPaths?: Record<string, string>;
		openTabsByWorkspace?: Record<string, OpenTabsRecord>;
		sortMode?: SortMode;
	};
	document?: { lastOpenedPath?: string | null };
	ui?: {
		sidebarOpen?: boolean;
		isTerminalOpen?: boolean;
		terminalPosition?: TerminalPosition;
	};
	settings?: {
		chatCommand?: string;
		codeFileOpenMode?: CodeFileOpenMode;
		lastSeenVersion?: string | null;
		shortcutBindings?: unknown;
		theme?: ThemePreference;
	};
};

export const STORAGE_KEY = "hubble-desktop-app";

function readStorage<T>(key: string): T | null {
	if (typeof localStorage === "undefined") return null;

	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Rebuilds the per-workspace tab sets from storage. Anything malformed is
 * dropped rather than trusted: a bad entry would otherwise reopen the app onto
 * a broken tab set with no way back.
 */
function hydrateOpenTabs(value: unknown): Record<string, OpenTabsRecord> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const records: Record<string, OpenTabsRecord> = {};
	for (const [workspacePath, record] of Object.entries(value)) {
		if (!record || typeof record !== "object" || Array.isArray(record))
			continue;
		const { paths, activeIndex } = record as {
			paths?: unknown;
			activeIndex?: unknown;
		};
		if (!Array.isArray(paths)) continue;
		const openPaths = paths.filter(
			(path): path is string => typeof path === "string" && path.length > 0,
		);
		const index = Number.isInteger(activeIndex) ? (activeIndex as number) : 0;
		// An empty set is kept: it says the workspace was left with nothing open,
		// which is a session to restore rather than a record to ignore.
		records[workspacePath] = {
			paths: openPaths,
			activeIndex: openPaths.length
				? Math.min(Math.max(index, 0), openPaths.length - 1)
				: 0,
		};
	}
	return records;
}

function hydrateWorkspace(ws: Persisted["workspace"]): WorkspaceState {
	return {
		workspacePath: ws?.workspacePath ?? null,
		recentWorkspaces: Array.isArray(ws?.recentWorkspaces)
			? ws.recentWorkspaces
			: [],
		lastOpenedPaths:
			ws?.lastOpenedPaths &&
			typeof ws.lastOpenedPaths === "object" &&
			!Array.isArray(ws.lastOpenedPaths)
				? ws.lastOpenedPaths
				: {},
		openTabsByWorkspace: hydrateOpenTabs(ws?.openTabsByWorkspace),
		sortMode: ws?.sortMode === "alpha" ? "alpha" : "recent",
		files: [],
		folders: [],
		pinnedNotes: [],
	};
}

export function getInitialState(): DesktopState {
	const p = readStorage<Persisted>(STORAGE_KEY);
	return {
		workspace: hydrateWorkspace(p?.workspace),
		document: emptyDoc(p?.document?.lastOpenedPath ?? null),
		ui: {
			sidebarOpen: p?.ui?.sidebarOpen ?? false,
			isSwitcherOpen: false,
			isTerminalOpen: p?.ui?.isTerminalOpen ?? false,
			terminalPosition:
				p?.ui?.terminalPosition === "right" ? "right" : "bottom",
			pendingTerminalCommand: null,
		},
		settings: {
			chatCommand:
				typeof p?.settings?.chatCommand === "string"
					? p.settings.chatCommand
					: DEFAULT_CHAT_COMMAND,
			codeFileOpenMode:
				p?.settings?.codeFileOpenMode === "default-app"
					? "default-app"
					: "hubble",
			// A missing field on an existing install means the user updated from
			// a release that predates version tracking: treat the running version
			// as news. Only a truly fresh install starts at null (no callout).
			lastSeenVersion:
				typeof p?.settings?.lastSeenVersion === "string"
					? p.settings.lastSeenVersion
					: p
						? ""
						: null,
			shortcutBindings: cleanCommandBindings(p?.settings?.shortcutBindings),
			theme:
				p?.settings?.theme === "light" || p?.settings?.theme === "dark"
					? p.settings.theme
					: "system",
		},
	};
}

export function serialize(state: DesktopState): Persisted {
	return {
		workspace: {
			workspacePath: state.workspace.workspacePath,
			recentWorkspaces: state.workspace.recentWorkspaces,
			lastOpenedPaths: state.workspace.lastOpenedPaths,
			openTabsByWorkspace: state.workspace.openTabsByWorkspace,
			sortMode: state.workspace.sortMode,
		},
		document: {
			lastOpenedPath: state.document.lastOpenedPath,
		},
		ui: {
			sidebarOpen: state.ui.sidebarOpen,
			isTerminalOpen: state.ui.isTerminalOpen,
			terminalPosition: state.ui.terminalPosition,
		},
		settings: {
			chatCommand: state.settings.chatCommand,
			codeFileOpenMode: state.settings.codeFileOpenMode,
			lastSeenVersion: state.settings.lastSeenVersion,
			shortcutBindings: state.settings.shortcutBindings,
			theme: state.settings.theme,
		},
	};
}
