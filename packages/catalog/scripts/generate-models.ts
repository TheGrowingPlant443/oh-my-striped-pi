#!/usr/bin/env bun
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildModel } from "../src/build";
import { apiRouteFor, modelLimitsFor } from "../src/compat/behavior";
import { providerEntries, seedModels } from "../src/compat/providers";
import { encodeModelCatalog } from "../src/model-catalog-format";
import { resolveModelTokenizer } from "../src/model-tokenizer";
import type { Api, Model, ModelSpec } from "../src/types";
import { mergeCopilotApiHeaders } from "../src/wire/github-copilot";

/** Materialize authored seeds without credentials, remote catalogs, or stale snapshots. */
export function buildGeneratedModel(model: ModelSpec<Api>): Model<Api> {
	const spec = { ...model };
	if (resolveModelTokenizer(spec.requestModelId ?? spec.id, spec.provider) !== undefined) delete spec.tokenizer;
	delete spec.promptCache;
	delete spec.promptCacheConfig;
	delete spec.kindConfig;
	const limits = modelLimitsFor(spec.provider, spec.id);
	if (limits?.context !== undefined) spec.contextWindow = limits.context;
	if (limits?.maxTokens !== undefined) spec.maxTokens = limits.maxTokens;
	if (spec.provider === "github-copilot") {
		spec.api = apiRouteFor(spec.provider, spec.id)?.api ?? spec.api;
		spec.headers = mergeCopilotApiHeaders(spec.headers);
	}
	return buildModel(spec);
}

export async function generateModels(selectedProvider?: string): Promise<void> {
	const entries = Object.values(providerEntries()).sort((a, b) => a.id.localeCompare(b.id));
	if (selectedProvider !== undefined && !entries.some(entry => entry.id === selectedProvider)) {
		throw new Error(`Unknown catalog provider: ${selectedProvider}`);
	}
	// Rebuild all authored providers; runtime-only servers intentionally have no bundled rows.
	const models: Record<string, Record<string, Model<Api>>> = {};
	for (const entry of entries) {
		models[entry.id] = Object.fromEntries(
			[...seedModels(entry.id)]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(model => [model.id, buildGeneratedModel(model)]),
		);
	}
	await Bun.write(path.join(import.meta.dir, "../src/models.json"), encodeModelCatalog(models));
	console.log("Generated src/models.json from authored provider seeds (offline)");
}

if (import.meta.main) {
	const { values } = parseArgs({ args: Bun.argv.slice(2), options: { provider: { type: "string" } } });
	generateModels(values.provider).catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
