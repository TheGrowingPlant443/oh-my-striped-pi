import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ChatUsageEvent } from "@oh-my-striped-pi/pi-agent-core";
import type { Api, AssistantMessage, ChoiceQuestion, ImageContent, Model } from "@oh-my-striped-pi/pi-ai";
import * as ai from "@oh-my-striped-pi/pi-ai";
import { getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { JudgmentCache } from "@oh-my-striped-pi/pi-coding-agent/judgment/cache";
import { cfgModelRoles } from "@oh-my-striped-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { ChainJudge, journalJudgmentUsage } from "@oh-my-striped-pi/pi-coding-agent/judgment";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { tinyModelClient } from "@oh-my-striped-pi/pi-coding-agent/tiny/title-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
const ONLINE = getBundledModel("github-copilot", "claude-sonnet-4.6");
if (!LOCAL || !ONLINE) throw new Error("Expected bundled local and Copilot judge models");

const ONLINE_BACKUP = { ...ONLINE, id: "copilot-judge-backup", name: "Judge Backup" } as Model<Api>;
const VISION_CHAT = { ...ONLINE, id: "vision-chat-judge", input: ["text", "image"] } as Model<Api>;

const IMAGE_ONE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

const BUCKET_QUESTION: ChoiceQuestion<"trivial" | "moderate" | "hard"> = {
	type: "choice",
	instructions: "Choose a coarse task bucket.",
	criteria: { trivial: "mechanical", moderate: "localized", hard: "deep" },
};

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

function makeRegistry(models: Model<Api>[], keys: Record<string, string> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/judgment-chain-models.yml");
	// Return the supplied fixtures directly; getAvailable's normal auth filtering is intentionally bypassed.
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

function reply(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ChainJudge", () => {
	it("uses configured native judgments, caches answers, and bills only actual requests", async () => {
		const native = buildModel({
			id: "openjev-company",
			name: "Company judge",
			provider: "company",
			api: "typesafe",
			baseUrl: "https://judgment.company.example",
			kind: "judge",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 0,
		});
		const settings = Settings.isolated({ modelRoles: { judge: "company/openjev-company" } });
		const registry = makeRegistry([native], { company: "company-key" });
		const respond = Object.assign(
			async (input: string | URL | Request) => {
				expect(String(input)).toBe("https://judgment.company.example/v1/systemone");
				return Response.json({
					answers: { urgent: { type: "noul", noul: 0.8 } },
					usage: { input_tokens: 3, output_tokens: 1 },
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(respond);
		const onUsage = vi.fn();
		const cache = JudgmentCache.open(":memory:");
		try {
			const judge = new ChainJudge({ settings, registry, purpose: "test", cache, onUsage });
			const request = {
				state: "company",
				questions: { urgent: { type: "noul", instructions: "Urgent?" } },
			} as const;
			expect((await judge.judge(request)).answers.urgent).toEqual({ type: "noul", noul: 0.8 });
			expect((await judge.judge(request)).answers.urgent).toEqual({ type: "noul", noul: 0.8 });
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(onUsage).toHaveBeenCalledTimes(1);
			expect(onUsage).toHaveBeenCalledWith(
				expect.objectContaining({ role: "judge", provider: "company", model: "openjev-company" }),
			);
		} finally {
			cache.close();
		}
	});

	it("never substitutes prompted chat for a failed native judgment", async () => {
		const native = {
			...ONLINE,
			id: "native-company",
			provider: "company",
			api: "typesafe",
			baseUrl: "https://judge.company.example",
			kind: "judge",
		} as Model;
		const settings = Settings.isolated({
			modelRoles: { judge: "company/native-company" },
			"retry.fallbackChains": { judge: [`${ONLINE.provider}/${ONLINE.id}`] },
		});
		const registry = makeRegistry([native, ONLINE], { company: "company-key", [ONLINE.provider]: "copilot-key" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "rejected" }, { status: 400 }));
		const chat = vi.spyOn(ai, "completeSimple");
		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "company",
				questions: { urgent: { type: "noul", instructions: "Urgent?" } },
			}),
		).rejects.toThrow("every judge candidate failed");
		expect(chat).not.toHaveBeenCalled();
	});

	it("falls from a coarse local question to a tiered online question", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${LOCAL.provider}/${LOCAL.id}` },
			"retry.fallbackChains": { judge: [`${ONLINE.provider}/${ONLINE.id}`] },
		});
		const registry = makeRegistry([LOCAL, ONLINE], { [ONLINE.provider]: "online-key" });
		const kinds: string[] = [];
		let localPrompt = "";
		let onlinePrompt = "";
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_model, promptText) => {
			localPrompt = promptText;
			return "not a bucket";
		});
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			onlinePrompt = context.systemPrompt?.join("\n") ?? "";
			const response = reply(model, "level: high");
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();
		const judge = new ChainJudge({ settings, registry, purpose: "test", onUsage });

		const answer = await judge.withCandidate(async (candidate, kind) => {
			kinds.push(kind);
			if (kind === "local") {
				const result = await candidate.judge({
					state: "refactor the scheduler",
					questions: { bucket: BUCKET_QUESTION },
				});
				return result.answers.bucket.choice;
			}
			const result = await candidate.judge({
				state: "refactor the scheduler",
				questions: { level: TIER_QUESTION },
			});
			return result.answers.level.choice;
		});

		expect(answer).toBe("high");
		expect(kinds).toEqual(["local", "online"]);
		expect(localPrompt).toContain("trivial");
		expect(localPrompt).toContain("moderate");
		expect(localPrompt).toContain("hard");
		expect(onlinePrompt).toContain("low");
		expect(onlinePrompt).toContain("high");
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "judge", provider: ONLINE.provider, model: ONLINE.id }),
		);
	});

	it("follows a judge role change within the chain reuse window", () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([LOCAL, ONLINE], { [ONLINE.provider]: "copilot-key" });
		expect(new ChainJudge({ settings, registry, purpose: "test" }).primaryModel()?.id).toBe(ONLINE.id);

		cfgModelRoles.override(settings, { judge: `${LOCAL.provider}/${LOCAL.id}` });

		expect(new ChainJudge({ settings, registry, purpose: "test" }).primaryModel()?.id).toBe(LOCAL.id);
	});

	it("journals Copilot usage on the active branch and drops usage after a session change", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "copilot-key" });
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, "level: high");
			options?.onAttempt?.(response);
			return response;
		});
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "locate the scheduler", timestamp: 1 });
		const parentId = manager.getLeafId();
		const judge = new ChainJudge({ settings, registry, purpose: "find", onUsage: journalJudgmentUsage(manager) });
		const request = { state: "redesign the scheduler", questions: { level: TIER_QUESTION } };

		await judge.judge(request);

		const entries = manager.getBranch().filter(entry => entry.type === "model_usage");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			parentId,
			purpose: "find",
			role: "judge",
			provider: ONLINE.provider,
			model: ONLINE.id,
			usage: { input: 3, output: 1 },
		});
		expect(manager.getLeafId()).toBe(entries[0]!.id);

		await manager.newSession();
		await judge.judge(request);
		expect(manager.getBranch().filter(entry => entry.type === "model_usage")).toHaveLength(0);
	});

	it("rejects malformed images before invoking chat", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "copilot-key" });
		const chat = vi.spyOn(ai, "completeSimple");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "look at this",
				questions: { level: TIER_QUESTION },
				images: [{ ...IMAGE_ONE, data: "not base64!" }],
			}),
		).rejects.toThrow("judgment: images[0] must contain non-empty base64 data");
		expect(chat).not.toHaveBeenCalled();
	});

	it("reports an explicit error when no candidate supports image judgments", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${LOCAL.provider}/${LOCAL.id}` } });
		const registry = makeRegistry([LOCAL]);
		const local = vi.spyOn(tinyModelClient, "complete");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge({
				state: "look at this",
				questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
				images: [IMAGE_ONE],
			}),
		).rejects.toThrow("judgment: no compatible judge candidate supports images");

		expect(local).not.toHaveBeenCalled();
	});

	it("normalizes prompted image inputs for each selected model without mutating originals", async () => {
		const stbModel = {
			...VISION_CHAT,
			id: "stb-vision-chat-judge",
			name: "STB vision chat judge",
			imageInputDecoder: "stb",
		} as Model<Api>;
		const settings = Settings.isolated({
			modelRoles: { judge: `${stbModel.provider}/${stbModel.id}` },
			"retry.fallbackChains": { judge: [`${VISION_CHAT.provider}/${VISION_CHAT.id}`] },
		});
		const registry = makeRegistry([stbModel, VISION_CHAT], { [VISION_CHAT.provider]: "vision-key" });
		const tinyImage: ImageContent = { ...IMAGE_ONE, detail: "original" };
		const webpBytes = await new Bun.Image(Buffer.from(IMAGE_ONE.data, "base64"))
			.resize(200, 200, { filter: "nearest" })
			.webp({ quality: 90 })
			.bytes();
		const webpImage: ImageContent = {
			type: "image",
			data: Buffer.from(webpBytes).toString("base64"),
			mimeType: "image/webp",
			detail: "high",
		};
		const attempts: Array<{ model: Model<Api>; images: ImageContent[] }> = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			const user = context.messages.find(message => message.role === "user");
			const images = Array.isArray(user?.content)
				? user.content.filter((block): block is ImageContent => block.type === "image")
				: [];
			attempts.push({ model, images });
			if (attempts.length === 1) throw new Error("first prompted candidate failed");
			const response = reply(model, "visible: yes");
			options?.onAttempt?.(response);
			return response;
		});

		const result = await new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "look at this",
			questions: { visible: { type: "noul", instructions: "Is an object visible?" } },
			images: [tinyImage, webpImage],
		});

		expect(result.answers.visible.noul).toBe(1);
		expect(attempts.map(({ model }) => model.id)).toEqual([stbModel.id, VISION_CHAT.id]);
		const [stbImages, fallbackImages] = attempts.map(attempt => attempt.images);
		expect(stbImages).toHaveLength(2);
		expect(stbImages[0]?.detail).toBe("original");
		expect(stbImages[0]?.data).not.toBe(tinyImage.data);
		const tinyMetadata = await new Bun.Image(Buffer.from(stbImages[0]!.data, "base64")).metadata();
		expect(Math.min(tinyMetadata.width, tinyMetadata.height)).toBeGreaterThanOrEqual(200);
		expect(stbImages[1]?.mimeType).not.toBe("image/webp");
		expect(stbImages[1]?.data).not.toBe(webpImage.data);
		expect(stbImages[1]?.detail).toBe("high");
		const convertedWebpMetadata = await new Bun.Image(Buffer.from(stbImages[1]!.data, "base64")).metadata();
		expect(Math.min(convertedWebpMetadata.width, convertedWebpMetadata.height)).toBeGreaterThanOrEqual(200);
		expect(fallbackImages?.[1]).toEqual(webpImage);
		expect(fallbackImages?.[0]?.detail).toBe("original");
		expect(fallbackImages?.[0]?.data).not.toBe(tinyImage.data);
		expect(tinyImage).toEqual({ ...IMAGE_ONE, detail: "original" });
		expect(webpImage.mimeType).toBe("image/webp");
	});

	it("propagates caller abort without attempting a fallback", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${LOCAL.provider}/${LOCAL.id}`] },
		});
		const registry = makeRegistry([ONLINE, LOCAL], { [ONLINE.provider]: "online-key" });
		const controller = new AbortController();
		vi.spyOn(registry, "getApiKey").mockImplementation(async () => {
			controller.abort(new Error("caller stopped"));
			throw new Error("credential refresh interrupted");
		});
		const local = vi.spyOn(tinyModelClient, "complete");

		await expect(
			new ChainJudge({ settings, registry, purpose: "test" }).judge(
				{ state: "x", questions: { level: TIER_QUESTION } },
				{ signal: controller.signal },
			),
		).rejects.toThrow("caller stopped");
		expect(local).not.toHaveBeenCalled();
	});

	it("does not append a session model already present in the configured chain", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${ONLINE_BACKUP.provider}/${ONLINE_BACKUP.id}`] },
		});
		const registry = makeRegistry([ONLINE, ONLINE_BACKUP], { [ONLINE.provider]: "online-key" });
		const attempted: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			attempted.push(model.id);
			if (model.id === ONLINE.id) return reply(model, "unparseable");
			return reply(model, "level: low");
		});

		const result = await new ChainJudge({ settings, registry, purpose: "test", sessionModel: ONLINE }).judge({
			state: "rename a local",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("low");
		// The primary's three entries are its initial completion plus two format
		// corrections. A duplicated session fallback would add another three.
		expect(attempted).toEqual([ONLINE.id, ONLINE.id, ONLINE.id, ONLINE_BACKUP.id]);
	});

	it("bills a chat-backed judgment once per completion attempt on the ledger and in telemetry", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` } });
		const registry = makeRegistry([ONLINE], { [ONLINE.provider]: "online-key" });
		const replies = ["no idea", "level: high"];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, replies.shift() ?? "");
			response.usage.cost = { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();
		const events: ChatUsageEvent[] = [];
		const judge = new ChainJudge({
			settings,
			registry,
			purpose: "test",
			onUsage,
			telemetry: { onChatUsage: event => void events.push(event) },
		});

		// Telemetry hooks fire synchronously inside the attempt report.
		const result = await judge.judge({ state: "redesign the scheduler", questions: { level: TIER_QUESTION } });

		expect(result.answers.level.choice).toBe("high");
		// Two attempts (initial + format correction): each billed once, never re-billed from the aggregate result.
		expect(onUsage.mock.calls.map(([usage]) => usage.usage.cost.total)).toEqual([0.01, 0.01]);
		expect(events.map(event => [event.operation, event.cost])).toEqual([
			["judgment", { usd: 0.01, inputUsd: 0.01, outputUsd: 0 }],
			["judgment", { usd: 0.01, inputUsd: 0.01, outputUsd: 0 }],
		]);
	});
});
