import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	resetRequestCompressionForTesting,
	wrapFetchForRequestCompression,
} from "@oh-my-pi/pi-ai/utils/request-compression";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const COPILOT_URL = "https://api.individual.githubcopilot.com/chat/completions";
const OTHER_COPILOT_URL = "https://api.business.githubcopilot.com/v1/messages";
const LARGE_BODY = JSON.stringify({ messages: [{ role: "user", content: "hello world ".repeat(500) }] });
const copilot = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});
const anthropic = buildModel({ ...copilot, id: "claude-sonnet-4.5", api: "anthropic-messages" });

interface Captured {
	body: RequestInit["body"];
	headers: Headers;
}
function captureFetch(responses: Response[]): { calls: Captured[]; fetch: FetchImpl } {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		calls.push({ body: init?.body, headers: new Headers(init?.headers) });
		return responses.shift() ?? Response.json({});
	};
	return { calls, fetch };
}
const post = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: LARGE_BODY });
const rejection = () =>
	new Response('{"error":{"message":"Failed to read request body.","code":"invalid_request_body"}}', { status: 400 });
const encodings = (calls: Captured[]) => calls.map(call => call.headers.get("content-encoding"));
afterEach(() => resetRequestCompressionForTesting());

describe("wrapFetchForRequestCompression", () => {
	it.each([
		{ model: copilot, url: COPILOT_URL },
		{ model: anthropic, url: OTHER_COPILOT_URL },
	])("compresses the retained Copilot wire without disturbing other headers: %p", async ({ model, url }) => {
		const { calls, fetch } = captureFetch([]);
		await wrapFetchForRequestCompression(fetch, model)(url, post());
		expect(calls[0].headers.get("content-type")).toBe("application/json");
		expect(encodings(calls)).toEqual(["zstd"]);
		expect(new TextDecoder().decode(Bun.zstdDecompressSync(calls[0].body as Uint8Array<ArrayBuffer>))).toBe(
			LARGE_BODY,
		);
	});

	it("leaves proxies, unverified Copilot hosts, and tiny bodies uncompressed", async () => {
		const { calls, fetch } = captureFetch([]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		await wrapped("https://gateway.example/v1/messages", post());
		await wrapped("https://copilot-api.acme.ghe.com/chat/completions", post());
		await wrapped(COPILOT_URL, { method: "POST", body: '{"model":"x"}' });
		expect(calls.map(call => call.body)).toEqual([LARGE_BODY, LARGE_BODY, '{"model":"x"}']);
		expect(encodings(calls)).toEqual([null, null, null]);
	});

	it("falls back through accepted encodings without disabling another host", async () => {
		const { calls, fetch } = captureFetch([rejection(), Response.json({}), rejection()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		await wrapped(COPILOT_URL, post());
		await wrapped(COPILOT_URL, post());
		await wrapped(COPILOT_URL, post());
		await wrapped(OTHER_COPILOT_URL, post());
		expect(encodings(calls)).toEqual(["zstd", null, "gzip", null, null, "zstd"]);
		expect(new TextDecoder().decode(Bun.gunzipSync(calls[2].body as Uint8Array<ArrayBuffer>))).toBe(LARGE_BODY);
		expect(calls[1].body).toBe(LARGE_BODY);
	});

	it.each([403, 415])("resends plain after a proxy's HTML %d and learns only the refused encoding", async status => {
		const { calls, fetch } = captureFetch([new Response("<html>Compressed uploads blocked.</html>", { status })]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		const response = await wrapped(COPILOT_URL, post());
		await wrapped(COPILOT_URL, post());
		expect(response.status).toBe(200);
		expect(encodings(calls)).toEqual(["zstd", null, "gzip"]);
		expect(calls[1].body).toBe(LARGE_BODY);
	});

	it("stops resending when the proxy refuses the plain body with the same status", async () => {
		const blocked = () => new Response("<html>Access denied.</html>", { status: 403 });
		const { calls, fetch } = captureFetch([blocked(), blocked(), blocked()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		const first = await wrapped(COPILOT_URL, post());
		const second = await wrapped(COPILOT_URL, post());
		expect([first.status, second.status]).toEqual([403, 403]);
		expect(encodings(calls)).toEqual(["zstd", null, "zstd"]);
	});

	it("keeps resending if the plain retry reaches the provider's own JSON error", async () => {
		const blocked = () => new Response("<html>Compressed uploads blocked.</html>", { status: 403 });
		const denied = Response.json({ error: { message: "Model not accessible." } }, { status: 403 });
		const { calls, fetch } = captureFetch([blocked(), denied, blocked()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		const first = await wrapped(COPILOT_URL, post());
		const second = await wrapped(COPILOT_URL, post());
		expect([first.status, second.status]).toEqual([403, 200]);
		expect(encodings(calls)).toEqual(["zstd", null, "zstd", null]);
	});

	it("keeps compressing when the plain retry also fails", async () => {
		const { calls, fetch } = captureFetch([rejection(), rejection()]);
		const wrapped = wrapFetchForRequestCompression(fetch, copilot);
		expect((await wrapped(COPILOT_URL, post())).status).toBe(400);
		await wrapped(COPILOT_URL, post());
		expect(encodings(calls)).toEqual(["zstd", null, "zstd"]);
	});

	it.each([400, 403])("surfaces an unrelated provider JSON %d once and keeps its body readable", async status => {
		const error = '{"error":{"message":"Model not accessible."}}';
		const { calls, fetch } = captureFetch([new Response(error, { status })]);
		const response = await wrapFetchForRequestCompression(fetch, copilot)(COPILOT_URL, post());
		expect(encodings(calls)).toEqual(["zstd"]);
		expect(await response.text()).toBe(error);
	});
});
