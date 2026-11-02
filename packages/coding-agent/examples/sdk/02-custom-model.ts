/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 */
import { ThinkingLevel } from "@oh-my-striped-pi/pi-agent-core";
import { getModel } from "@oh-my-striped-pi/pi-ai";
import { createAgentSession, discoverAuthStorage, discoverModels } from "@oh-my-striped-pi/pi-coding-agent";

// Set up auth storage and model registry
const authStorage = await discoverAuthStorage();
const modelRegistry = await discoverModels(authStorage);

// Select a concrete Copilot model; upstream families are not provider IDs.
const model = getModel("github-copilot", "gpt-5.5");
if (model) {
	console.log(`Found model: ${model.provider}/${model.id}`);
}

// Registry lookup includes overrides from models.yml.
const configuredModel = modelRegistry.find("github-copilot", "gpt-5.5");
if (configuredModel) {
	console.log(`Found model: ${configuredModel.provider}/${configuredModel.id}`);
}

// Available models have configured auth or are keyless local tiny/TTS/STT workers.
const available = modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map(m => `${m.provider}/${m.id}`),
);

if (configuredModel) {
	const { session } = await createAgentSession({
		model: configuredModel,
		thinkingLevel: ThinkingLevel.Medium, // off, low, medium, high
		authStorage,
		modelRegistry,
	});

	session.subscribe(event => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("Say hello in one sentence.");
	console.log();
}
