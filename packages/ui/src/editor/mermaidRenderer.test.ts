import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
}));
const sanitize = vi.hoisted(() => vi.fn());

vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("dompurify", () => ({ default: { sanitize } }));

async function importRenderer() {
	vi.resetModules();
	return await import("./mermaidRenderer");
}

beforeEach(() => {
	mermaid.initialize.mockReset();
	mermaid.parse.mockReset().mockResolvedValue(true);
	mermaid.render.mockReset().mockResolvedValue({ svg: "<svg>raw</svg>" });
	sanitize.mockReset().mockReturnValue("<svg>clean</svg>");
});

describe("renderMermaidDiagram", () => {
	it("returns the sanitized svg on success", async () => {
		const { renderMermaidDiagram } = await importRenderer();

		const result = await renderMermaidDiagram("graph TD; A-->B;", false);

		expect(result).toEqual({ ok: true, svg: "<svg>clean</svg>" });
		expect(sanitize).toHaveBeenCalledWith("<svg>raw</svg>", {
			USE_PROFILES: { svg: true, svgFilters: true },
			ADD_TAGS: ["style"],
			FORBID_TAGS: ["foreignObject", "script"],
		});
	});

	it("reports parse errors without rendering", async () => {
		const { renderMermaidDiagram } = await importRenderer();
		mermaid.parse.mockRejectedValue(new Error("Parse error on line 1"));

		const result = await renderMermaidDiagram("nope", false);

		expect(result).toEqual({ ok: false, message: "Parse error on line 1" });
		expect(mermaid.render).not.toHaveBeenCalled();
	});

	it("keeps the queue alive after a render rejection", async () => {
		const { renderMermaidDiagram } = await importRenderer();
		mermaid.render.mockRejectedValueOnce(new Error("render blew up"));

		const failed = await renderMermaidDiagram("graph TD; A-->B;", false);
		const recovered = await renderMermaidDiagram("graph TD; B-->C;", false);

		expect(failed).toEqual({ ok: false, message: "render blew up" });
		expect(recovered).toEqual({ ok: true, svg: "<svg>clean</svg>" });
	});

	it("serves repeated identical requests from the cache", async () => {
		const { renderMermaidDiagram } = await importRenderer();

		await renderMermaidDiagram("graph TD; A-->B;", false);
		const second = await renderMermaidDiagram("graph TD; A-->B;", false);

		expect(second).toEqual({ ok: true, svg: "<svg>clean</svg>" });
		expect(mermaid.render).toHaveBeenCalledTimes(1);
	});

	it("re-initializes and re-renders when the theme flips", async () => {
		const { renderMermaidDiagram } = await importRenderer();

		await renderMermaidDiagram("graph TD; A-->B;", false);
		await renderMermaidDiagram("graph TD; A-->B;", true);

		expect(mermaid.render).toHaveBeenCalledTimes(2);
		expect(mermaid.initialize).toHaveBeenCalledTimes(2);
		expect(mermaid.initialize.mock.calls[0]?.[0]).toMatchObject({
			theme: "default",
		});
		expect(mermaid.initialize.mock.calls[1]?.[0]).toMatchObject({
			theme: "dark",
		});
	});

	it("resolves concurrent renders in call order", async () => {
		const { renderMermaidDiagram } = await importRenderer();
		mermaid.render.mockImplementation(
			(_id: string, source: string) =>
				new Promise((resolve) => {
					setTimeout(
						() => resolve({ svg: source }),
						source === "first" ? 20 : 0,
					);
				}),
		);

		const settled: string[] = [];
		sanitize.mockImplementation((svg: string) => svg);

		await Promise.all([
			renderMermaidDiagram("first", false).then(() => settled.push("first")),
			renderMermaidDiagram("second", false).then(() => settled.push("second")),
			renderMermaidDiagram("third", false).then(() => settled.push("third")),
		]);

		expect(settled).toEqual(["first", "second", "third"]);
	});
});
