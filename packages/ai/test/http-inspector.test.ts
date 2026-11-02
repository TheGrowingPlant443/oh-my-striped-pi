import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHttp400DumpPayload,
	pruneHttpRequestDumps,
	type RawHttpRequestDump,
	shouldDumpRejectedRequest,
} from "@oh-my-striped-pi/pi-ai/utils/http-inspector";

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const dump: RawHttpRequestDump = {
	provider: "github-copilot",
	api: "anthropic-messages",
	model: "claude-opus-4-8",
	method: "POST",
	url: "https://api.githubcopilot.com/v1/messages",
	headers: { "x-api-key": "secret-key", "content-type": "application/json" },
	body: { messages: [{ role: "user", content: "hi" }] },
};

describe("buildHttp400DumpPayload", () => {
	it("keeps request fields top-level and records the provider error response", () => {
		const message = "400 image exceeds 5 MB limit";
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, message), message);

		expect(payload.provider).toBe(dump.provider);
		expect(payload.url).toBe(dump.url);
		expect(payload.body).toEqual({ messages: [{ role: "user", content: "hi" }] });
		expect(payload.errorResponse).toEqual({ status: 400, message });
	});

	it("records the same message-derived status that enables dumping", () => {
		const message = "400 Bad Request: image exceeds 5 MB limit";
		const error = new Error(message);

		expect(shouldDumpRejectedRequest(error)).toBe(true);
		expect(buildHttp400DumpPayload(dump, error, message).errorResponse).toEqual({ status: 400, message });
	});

	it("redacts sensitive request headers while keeping the rest", () => {
		const payload = buildHttp400DumpPayload(dump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});

	it("redacts a query string carried by a configurable baseUrl", () => {
		const gatewayDump: RawHttpRequestDump = {
			...dump,
			url: "https://copilot.example.com/v1/messages?code=secret-token",
		};
		const payload = buildHttp400DumpPayload(gatewayDump, new HttpError(400, "x"), "x");

		expect(payload.url).not.toContain("secret-token");
		expect(payload.url).toBe("https://copilot.example.com/v1/messages[redacted-query]");
	});

	it("redacts provider-specific auth headers the fixed list never named", () => {
		const customHeadersDump: RawHttpRequestDump = {
			...dump,
			headers: {
				"x-goog-api-key": "AIzaSy-live-google-key",
				"x-amz-security-token": "aws-session-token",
				"content-type": "application/json",
			},
			body: dump.body,
		};
		const payload = buildHttp400DumpPayload(customHeadersDump, new HttpError(400, "x"), "x");

		expect(payload.headers?.["x-goog-api-key"]).toBe("[redacted]");
		expect(payload.headers?.["x-amz-security-token"]).toBe("[redacted]");
		expect(payload.headers?.["content-type"]).toBe("application/json");
	});
});

describe("shouldDumpRejectedRequest", () => {
	it("captures request-content rejections (400 bad request, 413 payload too large)", () => {
		expect(shouldDumpRejectedRequest(new HttpError(400, "bad request"))).toBe(true);
		expect(shouldDumpRejectedRequest(new HttpError(413, "payload too large"))).toBe(true);
	});

	it("skips auth, not-found, rate-limit, and retried 5xx errors that would spam dumps", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
			expect(shouldDumpRejectedRequest(new HttpError(status, "x"))).toBe(false);
		}
	});

	it("skips errors without an HTTP status", () => {
		expect(shouldDumpRejectedRequest(new Error("network reset"))).toBe(false);
	});
});

describe("pruneHttpRequestDumps", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	const DAY_MS = 24 * 60 * 60 * 1000;
	const now = Date.UTC(2026, 9, 1);

	async function writeDump(dir: string, name: string, bytes: number, ageMs: number): Promise<void> {
		const filePath = path.join(dir, name);
		await Bun.write(filePath, "x".repeat(bytes));
		const mtime = new Date(now - ageMs);
		await fs.utimes(filePath, mtime, mtime);
	}

	it("deletes dumps past the age limit and the oldest dumps beyond the size cap", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-http-dumps-"));
		roots.push(dir);
		await writeDump(dir, "newest.json", 400, 1_000);
		await writeDump(dir, "recent.json", 400, DAY_MS);
		await writeDump(dir, "older.json", 400, 2 * DAY_MS);
		await writeDump(dir, "expired.json", 10, 30 * DAY_MS);
		await writeDump(dir, "notes.txt", 5_000, 30 * DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000 });

		expect((await fs.readdir(dir)).sort()).toEqual(["newest.json", "notes.txt", "recent.json"]);
	});

	it("never deletes the dump it was asked to keep, even past the caps", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-http-dumps-keep-"));
		roots.push(dir);
		await writeDump(dir, "just-written.json", 2_000, 0);
		await writeDump(dir, "previous.json", 10, DAY_MS);

		await pruneHttpRequestDumps(dir, { now, maxAgeMs: 7 * DAY_MS, maxTotalBytes: 1_000, keep: "just-written.json" });

		expect(await fs.readdir(dir)).toEqual(["just-written.json"]);
	});
});
