import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-striped-pi/pi-ai/registry";

const loginLiteLLM = getProviderDefinition("litellm")?.login;
if (!loginLiteLLM) throw new Error("LiteLLM login is not registered");

describe("LiteLLM login", () => {
	it("trims pasted proxy keys", async () => {
		const apiKey = await loginLiteLLM({ onPrompt: async () => " sk-litellm-test " });
		expect(apiKey).toBe("sk-litellm-test");
	});

	it("accepts an empty key for keyless proxy deployments", async () => {
		const apiKey = await loginLiteLLM({
			onPrompt: async prompt => {
				expect(prompt.allowEmpty).toBe(true);
				return "   ";
			},
		});
		expect(apiKey).toBe("");
	});
});
