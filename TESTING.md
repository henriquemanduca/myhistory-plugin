# Testing

MyHistory uses Vitest for unit tests. Tests run in Node.js and replace the
Obsidian runtime module with the test double in `tests/mocks/obsidian.ts`.

## Commands

```sh
npm test
npm run test:watch
npm run test:coverage
npm run test:typecheck
npm run check
```

`npm run check` is the complete local verification command. It builds the
production bundle, type-checks test code, and runs the unit test suite once.

## Mock boundaries

Three doubles stand in for the runtime, and nothing else is mocked:

- `tests/mocks/obsidian.ts` replaces the `obsidian` module through the Vitest
  path alias. `TFile` and `TFolder` mirror the real classes closely enough to be
  passed to plugin code without casting.
- `tests/mocks/pouchdb.ts` is an in-memory stand-in for PouchDB covering `get`,
  `put`, `remove`, `bulkDocs`, ranged `allDocs`, `info`, `close`, and `destroy`.
  It enforces revision conflicts and clones documents in and out, so tests never
  share mutable state with the code under test.
- `tests/mocks/vault.ts` builds a fake vault with a real folder tree, plus read,
  write, create, rename, and delete operations.

Because the storage double behaves like a database, the tests exercise the real
`PouchDbHistoryStore` and the real `HistoryService` instead of asserting against
`vi.fn()` call lists. Prefer that: a test that only checks a mock was called
proves nothing about capture, retention, or restore rules.

## Current coverage

The suite prioritizes code that can alter vault data or drop stored versions.

`tests/history/note-files.test.ts`

- record, version, and path-index identifier construction and parsing;
- chronological ordering of version ids and per-note key ranges;
- content hashing with line-ending normalization, and byte sizing;
- Markdown-only and tracked-folder rules;
- tracked folder resolution and invalid folder reporting.

`tests/history/pouchdb-store.test.ts`

- first capture writing the note record, version, and path index;
- no version for an unchanged content hash;
- exactly one version per content change, with a linked previous version;
- a new version when old content reappears;
- a path move without a version when only the path changed;
- note-record repair when it drifted from the stored timeline;
- rename keeping the file id and moving the path index;
- deletion recording a restorable tombstone and freeing the path;
- retention removing the oldest versions and keeping pinned ones;
- database info, reset, and reopen-after-close behavior.

`tests/history/history-service.test.ts`

- capture of new, unchanged, and changed notes, including metadata-only changes;
- rejection of non-Markdown files and notes outside the tracked folder;
- one continuous timeline across renames, folder renames, and later edits;
- deletion of a note, of a folder of notes, and of untracked files;
- restore writing back, keeping the replaced content, recreating a deleted note
  and its folder, and targeting the current path after a rename;
- refusal to restore content that fails its hash check, and a missing version;
- reconciliation capturing changes, recording disappearances, ignoring notes
  outside the tracked folder, and reporting an invalid folder;
- retention during capture and on demand;
- the capture debounce, its restart on further edits, and its deadline;
- database reset leaving vault files untouched.

`tests/utils/` covers logging redaction, date formatting, and PouchDB error
guards.

UI rendering remains covered by manual Obsidian testing. Unit tests should not
try to reproduce the complete Obsidian DOM runtime.

## Timer and async pitfalls

Two details bite when testing scheduled captures:

- Content hashing goes through `crypto.subtle.digest`, which resolves on a
  macrotask. Advancing fake timers only drains microtasks, so a test must yield
  to the real event loop — `await new Promise((resolve) => setImmediate(resolve))`
  — before asserting that a capture landed.
- The capture deadline compares timer delays against `Date.now()`. Faking only
  `setTimeout` leaves the clock still, and the deadline never arrives. Fake
  timers must include `Date`, and `setImmediate` must stay real.

`tests/history/history-service.test.ts` shows both, in `stubWindowTimers` and
`waitForVersions`.

## Roadmap

### 1. Test foundation — complete

- Vitest runner and V8 coverage.
- Type-checking configuration for tests.
- Obsidian, PouchDB, and vault test doubles.

### 2. Storage and capture rules — complete

- Store document lifecycle, ordering, retention, and repair.
- Service capture, rename, delete, restore, and reconciliation scenarios.

### 3. Settings and status surface

- Saved-settings normalization and clamping of out-of-range values.
- Status-bar text for each history status.
- The Obsidian 1.12 settings fallback renderer against the shared definitions.

These need a slightly larger Obsidian double (`Plugin`, `Setting`,
`SettingGroup`). Add it only when these tests are written.

### 4. Obsidian integration smoke tests

- Load the built plugin in a disposable vault.
- Open and save settings.
- Edit a note, wait for a capture, restore an older version.
- Delete a note and restore it from the timeline.

These checks require a real Obsidian environment and complement, rather than
replace, the unit suite.

## Coverage policy

Coverage is reported but not gated. UI files, `main.ts`, `settings.ts`, and
`src/utils/button.ts` are excluded from the report because they are verified
manually.

The suite currently sits around 85% of statements and 78% of branches. A useful
first gate is 80% of statements in `src/history/`, which is already met, while
keeping restore and retention paths covered by explicit scenario tests rather
than by chasing a branch percentage.
