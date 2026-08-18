import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePouchDB } from "../mocks/pouchdb";

vi.mock("pouchdb/dist/pouchdb", async () => {
	const { FakePouchDB: Fake } = await import("../mocks/pouchdb");
	return { default: Fake };
});

const { PouchDbHistoryStore } = await import("../../src/history/pouchdb-store");
const { createPathIndexId } = await import("../../src/history/note-files");
const { Logger } = await import("../../src/utils/logger");

type Store = InstanceType<typeof PouchDbHistoryStore>;

const NO_RETENTION_LIMIT = 0;

function createStore(name = "myhistory-test") {
	return new PouchDbHistoryStore(name);
}

async function capture(
	store: Store,
	overrides: {
		fileId: string;
		path?: string;
		content: string;
		capturedAtMs: number;
		event?: "baseline" | "created" | "modified" | "deleted" | "restored";
		maxVersionsPerNote?: number;
		overwriteCapturesWithinHour?: boolean;
	}
) {
	const path = overrides.path ?? "Notes/One.md";

	return store.captureVersion(
		{
			fileId: overrides.fileId,
			path,
			fileName: path.slice(path.lastIndexOf("/") + 1),
			content: overrides.content,
			contentHash: `hash-${overrides.content}`,
			size: overrides.content.length,
			sourceLastChanged: overrides.capturedAtMs,
			event: overrides.event ?? "modified",
			capturedAtMs: overrides.capturedAtMs
		},
		overrides.maxVersionsPerNote ?? NO_RETENTION_LIMIT,
		overrides.overwriteCapturesWithinHour ?? false
	);
}

beforeEach(() => {
	FakePouchDB.resetAll();
	Logger.setLevel("off");
});

describe("captureVersion", () => {
	it("creates the note record, the version, and the path index", async () => {
		const store = createStore();
		const result = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000,
			event: "baseline"
		});

		expect(result.captured).toBe(true);
		expect(result.version?.event).toBe("baseline");
		expect(result.version?.content).toBe("one");
		expect(result.note.versionCount).toBe(1);
		expect(result.note.latestVersionId).toBe(result.version?._id);
		expect(result.note.deleted).toBe(false);

		expect(await store.getNoteByPath("Notes/One.md")).toMatchObject({
			fileId: "file-1",
			path: "Notes/One.md"
		});
		expect(FakePouchDB.getDatabase("myhistory-test")?.has(createPathIndexId("Notes/One.md")))
			.toBe(true);
	});

	it("does not create a version when the content hash is unchanged", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		const second = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 2000
		});

		expect(second.captured).toBe(false);
		expect(second.version).toBeNull();
		expect(await store.countVersions("file-1")).toBe(1);
	});

	it("creates exactly one version per content change and chains them", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});
		const second = await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 2000
		});

		expect(second.captured).toBe(true);
		expect(second.version?.previousVersionId).toBe(first.version?._id);
		expect(await store.countVersions("file-1")).toBe(2);

		const versions = await store.listVersions("file-1", { descending: true });
		expect(versions.map((version) => version.content)).toEqual(["two", "one"]);
	});

	it("overwrites the latest capture within 60 minutes when enabled", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000,
			event: "created"
		});
		const second = await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 3_600_999,
			overwriteCapturesWithinHour: true
		});

		expect(second.captured).toBe(true);
		expect(second.version).toMatchObject({
			_id: first.version?._id,
			content: "two",
			capturedAt: new Date(3_600_999).toISOString(),
			event: "created"
		});
		expect(second.version?.previousVersionId).toBeUndefined();
		expect(second.note).toMatchObject({
			latestVersionId: first.version?._id,
			versionCount: 1,
			contentHash: "hash-two"
		});
		expect(await store.countVersions("file-1")).toBe(1);
	});

	it("creates a new version at the 60 minute boundary", async () => {
		const store = createStore();
		await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});
		await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 3_601_000,
			overwriteCapturesWithinHour: true
		});

		expect(await store.countVersions("file-1")).toBe(2);
	});

	it("does not overwrite pinned or lifecycle versions", async () => {
		const store = createStore();
		const pinned = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});
		await store.setVersionProtected(String(pinned.version?._id), true);
		await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 2000,
			overwriteCapturesWithinHour: true
		});
		await capture(store, {
			fileId: "file-1",
			content: "three",
			capturedAtMs: 3000,
			event: "restored",
			overwriteCapturesWithinHour: true
		});
		await capture(store, {
			fileId: "file-1",
			content: "four",
			capturedAtMs: 4000,
			overwriteCapturesWithinHour: true
		});

		const versions = await store.listVersions("file-1", {});
		expect(versions.map((version) => version.content)).toEqual([
			"one",
			"two",
			"three",
			"four"
		]);
		expect(versions[0]?.protected).toBe(true);
		expect(versions[2]?.event).toBe("restored");
	});

	it("records a new version when old content reappears", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "a", capturedAtMs: 1000 });
		await capture(store, { fileId: "file-1", content: "b", capturedAtMs: 2000 });
		await capture(store, { fileId: "file-1", content: "a", capturedAtMs: 3000 });

		const versions = await store.listVersions("file-1", {});
		expect(versions.map((version) => version.content)).toEqual(["a", "b", "a"]);
	});

	it("moves the note without a version when only the path changed", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		const moved = await capture(store, {
			fileId: "file-1",
			path: "Archive/One.md",
			content: "one",
			capturedAtMs: 2000
		});

		expect(moved.captured).toBe(false);
		expect(moved.note.path).toBe("Archive/One.md");
		expect(moved.note.pathHistory).toEqual([{
			previousPath: "Notes/One.md",
			path: "Archive/One.md",
			changedAt: new Date(2000).toISOString()
		}]);
		expect(await store.countVersions("file-1")).toBe(1);
		expect(await store.getNoteByPath("Notes/One.md")).toBeNull();
		expect(await store.getNoteByPath("Archive/One.md")).not.toBeNull();
	});

	it("repairs a note record that drifted from the stored timeline", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});

		// Simulate Obsidian stopping after the version was written but before
		// the note record was updated.
		const database = FakePouchDB.getDatabase("myhistory-test");
		const noteDocument = database?.get("note:file-1");
		database?.set("note:file-1", {
			...(noteDocument as Record<string, unknown>),
			_id: "note:file-1",
			_rev: String(noteDocument?._rev),
			contentHash: "hash-stale",
			latestVersionId: "",
			versionCount: 0
		});

		const repaired = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 2000
		});

		expect(repaired.captured).toBe(false);
		expect(repaired.note.latestVersionId).toBe(first.version?._id);
		expect(repaired.note.versionCount).toBe(1);
		expect(await store.countVersions("file-1")).toBe(1);
	});
});

describe("renameNote", () => {
	it("keeps the file id and moves the path index", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		const renamed = await store.renameNote("file-1", "Notes/Renamed.md", 2000);

		expect(renamed?.fileId).toBe("file-1");
		expect(renamed?.path).toBe("Notes/Renamed.md");
		expect(renamed?.fileName).toBe("Renamed.md");
		expect(await store.countVersions("file-1")).toBe(1);
		expect(await store.getNoteByPath("Notes/One.md")).toBeNull();
		expect((await store.getNoteByPath("Notes/Renamed.md"))?.fileId).toBe("file-1");
	});

	it("ignores a rename for an unknown note", async () => {
		const store = createStore();
		expect(await store.renameNote("missing", "Notes/Other.md", 1000)).toBeNull();
	});
});

describe("markNoteDeleted", () => {
	it("keeps history, records a tombstone, and frees the path", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		const result = await store.markNoteDeleted("file-1", 3000, NO_RETENTION_LIMIT);

		expect(result?.version.event).toBe("deleted");
		expect(result?.version.content).toBe("one");
		expect(result?.note.deleted).toBe(true);
		expect(result?.note.deletedAt).toBe(new Date(3000).toISOString());
		expect(await store.countVersions("file-1")).toBe(2);
		expect(await store.getNoteByPath("Notes/One.md")).toBeNull();
		expect((await store.getNote("file-1"))?.deleted).toBe(true);
	});

	it("does not record a second tombstone", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		await store.markNoteDeleted("file-1", 3000, NO_RETENTION_LIMIT);

		expect(await store.markNoteDeleted("file-1", 4000, NO_RETENTION_LIMIT)).toBeNull();
		expect(await store.countVersions("file-1")).toBe(2);
	});

	it("captures a version again after the note comes back", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		await store.markNoteDeleted("file-1", 2000, NO_RETENTION_LIMIT);
		const recreated = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 3000,
			event: "restored"
		});

		expect(recreated.captured).toBe(true);
		expect(recreated.note.deleted).toBe(false);
		expect(recreated.note.deletedAt).toBeUndefined();
		expect(await store.countVersions("file-1")).toBe(3);
	});
});

describe("resetNoteHistory", () => {
	it("removes every old version and starts a fresh history", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000,
			event: "created"
		});
		await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 2000
		});
		await store.setVersionProtected(String(first.version?._id), true);
		await store.renameNote("file-1", "Archive/Renamed.md", 3000);

		const result = await store.resetNoteHistory({
			fileId: "file-1",
			path: "Archive/Renamed.md",
			fileName: "Renamed.md",
			content: "current",
			contentHash: "hash-current",
			size: 7,
			sourceLastChanged: 4000,
			event: "modified",
			capturedAtMs: 4000
		});

		expect(result?.removedVersionIds).toHaveLength(2);
		expect(result?.version).toMatchObject({
			content: "current",
			event: "baseline",
			fileId: "file-1"
		});
		expect(result?.version.previousVersionId).toBeUndefined();
		expect(result?.version.protected).toBeUndefined();
		expect(await store.getVersion(String(first.version?._id))).toBeNull();

		const versions = await store.listVersions("file-1", {});
		expect(versions).toHaveLength(1);
		expect(versions[0]?._id).toBe(result?.version._id);
		expect(await store.getNote("file-1")).toMatchObject({
			path: "Archive/Renamed.md",
			versionCount: 1,
			pathHistory: [],
			deleted: false
		});
		expect(await store.getNoteByPath("Notes/One.md")).toBeNull();
		expect((await store.getNoteByPath("Archive/Renamed.md"))?.fileId).toBe("file-1");
	});

	it("does not create a history for an unknown note", async () => {
		const store = createStore();

		expect(await store.resetNoteHistory({
			fileId: "missing",
			path: "Notes/Missing.md",
			fileName: "Missing.md",
			content: "current",
			contentHash: "hash-current",
			size: 7,
			sourceLastChanged: 1000,
			event: "created",
			capturedAtMs: 1000
		})).toBeNull();
		expect(await store.listNotes()).toEqual([]);
	});
});

describe("deleteVersion", () => {
	it("removes only the selected version and updates the note count", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		const selected = await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 2000
		});
		const latest = await capture(store, {
			fileId: "file-1",
			content: "three",
			capturedAtMs: 3000
		});

		const result = await store.deleteVersion(String(selected.version?._id));

		expect(result).toEqual({
			fileId: "file-1",
			versionId: selected.version?._id,
			remainingVersionCount: 2,
			latestVersionId: latest.version?._id
		});
		expect((await store.listVersions("file-1", {})).map((version) => version.content))
			.toEqual(["one", "three"]);
		expect(await store.getNote("file-1")).toMatchObject({
			versionCount: 2,
			latestVersionId: latest.version?._id
		});
	});

	it("moves the latest pointer back and supports deleting the last version", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});
		const second = await capture(store, {
			fileId: "file-1",
			content: "two",
			capturedAtMs: 2000
		});

		await store.deleteVersion(String(second.version?._id));
		expect(await store.getNote("file-1")).toMatchObject({
			versionCount: 1,
			latestVersionId: first.version?._id
		});

		const result = await store.deleteVersion(String(first.version?._id));
		expect(result?.remainingVersionCount).toBe(0);
		expect(result?.latestVersionId).toBeNull();
		expect(await store.getNote("file-1")).toMatchObject({
			versionCount: 0,
			latestVersionId: ""
		});
		expect(await store.getNoteByPath("Notes/One.md")).not.toBeNull();
	});

	it("allows an explicitly selected pinned version to be deleted", async () => {
		const store = createStore();
		const selected = await capture(store, {
			fileId: "file-1",
			content: "one",
			capturedAtMs: 1000
		});
		const versionId = String(selected.version?._id);
		await store.setVersionProtected(versionId, true);

		expect(await store.deleteVersion(versionId)).not.toBeNull();
		expect(await store.getVersion(versionId)).toBeNull();
	});

	it("does nothing when the selected version is missing", async () => {
		const store = createStore();

		expect(await store.deleteVersion("version:missing:1:aa")).toBeNull();
	});
});

describe("retention", () => {
	it("removes the oldest versions above the limit", async () => {
		const store = createStore();

		for (const [index, content] of ["a", "b", "c", "d"].entries()) {
			await capture(store, {
				fileId: "file-1",
				content,
				capturedAtMs: 1000 * (index + 1),
				maxVersionsPerNote: 2
			});
		}

		const versions = await store.listVersions("file-1", {});
		expect(versions.map((version) => version.content)).toEqual(["c", "d"]);
		expect((await store.getNote("file-1"))?.versionCount).toBe(2);
	});

	it("keeps pinned versions when older versions expire", async () => {
		const store = createStore();
		const first = await capture(store, {
			fileId: "file-1",
			content: "a",
			capturedAtMs: 1000
		});
		const firstVersionId = String(first.version?._id);
		await store.setVersionProtected(firstVersionId, true);

		for (const [index, content] of ["b", "c", "d"].entries()) {
			await capture(store, {
				fileId: "file-1",
				content,
				capturedAtMs: 2000 + 1000 * index,
				maxVersionsPerNote: 2
			});
		}

		const versions = await store.listVersions("file-1", {});
		expect(versions.map((version) => version.content)).toEqual(["a", "d"]);
		expect(versions[0]?.protected).toBe(true);
	});

	it("keeps every version when the limit is zero", async () => {
		const store = createStore();

		for (const [index, content] of ["a", "b", "c"].entries()) {
			await capture(store, {
				fileId: "file-1",
				content,
				capturedAtMs: 1000 * (index + 1)
			});
		}

		expect(await store.pruneVersions("file-1", 0)).toEqual([]);
		expect(await store.countVersions("file-1")).toBe(3);
	});

	it("keeps one note's versions out of another note's timeline", async () => {
		const store = createStore();
		await capture(store, {
			fileId: "file-1",
			path: "Notes/One.md",
			content: "one",
			capturedAtMs: 1000
		});
		await capture(store, {
			fileId: "file-2",
			path: "Notes/Two.md",
			content: "two",
			capturedAtMs: 2000
		});

		expect(await store.countVersions("file-1")).toBe(1);
		expect(await store.countVersions("file-2")).toBe(1);
		expect((await store.listNotes()).map((note) => note.fileId).sort())
			.toEqual(["file-1", "file-2"]);
	});
});

describe("database lifecycle", () => {
	it("reports the stored document count", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });

		expect(await store.info()).toEqual({
			databaseName: "myhistory-test",
			documentCount: 3
		});
	});

	it("recreates an empty database after a reset", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		await store.reset();

		expect(await store.listNotes()).toEqual([]);
		expect(await store.countVersions("file-1")).toBe(0);
		expect((await store.info()).documentCount).toBe(0);
	});

	it("reopens the database after it was closed", async () => {
		const store = createStore();
		await capture(store, { fileId: "file-1", content: "one", capturedAtMs: 1000 });
		await store.close();

		expect((await store.listNotes()).length).toBe(1);
	});
});
