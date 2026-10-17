// Project state for the status bar dot and menu.
import type { SyncSession } from "./mutagen";

export type ProjectState = "running" | "paused" | "stopped" | "error" | "unavailable" | "nodaemon" | "noconfig";

export const STATE_LABEL: Record<ProjectState, string> = {
	running: "Sync running",
	paused: "Sync paused",
	stopped: "Project not started",
	error: "Sync error",
	unavailable: "mutagen not available",
	nodaemon: "Mutagen daemon not running",
	noconfig: "No mutagen config - click to create",
};

export function stateFromSessions(sessions: SyncSession[]): ProjectState {
	if (sessions.length === 0) return "stopped";
	if (sessions.some((s) => s.lastError)) return "error";
	if (sessions.every((s) => s.paused)) return "paused";
	return "running";
}

const STATUS_TEXT: Record<string, string> = {
	disconnected: "disconnected",
	"connecting-alpha": "connecting (alpha)",
	"connecting-beta": "connecting (beta)",
	watching: "watching",
	scanning: "scanning",
	"waiting-for-rescan": "waiting for rescan",
	reconciling: "reconciling",
	"staging-alpha": "staging (alpha)",
	"staging-beta": "staging (beta)",
	transitioning: "applying changes",
	saving: "saving",
};

// One short line per session: the native macOS menu cannot show multi-line text.
export function sessionSummary(s: SyncSession): string {
	const name = s.name || s.identifier.slice(0, 12);
	const status = s.paused ? "paused" : STATUS_TEXT[s.status] ?? s.status;
	const conflicts = s.conflicts?.length ? `, conflicts: ${s.conflicts.length}` : "";
	const error = s.lastError ? ` - error: ${s.lastError.slice(0, 80)}` : "";
	return `${name}: ${status}${conflicts}${error}`;
}
