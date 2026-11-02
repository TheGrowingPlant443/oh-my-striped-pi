import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-striped-pi/pi-ai";
import { type Api, Effort, type Model } from "@oh-my-striped-pi/pi-ai";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { generateCommitMessage } from "@oh-my-striped-pi/pi-coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@oh-my-striped-pi/pi-coding-agent/utils/title-generator";

function getModelOrThrow(id: string) {
	return buildModel({
		id,
		name: id,
		provider: "company-messages",
		api: "anthropic-messages",
		baseUrl: "https://models.company.test/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	});
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: (_kind = "chat") => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	};
}

function createSettings(modelRoles: Record<string, string>) {
	return Settings.isolated({ modelRoles });
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes smol-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:minimal",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Minimal,
			maxTokens: 1024,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({
			smol: `${model.provider}/${model.id}`,
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it("disables reasoning for title generation even when smol role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:low",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
