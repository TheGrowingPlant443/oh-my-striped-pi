/**
 * `alwaysRefetchDynamicModels` bypasses a fresh cache for online refreshes,
 * while explicit offline refreshes keep serving the cached catalog.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-striped-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-striped-pi/pi-catalog/types";

describe("alwaysRefetchDynamicModels", () => {
	it("replays a fresh cache under online-if-uncached without the option, refetches with it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "always-refetch-"));
		try {
			let served = "syn:first";
			const fetchMock = vi.fn(async (): Promise<ModelSpec<"openai-completions">[]> => [
				{
					id: served,
					name: served,
					api: "openai-completions",
					provider: "refetch-test",
					baseUrl: "https://catalog.example/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			]);

			// Baseline: without the option a fresh authoritative cache satisfies the refresh.
			const baseline = createModelManager({
				providerId: "refetch-test",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: fetchMock,
				cacheDbPath: path.join(tempDir, "baseline.db"),
			});
			await baseline.refresh("online");
			const seededCalls = fetchMock.mock.calls.length;
			const cached = await baseline.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBe(seededCalls);
			expect(cached.models.some(m => m.id === "syn:first")).toBe(true);

			// With the option the fetcher runs again and the new payload wins.
			const refetching = createModelManager({
				providerId: "refetch-test",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: fetchMock,
				alwaysRefetchDynamicModels: true,
				cacheDbPath: path.join(tempDir, "refetch.db"),
			});
			await refetching.refresh("online");
			const afterSeed = fetchMock.mock.calls.length;
			served = "syn:second";
			const fresh = await refetching.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBeGreaterThan(afterSeed);
			expect(fresh.models.some(m => m.id === "syn:second")).toBe(true);

			// Explicit offline still serves the cache without touching the network.
			const beforeOffline = fetchMock.mock.calls.length;
			const offline = await refetching.refresh("offline");
			expect(fetchMock.mock.calls.length).toBe(beforeOffline);
			expect(offline.models.some(m => m.id === "syn:second")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
