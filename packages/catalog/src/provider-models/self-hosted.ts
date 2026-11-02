import * as logger from "@oh-my-striped-pi/pi-utils/logger";
import { authPolicyFor } from "../compat/auth";
import { isExcludedDiscoveryMode, isLikelyOpenAIResponsesId } from "../compat/behavior";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../discovery/openai-compatible";
import { bareModelId } from "../identity/id";
import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels } from "../models";
import {
	type Api,
	type FetchImpl,
	type ModelKind,
	type ModelSpec,
	type OpenAICompat,
	type Provider,
	runnerApiKind,
} from "../types";
import { discoveryFetch, isRecord, toNumber, toPositiveNumber } from "../utils";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";
import { getDefaultModelDiscoveryBaseUrl, resolveModelCacheProviderId } from "./cache-provider-id";

function discoveryApiKey(provider: string, apiKey: string | undefined): string | undefined {
	if (!apiKey || apiKey === "N/A") return undefined;
	const login = authPolicyFor(provider)?.login;
	return login?.kind === "api-key" && login.emptyFallback === apiKey ? undefined : apiKey;
}

function revisionAtLeast(revision: string | undefined, floor: string): boolean {
	if (revision === undefined) return false;
	const parsedRevision = parseRevision(revision);
	const parsedFloor = parseRevision(floor);
	return (
		parsedRevision !== undefined && parsedFloor !== undefined && compareRevision(parsedRevision, parsedFloor) >= 0
	);
}

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

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	// Generic `/models` rows describe the chat roster. Do not make a bundled
	// runner kind look endpoint-authored merely because its metadata is reused.
	const { kind: _inheritedKind, ...chatReference } = reference;
	return {
		...chatReference,
		id: defaults.id,
		name,
		api: defaults.api,
		provider: defaults.provider,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string) => Promise<OllamaResolvedMetadata>,
	fetchImpl: FetchImpl = discoveryFetch(),
	apiKey?: string,
): Promise<ModelSpec<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<ModelSpec<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: ModelSpec<"openai-responses">[] = resolved.filter(
		(m): m is ModelSpec<"openai-responses"> => m !== null,
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Fallback context window for Ollama models when `/api/show` is unavailable
 * or omits a `model_info.<arch>.context_length` field. Matches the size
 * Ollama's cloud catalog reports for stock models.
 */
const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
/** Cap max output tokens at a value that matches OMSP's other openai-responses defaults. */
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Query Ollama's `/api/show` endpoint for a single model and pull native
 * context and capability metadata from the response. Returns `undefined` when
 * the endpoint is unavailable so callers can layer their own fallback.
 */
async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
	fetchImpl: FetchImpl = discoveryFetch(),
	apiKey?: string,
): Promise<OllamaShowMetadata | undefined> {
	try {
		const response = await fetchImpl(`${nativeBaseUrl}/api/show`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = getOllamaCapabilities(payload.capabilities);
		const contextWindow = getOllamaContextWindow(payload.model_info);
		return {
			contextWindow,
			maxTokens: contextWindow ? OLLAMA_DEFAULT_MAX_TOKENS : undefined,
			capabilities,
			reasoning: capabilities ? capabilities.includes("thinking") : undefined,
			input: capabilities
				? capabilities.includes("vision")
					? (["text", "image"] as Array<"text" | "image">)
					: (["text"] as Array<"text">)
				: undefined,
		};
	} catch {
		// fall through; caller decides on the fallback
	}
	return undefined;
}

/**
 * Build a resolver that fetches `/api/show` metadata per model id and caches
 * the result in-memory for the lifetime of the manager. Successful lookups are
 * cached so repeated `fetchDynamicModels` calls do not refetch; failed
 * lookups stay uncached so a later refresh can recover.
 */
function createOllamaMetadataResolver(
	nativeBaseUrl: string,
	fetchImpl?: FetchImpl,
	apiKey?: string,
): (modelId: string) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return modelId => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId, fetchImpl, apiKey);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW, maxTokens: OLLAMA_DEFAULT_MAX_TOKENS };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? OLLAMA_FALLBACK_CONTEXT_WINDOW,
				maxTokens: metadata.maxTokens ?? OLLAMA_DEFAULT_MAX_TOKENS,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

function isLikelyOpenAIResponsesModelId(
	id: string,
	references?: ReadonlyMap<string, ModelSpec<"openai-responses">>,
): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references?.has(trimmed)) {
		return true;
	}
	return isLikelyOpenAIResponsesId(trimmed);
}

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = discoveryApiKey("ollama", config?.apiKey);
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch, apiKey);
	return {
		providerId: "ollama",
		cacheProviderId: resolveModelCacheProviderId("ollama", { baseUrl }),
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							// The effort ladder is rule-owned (`providers/ollama.kdl`);
							// derived at build time from the reasoning flag.
							model.thinking = undefined;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl, resolveMetadata, config?.fetch, apiKey);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

/** Native LM Studio metadata keyed by model id from `/api/v0/models` and `/api/v1/models`. */
export interface LmStudioNativeModelMetadata {
	input: ("text" | "image")[];
	contextWindow?: number;
	/**
	 * LM Studio reports a decision model (`type: "decision"`): it answers typed
	 * questions on `/v1/decisions` and rejects chat completions.
	 */
	decision?: true;
}

/** Options for LM Studio's optional native metadata probe. */
export interface LmStudioNativeModelMetadataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

const LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250;

function toLmStudioNativeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function getLmStudioCapabilityNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function getLmStudioModelType(entry: Record<string, unknown>): string {
	return typeof entry.type === "string" ? entry.type.toLowerCase() : "";
}

function getLmStudioNativeInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modelType = getLmStudioModelType(entry);
	// A decision model stays `type: "decision"` when it reads images; LM Studio
	// says so through `has_vision_adapter` instead.
	if (modelType === "decision") {
		return entry.has_vision_adapter === true ? ["text", "image"] : ["text"];
	}
	const capabilities = getLmStudioCapabilityNames(entry.capabilities);
	const supportsImage = modelType === "vlm" || capabilities.includes("vision") || capabilities.includes("image");
	return supportsImage ? ["text", "image"] : ["text"];
}

/**
 * Decision models from LM Studio's v1 listing (`GET /api/v1/models`), keyed by
 * model key and by every loaded instance id. The v0 listing predates decision
 * models, so this is where `type: "decision"` is reported.
 */
function getLmStudioV1DecisionModels(payload: unknown): Map<string, LmStudioNativeModelMetadata> {
	const metadata = new Map<string, LmStudioNativeModelMetadata>();
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		return metadata;
	}
	for (const entry of payload.models) {
		if (!isRecord(entry) || getLmStudioModelType(entry) !== "decision") {
			continue;
		}
		const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances.filter(isRecord) : [];
		const loadedContextWindow = instances
			.map(instance => (isRecord(instance.config) ? toPositiveNumber(instance.config.context_length, null) : null))
			.find(window => window !== null);
		const contextWindow = loadedContextWindow ?? toPositiveNumber(entry.max_context_length, null) ?? undefined;
		const model: LmStudioNativeModelMetadata = {
			input: getLmStudioNativeInput(entry),
			...(contextWindow === undefined ? {} : { contextWindow }),
			decision: true,
		};
		const ids = [entry.key, ...instances.map(instance => instance.id)];
		for (const id of ids) {
			if (typeof id === "string" && id.length > 0) {
				metadata.set(id, model);
			}
		}
	}
	return metadata;
}

function getLmStudioNativeContextWindow(entry: Record<string, unknown>): number | undefined {
	// LM Studio serves `loaded_context_length` (the window the running instance
	// actually accepts) alongside `max_context_length` (the architectural
	// ceiling). A model is routinely loaded below its maximum — the user picks a
	// smaller window, or MLX context auto-fit shrinks it to fit unified memory —
	// so prefer what the runtime serves, matching the Ollama/llama.cpp rule from
	// #3754. Unloaded models report `loaded_context_length: null` and fall
	// through to the max/train chain unchanged.
	const loadedContextWindow = entry.state === "loaded" ? toPositiveNumber(entry.loaded_context_length, null) : null;
	return (
		loadedContextWindow ??
		toPositiveNumber(entry.max_context_length, null) ??
		toPositiveNumber(entry.context_length, null) ??
		toPositiveNumber(entry.max_model_len, null) ??
		undefined
	);
}

/**
 * Fetches LM Studio native model metadata used to mark VLM models as
 * image-capable and decision models as judges.
 */
export async function fetchLmStudioNativeModelMetadata(
	baseUrl: string,
	fetchImpl: FetchImpl = fetch,
	options?: LmStudioNativeModelMetadataOptions,
): Promise<Map<string, LmStudioNativeModelMetadata> | null> {
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	const fetchJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
		try {
			const response = await fetchImpl(`${nativeBaseUrl}${path}`, {
				method: "GET",
				headers: { Accept: "application/json", ...options?.headers },
				signal,
			});
			return response.ok ? await response.json() : null;
		} catch {
			return null;
		}
	};
	const fetchMetadata = async (signal?: AbortSignal): Promise<Map<string, LmStudioNativeModelMetadata> | null> => {
		// Builds without the v1 listing answer 404 there and keep v0 metadata alone.
		const [v0, v1] = await Promise.all([fetchJson("/api/v0/models", signal), fetchJson("/api/v1/models", signal)]);
		const decisions = getLmStudioV1DecisionModels(v1);
		if ((!isRecord(v0) || !Array.isArray(v0.data)) && decisions.size === 0) {
			return null;
		}
		const metadata = new Map<string, LmStudioNativeModelMetadata>();
		for (const entry of isRecord(v0) && Array.isArray(v0.data) ? v0.data : []) {
			if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
				continue;
			}
			const contextWindow = getLmStudioNativeContextWindow(entry);
			metadata.set(entry.id, {
				input: getLmStudioNativeInput(entry),
				...(contextWindow === undefined ? {} : { contextWindow }),
				...(getLmStudioModelType(entry) === "decision" ? { decision: true as const } : {}),
			});
		}
		for (const [id, model] of decisions) {
			metadata.set(id, model);
		}
		return metadata;
	};
	if (options?.signal !== undefined) {
		return fetchMetadata(options.signal);
	}
	return withCatalogDiscoveryTimeout(LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS, fetchMetadata);
}

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function lmStudioModelManagerOptions(config?: LmStudioModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = discoveryApiKey("lm-studio", config?.apiKey);
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio");
	return {
		providerId: "lm-studio",
		cacheProviderId: resolveModelCacheProviderId("lm-studio", { baseUrl }),
		fetchDynamicModels: async () => {
			const nativeMetadataPromise = fetchLmStudioNativeModelMetadata(baseUrl, config?.fetch, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			});
			const models = await fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (!models) {
				return models;
			}
			const nativeMetadata = await nativeMetadataPromise;
			if (!nativeMetadata) {
				return models;
			}
			return models.map((model): ModelSpec<Api> => {
				const metadata = nativeMetadata.get(model.id);
				if (!metadata) {
					return model;
				}
				return {
					...model,
					// Decision models answer only on `/v1/decisions` (OpenAI's Decisions API).
					...(metadata.decision
						? { api: "openai-decisions", kind: "judge", reasoning: false, supportsTools: false }
						: {}),
					input: metadata.input,
					contextWindow: metadata.contextWindow ?? model.contextWindow,
				};
			});
		},
	};
}

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
	resolveApi?: (entry: Record<string, unknown>, modelId: string) => TApi;
}

type LiteLLMRichModelEntry = Record<string, unknown>;
type LiteLLMApiRoute = "openai" | "other" | "unknown";
type LiteLLMRichEndpointModel<TApi extends Api> = {
	model: ModelSpec<TApi>;
	apiRoute: LiteLLMApiRoute;
	supportsVision: unknown;
	supportsReasoning: unknown;
	hasContextWindow: boolean;
	hasMaxTokens: boolean;
	hasToolMetadata: boolean;
	hasSupportedOpenAIParams: boolean;
	hasCost: boolean;
	/** Whether an endpoint reported a string `mode`, the only signal that selects a runner api. */
	hasMode: boolean;
	reportedCost: Partial<ModelSpec<Api>["cost"]>;
};
type LiteLLMRichEndpointFailure = {
	endpoint: string;
	reason: "http-status" | "invalid-json" | "invalid-pagination" | "network-error";
	status?: number;
	error?: unknown;
};
type LiteLLMRichEndpointResult<TApi extends Api> =
	| {
			models: LiteLLMRichEndpointModel<TApi>[];
			excludedModelIds: ReadonlySet<string>;
			incompleteVisionMetadata: boolean;
	  }
	| { failure: LiteLLMRichEndpointFailure };

const LITELLM_RICH_ENDPOINTS = ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] as const;
// Bound paginated management responses before trusting their advertised page count.
const LITELLM_MAX_RICH_PAGES = 100;
const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
const UNKNOWN_PROXY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const warnedLiteLLMMetadataBases = new Set<string>();
const LITELLM_UNUSABLE_SENTINEL_IDS: Record<string, true> = {
	"all-team-models": true,
	"all-proxy-models": true,
	"no-default-models": true,
};
function warnLiteLLMMetadataFallback(managementBaseUrl: string, failure: LiteLLMRichEndpointFailure): void {
	if (warnedLiteLLMMetadataBases.has(managementBaseUrl)) {
		return;
	}
	warnedLiteLLMMetadataBases.add(managementBaseUrl);
	logger.warn("LiteLLM rich model metadata unavailable; falling back to /v1/models", {
		endpoint: `${managementBaseUrl}${failure.endpoint}`,
		status: failure.status ?? "unavailable",
		reason: failure.reason,
		...(failure.status === 403
			? { requiredPermission: "Grant this LiteLLM key access to the model metadata endpoints" }
			: {}),
		...(failure.error !== undefined ? { error: failure.error } : {}),
	});
}

/** Exclude only known non-conversational modes; unknown and non-string modes remain selectable for aliases. */
export function isSelectableLiteLLMModelMode(mode: unknown): boolean {
	return typeof mode !== "string" || !isExcludedDiscoveryMode("litellm", mode);
}

export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/g, "");
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}

function normalizeLiteLLMRuntimeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

const LITELLM_RESELLER_USAGE_SUFFIX = /\s+\(\d+(?:\.\d+)?[x×] usage\)$/i;

function stripLiteLLMResellerUsageSuffix(name: string): string {
	const cleaned = name.replace(LITELLM_RESELLER_USAGE_SUFFIX, "").trim();
	return cleaned.length > 0 ? cleaned : name;
}

function toLiteLLMDisplayName(modelName: string | undefined, referenceName: string | undefined, id: string): string {
	const cleanedModelName = modelName ? stripLiteLLMResellerUsageSuffix(modelName) : undefined;
	if (cleanedModelName && cleanedModelName !== id) {
		return cleanedModelName;
	}
	return referenceName ? stripLiteLLMResellerUsageSuffix(referenceName) : id;
}

function mapLiteLLMOpenAICompatibleModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<Api>,
	reference: ModelSpec<Api> | undefined,
): ModelSpec<Api> | null {
	if (!isSelectableLiteLLMModelMode(entry.mode)) {
		return null;
	}
	const model = mapWithBundledReference(entry, defaults, reference);
	const api = resolveLiteLLMApi(entry, model.id);
	return {
		...model,
		api,
		...liteLLMRunnerKind(api),
		name: stripLiteLLMResellerUsageSuffix(model.name),
	};
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function extractLiteLLMRichEntries(payload: unknown): LiteLLMRichModelEntry[] | null {
	if (Array.isArray(payload)) {
		return payload.flatMap(entry => (isRecord(entry) ? [entry] : []));
	}
	if (!isRecord(payload)) {
		return null;
	}
	for (const candidate of [payload.data, payload.models, payload.result, payload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const entries = extractLiteLLMRichEntries(candidate);
		if (entries !== null) {
			return entries;
		}
	}
	return null;
}

function getLiteLLMModelInfo(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.model_info) ? entry.model_info : undefined;
}

function getLiteLLMParams(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.litellm_params) ? entry.litellm_params : undefined;
}

function getLiteLLMMetadataValue(entry: LiteLLMRichModelEntry, key: string): unknown {
	return entry[key] ?? getLiteLLMModelInfo(entry)?.[key];
}
/** Per-million USD cost from a positive `*_per_token` LiteLLM field. */
function getLiteLLMPerMillionCost(entry: LiteLLMRichModelEntry, key: string): number | undefined {
	const perToken = toNumber(getLiteLLMMetadataValue(entry, key));
	return perToken !== undefined && perToken > 0 ? perToken * 1_000_000 : undefined;
}

/** Map positive LiteLLM per-token prices onto their per-million cost fields. */
function getLiteLLMReportedCost(entry: LiteLLMRichModelEntry): Partial<ModelSpec<Api>["cost"]> {
	const input = getLiteLLMPerMillionCost(entry, "input_cost_per_token");
	const output = getLiteLLMPerMillionCost(entry, "output_cost_per_token");
	const cacheRead = getLiteLLMPerMillionCost(entry, "cache_read_input_token_cost");
	const cacheWrite = getLiteLLMPerMillionCost(entry, "cache_creation_input_token_cost");
	return {
		...(input !== undefined ? { input } : {}),
		...(output !== undefined ? { output } : {}),
		...(cacheRead !== undefined ? { cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWrite } : {}),
	};
}

function getLiteLLMCost(entry: LiteLLMRichModelEntry): ModelSpec<Api>["cost"] | undefined {
	const cost = getLiteLLMReportedCost(entry);
	if (cost.input === undefined && cost.output === undefined) {
		return undefined;
	}
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
}

function getLiteLLMRichModelId(entry: LiteLLMRichModelEntry): string | undefined {
	return (
		toNonEmptyString(entry.model_group) ??
		toNonEmptyString(entry.model_name) ??
		toNonEmptyString(entry.id) ??
		toNonEmptyString(getLiteLLMParams(entry)?.model)
	);
}

function getSupportedOpenAIParams(entry: LiteLLMRichModelEntry): string[] | undefined {
	const value = getLiteLLMMetadataValue(entry, "supported_openai_params");
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap(item => (typeof item === "string" ? [item] : []));
}

function getLiteLLMProviders(entry: LiteLLMRichModelEntry): string[] | undefined {
	if (!Array.isArray(entry.providers)) {
		return undefined;
	}
	const providers = entry.providers.flatMap(provider => {
		const normalized = toNonEmptyString(provider)?.toLowerCase();
		return normalized ? [normalized] : [];
	});
	return providers.length > 0 ? providers : undefined;
}

function classifyLiteLLMApiRoute(entry: LiteLLMRichModelEntry | undefined, id: string): LiteLLMApiRoute {
	if (entry) {
		const providers = getLiteLLMProviders(entry);
		if (providers) {
			return providers.every(provider => provider === "openai") ? "openai" : "other";
		}

		const params = getLiteLLMParams(entry);
		const configuredProvider = toNonEmptyString(params?.custom_llm_provider)?.toLowerCase();
		if (configuredProvider) {
			return configuredProvider === "openai" ? "openai" : "other";
		}

		const backendModel = toNonEmptyString(params?.model);
		const backendSeparator = backendModel?.indexOf("/") ?? -1;
		if (backendModel && backendSeparator > 0) {
			return backendModel.slice(0, backendSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}

		const baseModel = toNonEmptyString(getLiteLLMMetadataValue(entry, "base_model"));
		const baseSeparator = baseModel?.indexOf("/") ?? -1;
		if (baseModel && baseSeparator > 0) {
			return baseModel.slice(0, baseSeparator).toLowerCase() === "openai" ? "openai" : "other";
		}
	}

	const modelId = id.toLowerCase().startsWith("openai/") ? id.slice("openai/".length) : id;
	return isLikelyOpenAIResponsesModelId(modelId) ? "openai" : "unknown";
}

/**
 * Transport for a LiteLLM model group: `mode: "decisions"` answers only on the
 * proxy's `/v1/decisions` route, OpenAI-backed groups use Responses, and every
 * other group uses `fallbackApi`.
 */
export function resolveLiteLLMApi(
	entry: Record<string, unknown> | undefined,
	id: string,
	fallbackApi: Api = "openai-completions",
): Api {
	if (entry && getLiteLLMMetadataValue(entry, "mode") === "decisions") {
		return "openai-decisions";
	}
	return classifyLiteLLMApiRoute(entry, id) === "openai" ? "openai-responses" : fallbackApi;
}

/** `kind` a LiteLLM row takes on `api`: runner apis (Decisions → judge) leave the chat roster; chat transports add nothing. */
function liteLLMRunnerKind(api: Api): { kind?: ModelKind } {
	const kind = runnerApiKind(api);
	return kind ? { kind } : {};
}

function isLiteLLMUnusableSentinelPlaceholder(entry: LiteLLMRichModelEntry): boolean {
	const modelGroup = toNonEmptyString(entry.model_group);
	const id = toNonEmptyString(entry.id);
	if (
		(modelGroup === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[modelGroup] !== true) &&
		(id === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true)
	) {
		return false;
	}
	const providers = entry.providers;
	if (providers !== undefined && (!Array.isArray(providers) || providers.length > 0)) {
		return false;
	}
	const modelName = toNonEmptyString(entry.model_name);
	if (modelName && LITELLM_UNUSABLE_SENTINEL_IDS[modelName] !== true) {
		return false;
	}
	if (id && LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true) {
		return false;
	}
	const backendModel = toNonEmptyString(getLiteLLMParams(entry)?.model);
	if (backendModel && LITELLM_UNUSABLE_SENTINEL_IDS[backendModel] !== true) {
		return false;
	}
	if (
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null ||
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null
	) {
		return false;
	}
	if (
		getLiteLLMMetadataValue(entry, "supports_vision") === true ||
		getLiteLLMMetadataValue(entry, "supports_reasoning") === true ||
		getLiteLLMMetadataValue(entry, "supports_function_calling") === true ||
		getLiteLLMMetadataValue(entry, "supports_tools") === true
	) {
		return false;
	}
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	if (supportedOpenAIParams && supportedOpenAIParams.length > 0) {
		return false;
	}
	return true;
}

function mapLiteLLMRichEntry<TApi extends Api>(
	entry: LiteLLMRichModelEntry,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	runtimeBaseUrl: string,
): ModelSpec<TApi> | null {
	if (
		!isSelectableLiteLLMModelMode(getLiteLLMMetadataValue(entry, "mode")) ||
		isLiteLLMUnusableSentinelPlaceholder(entry)
	) {
		return null;
	}
	const id = getLiteLLMRichModelId(entry);
	if (!id) {
		return null;
	}
	const reference = options.referenceResolver?.(id);
	const modelName = toNonEmptyString(entry.model_name);
	const contextWindow = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_input_tokens"),
		reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_output_tokens"),
		reference?.maxTokens ?? Math.min(contextWindow, OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS),
	);
	const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
	const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
	const supportsTools =
		supportsFunctionCalling === true
			? true
			: supportsFunctionCalling === false
				? false
				: supportedOpenAIParams !== undefined
					? supportedOpenAIParams.some(param =>
							["tools", "tool_choice", "functions", "function_call"].includes(param),
						)
					: reference?.supportsTools;
	// Enrich from the bundled reference with provider-INDEPENDENT reasoning
	// hints only. The reference is resolved against the global bundled catalog,
	// so a custom endpoint exposing an alias that collides with a bundled model
	// (a LiteLLM proxy serving `kimi-k3`, which matches Fireworks' bundled
	// `kimi-k3`) must not inherit that provider's transport compat. Spreading
	// the resolved `reference.compat` wholesale leaked `wireModelIdMode`,
	// `toolSchemaFlavor`, `thinkingFormat`, etc. across the provider boundary —
	// rewriting the wire id to `accounts/fireworks/models/kimi-k3` for a
	// non-Fireworks endpoint (issue #9938). `buildModel` re-derives every
	// transport field from the discovered provider and model id, so only the
	// effort vocabulary flows through here. Mirrors `discoverOpenAIModelsList`.
	const referenceCompat = reference?.compat as OpenAICompat | undefined;
	const compat: OpenAICompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		...(supportedOpenAIParams !== undefined
			? { supportsReasoningEffort: supportedOpenAIParams.includes("reasoning_effort") }
			: referenceCompat?.supportsReasoningEffort !== undefined
				? { supportsReasoningEffort: referenceCompat.supportsReasoningEffort }
				: {}),
		...(referenceCompat?.reasoningEffortMap ? { reasoningEffortMap: referenceCompat.reasoningEffortMap } : {}),
		...(referenceCompat?.omitReasoningEffort !== undefined
			? { omitReasoningEffort: referenceCompat.omitReasoningEffort }
			: {}),
		// The deployment is authoritative about its own groups. When its
		// `model_info.supports_vision` says the group reads images, the derived
		// opt-out has to outrank the class-wide text-only guard
		// (`classes/deepseek.kdl`), which keys on the model id alone and would
		// otherwise replace the attachment with `[image omitted: model does not
		// support vision]` for a group the endpoint reads. LiteLLM cannot take a
		// reviewed model list the way OpenRouter or OpenCode Go can — its aliases
		// are chosen per deployment — so the declaration decides.
		// `applyCompatOverrides` runs after the cascade, so this beats the class
		// default; `supports_vision: false` or absent metadata leaves the guard
		// in place. `mergeLiteLLMCompat` keeps it when another endpoint wins the
		// compat merge (issue #11982).
		...(supportsVision === true ? { stripImageInput: false } : {}),
	};
	const api = options.resolveApi?.(entry, id) ?? options.api;
	return {
		id,
		name: toLiteLLMDisplayName(modelName, reference?.name, id),
		api,
		...liteLLMRunnerKind(api),
		provider: options.provider,
		baseUrl: runtimeBaseUrl,
		contextWindow,
		maxTokens,
		input:
			supportsVision === true
				? ["text", "image"]
				: supportsVision === false
					? ["text"]
					: (reference?.input ?? ["text"]),
		reasoning: typeof supportsReasoning === "boolean" ? supportsReasoning : (reference?.reasoning ?? false),
		thinking: reference?.thinking,
		cost: getLiteLLMCost(entry) ?? reference?.cost ?? UNKNOWN_PROXY_COST,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		compat: compat as ModelSpec<TApi>["compat"],
	};
}

/**
 * Field-wise compat union for the management endpoints describing one group.
 *
 * The endpoints are complementary, not ranked: `/model_group/info` reports the
 * gateway's view while `/model/info` and its `/v1` twin report the operator's
 * own `model_info`, and any of them may answer partially. Picking one side
 * wholesale dropped every axis the other had reported — a later endpoint that
 * merely listed `supported_openai_params` erased what an earlier one declared.
 * Merge per axis instead: a later endpoint overrides the axes it reports and
 * leaves the rest alone, so an absent axis means "no news", never "retract".
 */
function mergeLiteLLMCompat<TApi extends Api>(
	existing: ModelSpec<TApi>["compat"],
	next: ModelSpec<TApi>["compat"],
	evidence: { existingReportedParams: boolean; nextReportedParams: boolean },
): ModelSpec<TApi>["compat"] {
	if (!existing) return next;
	if (!next) return existing;
	const merged: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
	for (const axis in next as Record<string, unknown>) {
		const value = (next as Record<string, unknown>)[axis];
		if (value !== undefined) merged[axis] = value;
	}
	// `supportsReasoningEffort` is the one axis with two sources: the endpoint's
	// own `supported_openai_params` list, and the models.dev reference it falls
	// back to when no list was reported. Only the list is evidence, so an
	// inferred value must not override the other endpoint's verdict — a fallback
	// `true` would send `reasoning_effort` to a group whose own metadata omitted
	// it (#11985 review).
	if (!evidence.nextReportedParams) {
		const reported = (existing as Record<string, unknown>).supportsReasoningEffort;
		if (reported === undefined) delete merged.supportsReasoningEffort;
		else merged.supportsReasoningEffort = reported;
	}
	return merged as unknown as ModelSpec<TApi>["compat"];
}

function mergeLiteLLMRichEndpointModels<TApi extends Api>(
	existing: LiteLLMRichEndpointModel<TApi>,
	next: LiteLLMRichEndpointModel<TApi>,
): LiteLLMRichEndpointModel<TApi> {
	const apiRoute =
		existing.apiRoute === "other" || next.apiRoute === "other"
			? "other"
			: existing.apiRoute === "openai" || next.apiRoute === "openai"
				? "openai"
				: "unknown";
	// Only a group's `mode` selects a runner api, and an endpoint omitting the
	// mode carries no news for it, so a runner api reported by either side wins.
	const runnerApi = [next.model.api, existing.model.api].find(api => runnerApiKind(api) !== undefined);
	const api = runnerApi ?? (next.apiRoute === apiRoute ? next.model.api : existing.model.api);
	const model: ModelSpec<TApi> = {
		...existing.model,
		api,
		...liteLLMRunnerKind(api),
		name: next.model.name === next.model.id ? existing.model.name : next.model.name,
		contextWindow: next.hasContextWindow ? next.model.contextWindow : existing.model.contextWindow,
		maxTokens: next.hasMaxTokens ? next.model.maxTokens : existing.model.maxTokens,
		input: next.supportsVision === true || next.supportsVision === false ? next.model.input : existing.model.input,
		reasoning: typeof next.supportsReasoning === "boolean" ? next.model.reasoning : existing.model.reasoning,
		cost: { ...existing.model.cost, ...existing.reportedCost, ...next.reportedCost },
		compat: mergeLiteLLMCompat(existing.model.compat, next.model.compat, {
			existingReportedParams: existing.hasSupportedOpenAIParams,
			nextReportedParams: next.hasSupportedOpenAIParams,
		}),
	};
	if (next.hasToolMetadata) {
		model.supportsTools = next.model.supportsTools;
	}
	return {
		...next,
		apiRoute,
		model,
		reportedCost: { ...existing.reportedCost, ...next.reportedCost },
		hasContextWindow: existing.hasContextWindow || next.hasContextWindow,
		hasMaxTokens: existing.hasMaxTokens || next.hasMaxTokens,
		hasToolMetadata: existing.hasToolMetadata || next.hasToolMetadata,
		hasSupportedOpenAIParams: existing.hasSupportedOpenAIParams || next.hasSupportedOpenAIParams,
		hasCost: existing.hasCost || next.hasCost,
		hasMode: existing.hasMode || next.hasMode,
	};
}

async function fetchLiteLLMRichEndpoint<TApi extends Api>(
	endpoint: string,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	managementBaseUrl: string,
	runtimeBaseUrl: string,
	signal?: AbortSignal,
): Promise<LiteLLMRichEndpointResult<TApi> | null> {
	const fetchImpl = discoveryFetch(options.fetch);
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}
	const fetchPage = async (
		page?: number,
	): Promise<{ payload: unknown; status: number } | { failure: LiteLLMRichEndpointFailure } | null> => {
		let response: Response;
		try {
			response = await fetchImpl(`${managementBaseUrl}${endpoint}${page === undefined ? "" : `?page=${page}`}`, {
				method: "GET",
				headers: requestHeaders,
				signal,
			});
		} catch (error) {
			return { failure: { endpoint, reason: "network-error", error } };
		}
		if (!response.ok) {
			return response.status === 404 && page === undefined
				? null
				: { failure: { endpoint, reason: "http-status", status: response.status } };
		}
		try {
			return { payload: await response.json(), status: response.status };
		} catch (error) {
			return { failure: { endpoint, reason: "invalid-json", status: response.status, error } };
		}
	};
	const firstPage = await fetchPage();
	if (!firstPage || "failure" in firstPage) {
		return firstPage;
	}
	const entries = extractLiteLLMRichEntries(firstPage.payload);
	if (!entries || entries.length === 0) {
		return null;
	}
	// /v2/model/info returns {current_page, total_pages, data}; older
	// endpoints and unpaginated /v2 proxies must keep their existing behavior.
	if (
		endpoint === "/v2/model/info" &&
		isRecord(firstPage.payload) &&
		("current_page" in firstPage.payload || "total_pages" in firstPage.payload)
	) {
		const { current_page: currentPage, total_pages: totalPages, total_count: totalCount } = firstPage.payload;
		const invalidPage = (status: number): LiteLLMRichEndpointResult<TApi> => ({
			failure: { endpoint, reason: "invalid-pagination", status },
		});
		if (
			currentPage !== 1 ||
			typeof totalPages !== "number" ||
			!Number.isSafeInteger(totalPages) ||
			totalPages < 1 ||
			totalPages > LITELLM_MAX_RICH_PAGES ||
			(totalCount !== undefined &&
				(typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < entries.length))
		) {
			return invalidPage(firstPage.status);
		}
		const remainingPages = await Promise.all(
			Array.from({ length: totalPages - 1 }, (_, index) => fetchPage(index + 2)),
		);
		for (const [index, nextPage] of remainingPages.entries()) {
			if (!nextPage || "failure" in nextPage) {
				return nextPage ?? invalidPage(firstPage.status);
			}
			const nextEntries = extractLiteLLMRichEntries(nextPage.payload);
			if (
				!isRecord(nextPage.payload) ||
				nextPage.payload.current_page !== index + 2 ||
				nextPage.payload.total_pages !== totalPages ||
				(totalCount !== undefined && nextPage.payload.total_count !== totalCount) ||
				!nextEntries?.length
			) {
				return invalidPage(nextPage.status);
			}
			entries.push(...nextEntries);
		}
		if (totalCount !== undefined && entries.length !== totalCount) {
			return invalidPage(firstPage.status);
		}
	}
	const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
	const excludedModelIds = new Set<string>();
	for (const entry of entries) {
		if (isLiteLLMUnusableSentinelPlaceholder(entry)) {
			continue;
		}
		const modelId = getLiteLLMRichModelId(entry);
		if (!isSelectableLiteLLMModelMode(getLiteLLMMetadataValue(entry, "mode"))) {
			if (modelId) {
				excludedModelIds.add(modelId);
				deduped.delete(modelId);
			}
			continue;
		}
		if (modelId && excludedModelIds.has(modelId)) {
			continue;
		}
		const model = mapLiteLLMRichEntry(entry, options, runtimeBaseUrl);
		if (model) {
			const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
			const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
			const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
			const supportedOpenAIParams = getSupportedOpenAIParams(entry);
			const next: LiteLLMRichEndpointModel<TApi> = {
				model,
				apiRoute: classifyLiteLLMApiRoute(entry, model.id),
				supportsVision,
				supportsReasoning,
				hasContextWindow: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null,
				hasMaxTokens: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null,
				hasToolMetadata:
					supportsFunctionCalling === true ||
					supportsFunctionCalling === false ||
					supportedOpenAIParams !== undefined,
				hasSupportedOpenAIParams: supportedOpenAIParams !== undefined,
				hasCost: getLiteLLMCost(entry) !== undefined,
				hasMode: typeof getLiteLLMMetadataValue(entry, "mode") === "string",
				reportedCost: getLiteLLMReportedCost(entry),
			};
			const existing = deduped.get(model.id);
			deduped.set(model.id, existing ? mergeLiteLLMRichEndpointModels(existing, next) : next);
		}
	}
	if (deduped.size === 0 && excludedModelIds.size === 0) {
		return null;
	}
	const models = Array.from(deduped.values()).sort((left, right) => left.model.id.localeCompare(right.model.id));
	return {
		models,
		excludedModelIds,
		incompleteVisionMetadata: models.some(entry => entry.supportsVision !== true && entry.supportsVision !== false),
	};
}

async function fetchLiteLLMRichModelsInternal<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const managementBaseUrl = normalizeLiteLLMManagementBaseUrl(options.baseUrl);
	const runtimeBaseUrl = normalizeLiteLLMRuntimeBaseUrl(options.baseUrl);
	if (!managementBaseUrl || !runtimeBaseUrl) {
		return null;
	}
	const fetchModels = async (signal?: AbortSignal): Promise<ModelSpec<TApi>[] | null> => {
		const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
		const excludedModelIds = new Set<string>();
		let metadataFailure: LiteLLMRichEndpointFailure | undefined;
		for (const endpoint of LITELLM_RICH_ENDPOINTS) {
			const result = await fetchLiteLLMRichEndpoint(endpoint, options, managementBaseUrl, runtimeBaseUrl, signal);
			if (!result) {
				continue;
			}
			if ("failure" in result) {
				// A 401 is a retryable auth failure owned by the caller's auth-retry
				// path (withAuth refresh/sibling rotation in discoverLiteLLMModels);
				// recording it here would log a fallback warning on a stale first
				// credential before the refreshed retry ultimately serves rich
				// metadata. Forbidden (403) and other failures are never retried, so
				// they remain warn-worthy and keep priority.
				if (
					result.failure.status !== 401 &&
					(!metadataFailure || (metadataFailure.status !== 403 && result.failure.status === 403))
				) {
					metadataFailure = result.failure;
				}
				continue;
			}
			for (const modelId of result.excludedModelIds) {
				excludedModelIds.add(modelId);
				deduped.delete(modelId);
			}
			const hadPriorModels = deduped.size > 0;
			for (const next of result.models) {
				if (excludedModelIds.has(next.model.id)) {
					continue;
				}
				const existing = deduped.get(next.model.id);
				if (!existing) {
					if (!hadPriorModels) {
						deduped.set(next.model.id, next);
					}
					continue;
				}
				deduped.set(next.model.id, mergeLiteLLMRichEndpointModels(existing, next));
			}
			if (deduped.size === 0) {
				continue;
			}
			let needsMoreMetadata = false;
			for (const entry of deduped.values()) {
				if (
					(entry.supportsVision !== true && entry.supportsVision !== false) ||
					(options.resolveApi !== undefined && (entry.apiRoute === "unknown" || !entry.hasMode)) ||
					(Object.keys(entry.reportedCost).length > 0 &&
						(entry.reportedCost.input === undefined ||
							entry.reportedCost.output === undefined ||
							entry.reportedCost.cacheRead === undefined ||
							entry.reportedCost.cacheWrite === undefined))
				) {
					needsMoreMetadata = true;
					break;
				}
			}
			if (!needsMoreMetadata) {
				break;
			}
		}
		if (deduped.size === 0) {
			if (excludedModelIds.size > 0) {
				return [];
			}
			if (metadataFailure) {
				warnLiteLLMMetadataFallback(managementBaseUrl, metadataFailure);
			}
			return null;
		}
		return Array.from(deduped.values())
			.map(entry => entry.model)
			.sort((left, right) => left.id.localeCompare(right.id));
	};
	if (options.signal !== undefined) {
		return fetchModels(options.signal);
	}
	return options.timeoutMs !== undefined ? withCatalogDiscoveryTimeout(options.timeoutMs, fetchModels) : fetchModels();
}

export async function fetchLiteLLMRichModels<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	return fetchLiteLLMRichModelsInternal(options);
}

export function litellmModelManagerOptions(config?: LiteLLMModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = discoveryApiKey("litellm", config?.apiKey);
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("litellm")!;
	return {
		providerId: "litellm",
		// Versioned metadata mapping keeps warm caches from retaining obsolete
		// routes, partial pagination, or another provider's transport policy.
		cacheProviderId: resolveModelCacheProviderId("litellm", { baseUrl }),
		// Never fetch a public metadata service while discovering a private proxy.
		fetchDynamicModels: async () => {
			const providerReferences = createBundledReferenceMap<Api>("litellm");
			const resolveReference = createReferenceResolver(providerReferences);
			const richModels = await fetchLiteLLMRichModels<Api>({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
				referenceResolver: resolveReference,
				resolveApi: resolveLiteLLMApi,
				timeoutMs: 10_000,
			});
			const models =
				richModels ??
				(await fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "litellm",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) =>
						mapLiteLLMOpenAICompatibleModel(entry, defaults, resolveReference(defaults.id)),
					fetch: config?.fetch,
				}));
			// Bare catalog names can label proxy namespaces, but their pricing,
			// limits and request routing must never enrich a different deployment.
			if (models === null) return null;
			return models.map(model => {
				const name = toLiteLLMDisplayName(model.name, resolveReference(bareModelId(model.id))?.name, model.id);
				return name === model.name ? model : { ...model, name };
			});
		},
	};
}

const VLLM_DISCOVERY_TIMEOUT_MS = 10_000;

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = discoveryApiKey("vllm", config?.apiKey);
	const baseUrl = config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!;
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		cacheProviderId: resolveModelCacheProviderId("vllm", { baseUrl }),
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
					const identity = classifyModel("vllm", model.id, { lenient: true });
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
						// vLLM's /v1/models reports no reasoning capability. Qwen 3.8+
						// open weights always think (the template cannot disable it), so
						// light up the effort dial; buildModel derives the template
						// ladder from the id + local-backend compat.
						reasoning:
							model.reasoning || (identity.class === "qwen" && revisionAtLeast(identity.revision, "3.8")),
					};
				},
				fetch: config?.fetch,
				timeoutMs: VLLM_DISCOVERY_TIMEOUT_MS,
			}),
	};
}
