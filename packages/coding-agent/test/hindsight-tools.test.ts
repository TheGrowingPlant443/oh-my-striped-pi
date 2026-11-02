import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-striped-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-striped-pi/pi-coding-agent/hindsight/config";
import type { HindsightSessionState } from "@oh-my-striped-pi/pi-coding-agent/hindsight/state";
import type { ToolSession } from "@oh-my-striped-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-striped-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-striped-pi/pi-coding-agent/tools/memory-reflect";
import { LearnTool } from "@oh-my-striped-pi/pi-coding-agent/tools/learn";
import { MemoryRetainTool } from "@oh-my-striped-pi/pi-coding-agent/tools/memory-retain";

afterEach(() => {
	vi.restoreAllMocks();
});

function harness() {
	const settings = Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.apiUrl": "http://memory.internal:8888",
	});
	const client = new HindsightApi({ baseUrl: "http://memory.internal:8888" });
	const enqueueRetain = vi.fn();
	const state = {
		client,
		bankId: "company-memory",
		config: loadHindsightConfig(settings),
		retainTags: ["project:company"],
		recallTags: ["project:company"],
		recallTagsMatch: "any",
		banksSet: new Set(["company-memory"]),
		enqueueRetain,
	} as unknown as HindsightSessionState;
	const session = { settings, getHindsightSessionState: () => state } as unknown as ToolSession;
	return { session, client, enqueueRetain };
}

describe("private Hindsight memory tools", () => {
	it("keeps backend off by default, admits configured Hindsight and rejects an explicitly empty endpoint", () => {
		const inactive = { settings: Settings.isolated() } as ToolSession;
		expect(MemoryRecallTool.createIf(inactive)).toBeNull();
		const disabled = {
			settings: Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" }),
		} as ToolSession;
		expect(MemoryRecallTool.createIf(disabled)).toBeNull();

		expect(MemoryReflectTool.createIf(disabled)).toBeNull();
		expect(MemoryRetainTool.createIf(disabled)).toBeNull();
		const { session } = harness();
		expect(MemoryRecallTool.createIf(session)).not.toBeNull();
		expect(MemoryReflectTool.createIf(session)).not.toBeNull();
		expect(MemoryRetainTool.createIf(session)).not.toBeNull();
	});
	it("queues autolearn lessons through Hindsight without reporting a completed server write", async () => {
		const { session, enqueueRetain } = harness();
		const enabled = {
			...session,
			settings: Settings.isolated({ "memory.backend": "hindsight", "autolearn.enabled": true }),
		};
		const tool = LearnTool.createIf(enabled);
		expect(tool).not.toBeNull();
		const result = await tool!.execute("lesson", {
			memory: "Preserve private deployment boundaries",
			context: "review",
		});
		expect(enqueueRetain).toHaveBeenCalledWith("Preserve private deployment boundaries", "review");
		expect(result.content).toEqual([{ type: "text", text: "Lesson queued for retention." }]);
	});

	it("forwards the project recall scope and caller cancellation and renders returned memories", async () => {
		const { session, client } = harness();
		const recall = vi
			.spyOn(client, "recall")
			.mockResolvedValue({ results: [{ text: "Use the private cluster", type: "world" }] });
		const controller = new AbortController();
		const result = await new MemoryRecallTool(session).execute("r", { query: "deployment" }, controller.signal);
		expect(recall).toHaveBeenCalledWith(
			"company-memory",
			"deployment",
			expect.objectContaining({ tags: ["project:company"], tagsMatch: "any", signal: controller.signal }),
		);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("Use the private cluster [world]") }),
		]);
	});

	it("queues retain items locally and rejects unsupported global scope before enqueueing", async () => {
		const { session, enqueueRetain } = harness();
		const tool = new MemoryRetainTool(session);
		await expect(tool.execute("r", { items: [{ content: "private decision", scope: "global" }] })).rejects.toThrow(
			"only available with the Mnemopi",
		);
		expect(enqueueRetain).not.toHaveBeenCalled();
		const result = await tool.execute("r", { items: [{ content: "private decision", context: "architecture" }] });
		expect(enqueueRetain).toHaveBeenCalledWith("private decision", "architecture");
		expect(result.details).toEqual({ count: 1 });
	});

	it("reflects through the configured bank without losing tag filtering", async () => {
		const { session, client } = harness();
		vi.spyOn(client, "createBank").mockResolvedValue({});
		const reflect = vi.spyOn(client, "reflect").mockResolvedValue({ text: "The private cluster is required." });
		const result = await new MemoryReflectTool(session).execute("r", { query: "why?", context: "deployment" });
		expect(reflect).toHaveBeenCalledWith(
			"company-memory",
			"why?",
			expect.objectContaining({ context: "deployment", tags: ["project:company"], tagsMatch: "any" }),
		);
		expect(result.content).toEqual([{ type: "text", text: "The private cluster is required." }]);
	});
});
