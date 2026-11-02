import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

describe("runtime provider credentials", () => {
	const provider = "github-copilot";
	const envName = "LOGIN_KEY_PRECEDENCE_TEST_KEY";
	let previousEnv: string | undefined;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	beforeEach(async () => {
		previousEnv = process.env[envName];
		delete process.env[envName];
		tempDir = TempDir.createSync("@runtime-provider-credentials-");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(() => {
		if (previousEnv === undefined) delete process.env[envName];
		else process.env[envName] = previousEnv;
		authStorage.close();
		tempDir.removeSync();
	});

	test("a retained provider runtime environment key remains an explicit override", async () => {
		process.env[envName] = "env-key";
		registry.registerProvider(provider, { apiKey: envName }, "ext://login-key-precedence");
		await authStorage.credentials.set(provider, { type: "api_key", key: "stored-key", source: "login" });
		expect(await registry.getApiKeyForProvider(provider)).toBe("env-key");
	});
});
