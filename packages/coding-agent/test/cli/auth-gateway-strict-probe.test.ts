import { afterEach, describe, expect, test, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { CompletionProbeInput, Provider } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createStrictCompletionProbe } from "../../src/cli/auth-gateway-cli";

afterEach(() => {
	vi.restoreAllMocks();
	unregisterOAuthProvider("company-structured");
	unregisterOAuthProvider("company-bearer");
});

function oauthProbeInput(provider: Provider): CompletionProbeInput {
	return {
		provider,
		credentialId: 1,
		credential: {
			type: "oauth",
			accessToken: "access-token",
			refreshToken: "refresh-token",
			expiresAt: 1_900_000_000_000,
			projectId: "project-1",
		},
		signal: new AbortController().signal,
	};
}

/** Runs one strict probe and returns the apiKey the chat request received. */
async function probeApiKey(
	provider: Provider,
	getApiKey?: (credential: OAuthCredentials) => string,
): Promise<string | undefined> {
	registerOAuthProvider({
		id: provider,
		name: provider,
		login: async () => ({
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_900_000_000_000,
			projectId: "project-1",
		}),
		getApiKey,
	});
	const model = buildModel({
		id: "company-chat",
		name: "Company Chat",
		provider,
		api: "openai-completions",
		baseUrl: "https://models.company.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text: "pong" }],
	} as never);
	const result = await createStrictCompletionProbe([model])(oauthProbeInput(provider));
	expect(result.ok).toBe(true);
	expect(complete).toHaveBeenCalledTimes(1);
	expect(complete.mock.calls[0]?.[0]).toBe(model);
	const apiKey = complete.mock.calls[0]?.[2]?.apiKey;
	return typeof apiKey === "string" ? apiKey : undefined;
}

describe("auth-gateway check --strict completion probe", () => {
	test("sends the structured credential blob for a structured-format OAuth provider", async () => {
		const apiKey = await probeApiKey("company-structured", credential =>
			JSON.stringify({ token: credential.access, projectId: credential.projectId }),
		);
		expect(JSON.parse(apiKey ?? "")).toMatchObject({ token: "access-token", projectId: "project-1" });
	});

	test("sends the raw access token for a bearer-format OAuth provider", async () => {
		expect(await probeApiKey("company-bearer")).toBe("access-token");
	});
});
