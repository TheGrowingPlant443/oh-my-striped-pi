/** System One protocol, supported by OpenJEV, Kev and self-hosted Clef. */
import { isRecord } from "@oh-my-striped-pi/pi-utils";
import type { ImageContent } from "../types";
import {
	type BoxQuestion,
	type JsonValue,
	type JudgmentRequest,
	type Question,
	type Questions,
	tokenUsage,
} from "./types";
import { type DecodedJudgment, finiteNumber, type JudgmentImageAssets, type JudgmentWire } from "./wire";

function decodeSystemOne(payload: unknown): DecodedJudgment | undefined {
	if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
	const usage = isRecord(payload.usage) ? payload.usage : {};
	return {
		model: typeof payload.model === "string" ? payload.model : undefined,
		answers: payload.answers,
		refused: [],
		usage: tokenUsage(finiteNumber(usage.input_tokens), finiteNumber(usage.output_tokens), finiteNumber(usage.cost)),
	};
}

/**
 * `state` with `items` added and every original value kept: arrays gain them at the end, objects
 * under the first free `__omsp_judgment_images[_N]` key, and a string root becomes `[state, ...items]`.
 */
function stateWithImages(state: JudgmentRequest["state"], items: readonly JsonValue[]): JudgmentRequest["state"] {
	if (Array.isArray(state)) return [...state, ...items];
	if (!isRecord(state)) return [state, ...items];
	const baseKey = "__omsp_judgment_images";
	let key = baseKey;
	for (let suffix = 1; Object.hasOwn(state, key); suffix++) key = `${baseKey}_${suffix}`;
	return { ...state, [key]: items };
}

function* jsonStrings(value: unknown): Generator<string> {
	if (typeof value === "string") yield value;
	else if (Array.isArray(value)) for (const item of value) yield* jsonStrings(item);
	else if (isRecord(value)) for (const key in value) yield* jsonStrings(value[key]);
}

/**
 * The subset of `assets` that `request` references. TypeSafe substitutes a reference wherever it
 * occurs as text in a string of `state`, a question's `instructions`, or its `criteria` (never in
 * object keys) and rejects a request carrying an unreferenced asset.
 */
export function referencedImageAssets(request: JudgmentRequest, assets: JudgmentImageAssets): JudgmentImageAssets {
	const pending = new Set(Object.keys(assets));
	const visit = (value: unknown): void => {
		for (const text of jsonStrings(value)) {
			if (pending.size === 0) return;
			for (const reference of pending) if (text.includes(reference)) pending.delete(reference);
		}
	};
	visit(request.state);
	for (const id in request.questions) {
		const question = request.questions[id];
		visit(question.instructions);
		if (question.type !== "box") visit(question.criteria);
	}
	// `fromEntries` defines own properties, so a `__proto__` reference stays an ordinary key.
	return Object.fromEntries(Object.entries(assets).filter(([reference]) => !pending.has(reference)));
}

interface SystemOneImageAsset {
	type: "image";
	format: "png" | "jpeg";
	data_base64: string;
}

function encodeSystemOneImage(image: ImageContent): SystemOneImageAsset {
	const mimeType = image.mimeType.toLowerCase();
	return {
		type: "image",
		format: mimeType === "image/png" ? "png" : "jpeg",
		data_base64: Buffer.from(image.data, "base64").toString("base64"),
	};
}

type WireQuestion = Exclude<Question, BoxQuestion> | Omit<BoxQuestion, "image">;

/** `questions` as System One takes them: a box question's `image` only names the image its edges measure locally. */
function wireQuestions(questions: Questions): Record<string, WireQuestion> {
	const wire: Record<string, WireQuestion> = {};
	for (const id in questions) {
		const question = questions[id];
		wire[id] = question.type === "box" ? { type: "box", instructions: question.instructions } : question;
	}
	return wire;
}

/** A System One dialect posting the verbatim request to `path` under the base URL with the key as bearer. */
function systemOneWire(path: string): JudgmentWire {
	return {
		target: (baseUrl, _model, key) => ({ url: `${baseUrl}${path}`, token: key }),
		encode: (request, model) => ({ state: request.state, model, questions: wireQuestions(request.questions) }),
		decode: decodeSystemOne,
	};
}

/** TypeSafe's own route, shared by every System One server. */
export const typesafeWire: JudgmentWire = {
	...systemOneWire("/v1/systemone"),
	images: { mimeTypes: ["image/png", "image/jpeg"] },
	supportsImageAssets: true,
	imagesRequireOptIn: true,
	imageHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
	ignoresImageDetail: true,
	boxes: true,
	encode(request, model, imageAssets) {
		const suppliedAssets = Object.entries(imageAssets ?? {});
		const images = request.images ?? [];
		if (suppliedAssets.length === 0 && images.length === 0) {
			return { state: request.state, model, questions: wireQuestions(request.questions) };
		}

		const assets: Record<string, SystemOneImageAsset> = Object.fromEntries(
			suppliedAssets.map(([reference, image]) => [reference, encodeSystemOneImage(image)]),
		);
		const references: string[] = [];
		for (const image of images) {
			let reference = crypto.randomUUID();
			while (Object.hasOwn(assets, reference)) reference = crypto.randomUUID();
			assets[reference] = encodeSystemOneImage(image);
			references.push(reference);
		}

		return {
			state: references.length ? stateWithImages(request.state, references) : request.state,
			model,
			questions: wireQuestions(request.questions),
			assets,
		};
	},
};
