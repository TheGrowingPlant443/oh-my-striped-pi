import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("/slow", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	function createSession(provider: string, api: Api, settings = Settings.isolated()): AgentSession {
		const tempDir = TempDir.createSync("@slow-command-");
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => {
			authStorage.close();
			tempDir.removeSync();
		});
		const model = buildModel({
			id: "gpt-5.6",
			name: "Company Responses",
			api,
			provider,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		return new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
	}

	async function slow(session: AgentSession, args: string): Promise<string> {
		const command = BUILTIN_MODE_SLASH_COMMANDS.find(spec => spec.name === "slow");
		if (!command?.handle) throw new Error("/slow is not registered");
		const outputs: string[] = [];
		const runtime = {
			session,
			settings: session.settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;
		await command.handle({ name: "slow", args, text: `/slow ${args}` }, runtime);
		return outputs.join("\n");
	}

	it("switches company OpenAI-compatible models to flex and leaves a priority tier alone on off", async () => {
		const session = createSession("company", "openai-responses");

		await slow(session, "on");
		expect(session.serviceTierByFamily).toEqual({ openai: "flex" });
		expect(session.isSlowModeEnabled()).toBe(true);

		await slow(session, "");
		expect(session.serviceTierByFamily).toEqual({});

		session.setServiceTierFamily("openai", "priority");
		await slow(session, "off");
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
	});

	it("reports models without a slow mode and leaves settings untouched", async () => {
		const session = createSession("github-copilot", "anthropic-messages");

		await slow(session, "on");
		expect(session.serviceTierByFamily).toEqual({});
		expect(await slow(session, "sideways")).toContain("Usage: /slow");
	});

	it("keeps unsupported service-tier controls off Copilot Responses models", () => {
		const session = createSession("github-copilot", "openai-responses");
		expect(session.isSlowModeSupported()).toBe(false);
		expect(session.isSlowModeEnabled()).toBe(false);
		expect(session.getSlowModeScope()).toBeUndefined();
	});
});
