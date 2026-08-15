import {
	type CommandBindings,
	type CommandId,
	isDefaultCommandBinding,
	setCommandBindings,
} from "@hubble.md/editor";
import type { ReviewThread } from "@hubble.md/ui";
import { toast } from "sonner";
import changelogRaw from "../../../../CHANGELOG.md?raw";
import { desktopApi } from "../desktopApi";
import type { TelemetryChoice, WorkspaceDelta } from "../desktopApi/types";
import { classifyFileChange } from "../externalFileChange";
import {
	CHANGELOG_PATH,
	isChangelogPath,
	prepareChangelogMarkdown,
} from "../lib/changelogNote";
import { keyedQueue, takeLatest } from "../lib/concurrency";
import {
	absoluteWorkspacePath,
	basename,
	dirname,
	extname,
	fileKindForPath,
	fileStem,
	hasHtmlExtension,
	hasMarkdownExtension,
	isCodeFile,
	isEditableFile,
	joinPath,
	markdownAssetFolderPath,
	normalizePath,
	pathEquals,
	pathInFolder,
	relativeWorkspacePath,
	replacePathPrefix,
} from "../lib/filePath";
import {
	indexMovedFiles,
	type MovedFile,
	movedMarkdownFiles,
	pathAfterMove,
	rewriteMovedLinks,
} from "../lib/markdownLinkRewrite";
import {
	setThemePreference as applyThemePreference,
	initTheme,
	type ThemePreference,
} from "../theme";
import { createDeleteActions } from "./deleteActions";
import {
	activeHistory,
	canGoBack,
	canGoForward,
	dropTabHistory,
	normalizeStack,
	pushHistory,
	resetHistory,
	rewriteHistory,
	seedTabHistory,
	setHistory,
} from "./history";
import type { CodeFileOpenMode, TerminalPosition } from "./persistence";
import { DEFAULT_CHAT_COMMAND } from "./settings";
import {
	applyFileAction,
	appStore,
	chatCommandStore,
	cleanFileState,
	codeFileOpenModeStore,
	type DocumentState,
	emptyDoc,
	type FileEntry,
	type FolderEntry,
	getBaseline,
	historyStore,
	isInWorkspace,
	LOADING_DELAY_MS,
	lastSeenVersionStore,
	MAX_RECENT,
	pendingTerminalCommandStore,
	reviewThreadsStore,
	type SortMode,
	shortcutBindingsStore,
	sidebarOpenStore,
	spellcheckStore,
	switcherOpenStore,
	telemetryConsentStore,
	themePreferenceStore,
	uiStore,
	type ViewMode,
	viewerStore,
	withOpenedDoc,
	workspaceStore,
} from "./state";
import {
	activateTab,
	addTab,
	backgroundBuffers,
	beginOpenTabsRecording,
	documentForTab,
	getDocumentForPath,
	installTabs,
	isSavableDoc,
	openDocuments,
	openTabPaths,
	recordOpenTabs,
	removeTab,
	resetTabs,
	rewriteTabBufferPaths,
	tabForPath,
	tabIdAtOffset,
	tabIdForSlot,
	tabsStore,
	updateDocumentForPath,
	withOpenTabsRecordingSuppressed,
} from "./tabs";
import { createTitleManager } from "./titleManagement";
import { applyWorkspaceDelta } from "./workspaceDelta";

const REFRESH_FILES_DEBOUNCE_MS = 250;
const SELF_SAVE_TTL_MS = 5000;
const missingPathErrorPattern = /\bENOENT\b|\bENOTDIR\b/;
let refreshFilesTimer: ReturnType<typeof setTimeout> | null = null;
type RefreshRun = {
	reloadActive: boolean;
	promise: Promise<void>;
};
const refreshFilesInFlight = new Map<string, RefreshRun>();
const workspaceSidebarQueues = new Map<string, Promise<void>>();
// The active-file watcher also sees Hubble's own writes. If save A reaches disk
// after the editor already has draft B, that watcher event is not an external
// conflict; it is just the disk baseline catching up to a save we started.
const selfSaves = new Map<string, Map<string, number>>();
const saves = keyedQueue<string>();

type SidebarMoveItem =
	| { kind: "file"; path: string }
	| { kind: "folder"; folderId: string };

function enqueueWorkspaceSidebarUpdate(
	workspacePath: string,
	update: () => Promise<void>,
) {
	const previous = workspaceSidebarQueues.get(workspacePath);
	const updatePromise = previous ? previous.then(update) : update();
	const queue = updatePromise.catch((error) => {
		console.error("Workspace sidebar update failed:", error);
	});
	workspaceSidebarQueues.set(workspacePath, queue);
	void queue.then(() => {
		if (workspaceSidebarQueues.get(workspacePath) === queue) {
			workspaceSidebarQueues.delete(workspacePath);
		}
	});
	return updatePromise;
}

async function refreshFilesNow(
	path: string,
	options: { reloadActive: boolean },
) {
	let listing: { files: FileEntry[]; folders: FolderEntry[] };
	try {
		listing = await desktopApi.listDirectory(path);
	} catch (err) {
		toast.error("Failed to refresh folder", {
			description: errorMessage(err),
		});
		return;
	}
	workspaceStore.set((state) => {
		if (state.workspacePath !== path) return state;
		return { ...state, files: listing.files, folders: listing.folders };
	});

	if (!options.reloadActive || workspaceStore.get().workspacePath !== path) {
		return;
	}
	// Every open note is stale after a refresh, not just the focused one, so a
	// background tab shows the current file when the user switches to it.
	const activePath = viewerStore.get().currentPath;
	for (const openPath of openTabPaths()) {
		if (
			isChangelogPath(openPath) ||
			!isEditableFile(openPath) ||
			!isInWorkspace(openPath, path)
		) {
			continue;
		}
		try {
			const nextContent = await desktopApi.readFileText(openPath);
			handleExternalFileChange(openPath, nextContent);
		} catch (err) {
			if (openPath === activePath) {
				toast.error("Failed to refresh active note", {
					description: errorMessage(err),
				});
			} else {
				console.error(`Failed to refresh ${openPath}:`, err);
			}
		}
	}
}

export async function refreshFiles(
	path = workspaceStore.get().workspacePath,
	options?: { reloadActive?: boolean },
) {
	if (!path) return;
	const pending = refreshFilesInFlight.get(path);
	if (pending) {
		// A full refresh must not lose the active-note reload by joining a list-only one.
		pending.reloadActive ||= options?.reloadActive !== false;
		return pending.promise;
	}

	const run: RefreshRun = {
		reloadActive: options?.reloadActive !== false,
		promise: Promise.resolve(),
	};
	run.promise = enqueueWorkspaceSidebarUpdate(path, () =>
		refreshFilesNow(path, run),
	);
	refreshFilesInFlight.set(path, run);
	try {
		await run.promise;
	} finally {
		refreshFilesInFlight.delete(path);
	}
}

// Mutations already update or clear the active document themselves.
export function refreshFileList(path = workspaceStore.get().workspacePath) {
	return refreshFiles(path, { reloadActive: false });
}

export async function reconcileWorkspacePath(
	workspacePath: string,
	changedPath: string,
) {
	return enqueueWorkspaceSidebarUpdate(workspacePath, async () => {
		let delta: WorkspaceDelta | null;
		try {
			delta = await desktopApi.sidebarDeltaForPath(workspacePath, changedPath);
		} catch {
			return;
		}
		if (!delta || workspaceStore.get().workspacePath !== workspacePath) return;
		if (delta.kind === "refresh") {
			await refreshFilesNow(workspacePath, { reloadActive: false });
			return;
		}
		workspaceStore.set((state) => {
			if (state.workspacePath !== workspacePath) return state;
			const nextSidebar = applyWorkspaceDelta(state, delta);
			return { ...state, ...nextSidebar };
		});
	});
}
/**
 * Debounced wrapper for event-driven sidebar refreshes.
 *
 * Keep `refreshFiles()` immediate for user actions that await a fresh snapshot.
 * Prefer debounced for refreshes triggered by effects.
 */
export function refreshFilesDebounced(
	path = workspaceStore.get().workspacePath,
) {
	if (!path) return;
	if (refreshFilesTimer !== null) clearTimeout(refreshFilesTimer);
	refreshFilesTimer = setTimeout(() => {
		refreshFilesTimer = null;
		void refreshFiles(path);
	}, REFRESH_FILES_DEBOUNCE_MS);
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

function refreshFilesAfterMissingPath(message: string) {
	if (!missingPathErrorPattern.test(message)) return;
	// Missing files usually mean the sidebar snapshot is stale because Hubble no
	// longer watches the whole workspace.
	refreshFilesDebounced();
}

function handleFileError(err: unknown) {
	const message = errorMessage(err);
	refreshFilesAfterMissingPath(message);
	return message;
}

function pruneSelfSaves(path: string, now = Date.now()) {
	const contents = selfSaves.get(path);
	if (!contents) return;
	for (const [content, expiresAt] of contents) {
		if (expiresAt <= now) contents.delete(content);
	}
	if (contents.size === 0) selfSaves.delete(path);
}

function rememberSelfSave(path: string, content: string) {
	pruneSelfSaves(path);
	const contents = selfSaves.get(path) ?? new Map<string, number>();
	contents.set(content, Date.now() + SELF_SAVE_TTL_MS);
	selfSaves.set(path, contents);
}

function isSelfSave(path: string, content: string) {
	pruneSelfSaves(path);
	return selfSaves.get(path)?.has(content) ?? false;
}

function selfSaveState(editorContent: string, diskContent: string) {
	if (editorContent === diskContent) {
		return cleanFileState(diskContent);
	}
	// Keep newer editor text intact while acknowledging that an older self-save
	// is now the latest content known to be on disk.
	return {
		diskContent,
		externalChange: { kind: "none" as const },
		status: "ready" as const,
		error: null,
	};
}

function pathStartsWithFolder(filePath: string, folderPath: string): boolean {
	return pathEquals(filePath, folderPath) || pathInFolder(filePath, folderPath);
}

function moveAffectsPath(path: string, sourcePath: string, isFolder: boolean) {
	return isFolder
		? pathStartsWithFolder(path, sourcePath)
		: pathEquals(path, sourcePath);
}

/** Open notes, in any tab, that a rename or move of `sourcePath` relocates. */
function openDocumentsAffectedBy(sourcePath: string, isFolder: boolean) {
	return openDocuments().filter(
		(document) =>
			document.currentPath &&
			moveAffectsPath(document.currentPath, sourcePath, isFolder),
	);
}

/**
 * Flushes drafts to disk before the files under them move, so the move carries
 * the user's latest text whether the note is focused or parked on a tab.
 */
async function saveOpenDocuments(documents: DocumentState[]) {
	for (const document of documents) {
		const path = document.currentPath;
		if (!path || isChangelogPath(path) || !isEditableFile(path)) continue;
		await savePathContent(path, document.content, { force: true });
	}
}

function setDocumentCleanContent(path: string, content: string) {
	updateDocumentForPath(path, (document) => ({
		...document,
		...cleanFileState(content),
	}));
}

async function writeFileIfChanged(path: string, current: string, next: string) {
	if (next === current) return false;
	await desktopApi.writeFileText(path, next);
	setDocumentCleanContent(path, next);
	return true;
}

async function moveAssociatedAssetFolder(
	fromFilePath: string,
	toFilePath: string,
) {
	if (!hasMarkdownExtension(fromFilePath)) return null;
	const fromAssetFolder = markdownAssetFolderPath(fromFilePath);
	const toAssetFolder = markdownAssetFolderPath(toFilePath);
	if (
		!fromAssetFolder ||
		!toAssetFolder ||
		pathEquals(fromAssetFolder, toAssetFolder)
	) {
		return null;
	}
	// Asset folders are optional; check first so Electron does not log a
	// rejected rename for normal notes without assets.
	if (!(await desktopApi.pathExists(fromAssetFolder))) return null;
	try {
		await desktopApi.renameFile(fromAssetFolder, toAssetFolder);
		return { fromPath: fromAssetFolder, toPath: toAssetFolder };
	} catch (err) {
		if (missingPathErrorPattern.test(errorMessage(err))) return null;
		throw err;
	}
}

/**
 * Updates Markdown and wiki links after sidebar rename/move operations.
 *
 * Each file is processed once. Links are resolved from the file's old path, then
 * written relative to its new path so folder moves and file moves share one path.
 */
async function updateMovedLinks(movedFiles: MovedFile[], files: FileEntry[]) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath || movedFiles.length === 0) return;
	const movedByOldPath = indexMovedFiles(movedFiles);

	for (const file of files.filter((file) => hasMarkdownExtension(file.path))) {
		const nextPath = pathAfterMove(file.path, movedByOldPath);
		try {
			// Any open tab may hold unsaved changes, so disk content is stale for
			// that file. Rewrite from the draft and then save that rewritten draft.
			const openDocument = getDocumentForPath(nextPath);
			const content =
				openDocument?.content ?? (await desktopApi.readFileText(nextPath));
			const nextContent = rewriteMovedLinks({
				content,
				filePath: file.path,
				nextPath,
				workspacePath,
				movedByOldPath,
			});
			await writeFileIfChanged(nextPath, content, nextContent);
		} catch (err) {
			const message = handleFileError(err);
			toast.error("Failed to update links", { description: message });
		}
	}
}

function folderPathsFromEntries(
	files: FileEntry[],
	folderEntries: FolderEntry[] = [],
) {
	const folderPaths = new Set<string>();
	for (const folder of folderEntries) {
		folderPaths.add(folder.path.toLocaleLowerCase());
	}
	for (const file of files) {
		let parent = dirname(file.path);
		while (parent) {
			folderPaths.add(parent.toLocaleLowerCase());
			const nextParent = dirname(parent);
			parent = nextParent === parent ? null : nextParent;
		}
	}
	return folderPaths;
}

function uniqueMovePath(parent: string, sourcePath: string, isFolder: boolean) {
	const sourceName = basename(sourcePath);
	const extension = isFolder ? "" : extname(sourceName);
	const stem = extension ? sourceName.slice(0, -extension.length) : sourceName;
	const { files, folders } = workspaceStore.get();
	const existing = new Set([
		...files.map((file) => file.path.toLocaleLowerCase()),
		...folderPathsFromEntries(files, folders),
	]);
	for (let index = 0; ; index++) {
		const name = index === 0 ? sourceName : `${stem} ${index}${extension}`;
		const candidate = joinPath(parent, name);
		if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

async function loadPinnedNotes(workspacePath: string) {
	const config = await desktopApi.readWorkspaceConfig(workspacePath);
	workspaceStore.set((state) => {
		if (state.workspacePath !== workspacePath) return state;
		return {
			...state,
			pinnedNotes: config.pinnedNotes.map((note) =>
				absoluteWorkspacePath(note, workspacePath),
			),
		};
	});
}

async function writePinnedNotes(workspacePath: string, pinnedNotes: string[]) {
	await desktopApi.writeWorkspaceConfig(workspacePath, {
		version: 1,
		pinnedNotes: pinnedNotes.map((note) =>
			relativeWorkspacePath(note, workspacePath),
		),
	});
}

async function syncPinnedNotes() {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	try {
		await writePinnedNotes(workspacePath, workspaceStore.get().pinnedNotes);
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to update pinned notes", { description: message });
	}
}

export function touchFile(path: string) {
	workspaceStore.set((state) => {
		if (!isInWorkspace(path, state.workspacePath)) return state;
		return {
			...state,
			files: state.files.map((file) =>
				file.path === path
					? { ...file, modified_at: Math.floor(Date.now() / 1000) }
					: file,
			),
		};
	});
}

function uniqueFilePath(
	parent: string,
	stem: string,
	extension: string,
): string {
	const files = workspaceStore.get().files;
	const existing = new Set(files.map((file) => file.path.toLocaleLowerCase()));
	for (let index = 1; ; index++) {
		const name =
			index === 1 ? `${stem}${extension}` : `${stem}-${index}${extension}`;
		const candidate = joinPath(parent, name);
		if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

function uniqueFolderPath(parent: string): string {
	const { files, folders } = workspaceStore.get();
	const existing = new Set([
		...files.map((file) => file.path.toLocaleLowerCase()),
		...folderPathsFromEntries(files, folders),
	]);
	for (let index = 1; ; index++) {
		const name = index === 1 ? "new-folder" : `new-folder-${index}`;
		const candidate = joinPath(parent, name);
		if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

const pendingRenames = new Map<string, string>();
const titleManager = createTitleManager({
	pendingRenames,
	runFileTask: saves.run,
	savePathContent,
	moveAssociatedAssetFolder,
	updateMovedLinks,
	syncPinnedNotes,
	errorMessage,
	handleFileError,
});

type LoadPathOptions = {
	history?: "push" | "none";
	missing?: "toast" | "silent";
	/** `false` keeps code files in Hubble regardless of the default-app preference. */
	launchExternal?: boolean;
};

export function getPendingRenameTarget(path: string) {
	return pendingRenames.get(path) ?? null;
}

const initialWorkspacePath = workspaceStore.get().workspacePath;
if (initialWorkspacePath) {
	void Promise.all([
		refreshFiles(initialWorkspacePath),
		loadPinnedNotes(initialWorkspacePath),
	]);
}

export function setSortMode(mode: SortMode) {
	workspaceStore.select("sortMode").set(mode);
}

export function setWorkspaceSwitcherOpen(isOpen: boolean) {
	switcherOpenStore.set(isOpen);
}

export function setSidebarOpen(isOpen: boolean) {
	sidebarOpenStore.set(isOpen);
}

export function toggleSidebar() {
	sidebarOpenStore.set((open) => !open);
}

export function setTerminalOpen(isOpen: boolean) {
	uiStore.select("isTerminalOpen").set(isOpen);
}

export function toggleTerminal() {
	uiStore.select("isTerminalOpen").set((open) => !open);
}

export function setTerminalPosition(position: TerminalPosition) {
	uiStore.select("terminalPosition").set(position);
}

export function setChatCommand(command: string) {
	chatCommandStore.set(command);
}

export function setCodeFileOpenMode(mode: CodeFileOpenMode) {
	codeFileOpenModeStore.set(mode);
}

export async function openPathInDefaultApp(path: string) {
	try {
		await desktopApi.openPathInDefaultApp(path);
	} catch (err) {
		toast.error("Failed to open file", {
			description: handleFileError(err),
		});
	}
}

export function setLastSeenVersion(version: string) {
	lastSeenVersionStore.set(version);
}

export function loadSettingsState() {
	void desktopApi
		.getTelemetryConsent()
		.then((consent) => telemetryConsentStore.set(consent));
	void desktopApi
		.getSpellcheckState()
		.then((spellcheck) => spellcheckStore.set(spellcheck));
}

export async function setSpellcheckEnabled(enabled: boolean) {
	await updateSpellcheck(desktopApi.setSpellcheckEnabled(enabled));
}

export async function setSpellcheckLanguages(languages: string[]) {
	await updateSpellcheck(desktopApi.setSpellcheckLanguages(languages));
}

async function updateSpellcheck(request: Promise<void>) {
	try {
		await request;
		spellcheckStore.set(await desktopApi.getSpellcheckState());
	} catch {
		toast.error("Failed to update spellcheck");
	}
}

export async function setTelemetryConsent(choice: TelemetryChoice) {
	telemetryConsentStore.set(await desktopApi.setTelemetryConsent(choice));
	if (choice !== "enabled") return;

	const viewer = viewerStore.get();
	void desktopApi.recordTelemetryActivity({
		usedHtmlApp:
			viewer.status === "ready" &&
			!!viewer.currentPath &&
			hasHtmlExtension(viewer.currentPath),
	});
}

export function setShortcutBinding(id: CommandId, binding: string | null) {
	const next = { ...shortcutBindingsStore.get() };
	if (isDefaultCommandBinding(id, binding)) {
		delete next[id];
	} else {
		next[id] = binding;
	}
	saveShortcutBindings(next);
}

export function resetShortcutBindings() {
	saveShortcutBindings({});
}

function saveShortcutBindings(bindings: CommandBindings) {
	setCommandBindings(bindings);
	shortcutBindingsStore.set(bindings);
}

export function initThemePreference() {
	const preference = themePreferenceStore.get();
	initTheme(preference);
	syncNativeTheme(preference);
}

export function setThemePreference(preference: ThemePreference) {
	themePreferenceStore.set(preference);
	if (preference !== "system") applyThemePreference(preference);
	syncNativeTheme(preference);
}

/**
 * Hands the preference to the Electron main process, which forces it through
 * `nativeTheme.themeSource` so native window chrome and sandboxed HTML apps
 * follow it too.
 *
 * While a Light or Dark override is in force, Chromium reports that override to
 * `prefers-color-scheme` instead of the real OS appearance. So the OS value is
 * only readable after the main process drops the override, and dropping it fires
 * no `change` event. That is why `"system"` waits and then applies itself.
 */
function syncNativeTheme(preference: ThemePreference) {
	const updated = desktopApi.setThemeSource(preference);
	if (preference !== "system") return;
	void updated.then(() => {
		// A newer explicit pick already applied itself while this was in flight.
		if (themePreferenceStore.get() === "system") {
			applyThemePreference("system");
		}
	});
}

export function requestChatAboutNote() {
	if (isChangelogPath(viewerStore.get().currentPath)) return;
	const command = chatCommandStore.get().trim() || DEFAULT_CHAT_COMMAND;
	// Set the command before opening so the panel's open effect can see it
	// and defer to the chat launch instead of starting a plain session.
	pendingTerminalCommandStore.set(command);
	uiStore.select("isTerminalOpen").set(true);
}

export function clearPendingTerminalCommand() {
	uiStore.set((state) => ({ ...state, pendingTerminalCommand: null }));
}

export function clearViewer() {
	const path = viewerStore.get().currentPath;
	if (path) titleManager.stop(path);
	viewerStore.set((state) => emptyDoc(state.lastOpenedPath));
}

/** Opens a workspace and reveals the sidebar. */
export async function openWorkspaceWithSidebar() {
	await openWorkspace();
	if (workspaceStore.get().workspacePath !== null) {
		sidebarOpenStore.set(true);
	}
}

/** Creates a new folder, opens it as a workspace, and reveals the sidebar. */
export async function createWorkspaceWithSidebar() {
	const created = await desktopApi.createFolderPicker();
	if (typeof created !== "string") return;
	await openWorkspace(created);
	if (workspaceStore.get().workspacePath !== null) {
		sidebarOpenStore.set(true);
	}
}

/** Forgets an inactive folder from recents without changing its saved file state. */
export function removeRecentWorkspace(path: string) {
	workspaceStore.set((state) => {
		if (
			state.workspacePath === path ||
			!state.recentWorkspaces.includes(path)
		) {
			return state;
		}
		return {
			...state,
			recentWorkspaces: state.recentWorkspaces.filter(
				(recentPath) => recentPath !== path,
			),
		};
	});
}

/** Opens a workspace by path. If no path given, shows a folder picker first. */
export async function openWorkspace(path?: string) {
	let nextPath = path;
	if (!nextPath) {
		const selected = await desktopApi.openFolderPicker();
		if (typeof selected !== "string") return;
		nextPath = selected;
	}
	// The new workspace starts on one empty tab, so every stashed draft has to
	// reach disk first. A draft that cannot be saved keeps the current
	// workspace: switching would throw the only copy of it away.
	const unsaved = await saveAllTabs();
	if (unsaved) {
		toast.error("Unsaved changes", {
			description: `${basename(unsaved)} changed on disk. Resolve it before opening another folder.`,
		});
		return;
	}
	if (workspaceStore.get().workspacePath !== nextPath) {
		await expireDeleteUndo();
	}

	// The outgoing workspace keeps the tab set it ends on, flushed drafts and
	// all, so coming back to it restores exactly these notes.
	recordOpenTabs();

	await withOpenTabsRecordingSuppressed(async () => {
		workspaceStore.set((state) => {
			const filtered = state.recentWorkspaces.filter((p) => p !== nextPath);
			return {
				...state,
				workspacePath: nextPath,
				recentWorkspaces: [nextPath, ...filtered].slice(0, MAX_RECENT),
				files: [],
				pinnedNotes: [],
			};
		});
		switcherOpenStore.set(false);
		// Tabs belong to the workspace that opened them: the incoming workspace
		// gets its own set back, or a single empty tab when it has none.
		resetTabs();
		resetHistory();
		await Promise.all([refreshFileList(nextPath), loadPinnedNotes(nextPath)]);

		if (await restoreWorkspaceTabs(nextPath)) return;

		const lastFile = workspaceStore.get().lastOpenedPaths[nextPath];
		if (lastFile) {
			await loadPath(lastFile, { missing: "silent", launchExternal: false });
			return;
		}

		clearViewer();
	});
	beginOpenTabsRecording();
}

/**
 * Reopens the notes a workspace was last left on, one tab each, with the tab
 * that was on screen active again. Notes that no longer exist are dropped in
 * silence, the way a missing `lastOpenedPath` is. Returns whether the workspace
 * had a session of its own; `false` leaves the caller on its single-note
 * fallback. A workspace last left with nothing open comes back with nothing
 * open, rather than reopening the note the user closed last.
 *
 * Only the paths were persisted, so every note comes back clean, in the default
 * view mode, with a history stack holding just itself.
 */
export async function restoreWorkspaceTabs(
	workspacePath: string,
): Promise<boolean> {
	const record = workspaceStore.get().openTabsByWorkspace[workspacePath];
	if (!record) return false;
	const activePath =
		record.paths[
			Math.min(Math.max(record.activeIndex, 0), record.paths.length - 1)
		];

	const documents: DocumentState[] = [];
	const opened: string[] = [];
	for (const path of record.paths) {
		const kind = fileKindForPath(path);
		// External files never take over the viewer, so they never held a tab.
		if (kind === "external") continue;
		// A path lives in at most one tab, so a duplicate in the record (a hand
		// edited store, an older build) must not become a second tab on it.
		if (opened.some((openPath) => pathEquals(openPath, path))) continue;
		try {
			// Images and PDFs are shown from disk rather than read, and a code file
			// opens in its tab even when the "open in default app" preference is on:
			// restoring a session must never launch another app.
			if (kind === "viewer" && !(await desktopApi.pathExists(path))) continue;
			const content =
				kind === "viewer" ? "" : await desktopApi.readFileText(path);
			opened.push(path);
			documents.push({
				...emptyDoc(path),
				currentPath: path,
				...cleanFileState(content),
			});
		} catch {
			// Deleted or unreadable since the last session: drop it silently.
		}
	}
	if (documents.length === 0) {
		// The workspace's session was empty, or every note in it is gone: either
		// way it is left on one empty tab rather than on a note it did not record.
		resetTabs();
		resetHistory();
		clearViewer();
		beginOpenTabsRecording();
		return true;
	}

	const activeIndex = Math.max(
		documents.findIndex((document) => document.currentPath === activePath),
		0,
	);
	const tabIds = installTabs(documents, activeIndex);
	tabIds.forEach((tabId, index) => {
		const path = documents[index].currentPath;
		if (path) seedTabHistory(tabId, path);
	});
	rememberOpenedDoc(documents[activeIndex]);
	// The restored set is the session from here on, minus any note that went
	// missing since it was recorded.
	beginOpenTabsRecording();
	return true;
}

export function updateEditorContent(path: string, content: string) {
	const currentPath = titleManager.currentPath(path);
	const current = viewerStore.get();
	if (current.currentPath !== currentPath || current.content === content)
		return;
	void expireDeleteUndo();

	viewerStore.set((state) => {
		if (state.currentPath !== currentPath) return state;
		if (
			state.externalChange.kind === "conflict" &&
			content === state.externalChange.diskContent
		) {
			return {
				...state,
				...cleanFileState(content),
			};
		}
		return {
			...state,
			content,
			status: "ready",
			error: null,
		};
	});
	titleManager.update(path, content);
}

export function editorDocumentId(path: string) {
	return titleManager.editorDocumentId(path);
}

export function setViewerMode(viewMode: ViewMode) {
	viewerStore.set((state) => {
		if (state.viewMode === viewMode) return state;
		return { ...state, viewMode };
	});
}

/**
 * Writes one note to disk, wherever that note is open. The document is looked
 * up by path rather than read off the viewer, so a background tab's stash gets
 * the same preflight, conflict handling and baseline bookkeeping as the focused
 * one. Nothing happens when the path is no longer open in any tab.
 */
async function savePathContentNow(
	path: string,
	content: string,
	options?: { force?: boolean; throwOnError?: boolean; allowBlocked?: boolean },
) {
	// Binary viewers, external files, and the virtual changelog never enter text saves.
	if (isChangelogPath(path) || !isEditableFile(path)) return;
	// A save already queued by the editor must not recreate a staged deletion.
	if (!options?.allowBlocked && deletionActions.isSaveBlocked(path)) return;
	const current = getDocumentForPath(path);
	const force = options?.force === true;
	if (!current) return;
	if (!force && current.externalChange.kind === "conflict") return;
	if (!force && current.content === content && content === getBaseline(current))
		return;

	if (!force) {
		try {
			const currentDiskContent = await desktopApi.readFileText(path);
			const nextCurrent = getDocumentForPath(path);
			if (!nextCurrent) return;
			if (isSelfSave(path, currentDiskContent)) {
				updateDocumentForPath(path, (document) => ({
					...document,
					...selfSaveState(document.content, currentDiskContent),
				}));
			} else {
				const action = classifyFileChange({
					editorContent: nextCurrent.content,
					baseline: getBaseline(nextCurrent),
					diskContent: currentDiskContent,
				});
				if (action !== "none") {
					updateDocumentForPath(path, (document) =>
						applyFileAction(document, currentDiskContent, action),
					);
					return;
				}
			}
		} catch {
			// Fall through to the write path if the file cannot be read during preflight.
		}
	}

	try {
		rememberSelfSave(path, content);
		await desktopApi.writeFileText(path, content);
		rememberSelfSave(path, content);
		touchFile(path);
		updateDocumentForPath(path, (document) => {
			if (!force && document.externalChange.kind === "conflict")
				return document;
			// Only write the saved text back into live editor content if the user
			// has not typed more while the save was in flight. Otherwise, just
			// move the saved baseline forward and keep the newer editor text.
			if (document.content === content) {
				return {
					...document,
					...cleanFileState(content),
				};
			}
			return {
				...document,
				diskContent: content,
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			};
		});
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to save file", { description: message });
		updateDocumentForPath(path, (document) => ({
			...document,
			status: "error",
			error: message,
		}));
		if (options?.throwOnError) throw err;
	}
}

export function savePathContent(
	path: string,
	content: string,
	options?: { force?: boolean; throwOnError?: boolean },
) {
	const currentPath = titleManager.currentPath(path);
	return saves.run(currentPath, () =>
		savePathContentNow(currentPath, content, options),
	);
}

const deletionActions = createDeleteActions({
	saveBeforeDelete: (path, content) =>
		saves.run(path, () =>
			savePathContentNow(path, content, {
				force: true,
				throwOnError: true,
				allowBlocked: true,
			}),
		),
	waitForSaves: saves.waitFor,
	refreshFiles,
	refreshFileList,
	loadPath,
	syncPins: syncPinnedNotes,
	stopTitleRenames: titleManager.stop,
	closeDeletedTabs: closeDeletedBackgroundTabs,
	handleError: handleFileError,
});

export const {
	deleteFolder,
	deleteMarkdownFile,
	deleteSidebarItems,
	expireDeleteUndo,
	undoDelete,
} = deletionActions;

export async function renameMarkdownFile(path: string, nextName: string) {
	const currentExt = extname(path);
	if (renameStem(nextName, currentExt) !== fileStem(path)) {
		titleManager.stop(path);
	}
	// The file may be open in a background tab, whose draft has to reach disk
	// before the rename just like the focused one's.
	const openDocument = getDocumentForPath(path);
	const isCurrentFile = viewerStore.get().currentPath === path;
	const { files: filesBeforeRename, workspacePath } = workspaceStore.get();

	const trimmedName = nextName.trim();
	if (trimmedName.length === 0) return;

	const parent = dirname(path);
	if (!parent) return;

	const proposedStem = renameStem(trimmedName, currentExt);
	const nextNameWithExt = `${proposedStem}${currentExt}`;
	// Slash paths are relative to the current file's folder, matching sidebar
	// rename behavior for nested notes.
	const nextPath = normalizePath(joinPath(parent, nextNameWithExt));
	if (!isSafeRelativeRenamePath(trimmedName, nextPath, workspacePath)) return;
	if (nextPath === path) return;

	try {
		if (openDocument && isEditableFile(path)) {
			await savePathContent(path, openDocument.content, { force: true });
		}
		pendingRenames.set(path, nextPath);
		await desktopApi.renameFile(path, nextPath);
		const movedAssetFolder = await moveAssociatedAssetFolder(path, nextPath);
		const movedFiles = [{ fromPath: path, toPath: nextPath }];
		if (movedAssetFolder) movedFiles.push(movedAssetFolder);
		// Background stashes move before the link rewrite so a dirty one is
		// rewritten from its draft rather than from the file it no longer matches.
		rewriteTabBufferPaths(path, nextPath);
		await updateMovedLinks(movedFiles, filesBeforeRename);
		rewriteHistory(path, nextPath);
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.map((file) =>
					file.path === path ? { ...file, path: nextPath } : file,
				),
				pinnedNotes: state.workspace.pinnedNotes.map((pinnedPath) =>
					pinnedPath === path ? nextPath : pinnedPath,
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).map(
						([workspacePath, openedPath]) => [
							workspacePath,
							openedPath === path ? nextPath : openedPath,
						],
					),
				),
			},
			document: {
				...state.document,
				currentPath:
					state.document.currentPath === path
						? nextPath
						: state.document.currentPath,
				lastOpenedPath:
					state.document.lastOpenedPath === path
						? nextPath
						: state.document.lastOpenedPath,
			},
		}));
		await syncPinnedNotes();
		await refreshFileList();
		if (isCurrentFile) {
			// Path rewrite already updated history; reload content without a new visit.
			await loadPath(nextPath, { history: "none", launchExternal: false });
		}
	} catch (err) {
		pendingRenames.delete(path);
		const message = handleFileError(err);
		toast.error("Failed to rename file", { description: message });
	} finally {
		window.setTimeout(() => pendingRenames.delete(path), 1000);
	}
}

function renameStem(name: string, currentExt: string) {
	const trimmed = name.trim();
	const proposedExt = extname(trimmed);
	return proposedExt.length > 0 &&
		proposedExt.toLocaleLowerCase() === currentExt.toLocaleLowerCase()
		? trimmed.slice(0, -proposedExt.length)
		: trimmed;
}

export async function renameCurrentMarkdownFile(nextName: string) {
	const current = viewerStore.get();
	if (!current.currentPath || isChangelogPath(current.currentPath)) return;
	await renameMarkdownFile(current.currentPath, nextName);
}

async function deleteEmptySourceAncestors(
	sourcePath: string,
	targetPath: string,
	workspacePath: string | null,
) {
	if (!workspacePath) return;
	let parent = dirname(sourcePath);
	while (parent && !pathEquals(parent, workspacePath)) {
		if (pathEquals(parent, targetPath) || pathInFolder(targetPath, parent)) {
			return;
		}
		try {
			await desktopApi.deleteFile(parent);
		} catch (err) {
			const message = errorMessage(err);
			if (
				!missingPathErrorPattern.test(message) &&
				!/\bENOTEMPTY\b/.test(message)
			) {
				throw err;
			}
			return;
		}
		const nextParent = dirname(parent);
		parent = nextParent === parent ? null : nextParent;
	}
}

export async function renameFolder(
	path: string,
	nextName: string,
	targetPath?: string,
) {
	const { files: filesBeforeRename, workspacePath } = workspaceStore.get();
	const trimmedName = nextName.trim();
	if (trimmedName.length === 0) return;

	const parent = dirname(path);
	if (!parent) return;

	const nextPath = normalizePath(targetPath ?? joinPath(parent, trimmedName));
	if (
		targetPath &&
		workspacePath &&
		!pathInFolder(nextPath, normalizePath(workspacePath))
	) {
		return;
	}
	if (!isSafeRelativeRenamePath(trimmedName, nextPath, workspacePath)) return;
	if (nextPath === path) return;

	const affectedDocuments = openDocumentsAffectedBy(path, true);
	const movedFiles = movedMarkdownFiles(
		filesBeforeRename,
		path,
		nextPath,
		true,
	);

	try {
		await saveOpenDocuments(affectedDocuments);
		await desktopApi.renameFile(path, nextPath);
		await deleteEmptySourceAncestors(path, nextPath, workspacePath);
		rewriteHistory(path, nextPath, true);
		rewriteTabBufferPaths(path, nextPath, true);
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.map((file) => ({
					...file,
					path: replacePathPrefix(file.path, path, nextPath),
				})),
				folders: state.workspace.folders.map((folder) => ({
					...folder,
					path: replacePathPrefix(folder.path, path, nextPath),
				})),
				pinnedNotes: state.workspace.pinnedNotes.map((pinnedPath) =>
					replacePathPrefix(pinnedPath, path, nextPath),
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).map(
						([workspace, openedPath]) => [
							workspace,
							replacePathPrefix(openedPath, path, nextPath),
						],
					),
				),
			},
			document: {
				...state.document,
				currentPath: state.document.currentPath
					? replacePathPrefix(state.document.currentPath, path, nextPath)
					: null,
				lastOpenedPath: state.document.lastOpenedPath
					? replacePathPrefix(state.document.lastOpenedPath, path, nextPath)
					: null,
			},
		}));
		await updateMovedLinks(movedFiles, filesBeforeRename);
		await syncPinnedNotes();
		await refreshFileList();
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to rename folder", { description: message });
		await refreshFileList();
	}
}

function isSafeRelativeRenamePath(
	name: string,
	nextPath: string,
	workspacePath: string | null,
) {
	if (!/[\\/]/.test(name)) return true;
	if (!workspacePath) return false;
	if (
		name.startsWith("/") ||
		name.startsWith("\\") ||
		/^[a-zA-Z]:[\\/]/.test(name)
	) {
		return false;
	}
	const normalized = normalizePath(name);
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return false;
	}
	return pathInFolder(nextPath, normalizePath(workspacePath));
}

export async function moveSidebarItem(
	item: SidebarMoveItem,
	targetFolderPath: string,
) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	const filesBeforeMove = workspaceStore.get().files;
	const sourcePath =
		item.kind === "file"
			? item.path
			: absoluteWorkspacePath(
					item.folderId.replace(/[\\/]+$/, ""),
					workspacePath,
				);
	const isFolder = item.kind === "folder";
	const sourceParent = dirname(sourcePath);
	if (!sourceParent) return;
	if (pathEquals(sourceParent, targetFolderPath)) return;
	if (isFolder && pathStartsWithFolder(targetFolderPath, sourcePath)) return;

	const affectedDocuments = openDocumentsAffectedBy(sourcePath, isFolder);
	const nextPath = uniqueMovePath(targetFolderPath, sourcePath, isFolder);
	const movedFiles = movedMarkdownFiles(
		filesBeforeMove,
		sourcePath,
		nextPath,
		isFolder,
	);

	try {
		await saveOpenDocuments(affectedDocuments);
		await desktopApi.renameFile(sourcePath, nextPath);
		const movedAssetFolder =
			item.kind === "file"
				? await moveAssociatedAssetFolder(sourcePath, nextPath)
				: null;
		rewriteHistory(sourcePath, nextPath, isFolder);
		rewriteTabBufferPaths(sourcePath, nextPath, isFolder);
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.map((file) => ({
					...file,
					path: replacePathPrefix(file.path, sourcePath, nextPath),
				})),
				pinnedNotes: state.workspace.pinnedNotes.map((pinnedPath) =>
					replacePathPrefix(pinnedPath, sourcePath, nextPath),
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).map(
						([workspace, openedPath]) => [
							workspace,
							replacePathPrefix(openedPath, sourcePath, nextPath),
						],
					),
				),
			},
			document: {
				...state.document,
				currentPath: state.document.currentPath
					? replacePathPrefix(state.document.currentPath, sourcePath, nextPath)
					: null,
				lastOpenedPath: state.document.lastOpenedPath
					? replacePathPrefix(
							state.document.lastOpenedPath,
							sourcePath,
							nextPath,
						)
					: null,
			},
		}));
		if (movedAssetFolder) movedFiles.push(movedAssetFolder);
		await updateMovedLinks(movedFiles, filesBeforeMove);
		await syncPinnedNotes();
		await refreshFileList();
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to move item", { description: message });
		await refreshFileList();
	}
}

export async function moveSidebarItems(
	items: SidebarMoveItem[],
	targetFolderPath: string,
) {
	for (const item of items) {
		await moveSidebarItem(item, targetFolderPath);
	}
}

async function createEmptyFileInFolder(
	parentPath: string,
	stem: string,
	extension: string,
) {
	const path = uniqueFilePath(parentPath, stem, extension);
	try {
		await desktopApi.writeFileText(path, "");
		if (extension === ".md") {
			titleManager.start(path);
		}
		const modified_at = Math.floor(Date.now() / 1000);
		workspaceStore.set((state) => ({
			...state,
			files: [
				...state.files,
				{ path, modified_at, kind: fileKindForPath(path) },
			],
		}));
		await loadPath(path);
		await refreshFileList();
		return path;
	} catch (err) {
		titleManager.stop(path);
		const message = handleFileError(err);
		toast.error("Failed to create file", { description: message });
		return null;
	}
}

export function createMarkdownFileInFolder(parentPath: string) {
	return createEmptyFileInFolder(parentPath, "new-file", ".md");
}

export function createHtmlFileInFolder(parentPath: string) {
	return createEmptyFileInFolder(parentPath, "new-app", ".html");
}

export async function createFolderInFolder(parentPath: string) {
	const path = uniqueFolderPath(parentPath);
	try {
		await desktopApi.createFolder(path);
		const modified_at = Math.floor(Date.now() / 1000);
		workspaceStore.set((state) => ({
			...state,
			folders: [...state.folders, { path, modified_at }],
		}));
		await refreshFileList();
		return path;
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to create folder", { description: message });
		return null;
	}
}

export function handleExternalFileChange(
	path: string,
	nextDiskContent: string,
) {
	updateDocumentForPath(path, (document) => {
		if (isSelfSave(path, nextDiskContent)) {
			return {
				...document,
				...selfSaveState(document.content, nextDiskContent),
			};
		}
		const action = classifyFileChange({
			editorContent: document.content,
			baseline: getBaseline(document),
			diskContent: nextDiskContent,
		});
		return applyFileAction(document, nextDiskContent, action);
	});
}

export function reloadFromDiskConflict() {
	viewerStore.set((state) => {
		if (state.externalChange.kind !== "conflict") return state;
		return {
			...state,
			...cleanFileState(state.externalChange.diskContent),
		};
	});
}

/** Force-writes the current editor content to disk, overwriting any external changes. */
export async function forceKeepLocalEdits() {
	const current = viewerStore.get();
	if (current.currentPath === null) return;
	await savePathContent(current.currentPath, current.content, { force: true });
}

const { run: loadInternalPath, invalidate: invalidateLoadPath } = takeLatest(
	async ({ isStale }, path: string, options?: LoadPathOptions) => {
		const historyMode = options?.history ?? "push";
		const missingMode = options?.missing ?? "toast";
		const fileKind = fileKindForPath(path);
		const timer = window.setTimeout(() => {
			if (isStale()) return;
			viewerStore.set((state) => ({
				...state,
				status: "loading",
				error: null,
			}));
		}, LOADING_DELAY_MS);

		try {
			let content = "";
			if (fileKind === "viewer") {
				if (!(await desktopApi.pathExists(path))) throw new Error("ENOENT");
			} else {
				content = await desktopApi.readFileText(path);
			}
			if (isStale()) return;
			const currentPath = viewerStore.get().currentPath;
			// Navigating inside a tab leaves the old note behind entirely: the
			// one-tab-per-path invariant means no other tab is still showing it.
			if (currentPath && !pathEquals(currentPath, path)) {
				titleManager.stop(currentPath);
			}
			appStore.set((state) => withOpenedDoc(state, path, content));
			if (historyMode === "push") pushHistory(path);
		} catch (err) {
			if (isStale()) return;
			const message = handleFileError(err);
			if (missingMode === "toast") {
				toast.error("Failed to open file", { description: message });
				// Stay on the current document; the toast is the only failure
				// surface. Only undo the delayed loading flip if it fired.
				viewerStore.set((state) =>
					state.status === "loading"
						? { ...state, status: state.currentPath ? "ready" : "idle" }
						: state,
				);
			} else {
				appStore.set((state) => ({
					...state,
					workspace: {
						...state.workspace,
						lastOpenedPaths: Object.fromEntries(
							Object.entries(state.workspace.lastOpenedPaths).filter(
								([, openedPath]) => openedPath !== path,
							),
						),
					},
					document: emptyDoc(
						state.document.lastOpenedPath === path
							? null
							: state.document.lastOpenedPath,
					),
				}));
			}
		} finally {
			window.clearTimeout(timer);
		}
	},
);

export async function loadPath(path: string, options?: LoadPathOptions) {
	if (
		isCodeFile(path) &&
		codeFileOpenModeStore.get() === "default-app" &&
		options?.launchExternal !== false
	) {
		await openPathInDefaultApp(path);
		return;
	}
	if (fileKindForPath(path) !== "external") {
		// A path is open in at most one tab, so opening one that already lives in
		// another tab reveals it instead of duplicating it.
		const openTab = tabForPath(path);
		if (openTab && openTab !== tabsStore.get().activeTabId) {
			await switchToTab(openTab);
			return;
		}
		await loadInternalPath(path, options);
		return;
	}
	try {
		await desktopApi.openPathFromLink(path);
	} catch (err) {
		toast.error("Failed to open file", {
			description: handleFileError(err),
		});
	}
}

/**
 * Opens the app changelog as an ephemeral note. It never touches disk or
 * history: `lastOpenedPath` and the workspace's `lastOpenedPaths` keep the
 * real note so relaunch restores it, and the stack index stays put so back
 * returns to the note the user was on. Returns whether it opened.
 */
export async function openChangelog(): Promise<boolean> {
	const current = viewerStore.get();
	if (isChangelogPath(current.currentPath)) return true;
	if (current.currentPath) {
		await savePathContent(current.currentPath, current.content);
		if (viewerStore.get().externalChange.kind === "conflict") return false;
	}
	// An in-flight loadPath must not resolve over the changelog.
	invalidateLoadPath();
	viewerStore.set((state) => ({
		...state,
		currentPath: CHANGELOG_PATH,
		...cleanFileState(prepareChangelogMarkdown(changelogRaw)),
		viewMode: "rich",
	}));
	return true;
}

// ── Tabs ────────────────────────────────────────────────────────────
//
// tabs.ts owns the bookkeeping; the orchestration that has to touch disk
// (saving the outgoing note, loading the incoming one) lives here.

/** Serializes switches so a second click waits instead of being dropped. */
let switchQueue: Promise<void> = Promise.resolve();

/**
 * Records the tab's note as the one to reopen on relaunch, mirroring what
 * `withOpenedDoc` does for a fresh open.
 */
function rememberOpenedDoc(doc: DocumentState | null) {
	const path = doc?.currentPath;
	if (!path || isChangelogPath(path)) return;
	appStore.set((state) => {
		const workspacePath = state.workspace.workspacePath;
		const workspace =
			workspacePath && isInWorkspace(path, workspacePath)
				? {
						...state.workspace,
						lastOpenedPaths: {
							...state.workspace.lastOpenedPaths,
							[workspacePath]: path,
						},
					}
				: state.workspace;
		return {
			...state,
			workspace,
			document: { ...state.document, lastOpenedPath: path },
		};
	});
}

/**
 * Shows another tab's note. The outgoing note is saved first (a conflict is
 * stashed with its buffer instead of blocking the switch) and its whole
 * document state is parked on its tab, so coming back restores the draft,
 * the conflict and the view mode exactly as they were.
 */
export function switchToTab(id: string) {
	return queueSwitch(() => id);
}

/**
 * Runs switches one at a time, in the order they were asked for. The tab is
 * named by a callback rather than an id so a relative move picks its target
 * when its turn comes: a burst of Ctrl+Tab presses steps once per press
 * instead of resolving every press against the tab that is still on screen.
 */
function queueSwitch(target: () => string | null) {
	const run = switchQueue.then(
		() => switchToTabNow(target()),
		() => switchToTabNow(target()),
	);
	switchQueue = run.catch(() => {});
	return run;
}

async function switchToTabNow(id: string | null) {
	if (!id) return;
	const { tabs, activeTabId } = tabsStore.get();
	if (id === activeTabId || !tabs.some((tab) => tab.id === id)) return;

	const current = viewerStore.get();
	if (isSavableDoc(current)) {
		await savePathContent(current.currentPath, current.content);
	}
	// An in-flight load must not resolve over the tab we are switching to.
	invalidateLoadPath();
	rememberOpenedDoc(activateTab(id));
}

/**
 * Opens `path` in its own tab. Paths that never take over the viewer (external
 * files, code files routed to another app) and the virtual changelog keep their
 * existing single-document behavior.
 */
export async function openPathInNewTab(path: string) {
	if (isChangelogPath(path)) {
		await openChangelog();
		return;
	}
	if (
		fileKindForPath(path) === "external" ||
		(isCodeFile(path) && codeFileOpenModeStore.get() === "default-app")
	) {
		await loadPath(path);
		return;
	}
	const openTab = tabForPath(path);
	if (openTab) {
		await switchToTab(openTab);
		return;
	}
	// An empty tab is the natural home for the next file, the way a browser
	// reuses a blank tab rather than stranding it beside the new one.
	if (viewerStore.get().currentPath !== null) {
		await switchToTab(addTab());
	}
	// A missing file surfaces through loadPath's toast and leaves an empty tab.
	await loadPath(path);
}

/** Shows the tab `offset` places along, wrapping at both ends. */
export function switchToRelativeTab(offset: number) {
	return queueSwitch(() => tabIdAtOffset(offset));
}

/** Shows the tab a number shortcut names; slot 9 is the last tab. */
export function switchToTabSlot(slot: number) {
	return queueSwitch(() => tabIdForSlot(slot));
}

/** Closes the tab on screen, for the menu and the command palette. */
export async function closeActiveTab() {
	await closeTab(tabsStore.get().activeTabId);
}

/**
 * Closes a tab, saving its note when it holds unsaved edits. The last tab is
 * replaced by an empty one so the app lands on the open-file/welcome state.
 */
export async function closeTab(id: string) {
	const doc = documentForTab(id);
	if (doc && isSavableDoc(doc) && isDirty(doc)) {
		await savePathContent(doc.currentPath, doc.content);
	}
	// The note changed on disk behind the tab, so closing it would drop one of
	// the two versions. Keep the tab open on its conflict instead — whether the
	// conflict was already known or the save's preflight just found it — until
	// the user resolves it from the banner. A failed write still closes.
	if (doc?.currentPath && isDirty(doc) && hasDiskConflict(doc.currentPath)) {
		toast.error("File changed on disk", {
			description: `${basename(doc.currentPath)} has unsaved edits that conflict with a change on disk.`,
		});
		return;
	}
	const removal = removeTab(id);
	if (!removal) return;
	dropTabHistory(id);
	const closedPath = doc?.currentPath;
	if (closedPath && !tabForPath(closedPath)) titleManager.stop(closedPath);
	if (removal.restored) rememberOpenedDoc(removal.restored);
}

function isDirty(doc: DocumentState) {
	return doc.content !== getBaseline(doc);
}

/**
 * Closes the background tabs showing deleted notes. Their drafts are dropped
 * unsaved: writing one back would recreate the file the user just deleted. The
 * active document keeps its own delete handling, including the staged undo.
 */
function closeDeletedBackgroundTabs(isDeleted: (path: string) => boolean) {
	for (const { id, buffer } of backgroundBuffers()) {
		const path = buffer.currentPath;
		if (!path || !isDeleted(path)) continue;
		if (!removeTab(id)) continue;
		dropTabHistory(id);
		titleManager.stop(path);
	}
}

/** Whether the note at `path` is holding a draft that diverged from disk. */
function hasDiskConflict(path: string) {
	return getDocumentForPath(path)?.externalChange.kind === "conflict";
}

/**
 * Flushes every tab's unsaved edits to disk, for callers that are about to
 * drop the tab set. Returns the path of the first draft that could not be
 * saved because the file changed underneath it, or `null` when everything
 * dirty is safely on disk.
 */
async function saveAllTabs(): Promise<string | null> {
	let blocked: string | null = null;
	for (const doc of openDocuments()) {
		const path = doc.currentPath;
		if (!path || !isDirty(doc)) continue;
		if (!isSavableDoc(doc)) {
			// Already conflicted: its draft is only recoverable from the tab.
			if (!isChangelogPath(path) && isEditableFile(path)) blocked ??= path;
			continue;
		}
		await savePathContent(path, doc.content);
		if (hasDiskConflict(path)) blocked ??= path;
	}
	return blocked;
}

async function navigateHistory(delta: -1 | 1) {
	// Keep the toolbar's stack-derived availability stable while preventing a
	// second navigation from racing the in-flight save and load.
	if (historyStore.get().isNavigating) return;
	if (!(delta < 0 ? canGoBack() : canGoForward())) return;

	const current = viewerStore.get();
	if (current.externalChange.kind === "conflict") return;
	// The changelog note is never pushed, so back re-opens the entry the user
	// was on (`entries[index]`, not `index - 1`). Forward never gets here:
	// canGoForward is false on the changelog.
	const fromChangelog = isChangelogPath(current.currentPath);

	// Block concurrent history ops for the whole leave (save + load).
	historyStore.set((state) => ({ ...state, isNavigating: true }));
	try {
		if (current.currentPath) {
			await savePathContent(current.currentPath, current.content);
			if (viewerStore.get().externalChange.kind === "conflict") return;
		}

		let working = activeHistory();
		let nextIndex = working.index + (fromChangelog ? 0 : delta);
		while (nextIndex >= 0 && nextIndex < working.entries.length) {
			const target = working.entries[nextIndex];
			// Back and forward stay inside their own tab. A note another tab
			// already owns cannot be shown here (a path lives in one tab only), so
			// it drops out of this stack the way a deleted file does.
			const owner = tabForPath(target);
			const reachable =
				(!owner || owner === tabsStore.get().activeTabId) &&
				(await desktopApi.pathExists(target));
			if (reachable) {
				setHistory({ entries: working.entries, index: nextIndex });
				await loadPath(target, {
					history: "none",
					missing: "silent",
					launchExternal: false,
				});
				return;
			}
			const entries = working.entries.filter((entry) => entry !== target);
			working = normalizeStack({
				entries,
				index: Math.min(nextIndex - (delta > 0 ? 1 : 0), entries.length - 1),
			});
			setHistory(working);
			// Forward keeps nextIndex (successor shifted in); back steps left.
			nextIndex += delta > 0 ? 0 : -1;
		}
		toast.error(
			delta < 0 ? "No previous file to open" : "No next file to open",
		);
	} finally {
		historyStore.set((state) => ({ ...state, isNavigating: false }));
	}
}

export function goBack() {
	return navigateHistory(-1);
}

export function goForward() {
	return navigateHistory(1);
}

export async function togglePinnedNote(path: string) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath || !isInWorkspace(path, workspacePath)) return;
	const pinnedNotes = workspaceStore.get().pinnedNotes;
	const nextPinnedNotes = pinnedNotes.includes(path)
		? pinnedNotes.filter((pinnedPath) => pinnedPath !== path)
		: [...pinnedNotes, path];
	workspaceStore.set((state) => ({
		...state,
		pinnedNotes: nextPinnedNotes,
	}));
	try {
		await writePinnedNotes(workspacePath, nextPinnedNotes);
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to update pinned notes", { description: message });
		await loadPinnedNotes(workspacePath);
	}
}

export function setReviewThreads(threads: ReviewThread[]) {
	reviewThreadsStore.set(threads);
}
