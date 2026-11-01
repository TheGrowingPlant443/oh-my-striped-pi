// oxlint-disable no-template-curly-in-string -- literal `${VAR}` is .npmrc syntax under test
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

describe("company-managed application updates", () => {
	it("runs the real CLI without release requests, installer discovery or executable replacement", async () => {
		using temp = TempDir.createSync("@omp-managed-update-");
		const home = temp.join("home");
		const bin = temp.join("bin");
		fs.mkdirSync(home);
		fs.mkdirSync(bin);
		const executable = path.join(bin, process.platform === "win32" ? "omp.exe" : "omp");
		const installed = "company-managed executable: do not replace\n";
		fs.writeFileSync(executable, installed, { mode: 0o755 });
		const npmrc = path.join(home, ".npmrc");
		const credentials =
			"registry=https://registry.invalid/\n//registry.invalid/:_authToken=${UNSET_MANAGED_UPDATE_TOKEN}\n";
		fs.writeFileSync(npmrc, credentials);
		const attempts = temp.join("attempts.jsonl");
		const preload = temp.join("tripwire.ts");
		await Bun.write(
			preload,
			`import { appendFileSync } from "node:fs";
const refuse = operation => (...args) => {
	appendFileSync(${JSON.stringify(attempts)}, JSON.stringify({ operation, argument: String(args[0]) }) + "\\n");
	throw new Error("Managed application update attempted " + operation);
};
globalThis.fetch = Object.assign(refuse("fetch"), { preconnect: refuse("preconnect") });
Bun.spawn = refuse("spawn");
Bun.spawnSync = refuse("spawnSync");
`,
		);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PATH: bin,
			PI_CODING_AGENT_DIR: path.join(home, "agent"),
			PI_CONFIG_DIR: path.join(home, "config"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_STATE_HOME: path.join(home, "state"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			NO_COLOR: "1",
		};
		const proc = Bun.spawn([process.execPath, "--preload", preload, cliEntry, "update", "--check"], {
			cwd: temp.path(),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, , stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(fs.existsSync(attempts)).toBe(false);
		expect(fs.readFileSync(executable, "utf8")).toBe(installed);
		expect(fs.readdirSync(bin)).toEqual([path.basename(executable)]);
		expect(fs.readFileSync(npmrc, "utf8")).toBe(credentials);
	}, 30_000);
});
