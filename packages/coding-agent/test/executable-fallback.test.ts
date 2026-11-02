import * as path from "node:path";
import * as utils from "@oh-my-striped-pi/pi-utils";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveCliEntryCmd, resolveExecutablePath, resolveWorkerSpawnCmd } from "../src/subprocess/worker-client";

describe("executable fallback on unlinked binary", () => {
	const originalExecPathDesc = Object.getOwnPropertyDescriptor(process, "execPath");
	const originalArgv0Desc = Object.getOwnPropertyDescriptor(process, "argv0");

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalExecPathDesc) {
			Object.defineProperty(process, "execPath", originalExecPathDesc);
		}
		if (originalArgv0Desc) {
			Object.defineProperty(process, "argv0", originalArgv0Desc);
		}
	});

	function setProcessProp(prop: "execPath" | "argv0", value: string): void {
		Object.defineProperty(process, prop, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	it("launches the healthy compiled binary without invoking fallback lookups", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		vi.spyOn(utils, "isExecutable").mockReturnValue(true);
		const whichSpy = vi.spyOn(utils, "$which");

		expect(resolveCliEntryCmd()).toEqual([process.execPath]);
		expect(resolveWorkerSpawnCmd("__omsp_worker_test")).toEqual({
			cmd: [process.execPath, "__omsp_worker_test"],
		});
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers original absolute launcher path over generic PATH match when executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		// The launcher must be fully qualified on the host platform: on Windows a rooted path
		// without a drive letter is drive-relative and intentionally not trusted.
		const root = process.platform === "win32" ? "C:" : "";
		const missingPath = `${root}/opt/homebrew/Cellar/omsp/18.1.8/bin/omsp`;
		const originalLauncher = `${root}/opt/homebrew/bin/omsp`;
		const otherOmpInPath = `${root}/usr/local/bin/omsp`;

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omsp") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === originalLauncher || p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([originalLauncher]);
		expect(resolveWorkerSpawnCmd("__omsp_worker_test")).toEqual({
			cmd: [originalLauncher, "__omsp_worker_test"],
		});
	});

	it("falls back to PATH when original absolute launcher exists but is not executable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omsp/18.1.8/bin/omsp";
		const originalLauncher = "/opt/homebrew/bin/omsp";
		const otherOmpInPath = "/usr/local/bin/omsp";

		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", originalLauncher);

		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omsp") return otherOmpInPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			// Launcher is not executable (e.g. root-owned, mode 0644, or directory)
			return p === otherOmpInPath;
		});

		expect(resolveCliEntryCmd()).toEqual([otherOmpInPath]);
		expect(resolveWorkerSpawnCmd("__omsp_worker_test")).toEqual({
			cmd: [otherOmpInPath, "__omsp_worker_test"],
		});
	});

	it("does not resolve relative argv0 against the working tree", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omsp/18.1.8/bin/omsp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "./omsp");

		const cwdRogueBinary = path.resolve("./omsp");
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === cwdRogueBinary;
		});

		// Relative argv0 must never resolve against cwd; falls back to missingPath gracefully
		expect(resolveExecutablePath()).toBe(missingPath);
	});

	it("does not treat Windows drive-relative paths (e.g. C:omsp) as bare commands", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "C:\\Tools\\omsp.exe";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "C:omsp");

		let whichCalledWith: string | undefined;
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			whichCalledWith = cmd;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		resolveExecutablePath();

		// Should not pass "C:omsp" to which as a bare name; only "omsp" generic fallback is queried
		expect(whichCalledWith).toBe("omsp");
	});

	it("falls back to $which('omsp') when original execPath was unlinked and argv0 has no path", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/opt/homebrew/Cellar/omsp/18.1.8/bin/omsp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "omsp");

		const mockUpgradedPath = "/opt/homebrew/bin/omsp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "omsp") return mockUpgradedPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockUpgradedPath;
		});

		expect(resolveCliEntryCmd()).toEqual([mockUpgradedPath]);
		expect(resolveWorkerSpawnCmd("__omsp_worker_test")).toEqual({
			cmd: [mockUpgradedPath, "__omsp_worker_test"],
		});
	});

	it("falls back to process.argv0 when $which('omsp') is unavailable", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/custom/install/bin/omsp";
		setProcessProp("execPath", missingPath);
		setProcessProp("argv0", "my-omsp");

		const mockCustomPath = "/usr/local/bin/my-omsp";
		vi.spyOn(utils, "$which").mockImplementation((cmd: string) => {
			if (cmd === "my-omsp") return mockCustomPath;
			return null;
		});
		vi.spyOn(utils, "isExecutable").mockImplementation((p: string) => {
			return p === mockCustomPath;
		});

		expect(resolveExecutablePath()).toBe(mockCustomPath);
	});

	it("does not perform fallback lookup when isCompiledBinary is false", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(false);
		const missingPath = "/opt/homebrew/Cellar/omsp/18.1.8/bin/omsp";
		setProcessProp("execPath", missingPath);

		const whichSpy = vi.spyOn(utils, "$which");
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		const resolved = resolveExecutablePath();
		expect(whichSpy).not.toHaveBeenCalled();
		expect(resolved).toBe(missingPath);
	});

	it("returns original execPath gracefully if no fallback candidate exists", () => {
		vi.spyOn(utils, "isCompiledBinary").mockReturnValue(true);
		const missingPath = "/nonexistent/omsp";
		setProcessProp("execPath", missingPath);
		vi.spyOn(utils, "$which").mockReturnValue(null);
		vi.spyOn(utils, "isExecutable").mockReturnValue(false);

		expect(resolveExecutablePath()).toBe(missingPath);
	});
});
