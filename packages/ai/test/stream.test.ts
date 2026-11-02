import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-striped-pi/omptype";
import { Effort } from "@oh-my-striped-pi/pi-ai";
import { complete, stream } from "@oh-my-striped-pi/pi-ai/stream";
import type {
	Api,
	Context,
	ImageContent,
	Model,
	OptionsForApi,
	Tool,
	ToolResultMessage,
} from "@oh-my-striped-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { resolveApiKey } from "./oauth";

const githubCopilotToken = await resolveApiKey("github-copilot");

// Calculator tool definition (same as examples)
const calculatorSchema = type({
	a: "number",
	b: "number",
	operation: "'add'|'subtract'|'multiply'|'divide'",
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant. Be concise."],
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that uses tools when asked."],
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const s = stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let accumulatedToolArgs = "";
	let index = 0;
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			const toolCall = event.partial.content[event.contentIndex];
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				JSON.parse(accumulatedToolArgs);
				expect(toolCall.arguments).not.toBeUndefined();
				expect(toolCall.arguments.a).toBe(15);
				expect(toolCall.arguments.b).toBe(27);
				expect(
					["add", "subtract", "multiply", "divide"].some(operation => operation === toolCall.arguments.operation),
				).toBe(true);
			}
		}
	}

	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	expect(response.content.some(b => b.type === "toolCall")).toBeTruthy();
	const toolCall = response.content.find(b => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some(b => b.type === "text")).toBeTruthy();
}

async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				content: `Think long and hard about ${
					(Math.random() * 255) | 0
				} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some(b => b.type === "thinking")).toBeTruthy();
}

async function handleImage<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = path.join(import.meta.dir, "data", "red-circle.png");
	const imageBuffer = await fs.readFile(imagePath);
	const base64Image = imageBuffer.toBase64();

	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	const textContent = response.content.find(b => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that can use tools to answer questions."],
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		context.messages.push(response);

		// Process content blocks
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				const a = Number(block.arguments.a);
				const b = Number(block.arguments.b);
				const operation = typeof block.arguments.operation === "string" ? block.arguments.operation : "";
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

describe("Generate E2E Tests", () => {
	describe("GitHub Copilot Provider (gpt-4o via OpenAI Completions)", () => {
		const llm = getBundledModel("github-copilot", "gpt-4o");

		it.skipIf(!githubCopilotToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle thinking",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await handleThinking(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 2 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await multiTurn(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);
	});
});
