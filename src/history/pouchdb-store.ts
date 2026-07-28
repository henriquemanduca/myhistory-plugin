import PouchDB from "pouchdb/dist/pouchdb";
import type {
	HistoryDocument,
	NotePathChange,
	NotePathIndexRecord,
	NoteRecord,
	NoteVersionEvent,
	NoteVersionRecord
} from "./types";
import { isNoteVersionRecord } from "./types";
import {
	createNoteRecordId,
	createPathIndexId,
	createPrefixRange,
	createSequentialVersionId,
	createVersionIdRange,
	getFileNameFromPath,
	NOTE_PATH_INDEX_PREFIX,
	NOTE_RECORD_PREFIX
} from "./note-files";
import { Logger } from "../utils/logger";
import { isPouchNotFound } from "../utils/pouchdb-errors";

const logger = new Logger("PouchDbHistoryStore");
const MAX_PATH_HISTORY_ENTRIES = 25;

export interface CaptureVersionInput {
	fileId: string;
	path: string;
	fileName: string;
	content: string;
	contentHash: string;
	size: number;
	sourceLastChanged: number;
	event: NoteVersionEvent;
	capturedAtMs: number;
}

export interface CaptureVersionResult {
	captured: boolean;
	note: NoteRecord;
	version: NoteVersionRecord | null;
	prunedVersionIds: string[];
}

export interface DeleteNoteResult {
	note: NoteRecord;
	version: NoteVersionRecord;
	prunedVersionIds: string[];
}

export interface ListVersionsOptions {
	descending?: boolean;
	limit?: number;
}

export interface HistoryDatabaseInfo {
	databaseName: string;
	documentCount: number;
}

type ExistingNoteRecord = NoteRecord & PouchDB.ExistingDocument;
type ExistingVersionRecord = NoteVersionRecord & PouchDB.ExistingDocument;
type NoteRecordUpsert = NoteRecord & { _rev?: string };

/**
 * Local-only PouchDB storage for note history. Every write goes through a
 * single serialized queue so a capture, a rename, and a retention pass never
 * interleave on the same documents.
 */
export class PouchDbHistoryStore {
	private db: PouchDB<HistoryDocument>;
	private dbClosed = false;
	private operationQueue = Promise.resolve();

	constructor(private databaseName: string) {
		this.db = new PouchDB<HistoryDocument>(databaseName);
	}

	getDatabaseName() {
		return this.databaseName;
	}

	async info(): Promise<HistoryDatabaseInfo> {
		return this.runWithDb("info", async (db) => {
			const info = await db.info();

			return {
				databaseName: info.db_name,
				documentCount: info.doc_count ?? 0
			};
		});
	}

	async getNote(fileId: string) {
		return this.runWithDb("getNote", (db) => getNoteRecord(db, fileId));
	}

	async getNoteByPath(path: string) {
		return this.runWithDb("getNoteByPath", async (db) => {
			const pathIndex = await getPathIndexRecord(db, path);
			return pathIndex ? getNoteRecord(db, pathIndex.fileId) : null;
		});
	}

	async listNotes() {
		return this.runWithDb("listNotes", async (db) => {
			const result = await db.allDocs({
				...createPrefixRange(NOTE_RECORD_PREFIX),
				include_docs: true
			});

			return result.rows.flatMap(
				(row) => (row.doc && row.doc.type === "note" ? [row.doc] : [])
			);
		});
	}

	async listPathIndexRecords() {
		return this.runWithDb("listPathIndexRecords", async (db) => {
			const result = await db.allDocs({
				...createPrefixRange(NOTE_PATH_INDEX_PREFIX),
				include_docs: true
			});

			return result.rows.flatMap(
				(row) => (row.doc && row.doc.type === "note-path" ? [row.doc] : [])
			);
		});
	}

	async listVersions(fileId: string, options: ListVersionsOptions = {}) {
		return this.runWithDb("listVersions", (db) => listVersionRecords(db, fileId, options));
	}

	async countVersions(fileId: string) {
		return this.runWithDb("countVersions", async (db) => {
			const result = await db.allDocs(createVersionIdRange(fileId));
			return result.rows.length;
		});
	}

	async getVersion(versionId: string) {
		return this.runWithDb("getVersion", async (db) => {
			const document = await getDocument(db, versionId);
			return document && isNoteVersionRecord(document) ? document : null;
		});
	}

	/**
	 * Appends an immutable version and updates the note record in a single
	 * batch. Returns `captured: false` when the content hash already matches the
	 * current state, so metadata-only changes never grow the timeline.
	 */
	async captureVersion(
		input: CaptureVersionInput,
		maxVersionsPerNote: number
	): Promise<CaptureVersionResult> {
		return this.runWithDb("captureVersion", async (db) => {
			const existingNote = await getNoteRecord(db, input.fileId);
			const capturedAt = new Date(input.capturedAtMs).toISOString();

			if (
				existingNote
				&& hasSameStoredContent(existingNote, input.contentHash)
				&& await documentExists(db, existingNote.latestVersionId)
			) {
				const note = existingNote.path === input.path
					? existingNote
					: await movePathIndex(db, existingNote, input.path, capturedAt);

				return {
					captured: false,
					note,
					version: null,
					prunedVersionIds: []
				};
			}

			const [latestVersion] = await listVersionRecords(db, input.fileId, {
				descending: true,
				limit: 1
			});

			// The note record can drift from the timeline when Obsidian stops
			// between the two writes of a capture. Repair it instead of storing
			// the same content twice.
			if (
				existingNote
				&& !existingNote.deleted
				&& latestVersion
				&& latestVersion.contentHash === input.contentHash
			) {
				const repairedNote: ExistingNoteRecord = {
					...existingNote,
					path: input.path,
					fileName: input.fileName,
					contentHash: input.contentHash,
					size: input.size,
					lastChanged: input.sourceLastChanged,
					lastChangedIso: new Date(input.sourceLastChanged).toISOString(),
					latestVersionId: latestVersion._id,
					versionCount: Math.max(existingNote.versionCount, 1),
					updatedAt: capturedAt
				};
				const documents: Array<PouchDB.WritableDocument<HistoryDocument>> = [repairedNote];
				const repairedPathIndex = await createPathIndexUpsert(
					db,
					input.path,
					input.fileId,
					capturedAt
				);

				if (repairedPathIndex) {
					documents.push(repairedPathIndex);
				}

				assertBulkDocsSucceeded(await db.bulkDocs(documents), "captureVersion");
				logger.info("Note record repaired from the stored timeline", {
					fileId: input.fileId,
					path: input.path,
					versionId: latestVersion._id
				});

				return {
					captured: false,
					note: repairedNote,
					version: null,
					prunedVersionIds: []
				};
			}

			const version: NoteVersionRecord = {
				_id: createSequentialVersionId(
					input.fileId,
					input.capturedAtMs,
					latestVersion?._id
				),
				type: "note-version",
				fileId: input.fileId,
				path: input.path,
				fileName: input.fileName,
				content: input.content,
				contentHash: input.contentHash,
				size: input.size,
				capturedAt,
				sourceLastChanged: input.sourceLastChanged,
				event: input.event
			};

			const previousVersionId = existingNote?.latestVersionId ?? latestVersion?._id;

			if (previousVersionId) {
				version.previousVersionId = previousVersionId;
			}

			const note = createUpdatedNoteRecord(existingNote, input, version, capturedAt);
			const documents: Array<PouchDB.WritableDocument<HistoryDocument>> = [version, note];
			const pathIndex = await createPathIndexUpsert(db, input.path, input.fileId, capturedAt);

			if (pathIndex) {
				documents.push(pathIndex);
			}

			assertBulkDocsSucceeded(await db.bulkDocs(documents), "captureVersion");

			logger.debug("Note version captured", {
				fileId: input.fileId,
				path: input.path,
				event: input.event,
				versionId: version._id,
				versionCount: note.versionCount
			});

			return {
				captured: true,
				note,
				version,
				prunedVersionIds: await pruneVersionsInDb(db, input.fileId, maxVersionsPerNote)
			};
		});
	}

	/**
	 * Moves the path index and records the rename on the note. Renames keep the
	 * same `fileId`, so they never create a version document.
	 */
	async renameNote(fileId: string, newPath: string, changedAtMs: number) {
		return this.runWithDb("renameNote", async (db) => {
			const existingNote = await getNoteRecord(db, fileId);

			if (!existingNote) {
				return null;
			}

			if (existingNote.path === newPath) {
				return existingNote;
			}

			return movePathIndex(db, existingNote, newPath, new Date(changedAtMs).toISOString());
		});
	}

	/**
	 * Records a deletion without removing history. The tombstone carries the
	 * last known content so it stays restorable like any other version.
	 */
	async markNoteDeleted(
		fileId: string,
		deletedAtMs: number,
		maxVersionsPerNote: number
	): Promise<DeleteNoteResult | null> {
		return this.runWithDb("markNoteDeleted", async (db) => {
			const existingNote = await getNoteRecord(db, fileId);

			if (!existingNote || existingNote.deleted) {
				return null;
			}

			const [latestVersion] = await listVersionRecords(db, fileId, {
				descending: true,
				limit: 1
			});
			const deletedAt = new Date(deletedAtMs).toISOString();
			const version: NoteVersionRecord = {
				_id: createSequentialVersionId(fileId, deletedAtMs, latestVersion?._id),
				type: "note-version",
				fileId,
				path: existingNote.path,
				fileName: existingNote.fileName,
				content: latestVersion?.content ?? "",
				contentHash: latestVersion?.contentHash ?? existingNote.contentHash,
				size: latestVersion?.size ?? existingNote.size,
				capturedAt: deletedAt,
				sourceLastChanged: existingNote.lastChanged,
				event: "deleted"
			};

			if (existingNote.latestVersionId) {
				version.previousVersionId = existingNote.latestVersionId;
			}

			const note: ExistingNoteRecord = {
				...existingNote,
				deleted: true,
				deletedAt,
				latestVersionId: version._id,
				versionCount: existingNote.versionCount + 1,
				updatedAt: deletedAt
			};
			const documents: Array<PouchDB.WritableDocument<HistoryDocument>> = [version, note];
			const pathIndex = await getPathIndexRecord(db, existingNote.path);

			if (pathIndex && pathIndex.fileId === fileId) {
				documents.push({
					_id: pathIndex._id,
					_rev: pathIndex._rev,
					_deleted: true
				});
			}

			assertBulkDocsSucceeded(await db.bulkDocs(documents), "markNoteDeleted");
			logger.debug("Note deletion recorded", { fileId, path: existingNote.path });

			return {
				note,
				version,
				prunedVersionIds: await pruneVersionsInDb(db, fileId, maxVersionsPerNote)
			};
		});
	}

	/** Protected versions are exempt from retention. */
	async setVersionProtected(versionId: string, isProtected: boolean) {
		return this.runWithDb("setVersionProtected", async (db) => {
			const existing = await getDocument(db, versionId);

			if (!existing || !isNoteVersionRecord(existing)) {
				return null;
			}

			const version: ExistingVersionRecord = {
				...existing,
				protected: isProtected
			};
			await db.put(version);
			return version;
		});
	}

	async pruneVersions(fileId: string, maxVersionsPerNote: number) {
		return this.runWithDb(
			"pruneVersions",
			(db) => pruneVersionsInDb(db, fileId, maxVersionsPerNote)
		);
	}

	async reset() {
		const resetOperation = this.operationQueue.then(async () => {
			this.ensureDbOpen();
			logger.warn("Resetting local history database", undefined, {
				database: this.databaseName
			});

			try {
				await this.db.destroy();
			} finally {
				this.dbClosed = true;
				this.ensureDbOpen();
			}

			await this.db.info();
			logger.info("Local history database reset completed", {
				database: this.databaseName
			});
		});

		this.operationQueue = resetOperation.then(
			() => undefined,
			() => undefined
		);

		await resetOperation;
	}

	async close() {
		const closeOperation = this.operationQueue.then(async () => {
			if (!this.dbClosed) {
				await this.db.close();
				this.dbClosed = true;
			}
		});

		this.operationQueue = closeOperation.then(
			() => undefined,
			() => undefined
		);

		await closeOperation;
	}

	private runWithDb<T>(
		operationName: string,
		operation: (db: PouchDB<HistoryDocument>) => Promise<T>
	) {
		const queuedOperation = this.operationQueue.then(async () => {
			this.ensureDbOpen();

			try {
				return await operation(this.db);
			} catch (error) {
				logger.error(`Operation ${operationName} failed`, error);
				throw error;
			}
		});

		this.operationQueue = queuedOperation.then(
			() => undefined,
			() => undefined
		);

		return queuedOperation;
	}

	private ensureDbOpen() {
		if (!this.dbClosed) {
			return;
		}

		this.db = new PouchDB<HistoryDocument>(this.databaseName);
		this.dbClosed = false;
	}
}

async function getDocument(db: PouchDB<HistoryDocument>, documentId: string) {
	try {
		return await db.get(documentId);
	} catch (error) {
		if (isPouchNotFound(error)) {
			return null;
		}

		throw error;
	}
}

/** Existence check that avoids reading a version's stored content. */
async function documentExists(db: PouchDB<HistoryDocument>, documentId: string) {
	if (!documentId) {
		return false;
	}

	const result = await db.allDocs({ keys: [documentId] });
	const [row] = result.rows;

	return row !== undefined && row.error === undefined && row.value?.deleted !== true;
}

async function getNoteRecord(db: PouchDB<HistoryDocument>, fileId: string) {
	const document = await getDocument(db, createNoteRecordId(fileId));
	return document && document.type === "note" ? document : null;
}

async function getPathIndexRecord(db: PouchDB<HistoryDocument>, path: string) {
	const document = await getDocument(db, createPathIndexId(path));
	return document && document.type === "note-path" ? document : null;
}

async function listVersionRecords(
	db: PouchDB<HistoryDocument>,
	fileId: string,
	options: ListVersionsOptions
) {
	const range = createVersionIdRange(fileId);
	const result = await db.allDocs({
		startkey: options.descending ? range.endkey : range.startkey,
		endkey: options.descending ? range.startkey : range.endkey,
		descending: options.descending,
		include_docs: true,
		...(typeof options.limit === "number" ? { limit: options.limit } : {})
	});

	return result.rows.flatMap(
		(row) => (row.doc && isNoteVersionRecord(row.doc) ? [row.doc] : [])
	);
}

async function movePathIndex(
	db: PouchDB<HistoryDocument>,
	existingNote: ExistingNoteRecord,
	newPath: string,
	changedAt: string
) {
	const previousPath = existingNote.path;
	const note: ExistingNoteRecord = {
		...existingNote,
		path: newPath,
		fileName: getFileNameFromPath(newPath),
		pathHistory: appendPathChange(existingNote.pathHistory, {
			previousPath,
			path: newPath,
			changedAt
		}),
		updatedAt: changedAt
	};
	const documents: Array<PouchDB.WritableDocument<HistoryDocument>> = [note];
	const previousPathIndex = await getPathIndexRecord(db, previousPath);

	if (previousPathIndex && previousPathIndex.fileId === existingNote.fileId) {
		documents.push({
			_id: previousPathIndex._id,
			_rev: previousPathIndex._rev,
			_deleted: true
		});
	}

	const pathIndex = await createPathIndexUpsert(db, newPath, existingNote.fileId, changedAt);

	if (pathIndex) {
		documents.push(pathIndex);
	}

	assertBulkDocsSucceeded(await db.bulkDocs(documents), "movePathIndex");
	logger.debug("Note path updated", {
		fileId: existingNote.fileId,
		previousPath,
		path: newPath
	});

	return note;
}

async function pruneVersionsInDb(
	db: PouchDB<HistoryDocument>,
	fileId: string,
	maxVersionsPerNote: number
) {
	if (maxVersionsPerNote <= 0) {
		return [];
	}

	const storedVersionCount = (await db.allDocs(createVersionIdRange(fileId))).rows.length;

	if (storedVersionCount <= maxVersionsPerNote) {
		return [];
	}

	const versions = await listVersionRecords(db, fileId, {});
	const expendableVersions = versions.filter((version) => version.protected !== true);
	const removableCount = Math.min(
		versions.length - maxVersionsPerNote,
		expendableVersions.length
	);

	if (removableCount <= 0) {
		return [];
	}

	const removedVersions = expendableVersions.slice(0, removableCount);
	assertBulkDocsSucceeded(
		await db.bulkDocs(removedVersions.map((version) => ({
			_id: version._id,
			_rev: version._rev,
			_deleted: true as const
		}))),
		"pruneVersions"
	);

	const prunedVersionIds = removedVersions.map((version) => version._id);
	const remainingCount = versions.length - prunedVersionIds.length;
	const note = await getNoteRecord(db, fileId);

	if (note && note.versionCount !== remainingCount) {
		await db.put({
			...note,
			versionCount: remainingCount
		});
	}

	logger.debug("Expired note versions removed", {
		fileId,
		removed: prunedVersionIds.length,
		remaining: remainingCount
	});

	return prunedVersionIds;
}

function hasSameStoredContent(existingNote: NoteRecord, contentHash: string) {
	return !existingNote.deleted
		&& existingNote.versionCount > 0
		&& existingNote.contentHash === contentHash;
}

function createUpdatedNoteRecord(
	existingNote: ExistingNoteRecord | null,
	input: CaptureVersionInput,
	version: NoteVersionRecord,
	capturedAt: string
): NoteRecordUpsert {
	const pathHistory = existingNote && existingNote.path !== input.path
		? appendPathChange(existingNote.pathHistory, {
			previousPath: existingNote.path,
			path: input.path,
			changedAt: capturedAt
		})
		: existingNote?.pathHistory ?? [];
	const note: NoteRecordUpsert = {
		...(existingNote ?? {}),
		_id: createNoteRecordId(input.fileId),
		type: "note",
		fileId: input.fileId,
		path: input.path,
		fileName: input.fileName,
		contentHash: input.contentHash,
		size: input.size,
		lastChanged: input.sourceLastChanged,
		lastChangedIso: new Date(input.sourceLastChanged).toISOString(),
		latestVersionId: version._id,
		versionCount: (existingNote?.versionCount ?? 0) + 1,
		deleted: false,
		pathHistory,
		createdAt: existingNote?.createdAt ?? capturedAt,
		updatedAt: capturedAt
	};

	delete note.deletedAt;
	return note;
}

async function createPathIndexUpsert(
	db: PouchDB<HistoryDocument>,
	path: string,
	fileId: string,
	updatedAt: string
) {
	const existing = await getPathIndexRecord(db, path);

	if (existing && existing.fileId === fileId) {
		return null;
	}

	const pathIndex: NotePathIndexRecord & { _rev?: string } = {
		_id: createPathIndexId(path),
		type: "note-path",
		path,
		fileId,
		updatedAt
	};

	if (existing) {
		pathIndex._rev = existing._rev;
	}

	return pathIndex;
}

function appendPathChange(pathHistory: NotePathChange[], change: NotePathChange) {
	return [...pathHistory, change].slice(-MAX_PATH_HISTORY_ENTRIES);
}

function assertBulkDocsSucceeded(rows: PouchDB.BulkDocsRow[], operationName: string) {
	const failedRows = rows.filter((row): row is PouchDB.BulkDocsErrorRow => "error" in row);

	if (failedRows.length === 0) {
		return;
	}

	const details = failedRows
		.map((row) => `${row.id}: ${row.error}${row.reason ? ` (${row.reason})` : ""}`)
		.join("; ");

	throw new Error(`${operationName} failed to write ${failedRows.length} document(s). ${details}`);
}
