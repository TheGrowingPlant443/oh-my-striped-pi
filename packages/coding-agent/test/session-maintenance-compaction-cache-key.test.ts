import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { normalizeOpenAIPromptCacheKey } from "@oh-my-striped-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-striped-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Manual and automatic maintenance preserve a private gateway's distinct
 * conversation header and normalized body cache identity. An explicit key must
 * reach both summary callsites without replacing the conversation id.
 */

const SESSION_HEADER = "x-litellm-session-id";
/** Raw SDK session id over the 64-char cache-key wire limit (normalizes to pc_…). */
const RAW_SESSION_ID = `ses_${"0123456789abcdef".repeat(6)}`;
/** An explicit prompt-cache identity over the 64-char wire limit. */
const EXPLICIT_CACHE_KEY = `cache_${"fedcba9876543210".repeat(4)}`;

interface CapturedCompactionRequest {
	url: string;
	sessionHeader: string | null;
	body: { model?: string; prompt_cache_key?: string; input: Array<Record<string, unknown>> };
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("session-maintenance V2 compaction cache-key provenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let gatewayModel: Model;
	let compactionRequests: CapturedCompactionRequest[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compaction-provenance-");
		// Private Responses gateway opts into its conversation header and V2 protocol.
		gatewayModel = buildModel({
			id: "private-contributor",
			name: "Private compaction gateway fixture",
			api: "openai-responses",
			provider: "private-compaction-gateway",
			baseUrl: "https://gateway.company.invalid/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: { sessionHeader: "x-litellm-session-id" },
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		} satisfies ModelSpec<"openai-responses">);
		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote"],
			"contextPromotion.enabled": false,
		});
		const agent = new Agent({
			initialState: { model: gatewayModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(gatewayModel.provider, "private-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			// Long raw SDK provider session id; no providerPromptCacheKey in the
			// session header, so agent.promptCacheKey stays undefined.
			providerSessionId: RAW_SESSION_ID,
		});
		session.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([gatewayModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		compactionRequests = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as CapturedCompactionRequest["body"];
				if (body.input?.at(-1)?.type === "compaction_trigger") {
					compactionRequests.push({
						url,
						sessionHeader: new Headers(init?.headers).get(SESSION_HEADER),
						body,
					});
					return sseResponse([
						{
							type: "response.output_item.done",
							output_index: 0,
							item: { type: "compaction", encrypted_content: "enc" },
						},
						{
							type: "response.completed",
							response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
						},
					]);
				}
				throw new Error(`Unexpected request during compaction provenance test: ${url}`);
			}),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	/** The raw conversation id stays independent of the normalized body cache key. */
	function expectRawChildHeaderNormalizedBodyKey(): void {
		expect(session.agent.promptCacheKey).toBeUndefined();
		expect(compactionRequests).toHaveLength(1);
		const request = compactionRequests[0];
		if (!request) throw new Error("Expected a V2 compaction request");
		const normalized = normalizeOpenAIPromptCacheKey(RAW_SESSION_ID);
		if (!normalized?.startsWith("pc_")) throw new Error("Expected the long session id to normalize to pc_…");
		expect(normalized).not.toBe(RAW_SESSION_ID);
		expect(request.body.prompt_cache_key).toBe(normalized);
		expect(request.sessionHeader).toBe(RAW_SESSION_ID);
		expect(request.sessionHeader).not.toBe(request.body.prompt_cache_key);
		expect(request.url.endsWith("/responses")).toBe(true);
	}

	it("keeps the raw child session id on manual compaction V2 requests without an explicit cache key", async () => {
		const result = await session.compact();
		await session.waitForIdle();
		expect(result?.shortSummary).toBe("Remote compaction");
		expectRawChildHeaderNormalizedBodyKey();
	});

	/** Drive a threshold-crossing assistant turn so `runAutoCompaction` issues its V2 request. */
	async function triggerAutoCompaction(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		const contextWindow = gatewayModel.contextWindow;
		if (!contextWindow) throw new Error("Expected current model context window");
		const assistant = {
			...assistantMsg("threshold reached"),
			api: gatewayModel.api,
			provider: gatewayModel.provider,
			model: gatewayModel.id,
			usage: {
				input: contextWindow,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextWindow + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await promise;
		await session.waitForIdle();
	}

	it("keeps the raw child session id on auto-compaction V2 requests without an explicit cache key", async () => {
		await triggerAutoCompaction();
		expectRawChildHeaderNormalizedBodyKey();
	});

	it.each(["manual", "auto"] as const)("passes an explicit prompt-cache key into %s compaction", async mode => {
		session.agent.promptCacheKey = EXPLICIT_CACHE_KEY;
		const normalized = normalizeOpenAIPromptCacheKey(EXPLICIT_CACHE_KEY);
		expect(normalized).toMatch(/^pc_/);

		if (mode === "manual") {
			const result = await session.compact();
			await session.waitForIdle();
			expect(result?.shortSummary).toBe("Remote compaction");
		} else {
			await triggerAutoCompaction();
		}

		expect(compactionRequests).toHaveLength(1);
		expect(compactionRequests[0]?.body.prompt_cache_key).toBe(normalized);
		expect(compactionRequests[0]?.sessionHeader).toBe(RAW_SESSION_ID);
		expect(compactionRequests[0]?.url.endsWith("/responses")).toBe(true);
	});

	it("preserves explicit cache provenance when remote compaction overrides the active model id", async () => {
		Object.assign(gatewayModel, {
			id: "private-active-alias",
			remoteCompaction: { enabled: true, v2StreamingEnabled: true, model: "private-contributor" },
		});
		session.agent.promptCacheKey = EXPLICIT_CACHE_KEY;
		const result = await session.compact();
		await session.waitForIdle();

		expect(result?.shortSummary).toBe("Remote compaction");
		expect(compactionRequests).toHaveLength(1);
		expect(compactionRequests[0]?.body.model).toBe("private-contributor");
		expect(compactionRequests[0]?.body.prompt_cache_key).toBe(normalizeOpenAIPromptCacheKey(EXPLICIT_CACHE_KEY));
		expect(compactionRequests[0]?.sessionHeader).toBe(RAW_SESSION_ID);
		expect(session.model?.id).toBe("private-active-alias");
	});
});
