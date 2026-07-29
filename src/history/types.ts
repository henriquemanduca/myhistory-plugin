export type NoteVersionEvent =
	| "baseline"
	| "created"
	| "modified"
	| "deleted"
	| "restored";

export interface NotePathChange {
	previousPath: string;
	path: string;
	changedAt: string;
}

/**
 * Mutable identity and current state of a tracked note. The `fileId` never
 * changes, so the timeline survives renames and deletions.
 */
export interface NoteRecord {
	_id: string;
	type: "note";
	fileId: string;
	path: string;
	fileName: string;
	contentHash: string;
	size: number;
	lastChanged: number;
	lastChangedIso: string;
	latestVersionId: string;
	versionCount: number;
	deleted: boolean;
	deletedAt?: string;
	pathHistory: NotePathChange[];
	createdAt: string;
	updatedAt: string;
}

/** Immutable version document. Never rewritten, only expired by retention. */
export interface NoteVersionRecord {
	_id: string;
	type: "note-version";
	fileId: string;
	path: string;
	fileName: string;
	content: string;
	contentHash: string;
	size: number;
	capturedAt: string;
	sourceLastChanged: number;
	event: NoteVersionEvent;
	previousVersionId?: string;
	protected?: boolean;
}

/** Maps a vault path to the persistent `fileId` that owns its history. */
export interface NotePathIndexRecord {
	_id: string;
	type: "note-path";
	path: string;
	fileId: string;
	updatedAt: string;
}

export type HistoryDocument = NoteRecord | NoteVersionRecord | NotePathIndexRecord;

export function isNoteRecord(document: HistoryDocument): document is NoteRecord {
	return document.type === "note";
}

export function isNoteVersionRecord(
	document: HistoryDocument
): document is NoteVersionRecord {
	return document.type === "note-version";
}

export function isNotePathIndexRecord(
	document: HistoryDocument
): document is NotePathIndexRecord {
	return document.type === "note-path";
}
