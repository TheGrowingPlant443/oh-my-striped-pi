import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import type { ModelRegistry, ProviderDiscoveryState } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { ModelRegistry as ModelRegistryImpl } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { ModelHubComponent } from "@oh-my-striped-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-striped-pi/pi-tui/theme";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import type { TUI } from "@oh-my-striped-pi/pi-tui";
import { removeSyncWithRetries, Snowflake } from "@oh-my-striped-pi/pi-utils";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for issue-970 selector test");
	}
	setThemeInstance(testTheme);
}

async function createHub(state: ProviderDiscoveryState): Promise<ModelHubComponent> {
	const modelRegistry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [],
		getAll: () => [],
		getDiscoverableProviders: () => [state.provider],
		getProviderDiscoveryState: () => state,
		authStorage: { keys: { source: () => undefined } },
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(ui, createModelBrowserSource(Settings.isolated({})), modelRegistry, [], {
		onAssign: () => {},
		onUnassign: () => {},
		onCancel: () => {},
	});
	await Bun.sleep(0);
	installTestTheme();
	// Scope-hop is the default arrow mode: one Down moves All models → the
	// sole provider entry (separators are skipped).
	hub.handleInput("\x1b[B");
	await Bun.sleep(0);
	return hub;
}

describe("issue #970 configured Copilot discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for issue-970 selector test");
		}
	});

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-970-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("discovers configured models and lets YAML models override discovered fields", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  github-copilot:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    apiKey: sk-1234",
				"    api: openai-completions",
				"    auth: apiKey",
				"    discovery:",
				"      type: openai-models-list",
				"    models:",
				"      - id: qwen3.6",
				"        name: Qwen3.6",
				"        contextWindow: 128000",
				"        maxTokens: 8192",
			].join("\n"),
		);

		const fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = async (
			input,
			init,
		) => {
			const url = String(input);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer sk-1234");
			return new Response(JSON.stringify({ data: [{ id: "qwen3.6" }, { id: "vllm-lab-fork-b2" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("github-copilot");

		const providerModels = registry.getAll().filter(model => model.provider === "github-copilot");
		expect(providerModels.map(model => model.id)).toEqual(expect.arrayContaining(["qwen3.6", "vllm-lab-fork-b2"]));
		expect(registry.getProviderDiscoveryState("github-copilot")?.status).toBe("ok");

		const qwen = registry.find("github-copilot", "qwen3.6");
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.provider).toBe("github-copilot");
		expect(qwen?.name).toBe("Qwen3.6");
		expect(qwen?.contextWindow).toBe(128000);
		expect(qwen?.maxTokens).toBe(8192);

		const deepseek = registry.find("github-copilot", "vllm-lab-fork-b2");
		expect(deepseek?.api).toBe("openai-completions");
		expect(deepseek?.provider).toBe("github-copilot");
		expect(deepseek?.name).toBe("vllm-lab-fork-b2");
		expect(deepseek?.contextWindow).toBe(128000);
		expect(deepseek?.maxTokens).toBe(32_768);
	});

	test("shows a provider-tab hint when discovery succeeds but returns zero models", async () => {
		installTestTheme();
		const hub = await createHub({
			provider: "github-copilot",
			status: "empty",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
		});

		const rendered = normalizeRenderedText(hub.render(200).join("\n"));
		expect(rendered).toContain("Discovery succeeded but returned 0 models");
		expect(rendered).toContain("/models returns { data: [{ id }] }");
		hub.dispose();
	});

	test("shows a provider-tab hint when the discovery endpoint returns 404", async () => {
		installTestTheme();
		const hub = await createHub({
			provider: "github-copilot",
			status: "unavailable",
			optional: false,
			stale: false,
			fetchedAt: Date.now(),
			models: [],
			error: "HTTP 404 from http://192.168.5.3:8085/v1/models",
		});

		const rendered = normalizeRenderedText(hub.render(200).join("\n"));
		expect(rendered).toContain("http://192.168.5.3:8085/v1/models returned 404");
		expect(rendered).toContain("baseUrl");
		hub.dispose();
	});

	test("ignores legacy configured discovery cache namespaces", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  github-copilot:",
				"    baseUrl: http://192.168.5.3:8085/v1",
				"    auth: none",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
			].join("\n"),
		);
		writeModelCache(
			"github-copilot",
			Date.now(),
			[
				buildModel({
					id: "Stale",
					name: "Stale",
					provider: "github-copilot",
					api: "openai-completions",
					baseUrl: "http://192.168.5.3:8085/v1",
					contextWindow: 128_000,
					maxTokens: 32_768,
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
				}),
			],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const calls: string[] = [];
		const fetchMock: (input: string | URL | Request) => Promise<Response> = async input => {
			const url = String(input);
			calls.push(url);
			if (url !== "http://192.168.5.3:8085/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return new Response(JSON.stringify({ data: [{ id: "Fresh", max_model_len: 262_144 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const registry = new ModelRegistryImpl(authStorage, modelsPath, { fetch: fetchMock });
		await registry.refreshProvider("github-copilot", "online-if-uncached");

		expect(calls).toEqual(["http://192.168.5.3:8085/v1/models"]);
		expect(registry.find("github-copilot", "Fresh")?.contextWindow).toBe(262_144);
		expect(registry.find("github-copilot", "Stale")).toBeUndefined();
	});
});
