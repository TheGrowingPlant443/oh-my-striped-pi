import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-striped-pi/pi-coding-agent/internal-urls";
import { getDocsDiskRoot } from "@oh-my-striped-pi/pi-coding-agent/internal-urls/docs-index";

describe("OmpProtocolHandler", () => {
	it("treats omsp://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("omsp://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("omsp://tools/read.md");
		const prefixed = await router.resolve("omsp://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("locates a doc to the file the active corpus was read from", async () => {
		const router = InternalUrlRouter.instance();
		// A source checkout reads docs from disk; a bundled or embedded corpus
		// (e.g. after `gen:bundle`) has no file and must never link.
		const root = getDocsDiskRoot();
		const onDisk = root === null ? undefined : path.join(root, "tools", "read.md");

		// Both renderer entry points (sync read cards, async markdown links) must
		// agree on the file, or a link opens a doc `read` never resolved.
		expect(router.locateSync("omsp://tools/read.md")).toBe(onDisk);
		expect(router.locateSync("omsp://docs/tools/read.md:1-20")).toBe(onDisk);
		expect(await router.locate("omsp://tools/read.md")).toBe(onDisk ?? null);
	});

	it("never locates a URL that names no doc on disk", async () => {
		const router = InternalUrlRouter.instance();

		// The docs root is a listing, and an unknown doc has no file: linking it
		// would open something `omsp://` does not serve.
		expect(router.locateSync("omsp://")).toBeUndefined();
		expect(router.locateSync("omsp://docs")).toBeUndefined();
		expect(router.locateSync("omsp://no-such-doc.md")).toBeUndefined();
		expect(await router.locate("omsp://no-such-doc.md")).toBeNull();

		// Render paths must survive a model-authored traversal URL.
		expect(router.locateSync("omsp://../AGENTS.md")).toBeUndefined();
	});
});
