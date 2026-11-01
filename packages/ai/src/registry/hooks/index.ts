/** Lazy login and refresh hooks for the retained catalog auth policy. */
import { CUSTOM_LOGIN_HOOKS, CUSTOM_REFRESH_HOOKS } from "./custom";
import type { HookTables } from "./types";

export const HOOKS: HookTables = {
	login: CUSTOM_LOGIN_HOOKS,
	refresh: CUSTOM_REFRESH_HOOKS,
	headers: {},
};

export type * from "./types";
