export type MermaidRenderResult =
	| { ok: true; svg: string }
	| { ok: false; message: string };

type Mermaid = typeof import("mermaid").default;
type Sanitizer = typeof import("dompurify").default;

const CACHE_LIMIT = 50;

const cache = new Map<string, string>();

let mermaidPromise: Promise<Mermaid> | undefined;
let sanitizerPromise: Promise<Sanitizer> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let configuredDark: boolean | undefined;
let counter = 0;

function getMermaid(): Promise<Mermaid> {
	mermaidPromise ??= import("mermaid").then((m) => m.default);
	return mermaidPromise;
}

function getSanitizer(): Promise<Sanitizer> {
	sanitizerPromise ??= import("dompurify").then((m) => m.default);
	return sanitizerPromise;
}

function configure(mermaid: Mermaid, dark: boolean) {
	if (configuredDark === dark) return;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		suppressErrorRendering: true,
		htmlLabels: false,
		flowchart: { htmlLabels: false },
		theme: dark ? "dark" : "default",
		maxTextSize: 50_000,
		maxEdges: 500,
		secure: [
			"secure",
			"securityLevel",
			"startOnLoad",
			"maxTextSize",
			"suppressErrorRendering",
			"maxEdges",
			"theme",
			"themeVariables",
			"fontFamily",
			"look",
		],
	});
	configuredDark = dark;
}

export function renderMermaidDiagram(
	source: string,
	dark: boolean,
): Promise<MermaidRenderResult> {
	const key = `${dark ? "dark" : "light"}:${source}`;
	const cached = cache.get(key);
	if (cached !== undefined) return Promise.resolve({ ok: true, svg: cached });

	const result = queue.then(async (): Promise<MermaidRenderResult> => {
		try {
			const mermaid = await getMermaid();
			configure(mermaid, dark);
			await mermaid.parse(source);
			const { svg } = await mermaid.render(
				`hubble-mermaid-${counter++}`,
				source,
			);
			const sanitizer = await getSanitizer();
			const sanitized = sanitizer.sanitize(svg, {
				USE_PROFILES: { svg: true, svgFilters: true },
				ADD_TAGS: ["style"],
				FORBID_TAGS: ["foreignObject", "script"],
			});
			if (cache.size >= CACHE_LIMIT) {
				const oldest = cache.keys().next();
				if (!oldest.done) cache.delete(oldest.value);
			}
			cache.set(key, sanitized);
			return { ok: true, svg: sanitized };
		} catch (error) {
			return {
				ok: false,
				message:
					error instanceof Error && error.message
						? error.message
						: String(error),
			};
		}
	});
	queue = result;
	return result;
}
