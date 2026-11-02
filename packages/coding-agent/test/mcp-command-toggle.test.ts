import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-striped-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-striped-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-striped-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-striped-pi/pi-tui/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-striped-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.OMSP_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.OMSP_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.OMSP_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.OMSP_CODING_AGENT_DIR;
	delete Bun.env.OMSP_CODING_AGENT_DIR;
}

function createController() {
	const refreshMCPTools = vi.fn(async () => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
		}),
	);
	const mcpManager = createMcpManagerStub({ connectServers });
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
	});
	const controller = new MCPCommandController(ctx);

	return { controller, ctx, mcpManager, refreshMCPTools, connectServers };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test.each(["smithery-search filesystem", "smithery-login", "smithery-logout"])(
		"rejects removed registry command %s without requests or user-data changes",
		async command => {
			await writeProjectConfig(projectDir, { smithery: { type: "stdio", command: "company-mcp" } });
			const configPath = getMCPConfigPath("project", projectDir);
			const originalConfig = await fs.readFile(configPath, "utf8");
			const credentialPath = path.join(agentDir, "smithery.json");
			const originalCredential = JSON.stringify({ apiKey: "test-preserved-key" });
			await Bun.write(credentialPath, originalCredential);
			const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected registry request"));
			const { controller, ctx, mcpManager } = createController();
			const error = vi.spyOn(ctx, "showError");

			await controller.handle(`/mcp ${command}`);

			expect(error).toHaveBeenCalledTimes(1);
			expect(request).not.toHaveBeenCalled();
			expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
			expect(mcpManager.connectServers).not.toHaveBeenCalled();
			expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
			expect(await fs.readFile(credentialPath, "utf8")).toBe(originalCredential);
		},
	);

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, connectServers } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});
});
