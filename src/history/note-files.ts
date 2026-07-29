import { App, normalizePath, TFile, TFolder } from "obsidian";

export const NOTE_EXTENSION = "md";
export const NOTE_RECORD_PREFIX = "note:";
export const NOTE_VERSION_PREFIX = "version:";
export const NOTE_PATH_INDEX_PREFIX = "path:";

/** Highest code point PouchDB accepts as an exclusive upper bound for a prefix. */
const PREFIX_END_SUFFIX = "￰";
const VERSION_TIMESTAMP_LENGTH = 15;
const VERSION_SUFFIX_BYTES = 3;

export type HistoryFolderMode = "vault-root" | "custom";

export interface NoteContent {
	content: string;
	contentHash: string;
}

export interface KeyRange {
	startkey: string;
	endkey: string;
}

export function getHistoryFolder(
	app: App,
	historyFolderMode: HistoryFolderMode,
	customHistoryFolder: string
) {
	if (historyFolderMode === "custom") {
		return customHistoryFolder.trim();
	}

	return app.vault.getRoot().path || "/";
}

export function getHistoryFolderState(
	app: App,
	historyFolder: string
): { valid: true; folder: TFolder } | { valid: false; message: string } {
	const normalizedFolder = normalizeVaultFolder(historyFolder);

	if (normalizedFolder === "/") {
		return {
			valid: true,
			folder: app.vault.getRoot()
		};
	}

	const abstractFile = app.vault.getAbstractFileByPath(normalizedFolder);

	if (!abstractFile) {
		return {
			valid: false,
			message: `Folder not found: ${normalizedFolder}`
		};
	}

	if (!(abstractFile instanceof TFolder)) {
		return {
			valid: false,
			message: `Path is not a folder: ${normalizedFolder}`
		};
	}

	return {
		valid: true,
		folder: abstractFile
	};
}

export function collectNotesInFolder(folder: TFolder) {
	const notes: TFile[] = [];
	const remainingFolders = [folder];

	while (remainingFolders.length > 0) {
		const currentFolder = remainingFolders.pop();

		if (!currentFolder) {
			continue;
		}

		for (const child of currentFolder.children) {
			if (child instanceof TFile) {
				if (isNoteFile(child)) {
					notes.push(child);
				}
			} else if (child instanceof TFolder) {
				remainingFolders.push(child);
			}
		}
	}

	return notes;
}

export function isNoteFile(file: TFile) {
	return file.extension.toLowerCase() === NOTE_EXTENSION;
}

export function isNotePath(path: string) {
	return path.toLowerCase().endsWith(`.${NOTE_EXTENSION}`);
}

export function isTrackedNote(file: TFile, historyFolder: string) {
	return isNoteFile(file) && isPathInsideHistoryFolder(file.path, historyFolder);
}

export function isTrackedNotePath(path: string, historyFolder: string) {
	return isNotePath(path) && isPathInsideHistoryFolder(path, historyFolder);
}

export function isPathInsideHistoryFolder(path: string, historyFolder: string) {
	const normalizedFolder = normalizeVaultFolder(historyFolder);

	if (normalizedFolder === "/") {
		return true;
	}

	return path === normalizedFolder || path.startsWith(`${normalizedFolder}/`);
}

export function createFileId() {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return `${Date.now().toString(36)}-${createRandomHex(8)}`;
}

export function createNoteRecordId(fileId: string) {
	return `${NOTE_RECORD_PREFIX}${fileId}`;
}

export function getFileIdFromNoteRecordId(recordId: string) {
	return recordId.startsWith(NOTE_RECORD_PREFIX)
		? recordId.slice(NOTE_RECORD_PREFIX.length)
		: null;
}

/**
 * Version ids sort chronologically, so a version timeline is a single ranged
 * `allDocs` call instead of a query over the whole database.
 */
export function createVersionId(
	fileId: string,
	capturedAtMs: number,
	uniqueSuffix = createRandomHex(VERSION_SUFFIX_BYTES)
) {
	const timestamp = String(Math.max(0, Math.trunc(capturedAtMs)))
		.padStart(VERSION_TIMESTAMP_LENGTH, "0");

	return `${NOTE_VERSION_PREFIX}${fileId}:${timestamp}:${uniqueSuffix}`;
}

/**
 * Keeps the timeline ordered when two versions land in the same millisecond or
 * the system clock moves backwards. Version ids are opaque, so borrowing a
 * later timestamp costs nothing; `capturedAt` still reports the real time.
 */
export function createSequentialVersionId(
	fileId: string,
	capturedAtMs: number,
	latestVersionId?: string
) {
	const candidate = createVersionId(fileId, capturedAtMs);

	if (!latestVersionId || candidate > latestVersionId) {
		return candidate;
	}

	const latestTimestamp = getTimestampFromVersionId(latestVersionId);

	if (latestTimestamp === null) {
		return candidate;
	}

	return createVersionId(fileId, latestTimestamp + 1);
}

export function getFileIdFromVersionId(versionId: string) {
	if (!versionId.startsWith(NOTE_VERSION_PREFIX)) {
		return null;
	}

	const [fileId] = versionId.slice(NOTE_VERSION_PREFIX.length).split(":");
	return fileId || null;
}

export function getTimestampFromVersionId(versionId: string) {
	if (!versionId.startsWith(NOTE_VERSION_PREFIX)) {
		return null;
	}

	const [, timestamp] = versionId.slice(NOTE_VERSION_PREFIX.length).split(":");
	const parsed = Number.parseInt(timestamp ?? "", 10);

	return Number.isFinite(parsed) ? parsed : null;
}

export function createVersionIdRange(fileId: string): KeyRange {
	const prefix = `${NOTE_VERSION_PREFIX}${fileId}:`;

	return {
		startkey: prefix,
		endkey: `${prefix}${PREFIX_END_SUFFIX}`
	};
}

export function createPrefixRange(prefix: string): KeyRange {
	return {
		startkey: prefix,
		endkey: `${prefix}${PREFIX_END_SUFFIX}`
	};
}

export function createPathIndexId(path: string) {
	return `${NOTE_PATH_INDEX_PREFIX}${normalizePath(path)}`;
}

export function getPathFromPathIndexId(recordId: string) {
	return recordId.startsWith(NOTE_PATH_INDEX_PREFIX)
		? recordId.slice(NOTE_PATH_INDEX_PREFIX.length)
		: null;
}

export async function readNoteContent(app: App, file: TFile): Promise<NoteContent> {
	const content = normalizeTextContent(await app.vault.cachedRead(file));

	return {
		content,
		contentHash: await createTextContentHash(content)
	};
}

export function normalizeTextContent(content: string) {
	return content.replace(/\r\n?/g, "\n");
}

export async function createTextContentHash(content: string) {
	const normalized = normalizeTextContent(content);
	const hashBuffer = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(normalized)
	);

	return Array.from(
		new Uint8Array(hashBuffer),
		(byte) => byte.toString(16).padStart(2, "0")
	).join("");
}

export function getContentSize(content: string) {
	return new TextEncoder().encode(content).length;
}

export function getFileNameFromPath(path: string) {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function getParentFolderPath(path: string) {
	const separatorIndex = path.lastIndexOf("/");
	return separatorIndex > 0 ? path.slice(0, separatorIndex) : "";
}

function normalizeVaultFolder(folder: string) {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	return trimmed || "/";
}

function createRandomHex(byteLength: number) {
	if (typeof crypto.getRandomValues === "function") {
		return Array.from(
			crypto.getRandomValues(new Uint8Array(byteLength)),
			(byte) => byte.toString(16).padStart(2, "0")
		).join("");
	}

	return Math.random().toString(16).slice(2, 2 + byteLength * 2).padEnd(byteLength * 2, "0");
}
