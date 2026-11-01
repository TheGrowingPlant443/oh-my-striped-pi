import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { completeSimple } from "../src/stream";

const model = buildModel({
	provider: "apple",
	api: "apple-foundation-models",
	id: "system-language-model",
	name: "On-device Apple model",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

describe("Apple Foundation Models native dispatch", () => {
	test("lowers a full transcript and named tool selection before native generation", async () => {
		let payload: Record<string, unknown> | undefined;
		const result = await completeSimple(
			model,
			{
				systemPrompt: ["Company instructions"],
				messages: [
					{ role: "user", content: "Read the local document", timestamp: 0 },
					{
						role: "toolResult",
						toolCallId: "read-1",
						toolName: "read",
						content: [{ type: "text", text: "document" }],
						isError: false,
						timestamp: 1,
					},
				],
				tools: [
					{
						name: "read",
						description: "Read a document",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
					{ name: "write", description: "Write a document", parameters: { type: "object", properties: {} } },
				],
			},
			{
				temperature: 0,
				reasoning: Effort.High,
				toolChoice: { type: "function", name: "read" },
				onPayload: request => {
					payload = request as Record<string, unknown>;
					// Exercise portable request lowering without invoking the platform-only bridge.
					throw new Error("Stop before native generation");
				},
			},
		);
		expect(payload?.instructions).toBe("Company instructions");
		expect(payload?.greedy).toBe(true);
		expect(payload?.reasoningLevel).toBe("deep");
		expect(payload?.toolChoice).toBe("required");
		expect(payload?.tools).toEqual([expect.objectContaining({ name: "read" })]);
		expect(payload?.entries).toContainEqual({
			kind: "prompt",
			parts: [{ type: "text", text: "Read the local document" }],
		});
		expect(result.provider).toBe("apple");
		expect(result.api).toBe("apple-foundation-models");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Stop before native generation");
	});
});
