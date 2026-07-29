import { Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { NoteRecord, NoteVersionRecord } from "./history/types";
import { formatDateTime } from "./utils/date-format";
import { formatVersionEvent, formatVersionSize } from "./version-labels";

export class VersionPreviewModal extends Modal {
	private renderComponent = new Component();
	private restoring = false;

	constructor(
		app: App,
		private version: NoteVersionRecord,
		private note: NoteRecord | null,
		private restoreVersion: (versionId: string) => Promise<void>,
		private onClosed: () => void
	) {
		super(app);
	}

	onOpen() {
		this.renderComponent.load();
		this.modalEl.addClass("myhistory-preview-modal");
		void this.render();
	}

	onClose() {
		this.renderComponent.unload();
		this.contentEl.empty();
		this.onClosed();
	}

	private async render() {
		this.contentEl.empty();
		this.titleEl.setText(
			`${formatDateTime(this.version.capturedAt)} · ${formatVersionEvent(this.version.event)}`
		);

		const metaEl = this.contentEl.createDiv({ cls: "myhistory-preview-meta" });
		metaEl.createSpan({ text: this.version.path });
		metaEl.createSpan({
			cls: "myhistory-preview-size",
			text: formatVersionSize(this.version.size)
		});

		const targetPath = this.getTargetPath();

		if (targetPath !== this.version.path) {
			this.contentEl.createEl("p", {
				cls: "myhistory-preview-note",
				text: `This note is now at ${targetPath}. Restoring writes there.`
			});
		}

		const contentEl = this.contentEl.createDiv({ cls: "myhistory-preview-content" });

		if (this.version.content.length === 0) {
			contentEl.createEl("p", {
				cls: "myhistory-preview-empty",
				text: "This version is empty."
			});
		} else {
			await MarkdownRenderer.render(
				this.app,
				this.version.content,
				contentEl,
				targetPath,
				this.renderComponent
			);
		}

		this.contentEl.createEl("p", {
			cls: "myhistory-preview-note",
			text: this.note?.deleted
				? "Restoring recreates the note and keeps every stored version."
				: "The current content is stored as a new version before it is replaced."
		});

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(this.restoring)
			.onClick(() => this.close()));
		actions.addButton((button) => button
			.setButtonText(this.restoring ? "Restoring..." : "Restore this version")
			.setCta()
			.setDisabled(this.restoring)
			.onClick(() => void this.runRestore()));
	}

	private getTargetPath() {
		return this.note?.path ?? this.version.path;
	}

	private async runRestore() {
		if (this.restoring) {
			return;
		}

		this.restoring = true;
		await this.render();

		try {
			await this.restoreVersion(this.version._id);
			this.close();
		} finally {
			this.restoring = false;
		}
	}
}
