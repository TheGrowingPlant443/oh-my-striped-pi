import type { AssistantMessage, Model, Usage, UserMessage } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

/** Creates a Copilot model with explicit generic Harmony leak mitigation. */
export function createHarmonyMitigationModel(): Model<"openai-responses"> {
	const model = buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
	return { ...model, compat: { ...model.compat, harmonyLeakMitigation: true } };
}

/** Creates a timestamped user message for agent-loop tests. */
export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** Creates a timestamped mock assistant message with zero usage. */
export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "local-inference",
		provider: "local",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
