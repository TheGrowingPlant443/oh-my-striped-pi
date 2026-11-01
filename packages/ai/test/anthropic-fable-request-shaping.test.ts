import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

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
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

/** Adaptive-thinking model (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5). */
function adaptiveModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: { type: string };
	tool_choice?: { type: string };
	output_config?: { effort?: string };
};

async function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
	context: Context = CONTEXT,
): Promise<CapturedPayload> {
	let payload: CapturedPayload | undefined;
	await streamAnthropic(model, context, {
		apiKey: "ghu_test",
		signal: abortedSignal(),
		onPayload: captured => {
			payload = captured as CapturedPayload;
		},
		...opts,
	}).result();
	if (!payload) throw new Error("expected a built payload");
	return payload;
}

describe("Anthropic forced tool_choice", () => {
	it("downgrades a forced tool to auto for Fable (which rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("downgrades tool_choice:'any' to auto for Mythos", async () => {
		const payload = await capturePayload(adaptiveModel("claude-mythos-5"), {
			toolChoice: "any",
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("downgrades a forced tool to auto for Opus 5.5 (rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-5-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("preserves a forced tool_choice below the Opus 5.5 floor (Opus 5, Opus 4.8)", async () => {
		for (const id of ["claude-opus-5", "claude-opus-4-8"]) {
			const payload = await capturePayload(adaptiveModel(id), {
				toolChoice: { type: "tool", name: "get_weather" },
			});
			expect(payload.tool_choice?.type).toBe("tool");
		}
	});
});

describe("Anthropic adaptive-only thinking disable", () => {
	it("never sends thinking.type:'disabled' to an adaptive-only model, pins lowest effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config?.effort).toBe("low");
	});

	it("turns thinking off with between_tools on Sonnet 5.5, without an effort pin or block_binding", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-sonnet-5-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("keeps Sonnet 5 on adaptive-only omission, never sending between_tools", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-sonnet-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking?.type).not.toBe("between_tools");
	});

	it("still sends thinking.type:'disabled' for budget-based (non-adaptive) models", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-3-7-sonnet-20250219"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking?.type).toBe("disabled");
	});
});
