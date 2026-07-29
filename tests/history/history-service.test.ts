import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePouchDB } from "../mocks/pouchdb";
import { createFakeVault, type FakeVault } from "../mocks/vault";
import { Notice, TFolder } from "../mocks/obsidian";

vi.mock("pouchdb/dist/pouchdb", async () => {
	const { FakePouchDB: Fake } = await import("../mocks/pouchdb");
	return { default: Fake };
});

const { PouchDbHistoryStore } = await import("../../src/history/pouchdb-store");
const { HistoryService } = await import("../../src/history/history-service");
const { createTextContentHash } = await import("../../src/history/note-files");
const { Logger } = await import("../../src/utils/logger");

type MyHistorySettings = import("../../src/settings").MyHistorySettings;
type HistoryStatus = import("../../src/history/history-service").HistoryStatus;

const DATABASE_NAME = "myhistory-test";

interface Fixture {
	vault: FakeVault;
	store: InstanceType<typeof PouchDbHistoryStore>;
	service: InstanceType<typeof HistoryService>;
	settings: MyHistorySettings;
	statuses: HistoryStatus[];
	changedFileIds: Array<string | null>;
	completedOperations: string[];
}

function createFixture(overrides: Partial<MyHistorySettings> = {}): Fixture {
	const vault = createFakeVault();
	const store = new PouchDbHistoryStore(DATABASE_NAME);
	const settings: MyHistorySettings = {
		localVaultId: "test",
		historyFolderMode: "vault-root",
		customHistoryFolder: "",
		maxVersionsPerNote: 50,
		captureDebounceSeconds: 15,
		reconcileOnStartup: true,
		logLevel: "off",
		lastCaptureAt: "",
		lastReconciliationAt: "",
		lastRestoreAt: "",
		lastDatabaseResetAt: "",
		...overrides
	};
	const statuses: HistoryStatus[] = [];
	const changedFileIds: Array<string | null> = [];
	const completedOperations: string[] = [];
	const service = new HistoryService(
		vault.app,
		store,
		() => settings,
		(status) => statuses.push(status),
		async (operation) => {
			completedOperations.push(operation);
		},
		(fileId) => changedFileIds.push(fileId)
	);

	return { vault, store, service, settings, statuses, changedFileIds, completedOperations };
}

/**
 * A scheduled capture hashes content through `crypto.subtle`, which resolves on
 * a macrotask. Advancing fake timers only drains microtasks, so the loop yields
 * to the real event loop until the expected versions are stored.
 */
async function waitForVersions(fixture: Fixture, path: string, expected: number) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const timeline = await fixture.service.getTimelineForPath(path);

		if ((timeline?.versions.length ?? 0) >= expected) {
			return timeline;
		}

		await new Promise((resolve) => setImmediate(resolve));
	}

	return fixture.service.getTimelineForPath(path);
}

beforeEach(() => {
	FakePouchDB.resetAll();
	Logger.setLevel("off");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("captureFile", () => {
	it("stores a restorable first version for a new note", async () => {
		const fixture = createFixture();
		const file = fixture.vault.createNote("Notes/One.md", "first");
		const outcome = await fixture.service.captureFile(file);

		expect(outcome).toMatchObject({ captured: true });

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		expect(timeline?.versions).toHaveLength(1);
		expect(timeline?.versions[0]).toMatchObject({
			event: "created",
			content: "first",
			path: "Notes/One.md"
		});
		expect(fixture.completedOperations).toEqual(["capture"]);
		expect(fixture.changedFileIds).toEqual([timeline?.note.fileId]);
	});

	it("does not store a version when only the file metadata changed", async () => {
		const fixture = createFixture();
		const file = fixture.vault.createNote("Notes/One.md", "same");
		await fixture.service.captureFile(file);

		file.stat.mtime += 5000;
		file.stat.size += 10;
		const second = await fixture.service.captureFile(file);

		expect(second).toMatchObject({ captured: false });
		expect((await fixture.service.getTimelineForPath("Notes/One.md"))?.versions)
			.toHaveLength(1);
	});

	it("stores exactly one version per content change", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		fixture.vault.writeNote("Notes/One.md", "two");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		fixture.vault.writeNote("Notes/One.md", "three");
		await fixture.service.captureNoteAtPath("Notes/One.md");

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		expect(timeline?.versions.map((version) => version.content))
			.toEqual(["three", "two", "one"]);
		expect(timeline?.versions.map((version) => version.event))
			.toEqual(["modified", "modified", "created"]);
	});

	it("ignores files that are not Markdown", async () => {
		const fixture = createFixture();
		const file = fixture.vault.createOtherFile("Notes/report.pdf");

		expect(await fixture.service.captureFile(file)).toBeNull();
		expect(await fixture.store.listNotes()).toEqual([]);
	});

	it("ignores notes outside the tracked folder", async () => {
		const fixture = createFixture({
			historyFolderMode: "custom",
			customHistoryFolder: "Tracked"
		});
		const outside = fixture.vault.createNote("Other/One.md", "one");
		const inside = fixture.vault.createNote("Tracked/One.md", "one");

		expect(await fixture.service.captureFile(outside)).toBeNull();
		expect(await fixture.service.captureFile(inside)).toMatchObject({ captured: true });
		expect((await fixture.store.listNotes()).map((note) => note.path))
			.toEqual(["Tracked/One.md"]);
	});
});

describe("renames", () => {
	it("keeps one timeline across a rename", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const beforeRename = await fixture.service.getTimelineForPath("Notes/One.md");

		const renamed = fixture.vault.renameFile("Notes/One.md", "Notes/Renamed.md");
		await fixture.service.handleRenamedFile(renamed, "Notes/One.md");

		const afterRename = await fixture.service.getTimelineForPath("Notes/Renamed.md");
		expect(afterRename?.note.fileId).toBe(beforeRename?.note.fileId);
		expect(afterRename?.versions).toHaveLength(1);
		expect(afterRename?.note.pathHistory).toEqual([
			expect.objectContaining({
				previousPath: "Notes/One.md",
				path: "Notes/Renamed.md"
			})
		]);
		expect(await fixture.service.getTimelineForPath("Notes/One.md")).toBeNull();
	});

	it("continues the same timeline after a rename and a later edit", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const renamed = fixture.vault.renameFile("Notes/One.md", "Notes/Renamed.md");
		await fixture.service.handleRenamedFile(renamed, "Notes/One.md");

		fixture.vault.writeNote("Notes/Renamed.md", "changed");
		await fixture.service.captureNoteAtPath("Notes/Renamed.md");

		const timeline = await fixture.service.getTimelineForPath("Notes/Renamed.md");
		expect(timeline?.versions.map((version) => version.content))
			.toEqual(["changed", "one"]);
		expect(await fixture.store.listNotes()).toHaveLength(1);
	});

	it("records a deletion when a note is renamed out of the tracked folder", async () => {
		const fixture = createFixture({
			historyFolderMode: "custom",
			customHistoryFolder: "Tracked"
		});
		fixture.vault.createNote("Tracked/One.md", "one");
		await fixture.service.captureNoteAtPath("Tracked/One.md");

		const moved = fixture.vault.renameFile("Tracked/One.md", "Other/One.md");
		await fixture.service.handleRenamedFile(moved, "Tracked/One.md");

		const [note] = await fixture.store.listNotes();
		expect(note?.deleted).toBe(true);
		expect(await fixture.store.countVersions(String(note?.fileId))).toBe(2);
	});

	it("follows notes when their folder is renamed", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		fixture.vault.renameFile("Notes/One.md", "Archive/One.md");

		await fixture.service.handleRenamedFile(new TFolder("Archive"), "Notes");

		const timeline = await fixture.service.getTimelineForPath("Archive/One.md");
		expect(timeline?.versions).toHaveLength(1);
		expect(timeline?.note.path).toBe("Archive/One.md");
	});
});

describe("deletions", () => {
	it("keeps every version and records the deletion", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const file = fixture.vault.deleteFile("Notes/One.md");

		await fixture.service.handleDeletedFile(file!);

		const [note] = await fixture.store.listNotes();
		expect(note?.deleted).toBe(true);
		const versions = await fixture.store.listVersions(String(note?.fileId), {});
		expect(versions.map((version) => version.event)).toEqual(["created", "deleted"]);
		expect(versions[1]?.content).toBe("one");
	});

	it("records deletions for notes inside a deleted folder", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		fixture.vault.createNote("Notes/Two.md", "two");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		await fixture.service.captureNoteAtPath("Notes/Two.md");

		fixture.vault.deleteFile("Notes/One.md");
		fixture.vault.deleteFile("Notes/Two.md");
		await fixture.service.handleDeletedFile(new TFolder("Notes"));

		const notes = await fixture.store.listNotes();
		expect(notes).toHaveLength(2);
		expect(notes.every((note) => note.deleted)).toBe(true);
	});

	it("ignores deletions of files that were never tracked", async () => {
		const fixture = createFixture();
		const file = fixture.vault.createOtherFile("Notes/image.png");
		fixture.vault.deleteFile("Notes/image.png");

		await fixture.service.handleDeletedFile(file);
		expect(await fixture.store.listNotes()).toEqual([]);
	});
});

describe("restoreVersion", () => {
	it("writes the version back and keeps the replaced content as a version", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "original");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		const originalVersionId = String(timeline?.versions[0]?._id);

		fixture.vault.writeNote("Notes/One.md", "current");
		const result = await fixture.service.restoreVersion(originalVersionId);

		expect(result?.path).toBe("Notes/One.md");
		expect(fixture.vault.readNote("Notes/One.md")).toBe("original");

		const restoredTimeline = await fixture.service.getTimelineForPath("Notes/One.md");
		expect(restoredTimeline?.versions.map((version) => version.content))
			.toEqual(["original", "current", "original"]);
		expect(restoredTimeline?.versions.map((version) => version.event))
			.toEqual(["restored", "modified", "created"]);
		expect(fixture.completedOperations).toContain("restore");
	});

	it("recreates a deleted note and its folder", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/Nested/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/Nested/One.md");
		const timeline = await fixture.service.getTimelineForPath("Notes/Nested/One.md");
		const versionId = String(timeline?.versions[0]?._id);

		const file = fixture.vault.deleteFile("Notes/Nested/One.md");
		await fixture.service.handleDeletedFile(file!);
		expect(fixture.vault.getFile("Notes/Nested/One.md")).toBeNull();

		const result = await fixture.service.restoreVersion(versionId);

		expect(result?.path).toBe("Notes/Nested/One.md");
		expect(fixture.vault.readNote("Notes/Nested/One.md")).toBe("one");
		expect((await fixture.service.getTimelineForPath("Notes/Nested/One.md"))?.note.deleted)
			.toBe(false);
	});

	it("restores to the current path after a rename", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		const versionId = String(timeline?.versions[0]?._id);

		const renamed = fixture.vault.renameFile("Notes/One.md", "Notes/Renamed.md");
		await fixture.service.handleRenamedFile(renamed, "Notes/One.md");
		fixture.vault.writeNote("Notes/Renamed.md", "changed");

		const result = await fixture.service.restoreVersion(versionId);

		expect(result?.path).toBe("Notes/Renamed.md");
		expect(fixture.vault.readNote("Notes/Renamed.md")).toBe("one");
		expect(fixture.vault.getFile("Notes/One.md")).toBeNull();
	});

	it("refuses to restore a version whose stored content is corrupted", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "original");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		const versionId = String(timeline?.versions[0]?._id);

		const database = FakePouchDB.getDatabase(DATABASE_NAME);
		const versionDocument = database?.get(versionId);
		database?.set(versionId, {
			...(versionDocument as Record<string, unknown>),
			_id: versionId,
			_rev: String(versionDocument?._rev),
			content: "tampered"
		});

		fixture.vault.writeNote("Notes/One.md", "current");
		expect(await fixture.service.restoreVersion(versionId)).toBeNull();
		expect(fixture.vault.readNote("Notes/One.md")).toBe("current");
		expect(fixture.statuses.at(-1)).toEqual({
			state: "error",
			message: "The stored version failed its integrity check"
		});
	});

	it("reports a missing version without touching the vault", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "current");

		expect(await fixture.service.restoreVersion("version:missing:1:aa")).toBeNull();
		expect(fixture.vault.readNote("Notes/One.md")).toBe("current");
		expect(Notice.instances).toHaveLength(1);
	});
});

describe("reconcile", () => {
	it("captures notes that changed while Obsidian was closed", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		fixture.vault.createNote("Notes/Two.md", "two");

		const first = await fixture.service.reconcile();
		expect(first).toEqual({ tracked: 2, captured: 2, deleted: 0 });

		const second = await fixture.service.reconcile();
		expect(second).toEqual({ tracked: 2, captured: 0, deleted: 0 });

		fixture.vault.writeNote("Notes/One.md", "one changed");
		const third = await fixture.service.reconcile();
		expect(third).toEqual({ tracked: 2, captured: 1, deleted: 0 });

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		expect(timeline?.versions.map((version) => version.event))
			.toEqual(["modified", "baseline"]);
	});

	it("records deletions for notes that disappeared", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.reconcile();

		fixture.vault.deleteFile("Notes/One.md");
		expect(await fixture.service.reconcile()).toEqual({
			tracked: 0,
			captured: 0,
			deleted: 1
		});

		const [note] = await fixture.store.listNotes();
		expect(note?.deleted).toBe(true);
		expect(await fixture.store.countVersions(String(note?.fileId))).toBe(2);
	});

	it("does not record deletions for notes outside the tracked folder", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Tracked/One.md", "one");
		fixture.vault.createNote("Other/Two.md", "two");
		await fixture.service.reconcile();

		fixture.settings.historyFolderMode = "custom";
		fixture.settings.customHistoryFolder = "Tracked";

		expect(await fixture.service.reconcile()).toEqual({
			tracked: 1,
			captured: 0,
			deleted: 0
		});
		expect((await fixture.store.listNotes()).every((note) => !note.deleted)).toBe(true);
	});

	it("reports an invalid tracked folder", async () => {
		const fixture = createFixture({
			historyFolderMode: "custom",
			customHistoryFolder: "Missing"
		});

		expect(await fixture.service.reconcile()).toBeNull();
		expect(fixture.statuses.at(-1)).toEqual({
			state: "error",
			message: "Folder not found: Missing"
		});
	});

	it("stores a version for a note whose record has no version yet", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.reconcile();

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		const versionId = String(timeline?.versions[0]?._id);
		FakePouchDB.getDatabase(DATABASE_NAME)?.delete(versionId);

		expect(await fixture.service.reconcile()).toEqual({
			tracked: 1,
			captured: 1,
			deleted: 0
		});
		expect((await fixture.service.getTimelineForPath("Notes/One.md"))?.versions)
			.toHaveLength(1);
	});
});

describe("retention during capture", () => {
	it("keeps only the configured number of versions per note", async () => {
		const fixture = createFixture({ maxVersionsPerNote: 2 });
		fixture.vault.createNote("Notes/One.md", "a");
		await fixture.service.captureNoteAtPath("Notes/One.md");

		for (const content of ["b", "c", "d"]) {
			fixture.vault.writeNote("Notes/One.md", content);
			await fixture.service.captureNoteAtPath("Notes/One.md");
		}

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		expect(timeline?.versions.map((version) => version.content)).toEqual(["d", "c"]);
	});

	it("applies retention to every note on demand", async () => {
		const fixture = createFixture({ maxVersionsPerNote: 0 });
		fixture.vault.createNote("Notes/One.md", "a");
		await fixture.service.captureNoteAtPath("Notes/One.md");
		fixture.vault.writeNote("Notes/One.md", "b");
		await fixture.service.captureNoteAtPath("Notes/One.md");

		fixture.settings.maxVersionsPerNote = 1;
		expect(await fixture.service.applyRetention()).toEqual({ notes: 1, removed: 1 });
		expect((await fixture.service.getTimelineForPath("Notes/One.md"))?.versions)
			.toHaveLength(1);
	});
});

describe("queued captures", () => {
	function stubWindowTimers() {
		// The capture deadline compares timer delays against `Date.now()`, so the
		// clock has to advance with the timers. `setImmediate` stays real so the
		// asynchronous capture chain can still settle.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.stubGlobal("window", {
			setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
			clearTimeout: (timer: number) => clearTimeout(timer)
		});
	}

	it("captures a note once its idle delay elapses", async () => {
		stubWindowTimers();
		const fixture = createFixture({ captureDebounceSeconds: 15 });
		const file = fixture.vault.createNote("Notes/One.md", "one");

		fixture.service.queueCapture(file);
		expect(fixture.statuses.at(-1)).toEqual({ state: "queued", pending: 1 });

		await vi.advanceTimersByTimeAsync(14_000);
		expect(await fixture.store.listNotes()).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		expect((await waitForVersions(fixture, "Notes/One.md", 1))?.versions)
			.toHaveLength(1);
	});

	it("restarts the delay while the note keeps changing", async () => {
		stubWindowTimers();
		const fixture = createFixture({ captureDebounceSeconds: 10 });
		const file = fixture.vault.createNote("Notes/One.md", "one");

		fixture.service.queueCapture(file);
		await vi.advanceTimersByTimeAsync(9_000);
		fixture.vault.writeNote("Notes/One.md", "two");
		fixture.service.queueCapture(file);
		await vi.advanceTimersByTimeAsync(9_000);

		expect(await fixture.store.listNotes()).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		const timeline = await waitForVersions(fixture, "Notes/One.md", 1);
		expect(timeline?.versions).toHaveLength(1);
		expect(timeline?.versions[0]?.content).toBe("two");
	});

	it("captures a note that never stops changing once the deadline passes", async () => {
		stubWindowTimers();
		const fixture = createFixture({ captureDebounceSeconds: 10 });
		const file = fixture.vault.createNote("Notes/One.md", "one");

		for (let elapsed = 0; elapsed < 45_000; elapsed += 5_000) {
			fixture.service.queueCapture(file);
			await vi.advanceTimersByTimeAsync(5_000);
		}

		expect((await waitForVersions(fixture, "Notes/One.md", 1))?.versions)
			.toHaveLength(1);
	});

	it("captures pending notes when asked to flush", async () => {
		stubWindowTimers();
		const fixture = createFixture();
		const file = fixture.vault.createNote("Notes/One.md", "one");

		fixture.service.queueCapture(file);
		await fixture.service.flushPendingCaptures();

		expect((await fixture.service.getTimelineForPath("Notes/One.md"))?.versions)
			.toHaveLength(1);
	});
});

describe("resetDatabase", () => {
	it("deletes stored history without touching the vault", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "one");
		await fixture.service.captureNoteAtPath("Notes/One.md");

		expect(await fixture.service.resetDatabase()).toBe(true);
		expect(await fixture.store.listNotes()).toEqual([]);
		expect(fixture.vault.readNote("Notes/One.md")).toBe("one");
		expect(fixture.completedOperations).toContain("resetDatabase");
	});
});

describe("initialize", () => {
	it("skips the startup scan when it is disabled", async () => {
		const fixture = createFixture({ reconcileOnStartup: false });
		fixture.vault.createNote("Notes/One.md", "one");

		await fixture.service.initialize();
		expect(await fixture.store.listNotes()).toEqual([]);
	});

	it("scans on startup when enabled", async () => {
		const fixture = createFixture({ reconcileOnStartup: true });
		fixture.vault.createNote("Notes/One.md", "one");

		await fixture.service.initialize();
		expect(await fixture.store.listNotes()).toHaveLength(1);
	});
});

describe("stored content integrity", () => {
	it("stores a hash that matches the captured content", async () => {
		const fixture = createFixture();
		fixture.vault.createNote("Notes/One.md", "line one\nline two");
		await fixture.service.captureNoteAtPath("Notes/One.md");

		const timeline = await fixture.service.getTimelineForPath("Notes/One.md");
		const version = timeline?.versions[0];

		expect(version?.contentHash).toBe(await createTextContentHash(String(version?.content)));
	});
});
