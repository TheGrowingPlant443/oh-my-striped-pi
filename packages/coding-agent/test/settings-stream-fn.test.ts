/** Contract: live stream, cache, guard, and Responses settings preserve caller overrides. */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-striped-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-striped-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-striped-pi/pi-coding-agent/session/settings-stream-fn";

function captureBase(): { fn: StreamFn; calls: Array<{ options?: SimpleStreamOptions }> } {
	const calls: Array<{ options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (_model, _context, options) => {
		calls.push({ options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = getBundledModel("github-copilot", "gpt-5.4") as Model;
const stubResponsesModel = buildModel({
	id: "company-responses",
	name: "Company Responses fixture",
	api: "openai-responses",
	provider: "company-stream-settings",
	baseUrl: "https://models.company.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8192,
});
const stubContext = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

/** Base64 PNG whose IHDR declares `width`x`height`; the pixel data is irrelevant to sizing. */
function pngWithSize(width: number, height: number): string {
	const bytes = Buffer.alloc(64);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return bytes.toString("base64");
}

/** A rebuilt history holding one `producer` turn whose native payload replays 5,000 reasoning tokens. */
function replayedReasoningContext(producer: Model): Context {
	const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };
	return {
		messages: [
			// A rewrite marker newer than the turn makes its usage stale, so every
			// request is counted locally (a rebuilt history).
			{ role: "user", content: "summary", historyRewriteAt: 10, timestamp: 10 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: producer.api,
				provider: producer.provider,
				model: producer.id,
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: producer.provider,
					dt: true,
					items: [
						reasoningItem,
						{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
					],
				},
				usage: {
					input: 9_000,
					output: 6_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15_000,
					reasoningTokens: 5_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		],
	} as unknown as Context;
}

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});

	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});

	it("applies configured Responses verbosity and preserves caller overrides", () => {
		const settings = Settings.isolated({ textVerbosity: "low" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped({ ...stubModel, api: "anthropic-messages" }, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, { textVerbosity: "medium" });

		expect(calls[0]?.options?.textVerbosity).toBeUndefined();
		expect(calls[1]?.options?.textVerbosity).toBe("low");
		expect(calls[2]?.options?.textVerbosity).toBe("medium");
	});

	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});

	it("forwards retry.maxDelayMs while preserving caller overrides", () => {
		const settings = Settings.isolated({ "retry.maxDelayMs": 300_000 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, { maxRetryDelayMs: 5_000 });

		expect(calls[0]?.options?.maxRetryDelayMs).toBe(300_000);
		expect(calls[1]?.options?.maxRetryDelayMs).toBe(5_000);
	});

	it("forwards configured cache retention, leaves auto unset, and lets callers override", () => {
		const auto = captureBase();
		createSettingsAwareStreamFn(Settings.isolated({}), auto.fn)(stubModel, stubContext, undefined);
		// auto must stay unset so provider defaults and OMSP_CACHE_RETENTION apply
		expect(auto.calls[0]?.options?.cacheRetention).toBeUndefined();

		const long = captureBase();
		const settings = Settings.isolated({ "providers.cacheRetention": "long" });
		const wrapped = createSettingsAwareStreamFn(settings, long.fn);
		wrapped(stubModel, stubContext, undefined);
		expect(long.calls[0]?.options?.cacheRetention).toBe("long");

		wrapped(stubModel, stubContext, { cacheRetention: "none" });
		expect(long.calls[1]?.options?.cacheRetention).toBe("none");
	});

	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"model.loopGuard.checkAssistantContent": true,
			"model.loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});

	it("lowers the output cap so prompt plus output fits the model's context window", () => {
		// A large prompt plus the model's default output cap exceeded the window.
		// Test-env counts are bytes/4.
		const copilot: Model = {
			...stubModel,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		const promptTokens = 666_387;
		const context = {
			messages: [{ role: "user", content: "x".repeat(promptTokens * 4), timestamp: 0 }],
		} as unknown as Context;
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(copilot, context, { apiKey: "k" });
		wrapped(copilot, stubContext, { apiKey: "k" });

		const fitted = calls[0]?.options?.maxTokens;
		expect(fitted).toBeGreaterThan(0);
		expect(promptTokens + (fitted ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1_000_000);
		// A prompt that leaves room keeps the transport's own default.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	it("fits the output cap at the called model's prices, not an earlier model's", () => {
		const earlier: Model = { ...stubModel, api: "anthropic-messages", id: "earlier", contextWindow: 128_000 };
		const copilot: Model = { ...stubModel, contextWindow: 10_000 };
		const image = { type: "image", data: pngWithSize(2000, 2000), mimeType: "image/png", detail: "original" };
		const context = { messages: [{ role: "user", content: [image], timestamp: 0 }] } as unknown as Context;
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);
		const fresh = captureBase();

		wrapped(earlier, stubContext, { maxTokens: 8_000 });
		wrapped(copilot, context, { maxTokens: 8_000 });
		createSettingsAwareStreamFn(Settings.isolated({}), fresh.fn)(copilot, context, { maxTokens: 8_000 });

		const fitted = calls[1]?.options?.maxTokens ?? Number.POSITIVE_INFINITY;
		expect(fitted).toBe(fresh.calls[0]?.options?.maxTokens ?? Number.NaN);
		expect(fitted).toBeLessThan(8_000);
	});

	it("recounts replayed reasoning for a model it does not replay to", () => {
		// Same encoding, different Responses reader: only the producing model
		// replays the turn's 5,000 reasoning tokens.
		const sol: Model = { ...stubModel, contextWindow: 10_000, maxTokens: 9_000 };
		const other: Model = { ...stubModel, id: "other", contextWindow: 10_000, maxTokens: 9_000 };
		const context = replayedReasoningContext(sol);
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(sol, context, { apiKey: "k" });
		wrapped(other, context, { apiKey: "k" });

		// The producing model's prompt carries the reasoning, so its cap is fitted.
		expect(calls[0]?.options?.maxTokens).toBeLessThan(9_000);
		// The other model's prompt is a few tokens, so it keeps the transport default.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	it("does not fit the output cap over reasoning a cold Responses session leaves out", () => {
		const copilot: Model = {
			...getBundledModel("github-copilot", "gpt-5.4"),
			contextWindow: 10_000,
			maxTokens: 9_000,
		};
		const context = replayedReasoningContext(copilot);
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		// Fresh session state on a connection-bound host: the first request rebuilds
		// the turn from its text, so its prompt is a few tokens.
		wrapped(copilot, context, { apiKey: "k", providerSessionState: new Map() });
		// Without session state the request replays the reasoning.
		wrapped(copilot, context, { apiKey: "k" });

		expect(calls[0]?.options?.maxTokens).toBeUndefined();
		expect(calls[1]?.options?.maxTokens).toBeLessThan(9_000);
	});
});
