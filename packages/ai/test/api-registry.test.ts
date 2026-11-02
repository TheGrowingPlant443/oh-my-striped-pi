import { afterEach, describe, expect, test } from "bun:test";
import {
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
	unregisterCustomApis,
} from "@oh-my-striped-pi/pi-ai/api-registry";
import { createMockModel, streamMock } from "@oh-my-striped-pi/pi-ai/providers/mock";
import { completeSimple } from "@oh-my-striped-pi/pi-ai/stream";
import type { AssistantMessageEventStream } from "@oh-my-striped-pi/pi-ai/types";

afterEach(() => {
	clearCustomApis();
});

describe("custom API registry", () => {
	const streamSimple: CustomStreamSimpleFn = () => ({}) as unknown as AssistantMessageEventStream;

	test.each(["company-native", "openai-responses", "openai-completions", "anthropic-messages", "mock"])(
		"registers an explicit custom handler for %s",
		api => {
			registerCustomApi(api, streamSimple, "company-extension");
			expect(getCustomApi(api)?.streamSimple).toBe(streamSimple);
			unregisterCustomApis("company-extension");
			expect(getCustomApi(api)).toBeUndefined();
		},
	);

	test.each(["", "   ", "invalid\0api"])("rejects malformed API name %j", api => {
		expect(() => registerCustomApi(api, streamSimple)).toThrow("Custom API must be a nonempty name");
	});

	test("registers the local inference transport", () => {
		registerCustomApi("local-inference", streamSimple, "local-runtime");

		expect(getCustomApi("local-inference")?.streamSimple).toBe(streamSimple);
		expect(getCustomApi("local-inference")?.sourceId).toBe("local-runtime");
	});

	test("dispatches a local model through its registered inference transport", async () => {
		const model = createMockModel({ responses: [{ content: ["local response"] }] });
		registerCustomApi("local-inference", streamMock, "local-runtime");

		const response = await completeSimple(model, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});

		expect(response.provider).toBe("local");
		expect(response.api).toBe("local-inference");
		expect(response.content).toEqual([{ type: "text", text: "local response" }]);
		expect(model.calls).toHaveLength(1);
	});

	test("dispatches configured company providers without changing their identity", async () => {
		const model = createMockModel({ provider: "company", responses: [{ content: ["company response"] }] });
		registerCustomApi("company-native", model.stream, "company-runtime");
		const response = await completeSimple(
			{ ...model, api: "company-native" },
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		);
		expect(response.provider).toBe("company");
		expect(response.content).toEqual([{ type: "text", text: "company response" }]);
		expect(model.calls).toHaveLength(1);
	});

	test("unregisterCustomApis preserves a different source's local registration", () => {
		registerCustomApi("local-inference", streamSimple, "local-runtime");
		unregisterCustomApis("other-extension");
		expect(getCustomApi("local-inference")?.streamSimple).toBe(streamSimple);

		unregisterCustomApis("local-runtime");
		expect(getCustomApi("local-inference")).toBeUndefined();
	});

	test("clearCustomApis removes the local registration", () => {
		registerCustomApi("local-inference", streamSimple, "local-runtime");
		clearCustomApis();
		expect(getCustomApi("local-inference")).toBeUndefined();
	});
});
