/**
 * Shared grammar for `omsp://` docs scopes: which doc a URL names, and the
 * whole embedded corpus for the docs root (the handler's `enumerate`).
 */
import * as path from "node:path";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalUrl, ResolveContext } from "./types";

/** Host + path of an `omsp://` URL, exactly as the handler reads it; `""` when the URL names the docs root. */
export function ompDocFilename(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	return host ? (pathname && pathname !== "/" ? host + pathname : host) : "";
}

/**
 * Canonical doc path relative to `docs/` for an `omsp://` URL, or `""` for the
 * docs root (`omsp://`, `omsp:///`, `omsp://docs`, `omsp://docs/`). Throws on
 * absolute paths and `..` traversal — the rejections the handler reports.
 */
export function ompDocRel(url: InternalUrl): string {
	const filename = ompDocFilename(url);
	if (filename.length === 0) return "";
	if (path.isAbsolute(filename)) throw new Error("Absolute paths are not allowed in omsp:// URLs");
	const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error("Path traversal (..) is not allowed in omsp:// URLs");
	}
	if (normalized === "." || normalized === "docs") return "";
	return normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
}

/** One embedded doc of a `omsp://` root scope. */
interface OmpDocEntry {
	/** Canonical `omsp://<rel>` URL. */
	url: string;
	/** Doc text. */
	content: string;
}

/**
 * Every embedded doc for a root scope, in docs-index (sorted) order. Empty
 * when no docs corpus is reachable.
 */
export async function ompDocsScopeEntries(context?: ResolveContext): Promise<OmpDocEntry[]> {
	const entries: OmpDocEntry[] = [];
	for (const rel of getDocFilenames()) {
		context?.signal?.throwIfAborted();
		const content = await getEmbeddedDoc(rel);
		if (content === undefined) continue;
		entries.push({ url: `omsp://${rel}`, content });
	}
	return entries;
}
