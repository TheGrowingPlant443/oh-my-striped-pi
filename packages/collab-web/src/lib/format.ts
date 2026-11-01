import { formatNumber } from "@oh-my-pi/pi-utils/format";
export * from "@oh-my-pi/pi-utils/format";

/** HTML-escape text destined for `dangerouslySetInnerHTML`. */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function fmtTokens(n: number): string {
	return Number.isFinite(n) && n > 0 ? formatNumber(Math.round(n), 1) : "0";
}

export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return "now";
	const seconds = Math.floor(delta / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function fmtPercent(percent: number | null | undefined): string {
	return percent === null || percent === undefined || !Number.isFinite(percent)
		? "—"
		: `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/** Remote host paths cannot use this browser's home directory. */
export function shortenPath(value: string): string {
	if (typeof value !== "string" || value.length === 0) return "";
	const shortened = value.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
	const segments = shortened.split("/");
	return segments.length > 4 ? `${segments[0]}/…/${segments.slice(-2).join("/")}` : shortened;
}

export function messageText(message: unknown): string {
	if (typeof message === "string") return message;
	if (message === null || message === undefined) return "";
	if (Array.isArray(message)) {
		const parts: string[] = [];
		for (const block of message) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const record = block as Record<string, unknown>;
				if (typeof record.text === "string") parts.push(record.text);
				else if (typeof record.thinking === "string") parts.push(record.thinking);
			}
		}
		return parts.join("\n");
	}
	if (typeof message === "object") {
		const record = message as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if ("content" in record) return messageText(record.content);
	}
	return "";
}
