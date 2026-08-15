import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDesktopApi = {
	readFileText: ReturnType<typeof vi.fn>;
	writeFileText: ReturnType<typeof vi.fn>;
	listDirectory: ReturnType<typeof vi.fn>;
	readWorkspaceConfig: ReturnType<typeof vi.fn>;
	writeWorkspaceConfig: ReturnType<typeof vi.fn>;
	renameFile: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
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
		setDeleteUndoAvailable: vi.fn(async () => {}),
		pathExists: vi.fn(async () => true),
		openPathFromLink: vi.fn(async () => ({ kind: "opened" })),
		openPathInDefaultApp: vi.fn(async () => {}),
		sidebarDeltaForPath: vi.fn(async () => null),
		setThemeSource: vi.fn(async () => {}),
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
