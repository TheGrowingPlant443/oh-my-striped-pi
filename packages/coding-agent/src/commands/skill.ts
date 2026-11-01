/**
 * Install and discover skills on a Skillshare registry (skills.omp.sh).
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import type { SkillSearchSort } from "@oh-my-pi/pi-wire/skillshare";
import { skillHelp as commandHelp } from "../cli/command-help";
import { runSkillCommand, SKILL_ACTIONS, SKILL_USAGE, type SkillAction } from "../cli/skill-cli";

export default class Skill extends Command {
	static description = commandHelp.description;
	static aliases = ["skills"];

	static args = {
		action: Args.string({ description: "Skill action", required: false, options: SKILL_ACTIONS }),
		targets: Args.string({
			description: "Specs, names, directories, or action arguments",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		global: Flags.boolean({ char: "g", description: "Use the user-global skills.json (install/update/uninstall)" }),
		yes: Flags.boolean({ char: "y", description: "Install or update skills that ship scripts without asking" }),
		json: Flags.boolean({ description: "Output JSON (search, info, list)" }),
		sort: Flags.string({ description: "Search order", options: ["relevance", "downloads", "recent"] }),
	};

	static examples = [
		"omp skill install @alice/pdf-tools",
		"omp skill install -g @alice/pdf-tools@^1.2",
		'omp skill search "pdf" --sort downloads',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skill);
		if (!args.action) {
			process.stdout.write(SKILL_USAGE);
			return;
		}
		const exitCode = await runSkillCommand({
			action: args.action as SkillAction,
			args: args.targets ?? [],
			cwd: process.cwd(),
			flags: {
				global: flags.global,
				yes: flags.yes,
				json: flags.json,
				sort: flags.sort as SkillSearchSort | undefined,
			},
		});
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
