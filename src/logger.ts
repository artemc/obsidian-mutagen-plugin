// Debug log: developer console and debug.log in the plugin folder.
import { appendFile, stat, writeFile } from "fs/promises";

const MAX_LOG_BYTES = 1024 * 1024;

export class Logger {
	enabled = false;
	private queue: Promise<void> = Promise.resolve();

	constructor(readonly file: string) {}

	log(...parts: unknown[]) {
		if (!this.enabled) return;
		const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
		console.debug("[mutagen-sync]", text);
		const line = `${new Date().toISOString()} ${text}\n`;
		this.queue = this.queue.then(() => this.write(line)).catch(() => undefined);
	}

	private async write(line: string) {
		const size = await stat(this.file).then((s) => s.size, () => 0);
		if (size > MAX_LOG_BYTES) await writeFile(this.file, "");
		await appendFile(this.file, line);
	}
}
