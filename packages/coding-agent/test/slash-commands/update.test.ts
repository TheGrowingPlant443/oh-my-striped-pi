import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-striped-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-striped-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-striped-pi/pi-utils";

function createRuntime(cwd: string, output: string[]) {
	return {
		ctx: {
			session: {},
			sessionManager: { getCwd: () => cwd },
			editor: { setText: () => {} },
			showStatus: (text: string) => output.push(text),
		} as unknown as InteractiveModeContext,
	};
}

describe("/update", () => {
	it("runs the managed update CLI instead of returning a model prompt", async () => {
		using temp = TempDir.createSync("@omsp-update-slash-");
		const output: string[] = [];
		const handled = await executeBuiltinSlashCommand("/update --help", createRuntime(temp.path(), output));
		expect(handled).toBe(true);
		const help = output.join("\n");
		expect(help).toContain("--check");
		expect(help).toContain("--plugins");
	});

	it("surfaces invalid updater arguments rather than sending them to the model", async () => {
		using temp = TempDir.createSync("@omsp-update-slash-error-");
		const output: string[] = [];
		await expect(
			executeBuiltinSlashCommand("/update --not-an-updater-option", createRuntime(temp.path(), output)),
		).rejects.toThrow("Update exited with code");
		expect(output.join("\n")).toContain("--not-an-updater-option");
	});
});
