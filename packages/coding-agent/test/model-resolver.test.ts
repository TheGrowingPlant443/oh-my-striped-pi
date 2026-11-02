import { describe, expect, test, vi } from "bun:test";
import { type Api, Effort, type Model } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { logger } from "@oh-my-striped-pi/pi-utils";
import { parseModelString } from "@oh-my-striped-pi/pi-tui/overlays/model-selector";
import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	parseModelPattern,
	pickDefaultAvailableModel,
	resolveAgentAdvisorRolePattern,
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentModelSelection,
	resolveAgentPrewalkPattern,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelFromSettings,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	resolveRoleChain,
	resolveSessionModelSelector,
	rolePriorityDefaults,
	resolveProviderModelReference,
} from "@oh-my-striped-pi/pi-coding-agent/config/model-resolver";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
} from "@oh-my-striped-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";

// Literal provider fixtures: Copilot chat and a small on-device model.
const mockModels: Model<Api>[] = [
	buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "tiny",
		name: "Local Tiny",
		api: "local-inference",
		provider: "local",
		baseUrl: "local://inference",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	}),
];

const mockColonModels: Model<Api>[] = [
	buildModel({
		id: "qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

const mockMaxSuffixModels: Model<Api>[] = [
	buildModel({
		id: "coding-router",
		name: "Coding Router",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "coding-router:max",
		name: "Coding Router Max",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "coding-router:low",
		name: "Coding Router Low",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

// Sibling models where one id is a prefix of the other AND the longer id embeds
// a thinking-tier token (`-highspeed` contains `high`). Regression fixture for
// the fuzzy match swallowing a `:high` thinking suffix into the longer id.
const mockThinkingSuffixSiblingModels: Model<"openai-responses">[] = [
	buildModel({
		id: "local-coder",
		name: "Local Coder",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32000,
	}),
	buildModel({
		id: "local-coder-highspeed",
		name: "Local Coder Highspeed",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32000,
	}),
];

const mockAutoSuffixModels: Model<Api>[] = [
	buildModel({
		id: "runtime:auto",
		name: "Runtime Auto",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

const mockProviderOverlapModels: Model<Api>[] = [
	roleChainModel("local", "shared-chat"),
	roleChainModel("github-copilot", "shared-chat"),
];

const mockCopilotSiblingModels: Model<"openai-responses">[] = [
	buildModel({
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.5 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
];

const mockMaxCapableModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		},
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	}),
];

const sharedChatModels: Model<Api>[] = mockProviderOverlapModels.map(model =>
	buildModel({
		...model,
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	}),
);

function createOpusModel(provider: string, id: string, name: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

const allModels = [...mockModels, ...mockColonModels, ...mockProviderOverlapModels, ...mockCopilotSiblingModels];

function roleChainModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		api: provider === "local" ? "local-inference" : "openai-completions",
		provider,
		baseUrl: provider === "local" ? "local://inference" : "https://api.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

describe("pickDefaultAvailableModel", () => {
	test("returns no default for an empty roster", () => {
		expect(pickDefaultAvailableModel([])).toBeUndefined();
	});

	test("keeps literal local tiny selectable alongside Copilot chat", () => {
		const [chat, tiny] = mockModels;
		expect(pickDefaultAvailableModel([tiny])).toBe(tiny);
		expect(parseModelPattern("local/tiny", [chat, tiny]).model).toBe(tiny);
		expect(parseModelPattern("github-copilot/claude-sonnet-4-5", [tiny, chat]).model).toBe(chat);
	});

	test("prefers a provider account default over its first roster entry", () => {
		const [first, accountDefault] = mockCopilotSiblingModels;
		const selected = buildModel({ ...accountDefault, isProviderDefault: true });
		expect(pickDefaultAvailableModel([first, selected])).toBe(selected);
	});

	test("prefers concrete credentials when supplied and keeps keyless local otherwise", () => {
		const [chat, tiny] = mockModels;
		expect(pickDefaultAvailableModel([tiny, chat], provider => provider === "github-copilot")).toBe(chat);
		expect(pickDefaultAvailableModel([tiny], () => false)).toBe(tiny);
	});

	test("checks concrete auth once per provider", () => {
		const checkedProviders: string[] = [];
		const models = [mockModels[1], ...mockCopilotSiblingModels];
		const picked = pickDefaultAvailableModel(models, provider => {
			checkedProviders.push(provider);
			return provider === "github-copilot";
		});
		expect(picked?.provider).toBe("github-copilot");
		expect(checkedProviders).toEqual(["local", "github-copilot"]);
	});
});

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("all valid thinking levels work", () => {
			const levels = [
				"off",
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			] as const;
			for (const level of levels) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
		test("max parses as a real thinking level after the literal pattern misses", () => {
			const result = parseModelPattern("gpt-5.3-codex:max", allModels);
			expect(result.model?.id).toBe("gpt-5.3-codex");
			expect(result.thinkingLevel).toBe(Effort.Max);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("literal model ids ending in max win over the thinking suffix", () => {
			const result = parseModelPattern("github-copilot/coding-router:max", mockMaxSuffixModels);
			expect(result.model?.id).toBe("coding-router:max");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("fuzzy selectors preserve literal models ending in a thinking-level suffix", () => {
			const result = parseModelPattern("router:low", mockMaxSuffixModels);
			expect(result.model?.id).toBe("coding-router:low");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
		});

		test("literal model ids ending in auto win over the auto sentinel alias", () => {
			const result = parseModelPattern("github-copilot/runtime:auto", mockAutoSuffixModels);
			expect(result.model?.id).toBe("runtime:auto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("thinking suffix is stripped before fuzzy match, never absorbed into a longer sibling id", () => {
			// `local-coder:high` must resolve to the standard model at high effort,
			// not fuzzy-match `local-coder-highspeed` (issue #5151).
			const result = parseModelPattern("github-copilot/local-coder:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("local-coder");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("bare id thinking suffix is stripped before fuzzy match against a longer sibling", () => {
			const result = parseModelPattern("local-coder:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("local-coder");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		test("the longer sibling still resolves exactly with its own thinking suffix", () => {
			const result = parseModelPattern("github-copilot/local-coder-highspeed:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("local-coder-highspeed");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("literal colon ids", () => {
		test.each(["qwen3-coder:exacto", "github-copilot/qwen3-coder:exacto"])(
			"preserves %s without thinking",
			selector => {
				const result = parseModelPattern(selector, mockColonModels);
				expect(result.model).toBe(mockColonModels[0]);
				expect(result.thinkingLevel).toBeUndefined();
				expect(result.explicitThinkingLevel).toBe(false);
				expect(result.warning).toBeUndefined();
			},
		);

		test.each(["qwen3-coder:exacto:high", "github-copilot/qwen3-coder:exacto:high"])(
			"extracts thinking from %s",
			selector => {
				const result = parseModelPattern(selector, mockColonModels);
				expect(result.model).toBe(mockColonModels[0]);
				expect(result.thinkingLevel).toBe(Effort.High);
				expect(result.explicitThinkingLevel).toBe(true);
			},
		);

		test.each(["qwen3-coder:exacto:random", "qwen3-coder:exacto:high:random"])(
			"warns for invalid thinking in %s",
			selector => {
				const result = parseModelPattern(selector, mockColonModels);
				expect(result.model).toBe(mockColonModels[0]);
				expect(result.thinkingLevel).toBeUndefined();
				expect(result.explicitThinkingLevel).toBe(false);
				expect(result.warning).toContain("Invalid thinking level");
				expect(result.warning).toContain("random");
			},
		);
	});

	describe("provider-qualified identity", () => {
		const tiny = roleChainModel("local", "tiny");
		const shadow = roleChainModel("github-copilot", "local/tiny");

		test("a supported prefix never rebinds to another provider's raw id", () => {
			expect(parseModelPattern("local/tiny", [shadow]).model).toBeUndefined();
			expect(parseModelPattern("LOCAL/TINY", [shadow]).model).toBeUndefined();
			expect(resolveModelFromString("local/tiny", [shadow])).toBeUndefined();
		});

		test("decomposed provider and id win over a raw slashful id", () => {
			expect(parseModelPattern("local/tiny", [shadow, tiny]).model).toBe(tiny);
			expect(parseModelPattern("github-copilot/local/tiny", [shadow, tiny]).model).toBe(shadow);
			const modelRegistry = { getAll: () => [shadow, tiny], getAvailable: () => [shadow, tiny] };
			expect(resolveCliModel({ cliModel: "local/tiny", modelRegistry }).model).toBe(tiny);
		});

		test("CLI keeps the supported-provider lock when the provider is unavailable", () => {
			const result = resolveCliModel({
				cliModel: "local/tiny",
				modelRegistry: { getAll: () => [shadow], getAvailable: () => [shadow] },
			});
			expect(result.model).toBeUndefined();
			expect(result.error).toBeTruthy();
		});

		test("wire-only and configured unavailable providers keep their explicit namespace", () => {
			const llamaShadow = roleChainModel("github-copilot", "llama.cpp/not-loaded");
			expect(parseModelPattern("llama.cpp/not-loaded", [llamaShadow]).model).toBeUndefined();
			const companyShadow = roleChainModel("github-copilot", "company/not-loaded");
			expect(
				parseModelPattern("company/not-loaded", [companyShadow], {
					isKnownProvider: provider => provider === "company",
				}).model,
			).toBeUndefined();
		});

		test("dotted and dashed model revisions resolve within the selected provider", () => {
			const model = createOpusModel("github-copilot", "claude-fable-5-1", "Claude Fable 5.1");
			const result = parseModelPattern("github-copilot/claude-fable-5.1:high", [model]);
			expect(result.model).toBe(model);
			expect(result.thinkingLevel).toBe(Effort.High);
		});
	});

	describe("edge cases", () => {
		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// Empty string after colon is not a valid thinking level
			// So it tries to match "sonnet:" which won't match, then tries "sonnet"
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("preference logic", () => {
		test("recent use outranks the configured provider order", () => {
			const result = parseModelPattern("shared-chat", mockProviderOverlapModels, {
				usageOrder: ["local/shared-chat"],
				providerOrder: ["github-copilot"],
			});
			expect(result.model?.provider).toBe("local");
		});

		test("uses configured provider order without recent use", () => {
			const result = parseModelPattern("shared-chat", mockProviderOverlapModels, {
				usageOrder: [],
				providerOrder: ["github-copilot"],
			});
			expect(result.model?.provider).toBe("github-copilot");
		});
	});
});

describe("role priorities and chains", () => {
	test("role priority defaults accept arbitrary role names safely", () => {
		expect(rolePriorityDefaults("not-a-built-in-role")).toEqual([]);
		expect(rolePriorityDefaults("__proto__")).toEqual([]);
		expect(rolePriorityDefaults("memory")).toEqual(rolePriorityDefaults("smol"));
	});

	test("explicit local tiny stays distinct from Copilot chat in inherited roles", () => {
		const tiny = roleChainModel("local", "tiny");
		const chat = roleChainModel("github-copilot", "chat");
		const settings = Settings.isolated({ modelRoles: { tiny: "local/tiny", default: "github-copilot/chat" } });
		expect(resolveModelRoleValue("@tiny", [chat, tiny], { settings }).model).toBe(tiny);
		expect(resolveModelRoleValue("@default", [tiny, chat], { settings }).model).toBe(chat);
		expect(resolveRoleChain("memory", settings, [chat, tiny])[0]?.model).toBe(tiny);
		expect(resolveRoleChain("judge", settings, [chat, tiny]).map(candidate => candidate.model)).toEqual([tiny, chat]);
	});

	test("appends non-explicit built-in defaults after a configured primary", () => {
		const tiny = roleChainModel("local", "tiny");
		const haiku = roleChainModel("github-copilot", "claude-haiku-5.5");
		const settings = Settings.isolated({ modelRoles: { smol: "local/tiny" } });
		expect(
			resolveRoleChain("smol", settings, [tiny, haiku]).map(candidate => [candidate.model, candidate.explicit]),
		).toEqual([
			[tiny, true],
			[haiku, false],
		]);
	});

	test.each([
		{ smol: "local/missing" },
		{ smol: "local/missing,github-copilot/claude-haiku-5.5" },
		{ smol: "@search", search: "local/missing" },
		{ smol: "missing,local/missing,github-copilot/claude-haiku-5.5" },
	])("marks the first qualified selector replaced by fallback: %j", modelRoles => {
		const haiku = roleChainModel("github-copilot", "claude-haiku-5.5");
		const settings = Settings.isolated({ modelRoles });
		const chain = resolveRoleChain("smol", settings, [haiku]);
		expect(chain[0]?.replaces).toBe("local/missing");
		expect(chain.slice(1).some(candidate => candidate.replaces !== undefined)).toBe(false);
	});

	test("leaves a resolved configured selector unmarked", () => {
		const tiny = roleChainModel("local", "tiny");
		const settings = Settings.isolated({ modelRoles: { smol: "local/tiny" } });
		expect(resolveRoleChain("smol", settings, [tiny])[0]?.replaces).toBeUndefined();
	});

	test("upgrades a default primary when an explicit retry candidate resolves the same model", () => {
		const haiku = roleChainModel("github-copilot", "claude-haiku-5.5");
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: ["github-copilot/claude-haiku-5.5"] } });
		expect(
			resolveRoleChain("smol", settings, [haiku]).map(candidate => [candidate.model, candidate.explicit]),
		).toEqual([[haiku, true]]);
	});

	test("treats an empty configured role value as explicit by key presence", () => {
		const haiku = roleChainModel("github-copilot", "claude-haiku-5.5");
		const settings = Settings.isolated({ modelRoles: { smol: "" } });
		expect(resolveRoleChain("smol", settings, [haiku])[0]?.explicit).toBe(true);
	});

	test("an explicitly empty retry chain disables built-in fallbacks", () => {
		const tiny = roleChainModel("local", "tiny");
		const haiku = roleChainModel("github-copilot", "claude-haiku-5.5");
		const settings = Settings.isolated({ modelRoles: { smol: "local/tiny" }, "retry.fallbackChains": { smol: [] } });
		expect(resolveRoleChain("smol", settings, [tiny, haiku]).map(candidate => candidate.model)).toEqual([tiny]);
	});

	test("deduplicates explicit retry candidates by literal provider and model", () => {
		const tiny = roleChainModel("local", "tiny");
		const chat = roleChainModel("github-copilot", "chat");
		const settings = Settings.isolated({
			modelRoles: { worker: "local/tiny" },
			"retry.fallbackChains": { worker: ["github-copilot/chat", "local/tiny", "github-copilot/chat"] },
		});
		const chain = resolveRoleChain("worker", settings, [tiny, chat]);
		expect(chain.map(candidate => formatModelStringWithRouting(candidate.model))).toEqual([
			"local/tiny",
			"github-copilot/chat",
		]);
		expect(chain.every(candidate => candidate.explicit)).toBe(true);
	});

	test("ignores configured kind roles during default chat selection", () => {
		const chat = roleChainModel("github-copilot", "chat");
		const image = buildModel({ ...roleChainModel("local", "image"), kind: "image" });
		const settings = Settings.isolated({ modelRoles: { image: "local/image" } });
		expect(resolveModelFromSettings({ settings, availableModels: [chat, image] })).toBe(chat);
	});
});

describe("resolveModelRoleValue", () => {
	test("resolves @role:<thinking> by expanding role alias before parsing thinking", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "github-copilot/qwen3-coder:exacto" } });

		const result = resolveModelRoleValue("@smol:high", allModels, { settings });

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves @role:max by expanding role alias before parsing thinking", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "github-copilot/gpt-5.3-codex" } });

		const result = resolveModelRoleValue("@smol:max", allModels, { settings });

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("gpt-5.3-codex");
		// Role-value resolution clamps: gpt-5.3-codex's ladder tops out at xhigh.
		expect(result.thinkingLevel).toBe(Effort.XHigh);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves @default through configured default role alias", () => {
		const settings = Settings.isolated({ modelRoles: { default: "github-copilot/qwen3-coder:exacto" } });

		const result = resolveModelRoleValue("@default", allModels, { settings });

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("qwen3-coder:exacto");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.explicitThinkingLevel).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	test("resolves a custom role that references another custom role (#10853)", () => {
		// modelRoles.fast_worker = "@task" must expand through the referenced
		// role to its concrete model at the pure resolution layer, without
		// relying on the retry model-fallback path (which retry.modelFallback:
		// false disables).
		const settings = Settings.isolated({
			modelRoles: {
				task: "github-copilot/qwen3-coder:exacto",
				fast_worker: "@task",
			},
		});

		const result = resolveModelRoleValue("@fast_worker", allModels, { settings });

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("qwen3-coder:exacto");
	});

	test("splits direct comma fallback chains before parsing thinking selectors", () => {
		const result = resolveModelRoleValue("github-copilot/claude-sonnet-4-5:off,local/tiny:off", allModels);

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	test("tries later direct comma fallback entries when earlier entries miss", () => {
		const result = resolveModelRoleValue("github-copilot/missing:off,local/tiny:off", allModels);

		expect(result.model?.provider).toBe("local");
		expect(result.model?.id).toBe("tiny");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	test("does not resolve an exact sibling id to the longer id via substring matching", () => {
		const providerQualified = resolveModelRoleValue("github-copilot/gpt-5.3-codex:xhigh", allModels);
		expect(providerQualified.model?.provider).toBe("github-copilot");
		expect(providerQualified.model?.id).toBe("gpt-5.3-codex");
		expect(providerQualified.thinkingLevel).toBe(Effort.XHigh);
		expect(providerQualified.explicitThinkingLevel).toBe(true);

		const idOnly = resolveModelRoleValue("gpt-5.3-codex:xhigh", allModels);
		expect(idOnly.model?.provider).toBe("github-copilot");
		expect(idOnly.model?.id).toBe("gpt-5.3-codex");
		expect(idOnly.thinkingLevel).toBe(Effort.XHigh);
		expect(idOnly.explicitThinkingLevel).toBe(true);
	});

	test("clamps explicit thinking selectors from model metadata", () => {
		const result = resolveModelRoleValue("github-copilot/claude-sonnet-4-5:xhigh", allModels);

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("passes max through unclamped when the model ladder includes it", () => {
		const result = resolveModelRoleValue("github-copilot/claude-opus-4-7:max", mockMaxCapableModels);

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("claude-opus-4-7");
		expect(result.thinkingLevel).toBe(Effort.Max);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("preserves an explicit :auto suffix as an explicit thinking selector", () => {
		const result = resolveModelRoleValue("github-copilot/claude-sonnet-4-5:auto", allModels);

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("auto");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});
});
describe("resolveAgentPrewalkPattern", () => {
	test("agent definition alone decides: true → default target, pattern → custom, false/absent → off", () => {
		expect(resolveAgentPrewalkPattern({ agentPrewalk: true })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ agentPrewalk: "@very-smol" })).toBe("@very-smol");
		expect(resolveAgentPrewalkPattern({ agentPrewalk: false })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({})).toBeUndefined();
	});

	test("settings override wins over the agent definition", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "off", agentPrewalk: true })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({ settingsOverride: "off", agentPrewalk: "@very-smol" })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on", agentPrewalk: false })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "local/tiny", agentPrewalk: false })).toBe("local/tiny");
	});

	test("override 'on' keeps the agent's custom target when one is defined", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on", agentPrewalk: "@very-smol" })).toBe("@very-smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on" })).toBe("@smol");
	});

	test("blank override falls through to the agent definition", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "  ", agentPrewalk: true })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "", agentPrewalk: false })).toBeUndefined();
	});
});
describe("resolveAgentAdvisorSelection", () => {
	test("agent definition alone decides: true → advisor role, pattern → custom model, false/absent → off", () => {
		expect(resolveAgentAdvisorSelection({ agentAdvisor: true })).toEqual({});
		expect(resolveAgentAdvisorSelection({ agentAdvisor: "local/advisor" })).toEqual({ model: "local/advisor" });
		expect(resolveAgentAdvisorSelection({ agentAdvisor: false })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({})).toBeUndefined();
	});

	test("settings override wins over the agent definition", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "off", agentAdvisor: true })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({ settingsOverride: "off", agentAdvisor: "local/advisor" })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on", agentAdvisor: false })).toEqual({});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "local/tiny", agentAdvisor: false })).toEqual({
			model: "local/tiny",
		});
	});

	test("override 'on' keeps the agent's custom advisor model when one is defined", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on", agentAdvisor: "local/advisor" })).toEqual({
			model: "local/advisor",
		});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on" })).toEqual({});
	});

	test("blank override falls through to the agent definition", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "  ", agentAdvisor: true })).toEqual({});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "", agentAdvisor: false })).toBeUndefined();
	});
});
describe("resolveAgentAdvisorRolePattern", () => {
	test("a self-referential @advisor resolves to the owner's advisor role inside the spawned session", () => {
		const owner = Settings.isolated({ modelRoles: { advisor: "github-copilot/claude-haiku-4-5" } });
		const child = Settings.isolated({
			modelRoles: {
				...owner.getModelRoles(),
				advisor: resolveAgentAdvisorRolePattern("@advisor:high", owner),
			},
		});

		expect(resolveConfiguredModelPatterns("@advisor", child)).toEqual(["github-copilot/claude-haiku-4-5:high"]);
	});
});
describe("resolveAgentModelPatterns", () => {
	test("pairs the first non-empty source's role with its patterns, skipping aliases with no patterns", () => {
		const settings = Settings.isolated({
			modelRoles: {
				empty: "",
				override: "local/tiny",
				definition: "github-copilot/claude-sonnet-4-5",
			},
		});

		expect(
			resolveAgentModelSelection({
				requestModel: "",
				settingsOverride: "@override",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["local/tiny"], role: "override" });

		expect(
			resolveAgentModelSelection({
				requestModel: "@empty",
				settingsOverride: ",,",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["github-copilot/claude-sonnet-4-5"], role: "definition" });

		// An explicit selector carries no role identity, so the child must not
		// capture the routing of a role that happens to name the same model.
		expect(
			resolveAgentModelSelection({
				requestModel: "local/tiny",
				settingsOverride: "@override",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["local/tiny"], role: undefined });
	});

	test("falls back to the active session model when @task is unset", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "github-copilot/claude-sonnet-4-5" },
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
			activeModelPattern: "local/tiny",
		});

		expect(result).toEqual(["local/tiny"]);
	});

	test("uses the configured task role before falling back to the session model", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "local/tiny",
				task: "github-copilot/claude-sonnet-4-5:high",
			},
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
			activeModelPattern: "local/tiny",
		});

		expect(result).toEqual(["github-copilot/claude-sonnet-4-5:high"]);
	});

	test("accepts YAML list values for configured task role patterns", () => {
		const settings = Settings.isolated({
			modelRoles: {
				task: ["github-copilot/claude-sonnet-4-6", "local/worker:high"],
			},
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
		});

		expect(result).toEqual(["github-copilot/claude-sonnet-4-6", "local/worker:high"]);
	});

	test("uses default for unconfigured smol and slow agent roles before priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "local/llama" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "@smol", settings })).toEqual(["local/llama"]);
		expect(resolveAgentModelPatterns({ agentModel: "@slow", settings })).toEqual(["local/llama"]);
	});

	test("uses configured smol for unconfigured tiny before priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "local/default",
				smol: "local/custom-smol:max",
			},
		});

		expect(resolveAgentModelPatterns({ agentModel: "@tiny", settings })).toEqual(["local/custom-smol:max"]);
	});

	test("uses configured slow for unconfigured advisor before priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "local/default",
				slow: "local/custom-slow:max",
			},
		});

		expect(resolveAgentModelPatterns({ agentModel: "@advisor", settings })).toEqual(["local/custom-slow:max"]);
	});

	test("expands nested role aliases from the configured slow fallback", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "github-copilot/qwen3-coder:exacto",
				smol: "@default",
				slow: "@smol",
			},
		});

		const result = resolveModelRoleValue("@advisor", allModels, { settings });

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("qwen3-coder:exacto");
	});

	test("outer advisor thinking level overrides the inherited slow effort", () => {
		const settings = Settings.isolated({
			modelRoles: { slow: "github-copilot/coding-router:max" },
		});

		const result = resolveModelRoleValue("@advisor:high", [mockMaxSuffixModels[0]], { settings });

		expect(result.model?.id).toBe("coding-router");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("outer advisor thinking level preserves an inherited literal suffix model id", () => {
		const settings = Settings.isolated({
			modelRoles: { slow: "github-copilot/coding-router:max" },
		});

		const result = resolveModelRoleValue("@advisor:high", mockMaxSuffixModels, { settings });

		expect(result.model?.id).toBe("coding-router:max");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("keeps advisor on the built-in slow chain when slow is unconfigured", () => {
		const baseline = resolveAgentModelPatterns({ agentModel: "@advisor", settings: Settings.isolated() });
		const settings = Settings.isolated({ modelRoles: { default: "local/default" } });

		const advisor = resolveAgentModelPatterns({ agentModel: "@advisor", settings });

		expect(advisor).not.toContain("local/default");
		expect(advisor).toEqual(baseline);
	});

	test("breaks the tiny/smol fallback cycle via a default alias", () => {
		const settings = Settings.isolated({ modelRoles: { default: "@tiny" } });
		const baseline = resolveAgentModelPatterns({ agentModel: "@smol", settings: Settings.isolated() });

		const tiny = resolveAgentModelPatterns({ agentModel: "@tiny", settings });
		const smol = resolveAgentModelPatterns({ agentModel: "@smol", settings });

		expect(baseline.length).toBeGreaterThan(0);
		expect(tiny).not.toContain("@tiny");
		expect(smol).not.toContain("@tiny");
		expect(tiny).toEqual(baseline);
		expect(smol).toEqual(tiny);
	});

	test("preserves thinking suffix when breaking the smol fallback cycle", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "@tiny:high" } });
		const baseline = resolveAgentModelPatterns({ agentModel: "@smol", settings: Settings.isolated() });

		const tiny = resolveAgentModelPatterns({ agentModel: "@tiny", settings });

		expect(tiny).toEqual(baseline.map(pattern => `${pattern}:high`));
	});

	test("expands cross-role default aliases when inheriting for an unset role", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "@slow", slow: "github-copilot/claude-sonnet-4-5" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "@smol", settings })).toEqual([
			"github-copilot/claude-sonnet-4-5",
		]);
	});
});

describe("resolveModelFromString", () => {
	test("falls back to pattern parsing for provider/model:thinking when strict provider+id miss", () => {
		const resolved = resolveModelFromString("github-copilot/qwen3-coder:exacto:high", allModels);
		expect(resolved?.provider).toBe("github-copilot");
		expect(resolved?.id).toBe("qwen3-coder:exacto");
	});

	test("treats colon-containing model IDs without thinking suffix as exact IDs", () => {
		const resolved = resolveModelFromString("github-copilot/qwen3-coder:exacto", allModels);
		expect(resolved?.provider).toBe("github-copilot");
		expect(resolved?.id).toBe("qwen3-coder:exacto");
	});
});

describe("resolveModelOverride", () => {
	test("preserves explicit off and explicit-thinking metadata", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["sonnet:off"], registry);

		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves colon-containing model IDs with appended thinking suffix", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["github-copilot/qwen3-coder:exacto:high"], registry);

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});
});
describe("resolveCliModel", () => {
	const allModelsRegistry = { getAll: () => allModels, getAvailable: () => allModels };

	test("resolves --model provider/id without --provider", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "local/tiny",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("local");
		expect(result.model?.id).toBe("tiny");
	});

	test("prefers an authenticated provider for an unqualified exact model id", () => {
		const availableModels = sharedChatModels.filter(model => model.provider === "github-copilot");
		const registry = { getAll: () => sharedChatModels, getAvailable: () => sharedChatModels };

		const result = resolveCliModel({
			cliModel: "shared-chat",
			modelRegistry: registry,
			availableModels,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("shared-chat");
	});

	test("ranks an exact bare id carried by several authenticated providers like modelRoles", () => {
		// Registry order favors Copilot; the explicit preference must win.
		const models = [...sharedChatModels].reverse();
		const registry = { getAll: () => models, getAvailable: () => models };
		const preferences = { providerOrder: ["local"] };

		const bare = resolveCliModel({ cliModel: "shared-chat", modelRegistry: registry, preferences });
		const suffixed = resolveCliModel({ cliModel: "shared-chat:high", modelRegistry: registry, preferences });

		expect(bare.model?.provider).toBe("local");
		expect(suffixed.model?.provider).toBe("local");
		expect(suffixed.thinkingLevel).toBe(Effort.High);

		// Recent use outranks modelProviderOrder, as for roles; this registry lists local first.
		const recent = resolveCliModel({
			cliModel: "shared-chat",
			modelRegistry: { getAll: () => sharedChatModels, getAvailable: () => sharedChatModels },
			preferences: { usageOrder: ["github-copilot/shared-chat"], providerOrder: ["local"] },
		});
		expect(recent.model?.provider).toBe("github-copilot");
	});

	test("resolves bare configured role names from --model", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { task: "local/tiny" },
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("local");
		expect(result.model?.id).toBe("tiny");
	});

	test("resolves bare configured role names with thinking suffixes", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { task: "github-copilot/claude-sonnet-4-5" },
		});

		const result = resolveCliModel({
			cliModel: "task:high",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.configuredPatterns).toEqual(["github-copilot/claude-sonnet-4-5:high"]);
	});

	test("preserves configured role fallback selectors for deferred resolution", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				task: "local/z-ai/glm-4.7@cerebras,github-copilot/claude-sonnet-4-5",
			},
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.configuredPatterns).toEqual(["local/z-ai/glm-4.7@cerebras", "github-copilot/claude-sonnet-4-5"]);
	});

	test("reports when a configured role matches after unresolved candidates", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				task: "local/runtime-model,github-copilot/claude-sonnet-4-5",
			},
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.configuredPatternIndex).toBe(1);
		expect(result.configuredPatterns).toEqual(["local/runtime-model", "github-copilot/claude-sonnet-4-5"]);
	});

	test("does not fuzzy-match unresolved configured roles", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { sonnet: "local/runtime-model" },
		});

		const result = resolveCliModel({
			cliModel: "sonnet",
			modelRegistry: registry,
			settings,
		});

		expect(result.model).toBeUndefined();
		expect(result.configuredPatterns).toEqual(["local/runtime-model"]);
		expect(result.error).toContain('Model "sonnet" not found');
	});

	test("keeps unknown --model names on the not-found path", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };

		const result = resolveCliModel({
			cliModel: "not-a-model",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model "not-a-model" not found');
	});

	test("prefers an exact model name over a same-named configured role", () => {
		const exactModel = buildModel({
			id: "task",
			name: "Task",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, exactModel], getAvailable: () => [...allModels, exactModel] };
		const settings = Settings.isolated({
			modelRoles: { task: "github-copilot/claude-sonnet-4-5" },
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model).toBe(exactModel);
		const suffixed = resolveCliModel({
			cliModel: "task:high",
			modelRegistry: registry,
			settings,
		});

		expect(suffixed.error).toBeUndefined();
		expect(suffixed.model).toBe(exactModel);
		expect(suffixed.thinkingLevel).toBe(Effort.High);
	});

	test("configured role beats an unauthenticated catalog id collision (#6508)", () => {
		// An unauthenticated catalog id must not shadow a runnable configured role.
		const catalogDefault = buildModel({
			id: "default",
			name: "Catalog Default",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, catalogDefault], getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { default: "local/tiny" },
		});

		const result = resolveCliModel({
			cliModel: "default",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("local");
		expect(result.model?.id).toBe("tiny");
	});

	test("unauthenticated catalog id still resolves when no role matches", () => {
		// Without a configured role the same bare id must still reach the catalog
		// model (so `--model default` surfaces the usual "no API key" error rather
		// than a spurious not-found), confirming the fallback is only deferred.
		const catalogDefault = buildModel({
			id: "default",
			name: "Catalog Default",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, catalogDefault], getAvailable: () => allModels };
		const settings = Settings.isolated({ modelRoles: {} });

		const result = resolveCliModel({
			cliModel: "default",
			modelRegistry: registry,
			settings,
		});

		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("default");
	});

	test("resolves configured custom, legacy, and default role aliases from --model", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				default: "local/tiny",
				fable: "github-copilot/claude-sonnet-4-5:high",
			},
		});

		const canonical = resolveCliModel({
			cliModel: "@fable",
			modelRegistry: registry,
			settings,
		});
		const legacy = resolveCliModel({
			cliModel: `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}fable`,
			modelRegistry: registry,
			settings,
		});
		const defaultRole = resolveCliModel({
			cliModel: DEFAULT_MODEL_ROLE_ALIAS,
			modelRegistry: registry,
			settings,
		});

		expect(canonical.error).toBeUndefined();
		expect(canonical.model?.provider).toBe("github-copilot");
		expect(canonical.model?.id).toBe("claude-sonnet-4-5");
		expect(canonical.thinkingLevel).toBe(Effort.High);
		expect(legacy).toEqual(canonical);
		expect(defaultRole.model?.provider).toBe("local");
		expect(defaultRole.model?.id).toBe("tiny");
	});

	test.each(["@fable", `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}fable`])(
		"keeps an exact model id ahead of the configured alias %s",
		alias => {
			const literal = buildModel({ ...mockModels[0], id: alias, name: alias });
			const models = [...allModels, literal];
			const modelRegistry = { getAll: () => models, getAvailable: () => models };
			const settings = Settings.isolated({ modelRoles: { fable: "github-copilot/claude-sonnet-4-5:high" } });

			expect(resolveCliModel({ cliModel: alias, modelRegistry, settings }).model).toBe(literal);
			const suffixed = resolveCliModel({ cliModel: `${alias}:low`, modelRegistry, settings });
			expect(suffixed.model).toBe(literal);
			expect(suffixed.thinkingLevel).toBe(Effort.Low);
		},
	);

	test("rejects an unrecognized legacy-looking provider selector", () => {
		const settings = Settings.isolated({ modelRoles: { fable: "github-copilot/claude-sonnet-4-5" } });
		const result = resolveCliModel({
			cliModel: `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}not-a-role`,
			modelRegistry: allModelsRegistry,
			settings,
		});
		expect(result.model).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	test.each(["@fable", `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}fable`])(
		"keeps an empty configured role alias %s on the not-found path",
		cliModel => {
			const settings = Settings.isolated({ modelRoles: { fable: "" } });
			const result = resolveCliModel({ cliModel, modelRegistry: allModelsRegistry, settings });
			expect(result.model).toBeUndefined();
			expect(result.configuredRole).toBe("fable");
			expect(result.error).toContain("not found");
		},
	);

	test("splits thinking suffixes and abbreviations off the * default alias", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { default: "github-copilot/claude-sonnet-4-5" },
		});

		const explicit = resolveCliModel({
			cliModel: `${DEFAULT_MODEL_ROLE_ALIAS}:high`,
			modelRegistry: registry,
			settings,
		});
		const abbreviated = resolveCliModel({
			cliModel: `${DEFAULT_MODEL_ROLE_ALIAS}:xhi`,
			modelRegistry: registry,
			settings,
		});

		expect(explicit.error).toBeUndefined();
		expect(explicit.model?.id).toBe("claude-sonnet-4-5");
		expect(explicit.thinkingLevel).toBe(Effort.High);
		// `xhi` → xhigh via unique-prefix parsing, then clamped to the model ladder.
		expect(abbreviated.error).toBeUndefined();
		expect(abbreviated.model?.id).toBe("claude-sonnet-4-5");
		expect(abbreviated.thinkingLevel).toBe(Effort.High);
	});

	test("rejects a near miss within an explicit --provider and suggests the sibling", () => {
		const result = resolveCliModel({
			cliProvider: "local",
			cliModel: "tin",
			modelRegistry: allModelsRegistry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
		expect(result.error).toContain("Did you mean local/tiny");
		expect(resolveCliModel({ cliModel: "local/tin", modelRegistry: allModelsRegistry }).error).toContain(
			"local/tiny",
		);
		expect(resolveCliModel({ cliModel: "local/tin:high", modelRegistry: allModelsRegistry }).error).toContain(
			"Did you mean local/tiny",
		);
	});

	test("offers no suggestion when nothing in the provider is close", () => {
		expect(resolveCliModel({ cliModel: "local/zzzz", modelRegistry: allModelsRegistry }).error).not.toContain(
			"Did you mean",
		);
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("does not strip invalid :suffix as thinking level in --model (fail fast)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "local",
			cliModel: "tiny:extended",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	test("returns a clear error when there are no models", () => {
		const registry = { getAll: () => [], getAvailable: () => [] } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "local",
			cliModel: "tiny",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("rejects a provider-prefixed near miss instead of fuzzy-matching a sibling", () => {
		for (const cliModel of ["local/qwen", "github-copilot/claude-sonnet-5", "github-copilot/gpt-5.3-spark"]) {
			const result = resolveCliModel({ cliModel, modelRegistry: allModelsRegistry });
			expect(result.model).toBeUndefined();
			expect(result.error).toContain("not found");
		}
	});

	test("provider-prefixed exact ids resolve while bare selectors keep fuzzy matching", () => {
		const exact = resolveCliModel({
			cliModel: "github-copilot/gpt-5.3-codex-spark",
			modelRegistry: allModelsRegistry,
		});
		expect(exact.error).toBeUndefined();
		expect(exact.model?.provider).toBe("github-copilot");
		expect(exact.model?.id).toBe("gpt-5.3-codex-spark");

		const bare = resolveCliModel({ cliModel: "spark", modelRegistry: allModelsRegistry });
		expect(bare.error).toBeUndefined();
		expect(bare.model?.id).toBe("gpt-5.3-codex-spark");
	});

	describe("issue #13079: disabledProviders gates an explicit pin", () => {
		const registry = { getAll: () => sharedChatModels, getAvailable: () => sharedChatModels };
		const settings = Settings.isolated({ disabledProviders: ["github-copilot"] });

		test("refuses a provider-qualified pin and names the disabled provider", () => {
			const result = resolveCliModel({
				cliModel: "github-copilot/shared-chat",
				modelRegistry: registry,
				settings,
			});

			expect(result.model).toBeUndefined();
			expect(result.disabledProvider).toBe("github-copilot");
			expect(result.error).toContain("github-copilot");
		});

		test("refuses a --provider/--model pair naming the disabled provider", () => {
			const result = resolveCliModel({
				cliProvider: "github-copilot",
				cliModel: "shared-chat",
				modelRegistry: registry,
				settings,
			});

			expect(result.model).toBeUndefined();
			expect(result.disabledProvider).toBe("github-copilot");
		});

		test("falls through to an enabled provider carrying the same id", () => {
			const result = resolveCliModel({
				cliModel: "shared-chat",
				modelRegistry: registry,
				availableModels: sharedChatModels.filter(model => model.provider === "github-copilot"),
				settings,
			});

			expect(result.error).toBeUndefined();
			expect(result.disabledProvider).toBeUndefined();
			expect(result.model?.provider).toBe("local");
		});

		test("refuses a configured role whose only candidate is disabled", () => {
			const result = resolveCliModel({
				cliModel: "task",
				modelRegistry: registry,
				settings: Settings.isolated({
					disabledProviders: ["github-copilot"],
					modelRoles: { task: "github-copilot/shared-chat" },
				}),
			});

			expect(result.model).toBeUndefined();
			expect(result.disabledProvider).toBe("github-copilot");
			expect(result.configuredPatterns).toBeUndefined();
		});
	});
});

describe("resolveModelScope", () => {
	test("does not coalesce explicit local provider/id patterns to Copilot (regression for enabledModels)", async () => {
		const scoped = await resolveModelScope(["local/shared-chat"], {
			getAvailable: () => sharedChatModels,
		});
		expect(scoped).toHaveLength(1);
		expect(scoped[0].model.provider).toBe("local");
		expect(scoped[0].model.id).toBe("shared-chat");
	});

	test("keeps non-chat runners out of the scope without reporting them as unmatched (#14016)", async () => {
		const runnerSpec = (provider: string, id: string, kind: Model["kind"]) =>
			buildModel({
				id,
				name: id,
				api: "openai-completions",
				kind,
				provider,
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1024,
			});
		const judge = runnerSpec("local", "judge", "judge");
		const search = runnerSpec("local", "search", "search");
		const chat = sharedChatModels;
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const scoped = await resolveModelScope(
				["local/judge", "local/search", "local/shared-chat", "nonexistent-model"],
				{ getAvailable: kind => (kind === "all" ? [...chat, judge, search] : chat) },
			);
			expect(scoped.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual(["local/shared-chat"]);
			expect(warn.mock.calls.map(call => call[0])).toEqual(['No models match pattern "nonexistent-model"']);
		} finally {
			warn.mockRestore();
		}
	});

	test("resolves role aliases in --models scope to the role's model with its thinking level", async () => {
		const settings = Settings.isolated({
			modelRoles: { fable: "github-copilot/claude-sonnet-4-5:high" },
		});

		const scoped = await resolveModelScope(
			["@fable", "local/tiny"],
			{ getAvailable: () => allModels },
			undefined,
			settings,
		);

		expect(scoped).toHaveLength(2);
		expect(scoped[0].model.id).toBe("claude-sonnet-4-5");
		expect(scoped[0].thinkingLevel).toBe(Effort.High);
		expect(scoped[0].explicitThinkingLevel).toBe(true);
		expect(scoped[1].model.id).toBe("tiny");
	});

	test("applies max thinking selectors to glob scopes when no literal max ids match", async () => {
		const registry = {
			getAvailable: () => mockCopilotSiblingModels,
		};

		const scoped = await resolveModelScope(["github-copilot/*:max"], registry);

		expect(scoped).toHaveLength(2);
		// Scoped levels clamp per model: max on an xhigh-ceiling ladder resolves to xhigh.
		expect(scoped.map(entry => entry.thinkingLevel)).toEqual([Effort.XHigh, Effort.XHigh]);
		expect(scoped.every(entry => entry.explicitThinkingLevel)).toBe(true);
	});

	test("keeps max on glob scopes when the model ladder includes it", async () => {
		const registry = {
			getAvailable: () => mockMaxCapableModels,
		};

		const scoped = await resolveModelScope(["github-copilot/*:max"], registry);

		expect(scoped).toHaveLength(1);
		expect(scoped[0].thinkingLevel).toBe(Effort.Max);
		expect(scoped[0].explicitThinkingLevel).toBe(true);
	});

	test("preserves literal :max in scoped-model globs", async () => {
		const registry = {
			getAvailable: () => mockMaxSuffixModels,
		};

		const scoped = await resolveModelScope(["github-copilot/*:max"], registry);

		expect(scoped).toHaveLength(1);
		expect(scoped[0].model.id).toBe("coding-router:max");
		expect(scoped[0].thinkingLevel).toBeUndefined();
		expect(scoped[0].explicitThinkingLevel).toBe(false);
	});
});

describe("parseModelString", () => {
	test("parses standard provider/id format", () => {
		const result = parseModelString("github-copilot/claude-sonnet-4-5");
		expect(result).toEqual({ provider: "github-copilot", id: "claude-sonnet-4-5" });
	});

	test("returns undefined for strings without a slash", () => {
		expect(parseModelString("claude-sonnet-4-5")).toBeUndefined();
		expect(parseModelString("")).toBeUndefined();
		expect(parseModelString("sonnet:high")).toBeUndefined();
	});

	test("returns undefined for strings starting with slash", () => {
		expect(parseModelString("/claude-sonnet-4-5")).toBeUndefined();
	});

	describe("thinking level suffix extraction", () => {
		test("extracts all valid thinking levels", () => {
			const levels = ["off", Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
			for (const level of levels) {
				const result = parseModelString(`github-copilot/claude-sonnet-4-5:${level}`);
				expect(result?.id).toBe("claude-sonnet-4-5");
				expect(result?.thinkingLevel).toBe(level);
			}
		});

		test("does NOT strip invalid suffix — treats it as part of model ID", () => {
			const result = parseModelString("github-copilot/qwen3-coder:exacto");
			expect(result).toEqual({ provider: "github-copilot", id: "qwen3-coder:exacto" });
		});

		test("handles model ID with colon followed by valid thinking level", () => {
			// The last colon is the thinking level, not part of the literal model id.
			const result = parseModelString("github-copilot/qwen3-coder:exacto:high");
			expect(result).toEqual({
				provider: "github-copilot",
				id: "qwen3-coder:exacto",
				thinkingLevel: Effort.High,
			});
		});

		test("extracts max when explicitly enabled for provider id selectors", () => {
			const result = parseModelString("local/reasoner:max", { allowMaxSuffix: true });
			expect(result).toEqual({ provider: "local", id: "reasoner", thinkingLevel: Effort.Max });
		});

		test("preserves literal max model ids when the caller can prove they exist", () => {
			const result = parseModelString("github-copilot/coding-router:max", {
				allowMaxSuffix: true,
				isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "coding-router:max",
			});
			expect(result).toEqual({ provider: "github-copilot", id: "coding-router:max" });
		});

		test("leaves :max attached to the model id unless the caller opts in via allowMaxSuffix", () => {
			// Without allowMaxSuffix, the strict suffix parser must not silently
			// reinterpret a literal `:max` id as a thinking suffix.
			const result = parseModelString("github-copilot/claude-sonnet-4-5:max");
			expect(result).toEqual({ provider: "github-copilot", id: "claude-sonnet-4-5:max" });
		});

		test("leaves :auto attached to the model id unless the caller opts in via allowAutoAlias", () => {
			// Without allowAutoAlias, the strict suffix parser must not silently
			// reinterpret a literal `:auto` id as an auto-thinking selector.
			const result = parseModelString("github-copilot/runtime:auto");
			expect(result).toEqual({ provider: "github-copilot", id: "runtime:auto" });
		});

		test("extracts auto sentinel when explicitly enabled for provider id selectors", () => {
			const result = parseModelString("local/gpt-5:auto", { allowAutoAlias: true });
			expect(result).toEqual({ provider: "local", id: "gpt-5", thinkingLevel: "auto" });
		});

		test("preserves literal :auto model ids when the caller can prove they exist", () => {
			const result = parseModelString("github-copilot/runtime:auto", {
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "runtime:auto",
			});
			expect(result).toEqual({ provider: "github-copilot", id: "runtime:auto" });
		});

		test("does not strip inherited object keys as thinking suffixes", () => {
			const result = parseModelString("github-copilot/claude-sonnet-4-5:constructor");
			expect(result).toEqual({ provider: "github-copilot", id: "claude-sonnet-4-5:constructor" });
		});

		test("handles empty suffix after colon", () => {
			const result = parseModelString("github-copilot/claude-sonnet-4-5:");
			// Empty string is not a valid thinking level, so colon stays as part of ID
			expect(result).toEqual({ provider: "github-copilot", id: "claude-sonnet-4-5:" });
		});
	});
});

describe("resolveModelFromString", () => {
	test("applies max as a provider model selector alias after literal lookup misses", () => {
		const result = resolveModelFromString("github-copilot/coding-router:max", [mockMaxSuffixModels[0]]);
		expect(result?.provider).toBe("github-copilot");
		expect(result?.id).toBe("coding-router");
	});

	test("preserves literal max provider model ids before alias parsing", () => {
		const result = resolveModelFromString("github-copilot/coding-router:max", mockMaxSuffixModels);
		expect(result?.provider).toBe("github-copilot");
		expect(result?.id).toBe("coding-router:max");
	});

	test("preserves literal :auto provider model ids before alias parsing", () => {
		const result = resolveModelFromString("github-copilot/runtime:auto", mockAutoSuffixModels);
		expect(result?.provider).toBe("github-copilot");
		expect(result?.id).toBe("runtime:auto");
	});
});

describe("resolveExplicitModelRole", () => {
	test("extracts built-in, custom, legacy, default, and thinking-suffixed aliases before expansion", () => {
		const settings = Settings.isolated({
			modelRoles: {
				reviewer: "local/tiny",
			},
		});

		expect(resolveExplicitModelRole("@task", settings)).toBe("task");
		expect(resolveExplicitModelRole("pi/reviewer:high", settings)).toBe("reviewer");
		expect(resolveExplicitModelRole("@reviewer:xhigh", settings)).toBe("reviewer");
		expect(resolveExplicitModelRole("*:low", settings)).toBe("default");
	});

	test("does not infer a role from an explicit model selector", () => {
		const settings = Settings.isolated({ modelRoles: { reviewer: "local/tiny" } });
		expect(resolveExplicitModelRole("local/tiny", settings)).toBeUndefined();
		expect(resolveExplicitModelRole("local/tiny:high", settings)).toBeUndefined();
		expect(resolveExplicitModelRole("local/tiny:max", settings)).toBeUndefined();
		expect(resolveExplicitModelRole(["local/tiny", "@reviewer:high"], settings)).toBe("reviewer");
	});
});

describe("expandRoleAlias", () => {
	test("expands @vision to configured vision role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("vision", "local/tiny");

		expect(expandRoleAlias("@vision", settings)).toBe("local/tiny");
	});

	test("keeps @vision alias when vision role is unset", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", "github-copilot/claude-sonnet-4-5");

		expect(expandRoleAlias("@vision", settings)).toBe("@vision");
	});
});

describe("extractExplicitThinkingSelector", () => {
	test("does not carry max from literal role model ids", () => {
		const result = extractExplicitThinkingSelector("github-copilot/coding-router:max", undefined, {
			isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "coding-router:max",
		});
		expect(result).toBeUndefined();
	});

	test("treats max as an explicit selector when the model id is not literal", () => {
		const result = extractExplicitThinkingSelector("github-copilot/coding-router:max", undefined, {
			isLiteralModelId: () => false,
		});
		expect(result).toBe(Effort.Max);
	});

	test("treats max on pi role aliases as an explicit selector before expansion", () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", "github-copilot/coding-router:max");
		const result = extractExplicitThinkingSelector("@smol:max", settings, {
			isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "coding-router:max",
		});
		expect(result).toBe(Effort.Max);
	});

	test("does not carry auto from literal role model ids", () => {
		const result = extractExplicitThinkingSelector("github-copilot/coding-router:auto", undefined, {
			isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "coding-router:auto",
		});
		expect(result).toBeUndefined();
	});

	test("treats auto as an explicit selector when the model id is not literal", () => {
		const result = extractExplicitThinkingSelector("local/gpt-5:auto", undefined, {
			isLiteralModelId: () => false,
		});
		expect(result).toBe("auto");
	});

	test("extracts max from a short qualified selector", () => {
		expect(
			extractExplicitThinkingSelector("local/a:max", undefined, {
				isLiteralModelId: () => false,
			}),
		).toBe(Effort.Max);
	});

	test("extracts max from a short unqualified selector when no literal exists", () => {
		expect(
			extractExplicitThinkingSelector("a:max", undefined, {
				isLiteralModelId: (provider, id) => provider !== undefined || id !== "a:max",
			}),
		).toBe(Effort.Max);
	});

	test("requires an exact provider match for qualified literal model ids", () => {
		expect(
			extractExplicitThinkingSelector("local/a:max", undefined, {
				isLiteralModelId: (provider, id) => provider === "github-copilot" && id === "a:max",
			}),
		).toBe(Effort.Max);
	});

	test("extracts off from short qualified and unqualified selectors", () => {
		expect(extractExplicitThinkingSelector("local/a:off")).toBe("off");
		expect(extractExplicitThinkingSelector("a:off")).toBe("off");
	});

	test("keeps a strict outer suffix ahead of literal :max detection", () => {
		expect(
			extractExplicitThinkingSelector("a:max:off", undefined, {
				isLiteralModelId: (provider, id) => provider === undefined && id === "a:max",
			}),
		).toBe("off");
	});

	test("extracts max from a role alias targeting a short selector", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "local/a" } });
		expect(
			extractExplicitThinkingSelector("@smol:max", settings, {
				isLiteralModelId: () => false,
			}),
		).toBe(Effort.Max);
	});

	test("preserves literal qualified and unqualified :max and :auto model ids", () => {
		const literalIds: Record<string, true> = {
			"local/a:max": true,
			"local/a:auto": true,
			"a:max": true,
			"a:auto": true,
		};
		const isLiteralModelId = (provider: string | undefined, id: string) =>
			literalIds[provider === undefined ? id : `${provider}/${id}`] === true;

		expect(extractExplicitThinkingSelector("local/a:max", undefined, { isLiteralModelId })).toBeUndefined();
		expect(extractExplicitThinkingSelector("local/a:auto", undefined, { isLiteralModelId })).toBeUndefined();
		expect(extractExplicitThinkingSelector("a:max", undefined, { isLiteralModelId })).toBeUndefined();
		expect(extractExplicitThinkingSelector("a:auto", undefined, { isLiteralModelId })).toBeUndefined();
	});

	test("treats a missing unqualified literal :auto model id as the auto selector", () => {
		const availableIds: Record<string, true> = { a: true };
		const isLiteralModelId = (provider: string | undefined, id: string) =>
			provider === undefined && availableIds[id] === true;

		expect(extractExplicitThinkingSelector("a:auto", undefined, { isLiteralModelId })).toBe("auto");
	});
});

describe("filterAvailableModelsByEnabledPatterns", () => {
	const models = mockModels as Model[];
	test("returns all models when patterns is empty", () => {
		expect(filterAvailableModelsByEnabledPatterns(models, [])).toEqual(models);
	});

	test("resolves role aliases to the role's model when settings are provided", () => {
		const settings = Settings.isolated({
			modelRoles: { fable: "github-copilot/claude-sonnet-4-5:high" },
		});
		const result = filterAvailableModelsByEnabledPatterns(models, ["@fable"], settings);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("filters by exact provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["github-copilot/claude-sonnet-4-5"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("filters by bare model id matching across providers", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-sonnet-4-5"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("github-copilot");
	});

	test("strips :thinkingLevel suffix before matching", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["github-copilot/claude-sonnet-4-5:high"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("preserves colon-bearing configured ids (suffix is not a thinking level)", () => {
		const colonModels = mockColonModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(colonModels, ["github-copilot/qwen3-coder:exacto"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen3-coder:exacto");
	});

	test("matches bare colon-bearing model ids without a provider prefix", () => {
		const colonModels = mockColonModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(colonModels, ["qwen3-coder:exacto"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen3-coder:exacto");
		expect(result[0].provider).toBe("github-copilot");
	});

	test("evaluates glob patterns against provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["github-copilot/*"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("github-copilot");
	});
	test("preserves literal :max in enabledModels globs", () => {
		const result = filterAvailableModelsByEnabledPatterns(mockMaxSuffixModels, ["github-copilot/*:max"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("coding-router:max");
	});

	test("evaluates glob patterns against bare model id", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-*"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("applies glob and exact patterns together", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["github-copilot/*", "local/tiny"]);
		expect(result).toHaveLength(2);
	});

	test("returns empty list when no pattern matches (misconfiguration)", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["nonexistent-model"]);
		expect(result).toHaveLength(0);
	});

	test("does not coalesce explicit local provider/id patterns to Copilot (regression for enabledModels)", () => {
		const result = filterAvailableModelsByEnabledPatterns(sharedChatModels, ["local/shared-chat"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("local");
		expect(result[0].id).toBe("shared-chat");
	});
});

describe("explicit provider selectors never reroute to Copilot", () => {
	const chat = roleChainModel("github-copilot", "chat");
	const company = roleChainModel("company", "chat");
	const models = [chat, company];
	const registry = { getAll: () => models, getAvailable: () => models };

	test("an unknown explicit provider fails even when another provider carries its model id", () => {
		expect(resolveModelFromString("unknown-provider/chat", models)).toBeUndefined();
		expect(resolveProviderModelReference("unknown-provider", "chat", models)).toBeUndefined();
		const resolved = resolveCliModel({ cliModel: "unknown-provider/chat", modelRegistry: registry });
		expect(resolved.model).toBeUndefined();
		expect(resolved.error).toBeDefined();
	});

	test("a configured company selector preserves provider identity", () => {
		expect(resolveModelFromString("company/chat", models)).toBe(company);
		expect(resolveCliModel({ cliModel: "company/chat", modelRegistry: registry }).model).toBe(company);
	});

	test("unknown persisted selectors stop before credential probes", () => {
		const hasConfiguredAuth = vi.fn(() => true);
		const savedRegistry = {
			getAll: () => models,
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			hasConfiguredAuth,
		} as unknown as Parameters<typeof resolveSessionModelSelector>[0];
		expect(resolveSessionModelSelector(savedRegistry, "unknown-provider/chat:high")).toBeUndefined();
		expect(hasConfiguredAuth).not.toHaveBeenCalled();
		expect(resolveSessionModelSelector(savedRegistry, "company/chat")?.model).toBe(company);
	});
});

describe("literal model metadata", () => {
	test("keeps @revision as part of a local id, not an upstream route", () => {
		const model = roleChainModel("local", "coder@revision");
		expect(parseModelPattern("local/coder@revision", [model]).model).toBe(model);
		expect(parseModelPattern("coder@revision", [model]).model).toBe(model);
		expect(parseModelPattern("local/coder", [model]).model).toBeUndefined();
	});

	test("does not silently route a retained provider to an upstream", () => {
		expect(parseModelPattern("local/tiny@remote", mockModels).model).toBeUndefined();
	});

	test("live effort-route wire ids resolve to their logical local model", () => {
		const model = buildModel({
			...roleChainModel("local", "reasoner"),
			reasoning: true,
			requestModelId: "reasoner-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Medium, Effort.High],
				effortRouting: { [Effort.Medium]: "reasoner-medium", [Effort.High]: "reasoner-high" },
			},
		});
		expect(resolveProviderModelReference("local", "reasoner-high", [model])).toBe(model);
		expect(resolveProviderModelReference("github-copilot", "reasoner-high", [model])).toBeUndefined();
		const raw = roleChainModel("local", "reasoner-high");
		expect(resolveProviderModelReference("local", "reasoner-high", [model, raw])).toBe(raw);
	});
});

describe("resolveAllowedModels", () => {
	test("applies enabled literal providers without changing local tiny into Copilot chat", async () => {
		const settings = Settings.isolated({ enabledModels: ["local/tiny"] });
		const result = await resolveAllowedModels({ getAvailable: () => mockModels }, settings);
		expect(result).toEqual([mockModels[1]]);
	});
});
