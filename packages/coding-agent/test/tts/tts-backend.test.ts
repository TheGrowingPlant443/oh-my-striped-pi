import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { FetchImpl, Model } from "@oh-my-striped-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-striped-pi/pi-catalog/models";
import { buildModel } from "@oh-my-striped-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-striped-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-striped-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-striped-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AuthStorage } from "@oh-my-striped-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-striped-pi/pi-coding-agent/session/session-manager";
import { resolveSpeechCandidates, ttsTool } from "@oh-my-striped-pi/pi-coding-agent/tools/tts";
import { ttsClient } from "@oh-my-striped-pi/pi-coding-agent/tts/tts-client";

function requireModel(provider: GeneratedProvider, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model: ${provider}/${id}`);
	return model;
}

function createContext(
	settings: Settings,
	modelRegistry: ModelRegistry,
	cwd: string,
	fetchImpl: FetchImpl,
): CustomToolContext {
	return {
		sessionManager: SessionManager.create(cwd, cwd),
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort() {},
		settings,
		fetch: fetchImpl,
	};
}

const local = requireModel("local", "kokoro");

let authStorage: AuthStorage;
let tempDir: string;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omsp-tts-chain-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	authStorage.close();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("speech role candidate ordering", () => {
	test("selects the default local speech model", async () => {
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });

		expect(resolveSpeechCandidates(settings, registry).map(candidate => candidate.model)).toEqual([local]);
	});

	test("keeps an explicitly configured local candidate", async () => {
		const settings = Settings.isolated({ modelRoles: { speech: "local/kokoro" } });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });

		const candidates = resolveSpeechCandidates(settings, registry);
		expect(candidates.map(candidate => candidate.model)).toEqual([local]);
		expect(candidates.map(candidate => candidate.explicit)).toEqual([true]);
	});
});

describe("tts speech chain execution", () => {
	test("uses the default local model for WAV output at the configured speed", async () => {
		const settings = Settings.isolated({ "tts.localSpeed": 1.5 });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0, 0.25, -0.25]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => {
			throw new Error("Cloud fetch must not run for default WAV output");
		};

		const result = await ttsTool.execute(
			"tts-local",
			{ text: "Hello locally", output_path: "voice.wav" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "local-inference", voiceId: "kokoro/af_heart", codec: "wav" });
		expect(localSynthesis).toHaveBeenCalledWith("kokoro", "Hello locally", {
			voice: "af_heart",
			speed: 1.5,
			signal: undefined,
		});
		expect(fs.existsSync(path.join(tempDir, "voice.wav"))).toBe(true);
	});

	test("uses an explicitly configured company speech endpoint without changing role order", async () => {
		const remote = buildModel({
			id: "kokoro-company",
			name: "Company Kokoro",
			provider: "company",
			api: "openai-speech",
			baseUrl: "https://speech.company.example/v1",
			kind: "tts",
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
		authStorage.keys.setRuntime("company", "company-key");
		const settings = Settings.isolated({ modelRoles: { speech: "company/kokoro-company" } });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		registry.getAvailable = () => [remote, local];
		registry.getAll = () => [remote, local];
		registry.find = (provider, id) => [remote, local].find(model => model.provider === provider && model.id === id);
		const requests: Array<{ url: string; body: unknown }> = [];
		const result = await ttsTool.execute(
			"tts-company",
			{ text: "Hello company", voice_id: "company-voice", output_path: "company.mp3" },
			undefined,
			createContext(settings, registry, tempDir, async (url, init) => {
				requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return new Response(new Uint8Array([1, 2, 3]));
			}),
		);
		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "openai-speech", voiceId: "company-voice", codec: "mp3" });
		expect(requests).toEqual([
			{
				url: "https://speech.company.example/v1/audio/speech",
				body: {
					model: "kokoro-company",
					input: "Hello company",
					response_format: "mp3",
					voice: "company-voice",
				},
			},
		]);
		expect(fs.readFileSync(path.join(tempDir, "company.mp3"))).toEqual(Buffer.from([1, 2, 3]));
	});

	const companySpeech = () =>
		buildModel({
			id: "kokoro-company",
			name: "Company Kokoro",
			provider: "company",
			api: "openai-speech",
			baseUrl: "https://speech.company.example/v1",
			kind: "tts",
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});

	function companyRegistry(fallbackChain: string[]): { settings: Settings; registry: ModelRegistry } {
		const remote = companySpeech();
		authStorage.keys.setRuntime("company", "company-key");
		const settings = Settings.isolated({
			modelRoles: { speech: "company/kokoro-company" },
			"retry.fallbackChains": { speech: fallbackChain },
		});
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		registry.getAvailable = () => [remote, local];
		registry.getAll = () => [remote, local];
		registry.find = (provider, id) => [remote, local].find(model => model.provider === provider && model.id === id);
		return { settings, registry };
	}

	test("does not fall back when the explicit speech fallback chain is empty", async () => {
		const { settings, registry } = companyRegistry([]);
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => new Response("temporarily unavailable", { status: 503 });

		const result = await ttsTool.execute(
			"tts-explicit",
			{ text: "No fallback", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).toBe(true);
		expect(localSynthesis).not.toHaveBeenCalled();
	});

	test("advances from a company endpoint HTTP error to the next local candidate", async () => {
		const { settings, registry } = companyRegistry(["local/kokoro"]);
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0, 0.5, -0.5]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => new Response("rate limited", { status: 429 });

		const result = await ttsTool.execute(
			"tts-remote-fallback",
			{ text: "Fall back locally", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "local-inference", codec: "wav" });
		expect(localSynthesis).toHaveBeenCalledWith("kokoro", "Fall back locally", {
			voice: "af_heart",
			speed: 1,
			signal: undefined,
		});
		expect(fs.existsSync(path.join(tempDir, "voice.wav"))).toBe(true);
	});

	test("writes local WAV output for a non-WAV path", async () => {
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		const localSynthesis = spyOn(ttsClient, "synthesize").mockResolvedValue({
			pcm: new Float32Array([0, 0.5, -0.5]),
			sampleRate: 24_000,
		});
		const fetchImpl: FetchImpl = async () => new Response("rate limited", { status: 429 });

		const result = await ttsTool.execute(
			"tts-fallback",
			{ text: "Fall back locally", output_path: "voice.mp3" },
			undefined,
			createContext(settings, registry, tempDir, fetchImpl),
		);

		expect(result.isError).not.toBe(true);
		expect(result.details).toMatchObject({ backend: "local-inference", codec: "wav" });
		expect(localSynthesis).toHaveBeenCalledWith("kokoro", "Fall back locally", {
			voice: "af_heart",
			speed: 1,
			signal: undefined,
		});
		expect(fs.existsSync(path.join(tempDir, "voice.wav"))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "voice.mp3"))).toBe(false);
	});
});
