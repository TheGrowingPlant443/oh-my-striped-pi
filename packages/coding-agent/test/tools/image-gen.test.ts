import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";

const imageData = Buffer.from("company image").toString("base64");
const paths: string[] = [];
let storage: AuthStorage | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	storage?.close();
	storage = undefined;
	await Promise.all(paths.splice(0).map(path => fs.rm(path, { force: true })));
});

function imageModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		provider: "company",
		api: "openai-images",
		kind: "image",
		baseUrl: "https://images.company.example/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

async function context(models: Model[], fetch: FetchImpl): Promise<CustomToolContext> {
	storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime("company", "company-key");
	const settings = Settings.isolated({
		modelRoles: { image: "company/primary" },
		"retry.fallbackChains": { image: ["company/backup"] },
	});
	const registry = new ModelRegistry(storage, "/nonexistent/image-tool-models.yml", { settings });
	registry.getAvailable = () => models;
	registry.getAll = () => models;
	registry.find = (provider, id) => models.find(model => model.provider === provider && model.id === id);
	return {
		modelRegistry: registry,
		settings,
		fetch,
		sessionManager: SessionManager.inMemory("/tmp"),
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort() {},
	};
}

describe("configured company image generation tool", () => {
	it("honors an explicit model override, writes local output, and does not try the role chain", async () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		const ctx = await context([imageModel("primary"), imageModel("backup")], async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return Response.json({ data: [{ b64_json: imageData }] });
		});
		const result = await imageGenTool.execute(
			"image",
			{ subject: "company diagram", model: "company/backup" },
			undefined,
			ctx,
		);
		paths.push(...(result.details?.imagePaths ?? []));
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://images.company.example/v1/images/generations",
			body: { model: "backup" },
		});
		expect(result.details?.model).toBe("backup");
		expect(await fs.readFile(paths[0]!)).toEqual(Buffer.from("company image"));
	});

	it("continues the configured chain after an upstream HTTP refusal", async () => {
		const attempts: string[] = [];
		const ctx = await context([imageModel("primary"), imageModel("backup")], async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			attempts.push(body.model);
			return body.model === "primary"
				? Response.json({ error: { message: "unavailable" } }, { status: 400 })
				: Response.json({ data: [{ b64_json: imageData }] });
		});
		const result = await imageGenTool.execute("image", { subject: "company diagram" }, undefined, ctx);
		paths.push(...(result.details?.imagePaths ?? []));
		expect(attempts).toEqual(["primary", "backup"]);
		expect(result.details?.model).toBe("backup");
	});

	it("does not resolve credentials or headers when no endpoint was configured", async () => {
		const selected = { ...imageModel("primary"), baseUrl: "" };
		const ctx = await context([selected], async () => {
			throw new Error("unexpected fetch");
		});
		const resolver = vi.spyOn(ctx.modelRegistry, "resolver");
		const headers = vi.spyOn(ctx.modelRegistry, "resolveModelHeaders");
		await expect(imageGenTool.execute("image", { subject: "company diagram" }, undefined, ctx)).rejects.toThrow(
			"explicit endpoint required",
		);
		expect(resolver).not.toHaveBeenCalled();
		expect(headers).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"rejects a FIFO image input before reading or contacting the provider",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-special-file-"));
			const fifo = path.join(dir, "input.png");
			try {
				expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
				let fetchCalls = 0;
				const ctx = await context([imageModel("primary")], async () => {
					fetchCalls++;
					return Response.json({ data: [{ b64_json: imageData }] });
				});
				const outcome = await Promise.race([
					imageGenTool
						.execute(
							"special-image",
							{ subject: "edit", model: "company/primary", input: [{ path: fifo }] },
							undefined,
							ctx,
						)
						.then(
							() => undefined,
							error => error,
						),
					Bun.sleep(1_500).then(() => "HUNG" as const),
				]);
				expect(outcome).toBeInstanceOf(Error);
				expect(outcome).toHaveProperty(
					"message",
					`Cannot load '${fifo}': it is a FIFO, not a regular file or directory.`,
				);
				expect(fetchCalls).toBe(0);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		10_000,
	);
});
