import { describe, expect, test } from "bun:test";
import { shouldFilterBrowserMCPForPrelude } from "@oh-my-pi/pi-coding-agent/mcp/config";

describe("browser prelude MCP filtering", () => {
	test("filters only when unrestricted browser and Eval are all active", () => {
		expect(
			shouldFilterBrowserMCPForPrelude({
				restrictToolNames: false,
				browserEnabled: true,
				evalRegistered: true,
				evalActive: true,
			}),
		).toBe(true);
		for (const options of [
			{ restrictToolNames: false, browserEnabled: false, evalRegistered: true, evalActive: true },
			{ restrictToolNames: true, browserEnabled: true, evalRegistered: true, evalActive: true },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: false, evalActive: false },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: true, evalActive: false },
		]) {
			expect(shouldFilterBrowserMCPForPrelude(options)).toBe(false);
		}
	});
});
