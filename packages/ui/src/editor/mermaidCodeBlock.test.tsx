// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { act, type ReactNode } from "react";
// @ts-expect-error This package does not ship @types/react-dom; the test only
// needs createRoot's render/unmount surface.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubbleCodeBlock } from "./CodeBlockExtension";
import { renderMermaidDiagram } from "./mermaidRenderer";

vi.mock("./mermaidRenderer", () => ({
	renderMermaidDiagram: vi.fn(),
}));

const renderMock = vi.mocked(renderMermaidDiagram);

type Root = {
	render(children: ReactNode): void;
	unmount(): void;
};

const roots: Root[] = [];
const editors: Editor[] = [];

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
	vi.useFakeTimers();
	renderMock.mockReset().mockResolvedValue({ ok: true, svg: "<svg />" });
});

afterEach(() => {
	act(() => {
		for (const root of roots) root.unmount();
	});
	roots.length = 0;
	for (const editor of editors) editor.destroy();
	editors.length = 0;
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe("mermaid code block node view", () => {
	it("renders a diagram container only for mermaid blocks", async () => {
		const { container } = await mountEditor("mermaid");

		expect(container.querySelector(".pm-mermaid-diagram")).not.toBeNull();
		expect(container.querySelector("[data-mermaid]")).not.toBeNull();

		const other = await mountEditor("ts");

		expect(other.container.querySelector(".pm-mermaid-diagram")).toBeNull();
		expect(other.container.querySelector("[data-mermaid]")).toBeNull();
		expect(renderMock).toHaveBeenCalledTimes(1);
	});

	it("inserts the sanitized svg returned by the renderer", async () => {
		renderMock.mockResolvedValue({ ok: true, svg: "<svg id='diagram'></svg>" });

		const { container } = await mountEditor("mermaid");

		const diagram = container.querySelector(".pm-mermaid-diagram");
		expect(diagram?.querySelector("#diagram")).not.toBeNull();
	});

	it("shows the error panel without touching the source", async () => {
		renderMock.mockResolvedValue({
			ok: false,
			message: "Parse error on line 1",
		});

		const { container, editor } = await mountEditor("mermaid");
		const json = JSON.stringify(editor.getJSON());

		const error = container.querySelector(".pm-mermaid-error");
		expect(error?.textContent).toContain("Parse error on line 1");
		expect(container.querySelector(".pm-mermaid-diagram")).toBeNull();
		expect(JSON.stringify(editor.getJSON())).toBe(json);
		expect(editor.state.doc.lastChild?.textContent).toBe(MERMAID_SOURCE);
	});

	it("marks the wrapper active while the selection sits inside the block", async () => {
		const { container, editor } = await mountEditor("mermaid");
		const wrapper = container.querySelector<HTMLElement>("[data-mermaid]");
		expect(wrapper?.dataset.mermaidActive).toBeUndefined();

		await act(async () => {
			selectInsideCodeBlock(editor);
		});
		expect(wrapper?.dataset.mermaidActive).toBe("true");

		await act(async () => {
			editor.view.dispatch(
				editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
			);
		});
		expect(wrapper?.dataset.mermaidActive).toBeUndefined();
	});

	it("survives a destroy that lands before the render resolves", async () => {
		const errors: unknown[] = [];
		let resolveRender: (value: { ok: true; svg: string }) => void = () => {};
		renderMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRender = resolve;
				}),
		);
		const onError = (event: PromiseRejectionEvent | ErrorEvent) => {
			errors.push(event);
		};
		window.addEventListener("unhandledrejection", onError);
		window.addEventListener("error", onError);

		const { editor, root } = await mountEditor("mermaid");
		act(() => {
			root.unmount();
		});
		roots.length = 0;
		editor.destroy();
		editors.length = 0;

		await act(async () => {
			resolveRender({ ok: true, svg: "<svg />" });
			await Promise.resolve();
		});

		expect(errors).toEqual([]);
		window.removeEventListener("unhandledrejection", onError);
		window.removeEventListener("error", onError);
	});
});

const MERMAID_SOURCE = "graph TD;\n  A-->B;";

async function mountEditor(language: string) {
	const editor = new Editor({
		extensions: [StarterKit.configure({ codeBlock: false }), HubbleCodeBlock],
		content: {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "intro" }] },
				{
					type: "codeBlock",
					attrs: { language },
					content: [{ type: "text", text: MERMAID_SOURCE }],
				},
			],
		},
	});
	editors.push(editor);

	const container = document.createElement("div");
	container.dataset.hubbleEditor = "true";
	document.body.append(container);
	const root = createRoot(container) as Root;
	roots.push(root);
	await act(async () => {
		root.render(<EditorContent editor={editor} />);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
	return { container, editor, root };
}

function selectInsideCodeBlock(editor: Editor) {
	const codeBlock = editor.state.doc.lastChild;
	if (!codeBlock) throw new Error("Expected code block");
	const pos = editor.state.doc.content.size - codeBlock.nodeSize + 1;
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
	);
}
