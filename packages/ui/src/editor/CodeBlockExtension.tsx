import { Select } from "@base-ui/react/select";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { TextSelection } from "@tiptap/pm/state";
import {
	NodeViewContent,
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditorState,
} from "@tiptap/react";
import { common, createLowlight } from "lowlight";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteZoomInLine from "~icons/mingcute/zoom-in-line";
import MingcuteZoomOutLine from "~icons/mingcute/zoom-out-line";
import { Button } from "../primitives/button";
import { isDarkMode, subscribeDarkMode } from "./darkMode";
import { renderMermaidDiagram } from "./mermaidRenderer";

const DEFAULT_TAB_SIZE = 4;
const MERMAID_LANGUAGE = "mermaid";
const MERMAID_DEBOUNCE_MS = 150;
const MERMAID_ZOOM_STEP = 1.25;
const MERMAID_MIN_ZOOM = 0.25;
const MERMAID_MAX_ZOOM = 4;
const MERMAID_PAN_THRESHOLD_PX = 4;
const MERMAID_MIN_HEIGHT_PX = 96;
const MERMAID_MAX_HEIGHT_PX = 4000;
const MERMAID_FALLBACK_HEIGHT_PX = 320;
const MERMAID_HEIGHT_STEP_PX = 24;
const TWO_SPACE_LANGUAGES = new Set([
	"css",
	"html",
	"js",
	"json",
	"jsx",
	"md",
	"ts",
	"tsx",
]);
export const CODE_BLOCK_COPY_EVENT = "hubble:code-block-copy";

const lowlight = createLowlight(common);
lowlight.registerAlias({
	javascript: ["js", "jsx"],
	typescript: ["ts", "tsx"],
	xml: ["html"],
	bash: ["sh", "shell"],
	markdown: ["md"],
});

export const HubbleCodeBlock = CodeBlockLowlight.extend({
	addKeyboardShortcuts() {
		const { "Mod-Alt-c": _toggleCodeBlock, ...shortcuts } =
			this.parent?.() ?? {};
		return {
			...shortcuts,
			Tab: ({ editor }) => {
				const { state } = editor;
				const { selection } = state;
				const { $from, empty } = selection;
				if ($from.parent.type !== this.type) return false;

				const tabSize = tabSizeForLanguage($from.parent.attrs.language);
				const indent = " ".repeat(tabSize);

				if (empty) {
					return editor.commands.insertContent(indent);
				}

				return editor.commands.command(({ tr }) => {
					const { from, to } = selection;
					const text = state.doc.textBetween(from, to, "\n", "\n");
					const indentedText = text
						.split("\n")
						.map((line) => indent + line)
						.join("\n");
					tr.replaceWith(from, to, state.schema.text(indentedText));
					return true;
				});
			},
			Backspace: ({ editor }) => {
				const { state } = editor;
				const { selection } = state;
				if (!selection.empty) return false;

				const { $from } = selection;
				if ($from.parent.type !== this.type) return false;

				const blockStart = $from.start();
				const textBeforeCursor = state.doc.textBetween(
					blockStart,
					$from.pos,
					"\n",
					"\n",
				);
				const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
				const column = textBeforeCursor.length - lineStart;
				const linePrefix = textBeforeCursor.slice(lineStart);
				const tabSize = tabSizeForLanguage($from.parent.attrs.language);
				const previousSegment = linePrefix.slice(-tabSize);

				// Treat soft-tab spaces as one indentation unit at tab stops.
				if (
					column === 0 ||
					column % tabSize !== 0 ||
					previousSegment !== " ".repeat(tabSize)
				) {
					return false;
				}

				return editor.commands.command(({ tr }) => {
					const from = $from.pos - tabSize;
					tr.delete(from, $from.pos);
					tr.setSelection(TextSelection.create(tr.doc, from));
					return true;
				});
			},
		};
	},
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockView);
	},
}).configure({
	lowlight,
	enableTabIndentation: false,
	tabSize: DEFAULT_TAB_SIZE,
});

function CodeBlockView({
	editor,
	node,
	getPos,
	updateAttributes,
}: NodeViewProps) {
	const language =
		typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [selectOpen, setSelectOpen] = useState(false);
	// Mermaid blocks swap the source for a diagram whenever the selection sits
	// elsewhere, so the wrapper needs the active flag alongside the marker.
	const isMermaid = language === MERMAID_LANGUAGE;
	const active = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			if (!isMermaid) return false;
			const pos = getPos();
			if (pos === undefined) return false;
			const { from, to } = current.state.selection;
			// Containment rather than overlap: a selection that merely spans the
			// block, such as select-all, must not flip every diagram to source.
			return from >= pos && to <= pos + node.nodeSize;
		},
	});

	return (
		<NodeViewWrapper
			className="pm-code-block"
			as="div"
			data-mermaid={isMermaid ? "true" : undefined}
			data-mermaid-active={isMermaid && active ? "true" : undefined}
		>
			<div
				className="pm-code-block-controls"
				contentEditable={false}
				data-select-open={selectOpen}
			>
				<Select.Root
					open={selectOpen}
					onOpenChange={setSelectOpen}
					value={language}
					onValueChange={(next) => updateAttributes({ language: next || null })}
				>
					<Select.Trigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="xs"
								aria-label="Code block language"
								title="Code block language"
								className="pm-code-block-language h-4"
							/>
						}
					>
						<Select.Value>
							{languageLabel(language) || "Plain text"}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal>
						<Select.Positioner
							align="end"
							side="bottom"
							sideOffset={8}
							className="isolate z-50"
						>
							<Select.Popup className="z-50 w-40 origin-(--transform-origin) rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
								{codeBlockLanguages.map((option) => (
									<Select.Item
										key={option.value}
										value={option.value}
										className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-start text-[11px] text-foreground outline-hidden select-none data-highlighted:bg-accent"
									>
										<Select.ItemIndicator className="inline-flex" keepMounted>
											<MingcuteCheckLine className="size-3 [[data-selected]_&]:opacity-100 opacity-0" />
										</Select.ItemIndicator>
										<Select.ItemText>{option.label}</Select.ItemText>
									</Select.Item>
								))}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Copy code"
					title="Copy code"
					className="size-4"
					onClick={() => {
						void copyCodeBlock(node.textContent);
					}}
				>
					<MingcuteCopy2Line className="size-3.5" />
				</Button>
			</div>
			<pre>
				<NodeViewContent<"code">
					as="code"
					className={language ? `language-${language}` : undefined}
					style={{ whiteSpace: "inherit" }}
				/>
			</pre>
			{isMermaid ? (
				<MermaidDiagramSection
					editor={editor}
					node={node}
					getPos={getPos}
					active={active}
				/>
			) : null}
		</NodeViewWrapper>
	);
}

type MermaidState = {
	status: "idle" | "loading" | "ready" | "error" | "empty";
	svg?: string;
	message?: string;
};

type NaturalSize = { width: number; height: number };

function MermaidDiagramSection({
	editor,
	node,
	getPos,
	active,
}: Pick<NodeViewProps, "editor" | "node" | "getPos"> & { active: boolean }) {
	const source = node.textContent;
	const dark = useSyncExternalStore(subscribeDarkMode, isDarkMode, () => false);
	const editable = useEditorState({
		editor,
		selector: ({ editor: current }) => current.isEditable,
	});
	const [state, setState] = useState<MermaidState>({ status: "idle" });
	// `null` is the fit zoom: the svg stays constrained to the viewport width.
	const [zoom, setZoom] = useState<number | null>(null);
	const [natural, setNatural] = useState<NaturalSize | null>(null);
	// Zoom and height are view state only; the document keeps just `language`.
	const [maxHeight, setMaxHeight] = useState<number | null>(null);
	const canvasRef = useRef<HTMLSpanElement | null>(null);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	// The pan and scroll effects have to re-run once the viewport mounts behind
	// the loading placeholder, which a bare ref would not tell them.
	const [viewportReady, setViewportReady] = useState(false);
	const anchorRef = useRef<{ x: number; y: number } | null>(null);
	const renderedRef = useRef(false);

	useEffect(() => {
		if (active) return;
		if (source.trim().length === 0) {
			setState({ status: "empty" });
			return;
		}
		let cancelled = false;
		setState((previous) => ({ ...previous, status: "loading" }));
		const render = () => {
			void renderMermaidDiagram(source, dark).then((result) => {
				if (cancelled) return;
				setState((previous) =>
					result.ok
						? { status: "ready", svg: result.svg }
						: {
								status: "error",
								svg: previous.svg,
								message: result.message,
							},
				);
			});
		};
		// The first paint usually hits the renderer cache, so debouncing it would
		// only flash the placeholder when a note reopens.
		if (!renderedRef.current) {
			renderedRef.current = true;
			render();
			return () => {
				cancelled = true;
			};
		}
		const timer = setTimeout(render, MERMAID_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [source, dark, active]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		// The renderer sanitizes mermaid's output, so this stays the one place the
		// editor trusts a string as markup.
		canvas.innerHTML = state.svg ?? "";
		const svg = canvas.querySelector("svg");
		setNatural(svg ? measureNaturalSize(svg) : null);
	}, [state.svg]);

	useEffect(() => {
		const viewport = viewportReady ? viewportRef.current : null;
		if (!viewport) return;
		const anchor = anchorRef.current;
		anchorRef.current = null;
		if (zoom === null) {
			viewport.scrollLeft = 0;
			viewport.scrollTop = 0;
			return;
		}
		if (!anchor) return;
		viewport.scrollLeft = Math.max(0, anchor.x);
		viewport.scrollTop = Math.max(0, anchor.y);
	}, [zoom, viewportReady]);

	useEffect(() => {
		const viewport = viewportReady ? viewportRef.current : null;
		if (!viewport) return;
		let panning = false;
		let travelled = 0;
		let lastX = 0;
		let lastY = 0;
		let captured: number | undefined;
		let suppressClick = false;

		const onWheel = (event: WheelEvent) => {
			// A trackpad pinch reaches the page as a ctrl-modified wheel event.
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const from = zoom ?? 1;
			const next = clampZoom(
				from * (event.deltaY < 0 ? MERMAID_ZOOM_STEP : 1 / MERMAID_ZOOM_STEP),
			);
			if (next === from) return;
			const rect = viewport.getBoundingClientRect();
			const offsetX = event.clientX - rect.left;
			const offsetY = event.clientY - rect.top;
			const ratio = next / from;
			anchorRef.current = {
				x: (viewport.scrollLeft + offsetX) * ratio - offsetX,
				y: (viewport.scrollTop + offsetY) * ratio - offsetY,
			};
			setZoom(next);
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			panning = true;
			travelled = 0;
			suppressClick = false;
			lastX = event.clientX;
			lastY = event.clientY;
			viewport.dataset.panning = "true";
			if (typeof event.pointerId === "number") {
				viewport.setPointerCapture?.(event.pointerId);
				captured = event.pointerId;
			}
		};

		const onPointerMove = (event: PointerEvent) => {
			if (!panning) return;
			const deltaX = event.clientX - lastX;
			const deltaY = event.clientY - lastY;
			lastX = event.clientX;
			lastY = event.clientY;
			travelled += Math.abs(deltaX) + Math.abs(deltaY);
			viewport.scrollLeft -= deltaX;
			viewport.scrollTop -= deltaY;
		};

		const onPointerUp = () => {
			if (!panning) return;
			panning = false;
			delete viewport.dataset.panning;
			if (captured !== undefined) {
				viewport.releasePointerCapture?.(captured);
				captured = undefined;
			}
			// A pan that ended on the diagram must not also open the source.
			suppressClick = travelled > MERMAID_PAN_THRESHOLD_PX;
		};

		const onClickCapture = (event: MouseEvent) => {
			if (!suppressClick) return;
			suppressClick = false;
			event.preventDefault();
			event.stopPropagation();
		};

		viewport.addEventListener("wheel", onWheel, { passive: false });
		viewport.addEventListener("pointerdown", onPointerDown);
		viewport.addEventListener("click", onClickCapture, true);
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerUp);
		return () => {
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("pointerdown", onPointerDown);
			viewport.removeEventListener("click", onClickCapture, true);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
		};
	}, [zoom, viewportReady]);

	if (state.svg === undefined) {
		return (
			<div className="pm-mermaid-section" contentEditable={false}>
				{state.status === "error" ? (
					<div className="pm-mermaid-error">
						<span>Mermaid diagram error</span>
						<code>{state.message}</code>
					</div>
				) : (
					<div className="pm-mermaid-placeholder">
						{state.status === "empty" ? "Empty diagram" : "Rendering diagram…"}
					</div>
				)}
			</div>
		);
	}

	const scale = zoom ?? 1;
	const sized = zoom !== null && natural !== null;

	return (
		<div className="pm-mermaid-section" contentEditable={false}>
			<div
				className="pm-mermaid-viewport"
				ref={(element) => {
					viewportRef.current = element;
					setViewportReady(element !== null);
				}}
				style={maxHeight === null ? undefined : { maxHeight }}
			>
				<button
					type="button"
					className="pm-mermaid-diagram"
					aria-label="Edit mermaid source"
					// A read-only editor has no source to move the caret into, so the
					// diagram must not sit in the tab order offering an inert control.
					disabled={!editable}
					onClick={() => {
						const pos = getPos();
						if (pos === undefined) return;
						editor
							.chain()
							.focus()
							.setTextSelection(pos + 1)
							.run();
					}}
				>
					<span
						className="pm-mermaid-sizer"
						style={
							sized
								? {
										width: natural.width * scale,
										height: natural.height * scale,
									}
								: undefined
						}
					>
						<span
							className="pm-mermaid-canvas"
							ref={canvasRef}
							data-zoomed={zoom === null ? undefined : "true"}
							style={
								zoom === null
									? undefined
									: {
											width: natural?.width,
											height: natural?.height,
											transform: `scale(${scale})`,
											transformOrigin: "top left",
										}
							}
						/>
					</span>
				</button>
			</div>
			<div className="pm-mermaid-controls">
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Zoom out diagram"
					title="Zoom out"
					className="size-4"
					onClick={() => setZoom(clampZoom(scale / MERMAID_ZOOM_STEP))}
				>
					<MingcuteZoomOutLine className="size-3.5" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-label="Reset diagram zoom"
					title="Reset zoom"
					className="pm-mermaid-zoom-label h-4"
					onClick={() => setZoom(null)}
				>
					{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Zoom in diagram"
					title="Zoom in"
					className="size-4"
					onClick={() => setZoom(clampZoom(scale * MERMAID_ZOOM_STEP))}
				>
					<MingcuteZoomInLine className="size-3.5" />
				</Button>
			</div>
			{/* An <hr> so the drag handle carries the separator role natively. */}
			<hr
				className="pm-mermaid-resize"
				aria-orientation="horizontal"
				aria-label="Resize diagram"
				aria-valuenow={maxHeight ?? MERMAID_FALLBACK_HEIGHT_PX}
				aria-valuemin={MERMAID_MIN_HEIGHT_PX}
				aria-valuemax={MERMAID_MAX_HEIGHT_PX}
				tabIndex={0}
				onDoubleClick={() => setMaxHeight(null)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown") {
						setMaxHeight(
							clampHeight(
								currentHeight(viewportRef.current, maxHeight) +
									MERMAID_HEIGHT_STEP_PX,
							),
						);
					} else if (event.key === "ArrowUp") {
						setMaxHeight(
							clampHeight(
								currentHeight(viewportRef.current, maxHeight) -
									MERMAID_HEIGHT_STEP_PX,
							),
						);
					} else if (event.key === "Escape") {
						setMaxHeight(null);
					} else {
						return;
					}
					event.preventDefault();
				}}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					const startY = event.clientY;
					const startHeight = currentHeight(viewportRef.current, maxHeight);
					const handle = event.currentTarget;
					if (typeof event.pointerId === "number") {
						handle.setPointerCapture?.(event.pointerId);
					}
					const onMove = (move: PointerEvent) => {
						setMaxHeight(clampHeight(startHeight + move.clientY - startY));
					};
					const onUp = () => {
						window.removeEventListener("pointermove", onMove);
						window.removeEventListener("pointerup", onUp);
						window.removeEventListener("pointercancel", onUp);
					};
					window.addEventListener("pointermove", onMove);
					window.addEventListener("pointerup", onUp);
					window.addEventListener("pointercancel", onUp);
				}}
			/>
			{state.status === "error" ? (
				<span className="pm-mermaid-stale-badge">syntax error</span>
			) : null}
		</div>
	);
}

function clampZoom(value: number) {
	return Math.min(
		MERMAID_MAX_ZOOM,
		Math.max(MERMAID_MIN_ZOOM, Math.round(value * 100) / 100),
	);
}

function clampHeight(value: number) {
	return Math.min(
		MERMAID_MAX_HEIGHT_PX,
		Math.max(MERMAID_MIN_HEIGHT_PX, Math.round(value)),
	);
}

function currentHeight(
	viewport: HTMLDivElement | null,
	maxHeight: number | null,
) {
	if (maxHeight !== null) return maxHeight;
	return viewport?.offsetHeight || MERMAID_FALLBACK_HEIGHT_PX;
}

/**
 * Mermaid sizes its svg in viewBox units, so the intrinsic size is readable
 * without layout — which also keeps zooming honest before the first paint.
 */
function measureNaturalSize(svg: Element): NaturalSize | null {
	const viewBox = svg
		.getAttribute("viewBox")
		?.split(/[\s,]+/)
		.map(Number);
	if (
		viewBox?.length === 4 &&
		viewBox.every((value) => Number.isFinite(value))
	) {
		const [, , width, height] = viewBox;
		if (width > 0 && height > 0) return { width, height };
	}
	const widthAttribute = svg.getAttribute("width") ?? "";
	const heightAttribute = svg.getAttribute("height") ?? "";
	const width = Number.parseFloat(widthAttribute);
	const height = Number.parseFloat(heightAttribute);
	if (
		width > 0 &&
		height > 0 &&
		!widthAttribute.includes("%") &&
		!heightAttribute.includes("%")
	) {
		return { width, height };
	}
	const rect = svg.getBoundingClientRect?.();
	if (rect && rect.width > 0 && rect.height > 0) {
		return { width: rect.width, height: rect.height };
	}
	return null;
}

function languageLabel(value: string) {
	return codeBlockLanguages.find((option) => option.value === value)?.label;
}

function tabSizeForLanguage(language: unknown) {
	return typeof language === "string" && TWO_SPACE_LANGUAGES.has(language)
		? 2
		: DEFAULT_TAB_SIZE;
}

async function copyCodeBlock(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		// TODO: Revisit if UI grows a shared toast store; this bridges TipTap's node view to EditorView's onMessage without adding app state here.
		window.dispatchEvent(
			new CustomEvent(CODE_BLOCK_COPY_EVENT, {
				detail: { message: "Code copied", type: "success" },
			}),
		);
	} catch {
		window.dispatchEvent(
			new CustomEvent(CODE_BLOCK_COPY_EVENT, {
				detail: { message: "Failed to copy code", type: "error" },
			}),
		);
	}
}

const codeBlockLanguages = [
	{ value: "", label: "Plain text" },
	{ value: "js", label: "JavaScript" },
	{ value: "ts", label: "TypeScript" },
	{ value: "jsx", label: "JSX" },
	{ value: "tsx", label: "TSX" },
	{ value: "json", label: "JSON" },
	{ value: "css", label: "CSS" },
	{ value: "html", label: "HTML" },
	{ value: "md", label: "Markdown" },
	{ value: "sh", label: "Shell" },
	{ value: "python", label: "Python" },
	{ value: "rust", label: "Rust" },
	{ value: "go", label: "Go" },
	{ value: "mermaid", label: "Mermaid" },
] as const;
