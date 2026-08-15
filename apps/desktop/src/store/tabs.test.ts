import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGELOG_PATH } from "../lib/changelogNote";

type MockDesktopApi = {
	readFileText: ReturnType<typeof vi.fn>;
	writeFileText: ReturnType<typeof vi.fn>;
	listDirectory: ReturnType<typeof vi.fn>;
	readWorkspaceConfig: ReturnType<typeof vi.fn>;
	writeWorkspaceConfig: ReturnType<typeof vi.fn>;
	renameFile: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
	stageDelete: ReturnType<typeof vi.fn>;
	restoreDelete: ReturnType<typeof vi.fn>;
	finalizeDelete: ReturnType<typeof vi.fn>;
	setDeleteUndoAvailable: ReturnType<typeof vi.fn>;
	pathExists: ReturnType<typeof vi.fn>;
	openPathFromLink: ReturnType<typeof vi.fn>;
	openPathInDefaultApp: ReturnType<typeof vi.fn>;
	sidebarDeltaForPath: ReturnType<typeof vi.fn>;
	setThemeSource: ReturnType<typeof vi.fn>;
};

function createDesktopApi(): MockDesktopApi {
	return {
		readFileText: vi.fn(async (path: string) => `content:${path}`),
		writeFileText: vi.fn(async () => {}),
		listDirectory: vi.fn(async () => ({ files: [], folders: [] })),
		readWorkspaceConfig: vi.fn(async () => ({ version: 1, pinnedNotes: [] })),
		writeWorkspaceConfig: vi.fn(async () => {}),
		renameFile: vi.fn(async () => {}),
		deleteFile: vi.fn(async () => {}),
		stageDelete: vi.fn(async () => "delete-token"),
		restoreDelete: vi.fn(async () => {}),
		finalizeDelete: vi.fn(async () => {}),
		setDeleteUndoAvailable: vi.fn(async () => {}),
		pathExists: vi.fn(async () => true),
		openPathFromLink: vi.fn(async () => ({ kind: "opened" })),
		openPathInDefaultApp: vi.fn(async () => {}),
		sidebarDeltaForPath: vi.fn(async () => null),
		setThemeSource: vi.fn(async () => {}),
	};
}

/**
 * Backs the api with an in-memory disk so tests can change a file behind a
 * background tab, and can make one write fail to leave a tab holding a draft
 * that never reached disk.
 */
function withFakeDisk(api: MockDesktopApi) {
	const disk = new Map<string, string>();
	let failNextWrite = false;
	api.readFileText.mockImplementation(
		async (path: string) => disk.get(path) ?? `content:${path}`,
	);
	api.writeFileText.mockImplementation(
		async (path: string, content: string) => {
			if (failNextWrite) {
				failNextWrite = false;
				throw new Error("write failed");
			}
			disk.set(path, content);
		},
	);
	return {
		read: (path: string) => disk.get(path) ?? `content:${path}`,
		write: (path: string, content: string) => disk.set(path, content),
		failNextWrite: () => {
			failNextWrite = true;
		},
	};
}

/**
 * The store modules are singletons that capture window.desktopApi at import
 * time, so every test re-imports them against a freshly stubbed environment.
 */
async function loadStore(api: MockDesktopApi) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() => null),
		setItem: vi.fn(),
	});
	vi.stubGlobal("window", {
		desktopApi: api,
		setTimeout,
		clearTimeout,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
	});

	const actions = await import("./actions");
	const history = await import("./history");
	const state = await import("./state");
	const tabs = await import("./tabs");
	return { ...actions, ...history, ...state, ...tabs };
}

describe("desktop tabs", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens a second tab and restores the first document on switch back", async () => {
		const api = createDesktopApi();
		const {
			openPathInNewTab,
			setViewerMode,
			switchToTab,
			tabsStore,
			updateEditorContent,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		updateEditorContent("/workspace/a.md", "draft a");
		setViewerMode("source");
		const firstTabId = tabsStore.get().activeTabId;

		await openPathInNewTab("/workspace/b.md");

		expect(tabsStore.get().tabs).toHaveLength(2);
		expect(viewerStore.get()).toMatchObject({
			currentPath: "/workspace/b.md",
			content: "content:/workspace/b.md",
		});
		// The outgoing draft is stashed, not thrown away.
		const stashed = tabsStore
			.get()
			.tabs.find((tab) => tab.id === firstTabId)?.buffer;
		expect(stashed).toMatchObject({
			currentPath: "/workspace/a.md",
			content: "draft a",
			viewMode: "source",
		});

		await switchToTab(firstTabId);

		expect(viewerStore.get()).toMatchObject({
			currentPath: "/workspace/a.md",
			content: "draft a",
			// Leaving the tab saved the draft, so the stash carries the new baseline.
			diskContent: "draft a",
			viewMode: "source",
		});
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
		expect(
			tabsStore.get().tabs.find((tab) => tab.id === firstTabId)?.buffer,
		).toBeNull();
	});

	it("restores a stashed disk conflict instead of resolving it", async () => {
		const api = createDesktopApi();
		const { appStore, openPathInNewTab, switchToTab, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: "mine",
				externalChange: { kind: "conflict", diskContent: "theirs" },
			},
		}));

		await openPathInNewTab("/workspace/b.md");
		await switchToTab(firstTabId);

		expect(viewerStore.get()).toMatchObject({ content: "mine" });
		expect(viewerStore.get().externalChange).toEqual({
			kind: "conflict",
			diskContent: "theirs",
		});
		// A conflicted note is never written out by the switch.
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("saves the outgoing document before switching tabs", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, switchToTab, tabsStore, updateEditorContent } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");
		updateEditorContent("/workspace/b.md", "dirty b");

		await switchToTab(firstTabId);

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/b.md",
			"dirty b",
		);
	});

	it("switches to the existing tab instead of opening a path twice", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, tabsStore, viewerStore } = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");

		await openPathInNewTab("/workspace/a.md");

		expect(tabsStore.get().tabs).toHaveLength(2);
		expect(tabsStore.get().activeTabId).toBe(firstTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/a.md");
	});

	it("reveals the tab already holding a path opened through loadPath", async () => {
		const api = createDesktopApi();
		const { loadPath, openPathInNewTab, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");

		await loadPath("/workspace/a.md");

		expect(tabsStore.get().tabs).toHaveLength(2);
		expect(tabsStore.get().activeTabId).toBe(firstTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/a.md");
	});

	it("keeps external and default-app files out of tabs", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, setCodeFileOpenMode, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		setCodeFileOpenMode("default-app");

		await openPathInNewTab("/workspace/archive.zip");
		await openPathInNewTab("/workspace/app.ts");

		expect(api.openPathFromLink).toHaveBeenCalledWith("/workspace/archive.zip");
		expect(api.openPathInDefaultApp).toHaveBeenCalledWith("/workspace/app.ts");
		expect(tabsStore.get().tabs).toHaveLength(1);
		expect(viewerStore.get().currentPath).toBe("/workspace/a.md");
	});

	it("keeps each tab's back and forward history to itself", async () => {
		const api = createDesktopApi();
		const {
			canGoBack,
			canGoForward,
			goBack,
			loadPath,
			openPathInNewTab,
			switchToTab,
			tabsStore,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await loadPath("/workspace/a2.md");
		expect(canGoBack()).toBe(true);

		await openPathInNewTab("/workspace/b.md");

		// The new tab starts with a single entry of its own.
		expect(canGoBack()).toBe(false);
		expect(canGoForward()).toBe(false);
		const secondTabId = tabsStore.get().activeTabId;

		await switchToTab(firstTabId);
		expect(canGoBack()).toBe(true);

		await goBack();
		expect(viewerStore.get().currentPath).toBe("/workspace/a.md");
		expect(canGoForward()).toBe(true);

		await switchToTab(secondTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/b.md");
		expect(canGoBack()).toBe(false);
		expect(canGoForward()).toBe(false);
	});

	it("closes a tab, saving its edits and activating a neighbor", async () => {
		const api = createDesktopApi();
		const {
			closeTab,
			openPathInNewTab,
			tabsStore,
			updateEditorContent,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");
		const secondTabId = tabsStore.get().activeTabId;
		updateEditorContent("/workspace/b.md", "dirty b");

		await closeTab(secondTabId);

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/b.md",
			"dirty b",
		);
		expect(tabsStore.get().tabs).toHaveLength(1);
		expect(tabsStore.get().activeTabId).toBe(firstTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/a.md");
	});

	it("saves a background tab's stashed edits when closing it", async () => {
		const api = createDesktopApi();
		const {
			closeTab,
			openPathInNewTab,
			tabsStore,
			updateEditorContent,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		updateEditorContent("/workspace/a.md", "dirty a");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");

		await closeTab(firstTabId);

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/a.md",
			"dirty a",
		);
		expect(tabsStore.get().tabs).toHaveLength(1);
		expect(viewerStore.get().currentPath).toBe("/workspace/b.md");
	});

	it("leaves one empty tab behind when the last tab closes", async () => {
		const api = createDesktopApi();
		const { canGoBack, closeTab, openPathInNewTab, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const tabId = tabsStore.get().activeTabId;

		await closeTab(tabId);

		expect(tabsStore.get().tabs).toHaveLength(1);
		expect(tabsStore.get().tabs[0].id).not.toBe(tabId);
		expect(tabsStore.get().activeTabId).toBe(tabsStore.get().tabs[0].id);
		expect(viewerStore.get()).toMatchObject({
			currentPath: null,
			content: "",
			status: "idle",
		});
		expect(viewerStore.get().lastOpenedPath).toBe("/workspace/a.md");
		expect(canGoBack()).toBe(false);
	});

	it("restores the newly shown note as the relaunch target", async () => {
		const api = createDesktopApi();
		const { appStore, openPathInNewTab, switchToTab, tabsStore } =
			await loadStore(api);

		appStore.set((current) => ({
			...current,
			workspace: { ...current.workspace, workspacePath: "/workspace" },
		}));
		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");
		expect(appStore.get().workspace.lastOpenedPaths).toEqual({
			"/workspace": "/workspace/b.md",
		});

		await switchToTab(firstTabId);

		expect(appStore.get().workspace.lastOpenedPaths).toEqual({
			"/workspace": "/workspace/a.md",
		});
		expect(appStore.get().document.lastOpenedPath).toBe("/workspace/a.md");
	});

	it("resets to a single tab when a workspace is opened", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, openWorkspace, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		await openPathInNewTab("/workspace/b.md");
		const before = tabsStore.get().tabs.map((tab) => tab.id);

		await openWorkspace("/other-workspace");

		expect(tabsStore.get().tabs).toHaveLength(1);
		expect(before).not.toContain(tabsStore.get().activeTabId);
		expect(viewerStore.get().currentPath).toBeNull();
	});

	it("runs every queued switch instead of dropping rapid clicks", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, switchToTab, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/b.md");
		const secondTabId = tabsStore.get().activeTabId;
		await openPathInNewTab("/workspace/c.md");

		await Promise.all([switchToTab(firstTabId), switchToTab(secondTabId)]);

		expect(tabsStore.get().activeTabId).toBe(secondTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/b.md");
	});

	it("keeps a background draft when the file changed on disk underneath it", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const {
			closeTab,
			openPathInNewTab,
			tabsStore,
			updateEditorContent,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		updateEditorContent("/workspace/a.md", "dirty a");
		// The save on the way out fails, so the tab is backgrounded still dirty.
		disk.failNextWrite();
		await openPathInNewTab("/workspace/b.md");
		expect(disk.read("/workspace/a.md")).toBe("content:/workspace/a.md");

		// Someone else edits the note while nothing watches the background tab.
		disk.write("/workspace/a.md", "theirs");
		await closeTab(firstTabId);

		expect(disk.read("/workspace/a.md")).toBe("theirs");
		expect(tabsStore.get().tabs).toHaveLength(2);
		expect(viewerStore.get().currentPath).toBe("/workspace/b.md");
		const buffer = tabsStore
			.get()
			.tabs.find((tab) => tab.id === firstTabId)?.buffer;
		expect(buffer).toMatchObject({ content: "dirty a" });
		expect(buffer?.externalChange).toEqual({
			kind: "conflict",
			diskContent: "theirs",
		});
	});

	it("writes an unsaved background draft when the file is unchanged", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const { closeTab, openPathInNewTab, tabsStore, updateEditorContent } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		updateEditorContent("/workspace/a.md", "dirty a");
		disk.failNextWrite();
		await openPathInNewTab("/workspace/b.md");

		await closeTab(firstTabId);

		expect(disk.read("/workspace/a.md")).toBe("dirty a");
		expect(tabsStore.get().tabs).toHaveLength(1);
	});

	it("flushes background drafts before a workspace switch resets the tabs", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const { openPathInNewTab, openWorkspace, tabsStore, updateEditorContent } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		updateEditorContent("/workspace/a.md", "dirty a");
		disk.failNextWrite();
		await openPathInNewTab("/workspace/b.md");

		await openWorkspace("/other-workspace");

		expect(disk.read("/workspace/a.md")).toBe("dirty a");
		expect(tabsStore.get().tabs).toHaveLength(1);
	});

	it("refuses a workspace switch that would drop a conflicted background draft", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const {
			openPathInNewTab,
			openWorkspace,
			tabsStore,
			updateEditorContent,
			workspaceStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		updateEditorContent("/workspace/a.md", "dirty a");
		disk.failNextWrite();
		await openPathInNewTab("/workspace/b.md");
		disk.write("/workspace/a.md", "theirs");

		await openWorkspace("/other-workspace");

		expect(workspaceStore.get().workspacePath).not.toBe("/other-workspace");
		expect(tabsStore.get().tabs).toHaveLength(2);
		expect(disk.read("/workspace/a.md")).toBe("theirs");
	});

	it("skips history entries that another tab now owns", async () => {
		const api = createDesktopApi();
		const {
			canGoBack,
			goBack,
			loadPath,
			openPathInNewTab,
			switchToTab,
			tabsStore,
			viewerStore,
		} = await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		const firstTabId = tabsStore.get().activeTabId;
		await loadPath("/workspace/a2.md");
		// a.md leaves this tab's viewer but stays in its stack, then a second tab
		// takes ownership of it.
		await openPathInNewTab("/workspace/a.md");
		await switchToTab(firstTabId);

		await goBack();

		// Back stayed inside the tab rather than jumping to the tab holding a.md.
		expect(tabsStore.get().activeTabId).toBe(firstTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/a2.md");
		expect(canGoBack()).toBe(false);
	});

	it("ignores switching to the active or an unknown tab", async () => {
		const api = createDesktopApi();
		const { openPathInNewTab, switchToTab, tabsStore, viewerStore } =
			await loadStore(api);

		await openPathInNewTab("/workspace/a.md");
		await openPathInNewTab("/workspace/b.md");
		const { activeTabId } = tabsStore.get();

		await switchToTab(activeTabId);
		await switchToTab("missing-tab");

		expect(tabsStore.get().activeTabId).toBe(activeTabId);
		expect(viewerStore.get().currentPath).toBe("/workspace/b.md");
		// The background tab keeps its buffer through both no-ops.
		expect(
			tabsStore.get().tabs.find((tab) => tab.id !== activeTabId)?.buffer,
		).toMatchObject({ currentPath: "/workspace/a.md" });
	});
});

/**
 * Reads that used to mean "the only document" now mean "the document at this
 * path", so a note parked on a background tab keeps saving, reloading, and
 * following renames while another tab is on screen.
 */
describe("tab-aware document reads", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	/** Leaves `path` open on a background tab holding an unsaved draft. */
	async function backgroundDraft(
		store: Awaited<ReturnType<typeof loadStore>>,
		disk: ReturnType<typeof withFakeDisk>,
		path: string,
		draft: string,
	) {
		await store.openPathInNewTab(path);
		const tabId = store.tabsStore.get().activeTabId;
		store.updateEditorContent(path, draft);
		// The save on the way out fails, so the tab is backgrounded still dirty.
		disk.failNextWrite();
		await store.openPathInNewTab("/workspace/active.md");
		return tabId;
	}

	function bufferOf(
		store: Awaited<ReturnType<typeof loadStore>>,
		tabId: string,
	) {
		return store.tabsStore.get().tabs.find((tab) => tab.id === tabId)?.buffer;
	}

	it("writes a background draft through the same preflight as the active note", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const tabId = await backgroundDraft(store, disk, "/workspace/a.md", "mine");
		api.readFileText.mockClear();

		await store.savePathContent("/workspace/a.md", "mine");

		expect(api.readFileText).toHaveBeenCalledWith("/workspace/a.md");
		expect(disk.read("/workspace/a.md")).toBe("mine");
		expect(bufferOf(store, tabId)).toMatchObject({
			currentPath: "/workspace/a.md",
			content: "mine",
			diskContent: "mine",
			externalChange: { kind: "none" },
		});
	});

	it("marks the background buffer and skips the write when disk moved on", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const tabId = await backgroundDraft(store, disk, "/workspace/a.md", "mine");
		disk.write("/workspace/a.md", "theirs");
		api.writeFileText.mockClear();

		await store.savePathContent("/workspace/a.md", "mine");

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(disk.read("/workspace/a.md")).toBe("theirs");
		expect(bufferOf(store, tabId)).toMatchObject({ content: "mine" });
		expect(bufferOf(store, tabId)?.externalChange).toEqual({
			kind: "conflict",
			diskContent: "theirs",
		});
	});

	it("does not treat Hubble's own late write as a background conflict", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const tabId = await backgroundDraft(store, disk, "/workspace/a.md", "mine");

		await store.savePathContent("/workspace/a.md", "v1", { force: true });
		await store.savePathContent("/workspace/a.md", "v2", { force: true });
		// The watcher reports the earlier of the two writes out of order. Without
		// self-save tracking that reads as someone else's text.
		store.handleExternalFileChange("/workspace/a.md", "v1");

		expect(bufferOf(store, tabId)).toMatchObject({
			content: "mine",
			diskContent: "v1",
			externalChange: { kind: "none" },
		});
	});

	it("reloads a clean background buffer and conflicts a dirty one", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		await store.openPathInNewTab("/workspace/clean.md");
		const cleanTabId = store.tabsStore.get().activeTabId;
		const dirtyTabId = await backgroundDraft(
			store,
			disk,
			"/workspace/dirty.md",
			"mine",
		);

		store.handleExternalFileChange("/workspace/clean.md", "agent wrote this");
		store.handleExternalFileChange("/workspace/dirty.md", "theirs");

		expect(bufferOf(store, cleanTabId)).toMatchObject({
			content: "agent wrote this",
			diskContent: "agent wrote this",
			externalChange: { kind: "none" },
		});
		expect(bufferOf(store, dirtyTabId)).toMatchObject({ content: "mine" });
		expect(bufferOf(store, dirtyTabId)?.externalChange).toEqual({
			kind: "conflict",
			diskContent: "theirs",
		});
	});

	it("rewrites a dirty background tab's links from its draft, not from disk", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		store.appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: "/workspace/docs/note.md", modified_at: 1 }],
			},
		}));
		const tabId = await backgroundDraft(
			store,
			disk,
			"/workspace/docs/note.md",
			"draft body\n\n[link](../other.md)",
		);
		api.readFileText.mockClear();

		await store.renameFolder("/workspace/docs", "docs", "/workspace/sub/docs");

		const rewritten = "draft body\n\n[link](../../other.md)";
		const movedPath = "/workspace/sub/docs/note.md";
		expect(api.readFileText).not.toHaveBeenCalledWith(movedPath);
		expect(disk.read(movedPath)).toBe(rewritten);
		expect(bufferOf(store, tabId)).toMatchObject({
			currentPath: movedPath,
			content: rewritten,
			diskContent: rewritten,
		});
	});

	it("saves and follows a background tab through a file rename", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const tabId = await backgroundDraft(store, disk, "/workspace/a.md", "mine");

		await store.renameMarkdownFile("/workspace/a.md", "renamed");

		// The draft reached disk before the file moved.
		expect(disk.read("/workspace/a.md")).toBe("mine");
		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/a.md",
			"/workspace/renamed.md",
		);
		expect(bufferOf(store, tabId)).toMatchObject({
			currentPath: "/workspace/renamed.md",
			content: "mine",
		});
		expect(store.historyStore.get().byTab[tabId].entries).toEqual([
			"/workspace/renamed.md",
		]);
		// The rename never pulled the renamed note back into the active tab.
		expect(store.viewerStore.get().currentPath).toBe("/workspace/active.md");
	});

	it("closes a background tab whose file was deleted", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const tabId = await backgroundDraft(store, disk, "/workspace/a.md", "mine");
		api.writeFileText.mockClear();

		await store.deleteMarkdownFile("/workspace/a.md");

		expect(store.tabsStore.get().tabs).toHaveLength(1);
		expect(store.tabsStore.get().tabs[0].id).not.toBe(tabId);
		// The draft is dropped rather than written back over a deleted file.
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(store.historyStore.get().byTab[tabId]).toBeUndefined();
		expect(store.viewerStore.get().currentPath).toBe("/workspace/active.md");
	});

	it("closes every background tab under a deleted folder", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		store.appStore.set((current) => ({
			...current,
			workspace: { ...current.workspace, workspacePath: "/workspace" },
		}));
		await store.openPathInNewTab("/workspace/docs/one.md");
		await store.openPathInNewTab("/workspace/docs/two.md");
		await store.openPathInNewTab("/workspace/keep.md");

		await store.deleteSidebarItems([
			{ kind: "folder", folderId: "/workspace/docs" },
		]);

		expect(store.tabsStore.get().tabs).toHaveLength(1);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/keep.md");
	});

	it("does not restore the history of a tab the delete closed", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		// Undo dismisses its toast, and sonner schedules that on a frame.
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
			callback();
			return 0;
		});
		store.appStore.set((current) => ({
			...current,
			workspace: { ...current.workspace, workspacePath: "/workspace" },
		}));
		await store.openPathInNewTab("/workspace/gone.md");
		const closedTabId = store.tabsStore.get().activeTabId;
		await store.openPathInNewTab("/workspace/keep.md");

		await store.deleteSidebarItems([
			{ kind: "file", path: "/workspace/gone.md" },
		]);
		await store.undoDelete();

		// The file comes back; the tab does not, so neither does its stack.
		expect(api.restoreDelete).toHaveBeenCalled();
		expect(store.tabForPath("/workspace/gone.md")).toBeNull();
		expect(store.historyStore.get().byTab[closedTabId]).toBeUndefined();
	});
});

describe("tab-aware title generation", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renames a note that was backgrounded before the debounce fired", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("");
		api.pathExists.mockImplementation(
			async (path: string) => path === "/workspace/new-file.assets",
		);
		const {
			appStore,
			createMarkdownFileInFolder,
			openPathInNewTab,
			tabsStore,
			updateEditorContent,
			viewerStore,
		} = await loadStore(api);
		appStore.set((state) => ({
			...state,
			workspace: { ...state.workspace, workspacePath: "/workspace" },
		}));

		const path = (await createMarkdownFileInFolder("/workspace")) as string;
		const noteTabId = tabsStore.get().activeTabId;
		const markdown = "![Diagram](new-file.assets/diagram.png)\n# First Title";
		updateEditorContent(path, markdown);
		// The user switches tabs inside the rename debounce window.
		await openPathInNewTab("/workspace/other.md");
		api.writeFileText.mockClear();

		await vi.advanceTimersByTimeAsync(500);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/new-file.md",
			"/workspace/first-title.md",
		);
		const renamedMarkdown =
			"![Diagram](first-title.assets/diagram.png)\n# First Title";
		expect(
			tabsStore.get().tabs.find((tab) => tab.id === noteTabId)?.buffer,
		).toMatchObject({
			currentPath: "/workspace/first-title.md",
			content: renamedMarkdown,
		});
		expect(api.writeFileText).toHaveBeenLastCalledWith(
			"/workspace/first-title.md",
			renamedMarkdown,
		);
		expect(viewerStore.get().currentPath).toBe("/workspace/other.md");
	});
});

describe("tab navigation shortcuts", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	/** Leaves three tabs open, a.md first and c.md active. */
	async function threeTabs(store: Awaited<ReturnType<typeof loadStore>>) {
		await store.openPathInNewTab("/workspace/a.md");
		await store.openPathInNewTab("/workspace/b.md");
		await store.openPathInNewTab("/workspace/c.md");
	}

	it("cycles forwards and backwards through the tab order", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		await threeTabs(store);

		// Forward from the last tab wraps around to the first.
		await store.switchToRelativeTab(1);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/a.md");
		await store.switchToRelativeTab(-1);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/c.md");
		await store.switchToRelativeTab(-1);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/b.md");
	});

	it("has nowhere to cycle to with a single tab", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		await store.openPathInNewTab("/workspace/a.md");

		expect(store.tabIdAtOffset(1)).toBeNull();
		expect(store.tabIdAtOffset(-1)).toBeNull();
	});

	it("jumps to a tab by slot, with slot 9 meaning the last tab", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		await threeTabs(store);

		await store.switchToTabSlot(2);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/b.md");
		await store.switchToTabSlot(9);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/c.md");
		// A slot past the last tab does nothing rather than clamping.
		await store.switchToTabSlot(5);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/c.md");
	});

	it("closes the tab on screen", async () => {
		const api = createDesktopApi();
		const store = await loadStore(api);
		await threeTabs(store);

		await store.closeActiveTab();

		expect(store.tabsStore.get().tabs).toHaveLength(2);
		expect(store.viewerStore.get().currentPath).toBe("/workspace/b.md");
	});
});

describe("tab indicators", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks unsaved drafts, and a conflict apart from them", async () => {
		const api = createDesktopApi();
		const disk = withFakeDisk(api);
		const store = await loadStore(api);
		const { documentIndicator } = store;

		await store.openPathInNewTab("/workspace/dirty.md");
		const dirtyTabId = store.tabsStore.get().activeTabId;
		store.updateEditorContent("/workspace/dirty.md", "mine");
		expect(documentIndicator(store.viewerStore.get())).toBe("dirty");

		// The save on the way out fails, so the tab is backgrounded still dirty.
		disk.failNextWrite();
		await store.openPathInNewTab("/workspace/clean.md");
		const dirtyBuffer = store.tabsStore
			.get()
			.tabs.find((tab) => tab.id === dirtyTabId)?.buffer;
		expect(documentIndicator(dirtyBuffer)).toBe("dirty");
		expect(documentIndicator(store.viewerStore.get())).toBe("none");

		store.handleExternalFileChange("/workspace/dirty.md", "theirs");
		expect(
			documentIndicator(
				store.tabsStore.get().tabs.find((tab) => tab.id === dirtyTabId)?.buffer,
			),
		).toBe("conflict");
	});

	it("leaves notes with no draft to lose unmarked", async () => {
		const api = createDesktopApi();
		const { documentIndicator, emptyDoc } = await loadStore(api);
		const base = emptyDoc();

		expect(documentIndicator(null)).toBe("none");
		expect(documentIndicator(base)).toBe("none");
		// The changelog is read-only, and so is an image.
		expect(
			documentIndicator({
				...base,
				currentPath: CHANGELOG_PATH,
				content: "edited",
			}),
		).toBe("none");
		expect(
			documentIndicator({
				...base,
				currentPath: "/workspace/diagram.png",
				content: "edited",
			}),
		).toBe("none");
	});
});
