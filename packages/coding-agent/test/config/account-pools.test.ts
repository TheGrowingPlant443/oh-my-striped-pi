import { describe, expect, it } from "bun:test";
import { validateAgentAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentAccountPools } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("task.agentAccountPools", () => {
	it("keeps an empty provider list as a deny-all pool and lets null clear an agent", () => {
		expect(validateAgentAccountPools(undefined)).toEqual({});
		expect(validateAgentAccountPools(null)).toEqual({});
		expect(
			validateAgentAccountPools({
				reviewer: { "github-copilot": ["email:a@example.com|org:org-a"] },
				denied: { "github-copilot": [] },
				cleared: null,
			}),
		).toEqual({
			reviewer: { "github-copilot": ["email:a@example.com|org:org-a"] },
			denied: { "github-copilot": [] },
		});
	});

	it("preserves separate company provider namespaces and deny-all restrictions", () => {
		const pools = {
			reviewer: { "company-primary": ["email:a@example.com|org:org-a"], "company-secondary": [] },
		};
		expect(validateAgentAccountPools(pools)).toEqual(pools);
	});

	it("rejects every malformed level instead of widening the agent to all accounts", () => {
		const malformed: [unknown, string][] = [
			["reviewer", "Invalid task.agentAccountPools:"],
			[[], "Invalid task.agentAccountPools:"],
			[{ reviewer: ["email:a@example.com"] }, "Invalid task.agentAccountPools.reviewer:"],
			[
				{ reviewer: { "github-copilot": "email:a@example.com" } },
				"Invalid task.agentAccountPools.reviewer.github-copilot:",
			],
			[{ reviewer: { "github-copilot": null } }, "Invalid task.agentAccountPools.reviewer.github-copilot:"],
			[{ reviewer: { "github-copilot": [""] } }, "Invalid task.agentAccountPools.reviewer.github-copilot:"],
			[
				{ reviewer: { "github-copilot": [" email:a@example.com"] } },
				"Invalid task.agentAccountPools.reviewer.github-copilot:",
			],
			[{ reviewer: { "github-copilot": [42] } }, "Invalid task.agentAccountPools.reviewer.github-copilot:"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentAccountPools(value)).toThrow(message);
		}
	});

	it("fails settings load on a malformed pool", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentAccountPools": { reviewer: { "github-copilot": "email:a@example.com" } } },
			}),
		).rejects.toThrow("Invalid task.agentAccountPools.reviewer.github-copilot:");
	});

	it("keeps an agent named __proto__ restricted across settings layers", async () => {
		// YAML parses `__proto__` as an own key; layer merging and validation must keep it one.
		const tempDir = TempDir.createSync("@pi-account-pools-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  agentAccountPools:\n    __proto__:\n      github-copilot: []\n");
			const settings = await Settings.loadIsolated({
				inMemory: true,
				configFiles: [overlay],
				overrides: { "task.agentAccountPools": { reviewer: { "github-copilot": [] } } },
			});
			// Dispatch and revival read the pools through the validator.
			const pools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(settings));
			expect(Object.getOwnPropertyDescriptor(pools, "__proto__")?.value).toEqual({ "github-copilot": [] });
			expect(pools.reviewer).toEqual({ "github-copilot": [] });
		} finally {
			tempDir.removeSync();
		}
	});
});
