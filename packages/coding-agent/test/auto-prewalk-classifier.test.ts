import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AUTO_PREWALK_TIMEOUT_MS,
	type AutoPrewalkInput,
	classifyAutoPrewalk,
	type PrewalkRoute,
} from "@oh-my-pi/pi-coding-agent/auto-prewalk/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge, hasNativeJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { MAX_TINY_MESSAGE_CHARS } from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ONLINE = getBundledModel("github-copilot", "claude-sonnet-4.6");
if (!ONLINE) throw new Error("Expected bundled Copilot judge model");

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
if (!LOCAL) throw new Error("Expected bundled local judge model");

const NATIVE = buildModel({
	id: "openjev-company",
	name: "Company judge",
	provider: "company",
	api: "typesafe",
	baseUrl: "https://judge.company.example",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 0,
});

const REQUEST = "trace the sync engine, then fix the stale cursor";

interface JudgeRequest {
	state: Record<string, string>;
	questions: Record<string, { criteria: Record<string, string> }>;
}

function judgeDeps(model: Model<Api> = NATIVE) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime(model.provider, "company-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/auto-prewalk-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	return { settings: Settings.isolated({ modelRoles: { judge: `${model.provider}/${model.id}` } }), registry };
}

/** Typed judge answer; the winning route must match the distribution. */
function answer(prewalk: number, primary: number, direct: number) {
	const probabilities: Record<PrewalkRoute, number> = { prewalk, primary, direct };
	const choice: PrewalkRoute =
		prewalk >= primary && prewalk >= direct ? "prewalk" : primary >= direct ? "primary" : "direct";
	return { type: "choice", choice, probabilities, confidence: probabilities[choice] };
}

/** Exercise decision validation and context through the configured native wire. */
function serveJudge(route: unknown): JudgeRequest[] {
	const requests: JudgeRequest[] = [];
	const respond = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push(JSON.parse(String(init?.body)) as JudgeRequest);
			return Response.json({ answers: { route }, usage: { input_tokens: 3, output_tokens: 1 } });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(respond);
	return requests;
}

const userTurn = (text: string, extra: Partial<Extract<AgentMessage, { role: "user" }>> = {}): AgentMessage => ({
	role: "user",
	content: text,
	timestamp: 1,
	...extra,
});

const classify = (input: Partial<AutoPrewalkInput> = {}) =>
	classifyAutoPrewalk({ request: REQUEST, history: [], ...input }, judgeDeps());

afterEach(() => {
	vi.restoreAllMocks();
});

describe("classifyAutoPrewalk decision", () => {
	it.each([
		["a confident prewalk", answer(0.84, 0.1, 0.06), "prewalk", true],
		["a prewalk exactly at the threshold", answer(0.7, 0.2, 0.1), "prewalk", true],
		["a prewalk that wins below the threshold", answer(0.69, 0.21, 0.1), "prewalk", false],
		["a primary win", answer(0.18, 0.62, 0.2), "primary", false],
		["a direct win", answer(0.06, 0.1, 0.84), "direct", false],
	] as const)("arms only for confident prewalk: %s", async (_label, reply, route, arm) => {
		serveJudge(reply);

		expect(await classify()).toEqual({
			route,
			probabilities: reply.probabilities,
			confidence: reply.confidence,
			arm,
		});
	});

	it("asks one typed route question over all three outcomes", async () => {
		const requests = serveJudge(answer(0.84, 0.1, 0.06));

		await classify();

		expect(requests).toHaveLength(1);
		expect(Object.keys(requests[0]!.questions)).toEqual(["route"]);
		expect(Object.keys(requests[0]!.questions.route!.criteria).sort()).toEqual(["direct", "prewalk", "primary"]);
	});

	it("skips low-signal input without calling a configured judge", async () => {
		const requests = serveJudge(answer(0.84, 0.1, 0.06));

		expect(await classify({ request: "thanks" })).toBeUndefined();
		expect(requests).toHaveLength(0);
	});

	it.each([LOCAL, ONLINE])("never substitutes prompted $provider judgments for native probabilities", async model => {
		const local = vi.spyOn(tinyModelClient, "complete").mockRejectedValue(new Error("Unexpected local judgment"));
		const chat = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("Unexpected chat judgment"));
		expect(await classifyAutoPrewalk({ request: REQUEST, history: [] }, judgeDeps(model))).toBeUndefined();
		expect(local).not.toHaveBeenCalled();
		expect(chat).not.toHaveBeenCalled();
	});

	it("attributes native classification usage without a prompted chat request", async () => {
		serveJudge(answer(0.84, 0.1, 0.06));
		const onUsage = vi.fn();
		const decision = await classifyAutoPrewalk({ request: REQUEST, history: [] }, { ...judgeDeps(), onUsage });
		expect(decision?.arm).toBe(true);
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				purpose: "auto-prewalk",
				role: "judge",
				provider: "company",
				model: "openjev-company",
			}),
		);
	});

	it("rejects an answer without probabilities instead of guessing an arm", async () => {
		serveJudge({ type: "choice", choice: "prewalk" });

		await expect(classify()).rejects.toThrow("malformed");
	});

	it.each([
		["probabilities that do not sum to one", { ...answer(0.8, 0.9, 0.1), choice: "primary", confidence: 0.9 }],
		["a selected route that is not the most probable", { ...answer(0.8, 0.1, 0.1), choice: "primary" }],
		["a negative confidence", { ...answer(0.8, 0.1, 0.1), confidence: -0.8 }],
		["a non-finite confidence", { ...answer(0.8, 0.1, 0.1), confidence: Number.POSITIVE_INFINITY }],
		[
			"a probability outside 0-1",
			{ ...answer(0.8, 0.1, 0.1), probabilities: { prewalk: 1.2, primary: -0.1, direct: -0.1 } },
		],
	])("rejects %s instead of normalizing it into a decision", async (_label, reply) => {
		serveJudge(reply);

		await expect(classify()).rejects.toThrow("auto-prewalk");
	});

	it("refuses a stale prompted execution chain after the fresh gate discovers a native judge", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		const { registry } = judgeDeps();
		const settings = Settings.isolated({
			modelRoles: { judge: "company/openjev-company" },
			"retry.fallbackChains": { judge: [`${LOCAL.provider}/${LOCAL.id}`] },
		});
		const deps = { registry, settings };
		const available = vi.spyOn(registry, "getAvailable").mockReturnValue([LOCAL]);
		expect(new ChainJudge({ ...deps, purpose: "warm-cache" }).primaryModel()).toBe(LOCAL);
		available.mockReturnValue([NATIVE, LOCAL]);
		expect(hasNativeJudge(settings, registry)).toBe(true);
		const complete = vi.spyOn(tinyModelClient, "complete").mockRejectedValue(new Error("Unexpected local judgment"));
		await expect(classifyAutoPrewalk({ request: REQUEST, history: [] }, deps)).rejects.toThrow("no native backend");
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not run judgment when no candidate is available", async () => {
		const deps = judgeDeps();
		vi.spyOn(deps.registry, "getAvailable").mockReturnValue([]);
		const judge = vi.spyOn(ChainJudge.prototype, "withCandidate");

		expect(await classifyAutoPrewalk({ request: REQUEST, history: [] }, deps)).toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
	});
});

describe("classifyAutoPrewalk bounds", () => {
	it("gives up on a judge that never answers once the timeout fires", async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
			ms === AUTO_PREWALK_TIMEOUT_MS
				? AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
				: realTimeout(ms),
		);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));

		await expect(classify()).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("stops waiting when the caller aborts", async () => {
		const requested = Promise.withResolvers<void>();
		const respond = Object.assign(
			(_input: string | URL | Request, init?: RequestInit) => {
				const response = Promise.withResolvers<Response>();
				requested.resolve();
				init?.signal?.addEventListener("abort", () => response.reject(init.signal?.reason), { once: true });
				return response.promise;
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(respond);
		const controller = new AbortController();
		const pending = classifyAutoPrewalk(
			{ request: REQUEST, history: [] },
			{ ...judgeDeps(), signal: controller.signal },
		);

		await requested.promise;
		controller.abort(new Error("prompt aborted"));

		await expect(pending).rejects.toThrow("prompt aborted");
	});
});

describe("classifyAutoPrewalk follow-up context", () => {
	it("sends only the request when the transcript has nothing before it", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify();

		expect(requests[0]!.state).toEqual({ request: REQUEST });
	});

	it("resolves a short follow-up through the earlier request and the agent's reply, not its reasoning", async () => {
		const requests = serveJudge(answer(0.8, 0.1, 0.1));
		const reply: AgentMessage = {
			...createAssistantMessage("The cursor resets because sync() reads a stale offset."),
			content: [
				{ type: "thinking", thinking: "PRIVATE-REASONING" },
				{ type: "text", text: "The cursor resets because sync() reads a stale offset." },
			],
		};

		await classify({
			request: "do that",
			history: [userTurn("why does the sync cursor reset after a reconnect?"), reply],
		});

		expect(requests[0]!.state).toEqual({
			request: "do that",
			previous_request: "why does the sync cursor reset after a reconnect?",
			previous_response: "The cursor resets because sync() reads a stale offset.",
		});
	});

	it("keeps only the latest request/reply pair and bounds it", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify({
			request: "continue",
			history: [
				userTurn("ancient task about the billing exporter"),
				createAssistantMessage("ancient reply about the billing exporter"),
				userTurn("latest task about the sync cursor"),
				createAssistantMessage("x".repeat(10 * MAX_TINY_MESSAGE_CHARS)),
			],
		});

		const { state } = requests[0]!;
		expect(state.previous_request).toBe("latest task about the sync cursor");
		expect(state.previous_response!.length).toBeLessThanOrEqual(MAX_TINY_MESSAGE_CHARS);
		expect(JSON.stringify(state)).not.toContain("billing exporter");
	});

	it("looks past acknowledgements and injected turns to the request they follow", async () => {
		const requests = serveJudge(answer(0.1, 0.1, 0.8));

		await classify({
			request: "yes, implement it",
			history: [
				userTurn("refactor the scheduler to use a priority queue"),
				createAssistantMessage("Plan: replace the sorted array with a heap."),
				userTurn("ok"),
				userTurn("steered nudge", { attribution: "agent" }),
				userTurn("auto-continue", { synthetic: true }),
			],
		});

		expect(requests[0]!.state).toEqual({
			request: "yes, implement it",
			previous_request: "refactor the scheduler to use a priority queue",
			previous_response: "Plan: replace the sorted array with a heap.",
		});
	});
});
