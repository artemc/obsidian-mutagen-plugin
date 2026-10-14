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
function cliEnv(): NodeJS.ProcessEnv {
	const extra = [
		join(homedir(), ".local", "bin"),
		join(homedir(), "go", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
	];
	const path = [process.env.PATH ?? "", ...extra].filter(Boolean).join(delimiter);
	return { ...process.env, PATH: path };
}

export class MutagenCli {
	constructor(private binary: () => string, private cwd: string, private logger: Logger) {}

	run(args: string[], timeoutMs = 60_000): Promise<CliResult> {
		return new Promise((resolve) => {
			execFile(
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

	projectCommand(command: "list" | "start" | "pause" | "resume", configFile: string): Promise<CliResult> {
		return this.run(["project", command, "-f", configFile]);
	}

	async sessions(projectId: string): Promise<SyncSession[] | null> {
		const res = await this.run(
			["sync", "list", "--label-selector", `${PROJECT_LABEL}=${projectId}`, "--template", JSON_TEMPLATE],
			15_000
		);
		if (!res.ok) return null;
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
