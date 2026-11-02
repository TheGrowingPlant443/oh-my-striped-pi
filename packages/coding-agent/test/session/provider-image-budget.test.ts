import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, Message, TextContent } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
} from "@oh-my-striped-pi/pi-coding-agent/session/provider-image-budget";
import { providerImageBudget } from "@oh-my-striped-pi/snapcompact";

const MODEL = buildModel({
	id: "gpt-5.5",
	name: "GPT 5.5",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});
const IMAGE_BUDGET = providerImageBudget(MODEL);

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const count = IMAGE_BUDGET + 2;
		const context: Context = {
			messages: Array.from({ length: count }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImages(context, MODEL);
		expect(imageData(clamped)).toEqual(Array.from({ length: IMAGE_BUDGET }, (_, index) => `image-${index + 2}`));
		expect(textData(clamped)).toEqual(Array.from({ length: count }, (_, index) => `text-${index}`));
		expect(imageData(context)).toHaveLength(count);
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			messages: Array.from({ length: IMAGE_BUDGET + 1 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImages(context, MODEL);
		expect(imageData(clamped)).toEqual(Array.from({ length: IMAGE_BUDGET }, (_, index) => `image-${index + 1}`));
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: IMAGE_BUDGET }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};
		const clamped = clampProviderContextImages(context, MODEL);
		const [user, developer] = clamped.messages;
		if (user?.role !== "user" || developer?.role !== "developer") throw new Error("Expected input messages");
		expect(user.providerPayload).toBeUndefined();
		expect(developer.providerPayload).toBeUndefined();
		expect(context.messages[0]).toHaveProperty("providerPayload", userPayload);
		expect(context.messages[1]).toHaveProperty("providerPayload", developerPayload);
		expect(imageData(clamped)).toHaveLength(IMAGE_BUDGET);
	});

	it("does not charge assistant output images against the input image budget", () => {
		const generated = Array.from({ length: IMAGE_BUDGET + 2 }, (_, index) => image(`generated-${index}`));
		const context: Context = {
			messages: [
				{ role: "user", content: [image("user-image")], timestamp: 0 },
				{
					role: "assistant",
					content: generated,
					api: MODEL.api,
					provider: MODEL.provider,
					model: MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [image("tool-image")],
					isError: false,
					timestamp: 2,
				},
			],
		};
		expect(clampProviderContextImages(context, MODEL)).toBe(context);
	});

	it("counts a computer result as its metadata screenshot, not its content thumbnails", () => {
		const result: Message = {
			role: "toolResult",
			toolCallId: "call-0",
			toolName: "computer",
			content: Array.from({ length: IMAGE_BUDGET + 1 }, () => image("thumbnail")),
			isError: false,
			timestamp: 0,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "https://images.example/screen.png" },
				acknowledgedSafetyChecks: [],
			},
		};
		const context: Context = { messages: [result] };
		expect(clampProviderContextImages(context, MODEL)).toBe(context);
		const inlineOnlyModel = buildModel({
			id: "claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		expect(imageData(clampProviderContextImages(context, inlineOnlyModel))).toHaveLength(
			providerImageBudget(inlineOnlyModel),
		);
	});

	it("counts published URL images toward the cap without dropping their references", () => {
		const context: Context = {
			messages: Array.from({ length: IMAGE_BUDGET + 1 }, (_, index) => ({
				role: "user",
				content: [{ ...image(""), url: `https://images.example/${index}.png` }],
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImages(context, MODEL);
		expect(imageData(clamped)).toHaveLength(IMAGE_BUDGET);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(clamped.messages[1]).toBe(context.messages[1]);
	});

	it("does not inherit deleted providers' inline byte policies", () => {
		const context: Context = {
			messages: [{ role: "user", content: [image("A".repeat(25_000_000))], timestamp: 0 }],
		};
		expect(clampProviderContextImageBytes(context, MODEL)).toBe(context);
	});

	it("preserves context identity below the cap and for text-only models", () => {
		const context: Context = {
			messages: [{ role: "user", content: [text("ok"), image("image")], timestamp: 0 }],
		};
		expect(clampProviderContextImages(context, MODEL)).toBe(context);
		expect(clampProviderContextImages(context, { ...MODEL, input: ["text"] })).toBe(context);
	});

	it("caps summary archive frames without changing live images", () => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C"), text("tail")],
					historyRewriteAt: 1,
					timestamp: 1,
				},
				{ role: "user", content: [text("screenshot"), frame("D")], timestamp: 2 },
			],
		};
		const capped = capArchiveFrameBytes(context, MODEL);
		expect(imageData(capped).map(data => data[0])).toEqual(["C", "D"]);
		expect(textData(capped)).toContainEqual(expect.stringContaining("2 archived image frames could not be included"));
		expect(capped.messages[1]).toBe(context.messages[1]);
	});
});
