import { Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { NoteRecord, NoteVersionRecord } from "./history/types";
import { setDestructiveButton } from "./utils/button";
import { formatDateTime } from "./utils/date-format";
import { formatVersionEvent, formatVersionSize } from "./version-labels";

export class VersionPreviewModal extends Modal {
	private renderComponent = new Component();
	private restoring = false;
	private confirmingDelete = false;
	private deleting = false;

	constructor(
		app: App,
		private version: NoteVersionRecord,
		private note: NoteRecord | null,
		private restoreVersion: (versionId: string) => Promise<void>,
		private deleteVersion: (versionId: string) => Promise<boolean>,
		private confirmVersionDeletion: boolean,
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

		if (this.confirmingDelete) {
			this.contentEl.createEl("p", {
				cls: "myhistory-preview-delete-warning",
				text: "Permanently delete this stored version? The note itself is not changed, and this action cannot be undone."
			});
		}

		const actions = new Setting(this.contentEl);
		const busy = this.restoring || this.deleting;

		if (this.confirmingDelete) {
			actions.addButton((button) => button
				.setButtonText("Keep version")
				.setDisabled(busy)
				.onClick(() => {
					this.confirmingDelete = false;
					void this.render();
				}));
			actions.addButton((button) => {
				button.setButtonText(this.deleting ? "Deleting..." : "Delete permanently");
				setDestructiveButton(button)
					.setCta()
					.setDisabled(busy)
					.onClick(() => void this.runDelete());
			});
			return;
		}

		actions.addButton((button) => {
			button.setButtonText(this.deleting ? "Deleting..." : "Delete this version");
			setDestructiveButton(button)
				.setDisabled(busy)
				.onClick(() => {
					if (this.confirmVersionDeletion) {
						this.confirmingDelete = true;
						void this.render();
						return;
					}

					void this.runDelete();
				});
		});
		actions.addButton((button) => button
			.setButtonText(this.restoring ? "Restoring..." : "Restore this version")
			.setCta()
			.setDisabled(busy)
			.onClick(() => void this.runRestore()));
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(busy)
			.onClick(() => this.close()));
	}

	private getTargetPath() {
		return this.note?.path ?? this.version.path;
	}

	private async runRestore() {
		if (this.restoring || this.deleting) {
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

	private async runDelete() {
		if (
			(this.confirmVersionDeletion && !this.confirmingDelete)
			|| this.deleting
			|| this.restoring
		) {
			return;
		}

		this.deleting = true;
		await this.render();

		const succeeded = await this.deleteVersion(this.version._id);

		if (succeeded) {
			this.close();
			return;
		}

		this.deleting = false;
		this.confirmingDelete = false;
		await this.render();
	}
}
