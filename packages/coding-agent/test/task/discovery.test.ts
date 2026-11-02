import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-striped-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-striped-pi/pi-coding-agent/capability/fs";
import { clearAgentPluginRootCache } from "@oh-my-striped-pi/pi-coding-agent/discovery/agent-plugin-format";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-striped-pi/pi-coding-agent/discovery/omsp-extension-roots";
import { clearClaudePluginRootsCache, injectPluginDirRoots } from "@oh-my-striped-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-striped-pi/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@oh-my-striped-pi/pi-utils";

const OMSP_AGENT_MD = [
	"---",
	"name: omsp-test-agent",
	"description: OMSP-native test agent.",
	"---",
	"You are an OMSP task agent.",
].join("\n");

const OMSP_PLUGIN_AGENT_MD = [
	"---",
	"name: loom-verify-spec",
	"description: Plugin-shipped verification agent.",
	"---",
	"You verify the loom spec.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

async function writeOmpPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".omsp", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", omsp: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "omsp-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.md"), OMSP_PLUGIN_AGENT_MD);
}

function agentMd(name: string, model: string): string {
	return ["---", `name: ${name}`, `description: ${name} probe.`, `model: ${model}`, "---", `body ${name}`].join("\n");
}

// Register an omsp-installed marketplace plugin via the OMSP plugin registry
// (`~/.omsp/plugins/installed_plugins.json`), the path listClaudePluginRoots
// reads as origin "omsp" — distinct from the node_modules path above. `manifest`
// controls the declared plugin dialect: `.omsp-plugin/plugin.json` (OMSP-native),
// `.claude-plugin/plugin.json` (Claude Code), `both` (OMSP wins by precedence),
// or `none` (bare directory).
async function writeOmpMarketplacePlugin(
	home: string,
	options: {
		agentName: string;
		model: string;
		manifest: "omsp" | "claude" | "both" | "none";
		nativeMarker?: ".omsp-plugin" | ".omp-plugin";
	},
): Promise<void> {
	const pluginRoot = path.join(home, "marketplace-cache", options.agentName);
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "agents", `${options.agentName}.md`),
		agentMd(options.agentName, options.model),
	);

	const wantsOmp = options.manifest === "omsp" || options.manifest === "both";
	const wantsClaude = options.manifest === "claude" || options.manifest === "both";
	if (wantsOmp) {
		await fs.mkdir(path.join(pluginRoot, options.nativeMarker ?? ".omsp-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, options.nativeMarker ?? ".omsp-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}
	if (wantsClaude) {
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}

	const registryDir = path.join(home, ".omsp", "plugins");
	await fs.mkdir(registryDir, { recursive: true });
	await fs.writeFile(
		path.join(registryDir, "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: {
				[`${options.agentName}@my-marketplace`]: [
					{ installPath: pluginRoot, version: "1.0.0", scope: "user", enabled: true },
				],
			},
		}),
	);
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("omsp-plugins");
		clearOmpExtensionCliRoots();
		await injectPluginDirRoots(tempHome, []);
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("loads OMSP agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".omsp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omsp", "agents", "omsp-test-agent.md"), OMSP_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("omsp-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".omsp", "agents"));
	});

	test("loads agents from OMSP npm plugins under <home>/.omsp/plugins/node_modules", async () => {
		await writeOmpPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes OMSP npm plugin agents when omsp-plugins is disabled", async () => {
		await writeOmpPluginAgent(tempHome);
		disableProvider("omsp-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listOmpExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/omsp-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cliExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-cli", "---", "cli body"].join("\n"),
		);
		await fs.writeFile(
			path.join(projectExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-project-settings", "---", "project body"].join("\n"),
		);

		await fs.mkdir(path.join(projectDir, ".omsp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omsp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectOmpExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.md"));
	});

	test("explicit-only CLI roots expose only explicitly named package agents", async () => {
		const staleExt = path.join(tempHome, "stale-ext");
		const explicitExt = path.join(tempHome, "explicit-ext");
		const settingsExt = path.join(tempHome, "settings-ext");
		for (const [root, name] of [
			[staleExt, "stale-agent"],
			[explicitExt, "explicit-agent"],
			[settingsExt, "settings-agent"],
		] as const) {
			await fs.mkdir(path.join(root, "agents"), { recursive: true });
			await fs.writeFile(
				path.join(root, "agents", `${name}.md`),
				["---", `name: ${name}`, `description: ${name}`, "---", `${name} body`].join("\n"),
			);
		}
		await fs.mkdir(path.join(projectDir, ".omsp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omsp", "settings.json"),
			JSON.stringify({ extensions: [settingsExt] }),
		);
		await writeOmpPluginAgent(tempHome);

		injectOmpExtensionCliRoots([staleExt], tempHome, projectDir);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir, {
			mode: "explicit-only",
			replace: true,
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toEqual(expect.arrayContaining(["stale-agent", "settings-agent", "loom-verify-spec"]));
	});

	test("discovers agents from a --plugin-dir root with the foreign claude-plugins opt-in off (#11151)", async () => {
		// `--plugin-dir` roots ride the shared plugin registry as user-scope, origin
		// "plugin-dir" entries. The claude-plugins foreign opt-in is off by default, so
		// gating user-scope roots purely on scope (as before) dropped these agents.
		const pluginDir = path.join(tempHome, "my-plugin");
		await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(pluginDir, "agents", "plugin-dir-agent.md"),
			["---", "name: plugin-dir-agent", "description: agent shipped in a --plugin-dir plugin.", "---", "body"].join(
				"\n",
			),
		);
		await injectPluginDirRoots(tempHome, [pluginDir], projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("plugin-dir-agent");
	});

	test("honors model frontmatter of OMSP-native omsp-installed marketplace plugin agents (#12028)", async () => {
		// omsp-installed marketplace plugins ride the shared plugin registry as
		// origin "omsp" roots. An OMSP-native package (no Claude manifest) uses OMSP
		// model selectors, so `model:` must survive discovery.
		enableProvider("claude-plugins");
		await writeOmpMarketplacePlugin(tempHome, {
			agentName: "omsp-probe",
			model: '["@advisor", "@smol"]',
			manifest: "none",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "omsp-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toEqual(["@advisor", "@smol"]);
	});

	test("drops model frontmatter of a Claude-format plugin installed via the OMSP registry (#12031 review)", async () => {
		// origin "omsp" but a `.claude-plugin` package: its `model: sonnet` is a
		// Claude alias, not an OMSP selector, so it must still be stripped.
		enableProvider("claude-plugins");
		await writeOmpMarketplacePlugin(tempHome, {
			agentName: "claude-probe",
			model: "sonnet",
			manifest: "claude",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "claude-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toBeUndefined();
	});

	for (const nativeMarker of [".omsp-plugin", ".omp-plugin"] as const) {
		test(`honors model frontmatter when ${nativeMarker} overrides a Claude manifest`, async () => {
			enableProvider("claude-plugins");
			await writeOmpMarketplacePlugin(tempHome, {
				agentName: "hybrid-probe",
				model: '["@advisor", "@smol"]',
				manifest: "both",
				nativeMarker,
			});

			const { agents } = await discoverAgents(projectDir, tempHome);
			const agent = agents.find(candidate => candidate.name === "hybrid-probe");

			expect(agent).toBeDefined();
			expect(agent?.model).toEqual(["@advisor", "@smol"]);
		});
	}
});
