import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { setDestructiveButton } from "./utils/button";

export class NoteHistoryResetModal extends Modal {
	private resetting = false;

	constructor(
		app: App,
		private notePath: string,
		private resetNoteHistory: () => Promise<boolean>,
		private onClosed: () => void
	) {
		super(app);
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
		this.onClosed();
	}

	private render() {
		this.contentEl.empty();
		this.titleEl.setText("Reset note history");

		this.contentEl.createEl("p", {
			text: "This permanently deletes every stored version of this note."
		});
		this.contentEl.createEl("p", {
			text: this.notePath,
			cls: "myhistory-reset-note-path"
		});
		this.contentEl.createEl("p", {
			text: "The note itself is not changed. Its current content is stored immediately as the first version of a new history.",
			cls: "myhistory-reset-scope-note"
		});
		this.contentEl.createEl("p", {
			text: "This action cannot be undone. Previous versions, pinned versions, and rename history cannot be recovered.",
			cls: "myhistory-reset-warning"
		});

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(this.resetting)
			.onClick(() => this.close()));
		actions.addButton((button) => {
			button.setButtonText(this.resetting ? "Resetting..." : "Reset note history");
			setDestructiveButton(button)
				.setCta()
				.setDisabled(this.resetting)
				.onClick(() => void this.runReset());
		});
	}

	private async runReset() {
		if (this.resetting) {
			return;
		}

		this.resetting = true;
		this.render();

		const succeeded = await this.resetNoteHistory();

		if (succeeded) {
			this.close();
			return;
		}

		this.resetting = false;
		this.render();
	}
}
