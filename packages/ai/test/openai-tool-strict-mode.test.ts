import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	OpenAICompat,
	ProviderSessionState,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { copilotCompletionsModel } from "./helpers";

const retryModel = buildModel({
	...copilotCompletionsModel("strict-retry"),
	compat: { supportsStrictMode: true },
});

const testTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({
		text: "string",
	}),
};

const looseYieldTool: Tool = {
	name: "yield",
	description: "Submit result",
	strict: false,
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: {
			result: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						properties: {
							data: {
								type: "object",
								additionalProperties: true,
							},
						},
						required: ["data"],
					},
				],
			},
		},
		required: ["result"],
	},
};

const testContext: Context = {
	messages: [
		{
			role: "user",
			content: "say hi",
			timestamp: Date.now(),
		},
	],
	tools: [testTool],
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getYieldDataSchema(parameters: unknown): Record<string, unknown> {
	const resultSchema = toRecord(toRecord(parameters).properties).result;
	const variants = toRecord(resultSchema).anyOf;
	if (!Array.isArray(variants)) return {};
	for (const variant of variants) {
		const dataSchema = toRecord(toRecord(variant).properties).data;
		if (dataSchema !== undefined) return toRecord(dataSchema);
	}
	return {};
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function captureCompletionsPayload(
	model: Model<"openai-completions">,
	context: Context = testContext,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function captureResponsesPayload(model: Model<"openai-responses">, context: Context = testContext): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("OpenAI tool strict mode", () => {
	it("sends strict=true for openai-completions tool schemas", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
		};

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBe(true);
	});

	it("omits strict for openai-completions when compatibility disables strict mode", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { supportsStrictMode: false } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBeUndefined();
	});

	it("preserves explicit strict:false on the wire for openai-completions", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
		};
		const payload = (await captureCompletionsPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ function?: { strict?: boolean; parameters?: Record<string, unknown> } }>;
		};
		const fn = payload.tools?.[0]?.function;

		// #4336: `strict: false` from the tool author is semantically distinct from
		// omitted `strict` on some backends and MUST survive to the wire.
		expect(fn?.strict).toBe(false);
		expect(getYieldDataSchema(fn?.parameters).additionalProperties).toBe(true);
	});

	it("omits explicit strict:false for openai-completions when compat disables the strict field", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { supportsStrictMode: false } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);

		const payload = (await captureCompletionsPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		// `supportsStrictMode: false` providers reject the `strict` key entirely,
		// so the explicit `false` MUST still be suppressed.
		expect(payload.tools?.[0]?.function?.strict).toBeUndefined();
	});

	it("sends strict=true for openai-completions tool schemas on GitHub Copilot", async () => {
		const model = getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">;

		const payload = (await captureCompletionsPayload(model)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools?.[0]?.function?.strict).toBe(true);
	});

	it("omits stream_options usage requests when the capability is disabled", async () => {
		const model = buildModel({
			...copilotCompletionsModel("without-stream-usage"),
			compat: { supportsUsageInStreaming: false },
		});

		const payload = (await captureCompletionsPayload(model)) as {
			stream_options?: { include_usage?: boolean };
		};
		expect(payload.stream_options).toBeUndefined();
	});

	it("uses uniformly non-strict tool schemas when provider requires all-or-none strictness", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);
		const context: Context = {
			...testContext,
			tools: [
				testTool,
				{
					name: "dynamic_map",
					description: "Dynamic object map",
					parameters: type({
						"values?": { "[string]": "string" },
					}),
				},
			],
		};

		const payload = (await captureCompletionsPayload(model, context)) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		expect(payload.tools).toHaveLength(2);
		expect(payload.tools?.every(tool => tool.function?.strict === undefined)).toBe(true);
	});

	it("keeps strict uniformly absent when all_strict collapses on an explicit strict:false tool", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);
		const payload = (await captureCompletionsPayload(model, {
			...testContext,
			tools: [testTool, looseYieldTool],
		})) as {
			tools?: Array<{ function?: { strict?: boolean } }>;
		};

		// #4336: preserving explicit `false` MUST NOT leak into the all_strict →
		// none collapse — providers that reject mixed strict values still get a
		// uniformly absent flag.
		expect(payload.tools).toHaveLength(2);
		expect(payload.tools?.every(tool => tool.function?.strict === undefined)).toBe(true);
	});

	it("surfaces captured JSON error bodies when the SDK reports no body", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
		};
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				new Response(
					JSON.stringify({
						message: "Tools with mixed values for 'strict' are not allowed.",
						type: "invalid_request_error",
						param: "tools",
						code: "wrong_api_format",
					}),
					{
						status: 422,
						headers: { "content-type": "application/json" },
					},
				),
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Tools with mixed values for 'strict' are not allowed.");
		expect(result.errorMessage).toContain("param=tools");
		expect(result.errorMessage).toContain("code=wrong_api_format");
	});

	it("retries with non-strict tool schemas after strict-mode request errors", async () => {
		const model: Model<"openai-completions"> = buildModel({
			...(getBundledModel("github-copilot", "gpt-4o") as Model<"openai-completions">),
			api: "openai-completions",
			compat: { toolStrictMode: "all_strict" } satisfies OpenAICompat,
		} as ModelSpec<"openai-completions">);
		const strictFlags: boolean[][] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				if (strictFlags.length === 1) {
					return new Response(
						JSON.stringify({
							message: "Strict tool schema validation failed.",
							type: "invalid_request_error",
							param: "tools",
							code: "wrong_api_format",
						}),
						{
							status: 422,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return createSseResponse([
					{
						id: "chatcmpl-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: "Hello" } }],
					},
					{
						id: "chatcmpl-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "Hello" });
		expect(strictFlags).toEqual([[true], [false]]);
	});

	it("retries non-strict when a gateway rejects structured outputs for the model", async () => {
		const model = retryModel;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		let attempt = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				attempt += 1;
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				if (attempt === 1) {
					return new Response(
						JSON.stringify({ error: { code: "BadRequest", message: "structured_outputs not supported" } }),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				return createSseResponse([
					{
						id: "chatcmpl-foundry-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: { content: "Recovered" } }],
					},
					{
						id: "chatcmpl-foundry-retry",
						object: "chat.completion.chunk",
						created: 0,
						model: model.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					},
					"[DONE]",
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			providerSessionState,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toContainEqual({ type: "text", text: "Recovered" });
		expect(strictFlags).toEqual([[true], [false]]);
	});

	it("does not disable strict tools for unrelated invalid requests", async () => {
		const model = retryModel;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const strictFlags: boolean[][] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const bodyText = typeof init?.body === "string" ? init.body : "";
				const payload = JSON.parse(bodyText) as {
					tools?: Array<{ function?: { strict?: boolean } }>;
				};
				strictFlags.push((payload.tools ?? []).map(tool => tool.function?.strict === true));
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "Some other validation error." },
						request_id: "req_test",
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "test-key",
			providerSessionState,
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Some other validation error");
		expect(strictFlags).toEqual([[true]]);
	});

	it("sends strict=true for openai-responses tool schemas on OpenAI", async () => {
		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model)) as {
			tools?: Array<{ strict?: boolean }>;
		};
		expect(payload.tools?.[0]?.strict).toBe(true);
	});

	it("preserves explicit strict:false on the wire for openai-responses", async () => {
		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ strict?: boolean; parameters?: Record<string, unknown> }>;
		};
		const tool = payload.tools?.[0];

		// #4336: authors who opt out via `tool.strict === false` see the flag land
		// on the wire so backends that distinguish it from omission behave correctly.
		expect(tool?.strict).toBe(false);
		expect(getYieldDataSchema(tool?.parameters).additionalProperties).toBe(true);
	});

	it("omits explicit strict:false for openai-responses when compat disables the strict field", async () => {
		const model = buildModel({
			...(getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">),
			api: "openai-responses",
			compat: { supportsStrictMode: false } satisfies OpenAICompat,
		} as ModelSpec<"openai-responses">);

		const payload = (await captureResponsesPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ strict?: boolean }>;
		};
		// Some Responses-compatible providers reject the `strict` key entirely;
		// disabling strict mode must keep even author-set `false` off the wire.
		expect(payload.tools?.[0]?.strict).toBeUndefined();
	});

	it("preserves explicit strict:false for buildModel-resolved openai-responses compat (#4527)", async () => {
		const model = buildModel({
			id: "deepseek-chat",
			name: "DeepSeek Chat via Responses",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
		} as ModelSpec<"openai-responses">);

		const payload = (await captureResponsesPayload(model, {
			...testContext,
			tools: [looseYieldTool],
		})) as {
			tools?: Array<{ strict?: boolean }>;
		};

		expect(payload.tools?.[0]?.strict).toBe(false);
	});

	it("sends strict=true for openai-responses tool schemas on GitHub Copilot", async () => {
		const model = getBundledModel("github-copilot", "gpt-5-mini") as Model<"openai-responses">;

		const payload = (await captureResponsesPayload(model)) as {
			tools?: Array<{ strict?: boolean }>;
		};
		expect(payload.tools?.[0]?.strict).toBe(true);
	});
});
