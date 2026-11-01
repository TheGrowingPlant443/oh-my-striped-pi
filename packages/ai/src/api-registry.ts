/** Custom inference transport registration for hosts and extensions. */

import * as AIError from "./error";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StreamOptions } from "./types";

export type CustomStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;
export type CustomStreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RegisteredCustomApi {
	stream: CustomStreamFn;
	streamSimple: CustomStreamSimpleFn;
	sourceId?: string;
}

const customApiRegistry = new Map<string, RegisteredCustomApi>();

function assertCustomApiName(api: string): void {
	if (!api.trim() || api.includes("\0")) {
		throw new AIError.ConfigurationError("Custom API must be a nonempty name without NUL characters");
	}
}

/**
 * Register a custom API streaming function.
 */
export function registerCustomApi(
	api: string,
	streamSimple: CustomStreamSimpleFn,
	sourceId?: string,
	stream?: CustomStreamFn,
): void {
	assertCustomApiName(api);
	customApiRegistry.set(api, {
		stream: stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
		streamSimple,
		sourceId,
	});
}

/**
 * Get a custom API provider by API identifier.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	return customApiRegistry.get(api);
}

/**
 * Remove all custom APIs registered by a specific source (e.g., extension path).
 */
export function unregisterCustomApis(sourceId: string): void {
	for (const [api, entry] of customApiRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			customApiRegistry.delete(api);
		}
	}
}

/**
 * Clear all custom API registrations.
 */
export function clearCustomApis(): void {
	customApiRegistry.clear();
}
