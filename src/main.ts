// Entry point: status bar dot, menu and mutagen project state tracking.
import { App, FileSystemAdapter, Menu, Modal, Notice, Plugin, TAbstractFile } from "obsidian";
import type { ChildProcess } from "child_process";
import { join } from "path";
import { Logger } from "./logger";
import { MutagenCli, SyncSession } from "./mutagen";
import { DEFAULT_SETTINGS, normalizeYamlIndent, MutagenSettings, MutagenSettingTab } from "./settings";
import { ProjectState, STATE_LABEL, sessionSummary, stateFromSessions } from "./state";

const PRIMARY_ACTION: Partial<Record<ProjectState, { title: string; icon: string; command: "start" | "pause" | "resume" }>> = {
	stopped: { title: "Start", icon: "play", command: "start" },
	paused: { title: "Resume", icon: "play", command: "resume" },
	running: { title: "Pause", icon: "pause", command: "pause" },
	error: { title: "Pause", icon: "pause", command: "pause" },
};

const MONITOR_BACKOFF_MIN_MS = 5_000;
const MONITOR_BACKOFF_MAX_MS = 300_000;

export default class MutagenSyncPlugin extends Plugin {
	settings: MutagenSettings = DEFAULT_SETTINGS;
	logger!: Logger;
	private cli!: MutagenCli;
	private statusEl!: HTMLElement;
	private state: ProjectState = "stopped";
	private projectId: string | null = null;
	private sessions: SyncSession[] = [];

	private monitor: ChildProcess | null = null;
	private monitorId: string | null = null;
	private monitorBackoff = MONITOR_BACKOFF_MIN_MS;
	private monitorRetry: number | null = null;

	private refreshChain: Promise<void> = Promise.resolve();
	private allowClose = false;

	async onload() {
		await this.loadSettings();
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		const base = adapter.getBasePath();
		this.logger = new Logger(join(base, this.manifest.dir ?? "", "debug.log"));
		this.logger.enabled = this.settings.debugLog;
		this.logger.log("load", this.manifest.version, "vault", base, "platform", process.platform, "PATH", process.env.PATH ?? "");
		this.cli = new MutagenCli(() => this.settings.mutagenPath, base, this.logger);

		this.addSettingTab(new MutagenSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mutagen-status");
		this.statusEl.createDiv({ cls: "mutagen-status-dot" });
		this.registerDomEvent(this.statusEl, "click", (evt) => this.openMenu(evt));

		const onFileEvent = (file: TAbstractFile, oldPath?: string) => {
			if (this.isProjectPath(file.path) || (oldPath && this.isProjectPath(oldPath))) {
				this.logger.log("vault event", file.path, oldPath ?? "");
				this.refresh();
			}
		};
		this.registerEvent(this.app.vault.on("create", (f) => onFileEvent(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFileEvent(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => onFileEvent(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFileEvent(f, old)));

		this.registerDomEvent(window, "beforeunload", (evt) => this.onBeforeUnload(evt));

		this.app.workspace.onLayoutReady(() => {
			this.placeNextToSyncIcon();
			this.refresh();
		});
	}

	onunload() {
		this.stopMonitor();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.logger.enabled = this.settings.debugLog;
		this.stopMonitor();
		this.refresh();
	}

	private get lockFile(): string {
		return this.settings.configFile + ".lock";
	}

	private isProjectPath(path: string): boolean {
		return path === this.settings.configFile || path === this.lockFile;
	}

	// Put the dot right after the built-in Obsidian Sync icon, if present.
	private placeNextToSyncIcon() {
		const syncEl = this.statusEl.parentElement?.querySelector(".status-bar-item.plugin-sync");
		if (syncEl) syncEl.insertAdjacentElement("afterend", this.statusEl);
	}

	// Refreshes run strictly one after another so they never race.
	refresh(): Promise<void> {
		this.refreshChain = this.refreshChain.then(() => this.doRefresh()).catch((e) => console.error("mutagen-sync", e));
		return this.refreshChain;
	}

	private async doRefresh() {
		const adapter = this.app.vault.adapter;
		const configExists = await adapter.exists(this.settings.configFile);
		const lockExists = await adapter.exists(this.lockFile);
		this.logger.log("refresh: config", this.settings.configFile, configExists, "lock", this.lockFile, lockExists);
		if (!configExists) {
			this.projectId = null;
			this.stopMonitor();
			this.setState("noconfig");
			return;
		}

		// `mutagen project start` writes the project id to the lock file, `terminate` removes it.
		const id = lockExists ? (await adapter.read(this.lockFile)).trim() : "";
		this.logger.log("refresh: project id", JSON.stringify(id));
		if (!id) {
			this.projectId = null;
			this.stopMonitor();
			this.setState("stopped");
			return;
		}
		this.projectId = id;

		const sessions = await this.cli.sessions(id);
		this.sessions = sessions ?? [];
		this.logger.log("refresh: sessions", sessions ? sessions.length : "null (cli failed)");
		this.setState(sessions ? stateFromSessions(sessions) : "unavailable");

		if (this.settings.useMonitor && sessions && this.monitorId !== id) this.startMonitor(id);
	}

	private setState(state: ProjectState) {
		if (state !== this.state) this.logger.log("state", this.state, "->", state);
		this.state = state;
		this.statusEl.dataset.state = state;
		this.statusEl.setAttr("aria-label", `Mutagen: ${STATE_LABEL[state]}`);
		this.statusEl.setAttr("data-tooltip-position", "top");
	}

	private startMonitor(id: string) {
		this.stopMonitor();
		this.monitorId = id;
		let exited = false;
		const child = this.cli.monitor(
			id,
			(sessions: SyncSession[]) => {
				this.monitorBackoff = MONITOR_BACKOFF_MIN_MS;
				if (this.projectId !== id) return;
				this.sessions = sessions;
				this.setState(stateFromSessions(sessions));
			},
			() => {
				if (exited) return;
				exited = true;
				if (this.monitor !== child) return; // stopped by us
				this.monitor = null;
				this.monitorId = null;
				this.monitorRetry = window.setTimeout(() => {
					this.monitorRetry = null;
					this.refresh();
				}, this.monitorBackoff);
				this.monitorBackoff = Math.min(this.monitorBackoff * 2, MONITOR_BACKOFF_MAX_MS);
			}
		);
		this.monitor = child;
	}

	private stopMonitor() {
		if (this.monitorRetry !== null) {
			window.clearTimeout(this.monitorRetry);
			this.monitorRetry = null;
		}
		const child = this.monitor;
		this.monitor = null;
		this.monitorId = null;
		child?.kill();
	}

	private async openMenu(evt: MouseEvent) {
		await this.refresh();
		if (this.state === "noconfig") return this.openNoConfigMenu(evt);

		const menu = new Menu();
		menu.addItem((item) => item.setTitle(STATE_LABEL[this.state]).setDisabled(true));
		if (this.state !== "stopped" && this.state !== "unavailable") {
			for (const session of this.sessions) {
				menu.addItem((item) => item.setTitle(sessionSummary(session)).setDisabled(true));
			}
		}
		menu.addItem((item) => item.setTitle("Details…").setIcon("info").onClick(() => this.showProjectList()));

		// One action that makes sense in the current state.
		const action = PRIMARY_ACTION[this.state];
		if (action) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle(action.title).setIcon(action.icon).onClick(() => this.runProject(action.command))
			);
		}
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Plugin settings…").setIcon("settings").onClick(() => this.openSettings()));

		menu.showAtMouseEvent(evt);
	}

	// Full `mutagen project list` output goes to a modal; it does not fit in a menu.
	private async showProjectList() {
		const list = await this.cli.projectCommand("list", this.settings.configFile);
		const text = (list.ok ? list.stdout : list.stderr).trim() || STATE_LABEL[this.state];
		new ProjectListModal(this.app, text).open();
	}

	private openNoConfigMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle(STATE_LABEL[this.state]).setDisabled(true));
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle(`Create ${this.settings.configFile}`).setIcon("file-plus").onClick(() => this.createConfig())
		);
		menu.addSeparator();
		menu.addItem((item) => item.setTitle("Plugin settings…").setIcon("settings").onClick(() => this.openSettings()));
		menu.showAtMouseEvent(evt);
	}

	// Create the config in the vault root from the template in settings.
	private async createConfig() {
		const adapter = this.app.vault.adapter;
		const path = this.settings.configFile;
		if (await adapter.exists(path)) {
			new Notice(`${path} already exists`);
		} else {
			await adapter.write(path, normalizeYamlIndent(this.settings.configTemplate));
			new Notice(`Created ${path}`);
		}
		await this.refresh();
	}


	private async runProject(command: "start" | "pause" | "resume") {
		const notice = new Notice(`mutagen project ${command}…`, 0);
		const res = await this.cli.projectCommand(command, this.settings.configFile);
		this.logger.log("project", command, res.ok ? "ok" : "failed");
		notice.hide();
		if (!res.ok) new Notice(`mutagen project ${command} failed\n${res.stderr.trim()}`, 10_000);
		await this.refresh();
	}

	// Closing the vault window while the project is syncing: ask, pause silently, or do nothing.
	private onBeforeUnload(evt: BeforeUnloadEvent) {
		if (this.allowClose || (this.state !== "running" && this.state !== "error")) return;
		const action = this.settings.onClose;
		this.logger.log("close: state", this.state, "action", action);
		if (action === "nothing") return;
		if (action === "pause") {
			this.cli.runSync(["project", "pause", "-f", this.settings.configFile]);
			return;
		}
		// Cancel this close, ask, then close the window ourselves.
		evt.preventDefault();
		evt.returnValue = false;
		new ClosePromptModal(this.app, async (choice) => {
			this.logger.log("close: choice", choice);
			if (choice === "cancel") return;
			if (choice === "pause") await this.runProject("pause");
			this.allowClose = true;
			window.close();
		}).open();
	}

	private openSettings() {
		const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}
}

class ProjectListModal extends Modal {
	constructor(app: App, private text: string) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("mutagen project list");
		this.modalEl.addClass("mutagen-project-list-modal");
		this.contentEl.createEl("pre", { cls: "mutagen-project-list", text: this.text });
	}

	onClose() {
		this.contentEl.empty();
	}
}

type CloseChoice = "pause" | "close" | "cancel";

class ClosePromptModal extends Modal {
	private choice: CloseChoice = "cancel";

	constructor(app: App, private onChoice: (choice: CloseChoice) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Mutagen is still syncing");
		this.contentEl.createEl("p", { text: "Pause the Mutagen project before closing this vault?" });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const add = (text: string, choice: CloseChoice, cta = false) => {
			const btn = buttons.createEl("button", { text, cls: cta ? "mod-cta" : "" });
			btn.addEventListener("click", () => {
				this.choice = choice;
				this.close();
			});
		};
		add("Pause and close", "pause", true);
		add("Close without pausing", "close");
		add("Cancel", "cancel");
	}

	onClose() {
		this.contentEl.empty();
		this.onChoice(this.choice);
	}
}
