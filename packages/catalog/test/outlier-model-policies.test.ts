import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { seedModels } from "../src/compat/providers";

describe("outlier catalog policies", () => {
	test("seed rules distinguish local speech, dictation, and tiny role candidates", () => {
		const local = Object.fromEntries(seedModels("local").map(spec => [spec.id, buildModel(spec)]));
		expect(local.kokoro?.kind).toBe("tts");
		expect(local["parakeet-tdt-0.6b-v3"]?.kind).toBe("stt");
		expect(local["nemotron-streaming-en-0.6b"]?.kind).toBe("stt");
		expect(local["whisper-large-v3-turbo"]?.kind).toBe("stt");
		expect(local["lfm2.5-230m"]?.kind).toBe("tiny");
	});
});
