/**
 * Explain managed application updates or update installed plugins.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as pluginCli from "../cli/plugin-cli";
import { updateHelp as commandHelp } from "../cli/command-help";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		check: Flags.boolean({ char: "c", description: "Preview plugin updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = ["omp update", "omp update --plugins", "omp update --plugins --check"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		if (flags.plugins) {
			await initTheme();
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: flags.check ? { dryRun: true } : {} });
		} else {
			console.log(
				"Application updates are company-managed. Use your company's Git/Nix/managed release process to update OMP. To update plugins, run `omp update --plugins` (add --check to preview).",
			);
		}
	}
}
