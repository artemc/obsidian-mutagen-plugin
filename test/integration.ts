// Integration test: plugin code + Obsidian stub + real mutagen.
// Run: npm run test:integration (needs mutagen in PATH).
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileSystemAdapter, Menu, Modal } from "obsidian";
import MutagenSyncPlugin from "../src/main";

// Fake browser window: the plugin listens for beforeunload and closes the window itself.
let windowClosed = false;
(globalThis as any).window = { setTimeout, clearTimeout, close: () => { windowClosed = true; } };

const root = mkdtempSync(join(tmpdir(), "mutagen-sync-test-"));
const vault = join(root, "vault");
const remote = join(root, "remote");
mkdirSync(join(vault, ".obsidian/plugins/mutagen-sync"), { recursive: true });
mkdirSync(remote);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mutagen = (...args: string[]) => execFileSync("mutagen", args, { cwd: vault, stdio: "pipe" }).toString();

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = actual === expected;
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function waitState(p: any, expected: string, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end && p.state !== expected) await sleep(100);
	return p.state;
}

async function clickMenu(p: any): Promise<Menu> {
	await p.domHandlers[0]({});
	return Menu.last!;
}

async function main() {
	let layoutReady: () => void = () => {};
	const app = {
		vault: { adapter: new FileSystemAdapter(vault), on: () => ({}) },
		workspace: { onLayoutReady: (cb: () => void) => (layoutReady = cb) },
	};
	const p: any = new MutagenSyncPlugin(app as any, {} as any);
	await p.onload();
	p.settings.configTemplate = `sync:\n\tvault:\n\t\talpha: "."\n\t\tbeta: "${remote}"\n`;
	layoutReady();
	await p.refresh();
	check("no config", p.state, "noconfig");
	check("dot state without config", p.statusItems[0].dataset.state, "noconfig");

	let menu = await clickMenu(p);
	check("menu without config", menu.items.map((i) => i.title).join(" | "), "Create mutagen.yml | Settings");
	await menu.items[0].click!();
	check("after Create", p.state, "stopped");

	menu = await clickMenu(p);
	const start = menu.items.find((i) => i.title === "Start")!;
	check("Start enabled", start.disabled, false);
	await start.click!();
	check("after Start", await waitState(p, "running"), "running");
	check("monitor running", p.monitor !== null, true);

	mutagen("project", "pause");
	check("pause from terminal via monitor", await waitState(p, "paused"), "paused");
	await sleep(1500);
	check("still paused after more monitor updates", p.state, "paused");

	menu = await clickMenu(p);
	check("Start disabled while paused", menu.items.find((i) => i.title === "Start")!.disabled, true);
	const resume = menu.items.find((i) => i.title === "Resume")!;
	check("Resume enabled", resume.disabled, false);
	await resume.click!();
	check("after Resume", await waitState(p, "running"), "running");
	console.log("menu:", menu.items.map((i) => i.title).join(" | "));

	// Closing the vault while syncing.
	const closeEvent = () => {
		const evt: any = { prevented: false, preventDefault() { this.prevented = true; } };
		p.domHandlers[1](evt);
		return evt;
	};

	p.settings.onClose = "nothing";
	check("close, keep syncing: not blocked", closeEvent().prevented, false);
	check("close, keep syncing: state", p.state, "running");

	p.settings.onClose = "ask";
	Modal.last = null;
	let evt = closeEvent();
	check("close, ask: close blocked", evt.prevented, true);
	check("close, ask: prompt shown", Modal.last !== null, true);
	(Modal.last as any).choice = "cancel";
	Modal.last!.close();
	await sleep(200);
	check("close, ask, cancel: window stays", windowClosed, false);

	Modal.last = null;
	closeEvent();
	(Modal.last as any).choice = "pause";
	Modal.last!.close();
	check("close, ask, pause: paused", await waitState(p, "paused"), "paused");
	await sleep(200);
	check("close, ask, pause: window closed", windowClosed, true);

	mutagen("project", "resume");
	p.allowClose = false;
	check("resumed for next case", await waitState(p, "running"), "running");
	p.settings.onClose = "pause";
	evt = closeEvent();
	check("close, pause silently: not blocked", evt.prevented, false);
	check("close, pause silently: paused", await waitState(p, "paused"), "paused");

	p.onunload();
	check("monitor stopped", p.monitor, null);
}

main()
	.catch((e) => { failed++; console.error(e); })
	.finally(() => {
		try { mutagen("project", "terminate"); } catch {}
		rmSync(root, { recursive: true, force: true });
		console.log(failed ? `FAILED: ${failed}` : "ALL OK");
		process.exit(failed ? 1 : 0);
	});
