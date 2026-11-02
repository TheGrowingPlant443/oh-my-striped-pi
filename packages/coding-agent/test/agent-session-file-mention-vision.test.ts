/**
 * `@image.png` mentions are image attachments: with `images.describeForTextModels`
 * a text-only model must receive the vision-role description, same as images sent
 * as prompt content (#16853).
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-striped-pi/pi-agent-core";
import { createMockModel } from "@oh-my-striped-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-striped-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-striped-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import * as imageVisionFallback from "@oh-my-striped-pi/pi-coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@oh-my-striped-pi/pi-utils";
import { toProviderModelConfig } from "./helpers/model-fixtures";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("describes an @-mentioned image for a text-only model", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-file-mention-vision-"));
	cleanups.push(() => removeWithRetries(dir));
	const imagePath = path.join(dir, "shot.png");
	await Bun.write(imagePath, Buffer.from(PNG_BASE64, "base64"));

	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("company-file-vision", "test-key");
	const textOnly = buildModel({
		id: "text-only",
		name: "Company text-only",
		provider: "company-file-vision",
		api: "openai-completions",
		baseUrl: "https://company.example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
	const modelRegistry = new ModelRegistry(authStorage);
	modelRegistry.registerProvider(textOnly.provider, {
		api: textOnly.api,
		baseUrl: textOnly.baseUrl,
		apiKey: "test-key",
		models: [toProviderModelConfig(textOnly)],
	});
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: textOnly, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry,
	});
	cleanups.push(() => session.dispose());
	const describe = spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockResolvedValue([
		{ type: "text", text: "a single grey pixel" },
	]);
	cleanups.push(() => describe.mockRestore());

	await session.prompt(`@${imagePath} what does this say?`);

	expect(describe).toHaveBeenCalledTimes(1);
	expect(describe.mock.calls[0]?.[0]).toHaveLength(1);
	expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("a single grey pixel");
});
