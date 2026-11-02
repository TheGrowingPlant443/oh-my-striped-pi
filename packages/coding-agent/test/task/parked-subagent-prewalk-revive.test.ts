/**
 * A kept-alive subagent that handed off through prewalk and then parked must revive on
 * the handoff target, not on the model it was spawned with, and must not re-arm the
 * consumed handoff.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-striped-pi/pi-ai/api-registry";
import { Effort } from "@oh-my-striped-pi/pi-ai";
import { createMockModel } from "@oh-my-striped-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-striped-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-striped-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-striped-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-striped-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-striped-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "HandedOff";
const MOCK_API_SOURCE = "test/parked-subagent-prewalk-revive";
const PLANNER = "mock-model";
const TARGET = "mock-handoff";
const ENV_KEYS = ["HOME", "OMSP_CODING_AGENT_DIR", "OMSP_PROFILE"] as const;

/** The mock carries no effort ladder; without one every configured effort clamps away. */
const thinking = { mode: "effort", efforts: [Effort.Medium, Effort.High] } as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-prewalk-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omsp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("revives a parked subagent on its prewalk handoff target, keeping its todo list and not re-arming", async () => {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const planner = Object.assign(
		createMockModel({
			provider: "mock",
			id: PLANNER,
			reasoning: true,
			handler: context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
				if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "todo")) {
					return {
						content: [
							{
								type: "toolCall",
								name: "todo",
								arguments: { op: "init", list: [{ phase: "Work", items: ["Write the file"] }] },
							},
						],
					};
				}
				return {
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: path.join(cwd, "out.txt"), content: "done\n" },
						},
					],
				};
			},
		}),
		{ thinking },
	);
	const target = Object.assign(
		createMockModel({
			provider: "mock",
			id: TARGET,
			reasoning: true,
			handler: context =>
				(context.tools ?? []).some(tool => tool.name === "yield")
					? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
					: { content: ["label"] },
		}),
		{ thinking },
	);
	modelRegistry.registerProvider(planner.provider, {
		api: planner.api,
		baseUrl: planner.baseUrl,
		models: [planner, target],
	});
	registerCustomApi(
		planner.api,
		(model, context, options) => (model.id === planner.id ? planner : target).stream(model, context, options),
		MOCK_API_SOURCE,
	);

	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				tools: ["read", "write", "todo"],
				source: "bundled",
			},
			task: "write out.txt",
			index: 0,
			id: AGENT_ID,
			modelOverride: `mock/${PLANNER}:medium`,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"task.agentPrewalk": { task: `mock/${TARGET}:high` },
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: `mock/${PLANNER}` },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);

		const live = AgentRegistry.global().get(AGENT_ID)?.session;
		if (!live) throw new Error("Expected a kept-alive subagent session");
		expect(live.model?.id).toBe(TARGET);
		expect(live.configuredThinkingLevel()).toBe(Effort.High);

		await AgentLifecycleManager.global().park(AGENT_ID);
		const revived = await AgentLifecycleManager.global().ensureLive(AGENT_ID);

		expect(revived.model?.id).toBe(TARGET);
		expect(revived.configuredThinkingLevel()).toBe(Effort.High);
		expect(revived.getPrewalkState()).toBeUndefined();
		expect(revived.getActiveToolNames()).toContain("todo");
	} finally {
		authStorage.close();
	}
}, 30_000);
