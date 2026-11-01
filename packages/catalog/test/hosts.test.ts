import { describe, expect, test } from "bun:test";
import { hostMatchesUrl, modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";

describe("hostMatchesUrl", () => {
	test("matches Copilot and enterprise URLs case-insensitively", () => {
		for (const url of [
			"https://api.githubcopilot.com",
			"https://API.GITHUBCOPILOT.COM/v1",
			"https://copilot-api.example.ghe.com",
		]) {
			expect(hostMatchesUrl(url, "githubCopilot")).toBe(true);
		}
		expect(hostMatchesUrl("https://example.com/v1", "githubCopilot")).toBe(false);
		expect(hostMatchesUrl(undefined, "githubCopilot")).toBe(false);
	});

	test("repeated and evicted cache entries preserve host classification", () => {
		for (let index = 0; index < 520; index++) {
			expect(hostMatchesUrl(`https://proxy.example/${index}/githubcopilot.com`, "githubCopilot")).toBe(true);
			expect(hostMatchesUrl(`https://proxy.example/${index}`, "githubCopilot")).toBe(false);
		}
		expect(hostMatchesUrl("https://API.GITHUBCOPILOT.COM/v1", "githubCopilot")).toBe(true);
	});
});

describe("modelMatchesHost", () => {
	test("matches either the Copilot provider id or a Copilot URL", () => {
		expect(modelMatchesHost({ provider: "github-copilot", baseUrl: "https://example.com/v1" }, "githubCopilot")).toBe(
			true,
		);
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://api.githubcopilot.com" }, "githubCopilot")).toBe(
			true,
		);
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://example.com/v1" }, "githubCopilot")).toBe(false);
	});
});
