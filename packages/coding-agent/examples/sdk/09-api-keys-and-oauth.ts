/**
 * Copilot Credentials
 *
 * Run `omsp login github-copilot` first to populate the auth store.
 */
import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	discoverModels,
	ModelRegistry,
	SessionManager,
} from "@oh-my-striped-pi/pi-coding-agent";

// Default: discoverAuthStorage() uses ~/.omsp/agent/agent.db
// discoverModels() loads built-in models and overrides from ~/.omsp/agent/models.yml.
const authStorage = await discoverAuthStorage();
const modelRegistry = await discoverModels(authStorage);

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");

// Custom auth storage location
const customAuthStorage = await AuthStorage.create("/tmp/my-app/agent.db");
const customModelRegistry = await ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.yml");

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");

// Runtime Copilot credential override (not persisted to disk).
// The keyless local provider only serves tiny text, TTS, and STT workers.
authStorage.keys.setRuntime("github-copilot", Bun.env.COPILOT_GITHUB_TOKEN!);
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");

// Default registry using the standard configuration path.
// Removed persisted provider selectors fail rather than choosing Copilot.
const simpleRegistry = await ModelRegistry.create(authStorage);
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with the default model registry");
