import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { EvalLanguage, EvalStatusEvent, EvalView } from "@oh-my-pi/pi-tui/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

/** Kernel-defined tool metadata exposed to task subagents. */
export interface EvalToolDescriptor {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	language: EvalLanguage;
}

/** Result of invoking a kernel-defined tool. */
export type EvalToolInvokeResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Image metadata accepted at the untyped JS/Python display boundary. */
export function evalImageMetadata(value: unknown): Pick<ImageContent, "detail" | "url"> {
	const metadata: Pick<ImageContent, "detail" | "url"> = {};
	if (!isRecord(value)) return metadata;
	if (value.detail === "auto" || value.detail === "low" || value.detail === "high" || value.detail === "original") {
		metadata.detail = value.detail;
	}
	if (typeof value.url === "string") metadata.url = value.url;
	return metadata;
}

/**
 * Non-text output of an eval cell, from either backend:
 * - an image, sent to the model and shown to the user;
 * - a `view`: a pretty rendering of `text` the cell printed, for the user only
 *   (the model sees `text` in the output stream);
 * - a helper `status` event for the UI.
 */
export type EvalDisplayOutput =
	| ImageContent
	| { type: "view"; text: string; view: EvalView }
	| { type: "status"; event: EvalStatusEvent };
