import assert from "node:assert/strict";
import { registerCustomApi } from "../../src/api-registry";
import { createMockModel } from "../../src/providers/mock";
import { complete, completeSimple } from "../../src/stream";
import type { AssistantMessage, AssistantMessageEvent } from "../../src/types";
import { AssistantMessageEventStream } from "../../src/utils/event-stream";

const completion = process.argv[2] === "complete" ? complete : completeSimple;
const model = createMockModel().model;
const response = new AssistantMessageEventStream();
const started = Promise.withResolvers<void>();
registerCustomApi(model.api, () => {
	started.resolve();
	return response;
});

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "first second" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

// Capture each layer's early events: projection may replace provider event identities.
const references: WeakRef<AssistantMessageEvent>[] = [];
const emittedCounts = new WeakMap<AssistantMessageEventStream, number>();
const originalPush = AssistantMessageEventStream.prototype.push;
AssistantMessageEventStream.prototype.push = function (event: AssistantMessageEvent): void {
	const count = emittedCounts.get(this) ?? 0;
	emittedCounts.set(this, count + 1);
	if (count < 3) references.push(new WeakRef(event));
	originalPush.call(this, event);
};

function emit(): void {
	const events: AssistantMessageEvent[] = [
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "first ", partial: message },
	];
	for (const event of events) response.push(event);
	// An async iterator may retain its latest yield while waiting for the next event.
	response.push({ type: "text_delta", contentIndex: 0, delta: "second", partial: message });
}

let settled = false;
const result = completion(model, { messages: [{ role: "user", content: "go", timestamp: 0 }] });
void result.then(
	() => {
		settled = true;
		started.reject(new Error("completion settled before provider dispatch"));
	},
	error => {
		settled = true;
		started.reject(error);
	},
);
await started.promise;
emit();
const deadline = performance.now() + 5_000;
let collected = false;
do {
	// WeakRef targets survive the job that dereferences them; collect in a later turn.
	await Bun.sleep(0);
	Bun.gc(true);
	collected = references.every(reference => reference.deref() === undefined);
} while (!collected && performance.now() < deadline);
assert.equal(settled, false, "completion settled before the producer sent a terminal event");
assert.equal(collected, true, "completion retained earlier events while the producer was paused");
assert.ok(references.length >= 3, "producer events were not observed");
AssistantMessageEventStream.prototype.push = originalPush;

if (process.argv[3] === "failure") {
	const failure = new Error("producer disconnected before completion");
	response.fail(failure);
	await assert.rejects(result, error => error === failure);
} else {
	response.push({ type: "done", reason: "stop", message });
	response.end();
	assert.deepEqual((await result).content, [{ type: "text", text: "first second" }]);
	assert.equal((await result).stopReason, "stop");
}
process.stdout.write("verified\n");
