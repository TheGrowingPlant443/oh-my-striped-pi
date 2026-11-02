import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

describe("issue #775: per-model defaultLevel", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-775-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	function companyModel(id: string): Model {
		return buildModel({
			id,
			name: id,
			provider: "company-thinking",
			api: "anthropic-messages",
			baseUrl: "https://thinking.company.invalid",
			reasoning: true,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}

	async function createSession(initialModel: Model, settings: Settings) {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Low,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime(initialModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(Effort.Low);
	}

	it("setModel adopts model.thinking.defaultLevel when present", async () => {
		const sonnet = companyModel("initial");
		const opus = companyModel("target");
		const opusWithDefault: Model = {
			...opus,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				defaultLevel: Effort.XHigh,
			},
		};

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opusWithDefault);

		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("setModel preserves current level when model has no defaultLevel", async () => {
		const sonnet = companyModel("initial");
		const opus = companyModel("target");

		const settings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		await createSession(sonnet, settings);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.setModel(opus);

		expect(session.thinkingLevel).toBe(Effort.Low);
	});
});
