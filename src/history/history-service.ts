import { App, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import type { MyHistorySettings } from "../settings";
import type { PouchDbHistoryStore } from "./pouchdb-store";
import type { NoteRecord, NoteVersionEvent, NoteVersionRecord } from "./types";
import {
	collectNotesInFolder,
	createFileId,
	createTextContentHash,
	getContentSize,
	getFileNameFromPath,
	getHistoryFolder,
	getHistoryFolderState,
	getParentFolderPath,
	isNotePath,
	isPathInsideHistoryFolder,
	isTrackedNote,
	isTrackedNotePath,
	readNoteContent
} from "./note-files";
import { Logger } from "../utils/logger";

const logger = new Logger("HistoryService");

/**
 * A note being edited never stops firing `modify`, so each pending capture also
 * carries a deadline. This multiplier turns the idle delay into that deadline.
 */
const CAPTURE_DEADLINE_MULTIPLIER = 4;
const MIN_CAPTURE_DEBOUNCE_MS = 1000;

export type HistoryStatus =
	| { state: "idle" }
	| { state: "queued"; pending: number }
	| { state: "capturing"; current: number; total: number; captured: number }
	| { state: "captured"; total: number; captured: number; skipped: number }
	| { state: "reconciling"; current: number; total: number }
	| { state: "reconciled"; tracked: number; captured: number; deleted: number }
	| { state: "restoring"; path: string }
	| { state: "restored"; path: string }
	| { state: "pruning" }
	| { state: "pruned"; removed: number }
	| { state: "resetting-database" }
	| { state: "database-reset" }
	| { state: "error"; message: string };

export type CompletedHistoryOperation =
	| "capture"
	| "reconcile"
	| "restore"
	| "resetDatabase";

export interface NoteTimeline {
	note: NoteRecord;
	versions: NoteVersionRecord[];
}

export interface RestoreVersionResult {
	path: string;
	fileId: string;
	versionId: string;
	restoredVersionId: string | null;
}

interface PendingCapture {
	timer: number;
	deadlineAt: number;
}

export interface CaptureOutcome {
	captured: boolean;
	fileId: string;
	versionId: string | null;
}

export class HistoryService {
	private pendingCaptures = new Map<string, PendingCapture>();
	private suppressedPaths = new Set<string>();
	private captureInProgress = false;
	private operationInProgress = false;
	private closed = false;

	constructor(
		private app: App,
		private store: PouchDbHistoryStore,
		private getSettings: () => MyHistorySettings,
		private onStatusChange: (status: HistoryStatus) => void,
		private onOperationCompleted: (operation: CompletedHistoryOperation) => Promise<void>,
		private onHistoryChanged: (fileId: string | null) => void
	) {
		this.onStatusChange({ state: "idle" });
	}

	async initialize() {
		if (this.closed || !this.getSettings().reconcileOnStartup) {
			return;
		}

		try {
			await this.reconcile();
		} catch (error) {
			logger.error("Startup reconciliation failed", error);
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Startup reconciliation failed")
			});
		}
	}

	isRunning() {
		return this.captureInProgress || this.operationInProgress;
	}

	getDatabaseName() {
		return this.store.getDatabaseName();
	}

	/**
	 * Schedules a capture for a modified note. The timer restarts on every
	 * change so no version is stored mid-keystroke, but the deadline guarantees
	 * a long editing session still produces versions.
	 */
	queueCapture(abstractFile: TAbstractFile) {
		if (this.closed || !(abstractFile instanceof TFile) || !this.isTrackedFile(abstractFile)) {
			return;
		}

		const path = abstractFile.path;

		if (this.suppressedPaths.has(path)) {
			return;
		}

		const debounceMs = this.getCaptureDebounceMs();
		const now = Date.now();
		const pending = this.pendingCaptures.get(path);
		const deadlineAt = pending?.deadlineAt
			?? now + debounceMs * CAPTURE_DEADLINE_MULTIPLIER;

		if (pending) {
			window.clearTimeout(pending.timer);
		}

		const delayMs = Math.max(0, Math.min(debounceMs, deadlineAt - now));
		this.pendingCaptures.set(path, {
			deadlineAt,
			timer: window.setTimeout(() => {
				this.pendingCaptures.delete(path);
				void this.runPendingCapture(path);
			}, delayMs)
		});

		if (!this.captureInProgress) {
			this.onStatusChange({
				state: "queued",
				pending: this.pendingCaptures.size
			});
		}
	}

	/** Captures the current content of a note immediately. */
	async captureFile(file: TFile, event: NoteVersionEvent = "modified") {
		if (this.closed || !this.isTrackedFile(file)) {
			return null;
		}

		this.cancelPendingCapture(file.path);
		return this.captureNoteFile(file, event);
	}

	async captureNoteAtPath(path: string, event: NoteVersionEvent = "modified") {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.captureFile(file, event) : null;
	}

	async handleRenamedFile(abstractFile: TAbstractFile, oldPath: string) {
		if (this.closed) {
			return;
		}

		if (abstractFile instanceof TFolder) {
			await this.handleRenamedFolder(abstractFile, oldPath);
			return;
		}

		if (!(abstractFile instanceof TFile)) {
			return;
		}

		this.cancelPendingCapture(oldPath);
		const historyFolder = this.getHistoryFolder();
		const wasTracked = isTrackedNotePath(oldPath, historyFolder);
		const isTracked = isTrackedNote(abstractFile, historyFolder);

		if (wasTracked && !isTracked) {
			// The note left the tracked folder or stopped being Markdown. Keep
			// its history and stop following the path.
			await this.recordDeletionForPath(oldPath);
			return;
		}

		if (!isTracked) {
			return;
		}

		if (wasTracked) {
			const note = await this.store.getNoteByPath(oldPath);

			if (note) {
				const renamed = await this.store.renameNote(
					note.fileId,
					abstractFile.path,
					Date.now()
				);
				this.onHistoryChanged(renamed?.fileId ?? null);
				return;
			}
		}

		await this.captureNoteFile(abstractFile, "created");
	}

	async handleDeletedFile(abstractFile: TAbstractFile) {
		if (this.closed) {
			return;
		}

		if (abstractFile instanceof TFolder) {
			await this.recordDeletionForFolder(abstractFile.path);
			return;
		}

		this.cancelPendingCapture(abstractFile.path);

		if (!isTrackedNotePath(abstractFile.path, this.getHistoryFolder())) {
			return;
		}

		await this.recordDeletionForPath(abstractFile.path);
	}

	async getTimelineForPath(path: string): Promise<NoteTimeline | null> {
		if (this.closed) {
			return null;
		}

		const note = await this.store.getNoteByPath(path);
		return !this.closed && note ? this.getTimelineForNote(note) : null;
	}

	async getTimelineForFileId(fileId: string): Promise<NoteTimeline | null> {
		if (this.closed) {
			return null;
		}

		const note = await this.store.getNote(fileId);
		return !this.closed && note ? this.getTimelineForNote(note) : null;
	}

	async getVersion(versionId: string) {
		if (this.closed) {
			return null;
		}

		const version = await this.store.getVersion(versionId);
		return this.closed ? null : version;
	}

	async setVersionProtected(versionId: string, isProtected: boolean) {
		if (this.closed) {
			return null;
		}

		const version = await this.store.setVersionProtected(versionId, isProtected);

		if (version && !this.closed) {
			this.onHistoryChanged(version.fileId);
		}

		return version;
	}

	/**
	 * Writes a stored version back to the vault. The content being replaced is
	 * captured first, so restoring never destroys the current state.
	 */
	async restoreVersion(versionId: string): Promise<RestoreVersionResult | null> {
		if (this.closed) {
			return null;
		}

		const version = await this.store.getVersion(versionId);

		if (this.closed) {
			return null;
		}

		if (!version) {
			new Notice("MyHistory could not find the selected version.");
			return null;
		}

		const actualHash = await createTextContentHash(version.content);

		if (this.closed) {
			return null;
		}

		if (actualHash !== version.contentHash) {
			logger.error("Stored version failed its integrity check", undefined, {
				versionId,
				fileId: version.fileId
			});
			this.onStatusChange({
				state: "error",
				message: "The stored version failed its integrity check"
			});
			new Notice("MyHistory did not restore the version: its stored content is corrupted.");
			return null;
		}

		const note = await this.store.getNote(version.fileId);

		if (this.closed) {
			return null;
		}

		const targetPath = note?.path ?? version.path;

		this.operationInProgress = true;
		this.onStatusChange({ state: "restoring", path: targetPath });
		this.suppressedPaths.add(targetPath);
		this.cancelPendingCapture(targetPath);

		try {
			const existingFile = this.app.vault.getAbstractFileByPath(targetPath);

			if (existingFile instanceof TFolder) {
				throw new Error(`Cannot restore ${targetPath}: the path is a folder.`);
			}

			if (existingFile instanceof TFile) {
				await this.captureNoteFile(existingFile, "modified");

				if (this.closed) {
					return null;
				}

				await this.app.vault.modify(existingFile, version.content);
			} else {
				await this.ensureParentFolderExists(targetPath);
				await this.app.vault.create(targetPath, version.content);
			}

			const restoredFile = this.app.vault.getAbstractFileByPath(targetPath);
			const restored = restoredFile instanceof TFile
				? await this.captureNoteFile(restoredFile, "restored")
				: null;

			this.onStatusChange({ state: "restored", path: targetPath });
			await this.onOperationCompleted("restore");
			this.onHistoryChanged(version.fileId);
			new Notice(`MyHistory restored ${getFileNameFromPath(targetPath)}.`);

			return {
				path: targetPath,
				fileId: version.fileId,
				versionId,
				restoredVersionId: restored?.versionId ?? null
			};
		} catch (error) {
			logger.error("Version restore failed", error, { versionId, path: targetPath });
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Version restore failed")
			});
			new Notice("MyHistory failed to restore the version. Check the log for details.");
			return null;
		} finally {
			this.suppressedPaths.delete(targetPath);
			this.operationInProgress = false;
		}
	}

	/**
	 * Compares every tracked note with its stored timeline. Notes without
	 * history get a baseline version, changed notes get a new version, and notes
	 * that disappeared while Obsidian was closed get a deletion event.
	 */
	async reconcile() {
		if (this.closed) {
			return null;
		}

		if (this.operationInProgress) {
			new Notice("MyHistory is already running an operation.");
			return null;
		}

		const historyFolder = this.getHistoryFolder();
		const folderState = getHistoryFolderState(this.app, historyFolder);

		if (!folderState.valid) {
			this.onStatusChange({ state: "error", message: folderState.message });
			new Notice(`MyHistory could not read the tracked folder. ${folderState.message}`);
			return null;
		}

		this.operationInProgress = true;
		const notes = collectNotesInFolder(folderState.folder);
		let captured = 0;

		try {
			for (const [index, file] of notes.entries()) {
				if (this.closed) {
					return null;
				}

				this.onStatusChange({
					state: "reconciling",
					current: index + 1,
					total: notes.length
				});

				const outcome = await this.captureNoteFile(file, "baseline");

				if (outcome?.captured) {
					captured += 1;
				}
			}

			const deleted = await this.recordMissingNoteDeletions(historyFolder, notes);

			if (this.closed) {
				return null;
			}

			this.onStatusChange({
				state: "reconciled",
				tracked: notes.length,
				captured,
				deleted
			});
			await this.onOperationCompleted("reconcile");
			this.onHistoryChanged(null);

			logger.info("Reconciliation completed", {
				tracked: notes.length,
				captured,
				deleted
			});

			return { tracked: notes.length, captured, deleted };
		} catch (error) {
			logger.error("Reconciliation failed", error);
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Reconciliation failed")
			});
			new Notice("MyHistory failed to scan the vault. Check the log for details.");
			return null;
		} finally {
			this.operationInProgress = false;
		}
	}

	/** Applies the retention limit to every note, after the limit changes. */
	async applyRetention() {
		if (this.closed) {
			return null;
		}

		if (this.operationInProgress) {
			new Notice("MyHistory is already running an operation.");
			return null;
		}

		this.operationInProgress = true;
		this.onStatusChange({ state: "pruning" });

		try {
			const maxVersionsPerNote = this.getMaxVersionsPerNote();
			const notes = await this.store.listNotes();
			let removed = 0;

			for (const note of notes) {
				if (this.closed) {
					return null;
				}

				const prunedVersionIds = await this.store.pruneVersions(
					note.fileId,
					maxVersionsPerNote
				);
				removed += prunedVersionIds.length;
			}

			if (this.closed) {
				return null;
			}

			this.onStatusChange({ state: "pruned", removed });
			this.onHistoryChanged(null);
			logger.info("Retention applied", { notes: notes.length, removed });
			return { notes: notes.length, removed };
		} catch (error) {
			logger.error("Retention pass failed", error);
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Retention pass failed")
			});
			new Notice("MyHistory failed to apply retention. Check the log for details.");
			return null;
		} finally {
			this.operationInProgress = false;
		}
	}

	async resetDatabase(): Promise<boolean> {
		if (this.closed) {
			return false;
		}

		if (this.operationInProgress) {
			new Notice("MyHistory is already running an operation.");
			return false;
		}

		this.operationInProgress = true;
		this.onStatusChange({ state: "resetting-database" });
		this.clearPendingCaptures();

		try {
			await this.store.reset();

			if (this.closed) {
				return false;
			}

			this.onStatusChange({ state: "database-reset" });
			await this.onOperationCompleted("resetDatabase");
			this.onHistoryChanged(null);
			new Notice("MyHistory deleted the local history database.");
			return true;
		} catch (error) {
			logger.error("Local history database reset failed", error);
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Local history database reset failed")
			});
			new Notice("MyHistory failed to reset the local database. Check the log for details.");
			return false;
		} finally {
			this.operationInProgress = false;
		}
	}

	/** Captures every note that is waiting on its debounce timer. */
	async flushPendingCaptures() {
		if (this.closed) {
			return;
		}

		const paths = Array.from(this.pendingCaptures.keys());

		for (const path of paths) {
			this.cancelPendingCapture(path);
			await this.captureNoteAtPath(path);
		}
	}

	async close() {
		this.closed = true;
		this.clearPendingCaptures();
		await this.store.close();
	}

	private async getTimelineForNote(note: NoteRecord): Promise<NoteTimeline> {
		return {
			note,
			versions: await this.store.listVersions(note.fileId, { descending: true })
		};
	}

	private async runPendingCapture(path: string) {
		if (this.closed) {
			return;
		}

		this.captureInProgress = true;

		try {
			await this.captureNoteAtPath(path);

			if (this.closed) {
				return;
			}

			this.onStatusChange({
				state: "captured",
				total: 1,
				captured: 1,
				skipped: 0
			});
		} catch (error) {
			logger.error("Scheduled capture failed", error, { path });
			this.onStatusChange({
				state: "error",
				message: getErrorMessage(error, "Scheduled capture failed")
			});
		} finally {
			this.captureInProgress = false;

			if (!this.closed && this.pendingCaptures.size > 0) {
				this.onStatusChange({
					state: "queued",
					pending: this.pendingCaptures.size
				});
			}
		}
	}

	private async captureNoteFile(
		file: TFile,
		event: NoteVersionEvent
	): Promise<CaptureOutcome | null> {
		if (this.closed || !this.isTrackedFile(file)) {
			return null;
		}

		const { content, contentHash } = await readNoteContent(this.app, file);

		if (this.closed) {
			return null;
		}

		const existingNote = await this.store.getNoteByPath(file.path);

		if (this.closed) {
			return null;
		}

		const fileId = existingNote?.fileId ?? createFileId();
		const resolvedEvent = resolveCaptureEvent(event, existingNote);
		const result = await this.store.captureVersion(
			{
				fileId,
				path: file.path,
				fileName: file.name,
				content,
				contentHash,
				size: getContentSize(content),
				sourceLastChanged: file.stat.mtime,
				event: resolvedEvent,
				capturedAtMs: Date.now()
			},
			this.getMaxVersionsPerNote()
		);

		if (result.captured && !this.closed) {
			await this.onOperationCompleted("capture");
			this.onHistoryChanged(fileId);
		}

		return {
			captured: result.captured,
			fileId,
			versionId: result.version?._id ?? null
		};
	}

	private async recordDeletionForPath(path: string) {
		const note = await this.store.getNoteByPath(path);

		if (this.closed || !note) {
			return;
		}

		const result = await this.store.markNoteDeleted(
			note.fileId,
			Date.now(),
			this.getMaxVersionsPerNote()
		);

		if (result) {
			this.onHistoryChanged(note.fileId);
		}
	}

	private async recordDeletionForFolder(folderPath: string) {
		const prefix = `${folderPath}/`;
		const notes = await this.store.listNotes();

		for (const note of notes) {
			if (this.closed) {
				return;
			}

			if (note.deleted || !note.path.startsWith(prefix)) {
				continue;
			}

			this.cancelPendingCapture(note.path);
			await this.recordDeletionForPath(note.path);
		}
	}

	private async handleRenamedFolder(folder: TFolder, oldPath: string) {
		const prefix = `${oldPath}/`;
		const historyFolder = this.getHistoryFolder();
		const notes = await this.store.listNotes();

		for (const note of notes) {
			if (this.closed) {
				return;
			}

			if (note.deleted || !note.path.startsWith(prefix)) {
				continue;
			}

			const newPath = `${folder.path}/${note.path.slice(prefix.length)}`;
			this.cancelPendingCapture(note.path);

			if (isTrackedNotePath(newPath, historyFolder)) {
				await this.store.renameNote(note.fileId, newPath, Date.now());
			} else {
				await this.recordDeletionForPath(note.path);
			}
		}

		this.onHistoryChanged(null);
	}

	private async recordMissingNoteDeletions(historyFolder: string, notes: TFile[]) {
		const trackedPaths = new Set(notes.map((file) => file.path));
		const storedNotes = await this.store.listNotes();
		let deleted = 0;

		for (const note of storedNotes) {
			if (this.closed) {
				return deleted;
			}

			if (note.deleted || trackedPaths.has(note.path)) {
				continue;
			}

			if (!isNotePath(note.path) || !isPathInsideHistoryFolder(note.path, historyFolder)) {
				// The note is outside the tracked folder now. Keep its history
				// untouched instead of recording a deletion that never happened.
				continue;
			}

			if (this.app.vault.getAbstractFileByPath(note.path)) {
				continue;
			}

			const result = await this.store.markNoteDeleted(
				note.fileId,
				Date.now(),
				this.getMaxVersionsPerNote()
			);

			if (result) {
				deleted += 1;
			}
		}

		return deleted;
	}

	private async ensureParentFolderExists(path: string) {
		const parentPath = getParentFolderPath(path);

		if (!parentPath) {
			return;
		}

		const segments = parentPath.split("/");
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);

			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Cannot restore into ${parentPath}: ${currentPath} is a file.`);
			}
		}
	}

	private cancelPendingCapture(path: string) {
		const pending = this.pendingCaptures.get(path);

		if (!pending) {
			return;
		}

		window.clearTimeout(pending.timer);
		this.pendingCaptures.delete(path);
	}

	private clearPendingCaptures() {
		for (const pending of this.pendingCaptures.values()) {
			window.clearTimeout(pending.timer);
		}

		this.pendingCaptures.clear();
	}

	private isTrackedFile(file: TFile) {
		return isTrackedNote(file, this.getHistoryFolder());
	}

	private getHistoryFolder() {
		const settings = this.getSettings();
		return getHistoryFolder(
			this.app,
			settings.historyFolderMode,
			settings.customHistoryFolder
		);
	}

	private getMaxVersionsPerNote() {
		const { maxVersionsPerNote } = this.getSettings();
		return Number.isFinite(maxVersionsPerNote) && maxVersionsPerNote > 0
			? Math.trunc(maxVersionsPerNote)
			: 0;
	}

	private getCaptureDebounceMs() {
		const { captureDebounceSeconds } = this.getSettings();
		const debounceMs = Number.isFinite(captureDebounceSeconds)
			? Math.trunc(captureDebounceSeconds * 1000)
			: 0;

		return Math.max(MIN_CAPTURE_DEBOUNCE_MS, debounceMs);
	}
}

/**
 * A baseline is only a baseline the first time a note is seen. Reusing the
 * event for later scans would label ordinary edits as baselines.
 */
function resolveCaptureEvent(
	event: NoteVersionEvent,
	existingNote: NoteRecord | null
): NoteVersionEvent {
	if (!existingNote) {
		return event === "modified" ? "created" : event;
	}

	if (existingNote.deleted) {
		return event === "restored" ? "restored" : "created";
	}

	return event === "baseline" || event === "created" ? "modified" : event;
}

function getErrorMessage(error: unknown, fallback: string) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallback;
}
