// Contract: an ImageContent carrying `url` ships the URL to providers whose
// APIs fetch remote images — and its base64 payload stays off the wire.
// Undecorated blocks keep the inline base64 forms byte-for-byte.
import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { convertResponsesInputContent } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Message, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const PNG_B64 = Buffer.from("not-actually-a-png, but bytes are opaque here").toString("base64");
const BLOB_URL = "https://blobs.example.com/0123456789abcdef0123456789abcdef.png";
const userMessage: Message = {
	role: "user",
	content: [
		{ type: "text", text: "what is in these?" },
		{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL },
		{ type: "image", data: PNG_B64, mimeType: "image/png" },
	],
	timestamp: 0,
};

describe("image url parts", () => {
	it("anthropic sends a url source for decorated blocks and base64 for the rest", () => {
		const model = getBundledModel("github-copilot", "claude-sonnet-4.6") as Model<"anthropic-messages">;
		const params = convertAnthropicMessages([userMessage], model);

		expect(params).toHaveLength(1);
		const content = params[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
		const images = content.filter(block => block.type === "image");
		expect(images[0].source).toEqual({ type: "url", url: BLOB_URL });
		expect(images[1].source).toMatchObject({ type: "base64", media_type: "image/png", data: PNG_B64 });
		// The decorated block's bytes must not ride along anywhere in the message.
		expect(JSON.stringify(images[0])).not.toContain(PNG_B64);
	});

	it("responses input uses the url as image_url and a data URI otherwise", () => {
		const converted = convertResponsesInputContent(
			userMessage.content as Exclude<typeof userMessage.content, string>,
			true,
			true,
		);

		const images = (converted ?? []).flatMap(part => (part.type === "input_image" ? [part] : []));
		expect(images[0].image_url).toBe(BLOB_URL);
		expect(images[1].image_url).toBe(`data:image/png;base64,${PNG_B64}`);
	});

	it("completions sends the url in image_url content parts", async () => {
		const model = {
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
		} satisfies Model<"openai-completions">;
		let captured: { messages?: Array<{ content: unknown }> } | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const sse =
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
				"data: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;

		const context: Context = { messages: [userMessage] };
		await streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchImpl }).result();

		const parts = captured?.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
		const images = parts.filter(part => part.type === "image_url");
		expect(images[0].image_url?.url).toBe(BLOB_URL);
		expect(images[1].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
	});
});
