/**
 * Bake↔runtime consistency gate: for every bundled catalog row, the compat
 * engine (`resolveModelPolicy`) must reproduce the row's baked `compat` and
 * `thinking` values exactly, so a rule change that is not re-baked into the
 * bundle fails here.
 *
 * Thinking is derived from scratch (`thinking: undefined`), mirroring the
 * generator's `rebakeModelThinking`, except its documented provider-authored
 * exemption rows, which keep their explicit metadata.
 *
 * Hermetic (no network). Zero diffs required — a failure names each divergent
 * field as `provider/model.field: baked=X engine=Y`; fix the KDL rules or
 * regenerate the bundled seed catalog, never hand-edit baked values.
 */
import { describe, expect, test } from "bun:test";
import { isCollapsedVariantSpec } from "../src/compat/collapse";
import { resolveModelPolicy } from "../src/compat/resolve";
import { getBundledModels, getBundledProviders } from "../src/models";
import type { Api, Model, ModelSpec } from "../src/types";

function jsonClone<T>(value: T): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function diffValues(prefix: string, baked: unknown, engine: unknown, out: string[]): void {
	if (Bun.deepEquals(baked, engine, true)) return;
	if (
		typeof baked === "object" &&
		baked !== null &&
		!Array.isArray(baked) &&
		typeof engine === "object" &&
		engine !== null &&
		!Array.isArray(engine)
	) {
		const keys = new Set([...Object.keys(baked), ...Object.keys(engine)]);
		for (const key of keys) {
			diffValues(
				`${prefix}.${key}`,
				(baked as Record<string, unknown>)[key],
				(engine as Record<string, unknown>)[key],
				out,
			);
		}
		return;
	}
	out.push(`${prefix}: baked=${JSON.stringify(baked)} engine=${JSON.stringify(engine)}`);
}

interface RowLike {
	id: string;
	provider: string;
	api: Api;
	compat?: unknown;
	compatConfig?: { thinkingFormat?: string; trustExplicitThinkingOnly?: boolean };
	thinking?: Model<Api>["thinking"];
	[key: string]: unknown;
}

/**
 * Mirrors `rebakeModelThinking`'s exemptions: rows whose baked thinking is
 * provider-authored and never re-derived by the generator.
 */
function keepsExplicitThinking(row: RowLike): boolean {
	if (isCollapsedVariantSpec(row as unknown as ModelSpec<Api>)) return true;
	if (
		(row.compatConfig?.thinkingFormat === "chat-template" || row.compatConfig?.thinkingFormat === "kimi") &&
		row.thinking
	)
		return true;
	if (row.compatConfig?.trustExplicitThinkingOnly === true) return true;
	return false;
}

describe("compat parity", () => {
	test("engine reproduces every baked catalog compat/thinking value", () => {
		const diffs: string[] = [];
		let rows = 0;
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) {
				const row = model as unknown as RowLike;
				rows++;
				const label = `${provider}/${row.id}`;
				const {
					compat: _compat,
					compatConfig,
					requiresGlyphTokenization: _glyph,
					supportsComputerUseConfig,
					supportsComputerUse: _computerUse,
					identity: _identity,
					...rest
				} = row;
				if (compatConfig !== undefined) (rest as Record<string, unknown>).compat = compatConfig;
				if (supportsComputerUseConfig !== undefined) {
					(rest as Record<string, unknown>).supportsComputerUse = supportsComputerUseConfig;
				}
				const exempt = keepsExplicitThinking(row);
				if (!exempt) (rest as Record<string, unknown>).thinking = undefined;
				let policy: ReturnType<typeof resolveModelPolicy>;
				try {
					policy = resolveModelPolicy(rest as unknown as ModelSpec<Api>);
				} catch (error) {
					diffs.push(`${label}: engine threw ${(error as Error).message}`);
					continue;
				}
				diffValues(`${label}.compat`, jsonClone(row.compat), jsonClone(policy.compat), diffs);
				diffValues(`${label}.thinking`, jsonClone(row.thinking), jsonClone(policy.thinking), diffs);
			}
		}
		if (diffs.length > 0) {
			const shown = diffs.slice(0, 200);
			console.error(`\n${diffs.length} parity diffs across ${rows} rows:\n${shown.join("\n")}`);
			if (diffs.length > shown.length) console.error(`… and ${diffs.length - shown.length} more`);
		}
		expect(diffs.length).toBe(0);
	});
});
