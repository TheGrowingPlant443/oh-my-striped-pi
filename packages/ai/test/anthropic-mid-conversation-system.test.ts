import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-striped-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	DeveloperMessage,
	Message,
	Model,
	ModelSpec,
	UserMessage,
} from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";

/** Explicit mid-conversation-system overrides must still respect placement and attribution. */

function makeModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "github-copilot",
		id: "claude-opus-4-8-20260528",
		name: "Claude Opus 4.8",
		baseUrl: "https://api.githubcopilot.com",
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		maxTokens: 64000,
		contextWindow: 1000000,
		reasoning: true,
		compat: { supportsMidConversationSystem: true },
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function developer(text: string): DeveloperMessage {
	return { role: "developer", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string, model: Model<"anthropic-messages">): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Anthropic mid-conversation system messages", () => {
	it("maps a trailing developer message after a user turn to role: system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages([user("review utils.py"), developer("Use parameterized SQL.")], model);

		expect(params.map(p => p.role)).toEqual(["user", "system"]);
		const sys = params[1];
		expect(sys.role).toBe("system");
		// A single text block collapses to a plain string, same as a user turn.
		expect(sys.content).toBe("Use parameterized SQL.");
		// A trailing system message is a valid final entry; no synthetic Continue.
		expect(params.at(-1)?.role).toBe("system");
	});

	it("keeps developer turns carrying image content as user messages", () => {
		const model = makeModel({ input: ["text", "image"] });
		const visualDeveloper: DeveloperMessage = {
			role: "developer",
			content: [
				{ type: "text", text: "Match this reference design." },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		};
		const params = convertAnthropicMessages([user("hi"), visualDeveloper], model);
		// Placement qualifies (follows user, last entry), but system content is
		// text-only on the wire — the image-bearing turn must stay role: user.
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("maps a developer message that precedes an assistant turn to role: system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages([user("hi"), developer("Be terse."), assistant("ok", model)], model);
		// A trailing assistant turn appends the synthetic "Continue." user turn,
		// so assert the upgraded slot directly rather than the whole array.
		expect(params[0]?.role).toBe("user");
		expect(params[1]?.role).toBe("system");
		expect(params[2]?.role).toBe("assistant");
	});

	it("keeps a developer message following an assistant turn as user (must follow a user turn)", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("hi"), assistant("hello", model), developer("Switch to German.")],
			model,
		);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user"]);
		expect(params.at(-1)?.content).toBe("Switch to German.");
	});

	it("keeps user-attributed developer turns on the user role (#15881)", () => {
		const model = makeModel();
		const fileMention: DeveloperMessage = {
			...developer('<file path="report.md">\n1:# Report\n</file>'),
			attribution: "user",
		};
		const extensionStatus: DeveloperMessage = {
			...developer("[extension] status=disconnected"),
			attribution: "user",
		};
		// User-supplied context must not gain system authority or end the request
		// in place of the user's turn.
		expect(convertAnthropicMessages([user("@report.md polish this"), fileMention], model).map(p => p.role)).toEqual([
			"user",
			"user",
		]);
		expect(
			convertAnthropicMessages([user("@report.md polish this"), fileMention, extensionStatus], model).map(
				p => p.role,
			),
		).toEqual(["user", "user", "user"]);
		// An agent-owned reminder after the user-supplied context is still upgraded.
		const reminder: DeveloperMessage = { ...developer("Track multi-step work."), attribution: "agent" };
		expect(
			convertAnthropicMessages([user("@report.md polish this"), fileMention, reminder], model).map(p => p.role),
		).toEqual(["user", "user", "system"]);
	});

	it("never emits a developer message in the first position as system", () => {
		const model = makeModel();
		const params = convertAnthropicMessages([developer("Global rule."), user("hi")], model);
		// First entry cannot be a system message; followed by user, not assistant.
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});

	it("upgrades only the trailing developer message in a consecutive run", () => {
		const model = makeModel();
		const params = convertAnthropicMessages(
			[user("hi"), developer("Rule A."), developer("Rule B."), assistant("ok", model)],
			model,
		);
		// Consecutive system messages are not allowed; the first stays user, only
		// the trailing developer (before the assistant turn) is upgraded.
		expect(params[1]?.role).toBe("user");
		expect(params[2]?.role).toBe("system");
		expect(params[3]?.role).toBe("assistant");
	});

	it("upgrades a developer message that follows tool results (a user-role param)", () => {
		const model = makeModel();
		const messages: Message[] = [
			user("run the build"),
			{
				...assistant("", model),
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "build" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
			developer("Treat failures as fatal."),
		];
		const params = convertAnthropicMessages(messages, model);
		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user", "system"]);
	});

	it("honors an explicit compat override on an otherwise-unsupported model", () => {
		const model = makeModel({
			id: "claude-sonnet-4-6-20260217",
			name: "Claude Sonnet 4.6",
			compat: { supportsMidConversationSystem: true },
		});
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model);
		expect(params.map(p => p.role)).toEqual(["user", "system"]);
	});

	it("honors an explicit compat override disabling the feature on Opus 4.8", () => {
		const model = makeModel({ compat: { supportsMidConversationSystem: false } });
		const params = convertAnthropicMessages([user("hi"), developer("Be terse.")], model);
		expect(params.map(p => p.role)).toEqual(["user", "user"]);
	});
});
