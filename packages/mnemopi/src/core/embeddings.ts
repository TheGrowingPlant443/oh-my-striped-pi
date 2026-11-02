import { mkdirSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { type ApiKey, withAuth } from "@oh-my-striped-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-striped-pi/pi-ai/error";
import { $env, $flag, fetchWithRetry, getFastembedCacheDir, logger, withLoopPhase } from "@oh-my-striped-pi/pi-utils";
import { LRUCache } from "@oh-my-striped-pi/pi-utils/lru";
import type { EmbeddingModel } from "fastembed";
import { loadFastembed, withEmbedSessionBudget } from "./fastembed-runtime";
import {
	type EmbeddingOutput,
	getMnemopiRuntimeOptions,
	mnemopiDebugEnabled,
	resolveEmbeddingProvider,
} from "./runtime-options";
import { clipToWindow, DEFAULT_INPUT_CHARS } from "./text-window";

export type { EmbeddingOutput } from "./runtime-options";
export { cosineSimilarity } from "./vector-math";

export type Vector = Float32Array;
export type EmbeddingMatrix = Vector[];

export interface EmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export type StandardEmbeddingModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

export interface LocalEmbeddingModel {
	embed(texts: string[], batchSize?: number): EmbeddingOutput;
	queryEmbed?(query: string): Promise<number[]>;
}

export type LocalModelInitOptions = {
	model: StandardEmbeddingModel;
	cacheDir?: string;
	showDownloadProgress?: boolean;
};
export type LocalModelInitializer = (options: LocalModelInitOptions) => Promise<LocalEmbeddingModel>;

const QUERY_CACHE_MAX = 512;

let providerOverride: EmbeddingProvider | null = null;
let localModelPromise: Promise<LocalEmbeddingModel> | null = null;
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
const queryCache = new LRUCache<string, Vector>({ max: QUERY_CACHE_MAX });

// Provider identity table for the cache key. Each unique `provider` object/function
// (configured via `withMnemopiRuntimeOptions`) gets a stable integer id so the cache
// scope reflects the runtime's actual embedding source. Two Mnemopi instances in the
// same process using different providers/models hash to disjoint keys and never
// collide on the same query text. `0` is the sentinel for "env-default fallback".
const providerIds = new WeakMap<object, number>();
let nextProviderId = 1;

/**
 * Quarantine the exact ONNX file named by a "Protobuf parsing failed" init
 * error. A truncated cached model blocks local embeddings forever: the
 * downloader treats the existing file as complete, so every init re-parses
 * the same broken bytes. The extracted path is error-message CONTENT, so it
 * is only honored when it resolves inside the fastembed cache directory —
 * never rename an arbitrary file a dependency happens to mention. Atomic
 * rename; losing a concurrent-heal race (file already renamed/removed)
 * still returns true because a retry is safe either way.
 * @internal exported for tests
 */
export async function quarantineCorruptModelFile(message: string, cacheDir?: string): Promise<boolean> {
	const match = /Load model from (.+?\.onnx) failed:.*Protobuf parsing failed/i.exec(message);
	if (!match) return false;
	const modelFile = nodePath.resolve(match[1]);
	const cacheRoot = nodePath.resolve(cacheDir ?? getFastembedCacheDir());
	if (!modelFile.startsWith(cacheRoot + nodePath.sep)) return false;
	try {
		await fsp.rename(modelFile, `${modelFile}.corrupt-${Date.now()}`);
		logger.warn("mnemopi: quarantined corrupt local embedding model; retrying init", { modelFile });
	} catch {
		// Concurrent heal or vanished file: the single retry stays safe. A
		// rename that failed with the file still in place just makes the
		// retry surface the original error again.
	}
	return true;
}

/**
 * Shared local-model initializer: FlagEmbedding.init with a corrupt-cache heal.
 * A corrupt model blob (Protobuf parse failure) quarantines the file and
 * retries once; fastembed re-downloads any file missing from the model's
 * cache directory. Also the initializer the embed worker uses in its
 * subprocess; the in-process seam stays {@link setLocalModelInitializer}.
 *
 * The ONNX sessions fastembed builds here from the model cache carry the
 * embedding thread budget ({@link withEmbedSessionBudget}); it is off again by
 * the time this returns, and never touches a session built from anywhere else,
 * so a consumer sharing the same onnxruntime copy keeps its own defaults.
 */
export async function defaultLocalModelInitializer(options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	const cacheDir = options.cacheDir ?? getFastembedCacheDir();
	const initOptions = options.cacheDir === undefined ? { ...options, cacheDir } : options;
	const { FlagEmbedding } = await loadFastembed();
	return withEmbedSessionBudget(cacheDir, async () => {
		try {
			return await FlagEmbedding.init(initOptions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/Protobuf parsing failed/i.test(message) && (await quarantineCorruptModelFile(message, cacheDir))) {
				return FlagEmbedding.init(initOptions);
			}
			throw error;
		}
	});
}

function activeEmbeddingOptions() {
	return getMnemopiRuntimeOptions()?.embeddings;
}

/**
 * Compose the per-query cache key. Includes the active provider's identity, the
 * resolved model name, so two `Mnemopi` instances in the same
 * process that use different providers/models never share a cached query
 * vector. Provider identity comes from `providerIds` (WeakMap-assigned integer);
 * `0` is the sentinel for "no provider configured, fall back to env defaults".
 */
function queryCacheKey(text: string): string {
	const active = activeEmbeddingOptions();
	const provider = active?.provider as object | undefined;
	let providerId = 0;
	if (provider !== undefined) {
		const existing = providerIds.get(provider);
		if (existing === undefined) {
			providerId = nextProviderId++;
			providerIds.set(provider, providerId);
		} else {
			providerId = existing;
		}
	}
	const model = defaultModel();
	return `${providerId}::${model}::${embeddingBaseUrl()}::${text}`;
}

function inTestRuntime(): boolean {
	return $env.NODE_ENV === "test" || $env.BUN_ENV === "test";
}

export function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return $flag("MNEMOPI_NO_EMBEDDINGS");
}

/**
 * Resolved per-input character cap for {@link embed}.
 *
 * Reads (in order): the active runtime scope's `embeddings.maxInputChars`, then
 * `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS`, then the bundled `8192` default. `0`
 * disables the cap entirely.
 */
function effectiveMaxInputChars(): number {
	const override = activeEmbeddingOptions()?.maxInputChars;
	if (override !== undefined) return Math.max(0, Math.trunc(override));
	const envValue = Number.parseInt($env.MNEMOPI_EMBEDDING_MAX_INPUT_CHARS ?? "", 10);
	if (Number.isFinite(envValue) && envValue >= 0) return envValue;
	return DEFAULT_INPUT_CHARS;
}

/**
 * Clip every input to {@link effectiveMaxInputChars} so a runaway retention
 * transcript can't blow past the embedding model's context window. Uses a
 * head/tail split via {@link clipToWindow} so the embedding still sees the
 * tail of the conversation (where the latest topic shifts live) and not just
 * the stale prefix. Returns the original array when no input needs trimming
 * (the common case); the new array is allocated only when at least one input
 * is oversized so we don't churn arrays for the typical short-query path
 * through `embedQuery`. Emits one debug-or-warn log per call summarizing how
 * many inputs were trimmed and by how much — silent truncation was the
 * original bug (#3126).
 */
function capInputs(texts: readonly string[]): readonly string[] {
	const max = effectiveMaxInputChars();
	if (max === 0) return texts;
	let trimmed: string[] | null = null;
	let trimmedCount = 0;
	let maxOriginalLen = 0;
	for (let i = 0; i < texts.length; i++) {
		const text = texts[i] ?? "";
		if (text.length <= max) continue;
		if (trimmed === null) trimmed = texts.slice() as string[];
		trimmed[i] = clipToWindow(text, max);
		trimmedCount++;
		if (text.length > maxOriginalLen) maxOriginalLen = text.length;
	}
	if (trimmed === null) return texts;
	logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: embedding input truncated", {
		inputCount: texts.length,
		trimmedCount,
		maxOriginalLen,
		maxInputChars: max,
	});
	return trimmed;
}

function embeddingApiKey(): ApiKey {
	return activeEmbeddingOptions()?.apiKey ?? $env.MNEMOPI_EMBEDDING_API_KEY ?? "";
}

function embeddingBaseUrl(): string {
	return (activeEmbeddingOptions()?.apiUrl ?? $env.MNEMOPI_EMBEDDING_API_URL ?? "").trim().replace(/\/+$/, "");
}

function defaultModel(): string {
	const active = activeEmbeddingOptions();
	if (active?.model !== undefined) {
		return active.model;
	}
	return $env.MNEMOPI_EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";
}

/**
 * Resolve the embedding model name for the currently active runtime scope.
 *
 * Reads (in order): the active provider's `model` from `withMnemopiRuntimeOptions`,
 * the `MNEMOPI_EMBEDDING_MODEL` env var, then the bundled fastembed default. Stored
 * alongside each row in `memory_embeddings.model` so migrations can re-embed when
 * the active model changes.
 */
export function currentEmbeddingModel(): string {
	return defaultModel();
}

const MODEL_DIMS: Record<string, number> = {
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
	"BAAI/bge-small-zh-v1.5": 512,
	"BAAI/bge-base-zh-v1.5": 768,
	"BAAI/bge-large-zh-v1.5": 1024,
	"intfloat/multilingual-e5-small": 384,
	"intfloat/multilingual-e5-base": 768,
	"intfloat/multilingual-e5-large": 1024,
	"BAAI/bge-m3": 1024,
	"BAAI/bge-multilingual-gemma2": 3584,
	"openai/text-embedding-3-small": 1536,
	"openai/text-embedding-3-large": 3072,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"jina-embeddings-v5-omni-nano": 768,
	"jina-embeddings-v5-omni-small": 1024,
};
export function embeddingDimFor(modelName: string): number {
	const override = Number.parseInt($env.MNEMOPI_EMBEDDING_DIM ?? "", 10);
	if (Number.isFinite(override)) {
		return override;
	}
	return MODEL_DIMS[modelName] ?? 384;
}

/** Drain an embedding stream (a custom provider or fastembed) into a `Float32Array` matrix. */
async function collectMatrix(batches: EmbeddingOutput): Promise<EmbeddingMatrix> {
	const rows: Vector[] = [];
	for await (const batch of batches) {
		withLoopPhase("mnemopi.embed", () => {
			for (const row of batch) {
				rows.push(new Float32Array(row));
			}
		});
	}
	return rows;
}

const KNOWN_MODEL_NAMES: Record<string, string> = {
	"BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
	"BAAI/bge-small-en": "fast-bge-small-en",
	"BAAI/bge-base-en": "fast-bge-base-en",
	"BAAI/bge-small-zh-v1.5": "fast-bge-small-zh-v1.5",
	"intfloat/multilingual-e5-large": "fast-multilingual-e5-large",
	"sentence-transformers/all-MiniLM-L6-v2": "fast-all-MiniLM-L6-v2",
};
/** The bundled fastembed model id for a model name, or `null` when fastembed has no local model for it. */
export function fastembedModelName(modelName: string): StandardEmbeddingModel | null {
	// Fastembed `EmbeddingModel` enum string values, inlined so resolving a model name
	// (and `available()`) never imports `fastembed` — its module eagerly loads the
	// `onnxruntime-node` native addon, which segfaults in some runtimes.
	const id = KNOWN_MODEL_NAMES[modelName];
	return id === undefined ? null : (id as StandardEmbeddingModel);
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	if (embeddingBaseUrl() !== "" || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}
	if (localModelPromise !== null) {
		return localModelPromise;
	}

	const modelName = fastembedModelName(defaultModel());
	if (modelName === null) {
		return null;
	}
	const cacheDir = getFastembedCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const loading = localModelInitializer({
		model: modelName,
		cacheDir,
		showDownloadProgress: false,
	});
	localModelPromise = loading;
	try {
		return await loading;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding model failed to load", {
			model: modelName,
			error: String(error),
		});
		if (localModelPromise === loading) localModelPromise = null;
		return null;
	}
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	if (!baseUrl) return null;
	const body = JSON.stringify({ model: defaultModel(), input: texts });
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("Mnemopi embedding endpoint must use HTTP(S).");
		const response = await withAuth(embeddingApiKey(), async key => {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (key !== "") headers.Authorization = `Bearer ${key}`;
			const res = await fetchWithRetry(`${baseUrl}/embeddings`, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(30000),
				maxAttempts: 3,
				defaultDelayMs: attempt => 2 ** attempt * 1000,
			});
			if (res.status === 401)
				throw new ProviderHttpError("mnemopi embedding request unauthorized (401)", 401, { headers: res.headers });
			return res;
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
		if (!Array.isArray(data.data) || data.data.length !== texts.length) return null;
		const rows = data.data;
		if (rows.every(row => Number.isInteger(row.index))) rows.sort((a, b) => a.index! - b.index!);
		if (
			rows.some(
				row =>
					!Array.isArray(row.embedding) ||
					row.embedding.length === 0 ||
					row.embedding.some(value => !Number.isFinite(value)),
			)
		)
			return null;
		const dimensions = rows[0]?.embedding.length;
		if (rows.some(row => row.embedding.length !== dimensions)) return null;
		return withLoopPhase("mnemopi.embed", () => rows.map(row => new Float32Array(row.embedding)));
	} catch (error) {
		logger.debug("mnemopi embedding request failed", { error: String(error) });
		return null;
	}
}

async function providerAvailable(provider: EmbeddingProvider): Promise<boolean> {
	if (provider.available === undefined) {
		return true;
	}
	try {
		return await provider.available();
	} catch {
		return false;
	}
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCache.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	localModelPromise = null;
	queryCache.clear();
}

/**
 * Override the function used to construct the local fastembed model the next
 * time `embed()` is called. Lets a host (e.g. the agent CLI) keep
 * `onnxruntime-node` out of its own address space by routing every fastembed
 * load + inference through a dedicated subprocess. Same wipe semantics as the
 * `*ForTests` form: clears the cached model promise and the query cache so
 * subsequent embeds run through the new initializer immediately.
 */
export const setLocalModelInitializer = setLocalModelInitializerForTests;

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelPromise = null;
	localModelInitializer = defaultLocalModelInitializer;
	queryCache.clear();
}

export const resetEmbeddingStateForTests = resetEmbeddingProviderForTests;

export async function available(): Promise<boolean> {
	if (embeddingsDisabled()) {
		return false;
	}
	const active = activeEmbeddingOptions();
	const activeProvider = resolveEmbeddingProvider(active?.provider);
	if (activeProvider !== undefined) {
		return providerAvailable(activeProvider);
	}
	if (providerOverride !== null) {
		return providerAvailable(providerOverride);
	}
	if (embeddingBaseUrl() !== "") return true;
	if (inTestRuntime()) {
		return false;
	}
	return fastembedModelName(defaultModel()) !== null;
}

export async function embedQuery(text: string): Promise<Vector | null> {
	if (text === "" || embeddingsDisabled()) {
		return null;
	}
	const key = queryCacheKey(text);
	const cached = queryCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const vectors = await embed([text]);
	const vector = vectors?.[0] ?? null;
	if (vector !== null) {
		queryCache.set(key, vector);
	}
	return vector;
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	texts = capInputs(texts);
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider);
	if (activeProvider !== undefined) {
		try {
			return await collectMatrix(await activeProvider.embed(texts));
		} catch {
			return null;
		}
	}
	if (providerOverride !== null) {
		try {
			return await collectMatrix(await providerOverride.embed(texts));
		} catch {
			return null;
		}
	}
	if (texts.length === 1) {
		const key = queryCacheKey(texts[0] ?? "");
		const cached = queryCache.get(key);
		if (cached !== undefined) {
			return [cached];
		}
	}
	if (embeddingBaseUrl() !== "") return embedApi(texts);
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	try {
		const vectors = await withLoopPhase("mnemopi.embed", () => collectMatrix(model.embed([...texts])));
		if (vectors.length === 1) {
			const vector = vectors[0];
			if (vector !== undefined) {
				queryCache.set(queryCacheKey(texts[0] ?? ""), vector);
			}
		}
		return vectors;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding failed", {
			textCount: texts.length,
			error: String(error),
		});
		return null;
	}
}

export const DEFAULT_MODEL = defaultModel();
export const EMBEDDING_DIM = embeddingDimFor(DEFAULT_MODEL);
