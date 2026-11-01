import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { toProviderModelConfig } from "./helpers/model-fixtures";

import { cfgPrewalkEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";
const prewalkModels = ["company-primary", "company-secondary"].map(provider =>
	buildModel({
		id: "prewalk-chat",
		name: "Prewalk Chat",
		provider,
		api: "openai-completions",
		baseUrl: "https://models.company.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}),
);

// Regression for #6064: prewalk is an optional, off-by-default optimization.
// A missing key (or unresolvable target) for the prewalk hand-off model must
// leave prewalk unarmed with a warning, never abort startup and lock the user
// out of the app.
describe("prewalk startup degradation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-prewalk-repro-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		for (const model of prewalkModels) {
			modelRegistry.registerProvider(model.provider, {
				api: model.api,
				apiKey: "test-key",
				baseUrl: model.baseUrl,
				models: [toProviderModelConfig(model)],
			});
		}
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("leaves prewalk unarmed instead of crashing when the target has no configured auth", async () => {
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${prewalkModels[0]!.provider}/${prewalkModels[0]!.id}`);
		// Exercise a resolvable private target, independent of ambient credentials.
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk).toBeUndefined();
	});

	test("arms prewalk when the target resolves and has configured auth", async () => {
		const model = prewalkModels[0]!;
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test("skips a disabled provider and arms the next enabled prewalk candidate", async () => {
		const disabled = prewalkModels[0]!;
		const enabled = prewalkModels[1]!;
		const settings = Settings.isolated({ disabledProviders: [disabled.provider] });
		authStorage.keys.setRuntime(disabled.provider, "test-key");
		authStorage.keys.setRuntime(enabled.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--prewalk-into", `${disabled.provider}/${disabled.id},${enabled.provider}/${enabled.id}`]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(enabled.provider);
		expect(options.prewalk?.target.id).toBe(enabled.id);
	});

	test("does not implicitly re-arm configured prewalk while restoring a session", async () => {
		const model = prewalkModels[0]!;
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		for (const args of [parseArgs(["--continue"]), parseArgs(["--resume=session.jsonl"])]) {
			const options = await buildSessionOptions(args, [], SessionManager.inMemory(), modelRegistry, settings);
			expect(options.prewalk).toBeUndefined();
		}
	});

	test("honors an explicit prewalk flag while restoring a session", async () => {
		const model = prewalkModels[0]!;
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--continue", "--prewalk"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});
});
