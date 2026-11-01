import { apiRouteFor } from "../compat/behavior";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import {
	DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS,
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../discovery/openai-compatible";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl, ModelSpec } from "../types";
import { discoveryFetch, isRecord, toBoolean, toNumber, toPositiveNumber } from "../utils";
import {
	COPILOT_API_HEADERS,
	COPILOT_DISCOVERY_HEADERS,
	discoverGitHubCopilotApiEndpoint,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	mergeCopilotApiHeaders,
	parseGitHubCopilotApiKey,
} from "../wire/github-copilot";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";
import { resolveModelCacheProviderId } from "./cache-provider-id";

export const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;

function revisionAtLeast(revision: string | undefined, floor: string): boolean {
	if (revision === undefined) return false;
	const parsedRevision = parseRevision(revision);
	const parsedFloor = parseRevision(floor);
	return (
		parsedRevision !== undefined && parsedFloor !== undefined && compareRevision(parsedRevision, parsedFloor) >= 0
	);
}

/**
 * Uses a cancellable timer rather than the native abort-timeout helper so
 * successful fast discovery requests do not leave armed timeout signals for
 * concurrent GC to trip over later.
 */
async function withCatalogDiscoveryTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

// Copilot ids whose cached route predates the Responses pin: a cache written by
// an older build still says openai-completions, which Copilot answers with 400
// unsupported_api_for_model (#7096, #8807, #12901).
const COPILOT_CACHE_INVALIDATED_MODEL_IDS = [
	"gpt-6-astra",
	"gpt-6-astra-1m",
	"grok-4.5",
	"grok-4.5-1m",
	"grok-4.6",
	"grok-4.6-1m",
	"grok-4.7",
	"grok-4.7-1m",
	"mai-code-1-flash-picker",
];

function inferCopilotApi(modelId: string): Api {
	const route = apiRouteFor("github-copilot", modelId);
	if (route?.api === "anthropic-messages" || route?.api === "openai-responses") return route.api;
	return "openai-completions";
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

/** Local id/name suffixes for synthesized Copilot long-context variants. */
export const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
const COPILOT_LONG_CONTEXT_NAME_SUFFIX = " (1M)";

/** One tier of Copilot token pricing (`billing.token_prices.{default,long_context}`). Prices are hundredths of a dollar per 1M tokens. */
interface CopilotTokenPriceTier {
	contextMax?: number;
	inputPrice?: number;
	outputPrice?: number;
	cachePrice?: number;
}

function parseCopilotTokenPriceTier(value: unknown): CopilotTokenPriceTier | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		contextMax: toNumber(value.max_prompt_tokens) ?? toNumber(value.context_max),
		inputPrice: toNumber(value.input_price),
		outputPrice: toNumber(value.output_price),
		cachePrice: toNumber(value.cache_price),
	};
}

/**
 * Tiered context boundaries/prices from `billing.token_prices`. Served only
 * when discovery requests `X-GitHub-Api-Version` ≥ 2026-06-01; absent on the
 * legacy response shape (where `capabilities.limits` is already tier-capped).
 */
function extractCopilotTokenPrices(entry: OpenAICompatibleModelRecord): {
	defaultTier?: CopilotTokenPriceTier;
	longContext?: CopilotTokenPriceTier;
} {
	if (!isRecord(entry.billing)) {
		return {};
	}
	const tokenPrices = entry.billing.token_prices;
	if (!isRecord(tokenPrices)) {
		return {};
	}
	return {
		defaultTier: parseCopilotTokenPriceTier(tokenPrices.default),
		longContext: parseCopilotTokenPriceTier(tokenPrices.long_context),
	};
}

function extractCopilotSupportsVision(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!isRecord(entry.capabilities)) {
		return undefined;
	}
	const supports = entry.capabilities.supports;
	if (!isRecord(supports)) {
		return undefined;
	}
	return toBoolean(supports.vision);
}

/** Copilot's `/models` mixes chat and embedding models; only `type: "chat"` entries are usable here. */
function isCopilotChatModel(entry: OpenAICompatibleModelRecord): boolean {
	if (!isRecord(entry.capabilities)) {
		return true;
	}
	const type = entry.capabilities.type;
	return typeof type !== "string" || type === "chat";
}

function copilotTierCost(
	tier: CopilotTokenPriceTier | undefined,
): Omit<ModelSpec<Api>["cost"], "cacheWrite"> | undefined {
	if (tier?.inputPrice === undefined || tier.outputPrice === undefined) {
		return undefined;
	}
	return {
		input: tier.inputPrice / 100,
		output: tier.outputPrice / 100,
		cacheRead: (tier.cachePrice ?? 0) / 100,
	};
}

/**
 * Synthesize the opt-in long-context sibling for a Copilot model that reports
 * a `billing.token_prices.long_context` tier (e.g. Claude Opus 200k → 1M, as
 * selectable in copilot-cli). The variant is a local catalog entry: it keeps
 * the upstream model id on the wire via `requestModelId` — the tier is purely
 * a client-side context budget with its own pricing, not a served model id.
 * The base entry stays on the default tier so nobody silently pays
 * long-context rates.
 */
function createCopilotLongContextVariant(
	base: ModelSpec<Api>,
	fullContextWindow: number | null,
	maxTokens: number | null,
	longContext: CopilotTokenPriceTier | undefined,
): ModelSpec<Api> | undefined {
	const longContextMax = longContext?.contextMax;
	if (longContextMax === undefined || longContextMax <= 0 || fullContextWindow === null || maxTokens === null) {
		return undefined;
	}
	const variantWindow = Math.min(fullContextWindow, longContextMax + maxTokens);
	if (base.contextWindow === null || variantWindow <= base.contextWindow) {
		return undefined;
	}
	const longCost = copilotTierCost(longContext);
	return {
		...base,
		id: `${base.id}${COPILOT_LONG_CONTEXT_ID_SUFFIX}`,
		requestModelId: base.id,
		name: `${base.name}${COPILOT_LONG_CONTEXT_NAME_SUFFIX}`,
		contextWindow: variantWindow,
		// Long-context tier has its own token prices (Gemini/GPT bill ~2x above
		// the default boundary). cacheWrite is not reported per tier; inherit.
		...(longCost && { cost: { ...longCost, cacheWrite: base.cost.cacheWrite } }),
		contextPromotionTarget: undefined,
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.apiEndpoint && configuredBaseUrl.includes("githubcopilot.com")
			? parsedApiKey.apiEndpoint
			: parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
				? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
				: configuredBaseUrl;
	let providerReferences: Map<string, ModelSpec<Api>> | undefined;
	const getProviderReferences = () => (providerReferences ??= createBundledReferenceMap<Api>("github-copilot"));
	const resolveReference = createReferenceResolver(getProviderReferences);
	return {
		providerId: "github-copilot",
		cacheProviderId: resolveModelCacheProviderId("github-copilot", { apiKey: rawApiKey, baseUrl }),
		// Copilot discovery pre-applies the correct image fallback for omitted
		// `supports.vision`; the live row's modality is authoritative.
		dynamicInputAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: COPILOT_CACHE_INVALIDATED_MODEL_IDS,
		// COPILOT_API_HEADERS are compile-time wire identity constants, not
		// credentials. The cache omits all request headers for
		// safety and can only restore them from a bundled static entry — so a
		// Copilot model with no bundled reference (e.g. a freshly served
		// claude-opus-5 and its synthesized -1m sibling) is dropped on offline
		// reads. Declaring the constant lets the cache restore it by value.
		restorableHeaderFallback: { ...COPILOT_API_HEADERS },
		...(apiKey && {
			fetchDynamicModels: async () => {
				const fetchImpl = discoveryFetch(config?.fetch);
				const requestBaseUrl = isPersonalGitHubCopilotBaseUrl(baseUrl)
					? ((await withCatalogDiscoveryTimeout(DEFAULT_OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS, signal =>
							discoverGitHubCopilotApiEndpoint(apiKey, fetchImpl, signal),
						)) ?? baseUrl)
					: baseUrl;
				const longContextVariants: ModelSpec<Api>[] = [];
				const models = await fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl: requestBaseUrl,
					apiKey,
					headers: COPILOT_DISCOVERY_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): ModelSpec<Api> | null => {
						if (!isCopilotChatModel(entry)) {
							return null;
						}
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						// Copilot exposes token limits under capabilities.limits.*.
						// max_context_window_tokens is the model's total usable window;
						// max_prompt_tokens is Copilot's prompt/summarization budget and
						// must only be a fallback when total-window fields are absent.
						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						const supportsVision = extractCopilotSupportsVision(entry);
						const input: ModelSpec<Api>["input"] =
							supportsVision === true
								? ["text", "image"]
								: supportsVision === false || !isPersonalGitHubCopilotBaseUrl(requestBaseUrl)
									? ["text"]
									: (reference?.input ?? defaults.input);
						// With COPILOT_API_HEADERS the served window is the long-context
						// ceiling; the default tier reports its prompt boundary in
						// token_prices.default.max_prompt_tokens (or legacy context_max).
						// Cap the base entry to the default tier — the long tier is
						// the opt-in `-1m` sibling below. On tiered legacy rows the
						// model-wide max_prompt_tokens may be tighter than the billed
						// default ceiling (#13912), so use the smaller bound.
						const tokenPrices = extractCopilotTokenPrices(entry);
						const billedDefaultMax = tokenPrices.defaultTier?.contextMax;
						const tieredPromptBudget =
							(tokenPrices.longContext?.contextMax ?? 0) > 0 ? (copilotLimits.maxPromptTokens ?? 0) : 0;
						const defaultContextMax =
							tieredPromptBudget > 0 &&
							(billedDefaultMax === undefined || billedDefaultMax <= 0 || tieredPromptBudget < billedDefaultMax)
								? tieredPromptBudget
								: billedDefaultMax;
						const defaultTierWindow =
							defaultContextMax !== undefined &&
							defaultContextMax > 0 &&
							contextWindow !== null &&
							maxTokens !== null
								? Math.min(contextWindow, defaultContextMax + maxTokens)
								: contextWindow;
						const unreferencedIdentity =
							reference === undefined && api === "anthropic-messages"
								? classifyModel("github-copilot", defaults.id, { lenient: true })
								: undefined;
						const base: ModelSpec<Api> = reference
							? {
									...reference,
									api,
									provider: "github-copilot",
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(getProviderReferences().get(defaults.id)?.headers),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: // The bundled row for an id whose route later moved to
											// Responses/Messages still carries this chat-completions
											// block, and `supportsReasoningEffort: false` suppresses
											// the effort dial on a transport that supports it
											// (grok-4.7, #12901). Compat is transport-scoped: let the
											// rules resolve it for the route actually in use.
											{ compat: undefined }),
								}
							: {
									...defaults,
									api,
									baseUrl: requestBaseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: mergeCopilotApiHeaders(),
									// Copilot's `/models` advertises no reasoning bit, so a
									// thinking-capable Claude with no bundled reference would
									// fall back to `reasoning: false` and lose its effort dial.
									// Gate on the id classifier (not the transport alone) so a
									// lagging enterprise catalog serving a pre-thinking Claude
									// (<= 3.5) over the Messages proxy is not handed a fabricated
									// dial it would reject; a modern reference-less model (e.g.
									// claude-opus-5) is marked so `buildModel` derives the ladder.
									...(unreferencedIdentity?.class === "anthropic" &&
									revisionAtLeast(unreferencedIdentity.revision, "3.7")
										? { reasoning: true }
										: {}),
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								};
						// Cross-provider fallback references (e.g. a Cursor
						// collapsed family for an enterprise-only sibling id)
						// carry provider-specific wire routing that must not
						// transfer: the off-tier `requestModelId` pin would send
						// every Copilot request under the `-none` sibling id
						// regardless of thinking level.
						if (reference && reference.provider !== "github-copilot") {
							delete base.requestModelId;
							if (base.thinking) {
								// `base` is a shallow copy of the shared global
								// reference: clone before deleting or the bundled
								// entry loses its routing process-wide.
								base.thinking = { ...base.thinking };
								delete base.thinking.effortRouting;
							}
						}
						const defaultCost = copilotTierCost(tokenPrices.defaultTier);
						if (defaultCost) {
							// Cache writes are not reported per tier; retain the bundled provider rate.
							base.cost = { ...defaultCost, cacheWrite: base.cost.cacheWrite };
						}
						const variant = createCopilotLongContextVariant(
							base,
							contextWindow,
							maxTokens,
							tokenPrices.longContext,
						);
						if (variant) {
							longContextVariants.push(variant);
							// Overflowing the default tier promotes into the 1M sibling
							// unless the reference already pins a target.
							base.contextPromotionTarget ??= `github-copilot/${variant.id}`;
						}
						return base;
					},
					fetch: fetchImpl,
				});
				if (models === null) {
					return null;
				}
				// Append synthesized tiers; a real upstream id always wins over a
				// local variant with the same id.
				const takenIds = new Set(models.map(model => model.id));
				for (const variant of longContextVariants) {
					if (takenIds.has(variant.id)) {
						continue;
					}
					takenIds.add(variant.id);
					models.push(variant);
				}
				return models.sort((left, right) => left.id.localeCompare(right.id));
			},
		}),
	};
}

export {
	fetchLiteLLMRichModels,
	fetchLmStudioNativeModelMetadata,
	isSelectableLiteLLMModelMode,
	litellmModelManagerOptions,
	lmStudioModelManagerOptions,
	normalizeLiteLLMManagementBaseUrl,
	ollamaModelManagerOptions,
	resolveLiteLLMApi,
	vllmModelManagerOptions,
	type FetchLiteLLMRichModelsOptions,
	type LiteLLMModelManagerConfig,
	type LmStudioModelManagerConfig,
	type LmStudioNativeModelMetadata,
	type LmStudioNativeModelMetadataOptions,
	type OllamaModelManagerConfig,
	type VllmModelManagerConfig,
} from "./self-hosted";
