import { beforeAll, describe, expect, it } from "bun:test";
import type { TspKind, TspPickerProps } from "@oh-my-striped-pi/pi-wire";
import { getOAuthProviders } from "@oh-my-striped-pi/pi-ai/oauth";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { HookSelectorComponent } from "../src/overlays/hook-selector";
import { OAuthSelectorComponent, type OAuthSelectorAuthSource } from "../src/overlays/oauth-selector";
import { ThemeSelectorComponent } from "../src/overlays/theme-selector";
import { ThinkingSelectorComponent } from "../src/overlays/thinking-selector";
import { SessionAccountSelectorComponent } from "../src/overlays/session-account-selector";
import { initTheme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: (kind: TspKind) => kind !== "picker",
	feature: () => true,
};

/** The hoisted picker child of a docked selector's root. */
function sheet(root: NativeNode | null): { props: TspPickerProps } {
	const child = root?.c?.[0] as NativeNode | undefined;
	expect(child?.k).toBe("picker");
	return { props: child!.p as TspPickerProps };
}

const at = (type: "select" | "activate", item: string) => ({ type, key: "^picker", item }) as const;
const act = (id: string) => ({ type: "action", key: "^picker", act: id, mods: [] }) as const;

describe("theme selector picker", () => {
	function make() {
		const log: string[] = [];
		const selector = new ThemeSelectorComponent(
			"dark",
			["dark", "light", "nord"],
			name => log.push(`select:${name}`),
			() => log.push("cancel"),
			name => log.push(`preview:${name}`),
		);
		return { selector, log };
	}

	it("describes a picker with swatch marks and the current theme, else the card", () => {
		const { selector } = make();
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.items?.map(item => item.id)).toEqual(["dark", "light", "nord"]);
		expect(p.items?.[2]?.mark?.seed).toBe("nord");
		expect(p.current).toEqual(["dark"]);
		expect(p.selected).toBe("dark");
		expect(p.actions?.map(a => a.label)).toEqual(["Apply", "Close"]);
		expect(selector.describe(genericCx)?.c?.[0]).not.toMatchObject({ k: "picker" });
	});

	it("row click previews, second click applies, close reverts via cancel", () => {
		const { selector, log } = make();
		selector.handleNativeEvent(at("select", "nord"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("nord");
		selector.handleNativeEvent(at("activate", "nord"));
		selector.handleNativeEvent(act("close"));
		expect(log).toEqual(["preview:nord", "select:nord", "cancel"]);
	});
});

describe("thinking selector picker", () => {
	it("meters each level's depth, deeper levels fuller", () => {
		const selector = new ThinkingSelectorComponent(
			"high" as never,
			["low", "high"] as never,
			() => {},
			() => {},
		);
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.columns?.map(c => c.format)).toEqual(["bar"]);
		const depth = (id: string) => p.items?.find(item => item.id === id)?.facts?.depth as number;
		expect(depth("high")).toBeGreaterThan(depth("low"));
		expect(depth("high")).toBeLessThanOrEqual(1);
		expect(p.current).toEqual(["high"]);
	});

	it("marks auto as current without a depth meter; off meters empty", () => {
		const withAuto = new ThinkingSelectorComponent(
			"auto",
			["off", "auto", "high"] as never,
			() => {},
			() => {},
		);
		const p = sheet(withAuto.describe(pickerCx)).props;
		expect(p.current).toEqual(["auto"]);
		expect(p.selected).toBe("auto");
		expect(p.items?.find(item => item.id === "auto")?.facts).toBeUndefined();
		expect(p.items?.find(item => item.id === "off")?.facts?.depth).toBe(0);
	});
});

describe("session account picker", () => {
	const accounts = [
		{ position: 0, credentialId: 11, email: "a@x.so", label: "a@x.so", orgName: "Acme", active: false },
		{ position: 1, credentialId: 12, email: "b@x.so", label: "b@x.so", active: true },
	];

	it("checks the active account, details the org, and pins on confirm", () => {
		const picked: number[] = [];
		const selector = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => picked.push(account.credentialId),
			() => picked.push(-1),
		);
		const p = sheet(selector.describe(pickerCx)).props;
		expect(p.current).toEqual(["12"]);
		expect(p.selected).toBe("12");
		expect(p.items?.find(item => item.id === "11")?.detail).toBe("Acme");
		expect(p.actions?.map(a => a.label)).toEqual(["Pin", "Close"]);
		selector.handleNativeEvent(at("select", "11"));
		selector.handleNativeEvent(act("confirm"));
		selector.handleNativeEvent(act("close"));
		expect(picked).toEqual([11, -1]);
		expect(selector.describe(genericCx)?.c?.[0]).not.toMatchObject({ k: "picker" });
	});
});

describe("hook selector picker", () => {
	it("pointer select moves the selection without confirming; confirm picks it", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Pick",
			["one", "two"],
			o => picked.push(o),
			() => {},
		);
		selector.handleNativeEvent(at("select", "1"));
		expect(sheet(selector.describe(pickerCx)).props.selected).toBe("1");
		expect(picked).toEqual([]);
		selector.handleNativeEvent(act("confirm"));
		expect(picked).toEqual(["two"]);
	});

	it("inline stays in the dock as a card instead of a hoisted picker sheet", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Save where?",
			["project", "global"],
			o => picked.push(o),
			() => {},
			{ inline: true },
		);
		const root = selector.describe(pickerCx);
		expect(JSON.stringify(root)).not.toContain('"k":"picker"');
		selector.handleNativeEvent({ type: "activate", key: "list", item: "1" });
		expect(picked).toEqual(["global"]);
	});
});

describe("oauth selector picker", () => {
	const providers = getOAuthProviders();
	const signedIn = providers[0]!.id;
	const auth: OAuthSelectorAuthSource = {
		credentials: { has: (id: string) => id === signedIn },
		keys: { source: (id: string) => (id === signedIn ? { kind: "oauth" } : undefined) } as never,
	};

	it("shows Copilot and self-hosted backends with the auth-state dot and origin detail", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			auth,
			() => {},
			() => {},
		);
		const first = sheet(selector.describe(pickerCx)).props;
		expect(first.layout).toBe("cards");
		const row = first.items?.find(item => item.id === signedIn);
		expect(row?.dot).toBe("success");
		expect(row?.detail).toBe("Signed in · login");
		expect(first.items?.map(item => item.id)).toEqual([
			"github-copilot",
			"ollama",
			"llama.cpp",
			"lm-studio",
			"vllm",
			"litellm",
		]);
	});

	it("activate signs in with the clicked provider; close cancels", () => {
		const log: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			auth,
			id => log.push(id),
			() => log.push("cancel"),
		);
		const target = providers.find(p => p.available)!.id;
		selector.handleNativeEvent(at("activate", target));
		selector.handleNativeEvent(act("close"));
		expect(log).toEqual([target, "cancel"]);
	});
});
