import { afterEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MODEL_ROLES, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { validateRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { getSearchEngineModel, getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import {
	DEFAULT_SEARCH_CHAIN,
	resolveSearchChain,
	resolveSearchRoleValue,
} from "@oh-my-pi/pi-coding-agent/web/search/selection";
import { resolveRoleAssignments } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const storages = new Set<AuthStorage>();
const originalBaseUrl = process.env.FIRECRAWL_BASE_URL;
const originalApiUrl = process.env.FIRECRAWL_API_URL;

function createRuntime(overrides: Parameters<typeof Settings.isolated>[0] = {}) {
	const authStorage = createInMemoryAuthStorage();
	storages.add(authStorage);
	const settings = Settings.isolated(overrides);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const pool = roleCandidatePool("web", settings, modelRegistry);
	return { authStorage, settings, modelRegistry, pool };
}

afterEach(() => {
	for (const authStorage of storages) authStorage.close();
	storages.clear();
	if (originalBaseUrl === undefined) delete process.env.FIRECRAWL_BASE_URL;
	else process.env.FIRECRAWL_BASE_URL = originalBaseUrl;
	if (originalApiUrl === undefined) delete process.env.FIRECRAWL_API_URL;
	else process.env.FIRECRAWL_API_URL = originalApiUrl;
});

describe("independent web role resolution", () => {
	it("resolves private search selectors without registering a model provider", () => {
		const { pool, settings, modelRegistry } = createRuntime();
		const descriptor = getSearchEngineModel("searxng");
		if (!descriptor) throw new Error("SearXNG descriptor missing");
		expect(resolveSearchRoleValue("web/searxng", settings).model).toBe(descriptor);
		expect(pool).toContain(descriptor);
		expect(modelRegistry.getAll("all").some(model => model.provider === "web")).toBe(false);
		expect(MODEL_ROLES.web.accepts(descriptor)).toBe(true);
		expect(MODEL_ROLES.web.accepts({ ...descriptor, id: "exa" })).toBe(false);
		expect(resolveModelRoleValue("web/searxng", modelRegistry.getAll("all"), { settings }).model).toBeUndefined();
	});

	it("rejects removed public selectors rather than substituting a private engine", () => {
		const { settings } = createRuntime();
		for (const id of [
			"parallel",
			"exa",
			"perplexity",
			"zai",
			"tinyfish",
			"jina",
			"kagi",
			"tavily",
			"brave",
			"deepseek",
			"kimi",
			"synthetic",
			"ollama",
			"duckduckgo",
			"startpage",
			"ecosia",
			"google",
			"mojeek",
			"public",
			"hosted",
			"missing",
		]) {
			expect(resolveSearchRoleValue(`web/${id}`, settings).model).toBeUndefined();
		}
	});

	it("preserves role aliases and ordered selector lists", () => {
		const { settings } = createRuntime({ modelRoles: { web: "@preferred", preferred: "web/missing,web/firecrawl" } });
		expect(resolveSearchRoleValue("@web", settings).model?.id).toBe("firecrawl");
	});

	it("marks configured primaries and configured fallbacks explicit", () => {
		const { settings } = createRuntime({
			modelRoles: { web: "web/firecrawl" },
			"retry.fallbackChains": { web: ["web/searxng"] },
		});
		expect(resolveSearchChain(settings).map(candidate => [candidate.model.id, candidate.explicit])).toEqual([
			["firecrawl", true],
			["searxng", true],
		]);
	});

	it("keeps the private default order and upgrades duplicate explicit candidates", () => {
		const { settings } = createRuntime({ "retry.fallbackChains": { web: ["web/searxng", "web/firecrawl"] } });
		expect(resolveSearchChain(Settings.isolated()).map(candidate => `web/${candidate.model.id}`)).toEqual(
			DEFAULT_SEARCH_CHAIN,
		);
		expect(resolveSearchChain(settings).map(candidate => [candidate.model.id, candidate.explicit])).toEqual([
			["searxng", true],
			["firecrawl", true],
		]);
	});

	it("respects an explicitly empty fallback chain", () => {
		const { settings } = createRuntime({ modelRoles: { web: "web/firecrawl" }, "retry.fallbackChains": { web: [] } });
		expect(resolveSearchChain(settings).map(candidate => candidate.model.id)).toEqual(["firecrawl"]);
	});

	it("validates private fallback selectors without consulting the model registry", () => {
		const { settings, modelRegistry } = createRuntime({
			"retry.fallbackChains": { web: ["web/firecrawl", "web/searxng", "web/missing"] },
		});
		const warnings: string[] = [];
		validateRetryFallbackChains(settings, modelRegistry, warning => warnings.push(warning));
		expect(warnings).toEqual(["Fallback chain for role 'web' does not resolve to a compatible model: web/missing"]);
	});

	it("offers web roles even when no model provider is available", () => {
		const { settings } = createRuntime({ modelRoles: { web: "web/searxng" } });
		const source = createModelBrowserSource(settings);
		const roles = resolveRoleAssignments(source, [], []);
		expect(roles.web?.model).toBe(getSearchEngineModel("searxng"));
		expect(source.roleCandidates?.("web")).toContain(getSearchEngineModel("firecrawl"));
		expect(source.roleCandidates?.("default")).toBeUndefined();
		expect(source.defaultRoleChain("web")).toEqual(DEFAULT_SEARCH_CHAIN);
	});
});

describe("private web candidate availability", () => {
	it("requires an explicit Firecrawl endpoint even with a credential and explicit selection", async () => {
		delete process.env.FIRECRAWL_BASE_URL;
		delete process.env.FIRECRAWL_API_URL;
		const { authStorage } = createRuntime();
		authStorage.keys.setRuntime("firecrawl", "private-key");
		const provider = await getSearchProvider("firecrawl");
		expect(await provider.isAvailable(authStorage)).toBe(false);
		expect(await provider.isExplicitlyAvailable(authStorage)).toBe(false);
	});

	it("admits explicitly configured keyless Firecrawl deployments", async () => {
		process.env.FIRECRAWL_BASE_URL = "http://firecrawl.internal:3002";
		const { authStorage } = createRuntime();
		const provider = await getSearchProvider("firecrawl");
		expect(await provider.isAvailable(authStorage)).toBe(true);
		expect(await provider.isExplicitlyAvailable(authStorage)).toBe(true);
	});
});
