/** Typed judgments through local, configured native, or chat-backed judge roles. */
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	recordJudgmentTelemetry,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import {
	type Answer,
	type BoxEdges,
	checkBoxQuestions,
	createNativeJudge,
	type ImageContent,
	isJudgmentApi,
	nativeJudgmentAcceptsImages,
	nativeJudgmentImageBounds,
	nativeJudgmentSupportsBoxes,
	nativeJudgmentSupportsImages,
	type NativeJudge,
	type Question,
	tokenUsage,
	type AssistantMessage,
	chatTextBackend,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Model,
	type Questions,
	type TextBackend,
	type TextCompletion,
	type TextPrompt,
	TextJudge,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isEmbeddedImageContent } from "@oh-my-pi/pi-ai/judgment";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { normalizeModelContextImages } from "../utils/image-loading";
import { type FittedImage, fitImage } from "../utils/image-resize";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveRoleChain, type RoleChainCandidate } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { CostGate } from "../session/cost-gate";
import type { SessionManager } from "../session/session-manager";
import { getTinyLocalModelSpec } from "../tiny/models";
import localPromptTemplate from "../prompts/system/judgment-local.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";
import type { JudgmentCache } from "./cache";

export * from "./cache";

/** Usage of one billed judgment attempt, recorded on the session ledger by callers. */
export interface JudgmentUsage {
	/** Why the judgment ran; see {@link JudgeDeps.purpose}. */
	purpose: string;
	/** Model role used for this judgment. */
	role: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
}

export interface JudgeDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** The session's active model, appended when the judge role does not already route to it. */
	sessionModel?: Model;
	sessionId?: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Why the judgment runs (`find`, `ttsr`, `judge_batch`, …); labels ledger entries and telemetry spans. */
	purpose: string;
	/** Receives every billed attempt, including failures, for the session ledger. */
	onUsage?: (usage: JudgmentUsage) => void;
	/** Host telemetry; every billed attempt emits one `judgment` span. */
	telemetry?: AgentTelemetryConfig;
	/** Local answer cache for native protocols; absent means no cache. */
	cache?: JudgmentCache;
	/** The session tree's cost gate: refuses each candidate attempt at the cap and adds billed attempts' cost. */
	costGate?: CostGate;
}

/** One backend attempt before its purpose is stamped by the role chain. */
interface JudgmentAttempt extends Omit<JudgmentUsage, "purpose"> {
	startedAt: number;
	responseModel?: string;
	questions?: number;
	cachedQuestions?: number;
}

/** Session journal surface that records off-transcript model cost; journal-only managers omit it. */
export type JudgmentUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

function isUsageLedger(manager: Partial<JudgmentUsageLedger>): manager is JudgmentUsageLedger {
	return (
		manager.appendModelUsage !== undefined && manager.getSessionId !== undefined && manager.getLeafId !== undefined
	);
}

/**
 * Build a {@link JudgeDeps.onUsage} that journals every billed judgment attempt
 * as a `model_usage` entry beneath the session leaf at record time, so
 * `getSessionStats()` counts it in session totals. Attempts that land after
 * the session changes are dropped by the ledger. Returns `undefined` when the
 * journal cannot record usage.
 */
export function journalJudgmentUsage(manager: Partial<JudgmentUsageLedger> | undefined): JudgeDeps["onUsage"] {
	if (!manager || !isUsageLedger(manager)) return undefined;
	const sessionId = manager.getSessionId();
	return usage => {
		manager.appendModelUsage(usage, { sessionId, parentId: manager.getLeafId() });
	};
}

/** One keyword per answer; OpenAI-compatible endpoints reject budgets below 16. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning models need room for the keyword after their `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;

/**
 * How long a candidate stays skipped after its account rejected a judgment
 * outright (401/403 credential, 402 billing cap). Every judgment rebuilds the
 * chain, so without this each call re-pays the rejected request plus a
 * credential-rotation round trip before reaching the next candidate.
 */
const CANDIDATE_REJECTION_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * How long a resolved role chain is reused. Resolution filters the full
 * catalog (thousands of models) synchronously — milliseconds per call, which a
 * concurrent fan-out turns into sustained event-loop stalls. The chain is
 * shared by every judge built over the same settings and registry, since
 * per-call consumers (auto-thinking, subagent starts) resolve a fresh judge.
 */
const CANDIDATE_TTL_MS = 1_000;
/** Skip-until timestamps keyed by routed model identity, carried by the registry that produced the rejection. */
const kRejections = Symbol("judgment.rejections");
/** Last resolved judge role chain, carried by the registry it was drawn from. */
const kRoleChain = Symbol("judgment.roleChain");
interface RegistryWithRejections extends ModelRegistry {
	[kRejections]?: Map<string, number>;
	[kRoleChain]?: {
		settings: Settings;
		revision: number;
		roleChain: RoleChainCandidate[];
		list: RoleChainCandidate[];
		expiresAt: number;
	};
}

/** Reuse the resolved role chain briefly across bulk judgment requests. */
function cachedJudgeRoleChain(
	settings: Settings,
	registry: RegistryWithRejections,
): { roleChain: RoleChainCandidate[]; list: RoleChainCandidate[] } {
	const now = Date.now();
	const revision = settings.revision;
	const cached = registry[kRoleChain];
	if (cached && cached.settings === settings && cached.revision === revision && now < cached.expiresAt) {
		return cached;
	}
	const roleChain = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry));
	const entry = {
		settings,
		revision,
		roleChain,
		list: textJudgeRoleChain(roleChain),
		expiresAt: now + CANDIDATE_TTL_MS,
	};
	registry[kRoleChain] = entry;
	return entry;
}

/** Append a compatible session model when the role does not already route to it. */
function withSessionFallback(
	candidates: RoleChainCandidate[],
	sessionModel: Model | undefined,
	requiresImages = false,
): RoleChainCandidate[] {
	if (
		!sessionModel ||
		candidates.some(candidate => kindOf(candidate) === "native") ||
		(requiresImages && !supportsImageJudgment(sessionModel))
	) {
		return candidates;
	}
	const sessionIdentity = formatModelStringWithRouting(sessionModel);
	if (candidates.some(candidate => formatModelStringWithRouting(candidate.model) === sessionIdentity)) {
		return candidates;
	}
	return [...candidates, { model: sessionModel, explicit: false }];
}

/** Native protocols, on-device keywords, or prompted chat judgments. */
export type JudgeKind = "native" | "local" | "online";

/** Classify a role candidate by model API, never by provider identity. */
export function kindOf(candidate: RoleChainCandidate): JudgeKind;
export function kindOf(model: Model): JudgeKind;
export function kindOf(value: RoleChainCandidate | Model): JudgeKind {
	const model = "model" in value ? value.model : value;
	if (isJudgmentApi(model.api)) return "native";
	if (model.api === "local-inference") return "local";
	return "online";
}

/** Whether the model's actual judgment transport sends image input. */
function supportsImageJudgment(model: Model): boolean {
	switch (kindOf(model)) {
		case "native":
			return nativeJudgmentSupportsImages(model);
		case "local":
			return false;
		case "online":
			return sendsImageInputOnWire(model);
	}
}

/** A prompted model must not replace a native judge's calibrated probabilities. */
function textJudgeRoleChain(chain: RoleChainCandidate[]): RoleChainCandidate[] {
	const firstNative = chain.findIndex(candidate => kindOf(candidate) === "native");
	return firstNative < 0
		? chain
		: chain.filter((candidate, index) => index < firstNative || kindOf(candidate) === "native");
}

function nativeTakesImages(model: Model, images: readonly ImageContent[]): boolean {
	const bounds = nativeJudgmentImageBounds(model);
	return bounds !== undefined && images.length <= (bounds.maxCount ?? images.length);
}

function imageJudgeRoleChain(chain: RoleChainCandidate[], images: readonly ImageContent[]): RoleChainCandidate[] {
	return textJudgeRoleChain(
		chain.filter(candidate =>
			kindOf(candidate) === "native"
				? nativeTakesImages(candidate.model, images)
				: supportsImageJudgment(candidate.model),
		),
	);
}

function asksForBoxes(questions: Questions): boolean {
	for (const id in questions) if (questions[id].type === "box") return true;
	return false;
}

const WHOLE_IMAGE: BoxEdges = { top: 0, bottom: 1, left: 0, right: 1 };

/** Fit images to native transport bounds before sending; split the total byte cap evenly. */
async function fitNativeImages(model: Model, images: readonly ImageContent[]): Promise<FittedImage[]> {
	const bounds = nativeJudgmentImageBounds(model);
	if (!bounds) return images.map(image => ({ image, content: WHOLE_IMAGE }));
	const maxBytes = Math.min(
		bounds.maxBytes ?? Infinity,
		Math.floor((bounds.maxTotalBytes ?? Infinity) / images.length),
	);
	const fitted: FittedImage[] = [];
	for (const image of images) {
		const within = nativeJudgmentAcceptsImages(model, [image]) && Buffer.byteLength(image.data, "base64") <= maxBytes;
		fitted.push(within ? { image, content: WHOLE_IMAGE } : await fitImage(image, { ...bounds, maxBytes }));
	}
	return fitted;
}

/** Re-measure cached/sent-image boxes on their source images without mutating cached answers. */
function sourceBoxes<Q extends Questions>(
	questions: Q,
	result: JudgmentResult<Q>,
	fitted: readonly FittedImage[],
): JudgmentResult<Q> {
	let answers: Record<string, Answer> | undefined;
	for (const id in questions) {
		const question: Question = questions[id];
		const answer: Answer = result.answers[id];
		if (question.type !== "box" || answer.type !== "box") continue;
		answers ??= { ...result.answers };
		const content = fitted[question.image].content;
		const x = (edge: number) => Math.min(1, Math.max(0, (edge - content.left) / (content.right - content.left)));
		const y = (edge: number) => Math.min(1, Math.max(0, (edge - content.top) / (content.bottom - content.top)));
		const box = answer.box;
		answers[id] = {
			...answer,
			box: { top: y(box.top), bottom: y(box.bottom), left: x(box.left), right: x(box.right) },
		};
	}
	return answers ? { ...result, answers: answers as JudgmentResult<Q>["answers"] } : result;
}

export function hasNativeJudge(settings: Settings, registry: ModelRegistry): boolean {
	const [primary] = textJudgeRoleChain(
		resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, registry)),
	);
	return primary !== undefined && kindOf(primary) === "native";
}

/** Resolve a live judge-role chain. Candidates resolve lazily and are reused for {@link CANDIDATE_TTL_MS}. */
export function resolveJudge(deps: JudgeDeps): ChainJudge {
	return new ChainJudge(deps);
}

/**
 * Judge facade that falls through the live `judge` role chain. `withCandidate`
 * lets a caller choose candidate-specific questions while retaining the exact
 * same credential, failure, timeout, and abort semantics as ordinary `judge`.
 */
export class ChainJudge implements Judge {
	readonly label = "judge role chain";
	readonly #deps: JudgeDeps;
	readonly #telemetry: AgentTelemetry | undefined;
	/** Text-judgment candidates memoized per resolved chain; image candidates depend on each request's images. */
	#candidates: { chain: RoleChainCandidate[]; list: RoleChainCandidate[] } | undefined;

	constructor(deps: JudgeDeps) {
		this.#deps = deps;
		this.#telemetry = resolveTelemetry(deps.telemetry, deps.sessionId);
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const requestImages = request.images ?? [];
		// Malformed input is the caller's error, not a candidate failure: reject it before trying any candidate.
		for (const [index, image] of requestImages.entries()) {
			if (!isEmbeddedImageContent(image)) {
				throw new AIError.ValidationError(
					`judgment: images[${index}] must contain non-empty base64 data and an image MIME type`,
				);
			}
		}
		checkBoxQuestions(request);
		return this.#withCandidate(
			async (candidateJudge, kind, model) => {
				if (kind === "local" || requestImages.length === 0) return candidateJudge.judge(request, options);
				const fitted = kind === "native" ? await fitNativeImages(model, requestImages) : undefined;
				const images = fitted
					? fitted.map(fit => fit.image)
					: ((await normalizeModelContextImages([...requestImages], { model })) ?? []);
				const signal = options.signal;
				if (signal?.aborted) {
					const reason = signal.reason;
					throw reason instanceof Error ? reason : new AIError.AbortError("judgment aborted");
				}
				const result = await candidateJudge.judge({ ...request, images }, options);
				return fitted ? sourceBoxes(request.questions, result, fitted) : result;
			},
			options,
			request,
		);
	}

	/**
	 * Model of the first judge-role candidate, i.e. the one a judgment routes to
	 * when it is credentialed and healthy. Used to price work before running it;
	 * undefined when no candidate resolves.
	 */
	primaryModel(): Model | undefined {
		return this.#resolveCandidates()[0]?.model;
	}

	async withCandidate<T>(run: (judge: Judge, kind: JudgeKind) => Promise<T>, options: JudgeOptions = {}): Promise<T> {
		return this.#withCandidate((judge, kind) => run(judge, kind), options);
	}

	/** Run `run` against each candidate able to answer `request` (any candidate when omitted) until one succeeds. */
	async #withCandidate<T>(
		run: (judge: Judge, kind: JudgeKind, model: Model) => Promise<T>,
		options: JudgeOptions,
		request?: JudgmentRequest,
	): Promise<T> {
		const requiresImages = (request?.images?.length ?? 0) > 0;
		const signal = options.signal;
		let lastFailure: string | undefined;
		let lastUnavailable: string | undefined;
		let compatibleCandidate = false;
		let unsupportedCandidate = false;
		const candidates = this.#resolveCandidates(request);
		const rejections = this.#rejections();
		for (const candidate of candidates) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
			}
			const identity = formatModelStringWithRouting(candidate.model);
			const skippedUntil = rejections.get(identity);
			if (skippedUntil !== undefined) {
				if (skippedUntil > Date.now()) {
					lastUnavailable = `${identity} rejected the account recently`;
					continue;
				}
				rejections.delete(identity);
			}
			// Outside the candidate's failure handling: a refusal ends the judgment.
			this.#deps.costGate?.admit();
			try {
				const judge = await this.#createJudge(candidate, signal);
				if (!judge) {
					lastUnavailable = `no API key for ${candidate.model.provider}/${candidate.model.id}`;
					continue;
				}
				if (requiresImages && judge.supportsImages !== true) {
					unsupportedCandidate = true;
					lastUnavailable = `${identity} does not support image inputs`;
					continue;
				}
				compatibleCandidate = true;
				return await run(judge, kindOf(candidate), candidate.model);
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason instanceof Error ? signal.reason : new AIError.AbortError("judgment aborted");
				}
				if (isAbortOrTimeout(error)) throw error;
				const rejected = isAccountRejection(error);
				if (rejected) rejections.set(identity, Date.now() + CANDIDATE_REJECTION_COOLDOWN_MS);
				lastFailure = error instanceof Error ? error.message : String(error);
				logger.warn("judgment candidate failed", {
					candidate: identity,
					status: AIError.status(error),
					error: lastFailure,
					skippedForMs: rejected ? CANDIDATE_REJECTION_COOLDOWN_MS : undefined,
				});
			}
		}
		if (requiresImages && !compatibleCandidate && unsupportedCandidate) {
			throw new Error("judgment: no compatible judge candidate supports images");
		}
		if (candidates.length === 0) {
			if (request && asksForBoxes(request.questions))
				throw new Error("judgment: no judge candidate answers box questions");
			if (requiresImages) throw new Error("judgment: no compatible judge candidate supports images");
			throw new Error("judgment: no judge model available");
		}
		throw new Error(`judgment: every judge candidate failed: ${lastFailure ?? lastUnavailable ?? "unknown error"}`);
	}

	/** Attribute one billed attempt to the ledger and telemetry. */
	#report(attempt: JudgmentAttempt): void {
		const { startedAt, responseModel, questions, cachedQuestions, ...rest } = attempt;
		const usage: JudgmentUsage = { purpose: this.#deps.purpose, ...rest };
		if (questions === undefined || cachedQuestions !== questions) {
			this.#deps.costGate?.record(usage.usage.cost.total);
			this.#deps.onUsage?.(usage);
		}
		recordJudgmentTelemetry(this.#telemetry, {
			provider: usage.provider,
			model: usage.model,
			responseModel,
			purpose: usage.purpose,
			usage: usage.usage,
			stopReason: usage.stopReason,
			errorMessage: usage.errorMessage,
			startTime: startedAt,
			questions,
			cachedQuestions,
		}).catch(error => logger.warn("judgment telemetry failed", { error: String(error) }));
	}

	#rejections(): Map<string, number> {
		const registry: RegistryWithRejections = this.#deps.registry;
		return (registry[kRejections] ??= new Map());
	}

	#resolveCandidates(request?: JudgmentRequest): RoleChainCandidate[] {
		const { settings, registry, sessionModel } = this.#deps;
		const { roleChain, list: chain } = cachedJudgeRoleChain(settings, registry);
		const images = request?.images ?? [];
		if (request && asksForBoxes(request.questions)) {
			return roleChain.filter(
				candidate => nativeJudgmentSupportsBoxes(candidate.model) && nativeTakesImages(candidate.model, images),
			);
		}
		if (images.length > 0) return withSessionFallback(imageJudgeRoleChain(roleChain, images), sessionModel, true);
		if (chain === this.#candidates?.chain) return this.#candidates.list;
		const list = withSessionFallback(chain, sessionModel);
		this.#candidates = { chain, list };
		return list;
	}

	async #createJudge(candidate: RoleChainCandidate, signal: AbortSignal | undefined): Promise<Judge | undefined> {
		const model = candidate.model;
		if (model.api === "local-inference") return new TextJudge(new LocalTextBackend(model.id));
		if (isJudgmentApi(model.api) && !model.baseUrl?.trim()) {
			throw new AIError.ConfigurationError("Native judgment requires an explicit base URL");
		}
		if (!(await this.#deps.registry.getApiKey(model, this.#deps.sessionId, { signal }))) return undefined;
		const apiKey = this.#deps.registry.resolver(model, this.#deps.sessionId);
		if (isJudgmentApi(model.api)) {
			const judge = createNativeJudge(
				{
					...model,
					resolveHeaders: headerSignal => this.#deps.registry.resolveModelHeaders(model, headerSignal),
				},
				{ apiKey },
			);
			return nativeJudge(judge, model, this.#deps.cache, attempt => this.#report(attempt));
		}
		// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
		const metadata = this.#deps.metadataResolver?.(model.provider);
		const backend = chatTextBackend(model, {
			apiKey,
			sessionId: this.#deps.sessionId,
			metadata,
			// Sole attribution point for prompted judgments: TextJudge's result.usage
			// aggregates these same attempts and must never be billed again.
			onAttempt: attempt =>
				this.#report({
					role: "judge",
					api: attempt.api,
					provider: attempt.provider,
					model: attempt.model,
					usage: attempt.usage,
					stopReason: attempt.stopReason,
					errorMessage: attempt.errorMessage,
					startedAt: attempt.timestamp,
				}),
		});
		return new TextJudge(backend);
	}
}

/** Keyword completions through the shared on-device tiny-model worker. */
class LocalTextBackend implements TextBackend {
	readonly api = "local-inference";
	readonly provider = "local";
	readonly guardState = false;
	readonly model: string;
	readonly #reasoning: boolean;

	constructor(modelId: string) {
		this.model = modelId;
		this.#reasoning = getTinyLocalModelSpec(modelId)?.reasoning === true;
	}

	async complete(judgment: TextPrompt, options: JudgeOptions): Promise<TextCompletion> {
		// Sub-2B models answer a bare user message as a question (or echo the
		// system prompt); one merged turn ending in `Answer:` keeps them classifying.
		const text = await tinyModelClient.complete(
			this.model,
			prompt.render(localPromptTemplate, { system: judgment.system, state: judgment.user }),
			{
				maxTokens: this.#reasoning ? LOCAL_REASONING_MAX_TOKENS : LOCAL_ANSWER_MAX_TOKENS,
				signal: options.signal,
			},
		);
		if (!text) throw new Error(`judgment: local model ${this.model} returned no output`);
		return { text };
	}
}

/** Bill native attempts once, use cached answers locally, and preserve partial usage on failed batches. */
function nativeJudge(
	judge: NativeJudge,
	model: Model,
	cache: JudgmentCache | undefined,
	report: (attempt: JudgmentAttempt) => void,
): Judge {
	const cacheModel = `${model.provider}/${model.id}`;
	return {
		label: judge.label,
		...(judge.supportsImages === undefined ? {} : { supportsImages: judge.supportsImages }),
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const startedAt = Date.now();
			const cacheRequest =
				request.images === undefined
					? request
					: {
							...request,
							images: request.images.map(image => ({
								...image,
								detail: judge.effectiveImageDetail(image.detail),
							})),
						};
			const cached = cache?.lookup(cacheModel, cacheRequest);
			const known = cached?.answers ?? {};
			const pending: Questions = {};
			let questions = 0;
			let pendingCount = 0;
			for (const id in request.questions) {
				questions++;
				if (known[id] !== undefined) continue;
				pending[id] = request.questions[id];
				pendingCount++;
			}
			const attempt = {
				role: "judge",
				api: judge.api,
				provider: judge.provider,
				model: model.id,
				startedAt,
				questions,
				cachedQuestions: questions - pendingCount,
			};
			let fresh: JudgmentResult | undefined;
			if (pendingCount > 0 || questions === 0) {
				let partial = tokenUsage(0, 0);
				try {
					fresh = await judge.judge(
						{
							state: request.state,
							questions: pending,
							...(request.images === undefined ? {} : { images: request.images }),
						},
						{
							signal: options?.signal,
							onPartialUsage: usage => {
								partial = usage;
							},
						},
					);
				} catch (error) {
					if (partial.cost.total === 0) calculateCost(model, partial);
					report({
						...attempt,
						usage: partial,
						stopReason: isAbortOrTimeout(error) ? "aborted" : "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
				if (fresh.usage.cost.total === 0) calculateCost(model, fresh.usage);
				if (cache && cached) cache.record(cacheModel, cached, pending, fresh);
			}
			const usage = fresh?.usage ?? tokenUsage(0, 0);
			report({ ...attempt, usage, stopReason: "stop", responseModel: fresh?.model });
			const answers: Record<string, Answer> = {};
			for (const id in request.questions) {
				const answer = known[id] ?? fresh?.answers[id];
				if (answer) answers[id] = answer;
			}
			return {
				api: judge.api,
				provider: judge.provider,
				model: fresh?.model ?? model.id,
				answers: answers as JudgmentResult<Q>["answers"],
				usage,
			};
		},
	};
}

/** Credential or billing rejection: the account cannot serve this candidate until something changes out of band. */
function isAccountRejection(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 401 || status === 402 || status === 403;
}

function isAbortOrTimeout(error: unknown): boolean {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	return AIError.is(AIError.classify(error), AIError.Flag.Abort);
}
