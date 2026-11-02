import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-striped-pi/pi-catalog/types";
import { type ApiKey, NO_AUTH_SENTINEL } from "../src/auth-retry";
import { embed } from "../src/embeddings";
import { generateImage } from "../src/images";
import { createNativeJudge, NativeJudge } from "../src/judgment/native";
import { rerank } from "../src/rerank";
import { synthesizeSpeech } from "../src/speech";
import { transcribeAudio } from "../src/transcription";

function model(api: Api, baseUrl = "https://inference.company.example/v1"): Model {
	return buildModel({
		id: "company-model",
		name: "Company model",
		provider: "company",
		api,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

const image = { data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" };
const judgment = { state: "company state", questions: { ok: { type: "noul", instructions: "Is it valid?" } } } as const;

type TransportOptions = { apiKey: ApiKey; fetch: FetchImpl };

const calls = [
	{
		api: "openai-embeddings",
		invoke: (m: Model, options: TransportOptions) => embed(m, { input: "hello", encodingFormat: "float" }, options),
		response: { data: [{ index: 0, embedding: [0.25, 0.75] }], model: "company-model" },
		path: "/embeddings",
	},
	{
		api: "openrouter-rerank",
		invoke: (m: Model, options: TransportOptions) => rerank(m, { query: "hello", documents: ["world"] }, options),
		response: { model: "company-model", results: [{ index: 0, relevance_score: 0.9 }] },
		path: "/rerank",
	},
	{
		api: "openai-images",
		invoke: (m: Model, options: TransportOptions) => generateImage(m, { prompt: "a tree" }, options),
		response: { data: [{ b64_json: image.data }] },
		path: "/images/generations",
	},
	{
		api: "openai-speech",
		invoke: (m: Model, options: TransportOptions) => synthesizeSpeech(m, { text: "hello", format: "wav" }, options),
		response: null,
		path: "/audio/speech",
	},
	{
		api: "openai-transcriptions",
		invoke: (m: Model, options: TransportOptions) =>
			transcribeAudio(m, { audio: new Uint8Array([1, 2]), mimeType: "audio/wav", responseFormat: "json" }, options),
		response: { text: "hello" },
		path: "/audio/transcriptions",
	},
];

describe("configured company modality transports", () => {
	for (const entry of calls) {
		it(`${entry.api} uses only the configured endpoint and preserves keyless/custom headers`, async () => {
			const selected = model(entry.api);
			selected.headers = { "x-company-static": "static" };
			selected.resolveHeaders = async () => ({ "x-company-dynamic": "dynamic" });
			let request: { url: string; headers: Headers } | undefined;
			await entry.invoke(selected, {
				apiKey: NO_AUTH_SENTINEL,
				fetch: async (url, init) => {
					request = { url: String(url), headers: new Headers(init?.headers) };
					return entry.response === null ? new Response(new Uint8Array([1, 2])) : Response.json(entry.response);
				},
			});
			expect(request?.url).toBe(`https://inference.company.example/v1${entry.path}`);
			expect(request?.headers.has("authorization")).toBe(false);
			expect(request?.headers.get("x-company-static")).toBe("static");
			expect(request?.headers.get("x-company-dynamic")).toBe("dynamic");
		});

		it(`${entry.api} refuses an absent endpoint before resolving credentials or headers`, async () => {
			const selected = { ...model(entry.api), baseUrl: "" };
			let sideEffects = 0;
			selected.resolveHeaders = async () => {
				sideEffects++;
				return {};
			};
			const apiKey = async () => {
				sideEffects++;
				return "secret";
			};
			await expect(
				entry.invoke(selected, {
					apiKey,
					fetch: async () => {
						sideEffects++;
						throw new Error("unexpected fetch");
					},
				}),
			).rejects.toThrow("explicit base URL");
			expect(sideEffects).toBe(0);
		});
	}

	it("image edits send multipart bytes and preserve the generic 404 generation fallback", async () => {
		const requests: Array<{ url: string; body: RequestInit["body"] }> = [];
		const result = await generateImage(
			model("openai-images"),
			{ prompt: "edit", inputImages: [image] },
			{
				apiKey: "company-key",
				fetch: async (url, init) => {
					requests.push({ url: String(url), body: init?.body });
					return requests.length === 1
						? Response.json({ error: { message: "no edits route" } }, { status: 404 })
						: Response.json({ data: [{ b64_json: image.data }] });
				},
			},
		);
		const multipart = requests[0]?.body;
		expect(multipart).toBeInstanceOf(FormData);
		if (!(multipart instanceof FormData)) throw new Error("Expected multipart edit request");
		expect(multipart.get("image")).toBeInstanceOf(File);
		expect(requests[1]?.url).toEndWith("/images/generations");
		expect(JSON.parse(String(requests[1]?.body)).input_references).toEqual([
			{ type: "image_url", url: `data:image/png;base64,${image.data}` },
		]);
		expect(result.images).toEqual([image]);
	});

	it("native judgments require an explicit endpoint even when credentials are configured", () => {
		expect(() => new NativeJudge({ apiKey: "secret", baseUrl: "", model: "company-model" })).toThrow(
			"explicit base URL",
		);
	});

	it("self-hosted System One chunks questions and accounts for usage", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const judge = new NativeJudge({
			apiKey: NO_AUTH_SENTINEL,
			baseUrl: "http://localhost:8000",
			model: "openjev",
			maxQuestions: 1,
			fetch: async (url, init) => {
				expect(String(url)).toBe("http://localhost:8000/v1/systemone");
				expect(new Headers(init?.headers).has("authorization")).toBe(false);
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				return Response.json({
					answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.8 }])),
					usage: { input_tokens: 2, output_tokens: 1 },
				});
			},
		});
		const result = await judge.judge({
			state: "company",
			questions: { a: judgment.questions.ok, b: judgment.questions.ok },
		});
		expect(bodies).toHaveLength(2);
		expect(Object.keys(result.answers)).toEqual(["a", "b"]);
		expect(result.usage.totalTokens).toBe(6);
	});

	it("LM Studio-compatible Decisions translates questions without a hosted provider", async () => {
		let body: unknown;
		const judge = createNativeJudge(model("openai-decisions"), {
			apiKey: "company-key",
			fetch: async (url, init) => {
				expect(String(url)).toBe("https://inference.company.example/v1/decisions");
				body = JSON.parse(String(init?.body));
				return Response.json({
					answers: [{ name: "ok", type: "predicate", probability: 0.9 }],
					usage: { input_tokens: 3 },
				});
			},
		});
		const result = await judge.judge(judgment);
		expect(body).toMatchObject({
			model: "company-model",
			input: "company state",
			questions: [{ name: "ok", type: "predicate" }],
		});
		expect(result.answers.ok).toEqual({ type: "noul", noul: 0.9 });
	});
});
