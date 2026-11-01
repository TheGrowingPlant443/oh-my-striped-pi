import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

function spec(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "anthropic--claude-4.6-opus",
		name: "Claude 4.6 Opus via proxy",
		provider: "my-proxy",
		baseUrl: "http://localhost:6655/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("#4297 anthropic-messages replay-unsigned-thinking classification", () => {
	it("keeps native replay on opaque custom reasoning endpoints (no name detection)", () => {
		// The reporter's custom Claude proxy is indistinguishable from a
		// non-signing third-party reasoning endpoint at config time — the
		// default must not walk back #2005's native replay for the 3p
		// majority.
		expect(resolveModelPolicy(spec()).compat.replayUnsignedThinking).toBe(true);
	});

	it("keeps native replay on a Cloudflare-internal Claude gateway that is not the AI Gateway route", () => {
		// `opencode.cloudflare.dev/anthropic` (issue #4297 comment) is a
		// private Cloudflare Workers deployment, not `gateway.ai.cloudflare.com`.
		// Opaque custom signing proxy — user marks it with the compat override
		// and the transport surfaces the actionable error before then.
		expect(
			resolveModelPolicy(
				spec({
					id: "cf-anthropic/claude-opus-4-8",
					name: "Claude Opus 4.8",
					provider: "cf-anthropic",
					baseUrl: "https://opencode.cloudflare.dev/anthropic",
				}),
			).compat.replayUnsignedThinking,
		).toBe(true);
	});

	it("honors explicit `compat.replayUnsignedThinking: false` on custom signing proxies", () => {
		expect(
			resolveModelPolicy(spec({ compat: { replayUnsignedThinking: false } })).compat.replayUnsignedThinking,
		).toBe(false);
	});

	it("still demotes unsigned thinking on non-reasoning custom endpoints", () => {
		expect(resolveModelPolicy(spec({ reasoning: false })).compat.replayUnsignedThinking).toBe(false);
	});
});
