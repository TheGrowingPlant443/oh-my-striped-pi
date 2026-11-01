/** Offline Markdown, React tool cards and session traces included by the export viewer. */
import { Marked } from "@oh-my-pi/pi-utils/marked";
import "./tool-render/standalone";
import "./trace-render/standalone";

declare global {
	var ompMarkdown: { Marked: typeof Marked };
}

globalThis.ompMarkdown = { Marked };
