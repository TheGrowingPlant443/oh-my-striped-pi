import { afterEach, describe, expect, test } from "bun:test";
import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createSerializedRebuilder,
	gatewayRoutableModels,
	gatewayRoutableProviders,
	indexModelsByRequestId,
	resolveGatewayModel,
} from "../../src/cli/auth-gateway-cli";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { getTestModel } from "../helpers/model-fixtures";

const authStores: AuthStorage[] = [];

async function createAuthStorage(): Promise<AuthStorage> {
	const storage = await AuthStorage.create(":memory:");
	authStores.push(storage);
	return storage;
}

afterEach(() => {
	for (const storage of authStores.splice(0)) storage.close();
});

/** A served chat model, built through the catalog rules like discovery output. */
function servedModel(provider: string, id: string, api: Api): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://models.company.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

describe("indexModelsByRequestId (auth-gateway catalog)", () => {
	test("resolves a discovery-only model absent from the bundled catalog", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		// Simulate a model reached via provider discovery but not compiled into
		// the bundle (e.g. a post-release id). registerProvider merges it into
		// getAll() exactly as runtime discovery does.
		registry.registerProvider("company-discovery", {
			baseUrl: "https://models.company.test/v1",
			api: "anthropic-messages",
			apiKey: "test-key",
			models: [
				{
					id: "claude-opus-5-repro",
					name: "Claude Opus 5 (repro)",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		expect(getBundledModels("company-discovery").map(m => m.id)).not.toContain("claude-opus-5-repro");

		const index = indexModelsByRequestId(registry.getAll(), new Set(["company-discovery"]));

		// The gateway can now resolve it by qualified id and bare id — was
		// "Unknown model" when the index was built from getBundledModels only.
		expect(resolveGatewayModel("company-discovery/claude-opus-5-repro", index)?.id).toBe("claude-opus-5-repro");
		expect(resolveGatewayModel("claude-opus-5-repro", index)?.id).toBe("claude-opus-5-repro");
	});

	test("gateway registry ignores local models.yml credential and routing overrides", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const modelsPath = tempDir.join("models.yml");
		// Keep credential overrides and pi-native self-routes in separate company namespaces.
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  company-direct:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    api: openai-completions",
				"    models:",
				"      - id: direct-chat",
				"  company-native:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    transport: pi-native",
				"    api: openai-completions",
				"    models:",
				"      - id: native-chat",
				"",
			].join("\n"),
		);

		// A normal client registry applies the local overrides and installs the
		// config API keys into AuthStorage.
		const clientAuthStorage = await createAuthStorage();
		const clientRegistry = new ModelRegistry(clientAuthStorage, modelsPath);
		expect(clientRegistry.find("company-direct", "direct-chat")?.baseUrl).toBe("http://127.0.0.1:18899");
		expect(clientRegistry.find("company-native", "native-chat")?.transport).toBe("pi-native");
		expect(await clientAuthStorage.keys.get("company-direct")).toBe("gateway-token");

		// The gateway registry ignores models.yml entirely: bundled routing wins,
		// no config key reaches AuthStorage, and no pi-native self-route survives.
		const gatewayAuthStorage = await createAuthStorage();
		const gatewayRegistry = new ModelRegistry(gatewayAuthStorage, modelsPath, {
			ignoreLocalModelConfig: true,
		});
		const bundledModel = getTestModel("github-copilot");
		const gatewayModel = gatewayRegistry.find(bundledModel.provider, bundledModel.id);
		if (!gatewayModel) throw new Error("expected retained bundled model");

		expect(gatewayModel.baseUrl).toBe(bundledModel.baseUrl);
		expect(gatewayRegistry.find("company-direct", "direct-chat")).toBeUndefined();
		expect(gatewayRegistry.find("company-native", "native-chat")).toBeUndefined();
		expect(await gatewayAuthStorage.keys.get("company-direct")).not.toBe("gateway-token");
		expect(await gatewayAuthStorage.keys.get("company-native")).not.toBe("gateway-token");
		const gatewayIndex = indexModelsByRequestId(gatewayRegistry.getAll(), new Set([bundledModel.provider]));
		expect(resolveGatewayModel(gatewayModel.id, gatewayIndex)).toBe(gatewayModel);
	});

	test("scopes the catalog to providers with credentials", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const companyModel = servedModel("company-primary", "company-chat", "openai-completions");
		registry.registerProvider(companyModel.provider, {
			baseUrl: companyModel.baseUrl,
			api: companyModel.api,
			apiKey: "company-key",
			models: [{ ...companyModel, contextWindow: 200_000, maxTokens: 8192 }],
		});
		const foreignModel = getTestModel("github-copilot");
		const index = indexModelsByRequestId(registry.getAll(), new Set([companyModel.provider]));

		expect(resolveGatewayModel(`${companyModel.provider}/${companyModel.id}`, index)).toBeDefined();
		expect(resolveGatewayModel(`${foreignModel.provider}/${foreignModel.id}`, index)).toBeUndefined();
	});

	test("drops providers disabled in settings from the served catalog", async () => {
		const storage = await createAuthStorage();
		await storage.credentials.set("company-primary", { type: "api_key", key: "primary-key" });
		await storage.credentials.set("company-secondary", { type: "api_key", key: "secondary-key" });
		const settings = Settings.isolated({ disabledProviders: ["company-secondary"] });
		const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true, settings });
		for (const provider of ["company-primary", "company-secondary"]) {
			const model = servedModel(provider, "company-chat", "openai-completions");
			registry.registerProvider(provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				apiKey: `${provider}-key`,
				models: [{ ...model, contextWindow: 200_000, maxTokens: 8192 }],
			});
		}

		const routable = gatewayRoutableProviders(storage, settings);
		const index = indexModelsByRequestId(gatewayRoutableModels(registry), routable);

		expect([...routable].sort()).toEqual(["company-primary"]);
		expect(index.models.some(model => model.provider === "company-secondary")).toBe(false);
		expect(index.models.some(model => model.provider === "company-primary")).toBe(true);
	});

	test("serves judge-kind models alongside chat and keeps unrouted kinds out", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const judge = buildModel({
			...servedModel("company-judge", "judge-latest", "openai-decisions"),
			kind: "judge",
		});
		registry.registerProvider(judge.provider, {
			baseUrl: judge.baseUrl,
			api: judge.api,
			apiKey: "judge-key",
			models: [
				{ ...judge, contextWindow: 200_000, maxTokens: 8192 },
				{
					...servedModel(judge.provider, "company-chat", "openai-completions"),
					contextWindow: 200_000,
					maxTokens: 8192,
				},
			],
		});
		const tiny = buildModel({
			...servedModel("company-tiny", "tiny-chat", "local-inference"),
			kind: "tiny",
		});
		registry.registerProvider(tiny.provider, {
			baseUrl: tiny.baseUrl,
			api: tiny.api,
			auth: "none",
			models: [{ ...tiny, contextWindow: 200_000, maxTokens: 8192 }],
		});
		expect(registry.getAll("tiny").some(model => model.provider === tiny.provider)).toBe(true);
		const routable = gatewayRoutableModels(registry);
		expect(registry.getAll().some(model => model.provider === judge.provider && model.id === judge.id)).toBe(false);

		const index = indexModelsByRequestId(routable, new Set([judge.provider, tiny.provider]));

		expect(resolveGatewayModel("company-judge/judge-latest", index)?.api).toBe(judge.api);
		expect(resolveGatewayModel("judge-latest", index)?.provider).toBe(judge.provider);
		expect(resolveGatewayModel("company-chat", index)?.api).toBe("openai-completions");
		// Tiny on-device models have no gateway route and are not advertised.
		expect(index.models.some(model => modelKind(model) === "tiny")).toBe(false);
	});
});

describe("resolveGatewayModel", () => {
	// Retained Copilot ranks ahead of explicit company namespaces by default.
	const preferred = getTestModel("github-copilot");
	const alpha = servedModel("company-alpha", preferred.id, "openai-completions");
	const beta = servedModel("company-beta", preferred.id, "anthropic-messages");
	const gamma = servedModel("company-gamma", preferred.id, "openai-completions");
	const catalog = [alpha, gamma, beta, preferred];
	const credentialed = new Set(catalog.map(model => model.provider));

	test("a bare id resolves to the highest-priority provider whatever order the catalog lists it in", () => {
		// A discovery refresh re-appends a provider's models at the catalog's end; a bare id
		// used to follow that order and land on whichever mirror stayed in front.
		for (const order of [catalog, [...catalog].reverse()]) {
			const index = indexModelsByRequestId(order, credentialed);
			expect(resolveGatewayModel(preferred.id, index)).toBe(preferred);
			// The route's wire never outranks provider priority.
			expect(resolveGatewayModel(preferred.id, index, { api: "openai-completions" })).toBe(preferred);
		}
	});

	test("the configured provider order outranks the built-in one", () => {
		const index = indexModelsByRequestId(catalog, credentialed, ["company-gamma"]);
		expect(resolveGatewayModel(preferred.id, index)).toBe(gamma);
	});

	test("among equally ranked providers a bare id prefers the route's wire, then provider id", () => {
		const index = indexModelsByRequestId(catalog, credentialed);
		const unranked = { accepts: (model: Model<Api>) => model !== preferred };
		expect(resolveGatewayModel(preferred.id, index, unranked)).toBe(alpha);
		expect(resolveGatewayModel(preferred.id, index, { ...unranked, api: "anthropic-messages" })).toBe(beta);
		expect(resolveGatewayModel(preferred.id, index, { ...unranked, api: "openai-completions" })).toBe(alpha);
	});

	test("a refused provider/id never resolves to another provider's bare id spelled the same way", () => {
		const direct = servedModel("company-direct", "shared-chat", "anthropic-messages");
		const aggregated = servedModel("company-mirror", "company-direct/shared-chat", "openai-completions");
		const index = indexModelsByRequestId([direct, aggregated], new Set(["company-direct", "company-mirror"]));
		expect(resolveGatewayModel("company-direct/shared-chat", index)).toBe(direct);
		expect(
			resolveGatewayModel("company-direct/shared-chat", index, { accepts: model => model !== direct }),
		).toBeUndefined();
	});
});

describe("createSerializedRebuilder", () => {
	// Deferred `run` gate so tests drive completion without wall-clock timers.
	function makeRun() {
		const calls: boolean[] = [];
		const gates: PromiseWithResolvers<void>[] = [];
		const run = (force: boolean): Promise<void> => {
			calls.push(force);
			const gate = Promise.withResolvers<void>();
			gates.push(gate);
			return gate.promise;
		};
		return { calls, gates, run };
	}
	// Flush queued microtasks so a resolved gate lets the serialized loop advance.
	async function flush(): Promise<void> {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	}

	test("runs a forced pass when a forced rebuild is requested mid-flight", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		expect(calls).toEqual([false]);

		// A credential-triggered forced rebuild arrives while the cached pass runs.
		rebuild(true);
		expect(calls).toEqual([false]); // coalesced, not started yet

		gates[0].resolve();
		await flush();
		// The forced follow-up pass must run so the account change is not missed.
		expect(calls).toEqual([false, true]);

		gates[1].resolve();
		await first;
		expect(calls).toEqual([false, true]);
	});

	test("coalesces a non-forced rebuild without an extra pass", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		rebuild(false); // coalesces onto the in-flight pass
		expect(calls).toEqual([false]);

		gates[0].resolve();
		await first;
		expect(calls).toEqual([false]); // no redundant follow-up
	});
});
