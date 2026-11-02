import { afterEach, describe, expect, it } from "bun:test";
import { Mnemopi } from "@oh-my-striped-pi/pi-mnemopi/core/memory";
import type { MnemopiLlmCompletion } from "@oh-my-striped-pi/pi-mnemopi/core/runtime-options";

const instances: Mnemopi[] = [];

afterEach(async () => {
	for (const memory of instances) {
		await memory.flushExtractions();
		memory.close();
	}
	instances.length = 0;
});

function makeMemory(llm: false | { complete: MnemopiLlmCompletion }): Mnemopi {
	const memory = new Mnemopi({
		sessionId: "extract-wiring",
		dbPath: ":memory:",
		llm: llm === false ? false : { enabled: true, complete: llm.complete },
	});
	instances.push(memory);
	return memory;
}

describe("remember(extract) wires the LLM fact extractor", () => {
	it("runs the configured completion and makes extracted facts recallable", async () => {
		let calls = 0;
		const memory = makeMemory({
			complete: prompt => {
				calls += 1;
				expect(prompt).toContain("dark roast");
				return "The user loves coffee\nThe user prefers dark roast";
			},
		});

		const id = memory.remember("I love coffee, especially dark roast.", {
			source: "test",
			extract: true,
		});
		expect(id).toBeTruthy();

		// Extraction is fired-and-forgotten by the synchronous `remember`; drain it.
		await memory.flushExtractions();

		expect(calls).toBe(1);
		expect(memory.beam.factRecall("coffee", 5).some(fact => fact.content.includes("coffee"))).toBe(true);
		expect(memory.beam.factRecall("dark roast", 5).some(fact => fact.content.includes("dark roast"))).toBe(true);
	});

	it("stores every plain-line fact past the fifth", async () => {
		const lines = Array.from({ length: 8 }, (_, index) => `Runbook step ${index + 1} restarts the gateway`);
		const memory = makeMemory({ complete: () => lines.join("\n") });

		const id = memory.remember("A long runbook memory with eight steps.", { source: "test", extract: true });
		await memory.flushExtractions();

		expect(memory.conn.query("SELECT object FROM facts WHERE source_msg_id = ? ORDER BY rowid").all(id)).toEqual(
			lines.map(object => ({ object })),
		);
	});

	it("routes structured LLM categories into MEMORIA and KG tables", async () => {
		let calls = 0;
		const memory = makeMemory({
			complete: () => {
				calls += 1;
				return JSON.stringify({
					facts: ["Ada works at Example Corp"],
					instructions: ["Always use tabs"],
					preferences: ["Dislikes blur + fade without slide"],
					timelines: ["2026-07-03 launch rehearsal"],
					kg: [{ subject: "Mnemopi", predicate: "uses", object: "SQLite" }],
				});
			},
		});

		memory.remember("Ada works at Example Corp and dislikes blur fades.", {
			source: "test",
			extract: true,
		});
		await memory.flushExtractions();

		expect(calls).toBe(1);
		expect(memory.conn.query("SELECT COUNT(*) AS count FROM memoria_instructions").get()).toEqual({ count: 1 });
		expect(memory.conn.query("SELECT COUNT(*) AS count FROM memoria_preferences").get()).toEqual({ count: 1 });
		expect(memory.conn.query("SELECT COUNT(*) AS count FROM memoria_timelines").get()).toEqual({ count: 1 });
		expect(memory.conn.query("SELECT COUNT(*) AS count FROM memoria_kg").get()).toEqual({ count: 1 });
		expect(memory.conn.query("SELECT COUNT(*) AS count FROM triples").get()).toEqual({ count: 1 });
		expect(memory.conn.query("SELECT instruction FROM memoria_instructions").get()).toEqual({
			instruction: "Always use tabs",
		});
		expect(memory.conn.query("SELECT preference FROM memoria_preferences").get()).toEqual({
			preference: "Dislikes blur + fade without slide",
		});
		expect(memory.conn.query("SELECT date, description FROM memoria_timelines").get()).toEqual({
			date: "2026-07-03",
			description: "2026-07-03 launch rehearsal",
		});
		expect(memory.conn.query("SELECT subject, predicate, object FROM memoria_kg").get()).toEqual({
			subject: "Mnemopi",
			predicate: "uses",
			object: "SQLite",
		});
		expect(
			memory.conn.query("SELECT subject, predicate, object FROM facts WHERE object = ?").get("Always use tabs"),
		).toEqual({ subject: "fact", predicate: "entity", object: "Always use tabs" });
	});

	it("uses extractText instead of stored content for background extraction", async () => {
		let prompt = "";
		const memory = makeMemory({
			complete: capturedPrompt => {
				prompt = capturedPrompt;
				return "The user prefers tabs";
			},
		});

		const stored =
			"[role: user]\nI prefer tabs.\n[user:end]\n\n[role: assistant]\nThe parser never initializes when reorder never activates.\n[assistant:end]";
		memory.remember(stored, {
			source: "test",
			extract: true,
			extractText: "[role: user]\nI prefer tabs.\n[user:end]",
		});
		await memory.flushExtractions();

		expect(prompt).toContain("I prefer tabs");
		expect(prompt).not.toContain("parser never initializes");
		expect(memory.beam.factRecall("tabs", 5).some(fact => fact.content === "The user prefers tabs")).toBe(true);
		expect(memory.beam.factRecall("initializes", 5)).toHaveLength(0);
	});

	it("does not invoke the extractor when extract is not requested", async () => {
		let calls = 0;
		const memory = makeMemory({
			complete: () => {
				calls += 1;
				return "The user loves coffee";
			},
		});

		memory.remember("I love coffee, especially dark roast.", { source: "test" });
		await memory.flushExtractions();

		expect(calls).toBe(0);
		expect(memory.beam.factRecall("coffee", 5)).toHaveLength(0);
	});

	it("stores the memory without throwing when extraction has no LLM", async () => {
		const memory = makeMemory(false);

		const id = memory.remember("Some opaque payload with no extractable facts: zzz qqq.", {
			source: "test",
			extract: true,
		});
		expect(id).toBeTruthy();

		// Must resolve cleanly even though no LLM is configured.
		await expect(memory.flushExtractions()).resolves.toBeUndefined();

		// The memory itself is still durably stored and recallable.
		const recalled = await memory.recall("opaque payload", 5);
		expect(recalled.some(row => row.id === id)).toBe(true);
	});
});
