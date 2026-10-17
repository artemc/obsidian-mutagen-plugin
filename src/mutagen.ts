// Wrapper around the mutagen CLI: one-off commands and a long-lived `sync monitor`.
import { ChildProcess, execFile, execFileSync, spawn } from "child_process";
import { homedir } from "os";
import { delimiter, join } from "path";
import type { Logger } from "./logger";

// Label that `mutagen project start` puts on its sessions (pkg/project/label.go).
export const PROJECT_LABEL = "io.mutagen.project";

// Go template for `--template`. mutagen appends its own newline, so one JSON line per update.
const JSON_TEMPLATE = "{{ json . }}";

export interface SyncSession {
	identifier: string;
	name?: string;
	paused: boolean;
	status: string;
	lastError?: string;
	conflicts?: unknown[];
}

export interface CliResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

// Obsidian launched from a desktop shortcut does not see the shell PATH, so add common locations.
// The plugin never starts the daemon itself: a daemon started from Obsidian outlives it and makes
// the OS count Obsidian as running in the background. A terminal started by the user may start it.
function cliEnv(autostart = false): NodeJS.ProcessEnv {
	const extra = [
		join(homedir(), ".local", "bin"),
		join(homedir(), "go", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
	];
	const path = [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
	if (autostart) delete env.MUTAGEN_DISABLE_AUTOSTART;
	else env.MUTAGEN_DISABLE_AUTOSTART = "1";
	return env;
}

export class MutagenCli {
	constructor(private binary: () => string, private cwd: string, private logger: Logger) {}

	run(args: string[], timeoutMs = 60_000): Promise<CliResult> {
		return new Promise((resolve) => {
			const child = execFile(
				this.binary(),
				args,
				{ cwd: this.cwd, env: cliEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
				(error, stdout, stderr) => {
					this.logger.log("exec", this.binary(), args, "cwd", this.cwd, "->", error ? `error: ${error.message}` : "ok",
						"stdout:", JSON.stringify(String(stdout).slice(0, 2000)), "stderr:", JSON.stringify(String(stderr).slice(0, 1000)));
					resolve({
						ok: !error,
						stdout: String(stdout),
						stderr: String(stderr) || (error ? error.message : ""),
					});
				}
			);
			// Closed stdin makes mutagen fail at once when SSH asks for a password, instead of
			// waiting for input on an open pipe until the timeout.
			child.stdin?.end();
		});
	}

	// Blocking call for use while the window is closing, when async work may never finish.
	runSync(args: string[], timeoutMs = 10_000): boolean {
		try {
			execFileSync(this.binary(), args, { cwd: this.cwd, env: cliEnv(), timeout: timeoutMs, stdio: "ignore" });
			this.logger.log("execSync", args, "-> ok");
			return true;
		} catch (e) {
			this.logger.log("execSync", args, "-> error:", (e as Error).message);
			return false;
		}
	}

	projectCommand(command: "list" | "start" | "pause" | "resume" | "terminate", configFile: string): Promise<CliResult> {
		return this.run(["project", command, "-f", configFile]);
	}

	// "nodaemon" when the daemon is not running; null when the CLI failed for another reason.
	async sessions(projectId: string): Promise<SyncSession[] | "nodaemon" | null> {
		const res = await this.run(
			["sync", "list", "--label-selector", `${PROJECT_LABEL}=${projectId}`, "--template", JSON_TEMPLATE],
			15_000
		);
		if (!res.ok) return daemonDown(res.stderr) ? "nodaemon" : null;
		return parseSessions(res.stdout.trim());
	}

	// The daemon pushes changes itself; each change is one JSON line with the list of sessions.
	monitor(projectId: string, onUpdate: (s: SyncSession[]) => void, onExit: () => void): ChildProcess {
		const child = spawn(
			this.binary(),
			["sync", "monitor", "--label-selector", `${PROJECT_LABEL}=${projectId}`, "--template", JSON_TEMPLATE],
			{ cwd: this.cwd, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] }
		);
		this.logger.log("monitor spawn", this.binary(), "pid", child.pid ?? "none", "project", projectId);
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				this.logger.log("monitor line:", line.slice(0, 2000));
				const sessions = parseSessions(line);
				if (sessions) onUpdate(sessions);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => this.logger.log("monitor stderr:", chunk.toString().trim()));
		child.on("error", (e) => {
			this.logger.log("monitor error:", e.message);
			onExit();
		});
		child.on("exit", (code, signal) => {
			this.logger.log("monitor exit code", code ?? "null", "signal", signal ?? "null");
			onExit();
		});
		return child;
	}
}

// Empty output is not "no sessions": an empty list is printed as `[]`.
function parseSessions(text: string): SyncSession[] | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function daemonDown(stderr: string): boolean {
	return /unable to connect to daemon/i.test(stderr);
}

// Words in mutagen's error when SSH wanted a password or passphrase and there was no terminal to ask.
export function needsPrompt(stderr: string): boolean {
	return /unable to (invoke )?prompt|password|passphrase/i.test(stderr);
}

function shQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Runs a mutagen command in a visible system terminal, where SSH can ask for a password.
// `custom` overrides the terminal: its `{command}` is replaced with a quoted shell command.
export function runInTerminal(binary: string, args: string[], cwd: string, custom: string, logger: Logger, onError: (message: string) => void) {
	let file: string;
	let argv: string[];
	if (process.platform === "win32") {
		const line = [binary, ...args].map((a) => `"${a}"`).join(" ");
		file = "cmd.exe";
		argv = ["/c", "start", "Mutagen", "cmd.exe", "/k", line];
	} else {
		const line = `cd ${shQuote(cwd)} && ${[binary, ...args].map(shQuote).join(" ")}; echo; printf 'Press Enter to close'; read _`;
		if (custom.trim()) {
			file = "/bin/sh";
			argv = ["-c", custom.split("{command}").join(shQuote(line))];
		} else if (process.platform === "darwin") {
			// Terminal starts the user's login shell, which has the full PATH.
			const script = `exec /bin/sh -c ${shQuote(line)}`;
			const quoted = '"' + script.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
			file = "osascript";
			argv = ["-e", `tell application "Terminal" to do script ${quoted}`, "-e", 'tell application "Terminal" to activate'];
		} else {
			file = "x-terminal-emulator";
			argv = ["-e", "sh", "-c", line];
		}
	}
	logger.log("terminal", file, argv);
	const child = spawn(file, argv, { cwd, env: cliEnv(true), detached: true, stdio: "ignore" });
	child.on("error", (e) => {
		logger.log("terminal error", e.message);
		onError(`${file}: ${e.message}`);
	});
	// A custom command runs through sh, which reports a missing terminal only by exit code.
	child.on("exit", (code) => {
		if (code === 127) onError(`${custom.trim().split(/\s+/)[0]}: command not found`);
	});
	child.unref();
}
