# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript Obsidian plugin that keeps a local version history for
Markdown notes. Source code lives in `src/`, with the plugin entry point at
`src/main.ts`, settings UI and persistence in `src/settings.ts`, and local
PouchDB type declarations in `src/pouchdb.d.ts`.

History logic lives in `src/history/`: document shapes in `types.ts`, note and
identifier helpers in `note-files.ts`, local storage in `pouchdb-store.ts`, and
capture, rename, deletion, restore, and reconciliation in `history-service.ts`.

User interface files sit at the top of `src/`: the sidebar timeline in
`history-panel-view.ts`, the version preview and restore dialog in
`version-preview-modal.ts`, the destructive reset dialog in
`local-database-reset-modal.ts`, and shared display strings in
`version-labels.ts`. Shared helpers are in `src/utils/`.

Tests live in `tests/`, mirroring `src/`. `tests/mocks/obsidian.ts` replaces the
Obsidian runtime, `tests/mocks/pouchdb.ts` is an in-memory PouchDB stand-in, and
`tests/mocks/vault.ts` builds a fake vault with a real folder tree.

Obsidian release metadata is stored in `manifest.json` and compatibility
versions in `versions.json`. Build configuration lives in `esbuild.config.mjs`,
`tsconfig.json`, and `tsconfig.test.json`; test configuration in
`vitest.config.ts`; package and release automation in `package.json` and
`version-bump.mjs`. Styles belong in `styles.css`, which the build copies into
`dist/` and which must exist for `npm run build` to succeed.

Generated files are not source: `dist/` contains the bundled plugin artifacts
(`main.js`, `manifest.json`, `styles.css`), and `coverage/` the coverage report.
Root-level `main.js` is ignored as a legacy artifact if present. Dependencies in
`node_modules/` should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install dependencies for Node.js 22.22 or newer.
- `npm run dev`: watch `src/main.ts` and emit the bundle for local testing.
- `npm run build`: run TypeScript checks and produce a production bundle.
- `npm test`: run the Vitest unit suite once.
- `npm run test:watch`: run the unit suite in watch mode.
- `npm run test:coverage`: write the V8 coverage report to `coverage/`.
- `npm run test:typecheck`: type-check test code against `tsconfig.test.json`.
- `npm run check`: build, type-check tests, and run the suite. Required before
  committing.
- `npm version patch|minor|major`: update `package.json`, then run the version
  hook to sync `manifest.json` and `versions.json`.

For manual testing, place this repository under
`VaultFolder/.obsidian/plugins/myhistory`, run `npm run dev`, reload Obsidian,
and enable the plugin. `make deploy` copies a production build into the vaults
listed in the `Makefile`.

## Coding Style & Naming Conventions

Use tabs for indentation in code and JSON, matching `.editorconfig`. Keep
TypeScript strict and explicit where the compiler requires it. Prefer descriptive
plugin-facing IDs such as `capture-note-version` and class names such as
`MyHistoryPlugin`.

Use Obsidian APIs from the `obsidian` package instead of direct DOM or Electron
access unless the feature requires it. CSS classes and database names are
prefixed with `myhistory`. Keep user-visible strings short, specific, and in
English.

Settings are declared once in `getSettingDefinitions()`. Obsidian 1.13 and newer
render them natively; `display()` renders the same definitions imperatively for
the declared `minAppVersion`. Add new settings to the definitions only — never to
a second hand-written renderer.

## Testing Guidelines

Vitest is configured and unit tests are expected for behavior changes. Tests run
in Node and replace `obsidian` through a path alias to `tests/mocks/obsidian.ts`.

Prefer testing the real store and service over an in-memory PouchDB rather than
asserting against `vi.fn()` mocks, so capture, retention, and restore rules are
actually exercised. Cover anything that can alter vault data or drop stored
versions.

Two details matter when testing timers: content hashing resolves on a macrotask,
so a microtask drain is not enough, and the capture deadline compares timer
delays against `Date.now()`, so fake timers must also fake `Date`.

UI rendering stays covered by manual Obsidian testing. Unit tests should not try
to reproduce the Obsidian DOM runtime. See [TESTING.md](TESTING.md).

## Commit & Pull Request Guidelines

The history uses concise, imperative commit messages, for example
`Initial Obsidian plugin scaffold`. Continue that style: `Add retention limit`,
`Fix version ordering`.

Pull requests should include a short summary, testing notes, and any Obsidian UI
changes. Link related issues when available. Include screenshots only for visible
UI or settings changes.

## Data & Safety Tips

Stored versions hold the full text of a user's notes. Never log note content, and
keep the logger's redaction in place. Do not commit local vault data or plugin
data (`data.json`), and remember that restore and database reset are destructive
operations that must stay behind an explicit confirmation.
