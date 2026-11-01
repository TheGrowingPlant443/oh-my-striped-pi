import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("memory backend settings visibility", () => {
	it("shows only the selected backend controls and hides them before settings initialize", async () => {
		const host = createSettingsHost();
		const backendEntries = ["hindsight.apiUrl", "sharpshooter.model", "mnemopi.llmMode"].map(path => {
			const entry = host.entries.find(candidate => candidate.path === path);
			if (!entry?.condition) throw new Error(`Missing memory UI condition: ${path}`);
			return entry;
		});
		for (const entry of backendEntries) expect(entry.condition!()).toBe(false);
		using dir = TempDir.createSync("@omp-memory-settings-ui-");
		const settings = await Settings.init({
			cwd: dir.path(),
			agentDir: dir.join("agent"),
			inMemory: true,
			configFiles: [],
		});
		for (const backend of ["off", "hindsight", "sharpshooter", "mnemopi"] as const) {
			cfgMemoryBackend.override(settings, backend);
			for (const entry of backendEntries) {
				expect(entry.condition!()).toBe(entry.path.startsWith(`${backend}.`));
			}
		}
	});
});
