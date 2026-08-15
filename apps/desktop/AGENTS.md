This app uses the React compiler. Avoid manual memos or callbacks.

## Multi-note tabs (fork patch)

The desktop app shows notes in tabs (one visible, no split view). The active
tab's document lives in `appStore.document` (`viewerStore`); background tabs
stash their whole `DocumentState` in `src/store/tabs.ts`, and a path is open in
at most one tab. Before touching anything that reads "the current document"
(saves, watchers, renames, link rewrites, title generation), read the header
comment in `src/store/tabs.ts` and use `getDocumentForPath` /
`updateDocumentForPath` so background tabs stay first-class.

`openPathInNewTab` (`src/store/actions.ts`) is the one entry point for "open
this path in a tab of its own"; second-instance file opens and the HTML app
runtime's `hubble.files.open(path, { newTab: true })` both go through it, while
plain `hubble.files.open(path)` still calls `loadPath`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
