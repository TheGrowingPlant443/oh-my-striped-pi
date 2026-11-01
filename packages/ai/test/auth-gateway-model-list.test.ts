import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { classifyGatewayError, MissingApiKeyError, OAuthRefreshUnavailableError } from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveGatewayApiKey } from "../src/auth-gateway/dispatch";

test("model listing exposes one provider-qualified route per upstream model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-model-list-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const local = createMockModel({ id: "shared-model" });
	const copilot = { ...local, provider: "github-copilot", api: "openai-completions" as const };
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		listModels: () => [local, local, copilot, copilot],
		version: "test",
	});

	try {
		const response = await fetch(`${handle.url}/v1/models`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{
					id: "local/shared-model",
					object: "model",
					owned_by: "local",
					api: "local-inference",
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
				{
					id: "github-copilot/shared-model",
					object: "model",
					owned_by: "github-copilot",
					api: "openai-completions",
					display_name: "shared-model",
					context_length: 200_000,
					max_output_tokens: 32_768,
					input_modalities: ["text"],
				},
			],
		});
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test.each(["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"])(
	"rejects a resolved HTTP model without an endpoint before credentials or upstream dispatch through %s",
	async route => {
		const storage = await AuthStorage.create(":memory:");
		const forbidden = buildModel({
			...createMockModel({ id: "company-model" }),
			provider: "company",
			api: "openai-completions",
			baseUrl: "",
		});
		let credentialLookups = 0;
		let upstreamCalls = 0;
		const original = storage.keys.getWithCredential.bind(storage.keys);
		storage.keys.getWithCredential = (...args) => {
			credentialLookups++;
			return original(...args);
		};
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [],
			storage,
			resolveModel: () => forbidden,
			fetch: async () => {
				upstreamCalls++;
				throw new Error("unexpected upstream call");
			},
			version: "test",
		});
		try {
			const response = await fetch(`${handle.url}${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: forbidden.id,
					modelId: forbidden.id,
					messages: [{ role: "user", content: "hi" }],
					input: "hi",
					max_tokens: 16,
					context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
					stream: false,
				}),
			});
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(await response.text()).toContain("requires an explicit base URL");
			expect(credentialLookups).toBe(0);
			expect(upstreamCalls).toBe(0);
		} finally {
			await handle.close();
			storage.close();
		}
	},
);

test.each([false, true])(
	"configured keyless gateway resolution preserves account restrictions: %s",
	async restricted => {
		const storage = await AuthStorage.create(":memory:");
		const model = buildModel({
			...createMockModel({ id: "company-model" }),
			provider: "company",
			api: "openai-completions",
			baseUrl: "https://inference.company.example/v1",
		});
		let fallbackCalls = 0;
		if (restricted) storage.sessions.restrict("company", "gateway-request", []);
		try {
			const result = await resolveGatewayApiKey(
				{
					storage,
					getApiKeyWithCredential: async (provider, sessionId, options) => {
						fallbackCalls++;
						expect(provider).toBe("company");
						expect(sessionId).toBe("gateway-request");
						expect(options?.modelId).toBe("company-model");
						return { apiKey: "N/A" };
					},
				},
				model,
				"gateway-request",
				new AbortController().signal,
				"test",
			);
			if (restricted) {
				expect(result).toMatchObject({ status: 401, type: "authentication_error" });
				expect(fallbackCalls).toBe(0);
			} else {
				expect(result).toEqual({ apiKey: "N/A" });
				expect(fallbackCalls).toBe(1);
			}
		} finally {
			storage.close();
		}
	},
);

test.each([
	{
		error: new MissingApiKeyError("company", "Scoped account pool unavailable"),
		status: 401,
		type: "authentication_error",
	},
	{
		error: new OAuthRefreshUnavailableError("company", new Error("Upstream refresh service unavailable")),
		status: 502,
		type: "upstream_error",
	},
	{
		error: new Error("Upstream service has no API key configured"),
		status: 502,
		type: "upstream_error",
	},
])("gateway distinguishes missing client credentials from service failures: %s", ({ error, status, type }) => {
	expect(classifyGatewayError(error)).toEqual({ status, type, message: error.message });
});
