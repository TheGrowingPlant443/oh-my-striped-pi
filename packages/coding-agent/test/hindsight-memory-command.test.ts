import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-striped-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-striped-pi/pi-coding-agent/hindsight/config";
import type { HindsightSessionState } from "@oh-my-striped-pi/pi-coding-agent/hindsight/state";
import { CommandController } from "@oh-my-striped-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-striped-pi/pi-coding-agent/modes/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function harness(enabled = true) {
	const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.mentalModelsEnabled": enabled });
	const client = new HindsightApi({ baseUrl: "http://memory.internal:8888" });
	const reload = vi.fn(async () => true);
	const errors: string[] = [];
	const statuses: string[] = [];
	const state = {
		client,
		bankId: "company",
		config: loadHindsightConfig(settings),
		reloadMentalModels: reload,
	} as unknown as HindsightSessionState;
	const session = { getHindsightSessionState: () => state };
	state.session = session as HindsightSessionState["session"];
	const ctx = {
		settings,
		session,
		sessionManager: { getCwd: () => "/work/company" },
		showError: (text: string) => errors.push(text),
		showWarning: (text: string) => errors.push(text),
		showStatus: (text: string) => statuses.push(text),
	} as unknown as InteractiveModeContext;
	return { controller: new CommandController(ctx), client, reload, errors, statuses };
}

describe("private Hindsight mental-model maintenance", () => {
	it("does not regenerate curated models during a bulk refresh", async () => {
		const { controller, client, reload, errors, statuses } = harness();
		const list = vi.spyOn(client, "listMentalModels").mockResolvedValue({
			items: [
				{ id: "curated", bank_id: "company", name: "Curated", trigger: { refresh_after_consolidation: false } },
			],
		});
		const refresh = vi.spyOn(client, "refreshMentalModel");
		await controller.handleMemoryCommand("/memory mm refresh");
		expect(list).toHaveBeenCalledWith("company", { detail: "content" });
		expect(refresh).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(errors).toEqual([]);
		expect(statuses[0]).toContain("curated model(s) left untouched");
	});

	it("refreshes only opted-in models and then reloads the session snapshot", async () => {
		const { controller, client, reload, errors } = harness();
		vi.spyOn(client, "listMentalModels").mockResolvedValue({
			items: [
				{ id: "auto", bank_id: "company", name: "Auto", trigger: { refresh_after_consolidation: true } },
				{ id: "curated", bank_id: "company", name: "Curated" },
			],
		});
		const refresh = vi.spyOn(client, "refreshMentalModel").mockResolvedValue({});
		await controller.handleMemoryCommand("/memory mm refresh");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith("company", "auto");
		expect(reload).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
	});

	it("does not access the server when mental models are disabled", async () => {
		const { controller, client, errors } = harness(false);
		const list = vi.spyOn(client, "listMentalModels");
		await controller.handleMemoryCommand("/memory mm list");
		expect(list).not.toHaveBeenCalled();
		expect(errors).toEqual(["Mental models are disabled (hindsight.mentalModelsEnabled = false)."]);
	});
});
