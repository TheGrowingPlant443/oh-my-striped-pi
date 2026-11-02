import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { Api, Model, ModelSpec } from "@oh-my-striped-pi/pi-ai";
import { selectorCandidates } from "@oh-my-striped-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";

const fastSpec = {
	provider: "company",
	id: "fast",
	name: "Fast",
	api: "openai-completions",
	baseUrl: "https://inference.company.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
} satisfies ModelSpec<"openai-completions">;
const fast = buildModel(fastSpec);
const mini = buildModel({ ...fastSpec, id: "small", name: "Small" });
const vertex = buildModel({ ...fastSpec, provider: "standby-company", id: "standby", name: "Standby" });
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: Model<Api>) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("resolves company embedding models and excludes local-only workers", () => {
		const embedder = buildModel({
			...fastSpec,
			id: "embedding",
			api: "openai-embeddings",
			kind: "embedding",
			reasoning: false,
			supportsTools: false,
			maxTokens: null,
		});
		const tiny = buildModel({ ...fastSpec, id: "tiny", api: "local-inference", kind: "tiny" });
		const all = [embedder, tiny];
		const runners = { getAll: () => all, getAvailable: () => all };
		expect(selectorCandidates(key(embedder), Settings.isolated(), runners)).toEqual([embedder]);
		expect(selectorCandidates(key(tiny), Settings.isolated(), runners)).toEqual([]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});
});
