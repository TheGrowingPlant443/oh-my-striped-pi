import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicCompat, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Explicit disabled-thinking dialect overrides layer onto resolved Copilot policy. */
function model(id: string, compat: AnthropicCompat = {}): Model<"anthropic-messages"> {
	const built = buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	return { ...built, compat: { ...built.compat, ...compat } };
}

/** A thinking-led tool round trip, then a new user turn. */
function thinkingLedHistory(id: string): Context {
	return {
		messages: [
			{ role: "user", content: "Read probe.txt.", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Read it.", thinkingSignature: "sig" },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "probe.txt" } },
				],
				api: "anthropic-messages",
				provider: "github-copilot",
				model: id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "nonce" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } }],
	};
}

interface Payload {
	thinking?: { type: string };
	output_config?: { effort?: string };
	messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
}

async function payloadFor(target: Model<"anthropic-messages">, context: Context): Promise<Payload> {
	const controller = new AbortController();
	controller.abort();
	let payload: unknown;
	await streamAnthropic(target, context, {
		apiKey: "sk-ant-api-test",
		signal: controller.signal,
		thinkingEnabled: false,
		onPayload: captured => {
			payload = captured;
		},
	}).result();
	if (!payload) throw new Error("expected a built payload");
	return payload as Payload;
}

const assistantBlockTypes = (payload: Payload) =>
	payload.messages
		.filter(message => message.role === "assistant")
		.flatMap(message => (Array.isArray(message.content) ? message.content.map(block => block.type) : []));

describe("Anthropic disabled-thinking compat", () => {
	it("sends between_tools with the pinned effort when the route declares that disabled form", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { disabledThinking: "between-tools", betweenToolsEffort: "high" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it("pins the declared effort on the model's own between_tools fallback too", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { betweenToolsEffort: "medium" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("medium");
	});

	it("replays history without thinking blocks when a stripping route sends disabled", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled", stripThinkingHistory: true }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["tool_use"]);
	});

	it("keeps replayed thinking on disabled turns for routes without the strip contract", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled" }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["thinking", "tool_use"]);
	});
});

/** Copilot fixture for explicit binding controls and payload-hook overrides. */
function haiku(provider: "github-copilot", id = "claude-haiku-5-5"): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

describe("Anthropic thinking-binding beta follows block_binding", () => {
	it.each(["drop_block", "error"] as const)("honors the explicit prefix-mismatch override %s", async behavior => {
		const target = buildModel({
			...haiku("github-copilot"),
			compat: { supportsThinkingBindingControls: true },
		});
		let thinking: unknown;
		let beta = "";
		await streamAnthropic(
			target,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "ghu_test",
				thinkingEnabled: true,
				anthropicPrefixMismatchBehavior: behavior,
				onPayload: payload => {
					if (!payload || typeof payload !== "object" || !("thinking" in payload)) {
						throw new Error("expected a thinking request");
					}
					thinking = payload.thinking;
				},
				fetch: async (_url, init) => {
					beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
					return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
				},
			},
		).result();
		expect(thinking).toMatchObject({ type: "adaptive", block_binding: { prefix_mismatch_behavior: behavior } });
		expect(beta).toContain("thinking-binding-controls-2026-08-01");
	});

	it.each([
		["adds block_binding", { prefix_mismatch_behavior: "drop_block" }, true],
		["leaves block_binding explicitly undefined", undefined, false],
	] as const)("an onPayload hook that %s gets the binding beta: %p", async (_label, binding, expected) => {
		const target = haiku("github-copilot");
		let beta = "";
		await streamAnthropic(
			target,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "sk-ant-api-test",
				thinkingEnabled: false,
				onPayload: payload => ({
					...(payload as Record<string, unknown>),
					thinking: { type: "adaptive", block_binding: binding },
				}),
				fetch: async (_url, init) => {
					beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
					return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
				},
			},
		).result();
		expect(beta.includes("thinking-binding-controls-2026-08-01")).toBe(expected);
	});
});
