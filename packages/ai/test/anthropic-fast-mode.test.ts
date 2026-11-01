import { describe, expect, it } from "bun:test";
import { isFastModeUnsupported } from "@oh-my-pi/pi-ai/error";
import {
	clearAnthropicFastModeFallback,
	isAnthropicFastModeFallbackDisabled,
	streamAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ProviderSessionState, ServiceTier } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: { fastMode: true },
	});
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CaptureOptions = {
	serviceTier?: ServiceTier;
	providerSessionState?: Map<string, ProviderSessionState>;
};

function capturePayload(model: Model<"anthropic-messages">, opts: CaptureOptions): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		signal: abortedSignal(),
		serviceTier: opts.serviceTier,
		providerSessionState: opts.providerSessionState,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

withOfficialAnthropicEndpoint();

describe("Anthropic priority service tier with an explicit fast-mode override", () => {
	it("forwards speed='fast' when the caller opts into fast mode", async () => {
		const payload = (await capturePayload(makeAnthropicModel("claude-opus-4-5"), {
			serviceTier: "priority",
		})) as { speed?: string };
		expect(payload.speed).toBe("fast");
	});

	describe("provider-session fallback scope", () => {
		function stateKey(model: Model<"anthropic-messages">): string {
			return `anthropic-messages:${model.baseUrl}\u0000${model.id}`;
		}

		it("inspects the exact model and endpoint fallback without bleeding to other requests", async () => {
			const model = makeAnthropicModel("claude-opus-4-7");
			const otherModel = makeAnthropicModel("claude-opus-4-6");
			const otherEndpoint = buildModel({
				...model,
				id: model.id,
				name: `${model.id} gateway`,
				baseUrl: "https://gateway.example/v1",
			});
			const state = new Map<string, ProviderSessionState>();
			state.set(stateKey(model), {
				strictToolsDisabled: false,
				fastModeDisabled: true,
				replayUnsignedThinkingDisabled: false,
				close: () => {},
			} as ProviderSessionState);

			const matching = (await capturePayload(model, {
				serviceTier: "priority",
				providerSessionState: state,
			})) as Record<string, unknown>;
			const differentModel = (await capturePayload(otherModel, {
				serviceTier: "priority",
				providerSessionState: state,
			})) as Record<string, unknown>;
			const differentEndpoint = (await capturePayload(otherEndpoint, {
				serviceTier: "priority",
				providerSessionState: state,
			})) as Record<string, unknown>;

			expect(isAnthropicFastModeFallbackDisabled(state, model)).toBe(true);
			expect(isAnthropicFastModeFallbackDisabled(state, otherModel)).toBe(false);
			expect(isAnthropicFastModeFallbackDisabled(state, otherEndpoint)).toBe(false);
			expect(matching.speed).toBeUndefined();
			expect(differentModel.speed).toBe("fast");
			expect(differentEndpoint.speed).toBe("fast");
		});
	});
});

describe("clearAnthropicFastModeFallback", () => {
	it("is a no-op when the anthropic state entry hasn't been materialized", () => {
		const map = new Map<string, ProviderSessionState>();
		clearAnthropicFastModeFallback(map);
		expect(map.size).toBe(0);
	});

	it("flips fastModeDisabled back to false without touching unrelated flags", () => {
		const map = new Map<string, ProviderSessionState>();
		const state = {
			strictToolsDisabled: true,
			fastModeDisabled: true,
			close: () => {},
		} as ProviderSessionState & { strictToolsDisabled: boolean; fastModeDisabled: boolean };
		map.set("anthropic-messages", state);

		clearAnthropicFastModeFallback(map);

		expect(state.fastModeDisabled).toBe(false);
		// Strict-tools learning survives — only the fast-mode flag is reset.
		expect(state.strictToolsDisabled).toBe(true);
	});
});

describe("isFastModeUnsupported", () => {
	function makeStatusError(status: number, message: string): Error {
		const err = new Error(message) as Error & { status: number };
		err.status = status;
		return err;
	}

	it("detects 400 invalid_request_error when the model rejects `speed`", () => {
		const err = makeStatusError(
			400,
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"\'claude-opus-4-5-20251101\' does not support the `speed` parameter."}}',
		);
		expect(isFastModeUnsupported(err)).toBe(true);
	});

	it("detects 429 rate_limit_error when fast mode requires extra usage", () => {
		// Regression: prior to this fix, 429 with rate_limit_error fell through to
		// the generic retry path and looped forever instead of dropping `speed: fast`.
		const err = makeStatusError(
			429,
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"Extra usage is required for fast mode."}}',
		);
		expect(isFastModeUnsupported(err)).toBe(true);
	});

	it("ignores unrelated 429 rate limits", () => {
		const err = makeStatusError(
			429,
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your account\'s rate limit."}}',
		);
		expect(isFastModeUnsupported(err)).toBe(false);
	});

	it("ignores unrelated 400 invalid_request errors", () => {
		const err = makeStatusError(
			400,
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}',
		);
		expect(isFastModeUnsupported(err)).toBe(false);
	});
});
