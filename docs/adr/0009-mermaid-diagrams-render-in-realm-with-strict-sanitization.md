# Mermaid diagrams render in-realm with strict sanitization

> **Status: accepted.** Applies to fenced `mermaid` code blocks in the Markdown editor.

A fenced `mermaid` code block renders as a diagram inside the code block's node view. Mermaid compiles diagram text to SVG, so the rendered output is markup produced from note content — the same trust question ADR-0004 and ADR-0005 answered for [[Embed]]s.

Decision: mermaid diagrams render **in-realm**, in the editor's own document, consistent with [ADR-0005](./0005-embeds-render-in-realm-shadow-dom.md)'s in-realm ruling and its document-level trust boundary. A diagram is content the author of the note wrote; it is trusted exactly as far as the note is. When a trust signal for foreign documents exists, the whole editor canvas is sandboxed (ADR-0005), and diagrams are inside it.

## Considered Options

- **Mermaid `securityLevel: "sandbox"`** (mermaid renders each diagram into its own iframe). Rejected for the reasons [ADR-0004](./0004-embeds-run-as-untrusted-sandboxed-iframes.md) documents: an iframe clips content to its frame rectangle and needs continuous height syncing, so a diagram could not size itself to its content or scroll and zoom inside the note. One iframe per diagram also costs a document per block.

## Mitigations

The in-realm choice puts the burden on the render path, so it is hardened rather than trusted:

- `securityLevel: "strict"` and `htmlLabels: false` (including `flowchart.htmlLabels`), so labels are SVG text rather than injected HTML.
- An extended `secure` config allowlist that freezes the security-relevant keys — a `%%{init}%%` directive inside diagram text cannot re-open `securityLevel`, `htmlLabels`, or theme/CSS injection.
- A second DOMPurify pass over mermaid's SVG output, with `foreignObject` and `script` forbidden, before the single `innerHTML` site in the node view. Mermaid sanitizes its own input; Hubble does not depend on that.
- Renders are serialized through one queue, because mermaid's config and id counter are module-global.
- An exact version pin (`mermaid` 11.17.0) rather than a range, so a mermaid release cannot change the sanitization surface without an explicit bump.

## Consequences

- The node view keeps one `innerHTML` assignment. Any future change to diagram output must keep going through the sanitizer, not around it.
- **Residual risk: no app-level CSP.** A sanitizer bypass has no second line of defence. This is a pre-existing gap for the desktop renderer, not one this decision introduces, but diagrams widen the surface that would benefit from closing it.
- **Residual risk: parser cost.** A pathological diagram can burn parse time on the main thread. Bounded by `maxTextSize` (50k) and `maxEdges` (500), not eliminated.
- Zoom, pan, and diagram height are node-view state only. They are never written to the node's attributes, so they never reach the note's markdown.
