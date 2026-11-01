import { describe, expect, it } from "bun:test";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";

// Catalog snapshots contain only the retained backends, never a generator's
// machine-specific HTTP inference endpoints.
describe("bundled catalog retained-backend and endpoint guards", () => {
	const providers = getBundledProviders();

	it("keeps Copilot/local available without requiring fake seeds for discoverable servers", () => {
		expect(providers).toContain("github-copilot");
		expect(providers).toContain("local");
	});

	it("contains no loopback or private-network baseUrls", () => {
		const offenders: string[] = [];
		for (const provider of providers) {
			for (const model of getBundledModels(provider)) {
				const { id, baseUrl } = model;
				if (!baseUrl) continue;
				let host: string;
				try {
					host = new URL(baseUrl).hostname.toLowerCase();
				} catch {
					offenders.push(`${provider}/${id}: unparseable baseUrl "${baseUrl}"`);
					continue;
				}
				if (isLocalHost(host)) {
					offenders.push(`${provider}/${id}: ${baseUrl}`);
				}
			}
		}
		expect(offenders, `local endpoints leaked into the bundled catalog:\n${offenders.join("\n")}`).toEqual([]);
	});
});

// Loopback, unspecified, link-local, and RFC 1918 private hosts — anything that
// resolves to the machine that ran the generator rather than a public endpoint.
function isLocalHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "0.0.0.0" || host === "::" || host === "::1" || host === "[::1]" || host === "[::]") return true;
	if (host === "127.0.0.1" || host.startsWith("127.")) return true;
	if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
	// 172.16.0.0 – 172.31.255.255
	const match = /^172\.(\d{1,3})\./.exec(host);
	if (match) {
		const second = Number(match[1]);
		if (second >= 16 && second <= 31) return true;
	}
	return false;
}
