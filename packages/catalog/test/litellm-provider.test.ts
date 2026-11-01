import { afterEach, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	fetchLiteLLMRichModels,
	litellmModelManagerOptions,
	resolveLiteLLMApi,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const baseUrl = "https://models.company.example/proxy/v1";
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const row = (id: string) => ({
	model_name: id,
	model_info: {
		mode: "chat",
		supports_vision: false,
		supports_reasoning: false,
		max_input_tokens: 65536,
		max_output_tokens: 8192,
	},
	litellm_params: { model: `ollama/${id}` },
});

describe("private LiteLLM discovery", () => {
	test("fetches every management page and never contacts a public reference service", async () => {
		const requested: string[] = [];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			requested.push(url);
			expect(url.startsWith("https://models.company.example/proxy/")).toBe(true);
			if (url.endsWith("/model_group/info")) return new Response(null, { status: 404 });
			if (url.endsWith("/v2/model/info"))
				return json({ current_page: 1, total_pages: 2, total_count: 2, data: [row("qwen3.8-27b")] });
			if (url.endsWith("/v2/model/info?page=2"))
				return json({ current_page: 2, total_pages: 2, total_count: 2, data: [row("local-code")] });
			throw new Error(`Unexpected discovery request: ${url}`);
		};
		const options = litellmModelManagerOptions({ baseUrl, fetch });
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["local-code", "qwen3.8-27b"]);
		expect(models?.every(model => model.provider === "litellm" && model.baseUrl === baseUrl)).toBe(true);
		expect(requested).toHaveLength(3);
	});

	test("rejects incomplete pagination instead of publishing a partial authoritative roster", async () => {
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url.endsWith("/v2/model/info"))
				return json({ current_page: 1, total_pages: 2, total_count: 2, data: [row("first")] });
			return new Response(null, { status: 404 });
		};
		expect(
			await fetchLiteLLMRichModels({ api: "openai-completions", provider: "company", baseUrl, fetch }),
		).toBeNull();
	});

	test("merges complementary metadata without leaking a reference provider's wire policy", async () => {
		const reference: ModelSpec<"openai-completions"> = {
			id: "qwen3.8-27b",
			name: "Qwen",
			api: "openai-completions",
			provider: "other-company",
			baseUrl: "https://other.company.example/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 131072,
			maxTokens: 8192,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsNamedToolChoice: false, extraBody: { privateDeploymentFlag: true } },
		};
		const fetch: FetchImpl = async input => {
			const url = String(input);
			if (url.endsWith("/model_group/info"))
				return json({ data: [{ model_group: reference.id, providers: ["ollama"], supports_vision: true }] });
			if (url.endsWith("/v2/model/info")) return new Response(null, { status: 404 });
			if (url.endsWith("/model/info"))
				return json({
					data: [
						{
							...row(reference.id),
							model_info: { mode: "chat", supported_openai_params: ["tools", "reasoning_effort"] },
						},
					],
				});
			return new Response(null, { status: 404 });
		};
		const models = await fetchLiteLLMRichModels({
			api: "openai-completions",
			provider: "company",
			baseUrl,
			fetch,
			resolveApi: resolveLiteLLMApi,
			referenceResolver: () => reference,
		});
		expect(models?.[0]?.input).toEqual(["text", "image"]);
		expect(models?.[0]?.compat).toMatchObject({ supportsReasoningEffort: true, stripImageInput: false });
		expect(models?.[0]?.compat).not.toHaveProperty("extraBody");
		expect(models?.[0]?.compat).not.toHaveProperty("supportsNamedToolChoice");
	});

	test("routes local decision groups by explicit mode and drops unsupported task modes", async () => {
		const fetch: FetchImpl = async () =>
			json({
				data: [
					{ ...row("local-judge"), model_info: { ...row("local-judge").model_info, mode: "decisions" } },
					{ ...row("vectors"), model_info: { mode: "embedding" } },
				],
			});
		const models = await fetchLiteLLMRichModels({
			api: "openai-completions",
			provider: "litellm",
			baseUrl,
			fetch,
			resolveApi: resolveLiteLLMApi,
		});
		expect(models?.map(model => [model.id, model.api, model.kind])).toEqual([
			["local-judge", "openai-decisions", "judge"],
		]);
	});

	test("preserves declared deployment vision over model-family text-only defaults", async () => {
		const fetch: FetchImpl = async () =>
			json({ data: [{ ...row("deepseek-v4-pro"), model_info: { supports_vision: true, mode: "chat" } }] });
		const models = await fetchLiteLLMRichModels({ api: "openai-completions", provider: "litellm", baseUrl, fetch });
		expect(models?.[0]).toBeDefined();
		const built = buildModel(models![0]!);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.compat.stripImageInput).toBe(false);
	});
});

describe("private LiteLLM base URL and metadata merging", () => {
	const ORIGINAL_LITELLM_BASE_URL = Bun.env.LITELLM_BASE_URL;
	afterEach(() => {
		if (ORIGINAL_LITELLM_BASE_URL === undefined) delete Bun.env.LITELLM_BASE_URL;
		else Bun.env.LITELLM_BASE_URL = ORIGINAL_LITELLM_BASE_URL;
	});

	const primary = "http://primary:4000";
	const placeholder = {
		model_group: "all-team-models",
		model_name: null,
		providers: [],
		max_input_tokens: null,
		max_output_tokens: null,
		supports_vision: null,
		supports_reasoning: null,
		supports_function_calling: null,
		supported_openai_params: [],
		litellm_params: { model: null, model_name: null },
		model_info: {
			max_input_tokens: null,
			max_output_tokens: null,
			supports_vision: null,
			supports_reasoning: null,
			supports_function_calling: null,
			supported_openai_params: [],
		},
	};
	/** Serves `routes` by path; every other management endpoint is absent (404). */
	const routedFetch = (routes: Record<string, unknown>, calls: string[] = []): FetchImpl =>
		(async input => {
			const url = String(input);
			calls.push(url);
			const path = url.replace(primary, "");
			return path in routes ? json(routes[path]) : new Response("{}", { status: 404 });
		}) as FetchImpl;
	const discover = (fetch: FetchImpl) =>
		litellmModelManagerOptions({ apiKey: "sk-rich", baseUrl: `${primary}/v1`, fetch }).fetchDynamicModels?.();

	test("uses LITELLM_BASE_URL when no explicit baseUrl is configured", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm.example:4100/v1";
		const calls: string[] = [];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			calls.push(url);
			return url === "http://litellm.example:4100/v1/models"
				? json({ data: [{ id: "qwen3.8-27b" }] })
				: new Response("{}", { status: 404 });
		};
		const models = await litellmModelManagerOptions({ apiKey: "sk-litellm-test", fetch }).fetchDynamicModels?.();
		expect(calls.every(url => url.startsWith("http://litellm.example:4100/"))).toBe(true);
		expect(models?.[0]).toMatchObject({
			id: "qwen3.8-27b",
			provider: "litellm",
			baseUrl: "http://litellm.example:4100/v1",
		});
	});

	test("keeps explicit baseUrl higher precedence than LITELLM_BASE_URL", async () => {
		Bun.env.LITELLM_BASE_URL = "http://litellm-env.example:4100/v1";
		const calls: string[] = [];
		const fetch: FetchImpl = async input => {
			const url = String(input);
			calls.push(url);
			return url === "http://litellm-config.example:4200/v1/models"
				? json({ data: [{ id: "qwen3.8-27b" }] })
				: new Response("{}", { status: 404 });
		};
		const models = await litellmModelManagerOptions({
			apiKey: "sk-litellm-test",
			baseUrl: "http://litellm-config.example:4200/v1/",
			fetch,
		}).fetchDynamicModels?.();
		expect(calls.some(url => url.includes("litellm-env.example"))).toBe(false);
		expect(models?.[0]?.baseUrl).toBe("http://litellm-config.example:4200/v1");
	});

	test("ignores excluded modes on sentinel placeholders before /v1/models fallback", async () => {
		const calls: string[] = [];
		const models = await discover(
			routedFetch(
				{
					"/model_group/info": {
						data: [{ ...placeholder, model_info: { ...placeholder.model_info, mode: "embedding" } }],
					},
					"/v1/models": { data: [{ id: "fallback-chat", mode: "chat" }] },
				},
				calls,
			),
		);
		expect(calls).toContain(`${primary}/v1/models`);
		expect(models?.map(model => model.id)).toEqual(["fallback-chat"]);
	});

	test("filters the all-team-models placeholder from mixed model_group info", async () => {
		const calls: string[] = [];
		const models = await discover(
			routedFetch(
				{
					"/model_group/info": {
						data: [
							placeholder,
							{
								model_group: "example-real-model",
								model_name: "Example Real Model",
								providers: ["ollama"],
								mode: "chat",
								max_input_tokens: 96_000,
								max_output_tokens: 8_000,
								supports_function_calling: true,
								supports_vision: false,
							},
						],
					},
				},
				calls,
			),
		);
		expect(calls).not.toContain(`${primary}/v2/model/info`);
		expect(calls).not.toContain(`${primary}/v1/models`);
		expect(models?.map(model => model.id)).toEqual(["example-real-model"]);
		expect(models?.[0]).toMatchObject({
			name: "Example Real Model",
			contextWindow: 96_000,
			maxTokens: 8_000,
			supportsTools: true,
		});
	});

	test("continues rich discovery for cache pricing omitted by model group info", async () => {
		const calls: string[] = [];
		const models = await discover(
			routedFetch(
				{
					"/model_group/info": {
						data: [
							{
								model_group: "team-gpt",
								input_cost_per_token: 0.000_005_5,
								output_cost_per_token: 0.000_033,
								supports_vision: false,
							},
						],
					},
					"/v2/model/info": {
						data: [
							{
								model_name: "team-gpt",
								model_info: {
									cache_read_input_token_cost: 0.000_000_55,
									cache_creation_input_token_cost: 0.000_006_875,
								},
							},
						],
					},
				},
				calls,
			),
		);
		expect(calls).toContain(`${primary}/v2/model/info`);
		expect(models?.[0]?.cost).toEqual({ input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.875 });
	});

	test("ignores zero placeholder prices from later rich metadata", async () => {
		const models = await discover(
			routedFetch({
				"/model_group/info": {
					data: [
						{
							model_group: "placeholder-cache",
							input_cost_per_token: 0.000_005,
							output_cost_per_token: 0.000_03,
							cache_read_input_token_cost: 0.000_000_5,
							supports_vision: false,
						},
					],
				},
				"/v2/model/info": {
					data: [
						{
							model_name: "placeholder-cache",
							model_info: {
								input_cost_per_token: 0,
								output_cost_per_token: 0,
								cache_read_input_token_cost: 0,
								cache_creation_input_token_cost: 0,
							},
						},
					],
				},
			}),
		);
		expect(models?.[0]?.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
	});

	test("preserves cache prices reported before base prices", async () => {
		const models = await discover(
			routedFetch({
				"/model_group/info": {
					data: [
						{
							model_group: "cache-first",
							cache_read_input_token_cost: 0.000_000_5,
							cache_creation_input_token_cost: 0.000_006_25,
							supports_vision: false,
						},
					],
				},
				"/v2/model/info": {
					data: [
						{
							model_name: "cache-first",
							model_info: {
								input_cost_per_token: 0.000_005,
								output_cost_per_token: 0.000_03,
								supports_vision: false,
							},
						},
					],
				},
			}),
		);
		expect(models?.[0]?.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	});

	test("merges mixed-backend routing evidence within one rich endpoint", async () => {
		const models = await discover(
			routedFetch({
				"/model_group/info": {
					data: [
						{ model_group: "openai-last", providers: ["ollama"], supports_vision: false },
						{ model_group: "openai-last", providers: ["openai"], supports_vision: false },
						{ model_group: "openai-first", providers: ["openai"], supports_vision: false },
						{ model_group: "openai-first", providers: ["ollama"], supports_vision: false },
					],
				},
			}),
		);
		expect(models?.find(model => model.id === "openai-last")?.api).toBe("openai-completions");
		expect(models?.find(model => model.id === "openai-first")?.api).toBe("openai-completions");
	});
});
