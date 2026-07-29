import { Notice, Plugin, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	isHistoryFolderMode,
	MyHistorySettingTab,
	normalizeCaptureDebounceSeconds,
	normalizeMaxVersionsPerNote,
	type MyHistorySettings
} from "./settings";
import { PouchDbHistoryStore } from "./history/pouchdb-store";
import {
	HistoryService,
	type CompletedHistoryOperation,
	type HistoryStatus
} from "./history/history-service";
import type { NoteRecord, NoteVersionRecord } from "./history/types";
import { HISTORY_VIEW_TYPE, HistoryPanelView } from "./history-panel-view";
import { VersionPreviewModal } from "./version-preview-modal";
import { LocalDatabaseResetModal } from "./local-database-reset-modal";
import { formatDateTime } from "./utils/date-format";
import { isLoggerLevel, Logger } from "./utils/logger";

const IDLE_STATUS_DELAY_MS = 5000;
const STRING_SETTING_KEYS = [
	"localVaultId",
	"customHistoryFolder",
	"lastCaptureAt",
	"lastReconciliationAt",
	"lastRestoreAt",
	"lastDatabaseResetAt"
] as const;

interface HistoryStatusView {
	text: string;
	title: string;
	returnToIdle?: boolean;
}

export default class MyHistoryPlugin extends Plugin {
	settings!: MyHistorySettings;
	private store!: PouchDbHistoryStore;
	private historyService!: HistoryService;
	private statusBarEl!: HTMLElement;
	private idleStatusTimer: number | null = null;
	private previewModal: VersionPreviewModal | null = null;
	private localDatabaseResetModal: LocalDatabaseResetModal | null = null;

	async onload() {
		Logger.configureFileLogging(this.app.vault.adapter, this.getPluginDir());

		await this.loadSettings();

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addEventListener("click", () => void this.openHistoryPanel());
		this.updateStatus({ state: "idle" });

		this.store = new PouchDbHistoryStore(
			createHistoryDatabaseName(this.settings.localVaultId)
		);
		this.historyService = new HistoryService(
			this.app,
			this.store,
			() => this.settings,
			(status) => this.updateStatus(status),
			(operation) => this.saveCompletedOperation(operation),
			(fileId) => this.handleHistoryChanged(fileId)
		);

		this.registerView(
			HISTORY_VIEW_TYPE,
			(leaf) => new HistoryPanelView(leaf, this.historyService, {
				getMaxVersionsPerNote: () => this.settings.maxVersionsPerNote,
				openVersion: (version, note) => this.openVersionPreview(version, note),
				captureActiveNote: () => this.captureActiveNote(),
				toggleVersionProtection: (versionId, isProtected) =>
					this.toggleVersionProtection(versionId, isProtected)
			})
		);

		this.addRibbonIcon("history", "Open note history", () => {
			void this.openHistoryPanel();
		});

		this.addCommand({
			id: "open-note-history",
			name: "Open note history",
			callback: () => {
				void this.openHistoryPanel();
			}
		});

		this.addCommand({
			id: "capture-note-version",
			name: "Capture version of current note",
			callback: () => {
				void this.captureActiveNote();
			}
		});

		this.addCommand({
			id: "scan-notes",
			name: "Scan notes for missing versions",
			callback: () => {
				void this.historyService.reconcile();
			}
		});

		this.addCommand({
			id: "apply-retention",
			name: "Apply retention to every note",
			callback: () => {
				void this.applyRetention();
			}
		});

		this.addSettingTab(new MyHistorySettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create",
					(file) => this.historyService.queueCapture(file)
				)
			);

			this.registerEvent(
				this.app.vault.on("modify",
					(file) => this.historyService.queueCapture(file)
				)
			);

			this.registerEvent(
				this.app.vault.on("rename",
					(file, oldPath) => void this.historyService.handleRenamedFile(file, oldPath)
				)
			);

			this.registerEvent(
				this.app.vault.on("delete",
					(file) => void this.historyService.handleDeletedFile(file)
				)
			);

			void this.historyService.initialize();
		});
	}

	onunload() {
		this.clearIdleStatusTimer();
		this.previewModal?.close();
		this.localDatabaseResetModal?.close();
		this.historyService.close();
		void Logger.flush();
		// Obsidian automatically disposes registered events, views, and commands.
	}

	async loadSettings() {
		const savedSettings = normalizeSavedSettings((await this.loadData()) as unknown);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		Logger.setLevel(this.settings.logLevel);

		if (!this.settings.localVaultId) {
			this.settings.localVaultId = createLocalVaultId();
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getHistoryDatabaseName() {
		return createHistoryDatabaseName(this.settings.localVaultId);
	}

	updateLogLevel(value: unknown) {
		if (!isLoggerLevel(value)) {
			return;
		}

		this.settings.logLevel = value;
		Logger.setLevel(value);
	}

	async applyRetention() {
		await this.historyService.applyRetention();
	}

	openLocalDatabaseResetModal() {
		if (this.localDatabaseResetModal) {
			return;
		}

		this.localDatabaseResetModal = new LocalDatabaseResetModal(
			this.app,
			this.getHistoryDatabaseName(),
			() => this.historyService.resetDatabase(),
			() => {
				this.localDatabaseResetModal = null;
			}
		);
		this.localDatabaseResetModal.open();
	}

	private async openHistoryPanel() {
		const { workspace } = this.app;
		const [existingLeaf] = workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = existingLeaf ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
	}

	private async captureActiveNote() {
		const activeFile = this.app.workspace.getActiveFile();

		if (!(activeFile instanceof TFile)) {
			new Notice("Open a note to capture a version.");
			return;
		}

		const outcome = await this.historyService.captureFile(activeFile);

		if (!outcome) {
			new Notice("MyHistory does not track this file.");
			return;
		}

		new Notice(outcome.captured
			? `MyHistory captured a version of ${activeFile.name}.`
			: "No changes since the last stored version.");
	}

	private async toggleVersionProtection(versionId: string, isProtected: boolean) {
		const version = await this.historyService.setVersionProtected(versionId, isProtected);

		if (!version) {
			new Notice("MyHistory could not update the selected version.");
		}
	}

	private openVersionPreview(version: NoteVersionRecord, note: NoteRecord | null) {
		this.previewModal?.close();
		this.previewModal = new VersionPreviewModal(
			this.app,
			version,
			note,
			async (versionId) => {
				await this.historyService.restoreVersion(versionId);
			},
			() => {
				this.previewModal = null;
			}
		);
		this.previewModal.open();
	}

	private handleHistoryChanged(fileId: string | null) {
		for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
			const { view } = leaf;

			if (view instanceof HistoryPanelView) {
				void view.refresh(fileId);
			}
		}
	}

	private async saveCompletedOperation(operation: CompletedHistoryOperation) {
		const completedAt = new Date().toISOString();

		if (operation === "capture") {
			this.settings.lastCaptureAt = completedAt;
		} else if (operation === "reconcile") {
			this.settings.lastReconciliationAt = completedAt;
		} else if (operation === "restore") {
			this.settings.lastRestoreAt = completedAt;
		} else {
			this.settings.lastDatabaseResetAt = completedAt;
		}

		await this.saveSettings();
	}

	private updateStatus(status: HistoryStatus) {
		this.clearIdleStatusTimer();
		this.statusBarEl.empty();
		this.statusBarEl.addClass("myhistory-status");

		const view = createStatusView(status, this.settings);
		this.statusBarEl.setText(view.text);
		this.statusBarEl.title = view.title;
		this.statusBarEl.toggleClass("myhistory-status-error", status.state === "error");

		if (view.returnToIdle) {
			this.scheduleIdleStatus();
		}
	}

	private scheduleIdleStatus() {
		this.idleStatusTimer = window.setTimeout(() => {
			this.idleStatusTimer = null;
			this.updateStatus({ state: "idle" });
		}, IDLE_STATUS_DELAY_MS);
	}

	private clearIdleStatusTimer() {
		if (this.idleStatusTimer === null) {
			return;
		}

		window.clearTimeout(this.idleStatusTimer);
		this.idleStatusTimer = null;
	}

	private getPluginDir() {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}
}

function createLocalVaultId() {
	if (typeof crypto.randomUUID === "function") {
		const [shortId] = crypto.randomUUID().split("-");

		if (shortId) {
			return shortId;
		}
	}

	const randomPart = typeof crypto.getRandomValues === "function"
		? Array.from(
			crypto.getRandomValues(new Uint8Array(4)),
			(byte) => byte.toString(16).padStart(2, "0")
		).join("")
		: Math.random().toString(36).slice(2, 10);

	return `${Date.now().toString(36)}-${randomPart}`;
}

function createHistoryDatabaseName(localVaultId: string) {
	return `myhistory-${localVaultId}`;
}

function normalizeSavedSettings(data: unknown): Partial<MyHistorySettings> {
	if (!isRecord(data)) {
		return {};
	}

	const settings: Partial<MyHistorySettings> = {};

	for (const key of STRING_SETTING_KEYS) {
		const value = data[key];

		if (typeof value === "string") {
			settings[key] = value;
		}
	}

	if (isHistoryFolderMode(data.historyFolderMode)) {
		settings.historyFolderMode = data.historyFolderMode;
	}

	if (data.maxVersionsPerNote !== undefined) {
		settings.maxVersionsPerNote = normalizeMaxVersionsPerNote(data.maxVersionsPerNote);
	}

	if (data.captureDebounceSeconds !== undefined) {
		settings.captureDebounceSeconds =
			normalizeCaptureDebounceSeconds(data.captureDebounceSeconds);
	}

	if (typeof data.reconcileOnStartup === "boolean") {
		settings.reconcileOnStartup = data.reconcileOnStartup;
	}

	if (isLoggerLevel(data.logLevel)) {
		settings.logLevel = data.logLevel;
	}

	return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createStatusView(
	status: HistoryStatus,
	settings: MyHistorySettings
): HistoryStatusView {
	switch (status.state) {
		case "idle": {
			const lastCaptureAt = formatDateTime(settings.lastCaptureAt, { includeTime: true });

			return {
				text: lastCaptureAt ? lastCaptureAt : "...",
				title: lastCaptureAt
					? `MyHistory last captured a version at ${lastCaptureAt}`
					: "MyHistory has not captured a version yet"
			};
		}

		case "queued":
			return {
				text: `queued ${status.pending}`,
				title: `${status.pending} note(s) waiting to be captured`
			};

		case "capturing":
			return {
				text: `capturing ${status.current}/${status.total}`,
				title: `Captured ${status.captured}`
			};

		case "captured":
			return {
				text: status.captured > 0 ? "version captured" : "no changes",
				title: `Captured ${status.captured}, skipped ${status.skipped}`,
				returnToIdle: true
			};

		case "reconciling":
			return {
				text: `scanning ${calculatePercent(status.current, status.total)}%`,
				title: `Scanning note ${status.current} of ${status.total}`
			};

		case "reconciled":
			return {
				text: `scanned ${status.tracked}`,
				title: `Scanned ${status.tracked} note(s), captured ${status.captured}, recorded ${status.deleted} deletion(s)`,
				returnToIdle: true
			};

		case "restoring":
			return {
				text: "restoring",
				title: `Restoring ${status.path}`
			};

		case "restored":
			return {
				text: "restored",
				title: `Restored ${status.path}`,
				returnToIdle: true
			};

		case "pruning":
			return {
				text: "applying retention",
				title: "Removing versions above the retention limit"
			};

		case "pruned":
			return {
				text: `expired ${status.removed}`,
				title: `Removed ${status.removed} version(s)`,
				returnToIdle: true
			};

		case "resetting-database":
			return {
				text: "resetting history",
				title: "Deleting the local MyHistory database"
			};

		case "database-reset":
			return {
				text: "history reset",
				title: "The local MyHistory database was deleted and recreated",
				returnToIdle: true
			};

		case "error":
			return {
				text: "MyHistory error",
				title: status.message,
				returnToIdle: true
			};

		default:
			return assertNever(status);
	}
}

function calculatePercent(current: number, total: number) {
	return total > 0
		? Math.round((current / total) * 100)
		: 0;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled history status: ${JSON.stringify(value)}`);
}
