import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveAgentServiceTierOverride } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const deferredModelPattern = "github-copilot/gpt-4o-sdk-deferred";

const runtimeProviderExtension: ExtensionFactory = pi => {
	pi.registerProvider("github-copilot", {
		baseUrl: "https://api.githubcopilot.com",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		models: [
			{
				id: "gpt-4o-sdk-deferred",
				name: "Deferred Copilot Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
};

const originalNoTitle = Bun.env.PI_NO_TITLE;

function captureCopilotRequests() {
	const payloads: unknown[] = [];
	const extension: ExtensionFactory = pi => {
		pi.on("before_provider_request", event => {
			payloads.push(event.payload);
		});
	};
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (init?.method === "HEAD") return new Response(null, { status: 200 });
				expect(url).toBe("https://api.githubcopilot.com/chat/completions");
				const chunks = [
					{
						id: "sdk-tier-reply",
						choices: [
							{ index: 0, delta: { role: "assistant", content: "offline response" }, finish_reason: null },
						],
					},
					{
						id: "sdk-tier-reply",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
					},
				];
				return new Response(
					`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return { payloads, extension, fetch };
}

describe.serial("createAgentSession resolveServiceTierByFamily", () => {
	beforeEach(() => {
		Bun.env.PI_NO_TITLE = "1";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => {
					throw new Error("Unexpected network request in SDK service-tier regression test");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
	});
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
		if (originalNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = originalNoTitle;
	});

	function openAuthStorage(): AuthStorage {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		return authStorage;
	}

	function sessionOptions(cwd: string, authStorage: AuthStorage, settings: Settings, sessionManager: SessionManager) {
		return {
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			settings,
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		};
	}

	it("resolves an exact-agent tier override against the final Copilot model without sending unsupported tiers", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-first-turn-");
		const requests = captureCopilotRequests();
		const resolvedModels: Array<Model | undefined> = [];
		const { session } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				openAuthStorage(),
				Settings.isolated({ "tier.openai": "default", "tier.anthropic": "priority", "tier.google": "flex" }),
				SessionManager.inMemory(),
			),
			extensions: [runtimeProviderExtension, requests.extension],
			modelPattern: deferredModelPattern,
			resolveServiceTierByFamily: model => {
				resolvedModels.push(model);
				return resolveAgentServiceTierOverride("priority", model, {});
			},
		});
		try {
			expect(resolvedModels.map(model => model && `${model.provider}/${model.id}`)).toEqual([deferredModelPattern]);
			expect(session.serviceTierByFamily).toEqual({});
			await session.prompt("first turn");
			expect(requests.fetch).toHaveBeenCalled();
			expect(requests.payloads).toHaveLength(1);
			expect(requests.payloads[0]).toMatchObject({ model: "gpt-4o-sdk-deferred" });
			expect(requests.payloads[0]).not.toHaveProperty("service_tier");
		} finally {
			await session.dispose();
		}
	});

	it.each([undefined, { openai: "default" }] as const)(
		"keeps the resolved tier map %j without putting unsupported service_tier on Copilot requests",
		async tiers => {
			using tempDir = TempDir.createSync("@omp-service-tier-default-");
			const requests = captureCopilotRequests();
			const resolveServiceTierByFamily = tiers ? () => tiers : undefined;
			const { session } = await createAgentSession({
				...sessionOptions(
					tempDir.path(),
					openAuthStorage(),
					Settings.isolated({ "tier.openai": "none", "tier.anthropic": "none", "tier.google": "none" }),
					SessionManager.inMemory(),
				),
				extensions: [runtimeProviderExtension, requests.extension],
				modelPattern: deferredModelPattern,
				...(resolveServiceTierByFamily ? { resolveServiceTierByFamily } : {}),
			});
			try {
				expect(session.serviceTierByFamily).toEqual(tiers ?? {});
				await session.prompt("default tier turn");
				expect(requests.payloads).toHaveLength(1);
				expect(requests.payloads[0]).toMatchObject({ model: "gpt-4o-sdk-deferred" });
				expect(requests.payloads[0]).not.toHaveProperty("service_tier");
			} finally {
				await session.dispose();
			}
		},
	);

	it("evaluates the resolver against a deferred model and replaces configured tiers", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-");
		const resolvedModels: Array<Model | undefined> = [];
		const { session } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				openAuthStorage(),
				Settings.isolated({ "tier.anthropic": "priority" }),
				SessionManager.inMemory(),
			),
			extensions: [runtimeProviderExtension],
			modelPattern: deferredModelPattern,
			resolveServiceTierByFamily: model => {
				resolvedModels.push(model);
				return { openai: "scale" };
			},
		});
		try {
			expect(resolvedModels.map(model => model && `${model.provider}/${model.id}`)).toEqual([deferredModelPattern]);
			expect(session.model?.id).toBe("gpt-4o-sdk-deferred");
			expect(session.serviceTierByFamily).toEqual({ openai: "scale" });
		} finally {
			await session.dispose();
		}
	});

	it("persists an empty resolved tier map so a reopened session does not re-derive tiers from settings", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-reopen-");
		const authStorage = openAuthStorage();
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const settings = Settings.isolated({ "tier.openai": "priority" });
		const { session: spawned } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				settings,
				await SessionManager.open(sessionFile, tempDir.path()),
			),
			extensions: [runtimeProviderExtension],
			modelPattern: deferredModelPattern,
			resolveServiceTierByFamily: () => ({}),
		});
		try {
			expect(spawned.serviceTierByFamily).toEqual({});
		} finally {
			await spawned.dispose();
		}

		const { session: revived } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				settings,
				await SessionManager.open(sessionFile, tempDir.path()),
			),
			extensions: [runtimeProviderExtension],
		});
		try {
			expect(revived.serviceTierByFamily).toEqual({});
		} finally {
			await revived.dispose();
		}
	});
});
