import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-striped-pi/pi-ai/providers/anthropic";
import type { Context, UserMessage } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

const model = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});
const SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\nContinue with chunk 11.";

describe("Anthropic compaction history on Copilot", () => {
	it.each([
		{ provider: "anthropic", signature: "sig_opaque_on_demand" },
		{ provider: "github-copilot", signature: "sig_opaque_on_demand" },
		{ provider: "anthropic", encryptedContent: "enc_opaque_legacy" },
	])("keeps readable summaries without replaying unsupported signed blocks: %p", async state => {
		const summary: UserMessage = {
			role: "user",
			content: `<summary>${SUMMARY}</summary>`,
			providerPayload: { type: "anthropicCompaction", content: SUMMARY, ...state },
			timestamp: 1,
		};
		const messages: Context["messages"] = [summary, { role: "user", content: "next", timestamp: 2 }];
		const wire = convertAnthropicMessages(messages, model);
		expect(wire[0]).toMatchObject({ role: "user", content: `<summary>${SUMMARY}</summary>` });
		let payload: Record<string, unknown> | undefined;
		let beta = "";
		await streamAnthropic(
			model,
			{ messages },
			{
				apiKey: "ghu_test",
				onPayload: value => {
					payload = value as Record<string, unknown>;
				},
				fetch: async (_input, init) => {
					beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
					return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
				},
			},
		).result();
		expect(payload).toBeDefined();
		expect(JSON.stringify(payload?.messages)).toContain(SUMMARY.replaceAll("\n", "\\n"));
		expect(JSON.stringify(payload)).not.toContain("sig_opaque_on_demand");
		expect(JSON.stringify(payload)).not.toContain("enc_opaque_legacy");
		expect(payload?.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-");
	});
});
