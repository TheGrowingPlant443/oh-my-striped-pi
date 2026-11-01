import type { OAuthController, OAuthCredentials } from "../oauth/types";

export type LoginHook = (callbacks: OAuthController) => Promise<OAuthCredentials | string>;
export type RefreshHook = (credentials: OAuthCredentials, signal?: AbortSignal) => Promise<OAuthCredentials>;
export type Lazy<T> = () => Promise<T>;
export type HeadersHook = () => Record<string, string> | undefined;

export interface HookTables {
	login: Record<string, Lazy<LoginHook>>;
	refresh: Record<string, Lazy<RefreshHook>>;
	headers: Record<string, Lazy<HeadersHook>>;
}
