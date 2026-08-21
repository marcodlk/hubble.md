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
import {
	type MermaidRenderResult,
	renderMermaidDiagram,
} from "./mermaidRenderer";

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
	renderMock.mockReset().mockResolvedValue({ ok: true, svg: MERMAID_SVG });
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

	it("rests on a quiet empty state for a blank block nobody is editing", async () => {
		const { container } = await mountEditor("mermaid", { source: "   \n  " });

		const placeholder = container.querySelector(".pm-mermaid-placeholder");
		expect(placeholder?.textContent).toBe("Empty diagram");
		expect(container.querySelector(".pm-mermaid-error")).toBeNull();
		expect(renderMock).not.toHaveBeenCalled();
	});

	it("drops back to the empty state when the source is cleared", async () => {
		const { container, editor } = await mountEditor("mermaid");
		expect(container.querySelector(".pm-mermaid-diagram")).not.toBeNull();

		await act(async () => {
			const { from, to } = codeBlockRange(editor);
			editor.view.dispatch(editor.state.tr.delete(from + 1, to - 1));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(container.querySelector(".pm-mermaid-diagram")).toBeNull();
		expect(
			container.querySelector(".pm-mermaid-placeholder")?.textContent,
		).toBe("Empty diagram");
	});

	it("keeps the last good diagram behind a badge when an edit breaks it", async () => {
		const { container, editor } = await mountEditor("mermaid");
		const diagram = container.querySelector(".pm-mermaid-diagram");
		expect(diagram?.innerHTML).toContain("svg");
		expect(container.querySelector(".pm-mermaid-stale-badge")).toBeNull();

		renderMock.mockResolvedValue({ ok: false, message: "Parse error" });
		await act(async () => {
			appendToCodeBlock(editor, "!!!");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(container.querySelector(".pm-mermaid-diagram")).toBe(diagram);
		expect(diagram?.innerHTML).toContain("svg");
		expect(container.querySelector(".pm-mermaid-stale-badge")).not.toBeNull();
		expect(container.querySelector(".pm-mermaid-error")).toBeNull();

		renderMock.mockResolvedValue({ ok: true, svg: "<svg id='fixed'></svg>" });
		await act(async () => {
			appendToCodeBlock(editor, ";");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(container.querySelector(".pm-mermaid-stale-badge")).toBeNull();
		expect(diagram?.querySelector("#fixed")).not.toBeNull();
	});

	it("never lets a slow render overwrite a newer one", async () => {
		const pending = new Map<string, (result: MermaidRenderResult) => void>();
		renderMock.mockImplementation(
			(source: string) =>
				new Promise((resolve) => {
					pending.set(source, resolve);
				}),
		);

		const { container, editor } = await mountEditor("mermaid");
		expect(pending.has(MERMAID_SOURCE)).toBe(true);

		await act(async () => {
			appendToCodeBlock(editor, "\n  B-->C;");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		const newest = `${MERMAID_SOURCE}\n  B-->C;`;

		await act(async () => {
			pending.get(newest)?.({ ok: true, svg: "<svg id='newest'></svg>" });
		});
		await act(async () => {
			pending.get(MERMAID_SOURCE)?.({
				ok: true,
				svg: "<svg id='stale'></svg>",
			});
		});

		const diagram = container.querySelector(".pm-mermaid-diagram");
		expect(diagram?.querySelector("#newest")).not.toBeNull();
		expect(diagram?.querySelector("#stale")).toBeNull();
	});

	it("offers no live edit control in a read-only editor", async () => {
		const { container, editor } = await mountEditor("mermaid", {
			editable: false,
		});

		const diagram = container.querySelector<HTMLButtonElement>(
			".pm-mermaid-diagram",
		);
		expect(diagram?.innerHTML).toContain("svg");
		expect(diagram?.disabled).toBe(true);

		await act(async () => {
			diagram?.click();
		});
		expect(editor.state.selection.from).toBe(1);
		expect(
			container.querySelector<HTMLElement>("[data-mermaid]")?.dataset
				.mermaidActive,
		).toBeUndefined();
	});

	it("moves the caret into the source when the diagram is clicked", async () => {
		const { container, editor } = await mountEditor("mermaid");
		const wrapper = container.querySelector<HTMLElement>("[data-mermaid]");

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>(".pm-mermaid-diagram")
				?.click();
		});

		expect(editor.state.selection.from).toBe(codeBlockRange(editor).from + 1);
		expect(wrapper?.dataset.mermaidActive).toBe("true");
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

		await act(async () => {
			editor.commands.selectAll();
		});
		expect(wrapper?.dataset.mermaidActive).toBeUndefined();
		expect(container.querySelector(".pm-mermaid-diagram")).not.toBeNull();
	});

	it("renders the first diagram without waiting out the debounce", async () => {
		const { container } = await mountEditor("mermaid", { settle: false });

		expect(renderMock).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".pm-mermaid-diagram")).not.toBeNull();
	});

	it("zooms the canvas in steps and back to fit", async () => {
		const { container } = await mountEditor("mermaid");
		const sizer = container.querySelector<HTMLElement>(".pm-mermaid-sizer");
		const canvas = container.querySelector<HTMLElement>(".pm-mermaid-canvas");
		expect(label(container)?.textContent).toBe("Fit");
		expect(canvas?.style.transform).toBe("");

		await act(async () => {
			control(container, "Zoom in diagram")?.click();
		});

		expect(label(container)?.textContent).toBe("125%");
		expect(canvas?.style.transform).toBe("scale(1.25)");
		// Natural size comes from the viewBox, since happy-dom has no layout.
		expect(canvas?.style.width).toBe("400px");
		expect(sizer?.style.width).toBe("500px");
		expect(sizer?.style.height).toBe("250px");

		await act(async () => {
			control(container, "Reset diagram zoom")?.click();
		});

		expect(label(container)?.textContent).toBe("Fit");
		expect(canvas?.style.transform).toBe("");
		expect(sizer?.style.width).toBe("");
	});

	it("steps out from the scale a fitted diagram is drawn at", async () => {
		const { container } = await mountEditor("mermaid");
		const svg = container.querySelector<SVGElement>(".pm-mermaid-canvas svg");
		// A 400-wide diagram fitted into a 200-wide viewport draws at 50%.
		if (svg) {
			svg.getBoundingClientRect = () =>
				({ width: 200, height: 100 }) as DOMRect;
		}

		await act(async () => {
			control(container, "Zoom out diagram")?.click();
		});

		expect(label(container)?.textContent).toBe("40%");
	});

	it("pans without opening the source once the drag passes the threshold", async () => {
		const { container, editor } = await mountEditor("mermaid");
		const viewport = container.querySelector<HTMLElement>(
			".pm-mermaid-viewport",
		);
		const diagram = container.querySelector<HTMLButtonElement>(
			".pm-mermaid-diagram",
		);

		await act(async () => {
			viewport?.dispatchEvent(pointerEvent("pointerdown", 100, 100));
			window.dispatchEvent(pointerEvent("pointermove", 140, 130));
			window.dispatchEvent(pointerEvent("pointerup", 140, 130));
			diagram?.dispatchEvent(pointerEvent("click", 140, 130));
		});
		expect(editor.state.selection.from).toBe(1);

		await act(async () => {
			viewport?.dispatchEvent(pointerEvent("pointerdown", 100, 100));
			window.dispatchEvent(pointerEvent("pointermove", 101, 101));
			window.dispatchEvent(pointerEvent("pointerup", 101, 101));
			diagram?.dispatchEvent(pointerEvent("click", 101, 101));
		});
		expect(editor.state.selection.from).toBe(codeBlockRange(editor).from + 1);
	});

	it("still opens the source from the keyboard after a cancelled pan", async () => {
		const { container, editor } = await mountEditor("mermaid");
		const viewport = container.querySelector<HTMLElement>(
			".pm-mermaid-viewport",
		);

		// A cancelled pan leaves no click behind, so the swallower stays armed.
		await act(async () => {
			viewport?.dispatchEvent(pointerEvent("pointerdown", 100, 100));
			window.dispatchEvent(pointerEvent("pointermove", 140, 130));
			window.dispatchEvent(pointerEvent("pointercancel", 140, 130));
		});
		await act(async () => {
			// Enter on the focused button dispatches a click with no click count.
			container
				.querySelector<HTMLButtonElement>(".pm-mermaid-diagram")
				?.click();
		});

		expect(editor.state.selection.from).toBe(codeBlockRange(editor).from + 1);
	});

	it("resizes the viewport from the handle and resets on double click", async () => {
		const { container } = await mountEditor("mermaid");
		const viewport = container.querySelector<HTMLElement>(
			".pm-mermaid-viewport",
		);
		const handle = container.querySelector<HTMLElement>(".pm-mermaid-resize");
		expect(viewport?.style.maxHeight).toBe("");

		await act(async () => {
			handle?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		expect(viewport?.style.maxHeight).toBe("344px");

		await act(async () => {
			handle?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
			);
		});
		expect(viewport?.style.maxHeight).toBe("320px");

		await act(async () => {
			handle?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(viewport?.style.maxHeight).toBe("");
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
const MERMAID_SVG = '<svg viewBox="0 0 400 200" width="100%"></svg>';

async function mountEditor(
	language: string,
	options: { source?: string; editable?: boolean; settle?: boolean } = {},
) {
	const source = options.source ?? MERMAID_SOURCE;
	const editor = new Editor({
		editable: options.editable ?? true,
		extensions: [StarterKit.configure({ codeBlock: false }), HubbleCodeBlock],
		content: {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "intro" }] },
				{
					type: "codeBlock",
					attrs: { language },
					content: source ? [{ type: "text", text: source }] : [],
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
	if (options.settle !== false) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
	}
	return { container, editor, root };
}

/**
 * The code block is not reliably the doc's last child: the starter kit appends
 * a trailing paragraph once the first transaction lands.
 */
function codeBlockRange(editor: Editor) {
	let range: { from: number; to: number } | undefined;
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "codeBlock")
			range = { from: pos, to: pos + node.nodeSize };
	});
	if (!range) throw new Error("Expected code block");
	return range;
}

/** Edits the block's source while leaving the selection outside of it. */
function appendToCodeBlock(editor: Editor, text: string) {
	const end = codeBlockRange(editor).to - 1;
	editor.view.dispatch(editor.state.tr.insertText(text, end, end));
}

function control(container: HTMLElement, label: string) {
	return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

function label(container: HTMLElement) {
	return control(container, "Reset diagram zoom");
}

/** happy-dom has no PointerEvent, and the node view only reads mouse fields. */
function pointerEvent(type: string, clientX: number, clientY: number) {
	return new MouseEvent(type, {
		bubbles: true,
		clientX,
		clientY,
		button: 0,
		detail: 1,
	});
}

function selectInsideCodeBlock(editor: Editor) {
	const pos = codeBlockRange(editor).from + 1;
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
	);
}
