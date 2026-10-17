// Start when SSH asks for a password: the plugin has no terminal, so start must fail fast,
// leave no lock file behind and point to "Start in terminal".
// Own daemon with a fake ssh that asks through SSH_ASKPASS, as real ssh does without a terminal.
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { FileSystemAdapter, Menu, Notice } from "obsidian";
import MutagenSyncPlugin from "../src/main";

(globalThis as any).window = { setTimeout, clearTimeout, close: () => {} };

// Short path: the daemon socket path must fit the unix socket limit.
const root = mkdtempSync("/tmp/msp-");
const vault = join(root, "vault");
const bin = join(root, "bin");
mkdirSync(join(vault, ".obsidian/plugins/mutagen-sync"), { recursive: true });
mkdirSync(bin);
writeFileSync(join(bin, "ssh"), `#!/bin/sh\n"$SSH_ASKPASS" "user@host's password: " >/dev/null || exit 255\nexit 255\n`);
chmodSync(join(bin, "ssh"), 0o755);
process.env.MUTAGEN_DATA_DIRECTORY = join(root, "data");
process.env.MUTAGEN_SSH_PATH = bin;
writeFileSync(join(vault, "mutagen.yml"), `sync:\n  vault:\n    alpha: "."\n    beta: "user@localhost:/tmp/msp-remote"\n`);

const mutagen = (...args: string[]) => execFileSync("mutagen", args, { cwd: vault, stdio: "pipe" }).toString();

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = actual === expected;
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

async function main() {
	const app = {
		vault: { adapter: new FileSystemAdapter(vault), on: () => ({}) },
		workspace: { onLayoutReady: (cb: () => void) => cb() },
	};
	const p: any = new MutagenSyncPlugin(app as any, {} as any);
	await p.onload();

	// No daemon: the plugin must not start one (it would outlive Obsidian).
	writeFileSync(join(vault, "mutagen.yml.lock"), "proj_fake\n");
	await p.refresh();
	check("no daemon: state", p.state, "nodaemon");
	check("no daemon: plugin did not start it", existsSync(join(root, "data", "daemon", "daemon.lock")), false);
	await p.domHandlers.click({});
	check("no daemon: menu", Menu.last!.items.map((i) => i.title).join(" | "),
		"Mutagen daemon not running | Details… | Start daemon in terminal | Plugin settings…");
	rmSync(join(vault, "mutagen.yml.lock"));

	mutagen("daemon", "start");
	await p.refresh();

	await p.domHandlers.click({});
	const titles = Menu.last!.items.map((i) => i.title).join(" | ");
	check("menu when stopped", titles, "Project not started | Details… | Start | Start in terminal | Plugin settings…");

	const t0 = Date.now();
	await Menu.last!.items.find((i) => i.title === "Start")!.click!();
	const ms = Date.now() - t0;
	check("start fails fast (<10 s)", ms < 10_000, true);
	check("no lock left after failed start", existsSync(join(vault, "mutagen.yml.lock")), false);
	check("state after failed start", p.state, "stopped");
	check("notice points to Start in terminal", Notice.all.some((m) => m.includes("Start in terminal")), true);
	check("mutagen start from CLI is not blocked", /already/.test(String(Notice.all.at(-1))), false);
	p.onunload();
}

main()
	.catch((e) => { failed++; console.error(e); })
	.finally(() => {
		try { mutagen("project", "terminate"); } catch {}
		try { mutagen("daemon", "stop"); } catch {}
		rmSync(root, { recursive: true, force: true });
		console.log(failed ? `FAILED: ${failed}` : "ALL OK");
		process.exit(failed ? 1 : 0);
	});
