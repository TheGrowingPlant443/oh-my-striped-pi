/**
 * Whole-flow hooks: `login "custom" hook=…` and `refresh hook=…` for providers
 * whose flow is not expressible in the declarative grammar.
 */
import type { Lazy, LoginHook, RefreshHook } from "./types";

export const CUSTOM_LOGIN_HOOKS: Record<string, Lazy<LoginHook>> = {
	"github-copilot": () => import("../oauth/github-copilot").then(module => module.loginGitHubCopilotHook),
};
export const CUSTOM_REFRESH_HOOKS: Record<string, Lazy<RefreshHook>> = {
	"github-copilot": () => import("../oauth/github-copilot").then(module => module.refreshGitHubCopilotHook),
};
