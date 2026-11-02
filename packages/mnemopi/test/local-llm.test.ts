import { afterEach, describe, expect, it } from "bun:test";
import { createMockModel, registerMockApi } from "@oh-my-striped-pi/pi-ai/providers/mock";
import {
	CallableLlmBackend,
	resetHostLlmBackendForTests,
	setHostLlmBackend,
} from "@oh-my-striped-pi/pi-mnemopi/core/llm-backends";
import {
	buildHostPrompt,
	chunkMemoriesByBudget,
	cleanOutput,
	complete,
	llmAvailable,
	summarizeMemories,
} from "@oh-my-striped-pi/pi-mnemopi/core/local-llm";
import { Mnemopi } from "@oh-my-striped-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-striped-pi/pi-mnemopi/core/runtime-options";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

const OLD_ENV = { ...process.env };

const tempDirs: TempDir[] = [];

// Per-test SQLite path so `new Mnemopi(...)` never touches the shared default
// bank file. Full-workspace parallel runs otherwise contend on that single path
// and throw SQLITE_BUSY at initBeam once busy_timeout is exceeded (#9886).
function tempDbPath(): string {
	const tempDir = TempDir.createSync("@mnemopi-local-llm-");
	tempDirs.push(tempDir);
	return tempDir.join("mnemopi.db");
}

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	for (const tempDir of tempDirs.splice(0)) {
		tempDir.removeSync();
	}
});

registerMockApi();

describe("local LLM TypeScript port", () => {
	it("reports unavailable without an injected model or host backend", async () => {
		process.env.MNEMOPI_HOST_LLM_ENABLED = "false";
		expect(llmAvailable()).toBe(false);
		expect(await complete("Test prompt")).toBeNull();
	});

	it("removes leading reasoning blocks from injected summaries", async () => {
		const summary = await withMnemopiRuntimeOptions(
			{
				llm: {
					complete: () =>
						"<think>\nThe user requested a one-sentence summary.\n</think>\nMnemopi uses multilingual-e5-large.",
				},
			},
			() => summarizeMemories(["Mnemopi uses multilingual-e5-large."]),
		);
		expect(summary).toBe("Mnemopi uses multilingual-e5-large.");
	});

	it("preserves a literal think tag that follows real content", () => {
		expect(cleanOutput("The XML tag is <think>keep</think>")).toBe("The XML tag is <think>keep</think>");
	});

	it("uses the host backend and returns null on host miss", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		setHostLlmBackend(new CallableLlmBackend("host", () => "Host summary."));
		expect(llmAvailable()).toBe(true);
		expect(await summarizeMemories(["Memory one"])).toBe("Host summary.");

		setHostLlmBackend(new CallableLlmBackend("host", () => null));
		expect(await summarizeMemories(["Memory one"])).toBeNull();
	});

	it("renders host sleep prompt override without chat-template tokens", () => {
		process.env.MNEMOPI_SLEEP_PROMPT = "Write in German. Source={source}. Memories:\n{memories}";
		expect(buildHostPrompt(["User prefers tea"], "profile")).toBe(
			"Write in German. Source=profile. Memories:\n- User prefers tea",
		);
	});

	it("expands chunk budget when host backend will handle calls", () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_N_CTX = "32000";
		process.env.MNEMOPI_LLM_N_CTX = "2048";
		setHostLlmBackend(new CallableLlmBackend("host", () => "x"));
		const hostChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		resetHostLlmBackendForTests();
		const localChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		expect(hostChunks).toHaveLength(1);
		expect(localChunks).toHaveLength(0);
	});

	it("uses a constructor-scoped completion function", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		const memory = new Mnemopi({
			dbPath: tempDbPath(),
			llm: async (prompt, opts) => `fn:${prompt}:${opts?.maxTokens ?? 0}`,
		});
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("hello", 0.3));
			expect(text).toBe("fn:hello:2048");
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped pi-ai Model instance", async () => {
		const model = createMockModel({
			handler: () => ({ content: ["model summary"] }),
		});
		const memory = new Mnemopi({ dbPath: tempDbPath(), llm: model });
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBe("model summary");
		} finally {
			memory.close();
		}
	});

	it("honors enabled:false for injected models and completions", async () => {
		let calls = 0;
		const model = createMockModel({
			handler: () => {
				calls += 1;
				return { content: ["Must not be called"] };
			},
		});
		const complete = () => {
			calls += 1;
			return "Must not be called";
		};
		for (const llm of [{ model }, { complete }]) {
			const memory = new Mnemopi({ dbPath: tempDbPath(), llm: { ...llm, enabled: false } });
			try {
				const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => summarizeMemories(["hello"]));
				expect(result).toBeNull();
				expect(withMnemopiRuntimeOptions(memory.runtimeOptions, llmAvailable)).toBe(false);
			} finally {
				memory.close();
			}
		}
		expect(calls).toBe(0);
	});

	it("lets llm:false disable the host backend", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		setHostLlmBackend(new CallableLlmBackend("host", () => "Must not be called"));
		const memory = new Mnemopi({ dbPath: tempDbPath(), llm: false });
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("hello", 0.3));
			expect(text).toBeNull();
		} finally {
			memory.close();
		}
	});
});
