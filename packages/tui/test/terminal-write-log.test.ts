import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ProcessTerminal } from "@oh-my-striped-pi/pi-tui/terminal";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

const originalWriteLog = Bun.env.OMSP_TUI_WRITE_LOG;

afterEach(() => {
	if (originalWriteLog === undefined) delete Bun.env.OMSP_TUI_WRITE_LOG;
	else Bun.env.OMSP_TUI_WRITE_LOG = originalWriteLog;
});

// The debug write log must not become a copy of the user's clipboard: copies
// reach the terminal as OSC 52, so the log keeps only the payload's length.
describe("OMSP_TUI_WRITE_LOG", () => {
	it.each([
		["BEL", "\x07"],
		["ST", "\x1b\\"],
	] as const)("records an OSC 52 clipboard write ended by %s as its payload length", async (_terminator, end) => {
		using dir = TempDir.createSync("@omsp-tui-write-log-");
		const logPath = path.join(dir.path(), "writes.log");
		Bun.env.OMSP_TUI_WRITE_LOG = logPath;
		const terminal = new ProcessTerminal({ conpty: false });

		terminal.write(`\x1b[2Kframe\x1b]52;c;c2VjcmV0${end}tail`);

		expect(await Bun.file(logPath).text()).toBe(`\x1b[2Kframe\x1b]52;c;<8 bytes>${end}tail`);
	});
});
