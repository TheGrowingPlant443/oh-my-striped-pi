import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { closeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-striped-pi/pi-utils";
import { runSearchCommand } from "../../../src/cli/web-search-cli";

import { cfgRetryFallbackChains } from "@oh-my-striped-pi/pi-coding-agent/session/settings";
import { cfgSearxngEndpoint } from "@oh-my-striped-pi/pi-coding-agent/web/settings";

const originalAgentDir = process.env.OMSP_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMSP_PROFILE;
const originalPiProfile = process.env.OMSP_PROFILE;
const originalFirecrawlBaseUrl = process.env.FIRECRAWL_BASE_URL;

let tempAgentDir: TempDir | undefined;
let originalExitCode: typeof process.exitCode;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("http://searxng.internal/search")) {
				return new Response(
					JSON.stringify({
						results: [{ title: "Private SearXNG result", url: "https://searxng.example", content: "searxng" }],
					}),
					{
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (url === "http://firecrawl.internal/v2/search") {
				return new Response(
					JSON.stringify({
						data: {
							web: [
								{
									title: "Private Firecrawl result",
									url: "https://firecrawl.example",
									description: "firecrawl",
								},
							],
						},
					}),
					{
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	resetSettingsForTest();
	tempAgentDir = TempDir.createSync("@omsp-search-cli-");
	setAgentDir(tempAgentDir.path());
	const settings = await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
	settings.setModelRole("web", "web/searxng");
	cfgSearxngEndpoint.set(settings, "http://searxng.internal");
	process.env.FIRECRAWL_BASE_URL = "http://firecrawl.internal";
	cfgRetryFallbackChains.set(settings, { web: [] });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	process.exitCode = originalExitCode;
	restoreEnv("OMSP_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMSP_PROFILE", originalOmpProfile);
	restoreEnv("OMSP_PROFILE", originalPiProfile);
	restoreEnv("FIRECRAWL_BASE_URL", originalFirecrawlBaseUrl);
	__resetDirsFromEnvForTests();
	// runSearchCommand opens <agentDir>/models.db; Windows cannot delete an open database.
	closeModelCache();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand model role settings", () => {
	it("honors modelRoles.web for the implicit request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "role selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("searxng.example");
		expect(plain).not.toContain("firecrawl.example");
	});

	it("treats --model as a one-shot override of modelRoles.web", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "explicit model override",
			model: "web/firecrawl",
			limit: 1,
			expanded: false,
		});

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("firecrawl.example");
		expect(plain).not.toContain("searxng.example");
	});
});
