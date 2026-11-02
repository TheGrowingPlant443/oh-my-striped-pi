import { describe, expect, it } from "bun:test";
import { parseStatsDashboardArgs } from "../src/slash-commands/helpers/stats-dashboard";

describe("stats dashboard arguments", () => {
	it("normalizes explicit TCP port text and accepts an IPv6 bind host", () => {
		expect(parseStatsDashboardArgs(" --host=::1 -p 03850 ")).toEqual({ port: 3850, host: "::1" });
	});

	it("rejects out-of-range and nonnumeric ports before starting a listener", () => {
		for (const args of ["--port 65536", "--port=not-a-port"]) {
			expect(parseStatsDashboardArgs(args)).toMatchObject({ error: expect.any(String) });
		}
	});
});
