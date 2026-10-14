// Minimal Obsidian API stub for running the integration test in Node.
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

type Handler = (...args: any[]) => void;

export class FileSystemAdapter {
	constructor(private base: string) {}
	getBasePath() { return this.base; }
	async exists(p: string) { return existsSync(join(this.base, p)); }
	async read(p: string) { return readFile(join(this.base, p), "utf8"); }
	async write(p: string, data: string) { await writeFile(join(this.base, p), data); }
}

class FakeEl {
	dataset: Record<string, string> = {};
	attrs: Record<string, string> = {};
	hidden = false;
	parentElement = null;
	doc = {};
	addClass() {}
	createDiv() { return new FakeEl(); }
	addEventListener() {}
	createEl() { return new FakeEl(); }
	setAttr(k: string, v: string) { this.attrs[k] = v; }
	hide() { this.hidden = true; }
	show() { this.hidden = false; }
	empty() {}
	setText() {}
	getBoundingClientRect() { return { left: 0, top: 0 }; }
}

export class Plugin {
	manifest = { id: "mutagen-sync", dir: ".obsidian/plugins/mutagen-sync", version: "test" };
	statusItems: FakeEl[] = [];
	domHandlers: Record<string, Handler> = {};
	private data: unknown = null;
	constructor(public app: any) {}
	addStatusBarItem() { const el = new FakeEl(); this.statusItems.push(el); return el as any; }
	addSettingTab() {}
	registerDomEvent(_el: unknown, type: string, h: Handler) { this.domHandlers[type] = h; }
	registerEvent() {}
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = d; }
}

export class Menu {
	static last: Menu | null = null;
	items: { title: string; disabled: boolean; click?: Handler }[] = [];
	addItem(cb: (item: any) => void) {
		const rec: { title: string; disabled: boolean; click?: Handler } = { title: "", disabled: false };
		const item: any = {
			setTitle: (t: string) => { rec.title = t; return item; },
			setIcon: () => item,
			setDisabled: (d: boolean) => { rec.disabled = d; return item; },
			onClick: (h: Handler) => { rec.click = h; return item; },
		};
		cb(item);
		this.items.push(rec);
		return this;
	}
	addSeparator() { return this; }
	showAtMouseEvent() { Menu.last = this; }
}

export class Notice { constructor(public message: string) {} hide() {} }
export class Modal {
	static last: Modal | null = null;
	titleEl = new FakeEl();
	modalEl = new FakeEl();
	contentEl = new FakeEl();
	constructor(public app: any) {}
	open() { Modal.last = this; (this as any).onOpen?.(); }
	close() { (this as any).onClose?.(); }
}
export class PluginSettingTab { containerEl = new FakeEl(); constructor(public app: any, public plugin: any) {} }
export class Setting {}
export class TAbstractFile { path = ""; }
export class App {}
