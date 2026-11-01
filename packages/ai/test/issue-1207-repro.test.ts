import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

function contextWithTools(tools: Tool[] = [echoTool]): Context {
	return {
		messages: [{ role: "user", content: "call tool", timestamp: Date.now() }],
		tools,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface CaptureOptions {
	tools?: Tool[];
	reasoning?: Effort;
	disableReasoning?: boolean;
}

async function capturePayload(
	model: Model<"openai-completions">,
	options: CaptureOptions = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, contextWithTools(options.tools), {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning: options.disableReasoning ? undefined : (options.reasoning ?? Effort.High),
		disableReasoning: options.disableReasoning,
		toolChoice: "auto",
		maxTokens: 123,
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

describe("issue #1207 — tool schema conversion", () => {
	it("does not nest anyOf branches in generic tool schemas", async () => {
		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;
		const unionTool: Tool = {
			name: "union_repro",
			description: "Union schema repro",
			parameters: type({
				paths: "(string | string[])?",
			}),
		};
		const body = await capturePayload(model, { tools: [unionTool] });
		const tools = body.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
		const properties = tools[0].function.parameters.properties as Record<string, Record<string, unknown>>;
		const branches = properties.paths.anyOf as Array<Record<string, unknown>>;

		expect(branches.map(branch => branch.type)).toEqual(["string", "array", "null"]);
		expect(branches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});
});
