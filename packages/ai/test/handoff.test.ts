import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-striped-pi/omptype";
import { complete } from "@oh-my-striped-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	Tool,
	ToolResultMessage,
} from "@oh-my-striped-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

// Tool for testing
const weatherSchema = type({
	location: type("string").describe("City name"),
});

const weatherTool: Tool<typeof weatherSchema> = {
	name: "get_weather",
	description: "Get the weather for a location",
	parameters: weatherSchema,
};

// Local transcript fixtures exercise each retained wire format.
const providerContexts = {
	// Anthropic-style message with thinking block
	anthropic: {
		message: {
			role: "assistant",
			api: "anthropic-messages",
			content: [
				{
					type: "thinking",
					thinking: "Let me calculate 17 * 23. That's 17 * 20 + 17 * 3 = 340 + 51 = 391",
					thinkingSignature: "signature_abc123",
				},
				{
					type: "text",
					text: "I'll help you with the calculation and check the weather. The result of 17 × 23 is 391. The capital of Austria is Vienna. Now let me check the weather for you.",
				},
				{
					type: "toolCall",
					id: "toolu_01abc123",
					name: "get_weather",
					arguments: { location: "Tokyo" },
				},
			],
			provider: "local",
			model: "local-anthropic",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "toolu_01abc123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Tokyo: 18°C, partly cloudy" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 391,
			city: "Tokyo",
			temperature: 18,
			capital: "Vienna",
		},
	},

	// Local chat transcript with unsigned thinking
	local: {
		message: {
			role: "assistant",
			api: "openai-completions",
			content: [
				{
					type: "thinking",
					thinking:
						"I need to multiply 19 * 24. Let me work through this: 19 * 24 = 19 * 20 + 19 * 4 = 380 + 76 = 456",
					thinkingSignature: undefined,
				},
				{
					type: "text",
					text: "The multiplication of 19 × 24 equals 456. The capital of France is Paris. Let me check the weather in Berlin for you.",
				},
				{
					type: "toolCall",
					id: "call_local_123",
					name: "get_weather",
					arguments: { location: "Berlin" },
				},
			],
			provider: "local",
			model: "local-chat",
			usage: {
				input: 120,
				output: 60,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 180,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_local_123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Berlin: 22°C, sunny" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 456,
			city: "Berlin",
			temperature: 22,
			capital: "Paris",
		},
	},

	// OpenAI Completions style (with reasoning_content)
	openaiCompletions: {
		message: {
			role: "assistant",
			api: "openai-completions",
			content: [
				{
					type: "thinking",
					thinking: "Let me calculate 21 * 25. That's 21 * 25 = 525",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "text",
					text: "The result of 21 × 25 is 525. The capital of Spain is Madrid. I'll check the weather in London now.",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "get_weather",
					arguments: { location: "London" },
				},
			],
			provider: "local",
			model: "local-completions",
			usage: {
				input: 110,
				output: 55,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 165,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_abc123",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in London: 15°C, rainy" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 525,
			city: "London",
			temperature: 15,
			capital: "Madrid",
		},
	},

	// OpenAI Responses style (with complex tool call IDs)
	openaiResponses: {
		message: {
			role: "assistant",
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "Calculating 18 * 27: 18 * 27 = 486",
					thinkingSignature:
						'{"type":"reasoning","id":"rs_2b2342acdde","summary":[{"type":"summary_text","text":"Calculating 18 * 27: 18 * 27 = 486"}]}',
				},
				{
					type: "text",
					text: "The calculation of 18 × 27 gives us 486. The capital of Italy is Rome. Let me check Sydney's weather.",
					textSignature: "msg_response_456",
				},
				{
					type: "toolCall",
					id: "call_789|item_012",
					name: "get_weather",
					arguments: { location: "Sydney" },
				},
			],
			provider: "local",
			model: "local-responses",
			usage: {
				input: 115,
				output: 58,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 173,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: {
			role: "toolResult" as const,
			toolCallId: "call_789|item_012",
			toolName: "get_weather",
			content: [{ type: "text", text: "Weather in Sydney: 25°C, clear" }],
			isError: false,
			timestamp: Date.now(),
		} satisfies ToolResultMessage,
		facts: {
			calculation: 486,
			city: "Sydney",
			temperature: 25,
			capital: "Rome",
		},
	},

	// Aborted message (stopReason: 'error')
	aborted: {
		message: {
			role: "assistant",
			api: "anthropic-messages",
			content: [
				{
					type: "thinking",
					thinking: "Let me start calculating 20 * 30...",
					thinkingSignature: "partial_sig",
				},
				{
					type: "text",
					text: "I was about to calculate 20 × 30 which is",
				},
			],
			provider: "local",
			model: "local-interrupted",
			usage: {
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 75,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Request was aborted",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResult: null,
		facts: {
			calculation: 600,
			city: "none",
			temperature: 0,
			capital: "none",
		},
	},
};

/**
 * Test that Copilot can handle contexts from different wire formats.
 */
async function testProviderHandoff<TApi extends Api>(
	targetModel: Model<TApi>,
	sourceLabel: string,
	sourceContext: (typeof providerContexts)[keyof typeof providerContexts],
): Promise<boolean> {
	// Build conversation context
	const assistantMessage: AssistantMessage = sourceContext.message;
	const toolResult: ToolResultMessage | undefined | null = sourceContext.toolResult;

	const messages: Message[] = [
		{
			role: "user",
			content: "Please do some calculations, tell me about capitals, and check the weather.",
			timestamp: Date.now(),
		},
		assistantMessage,
	];

	// Add tool result if present
	if (toolResult) {
		messages.push(toolResult);
	}

	// Ask follow-up question
	messages.push({
		role: "user",
		content: `Based on our conversation, please answer:
                 1) What was the multiplication result?
                 2) Which city's weather did we check?
                 3) What was the temperature?
                 4) What capital city was mentioned?
                 Please include the specific numbers and names.`,
		timestamp: Date.now(),
	});

	const context: Context = {
		messages,
		tools: [weatherTool],
	};

	try {
		const response = await complete(targetModel, context, { apiKey: githubCopilotToken });

		// Check for error
		if (response.stopReason === "error") {
			console.log(`[${sourceLabel} → ${targetModel.provider}] Failed with error: ${response.errorMessage}`);
			return false;
		}

		// Extract text from response
		const responseText = response.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join(" ")
			.toLowerCase();

		// For aborted messages, we don't expect to find the facts
		if (sourceContext.message.stopReason === "error") {
			const hasToolCalls = response.content.some(b => b.type === "toolCall");
			const hasThinking = response.content.some(b => b.type === "thinking");
			const hasText = response.content.some(b => b.type === "text");

			expect(response.stopReason === "stop" || response.stopReason === "toolUse").toBe(true);
			expect(hasThinking || hasText || hasToolCalls).toBe(true);
			console.log(
				`[${sourceLabel} → ${targetModel.provider}] Handled aborted message successfully, tool calls: ${hasToolCalls}, thinking: ${hasThinking}, text: ${hasText}`,
			);
			return true;
		}

		// Check if response contains our facts
		const hasCalculation = responseText.includes(sourceContext.facts.calculation.toString());
		const hasCity =
			sourceContext.facts.city !== "none" && responseText.includes(sourceContext.facts.city.toLowerCase());
		const hasTemperature =
			sourceContext.facts.temperature > 0 && responseText.includes(sourceContext.facts.temperature.toString());
		const hasCapital =
			sourceContext.facts.capital !== "none" && responseText.includes(sourceContext.facts.capital.toLowerCase());

		const success = hasCalculation && hasCity && hasTemperature && hasCapital;

		console.log(`[${sourceLabel} → ${targetModel.provider}] Handoff test:`);
		if (!success) {
			console.log(`  Calculation (${sourceContext.facts.calculation}): ${hasCalculation ? "✓" : "✗"}`);
			console.log(`  City (${sourceContext.facts.city}): ${hasCity ? "✓" : "✗"}`);
			console.log(`  Temperature (${sourceContext.facts.temperature}): ${hasTemperature ? "✓" : "✗"}`);
			console.log(`  Capital (${sourceContext.facts.capital}): ${hasCapital ? "✓" : "✗"}`);
		} else {
			console.log(`  ✓ All facts found`);
		}

		return success;
	} catch (error) {
		console.error(`[${sourceLabel} → ${targetModel.provider}] Exception:`, error);
		return false;
	}
}

describe("Copilot Wire Handoff Tests", () => {
	for (const modelId of ["gpt-4o", "claude-sonnet-4", "gpt-5-mini"]) {
		it.skipIf(!githubCopilotToken)(
			`${modelId} should handle local transcript contexts`,
			async () => {
				const model = getBundledModel("github-copilot", modelId);
				for (const [label, context] of Object.entries(providerContexts)) {
					expect(await testProviderHandoff(model, label, context)).toBe(true);
				}
			},
			60000,
		);
	}
});
