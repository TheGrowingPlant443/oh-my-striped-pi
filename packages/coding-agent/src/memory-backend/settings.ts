/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Memory backend selector — local storage or an explicitly configured private server.
// `memories.enabled` is migration input only; see config/settings.ts.
// Protocol hosts (RPC/ACP) start with memory off: embedders opt in through their own settings layer.
export const cfgMemoryBackend = register({
	id: "memory.backend",
	protocolDefault: ["rpc", "acp"],
	type: "enum",
	values: ["off", "local", "mnemopi", "hindsight", "sharpshooter"] as const,
	default: "off",
	ui: {
		tab: "memory",
		group: "General",
		label: "Memory Backend",
		description: "Off, local summaries, Mnemopi SQLite, private Hindsight, or project decision memory",
		options: [
			{ value: "off", label: "Off", description: "No memory subsystem runs" },
			{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
			{
				value: "mnemopi",
				label: "Mnemopi",
				description: "Local SQLite recall/retain backend with optional embeddings",
			},
			{ value: "hindsight", label: "Hindsight", description: "Explicitly configured private Hindsight server" },
			{ value: "sharpshooter", label: "Sharpshooter", description: "Project-local friction-earned decision memory" },
		],
	},
});
