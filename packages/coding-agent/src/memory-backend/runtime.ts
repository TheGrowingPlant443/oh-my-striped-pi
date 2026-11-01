import type { AgentSession } from "../session/agent-session";
import { resolveMemoryBackend } from "./resolve";
import { cfgMemoryBackend } from "./settings";
import type {
	MemoryBackendId,
	MemoryBackendOperationContext,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryRuntimeContext,
} from "./types";
export function createMemoryRuntimeContext(context: MemoryBackendOperationContext): MemoryRuntimeContext {
	const settings = context.session?.settings;
	return {
		async status() {
			if (!settings) {
				return {
					backend: "off" as const,
					active: false,
					writable: false,
					searchable: false,
					message: "No active agent session.",
				};
			}
			const backend = await resolveMemoryBackend(settings);
			return backend.status
				? await backend.status(context)
				: {
						backend: backend.id,
						active: backend.id !== "off",
						writable: false,
						searchable: false,
						message: "This memory backend does not expose structured status.",
					};
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			if (!settings) return unavailableSearch("off", query, "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			return backend.search
				? await backend.search(context, query, options)
				: unavailableSearch(backend.id, query, `Memory search is not available for the ${backend.id} backend.`);
		},
		async save(input: string | MemoryBackendSaveInput) {
			if (!settings) return unavailableSave("off", "No active agent session.");
			const backend = await resolveMemoryBackend(settings);
			const normalized = typeof input === "string" ? { content: input } : input;
			return backend.save
				? await backend.save(context, normalized)
				: unavailableSave(backend.id, `Memory save is not available for the ${backend.id} backend.`);
		},
	};
}

export function createSessionMemoryRuntimeContext(
	session: AgentSession,
	agentDir: string,
	cwd: string,
): MemoryRuntimeContext {
	return createMemoryRuntimeContext({ agentDir, cwd, session });
}

function unavailableSearch(backend: MemoryBackendId, query: string, message: string) {
	return { backend, query, count: 0, items: [], message };
}

function unavailableSave(backend: MemoryBackendId, message: string) {
	return { backend, stored: 0, message };
}

/** Re-route memory after a cwd change without retaining the old transcript in the new bank. */
export async function rebindMemoryBackendForCwd(session: AgentSession): Promise<void> {
	if (!session.memoryEnabled) return;
	await session.settleMemoryBackend();
	if (cfgMemoryBackend.get(session.settings) === "hindsight") {
		const { awaitPrimaryStateRebuild } = await import("../hindsight/backend");
		await awaitPrimaryStateRebuild(session);
		return;
	}
	await session.applyMemoryBackend({ retainMnemopi: false });
	if (cfgMemoryBackend.get(session.settings) === "mnemopi" && !session.getMnemopiSessionState()) {
		throw new Error("Mnemopi backend failed to initialise for the destination cwd.");
	}
}
