/**
 * Show provider usage limits for every authenticated account.
 */

import { Args, Command, Flags } from "@oh-my-striped-pi/pi-utils/cli";
import { usageHelp as commandHelp } from "../cli/command-help";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Optional subcommand to execute",
			required: false,
			options: ["invalidate", "clients", "accounts"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({
			char: "p",
			description: "Only show usage for this provider id",
		}),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
		history: Flags.boolean({
			description: "Show recorded usage-limit history (hourly snapshots) instead of a live snapshot",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "History window in days (with --history or clients)", default: 7 }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before fetching usage (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
	};

	static examples = [
		"# Detailed per-account usage breakdown across all providers\n  omsp usage",
		"# Only GitHub Copilot accounts\n  omsp usage --provider github-copilot",
		"# Redact account identifiers for screenshots\n  omsp usage --redact",
		"# Machine-readable output\n  omsp usage --json",
		"# Usage-limit trend over the last 30 days\n  omsp usage --history --days 30",
		"# Per-client token burn (which machine/app spent what) over the last 30 days\n  omsp usage clients --days 30",
		"# OAuth identity keys for task.agentAccountPools (no tokens)\n  omsp usage accounts",
		"# Invalidate cached usage reports for all providers\n  omsp usage invalidate",
		"# Invalidate cached usage reports for GitHub Copilot\n  omsp usage invalidate --provider github-copilot",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Usage);
		await runUsageCommand({
			action: args.action,
			json: flags.json,
			provider: flags.provider,
			redact: flags.redact,
			history: flags.history,
			days: flags.days,
			extensions: flags.extension,
			noExtensions: flags["no-extensions"],
		});
	}
}
