import { Modal, Setting } from "obsidian";
import { setDestructiveButton } from "./utils/button";

export class LocalDatabaseResetModal extends Modal {
	private resetting = false;

	constructor(
		app: ConstructorParameters<typeof Modal>[0],
		private historyDatabaseName: string,
		private resetLocalDatabase: () => Promise<boolean>,
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
		this.titleEl.setText("Reset local database");

		this.contentEl.createEl("p", {
			text: "This permanently deletes every stored note version in this vault."
		});

		const databaseList = this.contentEl.createEl("ul", {
			cls: "myhistory-reset-database-list"
		});
		this.addDatabaseName(databaseList, "History database", this.historyDatabaseName);

		this.contentEl.createEl("p", {
			text: "Notes in the vault are not changed. Only the stored history is deleted.",
			cls: "myhistory-reset-scope-note"
		});
		this.contentEl.createEl("p", {
			text: "Versions, note records, path indexes, and pinned versions cannot be recovered. History starts again from the next capture.",
			cls: "myhistory-reset-warning"
		});

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button
			.setButtonText("Cancel")
			.setDisabled(this.resetting)
			.onClick(() => this.close()));
		actions.addButton((button) => {
			button.setButtonText(this.resetting ? "Resetting..." : "Reset local database");
			setDestructiveButton(button)
				.setCta()
				.setDisabled(this.resetting)
				.onClick(() => void this.runReset());
		});
	}

	private addDatabaseName(containerEl: HTMLElement, label: string, databaseName: string) {
		const itemEl = containerEl.createEl("li");
		itemEl.createSpan({ text: `${label}: ` });
		itemEl.createEl("code", { text: databaseName });
	}

	private async runReset() {
		if (this.resetting) {
			return;
		}

		this.resetting = true;
		this.render();

		const succeeded = await this.resetLocalDatabase();

		if (succeeded) {
			this.close();
			return;
		}

		this.resetting = false;
		this.render();
	}
}
