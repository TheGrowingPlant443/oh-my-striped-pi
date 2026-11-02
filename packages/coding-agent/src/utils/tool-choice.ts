import type { Api, Model, ToolChoice } from "@oh-my-striped-pi/pi-ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Providers that only expose required/any forcing may still honor named choices by
 * narrowing their request tool list before transport.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages") {
		return { type: "tool", name: toolName };
	}

	if (model.api === "openai-responses" || model.api === "openai-completions") {
		// Both OpenAI transports drop tool_choice when the model has none and turn a
		// forced choice into "auto" when forcing is unsupported. Such a choice never
		// reaches the wire, so it must not be reported as a forced one.
		const compat = model.compat as { supportsToolChoice?: boolean; supportsForcedToolChoice?: boolean };
		if (compat?.supportsToolChoice === false || compat?.supportsForcedToolChoice === false) return undefined;
		return { type: "function", name: toolName };
	}

	return undefined;
}

/**
 * Whether the given tool choice can be satisfied by the active tool set for the
 * upcoming turn. Non-named choices (`"none"`, `"required"`, etc.) do not name a
 * specific tool and are therefore always active.
 */
export function isToolChoiceActive(toolChoice: ToolChoice | undefined, tools: readonly { name: string }[]): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	if (toolChoice.type === "computer") return tools.some(tool => tool.name === "computer");
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}
