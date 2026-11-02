import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { createMockModel } from "@oh-my-striped-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import {
	ExtensionRuntime,
	loadExtensionFromFactory,
} from "@oh-my-striped-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-striped-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RpcDictationController } from "@oh-my-striped-pi/pi-coding-agent/modes/rpc/rpc-dictation";
import { runRpcMode } from "@oh-my-striped-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import type { SttCallbacks, SttState, SttTarget } from "@oh-my-striped-pi/pi-coding-agent/stt";
import { EventBus } from "@oh-my-striped-pi/pi-coding-agent/utils/event-bus";
import { getTestModel } from "../helpers/model-fixtures";

// Real RPC dispatch with a scripted speech controller, without audio.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const model = getTestModel("github-copilot", candidate => candidate.api === "anthropic-messages");
authStorage.keys.setRuntime(model.provider, "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.registerCommand("dictation-new-session", {
			handler: async (_args, ctx) => {
				await ctx.newSession();
			},
		});
		pi.registerCommand("dictation-switch-session", {
			handler: async (args, ctx) => {
				await ctx.switchSession(args);
			},
		});
		pi.registerCommand("dictation-reload-session", {
			handler: async (_args, ctx) => {
				await ctx.reload();
			},
		});
		pi.on("session_switch", async (event, ctx) => {
			await Bun.write(
				path.join(cwd, "session-switch.json"),
				JSON.stringify({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }),
			);
		});
		pi.registerCommand("dictation-nested-session", {
			handler: async (_args, ctx) => {
				await ctx.newSession({
					setup: async () => {
						await ctx.newSession();
						await ctx.ui.confirm("Transition held", "Release the outer session change");
					},
				});
			},
		});
	},
	cwd,
	new EventBus(),
	runtime,
	"dictation-session-change",
);
const extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
const mock = createMockModel({ provider: model.provider, id: model.id, handler: () => ({ content: ["Done"] }) });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({
		"compaction.enabled": false,
		"stt.enabled": process.env.RPC_DISABLE_DICTATION !== "1",
	}),
	modelRegistry,
	extensionRunner,
});

class FakeDictationController implements RpcDictationController {
	state: SttState = "idle";
	#callbacks: SttCallbacks | undefined;
	#target: SttTarget | undefined;
	#cancelled = false;
	#startGate = Promise.withResolvers<void>();
	#closed = false;

	async start(target: SttTarget, callbacks: SttCallbacks): Promise<void> {
		this.#callbacks = callbacks;
		this.#target = target;
		if (process.env.RPC_SLOW_DICTATION) await this.#startGate.promise;
		if (this.#cancelled) return;
		this.state = "recording";
		callbacks.onStateChange("recording");
		target.setVolatileText("hello");
	}

	async stop(): Promise<void> {
		this.#cancelled = true;
		this.#startGate.resolve();
		if (this.state !== "recording") return;
		this.state = "transcribing";
		this.#callbacks?.onStateChange("transcribing");
		if (process.env.RPC_FAIL_DICTATION) {
			this.state = "idle";
			this.#callbacks?.onStateChange("idle");
			this.#callbacks?.showWarning("recognizer failed");
			return;
		}
		this.#target?.commitVolatileText("hello world");
		this.state = "idle";
		this.#callbacks?.onStateChange("idle");
	}

	dispose(): void {
		if (this.#closed) return;
		if (process.env.RPC_FAIL_DICTATION_DISPOSE) throw new Error("microphone cleanup failed");
		this.#closed = true;
		this.#cancelled = true;
		this.#startGate.resolve();
		fs.writeFileSync(path.join(cwd, "dictation-stopped.json"), JSON.stringify({ state: this.state }));
		this.state = "idle";
	}
}

await runRpcMode(session, {
	createDictationController: () => new FakeDictationController(),
});
