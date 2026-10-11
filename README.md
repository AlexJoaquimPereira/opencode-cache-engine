# OpenCode Cache Engine

Provider-aware prompt-cache handling and cache-usage observability for
[OpenCode](https://opencode.ai).

`opencode-cache-engine` classifies the active model/provider through a pure policy
registry, applies only **verified, narrow** request mutations, and records
provider-reported cache usage — never fabricating cache reads, writes, or usage
records. It never records prompts, reasoning, credentials, or request bodies.

> **Design principle:** change the request structure only when there is a clear
> provider-specific reason. Otherwise preserve OpenCode's native request behavior
> and measure what the provider reports.

## What it does

1. Resolves the model/provider policy through the registry (`creator`, `family`,
   `baseline`, `overlays`, `transport`, `matchReason`).
2. Applies only the mutations registered for that policy:
   - **GPT‑5.6+**: adds *missing* `promptCacheKey`/`promptCacheOptions` (prompt text
     unchanged; existing values preserved).
   - **GLM‑5.3 / MiMo‑V2.6**: a content-preserving relocation of the identifiable
     `<env>` block to the system tail.
   - **OpenRouter affinity**: a deterministic `x-session-id` header for GLM/MiMo
     *only* when the actual provider is `openrouter`.
3. Leaves every other family's request unchanged.
4. Records provider-reported cache-token usage and route/affinity telemetry.

**Passive does not mean "no cache support."** It means the plugin does not change
the request because the provider or OpenCode already owns the cache behavior.

## Supported runtimes and verification status

| Runtime | Status |
| --- | --- |
| **OpenCode 1.x** (V1 adapter, `./server`) | **Verified** and in production use. Eleven provider families, tested against OpenCode 1.18.x. |
| **OpenCode 2.x** (V2 adapter, `./v2`) | **Implemented and offline-tested; runtime integration NOT yet verified.** The adapter imports and passes synthetic contract tests, but plugin registration and hook installation in the real runtime have not been demonstrated. Treat V2 as preview. |

The shared policy and usage/accounting core is used by both adapters and is free
of runtime dependencies. See the authoritative plan:
[`docs/implementation-plan-v2.md`](docs/implementation-plan-v2.md).

## Installation

### OpenCode 1.x (verified)

Register the package with OpenCode's plugin manager, or add it to the OpenCode
configuration. For reproducible installs, pin an exact version rather than a
moving `@latest`:

```json
{
  "plugin": [
    "opencode-cache-engine@0.7.1"
  ]
}
```

For local development, use the package from this Git checkout through the
project's OpenCode plugin development path. Do not copy the plugin into a
second active source tree.

### OpenCode 2.x (preview — not yet runtime-verified)

The package exposes a `./v2` entry for the V2 plugin loader and a `plugins`
configuration field is used by OpenCode 2.x. Because V2 runtime registration has
not yet been demonstrated, do not rely on V2 in a critical setup. The known
blocker is documented in the implementation plan.

## Package entrypoints

- **`./server`** — the V1 runtime: hooks, provider policies, telemetry.
- **`./tui`** — plugin-manager registration only; no CacheEngine UI.
- **`./v2`** — the V2 adapter (preview; see above).

## Provider policy

Eleven families. Only GPT‑5.6+, GLM‑5.3, and MiMo‑V2.6 mutate the request; the
rest are classified and accounted for without changing the request.

| Family | Behavior |
| --- | --- |
| DeepSeek | Passive: preserve and measure. |
| GPT‑5.6+ (GPT‑6/7+) | Active: add only missing cache key/options metadata. |
| GLM‑5.3+ | Passive baseline; GLM‑5.3: content-preserving `<env>` relocation + OpenRouter `x-session-id`. |
| MiMo‑V2.6+ | Passive baseline; V2.6 Flash/Pro: content-preserving `<env>` relocation + OpenRouter `x-session-id`. |
| Kimi | Passive (Moonshot implicit caching). |
| Claude (Anthropic) | Passive: OpenCode applies the `cache_control` breakpoints. |
| Google Gemini | Passive (2.5+ implicit caching). |
| Alibaba Qwen | Passive on every route. |
| xAI Grok | Passive: OpenCode already supplies the Responses affinity key. |
| Meta Muse | Passive: Meta requires an application-stable key; the plugin injects none. |
| MiniMax | Passive, route-aware: OpenCode owns the Anthropic breakpoints. |

Model classification is not hard-coded in the runtime: a pure registry in
`src/cache-policy-core.mjs` returns a structured policy result, and the hooks gate
on it. Per-model evidence lives in
[`docs/cache-policy-inventory.md`](docs/cache-policy-inventory.md).

## Usage accounting and telemetry

- Provider-reported cache **reads** are always recorded; **writes** are recorded
  only when the provider reports them. Nothing is fabricated.
- Ratios: generic `read/(read+write)`; GLM `read/(read+write+input)`; MiMo
  `cachedTokens/promptTokens` (where `promptTokens = read + input`).
- Telemetry is best-effort and never breaks a request. The default metrics file is
  `~/.cache/opencode/cache-metrics.jsonl` (configurable via `metricsFile` or the
  `CACHE_ENGINE_METRICS_FILE` env override).
- A local hash only shows observed byte changes — it is **not** proof of a cache
  hit. Provider usage is authoritative.

### Privacy boundaries

The plugin never records prompt text, reasoning content, credentials,
authorization headers, raw cache keys, or full request/response bodies. An
optional derived `stickySessionId` (a deterministic, non-secret identifier) may
appear in MiMo telemetry.

## Configuration

Configuration is loaded from `~/.config/opencode/cache-engine.json` (or the
`CACHE_ENGINE_METRICS_FILE` environment override for the metrics path), merged
over built-in defaults. Global keys: `enabled`, `metricsFile`, `compactTemplate`,
`logPrefixChanges`. Per-policy keys include `enabled`, and for the active
families: `promptCacheKey`, `cacheRootKey`, `compactionCacheIsolation`,
`reasoningEffortDiagnostics`, `mode`, `ttl` (GPT‑5.6+), `stabilizeSystem` and
`preserveThinkingIntegrity` (GLM/MiMo), and `stickySession` (MiMo).

The example config in `examples/cache-engine.json` matches the parser defaults.

## Known limitations

- **V1** is stable; **V2 runtime integration is unverified** (registration/hooks).
- V2: `session.usage.updated` delta-vs-cumulative semantics are unverified, so the
  event is unused; history is read via `session.context` with a defensive sort.
- In-memory session state is **not durable across restarts**.
- Cursor boundaries can **undercount** (same-millisecond ties; failures after
  cursor advancement; capacity-eviction backlog skip). Exactly-once accounting is
  not claimed.
- V2 compaction cache isolation, fork cache-root resolution, and the secondary
  diagnostics remain deferred.
- The plugin does not enforce pricing or context/output limits.

## Troubleshooting

- **GPT options missing** — confirm the model is within the GPT‑5.6+ boundary and
  the endpoint is OpenAI/Azure-compatible; ambiguous OpenAI-compatible providers
  are rejected by design; existing cache options are preserved.
- **GLM/MiMo prompt unchanged** — relocation requires exactly one system string
  with both `<env>` markers and `stabilizeSystem` enabled; an already-tailed block
  is a no-op.
- **OpenRouter header missing** — the `x-session-id` is added only when the
  detected family is GLM/MiMo **and** the provider is exactly `openrouter`; a
  pre-existing case-insensitive header is preserved.
- **Unknown model** — resolves to `neutral` with no mutation. Inspect
  `policy-resolution` records (`matchCategory`/`matchReason`) to see how it
  resolved.
- **Metrics file missing** — telemetry is best-effort; check the configured path
  and that the parent directory is writable. A telemetry failure is swallowed.

## More documentation

- Implementation roadmap (authoritative): [`docs/implementation-plan-v2.md`](docs/implementation-plan-v2.md)
- Harness/transport/API evidence: [`docs/research-findings.md`](docs/research-findings.md)
- Per-model compatibility evidence: [`docs/cache-policy-inventory.md`](docs/cache-policy-inventory.md)
- Contributor instructions: [`AGENTS.md`](AGENTS.md)

The plugin should be evaluated using **real provider-reported usage**, not by
assuming that any local transformation guarantees a cache hit.
