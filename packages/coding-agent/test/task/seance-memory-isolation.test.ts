import { afterEach, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { seanceIsolationOptions } from "@oh-my-pi/pi-coding-agent/task/seance-policy";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

it("does not attach the live parent's Hindsight bank to an isolated historical session", async () => {
	using dir = TempDir.createSync("@omp-seance-memory-isolation-");
	const settings = Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.autoRetain": false,
		"hindsight.mentalModelsEnabled": false,
		"marketplace.autoUpdate": "off",
	});
	const model = createMockModel().model;
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime(model.provider, "test-key");
	const parentState = new HindsightSessionState({
		sessionId: "live-parent",
		client: new HindsightApi({ baseUrl: "http://memory.internal:8888" }),
		bankId: "live-private-bank",
		config: loadHindsightConfig(settings),
		session: {} as AgentSession,
		banksSet: new Set(),
	});
	const start = vi.spyOn(hindsightBackend, "start");
	const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	let session: AgentSession | undefined;
	try {
		const parentCapabilities = { parentHindsightSessionState: parentState };
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			model,
			settings,
			sessionManager: SessionManager.inMemory(dir.path()),
			taskDepth: 1,
			agentName: "seance",
			toolNames: [],
			...parentCapabilities,
			...seanceIsolationOptions(dir.path()),
		});
		session = created.session;
		expect(session.getHindsightSessionState()).toBeUndefined();
		expect(start).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	} finally {
		await session?.dispose();
		parentState.dispose();
		authStorage.close();
	}
});
