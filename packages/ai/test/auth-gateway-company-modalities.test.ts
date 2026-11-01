import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { handleImageEdits, handleImageGenerations } from "../src/auth-gateway/routes/images";
import { handleSpeech } from "../src/auth-gateway/routes/speech";
import { handleSystemOne } from "../src/auth-gateway/routes/systemone";
import type { AuthGatewayRouteOptions } from "../src/auth-gateway/dispatch";
import { AuthStorage } from "../src/auth-storage";

const imageData = Buffer.from("company image").toString("base64");
let storage: AuthStorage | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	storage?.close();
	storage = undefined;
});

function model(api: string): Model {
	return buildModel({
		id: "company-model",
		name: "Company model",
		provider: "company",
		api,
		baseUrl: "https://inference.company.example/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

function request(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function options(
	selected: Model,
	respond: (url: string, init?: RequestInit) => Response,
): Promise<AuthGatewayRouteOptions> {
	storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime("company", "company-key");
	return {
		storage,
		resolveModel: id => (id === "company-model" ? selected : undefined),
		fetch: async (url, init) => respond(String(url), init),
	};
}

describe("company modality gateway routes", () => {
	it("generates image bytes through the configured endpoint", async () => {
		const selected = model("openai-images");
		let upstream: unknown;
		const opts = await options(selected, (url, init) => {
			expect(url).toBe("https://inference.company.example/v1/images/generations");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer company-key");
			upstream = JSON.parse(String(init?.body));
			return Response.json({ data: [{ b64_json: imageData }] });
		});
		const response = await handleImageGenerations(
			opts,
			request("/v1/images/generations", { model: selected.id, prompt: "company diagram" }),
			"test",
		);
		expect(response.status).toBe(200);
		expect(upstream).toMatchObject({ model: selected.id, prompt: "company diagram" });
		expect(await response.json()).toMatchObject({ data: [{ b64_json: imageData }] });
	});

	it("validates edit image bytes before touching credentials", async () => {
		const opts = await options(model("openai-images"), () => {
			throw new Error("unexpected fetch");
		});
		const credentials = vi.spyOn(opts.storage.keys, "getWithCredential");
		const response = await handleImageEdits(
			opts,
			request("/v1/images/edits", {
				model: "company-model",
				prompt: "edit",
				image: "data:image/png;base64,not base64!",
			}),
			"test",
		);
		expect(response.status).toBe(400);
		expect(credentials).not.toHaveBeenCalled();
	});

	it("returns raw speech audio while preserving custom endpoint headers", async () => {
		const selected = model("openai-speech");
		selected.resolveHeaders = async () => ({ "x-company-routing": "speech" });
		const opts = await options(selected, (url, init) => {
			expect(url).toBe("https://inference.company.example/v1/audio/speech");
			expect(new Headers(init?.headers).get("x-company-routing")).toBe("speech");
			return new Response(new Uint8Array([1, 2, 3]));
		});
		const response = await handleSpeech(
			opts,
			request("/v1/audio/speech", { model: selected.id, input: "hello", response_format: "wav" }),
			"test",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/wav");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("serves System One using the configured model and resolved company headers", async () => {
		const selected = model("typesafe");
		selected.baseUrl = "https://judge.company.example";
		selected.resolveHeaders = async () => ({ "x-company-routing": "judge" });
		const opts = await options(selected, (url, init) => {
			expect(url).toBe("https://judge.company.example/v1/systemone");
			expect(new Headers(init?.headers).get("x-company-routing")).toBe("judge");
			return Response.json({ answers: { urgent: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 3 } });
		});
		const response = await handleSystemOne(
			opts,
			request("/v1/systemone", {
				model: selected.id,
				state: "company",
				questions: { urgent: { type: "noul", instructions: "Urgent?" } },
			}),
			"test",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ answers: { urgent: { type: "noul", noul: 0.9 } } });
	});

	it("requires the configured endpoint before credential lookup", async () => {
		const selected = { ...model("openai-speech"), baseUrl: "" };
		const opts = await options(selected, () => {
			throw new Error("unexpected fetch");
		});
		const credentials = vi.spyOn(opts.storage.keys, "getWithCredential");
		const response = await handleSpeech(
			opts,
			request("/v1/audio/speech", { model: selected.id, input: "hello" }),
			"test",
		);
		expect(response.status).toBe(400);
		expect(credentials).not.toHaveBeenCalled();
	});
});
