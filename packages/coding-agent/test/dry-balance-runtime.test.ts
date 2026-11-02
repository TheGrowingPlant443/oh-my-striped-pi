import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-striped-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-striped-pi/pi-catalog/provider-models";
import { getModelDbPath, TempDir } from "@oh-my-striped-pi/pi-utils";
import { getTestModel } from "./helpers/model-fixtures";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

test("omsp dry-balance resolves credential-scoped models from the model cache", async () => {
	const tempDir = TempDir.createSync("@omsp-dry-balance-runtime-");
	const apiKey = "dry-balance-cache-test-key";
	const modelId = "cached-dry-balance-model";
	const bundled = getTestModel("github-copilot");
	const cacheDbPath = getModelDbPath(tempDir.path());
	await fs.mkdir(path.dirname(cacheDbPath), { recursive: true });
	try {
		writeModelCache(
			resolveModelCacheProviderId("github-copilot", { apiKey }),
			Date.now(),
			[
				buildModel({
					...bundled,
					id: modelId,
					name: "Cached Dry Balance Model",
				}),
			],
			true,
			"",
			cacheDbPath,
			[bundled],
			bundled.headers,
		);
		const child = Bun.spawn(
			[process.execPath, cliEntry, "dry-balance", `github-copilot/${modelId}`, "--count", "1", "--json"],
			{
				cwd: tempDir.path(),
				env: { ...process.env, NO_COLOR: "1", COPILOT_GITHUB_TOKEN: apiKey, OMSP_CODING_AGENT_DIR: tempDir.path() },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		// No OAuth account is stored, so the sample itself fails; resolving the model is the contract here.
		expect(stderr).toBe("");
		expect(JSON.parse(stdout).model).toBe(`github-copilot/${modelId}`);
	} finally {
		await tempDir.remove();
	}
});
