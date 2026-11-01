/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Collab
export const cfgCollabRelayUrl = register({
	id: "collab.relayUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Relay URL",
		description: "Explicit private relay used by /collab (wss://host[:port], or ws://localhost[:port])",
	},
});

export const cfgCollabWebUrl = register({
	id: "collab.webUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Web UI URL",
		description:
			"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
	},
});

export const cfgCollabDisplayName = register({
	id: "collab.displayName",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Display Name",
		description: "Name shown to other collab participants (default: OS username)",
	},
});

export const cfgCollabAutoStart = register({
	id: "collab.autoStart",
	type: "enum",
	values: ["off", "view", "control"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: "Auto Start",
		description:
			"Opt in to hosting interactive sessions through an explicitly configured collab.relayUrl; local discovery only",
		options: [
			{ value: "off", label: "Off", description: "Host only when /collab is run" },
			{ value: "view", label: "View", description: "Auto-host with read-only links in the local registry" },
			{ value: "control", label: "Control", description: "Auto-host with writable links in the local registry" },
		],
	},
});
