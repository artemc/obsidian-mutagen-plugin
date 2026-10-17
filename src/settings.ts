// Plugin settings and their tab.
import { App, PluginSettingTab, Setting } from "obsidian";
import type MutagenSyncPlugin from "./main";

export interface MutagenSettings {
	mutagenPath: string;
	configFile: string;
	useMonitor: boolean;
	configTemplate: string;
	debugLog: boolean;
	onClose: CloseAction;
	terminalCommand: string;
}

export type CloseAction = "ask" | "pause" | "nothing";

const INDENT = "  ";

export const DEFAULT_SETTINGS: MutagenSettings = {
	mutagenPath: "mutagen",
	configFile: "mutagen.yml",
	useMonitor: true,
	debugLog: false,
	onClose: "ask",
	terminalCommand: "",
	configTemplate: [
		"sync:",
		"  defaults:",
		"    mode: \"two-way-resolved\"",
		"    ignore:",
		"      vcs: true",
		"      paths:",
		"        - \".obsidian/workspace*.json\"",
		"  vault:",
		"    alpha: \".\"",
		"    beta: \"user@host:/path/to/vault\"",
		"",
	].join("\n"),
};

// YAML forbids tabs in indentation: leading tabs become spaces when the config is created.
export function normalizeYamlIndent(text: string): string {
	return text.replace(/^\t+/gm, (tabs) => INDENT.repeat(tabs.length));
}

// Tab indents and Shift+Tab outdents the current lines instead of moving focus out of the field.
function handleIndentKeys(el: HTMLTextAreaElement, evt: KeyboardEvent, onChange: () => void) {
	if (evt.key !== "Tab" || evt.ctrlKey || evt.altKey || evt.metaKey) return;
	evt.preventDefault();
	const { value, selectionStart: start, selectionEnd: end } = el;
	const lineStart = value.lastIndexOf("\n", start - 1) + 1;

	if (!evt.shiftKey && start === end) {
		el.setRangeText(INDENT, start, end, "end");
	} else {
		const block = value.slice(lineStart, end);
		const lines = block.split("\n");
		const changed = evt.shiftKey
			? lines.map((l) => (l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^ /, "")))
			: lines.map((l) => INDENT + l);
		const replaced = changed.join("\n");
		el.setRangeText(replaced, lineStart, end, "preserve");
		el.selectionStart = Math.max(lineStart, start + (changed[0].length - lines[0].length));
		el.selectionEnd = lineStart + replaced.length;
	}
	onChange();
}


export class MutagenSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MutagenSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Mutagen path")
			.setDesc("Command name in PATH or absolute path to the binary.")
			.addText((t) =>
				t.setValue(this.plugin.settings.mutagenPath).onChange(async (v) => {
					this.plugin.settings.mutagenPath = v.trim() || DEFAULT_SETTINGS.mutagenPath;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Project file")
			.setDesc("Mutagen project config in the vault root.")
			.addText((t) =>
				t.setValue(this.plugin.settings.configFile).onChange(async (v) => {
					this.plugin.settings.configFile = v.trim() || DEFAULT_SETTINGS.configFile;
					await this.plugin.saveSettings();
				})
			);

		const template = new Setting(containerEl)
			.setName("Config template")
			.setDesc("Content of the project file created from the menu when no config exists. Tab indents (2 spaces), Shift+Tab outdents.")
			.addTextArea((t) => {
				const save = async () => {
					this.plugin.settings.configTemplate = t.getValue();
					await this.plugin.saveData(this.plugin.settings);
				};
				t.setValue(this.plugin.settings.configTemplate).onChange(save);
				t.inputEl.spellcheck = false;
				t.inputEl.addEventListener("keydown", (evt) => handleIndentKeys(t.inputEl, evt, save));
			})
			.addExtraButton((b) =>
				b.setIcon("rotate-ccw").setTooltip("Restore default template").onClick(async () => {
					this.plugin.settings.configTemplate = DEFAULT_SETTINGS.configTemplate;
					await this.plugin.saveData(this.plugin.settings);
					this.display();
				})
			);
		template.settingEl.addClass("mutagen-template-setting");

		new Setting(containerEl)
			.setName("Watch status in background")
			.setDesc("One `mutagen sync monitor` process: status updates instantly, no polling. When off, status refreshes when the menu opens and after commands.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.useMonitor).onChange(async (v) => {
					this.plugin.settings.useMonitor = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("When closing the vault while syncing")
			.setDesc("Ask whether to pause the Mutagen project, pause it without asking, or leave it running.")
			.addDropdown((d) =>
				d
					.addOptions({ ask: "Ask", pause: "Pause without asking", nothing: "Keep syncing" })
					.setValue(this.plugin.settings.onClose)
					.onChange(async (v) => {
						this.plugin.settings.onClose = v as CloseAction;
						await this.plugin.saveData(this.plugin.settings);
					})
			);

		new Setting(containerEl)
			.setName("Terminal command")
			.setDesc("Used by \"Start in terminal\", where SSH can ask for a password. Empty: Terminal on macOS, x-terminal-emulator on Linux, cmd on Windows. {command} is replaced with the quoted shell command, e.g. `gnome-terminal -- sh -c {command}` or `kitty sh -c {command}`.")
			.addText((t) =>
				t.setPlaceholder("default").setValue(this.plugin.settings.terminalCommand).onChange(async (v) => {
					this.plugin.settings.terminalCommand = v;
					await this.plugin.saveData(this.plugin.settings);
				})
			);

		new Setting(containerEl)
			.setName("Debug log")
			.setDesc(`Write mutagen calls and state changes to ${this.plugin.logger.file} and the developer console.`)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.debugLog).onChange(async (v) => {
					this.plugin.settings.debugLog = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
