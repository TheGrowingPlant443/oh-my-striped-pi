import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for #8863: a deferred `--model @<role>` whose role maps to a model
// on configured Copilot discovery must trigger the
// online-if-uncached discovery refresh. Before the fix the deferred guard in
// sdk.ts treated the role's expanded `configuredPatterns` as a resolved runtime
// match, so `runtimeResolved` was `true`, the fallback refresh was skipped, and
// resolution failed with `Model "@<role>" not found`.
describe("createAgentSession deferred role alias on discoverable provider (#8863)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-sdk-deferred-role-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	const mockDiscovery = (modelNames: string[]): FetchImpl => {
		return async input => {
			if (String(input) === "https://copilot.example/v1/models") {
				return Response.json({ data: modelNames.map(id => ({ id })) });
			}
			return new Response("", { status: 404 });
		};
	};

	it("refreshes discoverable providers so @smol resolves to the discovered model", async () => {
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"github-copilot": {
						baseUrl: "https://copilot.example/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		// Fresh registry with no discovery cache: the requested model is only
		// reachable through a refresh, which the deferred path must perform.
		const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockDiscovery(["phi3"]),
		});
		const settings = Settings.isolated({
			modelRoles: { smol: "github-copilot/phi3" },
			"compaction.enabled": false,
		});

		let session: AgentSession | undefined;
		try {
			const result = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				authStorage,
				modelRegistry,
				settings,
				modelPattern: "@smol",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
			session = result.session;

			expect(result.session.model?.provider).toBe("github-copilot");
			expect(result.session.model?.id).toBe("phi3");
		} finally {
			session?.dispose();
		}
	});
});
