import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror.js";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown.js";

describe("code block markdown conversion", () => {
	it("preserves fenced code block language", () => {
		const doc = markdownToTiptapDoc("```ts\nconst x: number = 1;\n```");

		expect(doc.content?.[0]).toEqual({
			type: "codeBlock",
			attrs: { language: "ts" },
			content: [{ type: "text", text: "const x: number = 1;" }],
		});
		expect(tiptapDocToMarkdown(doc)).toBe("```ts\nconst x: number = 1;\n```");
	});

	it("preserves mermaid fences verbatim", () => {
		const markdown = "```mermaid\ngraph TD;\n  A-->B;\n```";
		const doc = markdownToTiptapDoc(markdown);

		expect(doc.content?.[0]).toEqual({
			type: "codeBlock",
			attrs: { language: "mermaid" },
			content: [{ type: "text", text: "graph TD;\n  A-->B;" }],
		});
		expect(tiptapDocToMarkdown(doc)).toBe(markdown);
	});

	it("keeps bare fenced code blocks bare", () => {
		const doc = markdownToTiptapDoc("```\nplain\n```");

		expect(doc.content?.[0]?.attrs).toEqual({ language: null });
		expect(tiptapDocToMarkdown(doc)).toBe("```\nplain\n```");
	});
});
