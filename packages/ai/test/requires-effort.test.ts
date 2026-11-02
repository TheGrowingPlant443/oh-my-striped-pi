import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-striped-pi/pi-ai";
import { streamSimple } from "@oh-my-striped-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-striped-pi/pi-ai/types";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { ModelSpec, ThinkingConfig } from "@oh-my-striped-pi/pi-catalog/types";

interface CapturedBody {
	model?: string;
	reasoning?: { effort?: string };
	reasoning_effort?: string;
}

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function copilotModel(thinking: ThinkingConfig): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		thinking,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	} satisfies ModelSpec<"openai-responses">);
}

function companyModel(thinking: ThinkingConfig): Model<"openai-completions"> {
	return buildModel({
		id: "company-reasoner",
		name: "Company reasoner",
		api: "openai-completions",
		provider: "company",
		baseUrl: "https://inference.company.example/v1",
		reasoning: true,
		thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 8192,
	});
}

async function captureBody(
	model: Model<"openai-responses" | "openai-completions">,
	options: { reasoning?: Effort; disableReasoning?: boolean; forceReasoningOff?: boolean },
): Promise<CapturedBody> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
	};
	const stream = streamSimple(model, context, { apiKey: "test-key", fetch: fetchMock, ...options });
	await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return JSON.parse(requestBody) as CapturedBody;
}

const MANDATORY_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	requiresEffort: true,
};

describe("thinking.requiresEffort clamping", () => {
	it("clamps omitted reasoning to the lowest supported effort", async () => {
		const body = await captureBody(copilotModel(MANDATORY_THINKING), {});
		expect(body.reasoning).toMatchObject({ effort: "minimal" });
	});

	it("clamps disableReasoning instead of sending an explicit disable", async () => {
		const body = await captureBody(copilotModel(MANDATORY_THINKING), { disableReasoning: true });
		expect(body.reasoning).toMatchObject({ effort: "minimal" });
	});

	it("clamps forceReasoningOff when the endpoint cannot disable reasoning", async () => {
		const body = await captureBody(copilotModel(MANDATORY_THINKING), {
			reasoning: Effort.High,
			forceReasoningOff: true,
		});
		expect(body.reasoning).toMatchObject({ effort: "minimal" });
	});

	it("keeps explicit efforts untouched", async () => {
		const body = await captureBody(copilotModel(MANDATORY_THINKING), { reasoning: Effort.High });
		expect(body.reasoning).toMatchObject({ effort: "high" });
	});

	it("does not clamp omitted reasoning without requiresEffort", async () => {
		const plain = copilotModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		const off = await captureBody(plain, {});
		expect(off.reasoning?.effort).toBeUndefined();
	});

	it("routes flag-free pairs off to the bare SKU and efforts to the thinking SKU", async () => {
		// This logical company model explicitly supports off via its bare backing SKU.
		const routed = companyModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: false,
			effortRouting: {
				off: "company-reasoner",
				[Effort.Minimal]: "company-reasoner-thinking",
				[Effort.High]: "company-reasoner-thinking",
			},
		});
		const off = await captureBody(routed, {});
		expect(off.model).toBe("company-reasoner");
		expect(off.reasoning_effort).toBeUndefined();
		const high = await captureBody(routed, { reasoning: Effort.High });
		expect(high.model).toBe("company-reasoner-thinking");
		expect(high.reasoning_effort).toBe("high");
	});

	it("clamps mandatory logical models before selecting an effort route", async () => {
		const routed = companyModel({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: true,
			effortRouting: {
				off: "company-reasoner",
				[Effort.Minimal]: "company-reasoner-thinking",
				[Effort.High]: "company-reasoner-thinking",
			},
		});
		const off = await captureBody(routed, {});
		expect(off.model).toBe("company-reasoner-thinking");
		expect(off.reasoning_effort).toBe("minimal");
	});
});
