/** Configured discovery defaults must resolve before bundled-model fallback. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-striped-pi/pi-ai";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-striped-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-striped-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("issue #6162 fresh launch default role from models.yml discovery provider", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-config-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const baseUrl = "https://example.com/v1";

	/** Configured Copilot `/v1/models` discovery. */
	function mockDiscovery(models: string[]): FetchImpl {
		return async input => {
			const url = String(input);
			if (url === `${baseUrl}/models`) {
				return Response.json({ data: models.map(id => ({ id })) });
			}
			return new Response("not found", { status: 404 });
		};
	}

	test("selects the configured discovery default instead of a bundled fallback on cold cache", async () => {
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  github-copilot:",
				`    baseUrl: ${baseUrl}`,
				"    api: openai-completions",
				"    apiKey: MY_API_KEY",
				"    discovery:",
				"      type: openai-models-list",
				"",
			].join("\n"),
		);

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("github-copilot", "test-provider-key");

		// The requested model is absent until configured discovery completes.
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: mockDiscovery(["some-model"]),
		});

		const settings = Settings.isolated();
		settings.setModelRole("default", "github-copilot/some-model");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
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
		});

		try {
			expect(session.model?.provider).toBe("github-copilot");
			expect(session.model?.id).toBe("some-model");
		} finally {
			await session.dispose();
		}
	});
});
