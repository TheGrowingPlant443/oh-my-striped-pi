import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";
import { parseModelPattern, resolveCliModel } from "@oh-my-striped-pi/pi-coding-agent/config/model-resolver";

const companySpec = {
	id: "team/private-model",
	name: "Private model",
	api: "openai-completions",
	provider: "company-proxy",
	baseUrl: "https://inference.company.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
} satisfies ModelSpec<"openai-completions">;
const companyModel = buildModel(companySpec);

const teamModel = buildModel({ ...companySpec, id: "private-model", provider: "team" });

describe("custom provider literal slash ids (#8800)", () => {
	test("an exact literal slash id resolves to its configured company provider", () => {
		expect(parseModelPattern("team/private-model", [companyModel]).model).toBe(companyModel);
	});

	test("the CLI preserves a configured literal slash id", () => {
		const result = resolveCliModel({
			cliModel: "team/private-model",
			modelRegistry: { getAll: () => [companyModel], getAvailable: () => [companyModel] },
		});
		expect(result.model).toBe(companyModel);
		expect(result.error).toBeUndefined();
	});

	test("an exact provider-qualified reference wins over a different provider's literal id", () => {
		expect(parseModelPattern("team/private-model", [companyModel, teamModel]).model).toBe(teamModel);
	});

	test("the full company provider reference remains unambiguous", () => {
		expect(parseModelPattern("company-proxy/team/private-model", [companyModel, teamModel]).model).toBe(companyModel);
	});
});
