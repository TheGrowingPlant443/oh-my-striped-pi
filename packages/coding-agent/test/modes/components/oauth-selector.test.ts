import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders, registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-striped-pi/pi-ai/oauth";
import { resetSettingsForTest, Settings, settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { OAuthSelectorComponent } from "@oh-my-striped-pi/pi-tui/overlays/oauth-selector";
import { initTheme } from "@oh-my-striped-pi/pi-tui/theme";
import type { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";

import { cfgDisabledProviders } from "@oh-my-striped-pi/pi-coding-agent/config/model-settings";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	credentials: { has: (_providerId: string) => false },
	keys: { source: (_providerId: string) => undefined },
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.map(provider => provider.id).sort()).toEqual([
			"github-copilot",
			"litellm",
			"llama.cpp",
			"lm-studio",
			"ollama",
			"vllm",
		]);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);
		component.setMaxHeight(6);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("does not offer env-only providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (_providerId: string) => false },
				keys: {
					source: (providerId: string) => (providerId === "vllm" ? { kind: "env", concrete: true } : undefined),
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "vllm") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("No stored provider credentials to log out");

		component.handleInput("\n");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (providerId: string) => providerId === "vllm" },
				keys: {
					source: (providerId: string) =>
						providerId === "vllm" ? { kind: "api_key", concrete: true } : undefined,
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "vllm") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("vLLM");
		expect(rendered).toContain("logged in");

		component.handleInput("\n");
		expect(selected).toEqual(["vllm"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides custom alias logins whose credential target is disabled", async () => {
			registerOAuthProvider({
				id: "company-alias",
				name: "Company sign-in",
				storeCredentialsAs: "vllm",
				login: async () => "test-key",
			});
			try {
				resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { disabledProviders: ["vllm"] } });
				const selected: string[] = [];
				const component = new OAuthSelectorComponent(
					"login",
					authStorage,
					providerId => selected.push(providerId),
					() => {},
					{ disabledProviders: cfgDisabledProviders.get(settings) },
				);
				for (const char of "company-alias") component.handleInput(char);
				component.handleInput("\n");
				// Enter lands on whatever fuzzy-matches the query; the hidden alias must not be it.
				expect(selected).not.toContain("company-alias");
				expect(Bun.stripANSI(component.render(80).join("\n"))).not.toContain("Company sign-in");
			} finally {
				unregisterOAuthProvider("company-alias");
			}
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["vllm"] } });

			const selected: string[] = [];
			const component = new OAuthSelectorComponent(
				"logout",
				{
					credentials: { has: (providerId: string) => providerId === "vllm" },
					keys: {
						source: (providerId: string) =>
							providerId === "vllm" ? { kind: "api_key", concrete: true } : undefined,
					},
				} as unknown as AuthStorage,
				providerId => selected.push(providerId),
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of "vllm") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("vLLM");
		});
	});
});
