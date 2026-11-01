/** Screen frames persisted by local session recordings. */
import { STREAM_HISTORY_LIMIT, type StreamRow } from "@oh-my-pi/pi-wire";

/** Screen-content frames stored in a recording. */
export type StreamScreenFrame =
	| { t: "resize"; cols: number; rows: number }
	| { t: "history"; rows: StreamRow[] }
	| { t: "viewport"; rows: StreamRow[] }
	| { t: "patch"; ops: [index: number, row: StreamRow][]; rows: number }
	| { t: "reset" };

/** Materialized screen of one session: bounded scrollback plus the live viewport. */
export interface StreamScreen {
	cols: number;
	rows: number;
	history: StreamRow[];
	viewport: StreamRow[];
}

/** Apply one recorded screen frame to the materialized playback screen. */
export function applyScreenFrame(screen: StreamScreen, frame: StreamScreenFrame): void {
	switch (frame.t) {
		case "resize":
			screen.cols = frame.cols;
			screen.rows = frame.rows;
			fitViewport(screen.viewport, frame.rows);
			break;
		case "history": {
			const overflow = screen.history.length + frame.rows.length - STREAM_HISTORY_LIMIT;
			if (overflow >= screen.history.length) {
				screen.history = frame.rows.slice(-STREAM_HISTORY_LIMIT);
			} else {
				if (overflow > 0) screen.history.splice(0, overflow);
				screen.history.push(...frame.rows);
			}
			break;
		}
		case "viewport":
			screen.viewport = frame.rows.slice();
			break;
		case "patch":
			screen.rows = frame.rows;
			fitViewport(screen.viewport, frame.rows);
			for (const [index, row] of frame.ops) {
				if (index >= 0 && index < frame.rows) screen.viewport[index] = row;
			}
			break;
		case "reset":
			screen.history = [];
			screen.viewport = [];
			break;
	}
}

function fitViewport(viewport: StreamRow[], rows: number): void {
	if (viewport.length > rows) viewport.length = rows;
	while (viewport.length < rows) viewport.push("");
}

/** Structural validation of an untrusted recording frame. */
export function isScreenFrame(value: unknown): value is StreamScreenFrame {
	if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") return false;
	const frame = value as Record<string, unknown>;
	switch (frame.t) {
		case "resize":
			return isDimension(frame.cols) && isDimension(frame.rows);
		case "history":
		case "viewport":
			return Array.isArray(frame.rows) && frame.rows.every(row => typeof row === "string");
		case "patch":
			return (
				isDimension(frame.rows) &&
				Array.isArray(frame.ops) &&
				frame.ops.every(
					op =>
						Array.isArray(op) &&
						op.length === 2 &&
						typeof op[0] === "number" &&
						Number.isInteger(op[0]) &&
						typeof op[1] === "string",
				)
			);
		case "reset":
			return true;
		default:
			return false;
	}
}

/** Non-negative integer terminal dimension. */
export function isDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
