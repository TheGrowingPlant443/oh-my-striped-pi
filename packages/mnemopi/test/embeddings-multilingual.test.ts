import { describe, expect, it } from "bun:test";

import { embeddingDimFor } from "@oh-my-pi/pi-mnemopi/core/embeddings";

function withEnvValue<T>(key: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[key];
	try {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
}

describe("multilingual embedding metadata", () => {
	it("detects English, Chinese, multilingual, Jina, and OpenAI dimensions", () => {
		withEnvValue("MNEMOPI_EMBEDDING_DIM", undefined, () => {
			expect(embeddingDimFor("BAAI/bge-small-en-v1.5")).toBe(384);
			expect(embeddingDimFor("BAAI/bge-base-en-v1.5")).toBe(768);
			expect(embeddingDimFor("BAAI/bge-large-en-v1.5")).toBe(1024);
			expect(embeddingDimFor("BAAI/bge-small-zh-v1.5")).toBe(512);
			expect(embeddingDimFor("BAAI/bge-base-zh-v1.5")).toBe(768);
			expect(embeddingDimFor("BAAI/bge-large-zh-v1.5")).toBe(1024);
			expect(embeddingDimFor("intfloat/multilingual-e5-small")).toBe(384);
			expect(embeddingDimFor("intfloat/multilingual-e5-base")).toBe(768);
			expect(embeddingDimFor("intfloat/multilingual-e5-large")).toBe(1024);
			expect(embeddingDimFor("BAAI/bge-m3")).toBe(1024);
			expect(embeddingDimFor("jina-embeddings-v5-omni-nano")).toBe(768);
			expect(embeddingDimFor("jina-embeddings-v5-omni-small")).toBe(1024);
			expect(embeddingDimFor("openai/text-embedding-3-small")).toBe(1536);
			expect(embeddingDimFor("text-embedding-3-large")).toBe(3072);
			expect(embeddingDimFor("some/unknown-model")).toBe(384);
		});
	});
	it("allows MNEMOPI_EMBEDDING_DIM to override model dimensions", () => {
		withEnvValue("MNEMOPI_EMBEDDING_DIM", "768", () => {
			expect(embeddingDimFor("BAAI/bge-small-en-v1.5")).toBe(768);
			expect(embeddingDimFor("unknown-model")).toBe(768);
		});
	});
});
