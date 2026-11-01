import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { available, embed, embedQuery, resetEmbeddingStateForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { extractFactCategories } from "@oh-my-pi/pi-mnemopi/core/extraction";
import { callRemoteLlm, complete } from "@oh-my-pi/pi-mnemopi/core/local-llm";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const saved = new Map<string, string | undefined>();
function env(name: string, value: string): void {
	if (!saved.has(name)) saved.set(name, process.env[name]);
	process.env[name] = value;
}

afterEach(() => {
	vi.restoreAllMocks();
	resetEmbeddingStateForTests();
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
});

describe("explicit private memory HTTP transports", () => {
	it("embeds at the configured endpoint without borrowing public-provider credentials or headers", async () => {
		env("OPENAI_API_KEY", "must-not-send-openai");
		env("OPENROUTER_API_KEY", "must-not-send-openrouter");
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({
				data: [
					{ index: 1, embedding: [0, 1] },
					{ index: 0, embedding: [1, 0] },
				],
			});
		}) as typeof fetch);
		const result = await withMnemopiRuntimeOptions(
			{ embeddings: { apiUrl: "http://embeddings.internal/v1/", apiKey: "", model: "company-embed" } },
			async () => {
				expect(await available()).toBe(true);
				return embed(["first", "second"]);
			},
		);
		expect(result?.map(row => [...row])).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://embeddings.internal/v1/embeddings");
		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.has("Authorization")).toBe(false);
		expect(headers.has("HTTP-Referer")).toBe(false);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			model: "company-embed",
			input: ["first", "second"],
		});
	});

	it("keeps query caches separate when the same model uses different company endpoints", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async input =>
			Response.json({ data: [{ embedding: [String(input).includes("one.internal") ? 1 : 2] }] })) as typeof fetch);
		const one = await withMnemopiRuntimeOptions(
			{ embeddings: { apiUrl: "http://one.internal/v1", model: "shared-model" } },
			() => embedQuery("same query"),
		);
		const two = await withMnemopiRuntimeOptions(
			{ embeddings: { apiUrl: "http://two.internal/v1", model: "shared-model" } },
			() => embedQuery("same query"),
		);
		expect(one?.[0]).toBe(1);
		expect(two?.[0]).toBe(2);
	});

	it("does not infer an embedding endpoint from a public model name, key or public base URL", async () => {
		env("MNEMOPI_EMBEDDING_API_URL", "");
		env("OPENROUTER_BASE_URL", "https://public.invalid/v1");
		env("OPENAI_API_KEY", "must-not-send");
		const request = vi.spyOn(globalThis, "fetch");
		const result = await withMnemopiRuntimeOptions({ embeddings: { model: "text-embedding-3-small" } }, () =>
			embed(["private text"]),
		);
		expect(result).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	it("uses explicit LLM model, endpoint and dedicated auth, with no public-model fallback", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const request: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			return Response.json({ choices: [{ message: { content: "Company summary." } }] });
		};
		const text = await withMnemopiRuntimeOptions(
			{ llm: { baseUrl: "http://llm.internal/v1/", model: "company-memory", apiKey: "dedicated-token" } },
			() => callRemoteLlm("private memory", 0, { fetch: request, maxTokens: 123 }),
		);
		expect(text).toBe("Company summary.");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://llm.internal/v1/chat/completions");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer dedicated-token");
		expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
			model: "company-memory",
			max_tokens: 123,
			temperature: 0,
		});
	});

	it("uses the independent HTTP completion for fact extraction", async () => {
		const respond = Object.assign(
			async () =>
				Response.json({
					choices: [
						{
							message: {
								content:
									'{"facts":["The deployment uses the private cluster"],"instructions":[],"preferences":[],"timelines":[],"kg":[]}',
							},
						},
					],
				}),
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(respond);
		const facts = await withMnemopiRuntimeOptions(
			{ llm: { baseUrl: "http://llm.internal/v1", model: "company-memory" } },
			() => extractFactCategories("The deployment uses the private cluster"),
		);
		expect(facts.facts).toEqual(["The deployment uses the private cluster"]);
	});

	it("keeps callback precedence and llm:false authoritative over endpoint environment settings", async () => {
		env("MNEMOPI_LLM_BASE_URL", "http://llm.internal/v1");
		env("MNEMOPI_LLM_MODEL", "company-memory");
		const request = vi.spyOn(globalThis, "fetch");
		const memory = new Mnemopi({ dbPath: ":memory:", noEmbeddings: true, llm: false });
		try {
			expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("do not send"))).toBeNull();
			expect(
				await withMnemopiRuntimeOptions({ llm: { complete: () => "callback" } }, () => complete("callback prompt")),
			).toBe("callback");
			expect(request).not.toHaveBeenCalled();
		} finally {
			memory.close();
		}
	});

	it("does not change endpoints or models when a private server rejects the request", async () => {
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			requests.push(String(input));
			return new Response("invalid company model", { status: 400 });
		}) as typeof fetch);
		expect(
			await withMnemopiRuntimeOptions({ llm: { baseUrl: "http://llm.internal/v1", model: "company-only" } }, () =>
				complete("private prompt"),
			),
		).toBeNull();
		expect(requests).toEqual(["http://llm.internal/v1/chat/completions"]);
	});

	it("rejects malformed and non-HTTP endpoints before resolving credentials", async () => {
		const key = vi.fn(async () => "secret");
		const request = vi.spyOn(globalThis, "fetch");
		for (const endpoint of ["not a URL", "file:///private"]) {
			expect(
				await withMnemopiRuntimeOptions(
					{ embeddings: { apiUrl: endpoint, apiKey: key, model: "company-embed" } },
					() => embed(["private text"]),
				),
			).toBeNull();
			expect(
				await withMnemopiRuntimeOptions({ llm: { baseUrl: endpoint, apiKey: key, model: "company-memory" } }, () =>
					callRemoteLlm("private text"),
				),
			).toBeNull();
		}
		expect(key).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("does not send a key or choose a model when the explicit LLM endpoint or model is absent", async () => {
		env("MNEMOPI_LLM_BASE_URL", "");
		env("MNEMOPI_LLM_MODEL", "");
		const request = vi.spyOn(globalThis, "fetch");
		expect(await withMnemopiRuntimeOptions({ llm: { apiKey: "secret" } }, () => callRemoteLlm("private"))).toBeNull();
		expect(
			await withMnemopiRuntimeOptions({ llm: { baseUrl: "http://llm.internal/v1", apiKey: "secret" } }, () =>
				callRemoteLlm("private"),
			),
		).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});
});
