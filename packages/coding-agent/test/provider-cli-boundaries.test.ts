import { afterEach, describe, expect, test, vi } from "bun:test";
import { runLoginCommand } from "@oh-my-pi/pi-coding-agent/cli/login-cli";
import AuthBroker from "@oh-my-pi/pi-coding-agent/commands/auth-broker";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const config: CliConfig = { bin: "omp", version: "test", commands: new Map() };

afterEach(() => vi.restoreAllMocks());

describe("CLI model provider boundaries", () => {
	for (const provider of ["ollama", "llama.cpp", "lm-studio", "vllm", "litellm", "company-provider"]) {
		test(`allows ${provider} credential administration to reach its configured store`, async () => {
			const discover = vi.spyOn(sdk, "discoverAuthStorage").mockRejectedValue(new Error("credential store reached"));
			const settings = vi.spyOn(Settings, "init").mockRejectedValue(new Error("settings reached"));
			await expect(runLoginCommand(provider)).rejects.toThrow("settings reached");
			await expect(new Token([provider], config).run()).rejects.toThrow("credential store reached");
			expect(discover).toHaveBeenCalled();
			expect(settings).toHaveBeenCalled();
		});
	}

	test("rejects the removed CLIProxy import subcommand", async () => {
		await expect(new AuthBroker(["import", "/tmp/credentials"], config).parse(AuthBroker)).rejects.toThrow(/import/);
	});
});
