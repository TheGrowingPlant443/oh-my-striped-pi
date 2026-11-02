import {
	DEFAULT_SKILLS_URL,
	SKILL_NAME_MAX,
	SKILL_SPEC_RE,
	SKILLS_ROUTES,
	type SkillHome,
	type SkillPackument,
	type SkillSearchResponse,
	type SkillSearchSort,
	type SkillVersionManifest,
} from "@oh-my-striped-pi/pi-wire/skillshare";
import { Settings } from "../config/settings";

import { cfgSkillsRegistryUrl } from "../extensibility/settings";

/** A registry failure: HTTP status plus the server's `{error}` message (or a local auth failure as 401). */
export class SkillshareError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "SkillshareError";
		this.status = status;
	}
}

export interface SkillSpec {
	scope: string;
	name: string;
	/** Exact version, semver range, or dist-tag; absent when the spec has no `@…` suffix. */
	range?: string;
}

/** Parse `@scope/name[@range]`; null when the spec is not a registry package id. */
export function parseSkillSpec(spec: string): SkillSpec | null {
	const match = SKILL_SPEC_RE.exec(spec.trim());
	if (!match) return null;
	const [, scope, name, range] = match;
	if (name.length > SKILL_NAME_MAX) return null;
	return range === undefined ? { scope, name } : { scope, name, range };
}

export interface SkillshareClientOptions {
	/** Registry base URL; defaults to the `skills.registryUrl` setting, then {@link DEFAULT_SKILLS_URL}. */
	registryUrl?: string;
}

interface RequestOptions {
	query?: Record<string, string>;
}

function normalizeRegistryUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`invalid skill registry URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`skill registry URL must use http or https: ${raw}`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** HTTP client for a Skillshare registry (`skills.omp.sh`). */
export class SkillshareClient {
	/** Normalized registry base URL (no trailing slash). */
	readonly registryUrl: string;

	private constructor(registryUrl: string) {
		this.registryUrl = registryUrl;
	}

	static async create(options: SkillshareClientOptions = {}): Promise<SkillshareClient> {
		let registryUrl = options.registryUrl;
		if (!registryUrl) {
			const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
			registryUrl = cfgSkillsRegistryUrl.get(settings) || DEFAULT_SKILLS_URL;
		}
		return new SkillshareClient(normalizeRegistryUrl(registryUrl));
	}

	home(): Promise<SkillHome> {
		return this.#json<SkillHome>("GET", SKILLS_ROUTES.home);
	}

	search(query: string, options: { sort?: SkillSearchSort; page?: number } = {}): Promise<SkillSearchResponse> {
		const params: Record<string, string> = { q: query };
		if (options.sort) params.sort = options.sort;
		if (options.page !== undefined) params.page = String(options.page);
		return this.#json<SkillSearchResponse>("GET", SKILLS_ROUTES.search, { query: params });
	}

	packument(scope: string, name: string): Promise<SkillPackument> {
		return this.#json<SkillPackument>("GET", SKILLS_ROUTES.packument(scope, name));
	}

	version(scope: string, name: string, versionOrTag: string): Promise<SkillVersionManifest> {
		return this.#json<SkillVersionManifest>(
			"GET",
			SKILLS_ROUTES.version(scope, name, encodeURIComponent(versionOrTag)),
		);
	}

	/** Download the `.tgz`, following the 302 to storage. Integrity is the installer's job. */
	async tarball(scope: string, name: string, version: string): Promise<Uint8Array> {
		const response = await this.#fetch("GET", SKILLS_ROUTES.tarball(scope, name, encodeURIComponent(version)), {});
		return new Uint8Array(await response.arrayBuffer());
	}

	async #json<T>(method: string, route: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.#fetch(method, route, options);
		try {
			return (await response.json()) as T;
		} catch {
			throw new SkillshareError(response.status, `unexpected non-JSON response from ${this.registryUrl}`);
		}
	}

	async #fetch(method: string, route: string, options: RequestOptions): Promise<Response> {
		const url = new URL(`${this.registryUrl}${route}`);
		if (options.query) {
			for (const key in options.query) url.searchParams.set(key, options.query[key]);
		}
		const headers = { Accept: "application/json" };

		let response: Response;
		try {
			response = await fetch(url, { method, headers, redirect: "follow" });
		} catch (error) {
			throw new Error(
				`cannot reach skill registry ${this.registryUrl}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			const payload: unknown = await response.json().catch(() => null);
			const reason =
				payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
					? payload.error
					: `${response.status} ${response.statusText || "request failed"}`;
			throw new SkillshareError(response.status, reason);
		}
		return response;
	}
}
