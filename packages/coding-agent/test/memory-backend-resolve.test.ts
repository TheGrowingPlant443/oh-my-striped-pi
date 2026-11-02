import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { createMemoryRuntimeContext, resolveMemoryBackend } from "@oh-my-striped-pi/pi-coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps memory off unless an available backend is selected", async () => {
		expect((await resolveMemoryBackend(Settings.isolated())).id).toBe("off");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "off" }))).id).toBe("off");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "local" }))).id).toBe("local");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "mnemopi" }))).id).toBe("mnemopi");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "hindsight" }))).id).toBe("hindsight");
		expect((await resolveMemoryBackend(Settings.isolated({ "memory.backend": "sharpshooter" }))).id).toBe(
			"sharpshooter",
		);
	});

	it("exposes inactive status when no session is available", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
	});

	it("reports local backend runtime status as writable (lessons) without structured search", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		await expect(memory.status()).resolves.toMatchObject({
			backend: "local",
			active: true,
			writable: true,
			searchable: false,
		});
		await expect(memory.search("project preference")).resolves.toMatchObject({
			backend: "local",
			count: 0,
		});
	});
});
