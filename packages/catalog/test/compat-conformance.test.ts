import { describe, expect, test } from "bun:test";
import rules from "../src/compat/rules.json";
import { getBundledModels, getBundledProviders } from "../src/models";

function collectReferencedProviders(): Map<string, string> {
	const referenced = new Map<string, string>();
	for (const rule of rules.cascade.rules) {
		if (!rule.source.startsWith("providers/")) continue;
		for (const provider of rule.providers ?? []) referenced.set(provider, rule.source);
	}
	const taxonomy = rules.taxonomy;
	for (const lane of taxonomy.collapse.lanes) {
		for (const provider of lane.providers) referenced.set(provider, `effort-lane ${lane.suffix}`);
	}
	for (const variant of taxonomy.collapse.routingVariants) {
		for (const provider of variant.providers) referenced.set(provider, `routing-variant ${variant.suffix}`);
	}
	for (const family of taxonomy.collapse.effortFamilies)
		referenced.set(family.provider, `effort-family ${family.logical}`);
	for (const provider of taxonomy.discovery.canonicalRecovery) referenced.set(provider, "recover-canonical-params");
	for (const group of taxonomy.discovery.responsesHintGroups) {
		for (const provider of group) referenced.set(provider, "borrow-responses-route");
	}
	for (const provider in taxonomy.discovery.responsesRouteModels) referenced.set(provider, "responses-route-models");
	const behavior = rules.behavior;
	const lists = [
		behavior.modelOperations,
		behavior.quotaTiers,
		behavior.hostedDefaults,
		behavior.apiRoutes,
		behavior.modelLimits,
		behavior.excludeDiscoveryModes,
		behavior.excludeModels,
		behavior.planRequirements,
		behavior.retryResetTimezones,
		behavior.pricingPeers,
	];
	for (const list of lists) {
		for (const entry of list) referenced.set(entry.provider, "behavior");
	}
	return referenced;
}

describe("compat rules conformance", () => {
	test("every referenced provider id is bundled or runtime-only", () => {
		const known = new Set<string>([...getBundledProviders(), ...rules.auth.providers.map(provider => provider.id)]);
		const offenders: string[] = [];
		for (const [provider, source] of collectReferencedProviders()) {
			if (!known.has(provider)) {
				offenders.push(`${provider} (${source})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('every bundle="always" seed row is bundled in the catalog', () => {
		// The seed-only generator must include every always-bundled row.
		const offenders: string[] = [];
		for (const [provider, entry] of Object.entries(rules.providers)) {
			if (entry.seed?.bundle !== "always") continue;
			const bundled = new Set(getBundledModels(provider).map(model => model.id));
			for (const seed of entry.seed.models) {
				if (!bundled.has(seed.id)) offenders.push(`${provider}/${seed.id}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every cascade class/family reference exists in the taxonomy", () => {
		const classes = new Map(rules.taxonomy.classes.map(cls => [cls.id, new Set(cls.families.map(f => f.id))]));
		const offenders: string[] = [];
		for (const rule of rules.cascade.rules) {
			if (rule.class !== undefined) {
				const families = classes.get(rule.class);
				if (!families) {
					offenders.push(`class ${rule.class} (${rule.source})`);
					continue;
				}
				if (rule.family !== undefined && !families.has(rule.family)) {
					offenders.push(`family ${rule.class}/${rule.family} (${rule.source})`);
				}
			} else if (rule.family !== undefined) {
				// Provider-scoped family selectors must name a family of SOME class.
				const known = rules.taxonomy.classes.some(cls => cls.families.some(f => f.id === rule.family));
				if (!known) offenders.push(`family ${rule.family} (${rule.source})`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
