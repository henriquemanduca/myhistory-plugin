import { App, PluginSettingTab, SettingGroup } from "obsidian";
import type {
	Setting,
	SettingControl,
	SettingDefinition,
	SettingDefinitionGroup,
	SettingDefinitionItem
} from "obsidian";
import type MyHistoryPlugin from "./main";
import type { HistoryFolderMode } from "./history/note-files";
import { setDestructiveButton } from "./utils/button";
import { formatDateTime } from "./utils/date-format";
import type { LoggerLevel } from "./utils/logger";

export type { HistoryFolderMode };

export const MIN_CAPTURE_DEBOUNCE_SECONDS = 1;
export const MAX_CAPTURE_DEBOUNCE_SECONDS = 600;
export const MAX_VERSIONS_PER_NOTE_LIMIT = 5000;

export interface MyHistorySettings {
	localVaultId: string;
	historyFolderMode: HistoryFolderMode;
	customHistoryFolder: string;
	maxVersionsPerNote: number;
	captureDebounceSeconds: number;
	reconcileOnStartup: boolean;
	logLevel: LoggerLevel;
	lastCaptureAt: string;
	lastReconciliationAt: string;
	lastRestoreAt: string;
	lastDatabaseResetAt: string;
}

export const DEFAULT_SETTINGS: MyHistorySettings = {
	localVaultId: "",
	historyFolderMode: "vault-root",
	customHistoryFolder: "",
	maxVersionsPerNote: 50,
	captureDebounceSeconds: 15,
	reconcileOnStartup: true,
	logLevel: "info",
	lastCaptureAt: "",
	lastReconciliationAt: "",
	lastRestoreAt: "",
	lastDatabaseResetAt: ""
};

type ReadonlyDateSettingKey =
	| "lastCaptureAt"
	| "lastReconciliationAt"
	| "lastRestoreAt"
	| "lastDatabaseResetAt";

export function isHistoryFolderMode(value: unknown): value is HistoryFolderMode {
	return value === "vault-root" || value === "custom";
}

export function normalizeMaxVersionsPerNote(value: unknown) {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 0;
	}

	return Math.min(Math.trunc(parsed), MAX_VERSIONS_PER_NOTE_LIMIT);
}

export function normalizeCaptureDebounceSeconds(value: unknown) {
	const parsed = Number(value);

	if (!Number.isFinite(parsed)) {
		return DEFAULT_SETTINGS.captureDebounceSeconds;
	}

	return Math.min(
		Math.max(Math.trunc(parsed), MIN_CAPTURE_DEBOUNCE_SECONDS),
		MAX_CAPTURE_DEBOUNCE_SECONDS
	);
}

/**
 * Settings are declared once in {@link getSettingDefinitions}. Obsidian 1.13
 * and newer render them natively; {@link display} renders the same definitions
 * imperatively so the plugin still works on the declared `minAppVersion`.
 */
export class MyHistorySettingTab extends PluginSettingTab {
	plugin: MyHistoryPlugin;

	constructor(app: App, plugin: MyHistoryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "History",
				cls: "myhistory-settings-section",
				items: [
					{
						name: "Tracked folder",
						desc: `Choose which notes get a history. Current vault: ${this.app.vault.getName()}.`,
						control: {
							type: "dropdown",
							key: "historyFolderMode",
							options: {
								"vault-root": "Every note in the vault",
								custom: "Notes inside one folder"
							}
						}
					},
					{
						name: "Tracked folder path",
						desc: "Folder inside the vault whose Markdown notes get a history.",
						control: {
							type: "folder",
							key: "customHistoryFolder",
							placeholder: "Projects",
							includeRoot: false,
							disabled: () => this.plugin.settings.historyFolderMode !== "custom"
						}
					},
					{
						name: "Versions per note",
						desc: "Oldest versions are removed once a note passes this limit. Use 0 to keep every version. Pinned versions never expire.",
						control: {
							type: "number",
							key: "maxVersionsPerNote",
							min: 0,
							max: MAX_VERSIONS_PER_NOTE_LIMIT,
							step: 1,
							placeholder: String(DEFAULT_SETTINGS.maxVersionsPerNote)
						}
					},
					{
						name: "Capture delay",
						desc: "Seconds of inactivity before an edited note is captured. A note edited without pause is captured anyway after four times this delay.",
						control: {
							type: "number",
							key: "captureDebounceSeconds",
							min: MIN_CAPTURE_DEBOUNCE_SECONDS,
							max: MAX_CAPTURE_DEBOUNCE_SECONDS,
							step: 1,
							placeholder: String(DEFAULT_SETTINGS.captureDebounceSeconds)
						}
					},
					{
						name: "Scan notes on startup",
						desc: "Compare every tracked note with its history when Obsidian loads the plugin, capturing what changed while it was closed.",
						control: {
							type: "toggle",
							key: "reconcileOnStartup"
						}
					},
					{
						name: "Log level",
						desc: "Minimum level written to myhistory.log. Errors also go to the developer console.",
						control: {
							type: "dropdown",
							key: "logLevel",
							options: {
								debug: "Debug",
								log: "Log",
								info: "Info",
								warn: "Warnings",
								error: "Errors",
								off: "Off"
							}
						}
					}
				]
			},
			{
				type: "group",
				heading: "Local data",
				cls: "myhistory-settings-section",
				items: [
					{
						name: "Local history database",
						desc: "Automatically created database that stores this vault's versions.",
						render: (setting) => {
							setting.addText((text) => {
								text.inputEl.readOnly = true;
								text.inputEl.addClass("myhistory-readonly-setting");
								text.setValue(this.plugin.getHistoryDatabaseName());
							});
						}
					},
					this.createReadonlyDateSetting(
						"Last captured version",
						"Last time a note version was stored.",
						"lastCaptureAt"
					),
					this.createReadonlyDateSetting(
						"Last vault scan",
						"Last successful comparison between tracked notes and their history.",
						"lastReconciliationAt"
					),
					this.createReadonlyDateSetting(
						"Last restore",
						"Last time a stored version was written back to the vault.",
						"lastRestoreAt"
					),
					this.createReadonlyDateSetting(
						"Last database reset",
						"Last time the local history database was deleted and recreated.",
						"lastDatabaseResetAt"
					),
					{
						name: "Apply retention now",
						desc: "Remove versions above the current limit from every note. Pinned versions are kept.",
						render: (setting) => {
							setting.addButton((button) => button
								.setButtonText("Apply retention")
								.onClick(() => void this.plugin.applyRetention()));
						}
					},
					{
						name: "Reset local database",
						desc: "Delete every stored version, note record, and path index for this vault. Notes in the vault are not changed.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Reset local database");
								setDestructiveButton(button)
									.onClick(() => this.plugin.openLocalDatabaseResetModal());
							});
						}
					}
				]
			}
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof MyHistorySettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "historyFolderMode": {
				if (!isHistoryFolderMode(value)) {
					return;
				}

				this.plugin.settings.historyFolderMode = value;
				await this.plugin.saveSettings();
				this.refreshRenderedState();
				return;
			}
			case "customHistoryFolder":
				this.plugin.settings.customHistoryFolder = String(value).trim();
				break;
			case "maxVersionsPerNote":
				this.plugin.settings.maxVersionsPerNote = normalizeMaxVersionsPerNote(value);
				break;
			case "captureDebounceSeconds":
				this.plugin.settings.captureDebounceSeconds =
					normalizeCaptureDebounceSeconds(value);
				break;
			case "reconcileOnStartup":
				this.plugin.settings.reconcileOnStartup = value === true;
				break;
			case "logLevel":
				this.plugin.updateLogLevel(value);
				break;
			default:
				return;
		}

		await this.plugin.saveSettings();
	}

	/**
	 * Fallback rendering for Obsidian versions older than 1.13.0, which ignore
	 * {@link getSettingDefinitions} and call this instead.
	 */
	display(): void {
		this.containerEl.empty();
		let looseGroup: SettingGroup | null = null;

		for (const definition of this.getSettingDefinitions()) {
			if (isSettingDefinitionGroup(definition)) {
				looseGroup = null;
				this.renderGroupFallback(definition);
				continue;
			}

			if (!isSettingDefinition(definition)) {
				continue;
			}

			looseGroup ??= new SettingGroup(this.containerEl)
				.addClass("myhistory-settings-section");
			this.renderSettingFallback(looseGroup, definition);
		}
	}

	private renderGroupFallback(group: SettingDefinitionGroup) {
		if (!isVisible(group.visible)) {
			return;
		}

		const settingGroup = new SettingGroup(this.containerEl)
			.addClass(group.cls ?? "myhistory-settings-section");

		if (group.heading) {
			settingGroup.setHeading(group.heading);
		}

		for (const item of group.items ?? []) {
			if (isSettingDefinition(item)) {
				this.renderSettingFallback(settingGroup, item);
			}
		}
	}

	private renderSettingFallback(group: SettingGroup, definition: SettingDefinition) {
		if (!isVisible(definition.visible)) {
			return;
		}

		group.addSetting((setting) => {
			setting.setName(definition.name);

			if (definition.desc) {
				setting.setDesc(definition.desc);
			}

			if (definition.render) {
				definition.render(setting, group);
				return;
			}

			if (definition.action) {
				const action = definition.action;
				setting.addButton((button) => button
					.setButtonText(definition.name)
					.setDisabled(isDisabled(definition.disabled))
					.onClick(() => action(setting.settingEl, 0)));
				return;
			}

			if (definition.control) {
				this.renderControlFallback(setting, definition.control);
			}
		});
	}

	private renderControlFallback(setting: Setting, control: SettingControl) {
		const disabled = isDisabled(control.disabled);
		const currentValue = this.getControlValue(control.key);

		switch (control.type) {
			case "dropdown":
				setting.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(control.options)) {
						dropdown.addOption(value, label);
					}

					dropdown
						.setValue(String(currentValue ?? control.defaultValue ?? ""))
						.setDisabled(disabled)
						.onChange((value) => void this.setControlValue(control.key, value));
				});
				return;

			case "toggle":
				setting.addToggle((toggle) => toggle
					.setValue(currentValue === true)
					.setDisabled(disabled)
					.onChange((value) => void this.setControlValue(control.key, value)));
				return;

			case "number":
				setting.addText((text) => {
					text.inputEl.type = "number";
					text.inputEl.min = String(control.min ?? "");
					text.inputEl.max = String(control.max ?? "");
					text
						.setPlaceholder(control.placeholder ?? "")
						.setValue(String(currentValue ?? ""))
						.setDisabled(disabled)
						.onChange((value) => void this.setControlValue(control.key, value));
				});
				return;

			case "text":
			case "folder":
			case "file":
				setting.addText((text) => text
					.setPlaceholder(control.placeholder ?? "")
					.setValue(String(currentValue ?? ""))
					.setDisabled(disabled)
					.onChange((value) => void this.setControlValue(control.key, value)));
				return;

			default:
				return;
		}
	}

	private refreshRenderedState() {
		const refreshDomState: unknown = Reflect.get(this, "refreshDomState");

		if (typeof refreshDomState === "function") {
			refreshDomState.call(this);
			return;
		}

		this.display();
	}

	private createReadonlyDateSetting(
		name: string,
		desc: string,
		key: ReadonlyDateSettingKey
	): SettingDefinition {
		return {
			name,
			desc,
			render: (setting) => {
				const value = this.plugin.settings[key];

				setting.addText((text) => {
					text.inputEl.readOnly = true;
					text.inputEl.addClass("myhistory-readonly-setting");
					text.setValue(formatDateTime(value, {
						fallback: "Never",
						invalidFallback: value
					}));
				});
			}
		};
	}
}

function isSettingDefinitionGroup(
	definition: SettingDefinitionItem
): definition is SettingDefinitionGroup {
	return "type" in definition
		&& (definition.type === "group" || definition.type === "list");
}

function isSettingDefinition(
	definition: SettingDefinitionItem
): definition is SettingDefinition {
	return !("type" in definition) && "name" in definition;
}

function isVisible(predicate: boolean | (() => boolean) | undefined) {
	if (predicate === undefined) {
		return true;
	}

	return typeof predicate === "function" ? predicate() : predicate;
}

function isDisabled(predicate: boolean | (() => boolean) | undefined) {
	if (predicate === undefined) {
		return false;
	}

	return typeof predicate === "function" ? predicate() : predicate;
}
