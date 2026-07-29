import { ItemView, setIcon, setTooltip, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { HistoryService, NoteTimeline } from "./history/history-service";
import type { NoteRecord, NoteVersionRecord } from "./history/types";
import { formatDateTime } from "./utils/date-format";
import { formatVersionEvent, formatVersionSize } from "./version-labels";

export const HISTORY_VIEW_TYPE = "myhistory-timeline";

export interface HistoryPanelHandlers {
	getMaxVersionsPerNote: () => number;
	openVersion: (version: NoteVersionRecord, note: NoteRecord | null) => void;
	captureActiveNote: () => Promise<void>;
	toggleVersionProtection: (versionId: string, isProtected: boolean) => Promise<void>;
}

/**
 * Sidebar timeline for the active note. Versions are opened in a preview modal
 * instead of being rendered inline, so the panel stays compact.
 */
export class HistoryPanelView extends ItemView {
	private activePath: string | null = null;
	private timeline: NoteTimeline | null = null;
	private loading = false;

	constructor(
		leaf: WorkspaceLeaf,
		private service: HistoryService,
		private handlers: HistoryPanelHandlers
	) {
		super(leaf);
	}

	getViewType() {
		return HISTORY_VIEW_TYPE;
	}

	getDisplayText() {
		return "Note history";
	}

	getIcon() {
		return "history";
	}

	async onOpen() {
		this.contentEl.addClass("myhistory-panel");
		this.registerEvent(
			this.app.workspace.on("file-open", () => void this.showActiveNote())
		);
		await this.showActiveNote();
	}

	async onClose() {
		this.contentEl.empty();
	}

	/** Reloads the timeline when the shown note changed. */
	async refresh(fileId: string | null) {
		if (fileId !== null && this.timeline && this.timeline.note.fileId !== fileId) {
			return;
		}

		await this.showActiveNote();
	}

	private async showActiveNote() {
		const activeFile = this.app.workspace.getActiveFile();
		this.activePath = activeFile instanceof TFile ? activeFile.path : null;

		if (!this.activePath) {
			this.timeline = null;
			this.render();
			return;
		}

		this.loading = true;
		this.render();

		try {
			this.timeline = await this.service.getTimelineForPath(this.activePath);
		} finally {
			this.loading = false;
		}

		this.render();
	}

	private render() {
		this.contentEl.empty();
		this.renderHeader();

		if (this.loading) {
			this.renderMessage("Loading history...");
			return;
		}

		if (!this.activePath) {
			this.renderMessage("Open a note to see its history.");
			return;
		}

		if (!this.timeline) {
			this.renderMessage(
				"This note has no stored history yet. It is captured after the next edit, or now with the button below."
			);
			this.renderFooter();
			return;
		}

		if (this.timeline.versions.length === 0) {
			this.renderMessage("Every stored version of this note has expired.");
			this.renderFooter();
			return;
		}

		this.renderVersions(this.timeline);
		this.renderFooter();
	}

	private renderHeader() {
		const headerEl = this.contentEl.createDiv({ cls: "myhistory-panel-header" });
		const note = this.timeline?.note;
		const title = note?.fileName
			?? (this.activePath ? this.activePath.slice(this.activePath.lastIndexOf("/") + 1) : "No note open");

		headerEl.createDiv({
			cls: "myhistory-panel-title",
			text: title
		});

		if (this.activePath) {
			headerEl.createDiv({
				cls: "myhistory-panel-path",
				text: this.activePath
			});
		}

		if (!note) {
			return;
		}

		const maxVersionsPerNote = this.handlers.getMaxVersionsPerNote();
		const versionCount = this.timeline?.versions.length ?? 0;
		const limitLabel = maxVersionsPerNote > 0
			? ` · limit ${maxVersionsPerNote}`
			: " · no limit";

		headerEl.createDiv({
			cls: "myhistory-panel-summary",
			text: `${versionCount} ${versionCount === 1 ? "version" : "versions"}${limitLabel}`
		});

		if (note.deleted) {
			headerEl.createDiv({
				cls: "myhistory-panel-badge",
				text: `Deleted ${formatDateTime(note.deletedAt ?? "")}`.trim()
			});
		}

		this.renderRenameSummary(headerEl, note);
	}

	private renderRenameSummary(headerEl: HTMLElement, note: NoteRecord) {
		const lastChange = note.pathHistory[note.pathHistory.length - 1];

		if (!lastChange) {
			return;
		}

		const renameCount = note.pathHistory.length;
		const summaryEl = headerEl.createDiv({ cls: "myhistory-panel-renames" });
		summaryEl.setText(
			renameCount === 1
				? `Renamed once · was ${lastChange.previousPath}`
				: `Renamed ${renameCount} times · was ${lastChange.previousPath}`
		);
		setTooltip(summaryEl, note.pathHistory
			.map((change) => `${formatDateTime(change.changedAt)}: ${change.previousPath} → ${change.path}`)
			.join("\n"));
	}

	private renderVersions(timeline: NoteTimeline) {
		const listEl = this.contentEl.createDiv({ cls: "myhistory-version-list" });

		for (const version of timeline.versions) {
			this.renderVersionRow(listEl, timeline.note, version);
		}
	}

	private renderVersionRow(
		listEl: HTMLElement,
		note: NoteRecord,
		version: NoteVersionRecord
	) {
		const rowEl = listEl.createDiv({ cls: "myhistory-version-row" });

		if (version._id === note.latestVersionId) {
			rowEl.addClass("myhistory-version-row-current");
		}

		const openEl = rowEl.createDiv({
			cls: "myhistory-version-open",
			attr: { role: "button", tabindex: "0" }
		});
		openEl.createSpan({
			cls: "myhistory-version-date",
			text: formatDateTime(version.capturedAt)
		});
		openEl.createSpan({
			cls: `myhistory-version-event myhistory-version-event-${version.event}`,
			text: formatVersionEvent(version.event)
		});
		openEl.createSpan({
			cls: "myhistory-version-size",
			text: formatVersionSize(version.size)
		});
		setTooltip(openEl, "Open this version");

		const openVersion = () => this.handlers.openVersion(version, note);
		openEl.addEventListener("click", openVersion);
		openEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openVersion();
			}
		});

		const isProtected = version.protected === true;
		const pinEl = rowEl.createDiv({
			cls: "myhistory-version-pin",
			attr: { role: "button", tabindex: "0" }
		});
		pinEl.toggleClass("myhistory-version-pinned", isProtected);
		setIcon(pinEl, isProtected ? "pin" : "pin-off");
		setTooltip(pinEl, isProtected
			? "Pinned: kept when older versions expire"
			: "Pin so retention keeps this version");
		pinEl.addEventListener("click", () => {
			void this.handlers.toggleVersionProtection(version._id, !isProtected);
		});
	}

	private renderFooter() {
		const footerEl = this.contentEl.createDiv({ cls: "myhistory-panel-footer" });
		const buttonEl = footerEl.createEl("button", { text: "Capture version now" });
		buttonEl.addEventListener("click", () => {
			void this.handlers.captureActiveNote();
		});
	}

	private renderMessage(text: string) {
		this.contentEl.createDiv({ cls: "myhistory-panel-message", text });
	}
}
