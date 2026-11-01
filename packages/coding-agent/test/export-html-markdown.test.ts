import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { type Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { Marked } from "@oh-my-pi/pi-utils/marked";

const [templateHtml, shellHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html.txt", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/shell.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);

interface MinimalMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user" | "assistant";
		content: string | unknown[];
		timestamp: number;
	};
}

interface MinimalSession {
	header: {
		type: "session";
		version: number;
		id: string;
		timestamp: string;
		cwd: string;
	};
	entries: MinimalMessageEntry[];
	leafId: string;
}

function renderSession(session: MinimalSession) {
	const { document, window } = parseHTML(templateHtml.replace("</body>", `${shellHtml}</body>`));
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(JSON.stringify(session)).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL("https://example.test/export.html"),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	// linkedom's HTMLSelectElement.value is getter-only; template.js assigns it
	// under 'use strict', which would throw. Shim a writable value like a browser.
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}

	const context = vm.createContext({
		window,
		document,
		ompMarkdown: { Marked },
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: () => 0,
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);
	return document;
}

function createSession(entries: MinimalMessageEntry[], leafId: string, id: string): MinimalSession {
	return {
		header: {
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		},
		entries,
		leafId,
	};
}

function createDeepChainSession(depth: number): MinimalSession {
	const entries: MinimalMessageEntry[] = [
		{
			type: "message",
			id: "message-0",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: "root",
				timestamp: 0,
			},
		},
	];
	for (let i = 1; i < depth; i++) {
		entries.push({
			type: "message",
			id: `message-${i}`,
			parentId: `message-${i - 1}`,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			message: {
				role: "assistant",
				content: [],
				timestamp: i,
			},
		});
	}
	return createSession(entries, "message-0", "deep-chain-test");
}

function renderMarkdown(source: string): Element {
	const document = renderSession(
		createSession(
			[
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: {
						role: "user",
						content: source,
						timestamp: 0,
					},
				},
			],
			"message-1",
			"markdown-test",
		),
	);

	const rendered = document.querySelector(".markdown-content");
	if (!rendered) throw new Error("Export viewer did not render Markdown content");
	return rendered;
}

describe("HTML export Markdown", () => {
	test("renders inline Markdown in ordered, unordered, and nested list items", () => {
		const rendered = renderMarkdown("**outside**\n\n- **bold** and *italic* and `code`\n  1. **nested**");

		expect(rendered.querySelector("p strong")?.textContent).toBe("outside");
		expect(rendered.querySelector("ul > li > strong")?.textContent).toBe("bold");
		expect(rendered.querySelector("ul > li > em")?.textContent).toBe("italic");
		expect(rendered.querySelector("ul > li > code")?.textContent).toBe("code");
		expect(rendered.querySelector("ol > li > strong")?.textContent).toBe("nested");
	});

	test("preserves links without loading remote images or executing transcript HTML", () => {
		const rendered = renderMarkdown(
			'[ordinary](https://example.test/page)\n\n![remote](https://example.test/image.png)\n\n<img src="https://example.test/raw.png" onerror="alert(1)">\n\n[unsafe](javascript:alert(1))',
		);
		expect(rendered.querySelectorAll("img, script")).toHaveLength(0);
		expect(rendered.querySelector('a[href="https://example.test/page"]')?.textContent).toBe("ordinary");
		expect(rendered.querySelector('a[href="https://example.test/image.png"]')?.textContent).toBe("remote");
		expect(rendered.querySelector('a[href^="javascript:"]')).toBeNull();
		expect(rendered.textContent).toContain('<img src="https://example.test/raw.png"');
	});

	test("preserves embedded Markdown images offline", () => {
		const image = renderMarkdown("![embedded](data:image/png;base64,aGVsbG8=)").querySelector("img");
		expect(image?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
		expect(image?.getAttribute("alt")).toBe("embedded");
	});

	test("does not let quotes in image or link Markdown break out of attributes", () => {
		const rendered = renderMarkdown(
			'![x" onerror="alert(1)](data:image/png;base64,AA==)\n\n[a](https://example.test/p "t\\" onmouseover=\\"alert(1)")\n\n[b](https://example.test/q?a=1"onfocus="alert(1))\n\n![y" onclick="alert(1)](https://example.test/i.png)',
		);
		const elements = [...rendered.querySelectorAll("img, a")];
		expect(elements.length).toBeGreaterThan(0);
		for (const element of elements) {
			const names = Array.from(element.attributes, attribute => attribute.name);
			expect(names.every(name => ["src", "alt", "href", "title", "target", "rel"].includes(name))).toBe(true);
		}
		expect(rendered.querySelector("img")?.getAttribute("alt")).toBe('x" onerror="alert(1)');
	});

	test("renders bold inline code before indented code blocks in ordered lists", () => {
		const rendered = renderMarkdown(`1. **\`Crew Ship\`** — description
   \`\`\`json
   { "crew": "..." }
   \`\`\`

2. **\`Hover Ship\`** — description
   \`\`\`json
   { "crew": "..." }
   \`\`\``);

		const names = [...rendered.querySelectorAll("ol > li > p > strong > code")].map(element => element.textContent);
		expect(names).toEqual(["Crew Ship", "Hover Ship"]);
	});

	test("renders a deep valid conversation tree without overflowing the call stack", () => {
		const document = renderSession(createDeepChainSession(30_000));

		expect(document.querySelectorAll(".tree-node").length).toBe(1);
		expect(document.querySelector(".tree-node.active")?.getAttribute("data-id")).toBe("message-0");
		expect(document.querySelector("#messages")?.textContent).toContain("root");
	});
});
