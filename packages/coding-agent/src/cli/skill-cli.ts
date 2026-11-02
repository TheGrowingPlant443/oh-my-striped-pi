/**
 * `omsp skill <action>` handlers for installing and discovering skills.
 */
import { CliUsageError } from "@oh-my-striped-pi/pi-utils/cli";
import type { SkillSearchSort } from "@oh-my-striped-pi/pi-wire/skillshare";
import { installSkills, searchSkills, showSkillInfo, uninstallSkills, updateSkills } from "../skillshare/installer";
import { handleSkillList } from "./skill-list";

export type SkillAction = "install" | "update" | "uninstall" | "search" | "info" | "list";

export const SKILL_ACTIONS: readonly SkillAction[] = ["install", "update", "uninstall", "search", "info", "list"];

export interface SkillCommandArgs {
	action: SkillAction;
	args: string[];
	cwd: string;
	flags: {
		global?: boolean;
		yes?: boolean;
		json?: boolean;
		sort?: SkillSearchSort;
	};
}

export const SKILL_USAGE = `Usage: omsp skill <action> [...]

Install and discover:
  install [@scope/name[@range]...] [-g] [--yes]   Install skills (no specs: install from skills.json)
  update [name...] [-g] [--yes]                   Update installed skills within their ranges
  uninstall <name...> [-g]                        Remove installed skills
  search <query> [--sort relevance|downloads|recent] [--json]
  info <@scope/name[@version]> [--json]
  list [dir] [--json]                             Skills a session in dir resolves, with warnings
`;

async function dispatch(cmd: SkillCommandArgs): Promise<number> {
	const { args, flags, cwd } = cmd;
	switch (cmd.action) {
		case "install":
			return installSkills({ specs: args, global: flags.global === true, yes: flags.yes === true, cwd });
		case "update":
			return updateSkills({ names: args, global: flags.global === true, yes: flags.yes === true, cwd });
		case "uninstall":
			if (args.length === 0) throw new CliUsageError("usage: omsp skill uninstall <name...> [-g]");
			return uninstallSkills({ names: args, global: flags.global === true, cwd });
		case "search": {
			const query = args.join(" ").trim();
			if (!query) throw new CliUsageError("usage: omsp skill search <query>");
			return searchSkills({ query, sort: flags.sort ?? "relevance", json: flags.json === true });
		}
		case "list":
			return handleSkillList(args, cwd, flags.json === true);
		case "info": {
			const spec = args[0];
			if (!spec) throw new CliUsageError("usage: omsp skill info <@scope/name[@version]>");
			return showSkillInfo({ spec, json: flags.json === true });
		}
	}
}

/**
 * Run one `omsp skill` action and return the process exit code. Usage mistakes
 * propagate as {@link CliUsageError}; registry and validation failures are
 * printed as `skill <action>: <message>` and yield 1.
 */
export async function runSkillCommand(cmd: SkillCommandArgs): Promise<number> {
	try {
		return await dispatch(cmd);
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`skill ${cmd.action}: ${message}\n`);
		return 1;
	}
}
