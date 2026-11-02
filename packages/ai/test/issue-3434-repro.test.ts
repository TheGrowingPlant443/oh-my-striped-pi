import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-striped-pi/pi-ai/dialect";
import { convertMessages } from "@oh-my-striped-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Message } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

const target = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});
const SIGNATURE = "opaque-anthropic-wire-signature";
const source: AssistantMessage = {
	role: "assistant",
	api: "anthropic-messages",
	provider: "github-copilot",
	model: "claude-sonnet-4.5",
	content: [
		{ type: "thinking", thinking: "Explore the repo, then patch it.", thinkingSignature: SIGNATURE },
		{ type: "text", text: "Done." },
	],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

describe("cross-API Copilot thinking history (#3433/#3434)", () => {
	it("demotes Anthropic reasoning to readable text without leaking its signature to Completions", () => {
		const messages: Message[] = [
			{ role: "user", content: "Plan it.", timestamp: 0 },
			source,
			{ role: "user", content: "Continue.", timestamp: 1 },
		];
		const wire = convertMessages(target, { messages }, target.compat);
		const assistant = wire.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toBe(`${renderDemotedThinking(target.id, "Explore the repo, then patch it.")}\nDone.`);
		expect(JSON.stringify(wire)).not.toContain(SIGNATURE);
		expect(source.content[0]).toEqual({
			type: "thinking",
			thinking: "Explore the repo, then patch it.",
			thinkingSignature: SIGNATURE,
		});
	});
});
