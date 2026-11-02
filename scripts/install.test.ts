import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test.skipIf(process.platform === "win32")(
	"public installer refuses without changing an existing omp install",
	async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omsp-install-"));
		try {
			const binDir = path.join(home, ".local", "bin");
			const installDir = path.join(home, "install");
			const existingOmp = path.join(binDir, "omp");
			const sentinel = "existing omp installation\n";
			await fs.mkdir(binDir, { recursive: true });
			await fs.writeFile(existingOmp, sentinel);

			const proc = Bun.spawn(["sh", "scripts/install.sh", "--binary"], {
				cwd: path.join(import.meta.dir, ".."),
				env: { ...process.env, HOME: home, OMSP_INSTALL_DIR: installDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			expect(exitCode).not.toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toContain("does not provide a public installer");
			expect(stderr).toContain("nix build .#omsp");
			expect(await fs.readFile(existingOmp, "utf8")).toBe(sentinel);
			expect(await fs.readdir(binDir)).toEqual(["omp"]);
			expect(await fs.readdir(home)).toEqual([".local"]);
			expect(await Bun.file(path.join(installDir, "omsp")).exists()).toBe(false);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	},
);
