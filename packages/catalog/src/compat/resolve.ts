/**
 * `resolveModelPolicy` — the single model-policy resolver. Layering, later
 * layers win:
 *
 *   1. unconditional per-API compat defaults;
 *   2. generic model-family and local-endpoint defaults;
 *   3. compat-cascade axes compiled from `rules/`;
 *   4. spec-authored sparse overrides (`applyCompatOverrides`), then the
 *      spec-undefined fixups the legacy builders applied.
 *
 * Thinking metadata resolves after compat: explicit spec thinking wins,
 * cascade thinking axes drive the ladder/mode/wire facts, and identity-generic
 * fallbacks cover unmatched targets.
 */
import { Effort, THINKING_EFFORTS } from "../effort";
import { modelMatchesHost } from "../hosts";
import { withoutUnverifiedThinking } from "../model-thinking";
import type {
	Api,
	CatalogPolicyInputs,
	CompatOf,
	ModelSpec,
	OpenAICompat,
	ResolvedAnthropicCompat,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	ResolvedOllamaCompat,
	ThinkingConfig,
} from "../types";
import { applyCompatOverrides } from "./apply";
import { API_COMPAT_RECORDS, AXES, type CompatRecordName } from "./axes";
import { hasModelScopedEffortsRule, resolveCascade } from "./cascade";
import { compareRevision, parseRevision, type Revision } from "./revision";
import { classifyModel, stripThinkingVariantSuffix } from "./taxonomy";
import type { ModelIdentity, RequestPolicy, ResolvedAxes, ResolveTarget } from "./types";

/** Result of resolving one model spec through the compat engine. */
export interface ResolvedModelPolicy<TApi extends Api = Api> {
	identity: ModelIdentity;
	compat: CompatOf<TApi>;
	thinking: ThinkingConfig | undefined;
	/** Catalog-data axis assignments (longContext, priority, …) for generation. */
	catalog: Record<string, unknown>;
	/** Request-shaping directives for the selected upstream. */
	request: RequestPolicy;
}

const REQUEST_AXIS_KEYS = Object.values(AXES)
	.filter(axis => axis.records?.includes("request"))
	.map(axis => axis.key);

function resolveRequestPolicy(axes: ResolvedAxes): RequestPolicy {
	const policy: Record<string, unknown> = {};
	for (const key of REQUEST_AXIS_KEYS) {
		if (key in axes.wire) policy[key] = axes.wire[key];
	}
	return policy as RequestPolicy;
}

// ---------------------------------------------------------------------------
// Identity facts — every check reads ModelIdentity fields, never id strings.
// ---------------------------------------------------------------------------

/** Structured identity plus revision comparison helpers. */
class IdentityFacts {
	readonly revision: Revision | undefined;

	constructor(readonly identity: ModelIdentity) {
		this.revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	}

	is(cls: string): boolean {
		return this.identity.class === cls;
	}

	family(...families: string[]): boolean {
		return this.identity.family !== undefined && families.includes(this.identity.family);
	}

	revGte(min: string): boolean {
		if (!this.revision) return false;
		const bound = parseRevision(min);
		return bound !== undefined && compareRevision(this.revision, bound) >= 0;
	}

	/** Adaptive-thinking Claude generation floor (Opus ≥ min; Sonnet/Fable/Mythos ≥ 5; Haiku ≥ 5.5). */
	anthropicAdaptiveGenAtLeast(opusMin: string): boolean {
		if (!this.is("anthropic")) return false;
		if (this.family("opus")) return this.revGte(opusMin);
		if (this.family("sonnet", "fable", "mythos")) return this.revGte("5");
		if (this.family("haiku")) return this.revGte("5.5");
		return false;
	}
}

/**
 * Resolve an unclassified display id under its classified request id so
 * model-family rules apply to aliases without changing their visible ids.
 */
function policyModelId(spec: CatalogPolicyInputs): string {
	const wireId = spec.requestModelId;
	if (wireId === undefined || wireId === spec.id) return spec.id;
	if (classifyModel(spec.provider, spec.id).class !== "unknown") return spec.id;
	return classifyModel(spec.provider, wireId).class === "unknown" ? spec.id : wireId;
}

function resolveIdentity(spec: CatalogPolicyInputs): ModelIdentity {
	// Strict on purpose: ambiguous identity is a rule-authoring defect surfaced
	// at build/CI time, never silently degraded to `unknown`. Discovery
	// normalization opts into leniency through `classifyModel` directly.
	return classifyModel(spec.provider, policyModelId(spec));
}

// ---------------------------------------------------------------------------
// Axis application
// ---------------------------------------------------------------------------

interface AxisKeyInfo {
	records: readonly CompatRecordName[];
}

let keyRecords: Record<string, AxisKeyInfo> | undefined;

function getKeyRecords(): Record<string, AxisKeyInfo> {
	if (!keyRecords) {
		keyRecords = {};
		for (const directive in AXES) {
			const axis = AXES[directive];
			if (axis.set === "wire" && axis.records) {
				keyRecords[axis.key] = { records: axis.records };
			}
		}
	}
	return keyRecords;
}

/**
 * Assigns resolved wire axes onto a freshly-detected compat record. An axis
 * lands only when the model's API maps to one of the axis's declared records
 * — the axes table is the single applicability authority, so optional keys
 * absent from the detected baseline still land.
 */
function applyWireAxes(compat: object, wire: Record<string, unknown>, api: Api): void {
	const records = API_COMPAT_RECORDS[api];
	if (!records) return;
	const info = getKeyRecords();
	for (const key in wire) {
		const meta = info[key];
		if (!meta?.records.some(record => records.includes(record))) continue;
		Reflect.set(compat, key, wire[key]);
	}
}
/**
 * Preserves legacy per-key merge semantics for map-valued effort remaps: a
 * cascade-provided `reasoningEffortMap` is the detected base and sparse spec
 * overrides overlay it key by key (spec keys win, unseen keys survive).
 */
function overlayEffortMapAxis(
	compat: { reasoningEffortMap: Partial<Record<Effort, string>> },
	axes: ResolvedAxes,
	specCompat: OpenAICompat | undefined,
): void {
	const axisMap = effortRecord(axes.wire.reasoningEffortMap);
	if (axisMap && specCompat?.reasoningEffortMap) {
		compat.reasoningEffortMap = { ...axisMap, ...specCompat.reasoningEffortMap };
	}
}

function effortList(value: unknown): readonly Effort[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: Effort[] = [];
	for (const entry of value) {
		const effort = THINKING_EFFORTS.find(candidate => candidate === entry);
		if (effort === undefined) return undefined;
		out.push(effort);
	}
	return out;
}

function effortValue(value: unknown): Effort | undefined {
	return THINKING_EFFORTS.find(candidate => candidate === value);
}

function objectPayload(value: unknown): object | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function effortRecord(value: unknown): Partial<Record<Effort, string>> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Partial<Record<Effort, string>> = {};
	let any = false;
	for (const key in value) {
		const effort = effortValue(key);
		const mapped: unknown = Reflect.get(value, key);
		if (effort === undefined || typeof mapped !== "string") continue;
		out[effort] = mapped;
		any = true;
	}
	return any ? out : undefined;
}

function effortNumberRecord(value: unknown): Partial<Record<Effort, number>> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Partial<Record<Effort, number>> = {};
	let any = false;
	for (const key in value) {
		const effort = effortValue(key);
		const mapped: unknown = Reflect.get(value, key);
		if (effort === undefined || typeof mapped !== "number") continue;
		out[effort] = mapped;
		any = true;
	}
	return any ? out : undefined;
}

function thinkingMode(value: unknown): ThinkingConfig["mode"] | undefined {
	switch (value) {
		case "effort":
		case "budget":
		case "google-level":
		case "anthropic-adaptive":
		case "anthropic-budget-effort":
			return value;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Detected baselines (layers 1+2) — ported from the legacy builders with
// pure identity/provider policy removed (rules own it).
// ---------------------------------------------------------------------------

const LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS = 300_000;
// Provider identity describes server semantics even when it uses company DNS.
const LOCAL_OPENAI_COMPAT_PROVIDERS: Readonly<Record<string, true>> = {
	"llama.cpp": true,
	"lm-studio": true,
	vllm: true,
	ollama: true,
};
function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
		if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	if (hostname.startsWith("10.")) return true;
	if (hostname.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	return false;
}

function resolveReasoningDisableMode(
	thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"],
): ResolvedOpenAISharedCompat["reasoningDisableMode"] {
	switch (thinkingFormat) {
		case "zai":
		case "kimi":
			return "zai-thinking-disabled";
		case "qwen":
			return "qwen-enable-thinking-false";
		case "qwen-chat-template":
			return "qwen-template-false";
		case "chat-template":
			return "chat-template-thinking-false";
		default:
			return "lowest-effort";
	}
}

function detectStreamMarkupHealing(
	spec: ModelSpec<Api>,
	facts: IdentityFacts,
): ResolvedOpenAISharedCompat["streamMarkupHealingPattern"] {
	if (spec.providerType === "github-copilot" || modelMatchesHost(spec, "githubCopilot")) return undefined;
	if (facts.is("deepseek")) return "dsml";
	if (facts.is("kimi") && facts.identity.family?.startsWith("k2")) return "kimi";
	return "thinking";
}

/** Generic chat-completions defaults; reviewed family and Copilot rules override them. */
function detectOpenAICompat(
	spec: ModelSpec<"openai-completions">,
	facts: IdentityFacts,
	reasoningCapable: boolean,
): ResolvedOpenAICompat {
	const backendProvider = spec.providerType ?? spec.provider;
	const isLocal =
		backendProvider !== "litellm" &&
		(LOCAL_OPENAI_COMPAT_PROVIDERS[backendProvider] === true || hasLocalLoopbackBaseUrl(spec.baseUrl));
	const isLocalServing = isLocal || hasLocalLoopbackBaseUrl(spec.baseUrl);
	const isDeepseek = facts.is("deepseek");
	const isQwen = facts.is("qwen");
	const thinkingFormat = isQwen ? "qwen" : "openai";
	return {
		supportsStore: true,
		supportsDeveloperRole: false,
		supportsMultipleSystemMessages: !isQwen && modelMatchesHost(spec, "githubCopilot"),
		supportsReasoningEffort: true,
		trustExplicitThinkingOnly: undefined,
		supportsReasoningParams: true,
		supportsSamplingParams: true,
		supportsPenaltyAndStopParams: true,
		reasoningEffortMap: {},
		supportsUsageInStreaming: true,
		alwaysSendMaxTokens: facts.is("kimi"),
		disableReasoningOnForcedToolChoice: facts.is("kimi") || facts.is("anthropic"),
		disableReasoningOnToolChoice: isDeepseek && reasoningCapable,
		disableReasoningWithTools: false,
		supportsToolChoice: true,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		thinkingFormat,
		kimiApiFormat: undefined,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: false,
		thinkingKeep: undefined,
		reasoningContentField: "reasoning_content",
		mistralReasoningContentParts: undefined,
		requiresReasoningContentForToolCalls: facts.is("kimi") || (isDeepseek && reasoningCapable),
		requiresReasoningContentForAllAssistantTurns: isDeepseek && reasoningCapable,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseek || !reasoningCapable,
		syntheticReasoningContentFallback: undefined,
		replayReasoningContent: isLocal,
		qwenPreserveThinking: isQwen && isLocal,
		qwenTemplateReasoningEffort: false,
		requiresAssistantContentForToolCalls: facts.is("kimi"),
		cacheControlFormat: undefined,
		supportsPromptCacheBreakpoints: false,
		promptCacheBreakpointTtl: undefined,
		supportsStrictMode: false,
		extraBody: undefined,
		toolStrictMode: "mixed",
		toolSchemaFlavor: facts.is("kimi") ? "moonshot-mfjs" : isLocal ? "grammar" : undefined,
		streamFirstEventTimeoutMs: isLocalServing ? 0 : undefined,
		streamIdleTimeoutMs: isLocalServing ? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS : undefined,
		stripDeepseekSpecialTokens: false,
		streamMarkupHealingPattern: detectStreamMarkupHealing(spec, facts),
		stripThinkingHistory: undefined,
		reasoningDeltasMayBeCumulative: false,
		emptyLengthFinishIsContextError: false,
		usesOpenAIToolCallIdLimit: false,
		promptCacheSessionHeader: undefined,
		sessionHeader: undefined,
		dropThinkingWhenReasoningEffort: false,
		nativeKimiK3Reasoning: false,
		zaiReasoningEffortDialect: false,
		clampOutputToModelMax: isLocal,
		stripImageInput: false,
		thinkingLoopGuard: undefined,
		rejectRootObjectUnion: false,
		retryWithoutStrictOnGrammarError: false,
		supportsPromptCacheKey: false,
	};
}

function fixupOpenAICompat(
	spec: ModelSpec<"openai-completions">,
	compat: ResolvedOpenAICompat,
	axes: ResolvedAxes,
): void {
	if (spec.compat?.reasoningDisableMode === undefined && !("reasoningDisableMode" in axes.wire)) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (
		spec.compat?.omitReasoningEffort === undefined &&
		!("omitReasoningEffort" in axes.wire) &&
		!compat.supportsReasoningEffort
	) {
		compat.omitReasoningEffort = true;
	}

	const axisWhenThinking = compatReasoning(spec, axes) ? objectPayload(axes.wire.whenThinking) : undefined;
	const whenThinkingPolicy = spec.compat?.whenThinking ?? axisWhenThinking;
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat, whenThinking: undefined };
		applyCompatOverrides(variant, whenThinkingPolicy);
		if (Reflect.get(whenThinkingPolicy, "reasoningDisableMode") === undefined) {
			variant.reasoningDisableMode = resolveReasoningDisableMode(variant.thinkingFormat);
		}
		if (Reflect.get(whenThinkingPolicy, "omitReasoningEffort") === undefined && !variant.supportsReasoningEffort) {
			variant.omitReasoningEffort = true;
		}
		compat.whenThinking = variant;
	} else {
		compat.whenThinking = undefined;
	}
}

function resolveOpenAICompletionsPolicy(
	spec: ModelSpec<"openai-completions">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
): ResolvedOpenAICompat {
	const reasoningCapable = compatReasoning(spec, axes);
	const compat = detectOpenAICompat(spec, facts, reasoningCapable);
	applyWireAxes(compat, axes.wire, "openai-completions");
	applyCompatOverrides(compat, spec.compat);
	overlayEffortMapAxis(compat, axes, spec.compat);
	fixupOpenAICompat(spec, compat, axes);
	return compat;
}

/** Generic Responses defaults; reviewed family and Copilot rules override them. */
function resolveOpenAIResponsesPolicy(
	spec: ModelSpec<"openai-responses">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
): ResolvedOpenAIResponsesCompat {
	const backendProvider = spec.providerType ?? spec.provider;
	const isLocal =
		backendProvider !== "litellm" &&
		(LOCAL_OPENAI_COMPAT_PROVIDERS[backendProvider] === true || hasLocalLoopbackBaseUrl(spec.baseUrl));
	const isLocalServing = isLocal || hasLocalLoopbackBaseUrl(spec.baseUrl);
	const reasoningCapable = compatReasoning(spec, axes);
	const isDeepseek = facts.is("deepseek");
	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole: modelMatchesHost(spec, "githubCopilot"),
		supportsStrictMode: false,
		supportsReasoningEffort: true,
		trustExplicitThinkingOnly: undefined,
		supportsLongPromptCacheRetention: false,
		supportsPromptCacheBreakpoints: false,
		promptCacheBreakpointTtl: undefined,
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		supportsReasoningSummary: true,
		statefulResponses: undefined,
		supportsAllTurnsReasoningContext: false,
		supportsConfigurationUpdate: false,
		supportsSteering: false,
		requiresReasoningOffJuiceInstruction: false,
		stripImageInput: false,
		thinkingLoopGuard: undefined,
		reasoningEffortMap: {},
		supportsReasoningParams: true,
		supportsSamplingParams: true,
		supportsPenaltyAndStopParams: true,
		thinkingFormat: "openai",
		reasoningDisableMode: "lowest-effort",
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: false,
		disableReasoningOnForcedToolChoice: facts.is("kimi"),
		disableReasoningOnToolChoice: isDeepseek && reasoningCapable,
		disableReasoningWithTools: false,
		supportsToolChoice: true,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls: (facts.is("kimi") || isDeepseek) && reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseek && reasoningCapable,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseek || !reasoningCapable,
		syntheticReasoningContentFallback: undefined,
		replayReasoningContent: false,
		qwenPreserveThinking: false,
		qwenTemplateReasoningEffort: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: facts.is("kimi"),
		toolSchemaFlavor: facts.is("kimi") ? "moonshot-mfjs" : undefined,
		alwaysSendMaxTokens: facts.is("kimi"),
		clampOutputToModelMax: isLocal,
		supportsObfuscationOptOut: false,
		storeResponses: false,
		connectionBoundNativeHistory: false,
		harmonyLeakMitigation: false,
		rejectRootObjectUnion: false,
		retryWithoutStrictOnGrammarError: false,
		cacheControlFormat: undefined,
		stripDeepseekSpecialTokens: false,
		streamMarkupHealingPattern: detectStreamMarkupHealing(spec, facts),
		reasoningDeltasMayBeCumulative: false,
		emptyLengthFinishIsContextError: false,
		usesOpenAIToolCallIdLimit: false,
		promptCacheSessionHeader: undefined,
		sessionHeader: undefined,
		streamFirstEventTimeoutMs: isLocalServing ? 0 : spec.compat?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: isLocalServing
			? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
			: spec.compat?.streamIdleTimeoutMs,
	};
	applyWireAxes(compat, axes.wire, "openai-responses");
	applyCompatOverrides(compat, spec.compat);
	overlayEffortMapAxis(compat, axes, spec.compat);
	if (spec.compat?.reasoningDisableMode === undefined && !("reasoningDisableMode" in axes.wire)) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (
		spec.compat?.omitReasoningEffort === undefined &&
		!("omitReasoningEffort" in axes.wire) &&
		!compat.supportsReasoningEffort
	) {
		compat.omitReasoningEffort = true;
	}
	return compat;
}

function resolveAnthropicPolicy(
	spec: ModelSpec<"anthropic-messages">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
): ResolvedAnthropicCompat {
	const signingEndpoint = modelMatchesHost(spec, "githubCopilot");
	const compat: ResolvedAnthropicCompat = {
		signingEndpoint,
		supportsContextManagement: true,
		supportsServerCompaction: false,
		honorsClaudeCodeBetaKillSwitch: false,
		supportsOutputEffort: true,
		disableStrictTools: false,
		disableAdaptiveThinking: false,
		allowAnthropicHeaderOverrides: false,
		supportsEagerToolInputStreaming: false,
		supportsLongCacheRetention: false,
		supportsMidConversationSystem: false,
		supportsTurnScopedSystem: false,
		supportsMidConversationToolChanges: false,
		supportsPerMessageEffort: false,
		supportsThinkingBindingControls: false,
		supportsBetweenToolsThinking: false,
		supportsForcedToolChoice: !facts.family("fable", "mythos"),
		supportsSamplingParams: true,
		requiresToolResultId: false,
		requiresThinkingEnabled: false,
		requiresThinkingPresence: false,
		replayUnsignedThinking: !signingEndpoint && (compatReasoning(spec, axes) || facts.is("deepseek")),
		escapeBuiltinToolNames: false,
		injectClaudeCodeInstruction: true,
		stripImageInput: false,
		// Unset means "canonical Anthropic image contract"; the request builder
		// owns those numbers. The keys must exist for a KDL rule or a
		// user-authored `compat` block to override them.
		maxImageDimension: undefined,
		maxImagePayloadBytes: undefined,
		thinkingLoopGuard: undefined,
		// Present as keys so models.yml `compat` can set them; unset unless a rule assigns them.
		stripThinkingHistory: undefined,
		fastMode: undefined,
		streamIdleTimeoutMs: spec.compat?.streamIdleTimeoutMs,
	};
	applyWireAxes(compat, axes.wire, "anthropic-messages");
	applyCompatOverrides(compat, spec.compat);
	return compat;
}

// ---------------------------------------------------------------------------
// Thinking resolution
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH: readonly Effort[] = [...DEFAULT_REASONING_EFFORTS, Effort.XHigh];

function omitsWireReasoningEffort(api: Api, compat: CompatOf<Api>): boolean {
	if (api !== "openai-responses") {
		return false;
	}
	return compat !== undefined && "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false;
}

function readCompatEffortMap(compat: CompatOf<Api>): Partial<Record<Effort, string>> | undefined {
	if (compat === undefined || !("reasoningEffortMap" in compat)) return undefined;
	const map = compat.reasoningEffortMap;
	return map && Object.keys(map).length > 0 ? map : undefined;
}

/** Identity/API-derived default control mode; `thinking-mode` rules override. */
function defaultThinkingMode<TApi extends Api>(spec: ModelSpec<TApi>, facts: IdentityFacts): ThinkingConfig["mode"] {
	switch (spec.api) {
		case "anthropic-messages":
			if (facts.is("anthropic")) {
				// Haiku stays on budget thinking until 5.5, its first adaptive generation.
				if (facts.revGte(facts.family("haiku") ? "5.5" : "4.6")) return "anthropic-adaptive";
				if (facts.family("opus") && facts.revGte("4.5")) return "anthropic-budget-effort";
			}
			return "budget";
		default:
			return "effort";
	}
}

/** API/compat-generic fallback ladder for targets no rule covered. */
function fallbackEfforts<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): readonly Effort[] {
	if (spec.api === "anthropic-messages") return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	if (spec.api === "openai-completions" && compat !== undefined && "thinkingFormat" in compat) {
		if (compat.thinkingFormat === "openai" && compat.supportsReasoningEffort) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		return DEFAULT_REASONING_EFFORTS;
	}
	if (spec.api === "openai-responses") {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function filterEffortMap(
	map: Partial<Record<Effort, string>>,
	efforts: readonly Effort[],
): Partial<Record<Effort, string>> | undefined {
	let filtered: Partial<Record<Effort, string>> | undefined;
	for (const effort of efforts) {
		const mapped = map[effort];
		if (mapped === undefined) continue;
		filtered ??= {};
		filtered[effort] = mapped;
	}
	return filtered;
}

interface RuleThinking {
	mode?: ThinkingConfig["mode"];
	efforts?: readonly Effort[];
	defaultLevel?: Effort;
	effortMap?: Partial<Record<Effort, string>>;
	effortBudgets?: Partial<Record<Effort, number>>;
	requiresEffort?: boolean;
	suppressWhenOff?: boolean;
	supportsDisplay?: boolean;
	prefixBinding?: boolean;
	upgradeNeutral?: boolean;
	unverified?: boolean;
}

function readRuleThinking(axes: ResolvedAxes): RuleThinking {
	const raw = axes.thinking;
	const out: RuleThinking = {};
	const mode = thinkingMode(raw.mode);
	if (mode !== undefined) out.mode = mode;
	const efforts = effortList(raw.efforts);
	if (efforts !== undefined) out.efforts = efforts;
	const defaultLevel = effortValue(raw.defaultLevel);
	if (defaultLevel !== undefined) out.defaultLevel = defaultLevel;
	const effortMap = effortRecord(raw.effortMap);
	if (effortMap !== undefined) out.effortMap = effortMap;
	const effortBudgets = effortNumberRecord(raw.effortBudgets);
	if (effortBudgets !== undefined) out.effortBudgets = effortBudgets;
	if (typeof raw.requiresEffort === "boolean") out.requiresEffort = raw.requiresEffort;
	if (typeof raw.suppressWhenOff === "boolean") out.suppressWhenOff = raw.suppressWhenOff;
	if (typeof raw.supportsDisplay === "boolean") out.supportsDisplay = raw.supportsDisplay;
	if (typeof raw.prefixBinding === "boolean") out.prefixBinding = raw.prefixBinding;
	if (typeof raw.upgradeNeutral === "boolean") out.upgradeNeutral = raw.upgradeNeutral;
	if (typeof raw.unverified === "boolean") out.unverified = raw.unverified;
	return out;
}

/**
 * Compat-time reasoning capability. `axes.reasoning` also promotes targets on
 * reviewed effort corrections (the cascade's thinking-axis gate), but compat
 * may only be repaired where the matching contract opted in with
 * `thinking-upgrade-neutral`; everywhere else a spec that reports no reasoning
 * stays the authoritative capability surface.
 */
function compatReasoning<TApi extends Api>(spec: ModelSpec<TApi>, axes: ResolvedAxes): boolean {
	if (spec.reasoning) return true;
	return axes.reasoning && readRuleThinking(axes).upgradeNeutral === true;
}

/** Identity-derived `requiresEffort` default (mandatory-reasoning lineages). */
function impliesMandatoryReasoning(facts: IdentityFacts, modelId: string): boolean {
	if (facts.identity.thinkingVariant) return true;
	// Thinking-variant orphans: a bounded pair token anywhere in the id
	// (`runtime-thinking-model`, `qwen3-…-thinking-2507`) names the
	// reasoning-locked sibling even when it is not a collapse suffix.
	if (stripThinkingVariantSuffix(modelId) !== undefined) return true;
	return false;
}

function isQwenTemplateReasoningEffortCompat(compat: CompatOf<Api>): boolean {
	return (
		compat !== undefined && "qwenTemplateReasoningEffort" in compat && compat.qwenTemplateReasoningEffort === true
	);
}

function resolveThinkingPolicy<TApi extends Api>(
	spec: ModelSpec<TApi>,
	facts: IdentityFacts,
	axes: ResolvedAxes,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	const rule = readRuleThinking(axes);
	const explicitThinking =
		spec.thinking !== undefined && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0
			? spec.thinking
			: undefined;
	// An explicit wire vocabulary is authoritative when discovery reports no
	// reasoning (e.g. Synthetic's `none`-only off-switch): reviewed KDL must
	// not re-expand it into an unadvertised ladder. Absent metadata is
	// repaired only where KDL opts in with `thinking-upgrade-neutral`
	// alongside a reviewed `thinking-efforts` ladder (the cascade upgrade for
	// stale source capability data). On deployments whose discovery reports no
	// capabilities (`thinking-unverified`), an unclassified neutral spec — nothing
	// says whether it reasons — gets an unverified ladder the user may opt into.
	const unverified = !compatReasoning(spec, axes);
	if (
		unverified &&
		(explicitThinking !== undefined || facts.identity.class !== "unknown" || rule.unverified !== true)
	) {
		return undefined;
	}
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	if (explicitThinking !== undefined) {
		return fillExplicitThinking(spec, facts, compat, explicitThinking, rule);
	}
	if (compat !== undefined && "trustExplicitThinkingOnly" in compat && compat.trustExplicitThinkingOnly === true) {
		return undefined;
	}
	if (rule.efforts?.length === 0) return undefined;
	const config: ThinkingConfig = {
		mode: rule.mode ?? defaultThinkingMode(spec, facts),
		efforts: rule.efforts ?? fallbackEfforts(spec, compat),
	};
	if (config.efforts.length === 0) {
		throw new Error(`Model ${spec.provider}/${spec.id} resolved to an empty thinking range`);
	}
	const effortMap = mergeEffortMap(rule.effortMap, compat, config.efforts);
	if (effortMap !== undefined) config.effortMap = effortMap;
	if (unverified) {
		// Off-by-default opt-in: no default level, mandatory effort, or wire off-switch.
		config.unverified = true;
		return config;
	}
	if (rule.defaultLevel !== undefined) config.defaultLevel = rule.defaultLevel;
	if (rule.effortBudgets !== undefined) config.effortBudgets = rule.effortBudgets;
	const supportsDisplay = rule.supportsDisplay ?? defaultSupportsDisplay(spec, facts);
	if (supportsDisplay) config.supportsDisplay = true;
	if (rule.prefixBinding) config.prefixBinding = true;
	const requiresEffort =
		rule.requiresEffort ?? (impliesMandatoryReasoning(facts, spec.id) || isQwenTemplateReasoningEffortCompat(compat));
	if (requiresEffort) config.requiresEffort = true;
	if (rule.suppressWhenOff) config.suppressWhenOff = true;
	return config;
}
/**
 * Adaptive Claude thinking is displayable on the Messages wire; reviewed
 * thinking-supports-display rules override this family default.
 */
function defaultSupportsDisplay<TApi extends Api>(spec: ModelSpec<TApi>, facts: IdentityFacts): boolean {
	return spec.api === "anthropic-messages" && facts.anthropicAdaptiveGenAtLeast("4.7");
}

function mergeEffortMap(
	ruleMap: Partial<Record<Effort, string>> | undefined,
	compat: CompatOf<Api>,
	efforts: readonly Effort[],
): Partial<Record<Effort, string>> | undefined {
	const configured = readCompatEffortMap(compat);
	if (ruleMap === undefined && configured === undefined) return undefined;
	return filterEffortMap({ ...ruleMap, ...configured }, efforts);
}

/**
 * Backfill missing wire/default fields onto explicit thinking metadata.
 * Explicit spec thinking is layer 4 of the resolution order: its ladder and
 * every explicitly-set field always win; only absent fields are filled from
 * the rules and identity-derived defaults.
 */
function fillExplicitThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	facts: IdentityFacts,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
	rule: RuleThinking,
): ThinkingConfig {
	const effortMap =
		thinking.effortMap === undefined ? mergeEffortMap(rule.effortMap, compat, thinking.efforts) : undefined;
	const needsDisplay =
		thinking.supportsDisplay === undefined && (rule.supportsDisplay ?? defaultSupportsDisplay(spec, facts));
	const needsRequiresEffort =
		thinking.requiresEffort === undefined &&
		(rule.requiresEffort ??
			(impliesMandatoryReasoning(facts, spec.id) || isQwenTemplateReasoningEffortCompat(compat)));
	const needsDefaultLevel = thinking.defaultLevel === undefined && rule.defaultLevel !== undefined;
	const needsPrefixBinding = thinking.prefixBinding === undefined && rule.prefixBinding === true;
	const needsEffortBudgets = thinking.effortBudgets === undefined && rule.effortBudgets !== undefined;
	if (
		effortMap === undefined &&
		!needsDisplay &&
		!needsRequiresEffort &&
		!needsDefaultLevel &&
		!needsPrefixBinding &&
		!needsEffortBudgets
	) {
		return thinking;
	}
	const filled: ThinkingConfig = { ...thinking };
	if (effortMap !== undefined) filled.effortMap = effortMap;
	if (needsDisplay) filled.supportsDisplay = true;
	if (needsDefaultLevel && rule.defaultLevel !== undefined) filled.defaultLevel = rule.defaultLevel;
	if (needsRequiresEffort) filled.requiresEffort = true;
	if (needsPrefixBinding) filled.prefixBinding = true;
	if (needsEffortBudgets) filled.effortBudgets = rule.effortBudgets;
	return filled;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function buildResolveTarget(
	spec: CatalogPolicyInputs,
	identity: ModelIdentity,
	providerType = spec.providerType ?? spec.provider,
): ResolveTarget {
	const target: ResolveTarget = {
		provider: providerType,
		api: spec.api,
		class: identity.class,
		model: policyModelId(spec),
		reasoning: Boolean(spec.reasoning),
	};
	if (identity.family !== undefined) target.family = identity.family;
	if (identity.revision !== undefined) target.revision = identity.revision;
	return target;
}

function specUsesApi<TApi extends Api>(spec: ModelSpec<Api>, api: TApi): spec is ModelSpec<TApi> {
	return spec.api === api;
}

/** Resolve the request adapter assigned to a discovery backend before materialization. */
export function resolveDiscoveryApi(spec: ModelSpec<Api>, providerType: string): Api {
	const identity = resolveIdentity(spec);
	const discoveryApi = resolveCascade(buildResolveTarget(spec, identity, providerType)).catalog.discoveryApi;
	return typeof discoveryApi === "string" ? discoveryApi : spec.api;
}

/**
 * Catalog-data axis assignments for one model spec — the `catalog` field of
 * {@link resolveModelPolicy} without resolving the compat and thinking
 * policies, which dominate its cost on catalog-wide scans.
 */
export function resolveCatalogAxes(spec: CatalogPolicyInputs): Record<string, unknown> {
	return resolveCascade(buildResolveTarget(spec, resolveIdentity(spec))).catalog;
}

/**
 * Resolves the full policy surface for one model spec: structured identity,
 * complete compat record, thinking metadata, and catalog-data corrections.
 */
export function resolveModelPolicy<TApi extends Api>(spec: ModelSpec<TApi>): ResolvedModelPolicy<TApi>;
export function resolveModelPolicy(input: ModelSpec<Api>): ResolvedModelPolicy<Api> {
	const spec = withoutUnverifiedThinking(input);
	const identity = resolveIdentity(spec);
	const facts = new IdentityFacts(identity);
	const target = buildResolveTarget(spec, identity);
	const axes = resolveCascade(target);
	let compat: CompatOf<Api>;
	if (specUsesApi(spec, "openai-completions")) {
		compat = resolveOpenAICompletionsPolicy(spec, facts, axes);
	} else if (specUsesApi(spec, "openai-responses")) {
		compat = resolveOpenAIResponsesPolicy(spec, facts, axes);
	} else if (specUsesApi(spec, "anthropic-messages")) {
		compat = resolveAnthropicPolicy(spec, facts, axes);
	} else if (specUsesApi(spec, "ollama-chat")) {
		const ollamaCompat: ResolvedOllamaCompat = { stripThinkingHistory: false };
		applyWireAxes(ollamaCompat, axes.wire, "ollama-chat");
		applyCompatOverrides(ollamaCompat, spec.compat);
		compat = ollamaCompat;
	} else {
		compat = undefined;
	}
	return {
		identity,
		compat,
		thinking: resolveThinkingPolicy(spec, facts, axes, compat),
		catalog: axes.catalog,
		request: resolveRequestPolicy(axes),
	};
}

/**
 * Whether reviewed rules know THIS model's effort ladder, as opposed to it
 * inheriting a provider-wide default or {@link resolveThinkingPolicy} falling
 * through to the neutral wire ladder.
 *
 * Discovery uses this to tell "omsp knows this model's tiers" apart from "omsp
 * is guessing them", so catalog-published tiers can correct the guess without
 * ever overriding reviewed knowledge.
 */
export function hasModelScopedEffortLadder<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return hasModelScopedEffortsRule(buildResolveTarget(spec, resolveIdentity(spec)));
}
