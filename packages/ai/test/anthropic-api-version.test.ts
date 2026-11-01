import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const SPEC = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as const;

const OFFICIAL: Model<"anthropic-messages"> = buildModel({ ...SPEC, input: [...SPEC.input] });

interface Captured {
	version: string | null;
	body: { temperature?: number; top_p?: number; top_k?: number };
}

async function capture(model: Model<"anthropic-messages">, apiKey: string): Promise<Captured> {
	let captured: Captured | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		captured = {
			version: new Headers(init?.headers).get("anthropic-version"),
			body: JSON.parse(requestBodyText(init) ?? "{}"),
		};
		return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	await streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
		{ apiKey, thinkingEnabled: false, temperature: 0.2, topP: 0.3, topK: 4, fetch: fetchMock },
	).result();
	if (!captured) throw new Error("request was not sent");
	return captured;
}

describe("anthropic API version", () => {
	it("keeps 2023-06-01 and sampling params on the Copilot wire", async () => {
		const { version, body } = await capture(OFFICIAL, "ghu_test");
		expect(version).toBe("2023-06-01");
		expect(body).toMatchObject({ temperature: 0.2, top_p: 0.3, top_k: 4 });
	});
});
