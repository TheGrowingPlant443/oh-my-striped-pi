# @oh-my-pi/pi-mnemopi

Local SQLite memory engine for omp agents.

This package is the Bun/TypeScript port of the Mnemosyne memory engine. It provides:

- `Mnemopi`, a small facade for remember/recall/stats/sleep workflows.
- `BeamMemory`, the lower-level working/episodic memory engine.
- MCP tool definitions and a dispatcher for host integrations.
- Optional local ONNX embeddings through `fastembed`, explicit private OpenAI-compatible HTTP endpoints, and host-injected embedding providers and LLM completions.

The package has no public hosted inference default or fallback and does not bundle a local GGUF LLM. LLM inference uses a host-managed model, completion callback, or explicitly configured HTTP endpoint and model; without one, deterministic heuristic paths are used.

## Basic use

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";

const memory = new Mnemopi({ dbPath: "./mnemopi.db", bank: "project" });
const id = memory.remember("The deployment target is stable-cluster.", {
	source: "notes",
	importance: 0.8,
	veracity: "true",
});

const results = memory.recall("deployment target", 5);
console.log(id, results[0]?.content);

memory.close();
```

Lexical recall matches whole tokens, declared synonyms, underscore-separated identifier parts, and other forms of a word of at least four characters: the word plus `s`, `es`, `d`, `ed`, `ing`, `er`, `ers`, `ment` or `ments`, a final `e` replaced by `ing`/`ion`/`ions`, or a final `y` replaced by `ies`/`ied`. `backup` matches `backups`, `facts` matches `fact` and `caching` matches `cache`, but `1Password` does not match `pass` or `word`, and `redis` does not match `redistribution`.

## Configuration

`Mnemopi` accepts host-managed LLMs, callbacks, local embeddings, and explicit private HTTP endpoints. Dedicated `MNEMOPI_*` environment variables remain fallbacks when the matching constructor option is omitted.

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { Model } from "@oh-my-pi/pi-ai";

const ftsOnly = new Mnemopi({ noEmbeddings: true });

const localEmbeddings = new Mnemopi({
	embeddings: { model: "BAAI/bge-small-en-v1.5" },
});

declare const smolModel: Model;
const piAiLlm = new Mnemopi({ llm: smolModel });
const dynamicLlm = new Mnemopi({
	llm: async (prompt, opts) => {
		return await completeWithHostModel(prompt, {
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

For an existing company OpenAI-compatible service, pass its API root and served model:

```ts
const companyMemory = new Mnemopi({
	dbPath: "./mnemopi.db",
	embeddings: { apiUrl: "http://embeddings.internal:8080/v1", model: "company-embed" },
	llm: { baseUrl: "http://llm.internal:8080/v1", model: "company-memory" },
});
```

Optional dedicated `apiKey` values may be strings or managed key resolvers. Unauthenticated private services need no token. Endpoints are used only when explicitly configured: neither public provider URLs nor `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `OPENROUTER_BASE_URL` are borrowed. The external inference servers are operator-managed, not bundled here.

### Banks and host scoping

`Mnemopi` itself exposes banks directly through constructor options such as `bank`; it does not hard-code coding-agent project scoping.

The omp coding-agent wrapper adds `mnemopi.scoping` on top of those constructor options:

- `global`: one shared bank
- `per-project`: isolated project memory
- `per-project-tagged`: project-local writes plus global recall visibility

In `per-project-tagged`, the wrapper is responsible for combining project-local retention with global recall visibility. The package still just exposes banks plus constructor-level LLM and embedding options.

The coding-agent `memory.backend` selector also retains `local` file summaries, `sharpshooter` project-local decision extraction/consolidation, and `hindsight` for an operator-managed Hindsight server. Memory is off by default. Hindsight defaults to the local server at `http://localhost:8888`; `hindsight.apiUrl` / `HINDSIGHT_API_URL` can select a private deployment with an optional dedicated bearer token. Sharpshooter stores project-scoped queued decisions and validated `architecture.md`, `product.md`, and `style.md` files locally, using its configured model or the managed `smol` role for extraction.

For coding-agent Mnemopi, the default `mnemopi.llmMode: smol` uses the managed memory role, while `none` disables LLM extraction. `remote` requires `mnemopi.llmBaseUrl` and `mnemopi.llmModel`; optional `mnemopi.llmApiKey` supplies its own bearer token. `mnemopi.embeddingApiUrl` and optional `mnemopi.embeddingApiKey` select private HTTP embeddings independently; leaving the endpoint unset preserves local FastEmbed.

Common environment fallbacks:

- `MNEMOPI_DATA_DIR` / `MNEMOPI_DB_PATH`: default storage location.
- `MNEMOPI_DB_PAGE_SIZE`: optional SQLite page size for new file-backed databases; use a valid power of two from 512 to 65536 or `os` to request the detected system page size. Unset preserves SQLite's default.
- `MNEMOPI_NO_EMBEDDINGS=1`: force FTS-only recall.
- `MNEMOPI_EMBEDDING_MODEL`: defaults to `BAAI/bge-small-en-v1.5`.
- `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS`: limits each embedding input (default `8192`; `0` disables the cap).
- `MNEMOPI_EMBEDDING_API_URL` / `MNEMOPI_EMBEDDING_API_KEY`: explicit private embedding API root and optional dedicated bearer token.
- `MNEMOPI_LLM_BASE_URL` / `MNEMOPI_LLM_MODEL` / `MNEMOPI_LLM_API_KEY`: explicit private chat API root, required served model, and optional dedicated bearer token.
- `MNEMOPI_LLM_ENABLED=0`: disables default host LLM inference; local heuristic extraction remains available. Explicit constructor options take precedence.

LLM constructor options accept `baseUrl`, `apiKey`, `model` (a managed `Model` or the model name served at the explicit endpoint), `complete`, `maxTokens`, `extractionPrompt`, and `consolidationPrompt`. Embeddings accept `apiUrl`, `apiKey`, `model`, `provider`, `disabled`, and `maxInputChars`. Managed models and completion callbacks retain precedence; `llm: false` and disabled embeddings remain authoritative. Existing SQLite memories are retained.

Local embeddings use the `fastembed` npm package. Its default `BGESmallENV15` model is 384-dimensional and uses the package's CLS pooling plus vector normalization path. Local GGUF LLMs are not available in this package.

## Commands

```sh
mnemopi remember "Use stable-cluster for production deploys"
mnemopi recall "production deploy target"
mnemopi stats
mnemopi sleep
```

## Tests

```sh
bun --cwd packages/mnemopi test
bun --cwd packages/mnemopi run check
```
