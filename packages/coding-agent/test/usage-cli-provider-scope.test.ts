import { afterEach, expect, test, vi } from "bun:test";
import { AuthStorage, type UsageReport } from "@oh-my-striped-pi/pi-ai";
import { runUsageCommand } from "@oh-my-striped-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-striped-pi/pi-coding-agent/sdk";

afterEach(() => vi.restoreAllMocks());

test("accepts an explicit company provider and invalidates only its usage cache", async () => {
	const storage = await AuthStorage.create(":memory:");
	try {
		await storage.credentials.set("company-primary", { type: "api_key", key: "primary-key" });
		await storage.credentials.set("company-secondary", { type: "api_key", key: "secondary-key" });
		let generation = 1;
		for (const provider of ["company-primary", "company-secondary"]) {
			storage.usage.setProvider(provider, {
				id: provider,
				fetchUsage: async () => ({
					provider,
					fetchedAt: Date.now(),
					limits: [],
					metadata: { generation },
				}),
			});
		}
		expect(await storage.usage.reports()).toHaveLength(2);
		generation = 2;
		let refreshed: UsageReport[] = [];
		vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated({}));
		const discover = vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(storage);
		const invalidate = storage.usage.invalidate.bind(storage.usage);
		vi.spyOn(storage.usage, "invalidate").mockImplementation(async (provider, signal) => {
			await invalidate(provider, signal);
			refreshed = (await storage.usage.reports()) ?? [];
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runUsageCommand({ action: "invalidate", provider: "company-primary", noExtensions: true });

		expect(discover).toHaveBeenCalledTimes(1);
		expect(refreshed.find(report => report.provider === "company-primary")?.metadata?.generation).toBe(2);
		expect(refreshed.find(report => report.provider === "company-secondary")?.metadata?.generation).toBe(1);
	} finally {
		storage.close();
	}
});

test("rejects the removed reset action before discovery", async () => {
	const discover = vi.spyOn(sdkModule, "discoverAuthStorage");
	await expect(runUsageCommand({ action: "reset" })).rejects.toThrow("Unknown usage action");
	expect(discover).not.toHaveBeenCalled();
});
