/**
 * Wire contract for Skillshare (`skills.omp.sh`): an npm-style registry for
 * omsp skills. Shared by the omsp CLI (`omsp skill …`), the Go server
 * (`stencil/apps/skills`), and its web UI (which mirrors this file).
 *
 * Packages are scoped: `@scope/name`. A scope is a Stencil username claimed on
 * first publish and bound to the account's immutable `sub` forever (usernames
 * can be renamed and recycled; scopes cannot). `name` is the SKILL.md
 * frontmatter `name`. Published versions are immutable.
 *
 * Registry fields ride in SKILL.md `metadata` (the Agent Skills frontmatter is
 * closed to name/description/license/compatibility/metadata/allowed-tools):
 * `metadata.version` (semver, required to publish), `metadata.keywords`
 * (comma-separated), `metadata.repository`, `metadata.homepage`.
 */

/** Default registry; `skills.registryUrl` overrides it. */
export const DEFAULT_SKILLS_URL = "https://skills.omp.sh";

/** Registry skill names: ASCII kebab-case, 1–64 chars, no leading/trailing/double hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
/** `@scope/name`, optionally `@version-or-range-or-tag`. */
export const SKILL_SPEC_RE = /^@([a-z0-9][a-z0-9_]{2,31})\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(.+))?$/;

/** Archive limits enforced when installing skills. */
export const SKILL_LIMITS = {
	/** Compressed `.tgz` archive. */
	tarballBytes: 5 * 1024 * 1024,
	/** Sum of all file sizes after unpacking. */
	unpackedBytes: 20 * 1024 * 1024,
	files: 1000,
	/** Longest path inside the package. */
	pathLength: 255,
	descriptionLength: 1024,
	keywords: 20,
	keywordLength: 50,
	deprecationLength: 500,
} as const;

/** Public identity of an account: current username + avatar seed (hash of the immutable sub). */
export interface SkillUser {
	username: string;
	/** Hex seed for the generated dither avatar; never the raw sub. */
	avatar: string;
}

export interface SkillReportedProvenance {
	ompVersion: string;
	gitRemote?: string;
	gitCommit?: string;
}

/** Provenance proven by a verified GitHub Actions OIDC token. */
export interface SkillVerifiedProvenance {
	kind: "github-actions";
	repository: string;
	workflow: string;
	ref: string;
	sha: string;
	runUrl: string;
}

export interface SkillProvenance {
	publisher: SkillUser;
	/** Publish came from a registry token rather than an interactive login. */
	viaToken: boolean;
	reported?: SkillReportedProvenance;
	verified?: SkillVerifiedProvenance;
}

export interface SkillFile {
	/** POSIX path relative to the skill root. */
	path: string;
	size: number;
	/** Hex SHA-256 of the content. */
	sha256: string;
	executable: boolean;
}

/** One version as listed in a packument. */
export interface SkillVersionSummary {
	version: string;
	publishedAt: number;
	publisher: SkillUser;
	integrity: string;
	size: number;
	unpackedSize: number;
	fileCount: number;
	/** Ships executables or anything under `scripts/`. */
	hasScripts: boolean;
	yanked: boolean;
	deprecated?: string;
}

/** Daily download counts, oldest first: `[YYYY-MM-DD, count]`. */
export type SkillDownloadSeries = [day: string, count: number][];

/** `GET SKILLS_ROUTES.packument`: everything about a package. */
export interface SkillPackument {
	scope: string;
	name: string;
	/** From the `latest` version. */
	description: string;
	keywords: string[];
	license?: string;
	repository?: string;
	homepage?: string;
	owners: SkillUser[];
	/** e.g. `{ latest: "1.2.0", next: "2.0.0-beta.1" }`. */
	distTags: Record<string, string>;
	versions: Record<string, SkillVersionSummary>;
	createdAt: number;
	updatedAt: number;
	downloads: { weekly: number; total: number; daily: SkillDownloadSeries };
	/** Signed-in viewer may publish, tag, yank, deprecate, and manage owners. */
	canManage: boolean;
}

/** `GET SKILLS_ROUTES.version`: one immutable version. `:version` may be a dist-tag. */
export interface SkillVersionManifest extends SkillVersionSummary {
	scope: string;
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	allowedTools?: string;
	/** SKILL.md `metadata` verbatim. */
	metadata: Record<string, string>;
	keywords: string[];
	repository?: string;
	homepage?: string;
	files: SkillFile[];
	/** Package path rendered as the README (`README.md` if present, else `SKILL.md`). */
	readmePath: string;
	provenance: SkillProvenance;
}

/** `GET SKILLS_ROUTES.readme`: sanitized HTML rendered at publish time. */
export interface SkillReadme {
	html: string;
}

/** `GET SKILLS_ROUTES.source`: one file for the code viewer. */
export interface SkillSource {
	path: string;
	size: number;
	/** Binary or over the view limit: no `html`, offer `SKILLS_ROUTES.file` instead. */
	binary: boolean;
	tooLarge: boolean;
	/** Server-highlighted, sanitized HTML: one `<span class="line">` per line. */
	html?: string;
	lines?: number;
}

export interface SkillSearchHit {
	scope: string;
	name: string;
	description: string;
	keywords: string[];
	version: string;
	publisher: SkillUser;
	updatedAt: number;
	weeklyDownloads: number;
	deprecated?: string;
}

export type SkillSearchSort = "relevance" | "downloads" | "recent";

/** `GET SKILLS_ROUTES.search?q=&sort=&page=`. `q` accepts `owner:<scope>` and `keyword:<kw>` filters. */
export interface SkillSearchResponse {
	total: number;
	page: number;
	perPage: number;
	hits: SkillSearchHit[];
}

/** `GET SKILLS_ROUTES.home`. */
export interface SkillHome {
	stats: { packages: number; versions: number; publishers: number; weeklyDownloads: number };
	recent: SkillSearchHit[];
	popular: SkillSearchHit[];
	trending: SkillSearchHit[];
	keywords: [keyword: string, count: number][];
}

/** `GET SKILLS_ROUTES.user`: a user or org scope page. */
export interface SkillProfile {
	user: SkillUser;
	kind: "user" | "org";
	scopes: string[];
	packages: SkillSearchHit[];
	/** Orgs only. */
	members?: { user: SkillUser; role: SkillOrgRole }[];
}

export type SkillOrgRole = "owner" | "member";

/** `GET SKILLS_ROUTES.me`. */
export interface SkillSession {
	user: SkillUser | null;
	/** Sign-in is configured on this server. */
	login: boolean;
	admin: boolean;
}

/** Error body of every non-2xx JSON response. */
export interface SkillError {
	error: string;
}

const pkg = (scope: string, name: string) => `/api/v1/skills/@${scope}/${name}`;

/** Read-only HTTP routes, relative to the registry base URL. */
export const SKILLS_ROUTES = {
	home: "/api/v1/home",
	search: "/api/v1/search",
	packument: (scope: string, name: string) => pkg(scope, name),
	version: (scope: string, name: string, version: string) => `${pkg(scope, name)}/versions/${version}`,
	readme: (scope: string, name: string, version: string) => `${pkg(scope, name)}/versions/${version}/readme`,
	/** 302 to a signed R2 link; counts one download. */
	tarball: (scope: string, name: string, version: string) => `${pkg(scope, name)}/versions/${version}/tarball`,
	/** Raw file, same-origin: text as text/plain, sniffed raster images inline, everything else as an attachment. */
	file: (scope: string, name: string, version: string, path: string) =>
		`${pkg(scope, name)}/versions/${version}/files/${path}`,
	source: (scope: string, name: string, version: string, path: string) =>
		`${pkg(scope, name)}/versions/${version}/source/${path}`,
	user: (username: string) => `/api/v1/users/${username}`,
	me: "/api/me",
	/** Web pages. */
	pages: {
		package: (scope: string, name: string) => `/@${scope}/${name}`,
		user: (username: string) => `/~${username}`,
		search: (query: string) => `/search?q=${encodeURIComponent(query)}`,
	},
} as const;
