import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("provider default selection", () => {
	test("picks Copilot's declared default over availability order", () => {
		const bundled = getBundledModels("github-copilot") as Model<Api>[];
		const declaredDefault = bundled.find(model => model.id === DEFAULT_MODEL_PER_PROVIDER["github-copilot"]);
		expect(declaredDefault).toBeDefined();
		if (!declaredDefault) return;

		const available = [...bundled.filter(model => model !== declaredDefault), declaredDefault];
		expect(available.length).toBeGreaterThan(1);

		const picked = pickDefaultAvailableModel(available);

		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER["github-copilot"]);
	});
});
