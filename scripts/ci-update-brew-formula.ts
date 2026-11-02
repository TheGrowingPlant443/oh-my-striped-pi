#!/usr/bin/env bun
//
// Render the Homebrew formula for `omsp` from a GitHub release and write it to
// a tap checkout. Each formula target points at the release asset with the
// sha256 listed in the release's SHA256SUMS.txt, so the formula never drifts
// from the shipped binaries. Fails when the release lacks a formula target.
//
// Usage:
//   bun scripts/ci-update-brew-formula.ts <tag> --out <path/to/Formula/omsp.rb>
//   bun scripts/ci-update-brew-formula.ts v18.8.9        # prints to stdout

if (import.meta.main) {
	throw new Error(
		"Public Homebrew distribution is disabled for oh-my-striped-pi. Build from the source checkout or with Nix.",
	);
}

const HOMEPAGE = "https://github.com/TheGrowingPlant443/oh-my-striped-pi";
const DESC = "Coding agent with the IDE wired in";
const RELEASE_DOWNLOAD_URL = "https://github.com/TheGrowingPlant443/oh-my-striped-pi/releases/download";

/** Release asset name of each formula stanza. */
const FORMULA_TARGETS = {
	macosArm: "omsp-darwin-arm64",
	macosIntel: "omsp-darwin-x64",
	linuxArm: "omsp-linux-arm64",
	linuxIntel: "omsp-linux-x64",
} as const;

type FormulaTarget = keyof typeof FORMULA_TARGETS;

/** A formula `url` stanza: where Homebrew downloads the binary and its sha256. */
export interface FormulaFile {
	url: string;
	sha256: string;
}

function parseArgs(argv: readonly string[]): {
	tag: string;
	out: string | null;
} {
	const rest = [...argv];
	let out: string | null = null;
	const outIdx = rest.indexOf("--out");
	if (outIdx >= 0) {
		out = rest[outIdx + 1] ?? null;
		if (!out) throw new Error("--out requires a path");
		rest.splice(outIdx, 2);
	}
	const tag = rest.find(a => !a.startsWith("--"));
	if (!tag) throw new Error("usage: ci-update-brew-formula.ts <tag> [--out <file>]");
	return { tag, out };
}

/** The formula file for `asset` of `tag`, hashed per the release's SHA256SUMS.txt. */
function resolveFile(tag: string, asset: string, sums: string): FormulaFile {
	const line = sums.split("\n").find(l => l.endsWith(`  ${asset}`));
	const sha256 = line?.split("  ")[0] ?? "";
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`SHA256SUMS.txt of ${tag} has no sha256 for ${asset}`);
	return { url: `${RELEASE_DOWNLOAD_URL}/${tag}/${asset}`, sha256 };
}

// `${...}` is JS interpolation; the literal `#{bin}` below is a Ruby
// interpolation Homebrew resolves when it evaluates the formula.
export function renderFormula(version: string, files: Record<FormulaTarget, FormulaFile>): string {
	// Each `url` carries `using: :nounzip` because the build files are bare
	// Mach-O/ELF executables, not archives. Without it Homebrew's default
	// CurlDownloadStrategy routes through UnpackStrategy::Uncompressed#extract_nestedly,
	// which nests the file outside the staging CWD; `Dir["omsp-*"].first` then
	// returns `nil` and `bin.install nil => "omsp"` raises.
	//
	// `with_env(HOME: buildpath)` redirects the CLI's `os.homedir()` lookup to
	// the writable staging dir so `generate_completions_from_executable` does
	// not touch the real `/Users/<user>/.omsp` (denied by Homebrew's sandbox
	// profile, which would otherwise fail the popen).
	return `class Omp < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${files.macosArm.url}",
          using: :nounzip
      sha256 "${files.macosArm.sha256}"
    end
    on_intel do
      url "${files.macosIntel.url}",
          using: :nounzip
      sha256 "${files.macosIntel.sha256}"
    end
  end

  on_linux do
    on_arm do
      url "${files.linuxArm.url}",
          using: :nounzip
      sha256 "${files.linuxArm.sha256}"
    end
    on_intel do
      url "${files.linuxIntel.url}",
          using: :nounzip
      sha256 "${files.linuxIntel.sha256}"
    end
  end

  def install
    bin.install Dir["omsp-*"].first => "omsp"
    (bin/"omsp").chmod 0555
    with_env(HOME: buildpath) do
      generate_completions_from_executable(bin/"omsp", "completions", shells: [:bash, :zsh, :fish])
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/omsp --version")
  end
end
`;
}

async function main(): Promise<void> {
	const { tag, out } = parseArgs(process.argv.slice(2));
	const version = tag.replace(/^v/, "");

	const sumsUrl = `${RELEASE_DOWNLOAD_URL}/${tag}/SHA256SUMS.txt`;
	const response = await fetch(sumsUrl);
	if (!response.ok) throw new Error(`${sumsUrl}: HTTP ${response.status}`);
	const sums = await response.text();
	const entries = (Object.entries(FORMULA_TARGETS) as [FormulaTarget, string][]).map(
		([key, asset]) => [key, resolveFile(tag, asset, sums)] as const,
	);
	const formula = renderFormula(version, Object.fromEntries(entries) as Record<FormulaTarget, FormulaFile>);
	if (out) {
		await Bun.write(out, formula);
		console.log(`wrote ${out} for ${tag}`);
	} else {
		process.stdout.write(formula);
	}
}

if (import.meta.main) {
	await main();
}
