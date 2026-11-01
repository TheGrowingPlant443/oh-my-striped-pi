import { afterEach, describe, expect, test, vi } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createCustomMessage,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	NativeCompactionError,
	prepareCompaction,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	buildCompactionV2Request,
	buildOpenAiNativeHistory,
	CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
	countResponsesHistoryTokens,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseCompactionV2Streaming,
	shouldUseOpenAiRemoteCompaction,
	trimRemoteCompactionInputToContextWindow,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as ai from "@oh-my-pi/pi-ai";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/auth-retry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as piUtils from "@oh-my-pi/pi-utils";

const { isRecord } = piUtils;

afterEach(() => {
	vi.restoreAllMocks();
});

function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://compact.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		remoteCompaction: { enabled: true },
		...overrides,
	});
}

test("requires explicit remote protocol opt-in for Copilot", () => {
	const model = makeOpenAiModel({ remoteCompaction: undefined });
	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(false);
	expect(shouldUseCompactionV2Streaming(model)).toBe(false);
	expect(shouldUseOpenAiRemoteCompaction(makeOpenAiModel())).toBe(true);
	expect(shouldUseCompactionV2Streaming(makeOpenAiModel({ remoteCompaction: { v2StreamingEnabled: true } }))).toBe(
		true,
	);
});

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("buildOpenAiNativeHistory custom tool calls", () => {
	test("serializes customWireName tool calls as custom_tool_call + custom_tool_call_output", () => {
		const patch = "*** Begin Patch\n*** End Patch\n";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_apply_1|ctc_apply_1",
					name: "edit",
					arguments: { input: patch },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "github-copilot",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_apply_1|ctc_apply_1",
			toolName: "edit",
			content: [{ type: "text", text: "patch applied" }],
			isError: false,
			timestamp: Date.now(),
		};

		const items = buildOpenAiNativeHistory([assistant, toolResult], makeOpenAiModel());

		const call = items.find(item => item.type === "custom_tool_call");
		expect(call).toBeDefined();
		expect(call?.name).toBe("apply_patch");
		expect(call?.input).toBe(patch);
		expect(call?.call_id).toBe("call_apply_1");

		const output = items.find(item => item.type === "custom_tool_call_output");
		expect(output).toBeDefined();
		expect(output?.call_id).toBe("call_apply_1");
		expect(output?.output).toBe("patch applied");

		// Did NOT emit the legacy function_call / function_call_output pair.
		expect(items.find(item => item.type === "function_call")).toBeUndefined();
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("continues to emit function_call for regular JSON tools", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read_1|fc_read_1",
					name: "read_file",
					arguments: { path: "/tmp/x" },
				},
			],
			timestamp: Date.now(),
			provider: "github-copilot",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		expect(items.find(item => item.type === "function_call")).toBeDefined();
		expect(items.find(item => item.type === "custom_tool_call")).toBeUndefined();
	});

	test("preserves bigint tool arguments as exact decimal strings", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_lookup_1|fc_lookup_1",
					name: "lookup",
					arguments: { rowId: 9_007_199_254_740_993n },
				},
			],
			timestamp: Date.now(),
			provider: "github-copilot",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};

		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		const call = items.find(item => item.type === "function_call");

		expect(call?.arguments).toBe('{"rowId":"9007199254740993"}');
	});
});

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Responses carries native API items on `providerPayload`. The history
// builder reads call ids from there (not the message content blocks), so each
// turn pairs a content `toolCall` (kept by `transformMessages` so the matching
// result survives) with a `providerPayload` function/custom call of the same id.
// `dt: true` appends to the running history; `dt: false` is a full snapshot that
// replaces it.
const RESPONSES_MODEL = makeOpenAiModel({ provider: "github-copilot" });

function responsesAssistant(calls: Array<{ callId: string; custom?: boolean }>, dt: boolean): AssistantMessage {
	const content = calls.map(c => ({
		type: "toolCall" as const,
		id: `${c.callId}|${c.custom ? "ctc" : "fc"}_${c.callId}`,
		name: c.custom ? "edit" : "read",
		arguments: c.custom ? { input: "p" } : {},
		...(c.custom ? { customWireName: "apply_patch" } : {}),
	}));
	const items = calls.map(c =>
		c.custom
			? {
					type: "custom_tool_call",
					id: `ctc_${c.callId}`,
					call_id: c.callId,
					name: "apply_patch",
					input: "p",
					status: "completed",
				}
			: {
					type: "function_call",
					id: `fc_${c.callId}`,
					call_id: c.callId,
					name: "read",
					arguments: "{}",
					status: "completed",
				},
	);
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "github-copilot",
		model: "gpt-5",
		api: "openai-responses",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "github-copilot",
			...(dt ? { dt: true } : {}),
			items,
		},
	} as unknown as AssistantMessage;
}

function toolResultFor(callId: string, custom = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${callId}|${custom ? "ctc" : "fc"}_${callId}`,
		toolName: custom ? "edit" : "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("buildOpenAiNativeHistory multimodal tool results", () => {
	test("encodes ReadTool images inside the native function output", () => {
		const imageData = Buffer.from("read image").toString("base64");
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_image|fc_call_image",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
			],
			isError: false,
			timestamp: Date.now(),
		};
		const model = makeOpenAiModel({ provider: "github-copilot", input: ["text", "image"] });

		const items = buildOpenAiNativeHistory(
			[responsesAssistant([{ callId: "call_image" }], true), result],
			model,
			undefined,
			true,
		);

		const output = items.find(item => item.type === "function_call_output");
		expect(output?.output).toEqual([
			{ type: "input_text", text: "Read image file [image/png]" },
			{
				type: "input_image",
				detail: "original",
				image_url: `data:image/png;base64,${imageData}`,
			},
		]);
		expect(items.some(item => item.type === "message" && item.role === "user")).toBe(false);
	});
});

describe("buildOpenAiNativeHistory interleaved assistant message (#8789)", () => {
	test("hoists a trailing text block before its tool-call batch", () => {
		// Interleaved thinking, calls and trailing text must not split a tool batch.
		const model = makeOpenAiModel({
			id: "deepseek-v4-flash",
			provider: "github-copilot",
			baseUrl: "http://127.0.0.1:8000/v1",
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "planning" },
				{ type: "toolCall", id: "call_a|fc_call_a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call_b|fc_call_b", name: "read", arguments: { path: "b" } },
				{ type: "text", text: "<think>\n</thinking\n</think>" },
			],
			timestamp: Date.now(),
			provider: "github-copilot",
			model: "deepseek-v4-flash",
			api: "openai-responses",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
		};

		const items = buildOpenAiNativeHistory([assistant, toolResultFor("call_a"), toolResultFor("call_b")], model);

		expect(items.map(item => item.type)).toEqual([
			"message",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
		]);
		expect(JSON.stringify(items[0]?.content)).toContain("</thinking");
	});
});

describe("buildOpenAiNativeHistory call-id tracking", () => {
	test("registers function_call ids carried in providerPayload so later tool results are emitted", () => {
		const items = buildOpenAiNativeHistory(
			[responsesAssistant([{ callId: "call_1" }], true), toolResultFor("call_1")],
			RESPONSES_MODEL,
		);
		const output = items.find(item => item.type === "function_call_output");
		const call = items.find(item => item.type === "function_call");
		expect(call).toBeDefined();
		expect(call).not.toHaveProperty("status");
		expect(output?.call_id).toBe("call_1");
		expect(items.find(item => item.type === "custom_tool_call_output")).toBeUndefined();
	});

	test("registers custom_tool_call ids from providerPayload so outputs use the custom wire shape", () => {
		const items = buildOpenAiNativeHistory(
			[responsesAssistant([{ callId: "call_2", custom: true }], true), toolResultFor("call_2", true)],
			RESPONSES_MODEL,
		);
		expect(items.find(item => item.type === "custom_tool_call_output")?.call_id).toBe("call_2");
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("a full-snapshot providerPayload resets known call ids so stale outputs are dropped", () => {
		const items = buildOpenAiNativeHistory(
			[
				responsesAssistant([{ callId: "call_old" }], true),
				// dt: false → splices the running history; call_old's function_call is gone.
				responsesAssistant([{ callId: "call_new" }], false),
				toolResultFor("call_old"),
				toolResultFor("call_new"),
			],
			RESPONSES_MODEL,
		);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_old")).toBe(false);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_new")).toBe(true);
	});

	test("drops stored native calls with malformed names and the outputs that answer them", () => {
		const invocationName = 'bash\0arg_key="command"\0arg_value="ls"';
		const assistant = responsesAssistant([{ callId: "call_bad" }, { callId: "call_ok" }], true);
		const badBlock = assistant.content[0];
		if (badBlock?.type !== "toolCall") throw new Error("expected tool call");
		badBlock.name = invocationName;
		const payload = assistant.providerPayload;
		if (payload?.type !== "openaiResponsesHistory") throw new Error("expected native history");
		payload.items[0]!.name = invocationName;
		const replacementHistory = {
			role: "user",
			content: "",
			timestamp: Date.now(),
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "github-copilot",
				items: [
					{ type: "function_call", call_id: "call_prev", name: "t".repeat(129), arguments: "{}" },
					{ type: "function_call", call_id: "call_prev_ok", name: "read", arguments: "{}" },
					{ type: "function_call_output", call_id: "call_prev", output: "prev result" },
					{ type: "function_call_output", call_id: "call_prev_ok", output: "prev ok result" },
				],
			},
		} as unknown as UserMessage;
		const items = buildOpenAiNativeHistory(
			[replacementHistory, assistant, toolResultFor("call_bad"), toolResultFor("call_ok")],
			RESPONSES_MODEL,
		);
		expect(items.flatMap(item => (typeof item.call_id === "string" ? [[item.type, item.call_id]] : []))).toEqual([
			["function_call", "call_prev_ok"],
			["function_call_output", "call_prev_ok"],
			["function_call", "call_ok"],
			["function_call_output", "call_ok"],
		]);
	});

	test("pairs a reused call id positionally and keeps a different-kind output", () => {
		const shared = "call_reused";
		const history = {
			role: "user",
			content: "",
			timestamp: Date.now(),
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "github-copilot",
				items: [
					{ type: "function_call", call_id: shared, name: "bad invocation", arguments: "{}" },
					{ type: "custom_tool_call_output", call_id: shared, output: "unrelated custom orphan" },
					{ type: "function_call_output", call_id: shared, output: "Tool not found" },
					{ type: "function_call", call_id: shared, name: "read", arguments: "{}" },
					{ type: "function_call_output", call_id: shared, output: "file contents" },
				],
			},
		} as unknown as UserMessage;
		const items = buildOpenAiNativeHistory([history], RESPONSES_MODEL);
		expect(
			items.flatMap(item =>
				typeof item.call_id === "string" ? [[item.type, item.call_id, item.output ?? item.name]] : [],
			),
		).toEqual([
			["custom_tool_call_output", shared, "unrelated custom orphan"],
			["function_call", shared, "read"],
			["function_call_output", shared, "file contents"],
		]);
	});

	test("does not let a malformed call without an output consume a reused id after a client message", () => {
		const shared = "call_reused";
		const history = {
			role: "user",
			content: "",
			timestamp: Date.now(),
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "github-copilot",
				items: [
					{ type: "function_call", call_id: shared, name: "bad invocation", arguments: "{}" },
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "boundary" }] },
					{ type: "function_call", call_id: shared, name: "read", arguments: "{}" },
					{ type: "function_call_output", call_id: shared, output: "file contents" },
				],
			},
		} as unknown as UserMessage;
		const items = buildOpenAiNativeHistory([history], RESPONSES_MODEL);
		expect(items.map(item => [item.type, item.role, item.call_id, item.name ?? item.output])).toEqual([
			["message", "developer", undefined, undefined],
			["function_call", undefined, shared, "read"],
			["function_call_output", undefined, shared, "file contents"],
		]);
	});
});

describe("buildOpenAiNativeHistory computer calls", () => {
	const computerModel = makeOpenAiModel({ supportsComputerUse: true });
	const pendingSafetyChecks = [{ id: "safe_1", code: "confirm", message: "Confirm click" }];
	const acknowledgedSafetyChecks = [{ id: "safe_1", code: "confirm", message: "Confirm click" }];

	function computerAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_computer_1|item_computer_1",
					name: "computer",
					arguments: { actions: [{ type: "click", button: "left", x: 12, y: 34 }] },
					providerMetadata: {
						type: "computer",
						providerItemId: "item_computer_1",
						actions: [{ type: "click", button: "left", x: 12, y: 34 }],
						pendingSafetyChecks,
					},
				},
			],
			timestamp: Date.now(),
			provider: "github-copilot",
			model: "gpt-5",
			api: "openai-responses",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
		};
	}

	test("preserves provider item id, actions, safety checks, screenshot file_id, and acknowledgements", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", file_id: "file_screen_电脑/%2F" },
				acknowledgedSafetyChecks,
			},
		};
		const items = buildOpenAiNativeHistory([computerAssistant(), result], computerModel);
		expect(items).toEqual([
			{
				type: "computer_call",
				id: "item_computer_1",
				call_id: "call_computer_1",
				actions: [{ type: "click", button: "left", x: 12, y: 34 }],
				pending_safety_checks: pendingSafetyChecks,
				status: "completed",
			},
			{
				type: "computer_call_output",
				call_id: "call_computer_1",
				output: { type: "computer_screenshot", file_id: "file_screen_电脑/%2F" },
				acknowledged_safety_checks: acknowledgedSafetyChecks,
			},
		]);
	});

	test("registers native provider-payload computer calls for exact output pairing", () => {
		const assistant = computerAssistant();
		assistant.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "github-copilot",
			dt: true,
			items: [
				{
					type: "computer_call",
					id: "item_raw_stable",
					call_id: "call_computer_1",
					actions: [{ type: "screenshot" }],
					pending_safety_checks: [],
					status: "completed",
				},
			],
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
				acknowledgedSafetyChecks: [],
			},
		};
		const items = buildOpenAiNativeHistory([assistant, result], computerModel);
		expect(items[0]?.id).toBe("item_raw_stable");
		expect(items[1]).toEqual({
			type: "computer_call_output",
			call_id: "call_computer_1",
			output: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
			acknowledged_safety_checks: [],
		});
	});

	test("replaces a failed call without a screenshot with valid recovery history", () => {
		const failed: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [{ type: "text", text: "capture failed" }],
			isError: true,
			timestamp: Date.now(),
		};
		const items = buildOpenAiNativeHistory([computerAssistant(), failed], computerModel);
		expect(items).toHaveLength(1);
		const recovery = items[0];
		expect(recovery).toMatchObject({
			type: "message",
			role: "assistant",
		});
		expect(recovery).not.toHaveProperty("status");
		expect(String(recovery?.id)).toMatch(/^msg_[a-z0-9-]+$/);
		expect(recovery?.content).toEqual([expect.objectContaining({ type: "output_text", annotations: [] })]);
		expect(JSON.stringify(items)).toContain("failed before a screenshot was recorded");
		expect(JSON.stringify(items)).toContain("capture failed");
	});

	test("downgrades unsupported native computer history to stable valid assistant message items", () => {
		const unsupportedModel = makeOpenAiModel({ supportsComputerUse: false });
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", file_id: "file_downgraded_screen" },
				acknowledgedSafetyChecks: [{ id: "safe_downgraded" }],
			},
		};
		const first = buildOpenAiNativeHistory([computerAssistant(), result], unsupportedModel);
		const second = buildOpenAiNativeHistory([computerAssistant(), result], unsupportedModel);
		expect(first).toHaveLength(2);
		for (const note of first) {
			expect(note).toMatchObject({ type: "message", role: "assistant" });
			expect(note).not.toHaveProperty("status");
			expect(String(note.id)).toMatch(/^msg_[a-z0-9-]+$/);
			expect(note.content).toEqual([expect.objectContaining({ type: "output_text", annotations: [] })]);
		}
		expect(first.map(item => item.id)).toEqual(second.map(item => item.id));
		expect(first.every(item => String(item.id).length <= 64)).toBe(true);
		expect(JSON.stringify(first)).toContain("file_downgraded_screen");
		expect(JSON.stringify(first)).toContain("safe_downgraded");
	});
});

describe("remote compaction input forwarding", () => {
	test("rewrites an oversized trailing tool output without dropping native history", async () => {
		// The compact endpoint still receives every call/result item. Only the
		// trailing output body is replaced when the request cannot fit.
		const nativeInput = [
			{ type: "custom_tool_call", call_id: "call_apply_1", name: "apply_patch", input: "{}" },
			{ type: "custom_tool_call_output", call_id: "call_apply_1", output: "patch applied".repeat(1_000) },
		];
		let requestInput: Array<Record<string, unknown>> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input) || !body.input.every(isRecord)) {
				throw new Error("expected remote compaction input");
			}
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		};

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 1_000 }),
			"test-key",
			nativeInput,
			"compact",
			undefined,
			{ fetch: fetchMock },
		);

		const trimmed = trimRemoteCompactionInputToContextWindow(nativeInput, new Tokenizer(), 1_000, "compact");
		expect(trimmed.estimatedTokensAfter).toBeLessThanOrEqual(1_000);
		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(true);
		expect(requestInput?.find(item => item.type === "custom_tool_call_output")?.output).toBe(
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		);
	});

	test("rewrites contiguous trailing outputs until the request fits", () => {
		const input = [
			{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "a".repeat(8_000) },
			{ type: "function_call_output", call_id: "call_2", output: "b".repeat(8_000) },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(2);
		expect(result.input.slice(0, 2)).toEqual(input.slice(0, 2));
		expect(result.input.slice(2).map(item => item.output)).toEqual([
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		]);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(1_000);
		expect(input[2].output).toHaveLength(8_000);
	});

	test("keeps the original input when trailing rewrites cannot make the request fit", () => {
		const input = [
			{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "a".repeat(20_000) },
			{ type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_2", output: "useful latest result" },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
		expect(result.input[3].output).toBe("useful latest result");
		expect(result.estimatedTokensAfter).toBe(result.estimatedTokensBefore);
		expect(result.fits).toBe(false);
	});

	test("charges inline images by the maximum vision budget instead of serialized base64 size", () => {
		const input = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${"a".repeat(80_000)}` },
				],
			},
			{ type: "function_call_output", call_id: "call_1", output: "useful result" },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
		expect(result.estimatedTokensAfter).toBeGreaterThan(12_000);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("counts retained replacement-history images by estimate instead of base64 size", () => {
		const image = { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${"a".repeat(320_000)}` };
		const withImage = [{ role: "user", content: [{ type: "input_text", text: "see screenshot" }, image] }];
		const withoutImage = [{ role: "user", content: [{ type: "input_text", text: "see screenshot" }] }];
		const tokenizer = new Tokenizer();

		const imageTokens =
			countResponsesHistoryTokens(withImage, tokenizer) - countResponsesHistoryTokens(withoutImage, tokenizer);

		// The serialized base64 alone tokenizes to ~80K; the flat estimate stays within one vision budget.
		expect(imageTokens).toBeGreaterThan(0);
		expect(imageTokens).toBeLessThan(20_000);
	});

	test("excludes opaque encrypted reasoning and compaction state from the fit estimate (#13611)", () => {
		// Base64 ciphertext tokenizes far above what the provider bills for it;
		// counting it refused Codex histories that the server accepts.
		const encrypted = Buffer.from(Array.from({ length: 3_000 }, (_, index) => (index * 131 + 7) % 256)).toString(
			"base64",
		);
		const input: Array<Record<string, unknown>> = [{ type: "compaction", encrypted_content: encrypted }];
		for (let turn = 0; turn < 20; turn++) {
			input.push({
				type: "reasoning",
				id: `rs_${turn}`,
				summary: [{ type: "summary_text", text: "Inspecting the module." }],
				encrypted_content: encrypted,
			});
			input.push({ type: "function_call", call_id: `call_${turn}`, name: "read", arguments: "{}" });
			input.push({ type: "function_call_output", call_id: `call_${turn}`, output: `result ${turn}` });
		}

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 5_000, "compact");

		expect(result.fits).toBe(true);
		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(5_000);
	});

	test("uses conservative token accounting for token-dense trailing output", () => {
		const output = Array.from({ length: 1_000 }, (_, index) => index.toString(16).padStart(8, "0")).join("");
		const input = [{ type: "function_call_output", call_id: "call_1", output }];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 3_000, "compact");

		expect(result.estimatedTokensBefore).toBeGreaterThan(3_000);
		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(3_000);
	});

	test("counts tool output as the model reads it, not as escaped JSON", () => {
		// Disassembly-style output: quotes, backslashes, tabs and newlines each
		// grow on JSON serialization, which used to refuse requests that fit.
		const output = '\tmov\trax, qword ptr [rip+0x1f]\t; "C:\\\\Windows\\\\System32"\n'.repeat(2_000);
		const input = [{ type: "function_call_output", call_id: "call_1", output }];
		const tokenizer = new Tokenizer();
		const contextWindow = tokenizer.countTokens(output, "strict") + 1_000;
		expect(tokenizer.countTokens(JSON.stringify({ instructions: "compact", input }), "strict")).toBeGreaterThan(
			contextWindow,
		);

		const result = trimRemoteCompactionInputToContextWindow(input, tokenizer, contextWindow, "compact");

		expect(result.fits).toBe(true);
		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input[0].output).toBe(output);
	});

	test("scans past a synthetic tool-image attachment to rewrite its output", () => {
		const attachment = {
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "Attached image(s) from tool result:" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
			],
		};
		const input = [
			{ type: "function_call_output", call_id: "call_1", output: "large tool output".repeat(1_000) },
			attachment,
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.input[1]).toEqual(attachment);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("rewrites a native multimodal tool output atomically", () => {
		const input = [
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [
					{ type: "input_text", text: "large tool output".repeat(1_000) },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("reserves the maximum patch budget for original-detail images", () => {
		const input = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_image", detail: "original", image_url: `data:image/png;base64,${"a".repeat(80_000)}` },
				],
			},
			{ type: "function_call_output", call_id: "call_1", output: "useful result".repeat(2_000) },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.estimatedTokensBefore).toBeGreaterThan(15_000);
		expect(result.rewrittenOutputs).toBe(1);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("returns semantically unchanged input when it already fits", () => {
		const input = [{ type: "function_call_output", call_id: "call_1", output: "small" }];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
	});
});

describe("requestCompactionV2Streaming", () => {
	test("posts a compaction_trigger Responses stream and installs replacement history", async () => {
		const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
		const compactionItem = { type: "compaction", encrypted_content: "enc_123" };
		const model = makeOpenAiModel({
			provider: "company-responses",
			compat: { sessionHeader: "x-litellm-session-id" },
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
				model: "gpt-5-compact",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[
				{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\nrepo" }] },
				userItem,
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
			],
			"instructions",
			{ sessionId: "session-1", promptCacheKey: "cache-1" },
		);
		let requestBody: { model: string; input: Array<Record<string, unknown>>; prompt_cache_key?: string } | undefined;
		let sessionHeader: string | undefined;
		let vendorSessionHeader: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://compact.example/v1/responses");
			const headers = new Headers(init?.headers);
			sessionHeader = headers.get("x-litellm-session-id") ?? undefined;
			vendorSessionHeader = headers.get("session_id") ?? undefined;
			requestBody = JSON.parse(String(init?.body)) as {
				model: string;
				input: Array<Record<string, unknown>>;
				prompt_cache_key?: string;
			};
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
				},
				{ type: "response.output_item.done", output_index: 1, item: compactionItem },
				{
					type: "response.completed",
					response: {
						usage: {
							input_tokens: 123,
							output_tokens: 4,
							total_tokens: 127,
							input_tokens_details: { cached_tokens: 7 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			]);
		};

		expect(shouldUseCompactionV2Streaming(model)).toBe(true);
		const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, { fetch: fetchMock });

		expect(sessionHeader).toBe("session-1");
		expect(vendorSessionHeader).toBeUndefined();
		expect(requestBody?.model).toBe("gpt-5-compact");
		expect(requestBody?.prompt_cache_key).toBe("cache-1");
		expect(requestBody?.input[requestBody.input.length - 1]).toEqual({ type: "compaction_trigger" });
		expect(result.replacementHistory).toEqual([userItem, compactionItem]);
		expect(result.usedTokens).toBe(123);
		expect(result.usage?.cachedInputTokens).toBe(7);
		expect(result.usage?.reasoningOutputTokens).toBe(1);
	});
	test.each(["The socket connection was closed unexpectedly", "socket connection closed unexpectedly"] as const)(
		"retries a transient socket closure: %s",
		async socketCloseMessage => {
			const model = makeOpenAiModel({
				remoteCompaction: {
					enabled: true,
					v2StreamingEnabled: true,
					v2Endpoint: "https://compact.example/v1/responses",
				},
			});
			const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
			const request = buildCompactionV2Request(model, [userItem], "instructions");
			const compactionItem = { type: "compaction", encrypted_content: "enc_123" };
			let attempts = 0;
			const fetchMock: FetchImpl = async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error(socketCloseMessage);
				}
				return sseResponse([
					{ type: "response.output_item.done", output_index: 0, item: compactionItem },
					{ type: "response.completed" },
				]);
			};

			const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
				fetch: fetchMock,
				retryWait: async () => {},
			});

			expect(attempts).toBe(2);
			expect(result.compactionItem).toEqual(compactionItem);
		},
	);
	test("retries transient V2 stream failures with a fresh request attempt", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		let attempts = 0;
		const fetchMock: FetchImpl = async () => {
			attempts++;
			if (attempts === 1) {
				return new Response("try again", { status: 500, statusText: "Internal Server Error" });
			}
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc" },
				},
				{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			]);
		};

		await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		});

		expect(attempts).toBe(2);
	});

	test("does not retry and preserves auth_unavailable from V2 HTTP failures", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ error: { type: "auth_unavailable", message: "no auth available for github-copilot" } },
				{ status: 503, statusText: "Service Unavailable" },
			),
		);

		const error = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		}).catch(cause => cause);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(true);
	});

	test("surfaces a standalone error event as a terminal failure without retrying", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		const fetchMock = vi.fn(async () =>
			sseResponse([
				{
					type: "error",
					status: 400,
					error: {
						message:
							"Your input exceeds the context window of this model. Please adjust your input and try again.",
						type: "invalid_request_error",
						code: "context_too_large",
					},
				},
			]),
		);

		const error = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		}).catch(cause => cause);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect(error).toMatchObject({ status: 400 });
		expect(error.message).toContain("context_too_large");
		expect(AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow)).toBe(true);
	});
});

test("uses a configured Responses endpoint and remote model override", async () => {
	const model = makeOpenAiModel({
		baseUrl: "http://127.0.0.1:8317/v1",
		remoteCompaction: {
			enabled: true,
			api: "openai-responses",
			endpoint: "http://127.0.0.1:8317/v1/responses/compact",
			model: "gpt-5.5",
		},
	});
	let requestBody: unknown;
	const fetchMock: FetchImpl = async (input, init) => {
		expect(String(input)).toBe("http://127.0.0.1:8317/v1/responses/compact");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				output: [{ type: "compaction_summary", summary: "native compacted" }],
			}),
		);
	};

	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);
	await requestOpenAiRemoteCompaction(
		model,
		"test-key",
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		undefined,
		{ fetch: fetchMock },
	);
	expect(requestBody).toMatchObject({ model: "gpt-5.5" });
});

describe("requestOpenAiRemoteCompaction abort", () => {
	test("rejects when the abort signal is aborted mid-fetch", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			// Honor the provided abort signal: hang until aborted, then reject.
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				return promise;
			}
			signal?.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			});
			return promise;
		};

		const promise = requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact",
			controller.signal,
			{ fetch: fetchMock },
		);

		queueMicrotask(() => controller.abort());

		await expect(promise).rejects.toThrow();
	});
});

describe("requestOpenAiRemoteCompaction timeout", () => {
	test("a never-responding endpoint rejects with TimeoutError instead of hanging", async () => {
		// Contract: the compact endpoint is a raw fetch outside the pi-ai stream
		// watchdogs — a silently dropped connection must not hang compaction
		// forever (frozen "Auto context-full maintenance…" spinner).
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener("abort", () => reject(signal.reason));
			return promise;
		};

		await expect(
			requestOpenAiRemoteCompaction(
				makeOpenAiModel(),
				"test-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ fetch: fetchMock, timeoutMs: 20 },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});
});

describe("requestRemoteCompaction wire formats", () => {
	test("uses OpenAI chat completions format for /chat/completions endpoints", async () => {
		const model = buildModel({
			id: "catalog-selection-id",
			name: "Qwopus 3.6 35B-A3B Coder",
			requestModelId: "provider-wire-id",
			remoteCompaction: { model: "provider-compact-wire-id" },
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "http://127.0.0.1:8001/v1",
			headers: { "x-local-llama": "1" },
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
		});
		let sentBody: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			sentBody = JSON.parse(init.body) as unknown;
			const headers = new Headers(init.headers);
			expect(headers.get("authorization")).toBe("Bearer local-key");
			expect(headers.get("x-local-llama")).toBe("1");
			return new Response(JSON.stringify({ choices: [{ message: { content: "remote summary" } }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await requestRemoteCompaction(
			"http://127.0.0.1:8001/v1/chat/completions",
			{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>", maxTokens: 16_384 },
			undefined,
			{ fetch: fetchMock, model, apiKey: "local-key" },
		);

		expect(result).toEqual({ summary: "remote summary" });
		expect(sentBody).toEqual({
			model: "provider-compact-wire-id",
			messages: [
				{ role: "system", content: "summarize" },
				{ role: "user", content: "<conversation>hello</conversation>" },
			],
			stream: false,
			max_tokens: 16_384,
		});
	});

	test("keeps the generic omp summarizer format for other endpoints", async () => {
		let sentBody: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			sentBody = JSON.parse(init.body) as unknown;
			expect(new Headers(init.headers).get("authorization")).toBeNull();
			return new Response(JSON.stringify({ summary: "generic summary", shortSummary: "generic" }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await requestRemoteCompaction(
			"https://compaction.example.test/summarize",
			{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>", maxTokens: 16_384 },
			undefined,
			{ fetch: fetchMock, apiKey: "unused-for-generic" },
		);

		expect(result).toEqual({ summary: "generic summary", shortSummary: "generic" });
		expect(sentBody).toEqual({
			systemPrompt: "summarize",
			prompt: "<conversation>hello</conversation>",
			maxTokens: 16_384,
		});
	});
});

describe("compact() remote compaction failure handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function localSummaryMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			provider: "local",
			model: "mock",
			api: "local-inference",
			usage: ZERO_USAGE,
			stopReason: "stop",
		};
	}

	function makePreparation(): CompactionPreparation {
		return {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: false },
		};
	}

	test.each(["v1", "v2"])("preserves local summary history when entering native replay (%s)", async protocol => {
		const streaming = protocol !== "v1";
		const preparation = makePreparation();
		preparation.previousSummary = "Archived decision: use port 4242.";
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: streaming };
		const baseModel = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: streaming },
		});
		const model: Model = baseModel;
		const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
		const fetchMock: FetchImpl = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
			const item = { type: "compaction", encrypted_content: `history-${requests.length}` };
			return streaming
				? sseResponse([
						{ type: "response.output_item.done", output_index: 0, item },
						{
							type: "response.completed",
							response: { usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
						},
					])
				: new Response(JSON.stringify({ output: [item] }));
		};
		const first = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });
		const firstInput = JSON.stringify(requests[0].input);
		expect(firstInput.match(/Archived decision: use port 4242\./g)).toHaveLength(1);
		expect(firstInput).toContain("long history");
		expect(firstInput).toContain("recent");

		await compact(
			{ ...preparation, previousSummary: first.summary, previousPreserveData: first.preserveData },
			model,
			"test-key",
			undefined,
			undefined,
			{ fetch: fetchMock },
		);
		const secondInput = JSON.stringify(requests[1].input);
		expect(secondInput.match(/history-1/g)).toHaveLength(1);
		expect(secondInput).not.toContain(first.summary);
		expect(secondInput).not.toContain(preparation.previousSummary);
	});

	test.each(["v1", "v2"])("does not dispatch a native request that cannot fit the window (%s)", async protocol => {
		const streaming = protocol === "v2";
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: streaming };
		preparation.messagesToSummarize = [{ role: "user", content: "re-expanded history ".repeat(4_000), timestamp: 1 }];
		const model: Model = {
			...makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: streaming } }),
			contextWindow: 2_000,
		};
		const fetchMock = vi.fn<FetchImpl>(async () => {
			throw new Error("native compaction must not reach the network");
		});

		const error = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(
			cause => cause,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(NativeCompactionError);
		// Overflow is deterministic: callers must advance to the next method, not retry.
		const id = AIError.classify(error.cause);
		expect(AIError.is(id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.retriable(id)).toBe(false);
	});

	test("claims a V1 fallback when V1 runs", async () => {
		const warn = vi.spyOn(piUtils.logger, "warn");
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const baseModel = makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		const model: Model = baseModel;
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			return url.endsWith("/responses/compact")
				? Response.json({ output: [{ type: "compaction", encrypted_content: "enc-v1" }] })
				: new Response("V2 unavailable", { status: 400, statusText: "Bad Request" });
		};

		await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(() => undefined);

		const ranV1 = requestedUrls.some(url => url.endsWith("/responses/compact"));
		const claimedV1 = warn.mock.calls.some(([message]) => message.includes("falling back to V1"));
		expect(ranV1).toBe(true);
		expect(claimedV1).toBe(ranV1);
	});

	test("streams V2 compaction before V1 when both settings and model opt in", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteStreamingV2Enabled: true,
		};
		preparation.messagesToSummarize = [
			{ role: "user", content: "first user request", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "hidden reasoning",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_test",
							encrypted_content: "encrypted reasoning",
							summary: [],
						}),
					},
					{ type: "text", text: "assistant visible answer" },
					{ type: "toolCall", id: "call_read_1|fc_read_1", name: "read", arguments: { path: "/tmp/x" } },
				],
				timestamp: 2,
				provider: "github-copilot",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_read_1|fc_read_1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
		];
		preparation.recentMessages = [{ role: "user", content: "second user request", timestamp: 4 }];
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		let requestBody: { input: Array<Record<string, unknown>>; reasoning?: Record<string, unknown> } | undefined;
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			calls++;
			requestBody = JSON.parse(String(init?.body)) as {
				input: Array<Record<string, unknown>>;
				reasoning?: Record<string, unknown>;
			};
			return sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 55, output_tokens: 3, total_tokens: 58 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			fetch: fetchMock,
		});

		const input = requestBody?.input ?? [];
		const inputText = input.flatMap(item =>
			Array.isArray(item.content)
				? item.content.filter(isRecord).map(part => (typeof part.text === "string" ? part.text : ""))
				: [],
		);
		expect(calls).toBe(1);
		// Faithful Codex V2 shape: the trigger is the final input item.
		expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" });
		// Conversation turns survive translation — user prompts, assistant prose, reasoning, and the tool pair.
		expect(inputText).toContain("first user request");
		expect(inputText).toContain("assistant visible answer");
		expect(inputText).toContain("second user request");
		expect(input.some(item => item.type === "reasoning")).toBe(true);
		expect(input.some(item => item.type === "function_call" && item.name === "read")).toBe(true);
		expect(input.some(item => item.type === "function_call_output")).toBe(true);
		expect(
			input.some(
				item =>
					(item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call") &&
					Object.hasOwn(item, "status"),
			),
		).toBe(false);
		// Reasoning effort is sent like a normal turn (gpt-5 is a reasoning model).
		expect(requestBody?.reasoning).toMatchObject({ effort: "high", summary: "auto" });
		const remote = getCompactionV2PreserveData(result.preserveData);
		expect(remote?.usedTokens).toBe(55);
		expect(remote?.replacementHistory.at(-1)).toEqual(compactionItem);
		expect(result.summary).toBe(
			"Remote compaction preserved provider-native history for this session. Compaction processed 55 input tokens.",
		);
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("retains only user-written turns, as serialized, in V2 replacement history", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const quotedLeadIn = "Previous snapcompact archive source text:\n\nPlease rename this heading in our UI.";
		const imageData = Buffer.from("screenshot").toString("base64");
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.previousSummary = "Archived decision: use port 4242.";
		preparation.messagesToSummarize = [
			{ role: "user", content: "first user request", timestamp: 1 },
			{ role: "developer", content: "harness developer note", timestamp: 2 },
			createCustomMessage("hook", "extension hook note", false, undefined, new Date(3).toISOString()),
			{
				role: "user",
				content: [
					{ type: "text", text: quotedLeadIn },
					{ type: "image", data: imageData, mimeType: "image/png" },
				],
				timestamp: 4,
			},
		];
		const baseModel = makeOpenAiModel({
			input: ["text", "image"],
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const model: Model = baseModel;
		let requestInput: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = async (_url, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			requestInput = isRecord(body) && Array.isArray(body.input) ? body.input.filter(isRecord) : [];
			return sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 55, output_tokens: 3, total_tokens: 58 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		const textOf = (item: Record<string, unknown>) =>
			Array.isArray(item.content)
				? item.content.filter(isRecord).map(part => (typeof part.text === "string" ? part.text : ""))
				: [];
		const wireUsers = requestInput.filter(item => item.role === "user");
		// The serializer sends user turns without `type`; the summary is a user-role turn on
		// both transports, and OpenAI also sends developer and hook messages as user-role turns.
		expect(wireUsers.every(item => item.type === undefined)).toBe(true);
		expect(JSON.stringify(wireUsers)).toContain("Archived decision: use port 4242.");
		expect(JSON.stringify(wireUsers)).toContain("extension hook note");

		const remote = getCompactionV2PreserveData(result.preserveData);
		const retained = remote?.replacementHistory.slice(0, -1) ?? [];
		expect(remote?.replacementHistory.at(-1)).toEqual(compactionItem);
		expect(retained.map(item => textOf(item)[0])).toEqual(["first user request", quotedLeadIn, "recent"]);
		for (const item of retained) expect(wireUsers).toContainEqual(item);
		expect(result.preserveData?.openaiRemoteCompaction).toMatchObject({ retainedImageCount: 1 });
	});

	test("retains custom turns the host marks as user-written in V2 replacement history", async () => {
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.messagesToSummarize = [
			{ role: "user", content: "older plain request", timestamp: 1 },
			createCustomMessage(
				"skill-prompt",
				"run the release skill",
				true,
				undefined,
				new Date(2).toISOString(),
				"user",
			),
			createCustomMessage("notice", "attached file note", false, undefined, new Date(3).toISOString(), "user"),
		];
		const model = makeOpenAiModel({ remoteCompaction: { enabled: true, v2StreamingEnabled: true } });
		const fetchMock: FetchImpl = async () =>
			sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
			]);

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			fetch: fetchMock,
			isUserAuthored: message =>
				message.role === "user" || (message.role === "custom" && message.customType === "skill-prompt"),
		});

		const retained = JSON.stringify(
			getCompactionV2PreserveData(result.preserveData)?.replacementHistory.slice(0, -1),
		);
		expect(retained).toContain("older plain request");
		expect(retained).toContain("run the release skill");
		expect(retained).not.toContain("attached file note");
	});

	test("rewrites an oversized trailing tool output before V2 streaming compaction", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.messagesToSummarize = [
			{ role: "user", content: "inspect the large file", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_read_large|fc_read_large", name: "read", arguments: { path: "/tmp/x" } },
				],
				timestamp: 2,
				provider: "github-copilot",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_read_large|fc_read_large",
				toolName: "read",
				content: [{ type: "text", text: "large output".repeat(10_000) }],
				isError: false,
				timestamp: 3,
			},
		];
		preparation.recentMessages = [];
		const model = makeOpenAiModel({
			contextWindow: 20_000,
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		let requestInput: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input) || !body.input.every(isRecord)) {
				throw new Error("expected V2 compaction input");
			}
			requestInput = body.input;
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc_trimmed" },
				},
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } },
				},
			]);
		};

		await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestInput.some(item => item.type === "function_call" && item.call_id === "call_read_large")).toBe(true);
		expect(requestInput.find(item => item.type === "function_call_output")?.output).toBe(
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		);
		expect(requestInput.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	test("compacts the history before the kept tail when a final response pushes it over the window", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.lastSummarizedEntryId = "summarized-last";
		const tailText = "final answer paragraph ".repeat(8_000);
		preparation.recentMessages = [
			{ role: "user", content: "recent", timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "text", text: tailText }],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 3,
			},
		];
		const model = makeOpenAiModel({
			contextWindow: 20_000,
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const requestInputs: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("expected V2 compaction input");
			requestInputs.push(JSON.stringify(body.input));
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc_prefix" },
				},
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestInputs).toHaveLength(1);
		expect(requestInputs[0]).toContain("long history");
		expect(requestInputs[0]).not.toContain("final answer paragraph");
		expect(requestInputs[0]).not.toContain('"recent"');
		expect(result.providerReplayThroughEntryId).toBe("summarized-last");
		expect(result.preserveData?.openaiRemoteCompaction).toBeDefined();
	});

	test("replays an oversized kept tool result instead of rewriting it when the prefix fits", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.lastSummarizedEntryId = "summarized-last";
		preparation.recentMessages = [
			{ role: "user", content: "read the large file", timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_kept|fc_kept", name: "read", arguments: { path: "/tmp/x" } }],
				timestamp: 3,
				provider: "github-copilot",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_kept|fc_kept",
				toolName: "read",
				content: [{ type: "text", text: "kept tool output ".repeat(8_000) }],
				isError: false,
				timestamp: 4,
			},
		];
		const model = makeOpenAiModel({
			contextWindow: 20_000,
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const requestInputs: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("expected V2 compaction input");
			requestInputs.push(JSON.stringify(body.input));
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc_prefix" },
				},
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestInputs).toHaveLength(1);
		expect(requestInputs[0]).toContain("long history");
		expect(requestInputs[0]).not.toContain("call_kept");
		expect(requestInputs[0]).not.toContain(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.providerReplayThroughEntryId).toBe("summarized-last");
	});

	test("re-expands native history for local preparation when new native compaction is disabled", async () => {
		const localComplete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(localSummaryMessage("re-expanded local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const v2Model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		// Produce a real V2 preserve payload (opaque placeholder summary, provider "openai").
		const v2Preparation = makePreparation();
		v2Preparation.messagesToSummarize = [{ role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 }];
		v2Preparation.recentMessages = [{ role: "user", content: "turn after", timestamp: 2 }];
		v2Preparation.settings = { ...v2Preparation.settings, remoteStreamingV2Enabled: true };
		const v2Result = await compact(v2Preparation, v2Model, "k", undefined, undefined, {
			fetch: async () =>
				sseResponse([
					{ type: "response.output_item.done", output_index: 0, item: compactionItem },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
					},
				]),
		});

		// Session branch after that V2 compaction: originals + compaction boundary + new turns.
		const ts = (n: number) => new Date(n).toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: ts(2),
				summary: v2Result.summary,
				firstKeptEntryId: "m1",
				tokensBefore: 100_000,
				preserveData: v2Result.preserveData,
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: ts(3),
				message: { role: "user", content: "second turn", timestamp: 3 },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: ts(4),
				message: { role: "user", content: "third turn", timestamp: 4 },
			},
		];
		const baseSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

		// Normal replay still works, but local preparation must re-expand the
		// originals rather than send an opaque placeholder to its summarizer.
		for (const { model, settings } of [
			{ model: v2Model, settings: { ...baseSettings, remoteEnabled: false } },
			{
				model: { ...v2Model, remoteCompaction: { ...v2Model.remoteCompaction, enabled: false } },
				settings: baseSettings,
			},
		]) {
			const reexpanded = prepareCompaction(entries, settings, model);
			if (!reexpanded) throw new Error("Expected local compaction preparation");
			localComplete.mockClear();
			await compact(reexpanded, model, "k");
			expect(JSON.stringify(localComplete.mock.calls.map(([, context]) => context.messages))).toContain(
				"ORIGINAL ALPHA port 4242",
			);
		}

		// Remote + V2 still enabled, same provider → reuse the replay, don't re-summarize originals.
		const reused = prepareCompaction(entries, { ...baseSettings, remoteStreamingV2Enabled: true }, v2Model);
		expect(reused).toBeDefined();
		const reusedText = JSON.stringify(reused?.messagesToSummarize ?? []);
		expect(reusedText).not.toContain("ORIGINAL ALPHA port 4242");
	});

	test("re-expands a stranded remote compaction when the active model cannot replay it (#6343)", () => {
		const ts = (n: number) => new Date(n).toISOString();
		const anthropicActive = buildModel({
			id: "claude-sonnet-4.5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const openaiSmol = makeOpenAiModel({ id: "gpt-5-mini", name: "GPT-5 mini" });
		// Prior OpenAI remote compaction: opaque placeholder summary, provider-native
		// replay stored under preserveData tagged "openai".
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: ts(2),
				summary: "Remote compaction preserved provider-native history for this session.",
				firstKeptEntryId: "m1",
				tokensBefore: 100_000,
				preserveData: {
					openaiRemoteCompaction: {
						provider: "github-copilot",
						replacementHistory: [{ type: "message", role: "user", content: "opaque native replay" }],
						compactionItem: { type: "compaction", encrypted_content: "enc_v1" },
					},
				},
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: ts(3),
				message: { role: "user", content: "second turn", timestamp: 3 },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: ts(4),
				message: { role: "user", content: "third turn", timestamp: 4 },
			},
		];
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
		// Reuse is judged by the ACTIVE model, not the candidate set. The active
		// anthropic model's encoder drops the OpenAI replay payload, so the stranded
		// originals are re-expanded into a portable local summary — even though the
		// OpenAI smol role could still replay the blob.
		const foreignActive = prepareCompaction(entries, settings, anthropicActive);
		expect(foreignActive).toBeDefined();
		expect(JSON.stringify(foreignActive?.messagesToSummarize ?? [])).toContain("ORIGINAL ALPHA port 4242");
		// The same-provider OpenAI model can replay the payload, so the boundary is
		// kept and the originals are not re-summarized.
		const sameProviderActive = prepareCompaction(entries, settings, openaiSmol);
		expect(sameProviderActive).toBeDefined();
		expect(JSON.stringify(sameProviderActive?.messagesToSummarize ?? [])).not.toContain("ORIGINAL ALPHA port 4242");
	});

	test("retains the V2 non-auth failure when the V1 fallback fails authentication", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			return url.endsWith("/responses/compact")
				? new Response("authentication failed", { status: 401, statusText: "Unauthorized" })
				: new Response("V2 transport failed", { status: 400, statusText: "Bad Request" });
		};

		const error = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(
			cause => cause,
		);

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact"]);
		expect(error).toBeInstanceOf(NativeCompactionError);
		expect(error).toMatchObject({ cause: { status: 400 } });
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(false);
	});

	test("keeps native compaction auth-classified when every attempted protocol fails authentication", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return new Response("authentication failed", { status: 401, statusText: "Unauthorized" });
		};

		const error = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(
			cause => cause,
		);

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact"]);
		expect(error).toBeInstanceOf(NativeCompactionError);
		expect(error).toMatchObject({ cause: { status: 401 } });
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(true);
	});

	test("V2 native failure falls back to V1 without generic summarization", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/responses/compact")) {
				return Response.json({ output: [{ type: "compaction", encrypted_content: "enc-v1" }] });
			}
			return new Response("V2 unavailable", { status: 502, statusText: "Bad Gateway" });
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestedUrls.some(url => url.endsWith("/responses"))).toBe(true);
		expect(requestedUrls.some(url => url.endsWith("/responses/compact"))).toBe(true);
		expect(result.shortSummary).toBe("Remote compaction");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("user abort during the remote compact request rejects without falling back to local summarization", async () => {
		// Contract: Esc is a cancellation, not a remote failure. Before the fix
		// the AbortError was swallowed by the fallback catch and compaction kept
		// running local summarization on an already-aborted signal.
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			const fail = () =>
				reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail);
			// Esc lands while the compact POST is in flight.
			queueMicrotask(() => controller.abort());
			return promise;
		};

		await expect(
			compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, controller.signal, {
				fetch: fetchMock,
			}),
		).rejects.toThrow();
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("uses configured chat completions endpoints for openai-completions remote compaction", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local fallback"));
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteEndpoint: "http://127.0.0.1:8001/v1/chat/completions",
			remoteStreamingV2Enabled: false,
		};
		const model = buildModel({
			id: "catalog-selection-id",
			name: "Qwopus 3.6 35B-A3B Coder",
			requestModelId: "provider-wire-id",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "http://127.0.0.1:8001/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
		});
		const requestBodies: unknown[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			requestBodies.push(JSON.parse(init.body) as unknown);
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-key");
			const summary = requestBodies.length === 1 ? "remote history summary" : "remote short summary";
			return new Response(JSON.stringify({ choices: [{ message: { content: summary } }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await compact(preparation, model, "local-key", undefined, undefined, {
			fetch: fetchMock,
		});

		expect(result.summary).toContain("remote history summary");
		expect(result.shortSummary).toBe("remote short summary");
		expect(completeSpy).not.toHaveBeenCalled();
		expect(requestBodies).toHaveLength(2);
		expect(requestBodies[0]).toMatchObject({
			model: "provider-wire-id",
			messages: [{ role: "system" }, { role: "user", content: expect.stringContaining("long history") }],
			stream: false,
		});
	});

	test("uses an explicit remote endpoint after provider-native compaction fails", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local fallback"));
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteEndpoint: "http://summary.test/v1/chat/completions",
			remoteStreamingV2Enabled: true,
		};
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === preparation.settings.remoteEndpoint) {
				const summary =
					requestedUrls.filter(requested => requested === url).length === 1
						? "configured remote history summary"
						: "configured remote short summary";
				return Response.json({ choices: [{ message: { content: summary } }] });
			}
			return new Response("native compaction unavailable", { status: 400, statusText: "Bad Request" });
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual([
			"/v1/responses",
			"/v1/responses/compact",
			"/v1/chat/completions",
			"/v1/chat/completions",
		]);
		expect(result.summary).toContain("configured remote history summary");
		expect(result.shortSummary).toBe("configured remote short summary");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("native compaction server failure rejects without generic summarization", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const fetchMock: FetchImpl = async () =>
			new Response("nope", { status: 500, statusText: "Internal Server Error" });

		await expect(
			compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, undefined, {
				fetch: fetchMock,
			}),
		).rejects.toThrow("Remote compaction failed");
		expect(completeSpy).not.toHaveBeenCalled();
	});
});

describe("configured remote compaction request preparation", () => {
	const nativeInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
	const runtimeUrl = "http://127.0.0.1:8317/v1";

	function compactionResponse(): Response {
		return Response.json({ output: [{ type: "compaction", encrypted_content: "enc" }] });
	}

	function v2Response(): Response {
		return sseResponse([
			{ type: "response.output_item.done", output_index: 0, item: { type: "compaction", encrypted_content: "enc" } },
			{ type: "response.completed" },
		]);
	}

	test.each(["Authorization", "x-company-api-key"] as const)(
		"sends lazily resolved configured headers instead of a keyless bearer (%s)",
		async credentialHeader => {
			let headerResolutions = 0;
			const model: Model<"openai-responses"> = {
				...makeOpenAiModel({
					provider: "company-responses",
					baseUrl: runtimeUrl,
					headers: { "x-company-routing": "compaction" },
					remoteCompaction: { enabled: true, v2StreamingEnabled: true },
				}),
				resolveHeaders: async () => ({ [credentialHeader]: `lazy-token-${++headerResolutions}` }),
			};
			const authorizations: Array<string | null> = [];
			const credentials: Array<string | null> = [];
			const fetchMock: FetchImpl = async (input, init) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("x-company-routing")).toBe("compaction");
				authorizations.push(headers.get("authorization"));
				credentials.push(headers.get(credentialHeader));
				return String(input).endsWith("/compact") ? compactionResponse() : v2Response();
			};

			const v1 = await requestOpenAiRemoteCompaction(
				model,
				NO_AUTH_SENTINEL,
				nativeInput,
				"instructions",
				undefined,
				{ fetch: fetchMock },
			);
			const v2 = await requestCompactionV2Streaming(
				model,
				NO_AUTH_SENTINEL,
				buildCompactionV2Request(model, nativeInput, "instructions"),
				undefined,
				{ fetch: fetchMock },
			);

			expect(headerResolutions).toBe(2);
			expect(credentials).toEqual(["lazy-token-1", "lazy-token-2"]);
			expect(authorizations).toEqual(
				credentialHeader === "Authorization" ? ["lazy-token-1", "lazy-token-2"] : [null, null],
			);
			expect(v1.replacementHistory).toEqual([{ type: "compaction", encrypted_content: "enc" }]);
			expect(v2.replacementHistory).toEqual([...nativeInput, { type: "compaction", encrypted_content: "enc" }]);
		},
	);

	test.each(["v1", "v2"] as const)("cancels %s while configured headers are resolving", async protocol => {
		const controller = new AbortController();
		const model: Model<"openai-responses"> = {
			...makeOpenAiModel({
				provider: "company-responses",
				baseUrl: runtimeUrl,
				remoteCompaction: { enabled: true, v2StreamingEnabled: true },
			}),
			resolveHeaders: async signal => {
				expect(signal).toBeDefined();
				queueMicrotask(() => controller.abort());
				return new Promise<Record<string, string>>(() => {});
			},
		};
		const fetchMock = vi.fn<FetchImpl>(async () => {
			throw new Error("Aborted compaction must not dispatch");
		});
		const result =
			protocol === "v1"
				? requestOpenAiRemoteCompaction(model, NO_AUTH_SENTINEL, nativeInput, "instructions", controller.signal, {
						fetch: fetchMock,
					})
				: requestCompactionV2Streaming(
						model,
						NO_AUTH_SENTINEL,
						buildCompactionV2Request(model, nativeInput, "instructions"),
						controller.signal,
						{ fetch: fetchMock },
					);

		await expect(result).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test.each([
		["https://inference.company.example/v1", "http://proxy.example.test:8080"],
		[runtimeUrl, undefined],
	] as const)("routes compaction through the provider proxy except for loopback (%s)", async (baseUrl, proxy) => {
		const model = makeOpenAiModel({
			provider: "company-responses",
			baseUrl,
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const previous = Bun.env.PI_PROXY_COMPANY_RESPONSES;
		Bun.env.PI_PROXY_COMPANY_RESPONSES = "http://proxy.example.test:8080";
		__resetProxyCache();
		const proxies: unknown[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			proxies.push((init as { proxy?: unknown } | undefined)?.proxy);
			return String(input).endsWith("/compact") ? compactionResponse() : v2Response();
		};
		try {
			await requestOpenAiRemoteCompaction(model, "test-key", nativeInput, "instructions", undefined, {
				fetch: fetchMock,
			});
			await requestCompactionV2Streaming(
				model,
				"test-key",
				buildCompactionV2Request(model, nativeInput, "instructions"),
				undefined,
				{ fetch: fetchMock },
			);
		} finally {
			if (previous === undefined) delete Bun.env.PI_PROXY_COMPANY_RESPONSES;
			else Bun.env.PI_PROXY_COMPANY_RESPONSES = previous;
			__resetProxyCache();
		}

		expect(proxies).toEqual([proxy, proxy]);
	});
});
