import type { CompiledAuthProvider } from "@oh-my-pi/pi-catalog/compat/types";
import { $pickenv } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { createApiKeyLogin } from "./engine/api-key";
import { HOOKS } from "./hooks";
import type { ProviderDefinition } from "./types";

/** Materialize declarative local/company auth and the retained Copilot hooks. */
export function buildProviderDefinition(policy: CompiledAuthProvider): ProviderDefinition {
	let login: ProviderDefinition["login"];
	if (policy.login?.kind === "api-key") {
		login = createApiKeyLogin(policy.login, policy.name);
	} else if (policy.login?.kind === "custom") {
		const hook = HOOKS.login[policy.login.hook];
		if (!hook) throw new AIError.ConfigurationError(`Unknown login hook for ${policy.id}`);
		login = async controller => (await hook())(controller);
	} else if (policy.login) {
		throw new AIError.ConfigurationError(`Unsupported login policy for ${policy.id}`);
	}
	let refreshToken: ProviderDefinition["refreshToken"];
	if (policy.refresh?.kind === "hook") {
		const hook = HOOKS.refresh[policy.refresh.hook];
		if (!hook) throw new AIError.ConfigurationError(`Unknown refresh hook for ${policy.id}`);
		refreshToken = async (credentials, signal) => (await hook())(credentials, signal);
	} else if (policy.refresh && policy.refresh.kind !== "none") {
		throw new AIError.ConfigurationError(`Unsupported refresh policy for ${policy.id}`);
	}
	if (policy.env && "hook" in policy.env) {
		throw new AIError.ConfigurationError(`Unknown environment hook for ${policy.id}`);
	}
	const envVars = policy.env?.vars;
	return {
		id: policy.id,
		name: policy.name,
		envKeys: envVars ? (envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars)) : undefined,
		allowsMissingApiKey: policy.allowsMissingApiKey,
		nativeAuthApis: policy.nativeAuthApis,
		available: policy.available,
		showInLoginList: policy.showInLoginList,
		storeCredentialsAs: policy.storeAs,
		callbackPort: policy.callbackPort,
		pasteCodeFlow: policy.pasteCode,
		login,
		refreshToken,
	};
}
