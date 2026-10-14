# External research findings

Cross-model findings about the **harness and transports** that CacheEngine
depends on: OpenCode runtime/SDK/plugin-API behavior, OpenRouter routing and
transport, AI-SDK / provider-package serialization, and provider API mechanics.

This file exists so a verified fact is fetched once, not once per session.

- **Per-model cache-policy compatibility** (does documented cache behavior
  support how CacheEngine treats model X?) belongs in
  `docs/cache-policy-inventory.md`, not here. That inventory remains the home
  for new-model audits.
- Code comments and inventory rows should cite a finding ID (`RF-OC-001`) rather
  than restating the fact.

Evidence tags are the same legend the inventory uses:

| Tag | Meaning |
| --- | --- |
| `[D]` | Documented by a first-party source |
| `[O]` | Observed (runtime, telemetry, live measurement) |
| `[I]` | Inferred from documented facts |
| `[U]` | Unknown / unresolved |

## When to use this file

1. Before any web search, check this file and the inventory. Do not re-search a
   fact whose `Status` is `current` and whose `Version context` still matches the
   installed toolchain.
2. After verifying something new, append an entry here. A research session that
   fetches a source and does not store the fact is not finished.
3. Record facts, never payloads: no prompt text, reasoning content, credentials,
   authorization headers, or request/response bodies.

`docs/audit-report-*.md` and `session-*.md` are gitignored, so anything durable
found in them is lost on a fresh clone. Promote it here.

The post-1.0.0 plan `docs/opencode-cache-engine-v1.x.x-implementation-plan.md` is
the tracked distillation of `docs/competitor-prompt-cache-plugins-research-report.md`
(gitignored/local-only). The report's competitor claims are author-reported, never
first-party facts; cite the plan for the distilled conclusions and keep the `RF-*`
entries here for first-party runtime/API facts.

## Entry template

```markdown
### RF-<AREA>-<NNN> — <short imperative title>
- Status: current | superseded | unknown
- Verified: <YYYY-MM-DD>
- Area: opencode-runtime | openrouter-transport | sdk-serialization | provider-api
- Fact: <one or two sentences, exact, no interpretation>
- Evidence: [D] | [O] | [I] | [U]
- Sources: <exact URL — what on the page establishes the fact (fetched DATE)>;
  <local evidence: file:line, installed package@version, telemetry record,
  or live measurement>
- Justifies: <file:line / feature / test that depends on this fact>
- Version context: <OpenCode, ai, provider-package versions verified against>
- Re-verify when: <a concrete trigger, not a date>
- Superseded by: <RF-… or null>
- Notes: <contradictions, unresolved questions>
```

IDs are immutable and never reused. Supersede by pointing forward with
`Superseded by:`; keep the old entry for the audit trail.

Area codes: `OC` OpenCode runtime/SDK, `OR` OpenRouter transport,
`SDK` AI-SDK/provider packages, `PRV` provider API mechanics.

---

## RF-OC — OpenCode runtime and SDK

### RF-OC-001 — OpenCode pre-sets `promptCacheKey` to the session ID for direct OpenAI/Azure and sets nothing for OpenRouter

- Status: current
- Verified: 2026-10-02
- Area: opencode-runtime
- Fact: OpenCode's provider `options()` sets `promptCacheKey = sessionID` for
  direct OpenAI and Azure requests, and sets no key for OpenRouter. CacheEngine
  must therefore preserve a pre-existing key by default on direct transports,
  and set its own on OpenRouter.
- Evidence: [O]
- Sources: local — OpenCode source tag `v1.18.34`, provider `options()`;
  recorded with the transport matrix in `docs/cache-policy-inventory.md`
  ("Follow-up: v0.4.11 GPT key ownership and compaction isolation").
- Justifies: `gptCacheOptionFieldNames` and the key-preservation /
  `applyRoot || isolated` logic in `src/cache-engine.ts`; `v0.4.11` tests.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes its provider `options()` defaults, or the
  installed OpenCode minor version changes.
- Superseded by: null
- Notes: A prompt-cache key provides namespace stability/isolation, not a
  guaranteed cache hit. This entry recovered a defect where compaction isolation
  was silently disabled because the key was only written when `applyRoot`.

### RF-OC-002 — `tokens.input` is non-cached input, so no provider-specific usage parsing is needed

- Status: current
- Verified: 2026-10-02
- Area: opencode-runtime
- Fact: OpenCode normalizes provider cache usage to
  `Message.info.tokens = { input, output, reasoning, cache: { read, write } }`,
  and `tokens.input` is **non-cached** input, so total prompt tokens =
  `input + cache.read + cache.write`.
- Evidence: [D][O]
- Sources: local — `@opencode-ai/sdk` types 1.18.34; OpenCode source tag
  `v1.18.34` (`packages/opencode/src/session/llm/ai-sdk.ts`,
  `session/session.ts` getUsage); full per-provider field map in
  `docs/cache-policy-inventory.md` §9a.
- Justifies: the GLM ratio `read/(read+write+input)` and the MiMo
  `promptTokens = read + input` formulas in `src/cache-engine.ts`.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes its usage normalization or SDK token shape.
- Superseded by: null
- Notes: DeepSeek has no write accounting, so its `cache.write` is always 0 and
  `prompt_cache_miss_tokens` survives only in provider metadata.

### RF-OC-003 — `x-session-id` OpenRouter affinity is best-effort and does not pin an upstream

- Status: current
- Verified: 2026-10-01
- Area: opencode-runtime
- Fact: OpenRouter treats a sticky-session request as a preference. A live
  measurement saw GLM held on one upstream while **MiMo switched upstream
  (Novita → DeepInfra) despite `x-session-id`**, and in both cases the cache
  warmed only on the third request.
- Evidence: [O]
- Sources: local — live measurement recorded in the gitignored
  `docs/audit-report-v0.4-2026-10-01-0909.md` (per-request upstream and cached
  token table). Promoted here because the audit report is not tracked.
- Justifies: the "best-effort, never guaranteed" framing of the affinity feature
  in `README.md` and `AGENTS.md`; the decision not to treat affinity as a cache
  correctness mechanism.
- Version context: OpenCode 1.18.34, `@openrouter/ai-sdk-provider@2.9.0`,
  measured through OpenRouter with `mimo-v2.6-flash`.
- Re-verify when: OpenRouter changes sticky-routing behavior, or a later audit
  measures affinity again; also re-measure if upstream availability changed.
- Superseded by: null
- Notes: Sample size is one session per family. Do not generalize to "affinity
  does not work" — GLM held. Report it as a cache-hit-latency risk, not a
  correctness bug.

### RF-OC-004 — `client.session.messages` returns messages oldest-first

- Status: current
- Verified: 2026-09-26
- Area: opencode-runtime
- Fact: `client.session.messages({ path: { id } })` returns messages in
  chronological (oldest-first) order, with non-decreasing `time.created`. SDK
  methods must be called as members or bound, because they use `this._client`.
- Evidence: [O]
- Sources: local — `src/cache-engine.ts` shape comment; usage-aggregation
  cursor tests.
- Justifies: usage aggregation after the `lastProcessedMessageID` cursor and its
  `lastProcessedAt` watermark.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes message pagination or ordering.
- Superseded by: null
- Notes: A newest-first assumption silently double-counts usage and is not
  detectable by reading the type alone.

### RF-OC-005 — The system-transform hook ignores `output.system` reassignment

- Status: current
- Verified: 2026-09-26
- Area: opencode-runtime
- Fact: The runtime passes a single `output.system` element and ignores
  reassignment of `output.system`; mutating `output.system[0]` in place is
  required.
- Evidence: [O]
- Sources: local — `experimental.chat.system.transform` implementation.
- Justifies: the `<env>` relocation for GLM-5.3 / MiMo-V2.6.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes the system-transform hook contract.
- Superseded by: null
- Notes: Reassigning looks correct in review and silently does nothing.

### RF-OC-006 — OpenCode sorts tools before sending, so a registry-order fingerprint is not a wire fingerprint

- Status: current
- Verified: 2026-09-26
- Area: opencode-runtime
- Fact: OpenCode sorts tools before transmission, so `toolWireFingerprint` is a
  registry-order diagnostic and cannot detect a byte-level tool-list change.
- Evidence: [O]
- Sources: local — tool serialization path in the OpenCode source tree.
- Justifies: the tool-change diagnostic and the rule never to emit a fabricated
  tool change when a tool list fails to load.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes tool ordering or serialization.
- Superseded by: null

### RF-OC-007 — The OpenCode plugin client throws on HTTP errors (`throwOnError: true`)

- Status: current
- Verified: 2026-10-03
- Area: opencode-runtime
- Fact: The generated SDK client defaults `throwOnError` to `false`, but OpenCode
  constructs the client handed to plugins with `throwOnError: true`, so SDK calls
  (`session.messages`, `session.get`, `tool.list`) reject on HTTP failure rather
  than resolving an `{ error }` value.
- Evidence: [O]
- Sources: local — installed binary `/home/alex/.opencode/bin/opencode` (multiple
  `createClient({...,throwOnError:!0})` sites); installed `@opencode-ai/sdk`
  `dist/gen/client/types.gen.d.ts` documents the `false` default.
- Justifies: the `try/catch` + single bounded `telemetry-error` paths in
  `collectUsage` and `resolveCacheRoot`. No `res.error` checks are needed for the
  verified plugin client; adding them would be redundant.
- Version context: OpenCode 1.18.34; `@opencode-ai/sdk` 1.18.34.
- Re-verify when: OpenCode changes how it constructs the plugin client, or the
  installed SDK's `throwOnError` default handling changes.
- Superseded by: null
- Notes: Residual uncertainty — the exact client instance passed to plugins was
  not pinned from the minified binary. If a probe against an unavailable endpoint
  resolves a value instead of throwing, add explicit `res.error` checks then.

### RF-OC-008 — OpenCode applies Anthropic `cache_control` breakpoints itself, so CacheEngine must not

- Status: current
- Verified: 2026-10-04
- Area: opencode-runtime
- Fact: OpenCode 1.18.34's `ProviderTransform.applyCaching` marks the first two
  `system` messages and the last two non-system messages (≤4 breakpoints, default
  `{type:"ephemeral"}` 5m TTL) for Claude/Anthropic transports. Gate:
  `(providerID === "anthropic" || providerID === "google-vertex-anthropic" ||
  api.id/model.id includes "anthropic" or "claude" || api.npm === "@ai-sdk/anthropic"
  || api.npm === "@ai-sdk/alibaba") && api.npm !== "@ai-sdk/gateway" &&
  !usesAnthropicAutomaticCaching`, where `usesAnthropicAutomaticCaching` is
  `options.cacheControl !== undefined && (npm === "@ai-sdk/anthropic" ||
  "@ai-sdk/google-vertex/anthropic")`. Transport map:
  `anthropic:{cacheControl}`, `openrouter:{cacheControl}`,
  `bedrock:{cachePoint:{type:"default"}}`, `openaiCompatible:{cache_control}`,
  `copilot:{copilot_cache_control}`, `alibaba:{cacheControl}`; native
  Anthropic/Bedrock use message-level provider options, the others mark the last
  content block. Supplying a top-level `options.cacheControl` in the `chat.params`
  hook disables the `applyCaching` path (flips to automatic). Anthropic usage is
  normalized into `tokens.cache.{read,write}` via `getUsage`
  (`cacheReadInputTokens`/`cacheWriteInputTokens`, with fallbacks
  `metadata.anthropic.cacheCreationInputTokens`,
  `metadata.vertex.cacheCreationInputTokens`,
  `metadata.bedrock.usage.cacheWriteInputTokens`); there is **no TTL-specific
  handling** (only read/write totals). See RF-OC-002.
- Evidence: [O]
- Sources: OpenCode tag `v1.18.34` — `packages/opencode/src/provider/transform.ts`
  (`applyCaching`, `message()` gate), `packages/opencode/src/session/llm/request.ts`,
  `packages/opencode/src/session/session.ts` (`getUsage`); local `opencode@1.18.34`
  binary. Accessed 2026-10-04.
- Justifies: keeping Claude **passive** in `src/cache-policy-core.mjs`
  (`anthropic.claude`, no overlay) and not injecting `cacheControl`/`cache_control`.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode changes `applyCaching`, the provider gating, or the
  `chat.params` options path.
- Superseded by: null
- Notes: Injecting our own top-level `cacheControl` would switch OpenCode to
  automatic caching and risk duplicate/TTL-conflicting markers (HTTP 400). A
  parallel `@opencode-ai/llm` `CacheHint` layer also contains
  `BEDROCK_BREAKPOINT_CAP = 4` and a `cachePoint:{type:"default",ttl:"1h"}`
  constant; its reachability in this build is **UNKNOWN** — the runtime path above
  is `provider/transform.ts`. The gate has **two** id checks (`api.id` and
  `model.id`), and the `@ai-sdk/gateway` exclusion targets the **Vercel AI
  Gateway**; OpenCode **Zen**/**Go** use per-model native npm, so they are not
  excluded (see RF-OC-009).

### RF-OC-009 — OpenCode Claude route support: Zen caches; Go has no Claude; subscription OAuth is absent

- Status: current
- Verified: 2026-10-04
- Area: opencode-runtime
- Fact: (1) OpenCode **Zen** (`opencode`, `opencode.ai/zen/v1/messages`) serves
  Claude via `@ai-sdk/anthropic` and lists Cached-Read and Cached-Write pricing,
  so Anthropic caching applies (applyCaching; not `@ai-sdk/gateway`). (2)
  **OpenCode Go** (`opencode-go`, `https://opencode.ai/zen/go/v1/*`) is a hosted
  subscription gateway that serves **no Claude models** (MiniMax/Qwen only); its
  Anthropic-style `/v1/messages` routes are for those non-Claude models. (3)
  Claude Pro/Max **subscription OAuth is not built into OpenCode 1.18.34** — the
  bundled Anthropic-subscription plugin was removed in 1.3.0 and the third-party
  `opencode-anthropic-auth` package is deprecated; Anthropic prohibits third-party
  subscription use. (4) The `@ai-sdk/gateway` exclusion targets the **Vercel AI
  Gateway**, not Zen/Go.
- Evidence: [D]
- Sources: OpenCode tag `v1.18.34` `provider/transform.ts` and
  `packages/opencode/package.json`; https://opencode.ai/docs/go/ ;
  https://opencode.ai/docs/zen/ ; https://registry.npmjs.org/opencode-anthropic-auth.
  Accessed 2026-10-04.
- Justifies: classifying the Claude subscription path as **outside the plugin's
  effective scope**, and keeping CacheEngine passive on every route.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode adds/removes a subscription provider or changes the Zen/Go model set.
- Superseded by: null
- Notes: A route may serve a Claude model without exposing Anthropic caching; do
  not infer cache support from the model catalogue.

### RF-OC-010 — OpenCode is a no-op for Gemini caching and normalizes cachedContentTokenCount to cache.read

- Status: current
- Verified: 2026-10-05
- Area: opencode-runtime
- Fact: In OpenCode 1.18.34 the `applyCaching` gate does **not** include
  Gemini/Google (the gate covers `anthropic`, `google-vertex-anthropic`,
  `anthropic`/`claude` ids, `@ai-sdk/anthropic`, and `@ai-sdk/alibaba`; it
  excludes `@ai-sdk/gateway`), so Gemini is a **no-op** for OpenCode's cache
  markers. The native Gemini protocol body has no cache-control field, and usage
  is normalized from `usageMetadata.cachedContentTokenCount` → `tokens.cache.read`
  with **no write** (upstream `@ai-sdk/google` `convertGoogleUsage` sets
  `cacheWrite: undefined`; the native `packages/llm/src/protocols/gemini.ts`
  `mapUsage` does the same). OpenCode's Gemini protocol comments call the
  `CacheHint` layer "a no-op for Gemini" and the explicit `CachedContent` API
  "intentionally not wired up". Provider ids: `google` → `@ai-sdk/google`,
  `google-vertex` → `@ai-sdk/google-vertex`. Zen (`opencode`) serves Gemini via
  `@ai-sdk/google`; Go (`opencode-go`) exposes no Gemini.
- Evidence: [D]/[O]
- Sources: OpenCode tag `v1.18.34` — `packages/opencode/src/provider/transform.ts`,
  `packages/opencode/src/session/session.ts`,
  `packages/opencode/src/session/llm/ai-sdk.ts`,
  `packages/llm/src/protocols/gemini.ts` and its recorded cache test; local
  `opencode@1.18.34` binary and `~/.cache/opencode/models.json`. Accessed 2026-10-05.
- Justifies: the passive `google.gemini` policy in `src/cache-policy-core.mjs`.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenCode adds a Gemini cache marker or changes the native Gemini runtime.
- Superseded by: null
- Notes: Because OpenCode adds no Gemini cache field, CacheEngine must not either.

### RF-OC-011 — OpenCode Go exposes no Gemini; Zen exposes Gemini via @ai-sdk/google

- Status: current
- Verified: 2026-10-05
- Area: opencode-runtime
- Fact: OpenCode **Go** (`opencode-go`, `https://opencode.ai/zen/go/v1/models`)
  exposes **no Gemini** models and asks clients to send a stable
  `x-opencode-session` for routing/prompt caching. Its catalog (per official
  docs) is:
  - `@ai-sdk/openai` (`/zen/go/v1/responses`): `grok-4.7`, `grok-4.6`,
    `gpt-6-luna`, `gpt-5.6-luna`, `muse-spark-1.3-contributor`,
    `muse-spark-1.2-contributor` (installed catalog also lists `grok-4.5`).
  - `@ai-sdk/anthropic` (`/zen/go/v1/messages`): `minimax-m3`, `minimax-m2.7`,
    `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus` (installed catalog also lists
    `qwen3.6-plus`).
  - `@ai-sdk/openai-compatible` (`/zen/go/v1/chat/completions`): `glm-5.3-flash`,
    `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`,
    `longcat-2.0`, `longcat-2.5-preview-free`, `deepseek-v4.1-flash`,
    `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`,
    `mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.5`, `mimo-v2.5-pro`,
    `hy4-preview`, `hy3`, `space-bunny-free`.
  Go prices Cached Read for most models; Cached Write only for MiniMax M2.7,
  Qwen3.8 Max/Flash, Qwen3.7 Plus, GPT 6 Luna, GPT 5.6 Luna.
- OpenCode **Zen** (`opencode`, `https://opencode.ai/zen/v1/models`) **does**
  serve Gemini via `@ai-sdk/google`. Documented transport mapping: Gemini →
  `@ai-sdk/google`; Claude → `@ai-sdk/anthropic`; GPT/Grok/Muse → `@ai-sdk/openai`;
  DeepSeek/MiniMax/GLM/Kimi/LongCat/Hy and the free models →
  `@ai-sdk/openai-compatible`; Qwen mixed (`@ai-sdk/anthropic` and
  `@ai-sdk/openai-compatible`). Zen prices Cached Read for Gemini and **no**
  Cached Write (consistent with Gemini having no write field).
- **Zen Gemini ids** (`@ai-sdk/google`): `gemini-3-flash`, `gemini-3-pro`,
  `gemini-3.1-pro`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`,
  `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`.
- **Complete installed Zen catalog** (`~/.cache/opencode/models.json`, 116 ids):
  Claude (`claude-3-5-haiku`, `claude-fable-5`, `claude-fable-5-1`,
  `claude-haiku-4-5`, `claude-opus-4-1`, `claude-opus-4-5`, `claude-opus-4-6`,
  `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`,
  `claude-sonnet-4`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5`,
  `claude-sonnet-5-5`); DeepSeek (`deepseek-v4-flash`, `deepseek-v4-flash-free`,
  `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`, `deepseek-v4.1-flash`);
  Gemini (above); GLM (`glm-4.6`, `glm-4.7`, `glm-4.7-free`, `glm-5`, `glm-5-free`,
  `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`); GPT (`gpt-5`, `gpt-5-codex`,
  `gpt-5-nano`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`,
  `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`,
  `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`,
  `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`); Grok (`grok-4.5`,
  `grok-4.6`, `grok-4.7`, `grok-build-0.1`, `grok-code`); Kimi (`kimi-k2`,
  `kimi-k2-thinking`, `kimi-k2.5`, `kimi-k2.5-free`, `kimi-k2.6`,
  `kimi-k2.7-code`, `kimi-k3`); MiniMax (`minimax-m2.1`, `minimax-m2.1-free`,
  `minimax-m2.5`, `minimax-m2.5-free`, `minimax-m2.7`, `minimax-m3`,
  `minimax-m3-free`); Muse (`muse-spark-1.2`, `muse-spark-1.2-contributor-free`,
  `muse-spark-1.3`, `muse-spark-1.3-contributor-free`); Qwen (`qwen3-coder`,
  `qwen3.5-plus`, `qwen3.6-plus`, `qwen3.6-plus-free`, `qwen3.8-flash`,
  `qwen3.8-max`); LongCat (`longcat-2.0-free`, `longcat-2.5-preview-free`); Hy
  (`hy3-free`, `hy3-preview-free`); other free/preview (`big-pickle`,
  `fledge-alpha-free`, `laguna-s-2.1-free`, `ling-2.6-flash-free`,
  `ling-3.0-flash-fin-free`, `ling-3.0-flash-free`, `ling-3.0-tiny-free`,
  `ling-3.1-flash-free`, `mimo-v2-flash-free`, `mimo-v2-omni-free`,
  `mimo-v2-pro-free`, `mimo-v2.5-free`, `mimo-v2.6-flash-free`,
  `nemotron-3-super-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`,
  `north-mini-code-free`, `ring-2.6-1t-free`, `space-bunny-free`,
  `trinity-large-preview-free`, `x-preview-f-free`). The installed catalog also
  lists 33 Go models (none matching `gemini`).
- Evidence: [D]/[O]
- Sources: https://opencode.ai/docs/go/ , https://opencode.ai/docs/zen/ ;
  installed `~/.cache/opencode/models.json`. Accessed 2026-10-05.
- Justifies: the passive Gemini policy stays correct on both hosted routes; the
  matcher stays catalog-independent (no `opencode-go`/`opencode` special-casing).
- Version context: OpenCode 1.18.34 (installed); the live docs may describe a
  newer version. Hosted model catalogs change frequently.
- Re-verify when: OpenCode Go or Zen changes its model catalog or provider routing.
- Superseded by: null
- Notes: These catalogs are research evidence, not classifier configuration; do
  not hardcode Zen's current Gemini list into the matcher.

### RF-OC-012 — OpenCode applies caching to Qwen only on the Messages routes; no installed provider uses `@ai-sdk/alibaba`

- Status: current
- Verified: 2026-10-05
- Area: opencode-runtime
- Fact: In the installed 1.18.34 catalog every Alibaba provider (`alibaba`,
  `alibaba-cn`, `alibaba-coding-plan`, `alibaba-coding-plan-cn`,
  `alibaba-token-plan`, `alibaba-token-plan-cn`) declares
  `@ai-sdk/openai-compatible`, and **no** provider or model anywhere declares
  `@ai-sdk/alibaba` (0 entries). Therefore `ProviderTransform.applyCaching`
  (RF-OC-008) cannot fire for direct DashScope / Coding-Plan / Token-Plan Qwen —
  none of its `providerID` / `api.id` / `model.id` / `api.npm` branches match — and
  OpenCode adds no cache marker there. It **does** fire on the OpenCode Messages
  routes, where the per-model `provider.npm` is overridden to
  `@ai-sdk/anthropic`: Go `qwen3.8-max` / `qwen3.8-flash` / `qwen3.7-plus`, and
  Zen `qwen3.5-plus` / `qwen3.6-plus` / `qwen3.6-plus-free` / `qwen3.8-flash`.
  There it marks the last content block with the `@ai-sdk/anthropic`
  `cacheControl:{type:"ephemeral"}` option (RF-OC-008). `getUsage` (RF-OC-008) has
  no `metadata.alibaba` / `metadata.dashscope` fallback, so a Qwen cache-write
  count is populated only on the Anthropic Messages route
  (`cache_creation_input_tokens`); OpenAI-compatible / DashScope reports reads
  only (`cache.read`), with `cache.write = 0`.
- Evidence: [O]/[D]
- Sources: installed `~/.cache/opencode/models.json` walked 2026-10-05;
  OpenCode `v1.18.34` `packages/opencode/src/provider/transform.ts` +
  `packages/opencode/src/session/session.ts` (per RF-OC-008); OpenCode Go/Zen
  route tables https://opencode.ai/docs/go/ and https://opencode.ai/docs/zen/ ;
  accessed 2026-10-05.
- Justifies: `src/cache-policy-core.mjs` `alibaba.qwen` staying passive on every
  Qwen route (no overlay, no affinity); the passive Qwen route tests in
  `test/cache-engine.test.mjs`; the inventory §8a Qwen route rows.
- Version context: OpenCode 1.18.34 (installed); catalog walked 2026-10-05.
- Re-verify when: OpenCode adds an `@ai-sdk/alibaba` provider or model override,
  changes `applyCaching`/`getUsage`, or changes the Go/Zen Qwen model set.
- Superseded by: null
- Notes: Harness-side confirmation of RF-PRV-006; the Go/Zen catalog itself is
  RF-OC-011. The `@ai-sdk/alibaba` branch exists in the bundled source but is
  dormant for the installed catalog today.

### RF-OC-013 — OpenCode 1.18.34 routes direct xAI through the Responses API and pre-sets `promptCacheKey = sessionID`

- Status: current
- Verified: 2026-10-06
- Area: opencode-runtime
- Fact: In the installed OpenCode 1.18.34 binary the provider effect for
  `providerID === "xai"` sets `language = sdk.responses(model.api.id)` — direct
  xAI is **always the Responses API** (`https://api.x.ai/v1/responses`), never
  Chat Completions. The xai effect has **no** Chat/Responses branch (unlike
  `github-copilot`, which branches on `options.endpoint`). The provider
  `options()` also sets `providerOptions.xai.promptCacheKey = sessionID` for
  `@ai-sdk/xai` when `setCacheKey !== false` (the same branch as `@ai-sdk/openai`,
  `@ai-sdk/azure`, `@ai-sdk/mistral`, `venice-ai-sdk-provider`). The bundled
  `@ai-sdk/xai` Responses request builder then emits the wire field
  `prompt_cache_key` from `promptCacheKey` (xAI chunk, near `createXai`; also
  `...previous_response_id:J.previousResponseId,...prompt_cache_key:J.promptCacheKey`
  and `...B.promptCacheKey!=null&&{prompt_cache_key:B.promptCacheKey}`). The string
  `x-grok-conv-id` appears **zero** times in the binary. OpenCode also sets
  `store = false` for xai. Consequences for CacheEngine: (1) the direct-xAI Chat
  Completions `x-grok-conv-id` path is **unreachable** and is not implemented;
  (2) the Responses affinity key is already supplied by the harness and must be
  **preserved**, never overwritten; (3) no Grok-specific usage parser is needed —
  xAI Responses reports `usage.input_tokens_details.cached_tokens`, which the AI
  SDK surfaces as `cachedInputTokens`/`inputTokenDetails.cacheReadTokens` and
  OpenCode normalizes into `tokens.cache.read` (the same generic path as
  RF-OC-002/RF-OC-010; `cache_creation_input_tokens` exists only in Anthropic
  schemas, so xAI has no write bucket).
- Evidence: [O]
- Sources: local `opencode@1.18.34` binary (`~/.opencode/bin/opencode`),
  inspected 2026-10-06 via embedded-JS extraction: the `{id:"xai"}` provider
  effect (`e.language=e.sdk.responses(e.model.api.id)`), the `options()`
  `promptCacheKey=$.sessionID` branch, and the `@ai-sdk/xai`
  `prompt_cache_key` serializer. Complements RF-OC-008 (Anthropic gate) and
  RF-OC-012 (Qwen routes).
- Justifies: keeping `xai.grok` passive in `src/cache-policy-core.mjs` and
  injecting no header/key in `src/cache-engine.ts`; the `grok_affinity` telemetry
  `affinitySource: "preexisting"`; the Grok route tests.
- Version context: OpenCode 1.18.34 (bundled `@ai-sdk/xai`).
- Re-verify when: OpenCode changes the xai provider effect (`responses` vs
  `chat`), the `options()` `promptCacheKey` branch, or the bundled `@ai-sdk/xai`
  serializer.
- Superseded by: null
- Notes: The binary also contains the string `1.19.101` (likely update metadata)
  while the running version is `1.18.34`. Do not assume the Chat Completions
  path — the exact runtime route is Responses. This makes the xAI case the
  mirror image of OpenAI: both use a `prompt_cache_key` wire field, but for xAI
  it is a routing/affinity hint supplied on the harness side, not an
  OpenAI-style `prompt_cache_options` policy (do not reuse GPT semantics).

### RF-OC-014 — OpenCode 1.18.34 drives Muse via Chat Completions (direct Meta) / Responses (Zen, Go) and pre-sets `promptCacheKey = sessionID`

- Status: current
- Verified: 2026-10-06
- Area: opencode-runtime
- Fact: The bundled OpenCode 1.18.34 catalog defines direct Meta as
  `meta: { id: "meta", env: ["META_MODEL_API_KEY"], npm: "@ai-sdk/openai",
  api: "https://api.meta.ai/v1", name: "Meta" }` with models `muse-spark-1.3`,
  `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`,
  `muse-spark-1.3-contributor`. There is **no provider-specific `language`
  effect for `meta`** (unlike `openai` → `sdk.responses(...)` and `xai` →
  `sdk.responses(...)`); the AISDK language runner falls back to
  `h.language ?? m.languageModel(d.api.id)`, so direct Meta is driven through the
  **Chat Completions** model of `@ai-sdk/openai`. OpenCode's `options()` sets
  `providerOptions.promptCacheKey = sessionID` for `@ai-sdk/openai` (the branch
  covering `@ai-sdk/openai`/`@ai-sdk/azure`/`@ai-sdk/xai`/`@ai-sdk/mistral`/
  venice when `setCacheKey !== false`), and also sets `reasoningSummary:"auto"`
  plus `include` when `providerID === "meta"`. The OpenAI **Chat Completions**
  serializer emits the wire field `prompt_cache_key` from `promptCacheKey` (and
  also supports `prompt_cache_options` and `prompt_cache_retention`). For
  `providerID` starting with `opencode` (Zen/Go) OpenCode sets
  `promptCacheKey = sessionID`, `include`, and `reasoningSummary:"auto"`; per
  RF-OC-011 Zen/Go serve Muse via `@ai-sdk/openai` on `/zen[/go]/v1/responses`,
  and Go additionally asks clients to send a stable `x-opencode-session`.
  OpenCode does **not** expose or set `prompt_cache_retention`. Consequence:
  CacheEngine must preserve the harness `promptCacheKey` and must not inject a
  key or retention value. Meta documents that `prompt_cache_key` should be an
  application-stable value and **not** a per-session value (RF-PRV-008), so the
  harness value on these routes is plausible-per-session and CacheEngine must
  not "fix" it by overwriting.
- Evidence: [O]
- Sources: local `opencode@1.18.34` binary (`~/.opencode/bin/opencode`),
  inspected 2026-10-06: the `meta` provider catalog entry; the
  `AISDK.language` fallback `h.language??m.languageModel(d.api.id)`; the
  `options()` `promptCacheKey=$.sessionID` branch and the providerID-startsWith
  `opencode` branch; the OpenAI Chat serializer
  `...prompt_cache_key:M.promptCacheKey,prompt_cache_options:...`; and the
  `prompt_cache_retention` serializers. Complements RF-OC-011 (Go/Zen catalogs)
  and RF-OC-013 (xAI).
- Justifies: the passive `meta.muse` policy in `src/cache-policy-core.mjs`; the
  `muse_affinity` telemetry `affinitySource`; the Muse route tests.
- Version context: OpenCode 1.18.34 (bundled `@ai-sdk/openai`).
- Re-verify when: OpenCode adds a `meta` provider language effect (chat vs
  responses), changes the `options()` `promptCacheKey` branch, or the bundled
  `@ai-sdk/openai` serializers change.
- Superseded by: null
- Notes: Direct Meta being Chat Completions is an inference from the absent
  provider effect + the runner fallback ([O]/[I]); the wire behavior of
  `promptCacheKey` on Chat Completions is [O] from the serializer. Do not treat
  the OpenCode-supplied key as authoritative cache guidance for Meta — Meta's own
  docs say a per-session key lowers hit rate.

### RF-OC-015 — OpenCode 1.18.34 routes direct MiniMax and OpenCode Go through the Anthropic SDK, and Zen through the OpenAI-compatible SDK

- Status: current
- Verified: 2026-10-07
- Area: opencode-runtime
- Fact: The bundled OpenCode 1.18.34 catalog defines direct MiniMax as
  `minimax: { id: "minimax", env: ["MINIMAX_API_KEY"], npm: "@ai-sdk/anthropic",
  api: "https://api.minimax.io/anthropic/v1", name: "MiniMax (minimax.io)" }`, and
  the MiniMax Token Plan providers `minimax-coding-plan` / `minimax-cn-coding-plan` with the
  same `@ai-sdk/anthropic` npm and `/anthropic/v1` base URL. So direct MiniMax is
  driven through the **Anthropic-compatible Messages API**. Because OpenCode's
  `ProviderTransform.applyCaching` gate matches `api.npm === "@ai-sdk/anthropic"`,
  **OpenCode itself inserts Anthropic `cache_control` breakpoints on the direct
  MiniMax routes** (first two system messages, last two non-system messages,
  `{type:"ephemeral"}`, ≤4) — unless a top-level `options.cacheControl` is
  supplied, which flips to automatic (RF-OC-008). OpenCode **Go**
  (`opencode-go`) serves `minimax-m3` and `minimax-m2.7` via `@ai-sdk/anthropic`
  on `/zen/go/v1/messages` (per RF-OC-011), so the same `applyCaching` fires there
  too, and Go asks clients to send a stable `x-opencode-session`. OpenCode **Zen**
  (`opencode`) serves `minimax-m3`/`-m2.7`/`-m2.5` via
  `@ai-sdk/openai-compatible` on `/zen/v1/chat/completions`, which the
  `applyCaching` gate does **not** match, so Zen MiniMax is passive-only.
  Consequences: CacheEngine must not duplicate or compete with the harness
  breakpoints on the `@ai-sdk/anthropic` routes, and must not inject any MiniMax
  cache field on Zen/OpenRouter/gateways. This route asymmetry (same model,
  different SDK/cache contract) is why MiniMax is route-aware but passive.
- Evidence: [O]
- Sources: local `opencode@1.18.34` binary (`~/.opencode/bin/opencode`),
  inspected 2026-10-07: the `minimax` / `minimax-coding-plan` catalog entries;
  the `applyCaching` gate
  `(... || api.npm === "@ai-sdk/anthropic" || api.npm === "@ai-sdk/alibaba") && api.npm !== "@ai-sdk/gateway" && !usesAnthropicAutomaticCaching`;
  the per-model `@ai-sdk/anthropic` overrides on `opencode-go`. Complements
  RF-OC-008 (Anthropic gate) and RF-OC-011 (Go/Zen catalogs).
- Justifies: the passive `minimax.m3` / `minimax.m2` policies; the
  `minimax_route` telemetry `route` / `harnessAnthropicCaching` fields; the
  MiniMax route tests.
- Version context: OpenCode 1.18.34 (bundled `@ai-sdk/anthropic` and
  `@ai-sdk/openai-compatible`).
- Re-verify when: OpenCode changes the MiniMax provider npm/base URL, the
  `applyCaching` gate, or the Go/Zen MiniMax transport.
- Superseded by: null
- Notes: `applyCaching` fires for direct MiniMax including **M3**, which is not in
  MiniMax's explicit `cache_control` model list; whether MiniMax ignores or
  rejects those breakpoints on M3 is unverified ([U]). CacheEngine does not
  intervene in OpenCode's transform.

### RF-OC-016 — OpenCode union-merges `plugin` arrays across config files, and `~/.opencode/opencode.json` is outside `XDG_CONFIG_HOME`

- Status: current
- Verified: 2026-10-09
- Area: opencode-runtime
- Fact: OpenCode discovers plugin entries from several config sources and
  **unions** their `plugin` arrays instead of replacing one source's list with
  another's. Sources observed on 1.18.35: the global config dir
  (`$XDG_CONFIG_HOME/opencode/opencode.json[c]`, default `~/.config/opencode`), a
  separate `~/.opencode/opencode.json[c]` directory, and the project
  `<dir>/.opencode/opencode.json[c]`; `OPENCODE_CONFIG` is **added** to the
  candidate path list (it does not replace the others). A `file://` entry in
  `plugin` is loaded and its module runs (verified with an import marker).
  Consequences: (a) a project config that sets `"plugin": []` or points `plugin`
  at a `file://` module does **not** suppress a plugin declared in
  `~/.opencode/opencode.json`; on this machine that file lists
  `"opencode-cache-engine"`, resolved to the npm-cached **0.5.7** under
  `~/.cache/opencode/packages/opencode-cache-engine/`. (b) `~/.opencode/` is not
  under `XDG_CONFIG_HOME`, so `XDG_CONFIG_HOME=<empty>` (which does bypass
  `~/.config/opencode`) cannot bypass it. (c) Combining a working-tree `file://`
  CacheEngine entry with the existing `opencode-cache-engine` entry makes the
  CacheEngine `event`/session-idle handler run **twice** for one idle (two
  `idle: no new assistant usage` records for the same session), i.e. two
  CacheEngine instances are active. There is no config-only way to load exactly
  one CacheEngine from a working-tree `file://` source while the
  `~/.opencode/opencode.json` entry remains — doing so requires editing that file
  or relocating `HOME`/config.
- Evidence: [O]
- Sources: OpenCode `v1.18.35` runtime `--print-logs --log-level DEBUG` config-load
  lines (`loading config from` `~/.config/opencode/...`, `<dir>/.opencode/opencode.json`,
  `~/.opencode/opencode.json`); the `~/.opencode/opencode.json` `plugin` list;
  `~/.cache/opencode/packages/opencode-cache-engine/node_modules/opencode-cache-engine/package.json`
  (`"version": "0.5.7"`); an isolated `file://` wrapper module's import marker and
  CacheEngine session-idle record counts (1 with an empty project `plugin` list vs
  2 with the wrapper present). Accessed 2026-10-09.
- Justifies: why the MiMo-V2.6-Flash live integration test was BLOCKED (the repo
  v0.6.0 `file://` source could not be isolated from the npm-cached 0.5.7). No
  runtime or policy change follows: it is an environment/config fact, and
  CacheEngine must remain loadable as the named npm plugin.
- Version context: OpenCode 1.18.35 (installed); `~/.opencode/opencode.json` and
  `~/.config/opencode/opencode.jsonc` as of 2026-10-09; npm-cached
  `opencode-cache-engine@0.5.7`.
- Re-verify when: OpenCode changes config/plugin discovery (e.g. makes
  `OPENCODE_CONFIG` replace rather than add, honors XDG for `~/.opencode`, or adds
  a plugin dedup/disable flag); or the user edits or relocates
  `~/.opencode/opencode.json`.
- Superseded by: null
- Notes: Distinguishes "loaded from the working tree" from "loaded from the npm
  cache": a bare `file://` project `plugin` entry **adds** a second instance rather
  than replacing the named package. To run a clean single-source live test the
  `opencode-cache-engine` entry must be temporarily removed from
  `~/.opencode/opencode.json`, or OpenCode run under an isolated `HOME` with
  `auth.json` available — both edit shared state and require explicit
  authorization.

### RF-OC-017 — OpenCode V2 (2.0.26) is a plain `{ id, setup }` plugin model with a `./v2` package entry

- Status: current
- Verified: 2026-10-10
- Area: opencode-runtime
- Fact: The running OpenCode is **v2.0.26** and its V2 plugin API package is
  **`@opencode/plugin@2.0.25`** (observed at
  `~/.cache/opencode/packages/opencode-mem@latest/node_modules/@opencode/plugin`).
  A V2 plugin is a plain object `{ id, setup(ctx) }`; `define()` from
  `@opencode/plugin` (and `@opencode/plugin/effect`) is the **identity function**
  (`export function define(plugin){ return plugin }`), so a plugin requires no
  runtime import. `setup` may return a cleanup callback. Package discovery: an
  npm plugin declares its V2 entry via the **`"./v2"` export** while V1 uses
  `"./server"` (working example `opencode-mem` maps `"."`/`"./server"` → V1 and
  `"./v2"` → V2, and declares `"opencode": { "type": "plugin", "hooks": [...] }`).
  The V2 user-config key is **`"plugins"`** (renamed from V1 `"plugin"`;
  `providers`, model `settings` are likewise renamed). The on-disk
  `@opencode-ai/plugin@1.18.35` exposes a *partial*, older `v2` surface
  (`./v2/promise`, `./v2/effect`) whose `PluginContext` omits `session`/`event`;
  the runtime's real context is richer — do **not** target the 1.18.35 types for V2.
- Evidence: [O]
- Sources: local — `opencode --version` (`2.0.26`);
  `.../opencode-mem@latest/node_modules/@opencode/plugin/package.json` (2.0.25) and
  `dist/promise/plugin.js` (`define` identity); `opencode-mem/package.json`
  (`exports`, `opencode` field); `~/.config/opencode/opencode.jsonc` (`plugins`).
  Accessed 2026-10-10.
- Justifies: the `src/cache-engine-v2.mjs` registration shape and the
  `package.json` `./v2` export + `opencode` field.
- Version context: OpenCode 2.0.26; `@opencode/plugin` 2.0.25.
- Re-verify when: OpenCode changes plugin registration, entry resolution, or the
  config key.
- Superseded by: null
- Notes: `@opencode-ai/plugin` remains the V1 authoring package. The
  `"opencode"` metadata field (seen on `opencode-mem`/`harness-memory`) is **not
  required** for discovery: `@slkiser/opencode-quota` and
  `@tarquinen/opencode-dcp` are configured in the V2 `plugins` list with no
  `opencode` field and no `"./v2"` export. The `"./v2"` export is the V2 entry
  convention observed on the V2-capable reference (`opencode-mem`); whether the
  loader prefers `"./v2"` over `"."`/`"./server"` was not verified in a live
  session (deferred). `opencode plugin list` reads configuration only and does
  **not** execute a plugin; local plugins in `~/.opencode/plugins/*.ts` are listed
  as `local`. Plugin discovery/service binding is **not** fully env-isolatable:
  with `HOME`/`XDG_*` redirected to a temp tree the runtime still resolved the
  user's plugin set, and a private `opencode serve` neither accepts `--standalone`
  nor loaded a local plugin probe — so a package cannot be load-tested without
  editing shared configuration. The 2.0.26 CLI honors neither `OPENCODE_CONFIG`
  nor `OPENCODE_CONFIG_DIR` for `opencode plugin list`, which queries the running
  **managed** service (registered in `<XDG_STATE_HOME>/opencode/service.json`) that
  owns plugin discovery; a competing `serve --service` risks deregistering it.

### RF-OC-018 — OpenCode V2 hook, event, message and usage shapes

- Status: current
- Verified: 2026-10-10
- Area: opencode-runtime
- Fact: V2 `PluginContext` domains (from `@opencode/plugin@2.0.25`
  `dist/promise/plugin.d.ts`): `app, location, options, agent, aisdk, command,
  event, experimental, integration, mcp, model, generate, permission, plugin,
  provider, reference, rpc, session, shell, skill, storage, tool, vcs, websearch,
  worktree`. Relevant contracts:
  - `session.hook(name, cb, options?)` (ModelHooks; `options.providerID` scopes a
    hook to one provider). Session events: `prompt`, `context`, `compaction`,
    `generate`, `title`, `model.request`, `http.request`, `http.response`,
    `retry`, plus experimental `experimental.ws.*`. Inputs are mutable.
    - `context` input `SessionContext`: `{ sessionID, agent, model: { id,
      providerID }, system: SystemPart[], messages, options, tools }`.
      `SystemPart = { type: "text", text }`. `options` (SessionRequestOptions) =
      typed generation settings plus arbitrary provider options.
    - `model.request` input `SessionModelRequest`: `{ sessionID, agent, model,
      kind: "primary"|"compaction"|"title"|"generate", baseURL?, headers:
      Record<string,string> }`.
  - `event.subscribe()` → `AsyncIterable<V2Event>`; `session.idle` is
    `{ type: "session.idle", data: { sessionID } }` and `session.deleted` is
    `{ type: "session.deleted", durable: {…}, data: { sessionID } }` (session-scoped;
    use it to drop per-session state).
  - `session.context({ sessionID })` → `Promise<SessionMessageInfo[]>`; an
    assistant message is `{ id, type: "assistant", time: { created }, model: {
    id, providerID }, tokens?: TokenUsageInfo }`; `TokenUsageInfo = { input,
    output, reasoning, cache: { read, write } }` (matches CacheEngine's
    normalized usage).
  - `session.usage.updated` event carries `data.tokens: TokenUsageInfo`.
- Evidence: [O]
- Sources: local — `.../@opencode/plugin/dist/promise/{plugin,session,event,aisdk,registration}.d.ts`;
  `.../@opencode/client/dist/promise/client.d.ts` and
  `.../generated/types.d.ts` (`SessionMessageAssistant`, `TokenUsageInfo`,
  `MessageListInput`, `V2Event`). Accessed 2026-10-10.
- Justifies: `src/cache-engine-v2.mjs` — `<env>`/GPT transforms at `context`,
  OpenRouter affinity at `model.request`, and usage aggregation from
  `session.context` on `session.idle`.
- Version context: `@opencode/plugin` 2.0.25 / OpenCode 2.0.26.
- Re-verify when: OpenCode changes the session hook names/shapes, the event
  stream, or the usage/message schema.
- Superseded by: null
- Notes: `session.usage.updated` delta-vs-cumulative semantics and
  `session.context` array ordering are **unverified**; the adapter sorts by
  `info.time.created` (ties keep input order) and reuses the shared
  cursor/watermark. `SessionContext` (the `context` hook input) exposes
  `sessionID`, `model`, `system`, `messages`, `options`, `tools` but **no
  `kind`**; only `model.request` (`SessionModelRequest`) carries
  `kind ∈ {primary, compaction, title, generate}` — so the `context` hook cannot
  filter by request kind. Re-verified 2026-10-11 against the currently installed
  **`@opencode/plugin@2.0.16`** (same `SessionContext`/`SessionModelRequest`
  shape as the earlier 2.0.25 observation). **Related test:**
  `test/cache-engine.test.mjs` → "v2 contract: installed SessionContext has no
  request-kind field (declaration-level)" pins the declared shape (it does **not**
  assert which request kinds invoke the `context` hook at runtime). **Implementation
  inspection (2026-10-11, installed `@opencode/plugin@2.0.16`, resolved at
  `~/.cache/opencode/packages/@slkiser/opencode-quota@latest/node_modules/@opencode/plugin`):**
  `dist/promise/adapter.js` is only a promise→Effect forwarder —
  `session.hook: (name, callback, options) => register(host.session.hook(name, (event) => Effect.promise(() => Promise.resolve(callback(event))), options))`
  (~L418), where `register` resolves the registration to `{ dispose }` (~L177) and
  `host` is the runtime-provided plugin host. The package ships **no** local hook
  registry or dispatch: `dist/promise/session.js`, `dist/promise/registration.js`,
  `dist/effect/session.js`, and `dist/effect/registration.js` are **0 bytes**, and
  `dist/host.js` contains no session/hook/kind logic. Dispatch and any request-kind
  gating are therefore entirely **server-side (the OpenCode runtime)** and are not
  present in this package. Observed: the adapter neither adds nor strips a `kind`
  discriminator and forwards the `{ providerID }` scoping option verbatim.
  **Consequence:** whether auxiliary request kinds (`compaction`/`title`/`generate`)
  invoke `context` cannot be established from the installed package source and
  remains **unverified** (it requires the server implementation or a live runtime
  test). No code change is justified. **Server-side dispatch (observed in the
  embedded OpenCode 2.0.26 implementation, `@opencode/SessionModelRequest`
  service):** each session request kind maps to exactly one hook name —
  `primary → trigger("session","context", …)`, `compaction →
  trigger("session","compaction", …)`, `generate → trigger("session","generate", …)`,
  `title → trigger("session","title", …)` — through the trigger helper
  `r = (name, agent) => (payload, tools) => H.trigger("session", name, { ...payload, agent, tools })`
  and the per-kind entries
  `primary: f("primary", i, r("context", i.agent)); compaction: f("compaction", i, r("compaction", i.agent)); generate: f("generate", i, r("generate", i.agent)); title: f("title", i, (u) => H.trigger("session","title", u))`.
  The payload `p = { sessionID, agent, model, kind }` is assembled in
  `SessionModelRequest.prepare` (the same structure whose `kind` is exposed on
  `model.request`). **Consequence:** the `context` hook is invoked only for the
  `primary` kind; the auxiliary kinds (`compaction`, `generate`, `title`) invoke
  their own hook names and do **not** invoke `context`. So `onContext` needs no
  request-kind guard — it is simply not called for auxiliary kinds by this
  dispatcher. Evidence class: **observed server implementation** (embedded code
  in the 2.0.26 binary), not a live runtime registration test; actual plugin
  registration/loading in 2.0.26 remains unverified.

### RF-OC-019 — In an isolated 2.0.26 `run --standalone` flow the runtime delivered `session.usage.updated` but no `session.idle`/`session.deleted`, so the V2 adapter's usage consumer never ran

- Status: current
- Verified: 2026-10-11
- Area: opencode-runtime
- Fact: In a single isolated OpenCode 2.0.26 `opencode run --standalone`
  session driven by a local mock OpenAI-compatible provider, the plugin runtime
  delivered 24 event notifications to the adapter's `event.subscribe()` iterator,
  including `session.usage.updated` (×2), `session.execution.started` /
  `session.execution.succeeded`, `session.step.started` / `session.step.streamed`
  / `session.step.ended`, `session.text.started` / `session.text.delta` /
  `session.text.ended`, `session.inbox.enqueued` / `session.inbox.delivered`,
  `session.renamed`, `session.instructions.updated`, and `location.shutdown` —
  but **neither `session.idle` nor `session.deleted`**. In the same session the
  `context` hook was invoked **once** (the primary request) and `model.request`
  **twice**; the mock provider received exactly two `POST /v1/chat/completions`
  requests and returned responses.
- Evidence: [O]
- Sources: local isolated test 2026-10-11 — disposable `bubblewrap --unshare-net`
  project; OpenCode 2.0.26 (`/home/alex/.opencode/bin/opencode`); checkpoint
  adapter `feature/v2-adapter-checkpoint` @ `1091084`
  (`src/cache-engine-v2.mjs` sha256 `9dc623a8…`); a plugin probe wrapped
  `session.hook` and `event.subscribe` and wrote a marker file; the mock provider
  request log recorded two `/v1/chat/completions` posts and no rejected paths; no
  usage metrics file was produced.
- Justifies: `src/cache-engine-v2.mjs` `consumeEvents` filters
  `ev.type === "session.idle"` (usage) and `ev.type === "session.deleted"`
  (cleanup). This observation shows neither type fired on this runtime path, so
  the adapter's usage consumer stayed inert. Contrasts with `RF-OC-018`, which
  lists `session.idle` as the usage trigger.
- Version context: OpenCode 2.0.26; `@opencode/plugin` 2.0.16; adapter
  checkpoint `1091084`.
- Re-verify when: the adapter's event filters change, OpenCode changes the V2
  event stream, or a flow that is expected to idle (e.g. an interactive/TUI
  session) is tested.
- Superseded by: null
- Notes: **Directly observed:** the 24 event notifications above and the hook
  invocation counts. **Adapter behavior established by this test:** its usage
  consumer did not run and no usage metrics file was written, so usage accounting
  for this runtime path is **unverified**, not failed universally.
  **Hypotheses still needing investigation:** `session.idle` / `session.deleted`
  may be emitted only in other flows (e.g. an interactive/TUI idle, or session
  deletion), or the runtime may name the usage notification
  `session.usage.updated` (which carries `data.tokens`) rather than `session.idle`
  on the `run` path. A single `opencode run --standalone` flow does **not** prove
  `session.idle` / `session.deleted` are never emitted elsewhere. **Evidence
  limits:** one flow, mock OpenAI-compatible provider, no real provider traffic,
  network-isolated; no credentials, prompts, or request bodies were recorded. No
  adapter code was changed.

### RF-OC-020 — OpenCode 2.0.26 emits `session.usage.updated` per turn with cumulative totals and delivers `session.deleted` to an active subscriber; the V2 adapter can drive its shared history scan from `session.usage.updated`

- Status: current
- Verified: 2026-10-11
- Area: opencode-runtime
- Fact:
  - `session.usage.updated` payload: `{ id, created, type: "session.usage.updated",
    data: { sessionID, cost, tokens: { input, output, reasoning, cache: { read,
    write } } } }`, with **no `durable` block** (volatile). It is emitted by the
    server `SessionProjector.publishUsage`, which SELECTs the session row's stored
    totals and publishes them; the row is incremented (`UPDATE … = ${existing} +
    ${added}`) before publishing, and the client reducer **replaces** the stored
    session cost/tokens — so the totals are **cumulative session snapshots, not
    deltas**.
  - It fires per usage change (observed ~1–2 per turn: the primary request plus an
    auxiliary/title request), carries a usable `data.sessionID`, and its totals can
    exceed the sum of `session.context` assistant tokens when auxiliary usage is
    absent from history.
  - `session.deleted` is durable (`durable: { aggregateID, seq, version: 2 }`,
    published by `Session.remove`) and WAS delivered to an **already-active** plugin
    subscriber when deletion targeted that same long-lived server.
  - The `event.subscribe` stream is documented **volatile by contract** ("a slow
    consumer overflows and fails the stream, and events during disconnection are
    missed") — no replay or ordering guarantee.
  - In a persistent server process, `usage.updated` arrives with the just-completed
    assistant already visible in `session.context`; running the shared
    `scanPage`/`nextProcessedCursor` with one persistent cursor/watermark counts
    each assistant exactly once, is idempotent across repeated events over unchanged
    history, and advances only on newly visible messages. Validated with the actual
    checkpoint adapter: two turns produced exactly two `usage` records (cumulative
    read 5 → 10; the auxiliary usage event produced none).
  - `session.idle` is defined and subscribable, but no publisher was found in the
    readable bundle and it was not emitted in the headless server flows →
    emission conditions remain **unverified**.
- Evidence: [O] (server publisher selection/replace + client reducer; isolated
  long-lived `serve` runtime), [I] (cumulative semantics inferred from both)
- Sources: installed `@opencode/client@2.0.16`
  `dist/promise/generated/types.d.ts` (`SessionUsageUpdated`, `SessionDeleted`,
  `SessionIdle`, `TokenUsageInfo`) and `dist/chunks/*` reducer; embedded OpenCode
  2.0.26 binary (`SessionProjector.publishUsage`, `Session.remove`, the
  `event.subscribe` volatile-contract description); isolated `serve` test
  2026-10-11 (`bubblewrap --unshare-net`, local mock OpenAI-compatible provider)
  loading the real checkpoint adapter.
- Justifies: `src/cache-engine-v2.mjs` `consumeEvents` triggering `collectUsage` on
  `session.usage.updated` (primary) while retaining `session.idle` (secondary); its
  regression tests in `test/cache-engine.test.mjs`.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `1091084`.
- Re-verify when: OpenCode changes the V2 event names/payloads or the usage
  projector, the `event.subscribe` volatility contract, or the deletion emission
  path.
- Superseded by: null
- Notes: **Evidence bounds:** a single mock OpenAI-compatible model, two turns, one
  deletion path, no real provider traffic. `session.usage.updated` is volatile, so
  a trigger on it is best-effort (undercount possible, never double-count by design;
  the event's cumulative totals are intentionally not used for accounting).
  `session.deleted` delivery was observed once with an active subscriber; other
  deletion paths (child/subagent removal) are not established. The `session.idle`
  publisher remains unidentified (likely bytecode/interactive). See `RF-OC-019` for
  the original observation and `RF-OC-018` for the event/type shapes.

### RF-OC-021 — `ctx.session.context({ sessionID })` returns the complete active history (all messages after the last compaction) and is distinct from the paginated `/message` list

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact: The V2 client `SessionApi.context` op (exposed to plugins as
  `SessionDomain.context`) maps to the route
  `/api/session/:sessionID/context`, whose **only** input is `{ sessionID }`
  (no `limit`/`cursor`/`order`; `SessionContextInput`), returning
  `SessionMessageInfo[]` (`{ data: [...] }`). The embedded 2.0.26 route
  description is "Retrieve the active context messages for a session (all
  messages after the last compaction)". This is **distinct** from the paginated
  list route `/api/session/:sessionID/message` (`message.list`), which applies
  `limit: r.query.limit ?? 50` (default), `order` default `"desc"`, and returns
  `{ data, cursor }`. In an isolated 2.0.26 runtime a 78-message session returned
  **78** messages from `/context` and **50** (+ `cursor`) from `/message` — so
  `session.context` is **not** truncated to the 50-message page.
- Evidence: [O] (route definition in the 2.0.26 binary; client types/impl) and
  [O] (isolated runtime measurement).
- Sources: embedded OpenCode 2.0.26 binary (`session.context` route definition,
  `/api/session/:sessionID/context`); `@opencode/client@2.0.16`
  `dist/promise/generated/{client,types}.d.ts` (`SessionContextInput` /
  `SessionContextOutput`) and `dist/chunks/*` (`context` path vs `message` list);
  isolated `serve` runtime test 2026-10-12 (`bubblewrap --unshare-net`, local mock
  provider).
- Justifies: `src/cache-engine-v2.mjs` `collectUsage` scanning the full
  `session.context` result (the adapter's `Array.isArray(res) ? res : res.data`
  handling matches the `{ data: [...] }` shape); it resolves the earlier
  pagination-undercount concern.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16.
- Re-verify when: OpenCode changes the `context` route, its message limit, the
  `/message` default, or the compaction boundary.
- Superseded by: null
- Notes: **Accepted accounting limitations** (complementary to `RF-OC-020`): the
  `context` route returns only "messages after the last compaction", so compaction
  is the sole truncation boundary — history removed/summarized before a scan is a
  best-effort **undercount**. The adapter's cursor/watermark are in-memory
  (restart re-counts), capacity/mark eviction undercounts (mark expiry can
  recount), `session.usage.updated` is volatile, and same-millisecond watermark
  ties undercount; exactly-once accounting is not claimed. `RF-OC-018` previously
  marked the `session.context` array ordering unverified; the adapter sorts by
  `time.created` regardless, so ordering is handled regardless of the route's
  default order.

### RF-OC-022 — OpenCode 2.0.26 V2 plugin-management CLI: `plugin add/remove/update` mutate the global configuration; `run` has no `--plugin` flag

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - `opencode plugin` subcommands are `list`, `add`, `check`, `update`, `remove`.
    `add` = "Install a plugin and add it to the global configuration"; `remove` =
    "Remove a plugin from global configuration"; `check`/`update` operate on
    installed package plugins. So `add`/`remove`/`update` **mutate the user's
    global configuration** and must not be used for an isolated test; `list` and
    `check` are read-only.
  - `opencode run` has **no `--plugin` flag**. Verified `run` flags:
    `--standalone`, `--server <url>`, `--continue/-c`, `--session/-s <id>`,
    `--model/-m`, `--agent`, `--format <choice>`, `--file/-f`, `--title`,
    `--thinking`, `--auto`.
  - Top-level flags: `--standalone`, `--server <url>`, `--auto`, `--continue/-c`,
    `--session/-s <id>`, `--prompt`; globals `--log-level <choice>`,
    `--print-logs`, `--help/-h`, `--version/-v`, `--wizard`,
    `--completions <shell>`.
  - `opencode serve` flags: `--hostname <str>`, `--port <int>`, `--cors <str>`,
    `--service`, `--stdio`.
  - Config/plugin env vars present: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
    `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_PROJECT_DISABLE`,
    `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CLIENT`.
  - Installed `@opencode/plugin` / `@opencode/client` = **2.0.16** (reconfirmed
    2026-10-12; `RF-OC-017`/`RF-OC-018` cited 2.0.25 earlier).
- Evidence: [O]
- Sources: local — `opencode --version`, `opencode --help`, `opencode plugin
  --help`, `opencode run --help`, `opencode serve --help` on the installed
  v2.0.26 binary; env-var names grepped from the binary; installed
  `@opencode/plugin`/`@opencode/client` `package.json` (2.0.16). Accessed
  2026-10-12.
- Justifies: `docs/implementation-plan-v2.md` §2D.0 (verified command surface)
  and §2D.2 (Gate 0 isolation); the prohibition on `plugin add/remove/update`
  during an isolated V2 loader test.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16.
- Re-verify when: the CLI help/subcommands change, plugin management moves out
  of the global configuration, or the `run`/`serve` flags change.
- Superseded by: null
- Notes: Partially supersedes the **operational** conclusion in `RF-OC-017`'s
  Notes ("a private `opencode serve` … loaded a local plugin probe … so a package
  cannot be load-tested without editing shared configuration"). Later isolated
  runs (2026-10-11/12; `RF-OC-019`–`RF-OC-021`) showed a private `opencode serve
  --hostname 127.0.0.1 --port <p>` inside a `bubblewrap` namespace with a private
  `HOME` **did** discover and load project-local `.opencode/plugins/*.ts` and run
  `setup`, and `OPENCODE_SERVER_PASSWORD` lets clients attach to that private
  server. `RF-OC-017`'s remaining true point stands: package discovery is not
  fully env-isolatable via `HOME`/`XDG_*` alone, and a competing `serve --service`
  could deregister the user's managed service — so isolated runs must avoid
  `--service` and the managed port. Gate 1 (2026-10-12) tested whether the loader
  resolves a package **subpath** (`<pkg>/v2`) from a project-local install: the
  direct `opencode-cache-engine/v2` config entry failed under the offline setup
  (see `RF-OC-023`). That result does **not** establish universal impossibility of
  direct subpath resolution; online-install behavior and alternative loader
  configurations remain untested.

### RF-OC-023 — OpenCode 2.0.26 treats a config `plugins` entry as an npm package spec: the direct subpath `opencode-cache-engine/v2` does not resolve via the package `exports` map (Gate 1 FAIL, offline)

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - With the package offline-installed into the disposable project's
    `node_modules` and registered directly in config as
    `plugins: ["opencode-cache-engine/v2"]` (project `.opencode/opencode.json`
    **and** the private global config; **no shim**), the OpenCode 2.0.26 loader
    **read** the entry but used its **npm-install path** instead of resolving the
    subpath from the project or the `exports` map. Server log (sanitized):
    `WARN "failed to load plugin" target=opencode-cache-engine/v2
    cause="NpmInstallFailedError (cause: Error: An unknown git error occurred)"`
    (twice) and `WARN "failed to check plugin update"
    target=opencode-cache-engine/v2 cause="NpmInstallFailedError
    (cause: Package is not installed: opencode-cache-engine/v2)"`.
  - No plugin identity and no adapter initialization side effect were observed
    (the isolated `CACHE_ENGINE_METRICS_FILE` directory was not created) — the
    plugin never loaded.
  - A client `GET /api/config` returned both config documents including
    `"plugins":["opencode-cache-engine/v2"]`; OpenCode's own `models.dev` fetch
    failed with `getaddrinfo ETIMEOUT` (expected under the isolated network
    namespace).
- Evidence: [O]
- Sources: isolated Gate 1 run 2026-10-12 — `bubblewrap --unshare-net`, private
  HOME/XDG, OpenCode 2.0.26 `serve`; tarball `opencode-cache-engine-0.7.1.tgz`
  from the checkpoint worktree; offline `npm install`; direct config entry; no
  shim; server-log lines; no adapter side effect.
- Justifies: `docs/implementation-plan-v2.md` §2D.3 (Gate 1 result) and the §2D.4
  (Gate 1b) fallback.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `bc01c6b`.
- Re-verify when: OpenCode changes plugin resolution to honor local
  package/subpath resolution, the `plugins` config-entry semantics change, or an
  online-install variant is tested.
- Superseded by: null
- Notes: **Observed:** the loader used its npm-install path for the config entry;
  `NpmInstallFailedError`; no identity/side effect. **Gate verdict:** FAIL under
  §2D.3 for the tested **offline** setup. **Qualification:** the offline install
  failure does **not** establish universal impossibility of direct subpath loading
  under every configuration (online-install behavior and alternate loader
  configurations remain untested); this is neither PASS nor PARTIAL, and no
  successful `exports`-map resolution is claimed. **Not executed:** Gate 1b and
  Gates 2–6. **Isolation/cleanup:** Gate 0 invariants re-verified (distinct
  network namespace; `/proc/net/dev` = `lo` only; no default route; host
  `127.0.0.1:49374` listening with the sandbox connection refused); disposable
  artifacts removed; no test process remained; host managed service unchanged;
  branch/HEAD/status and `package-lock.json` unchanged.

### RF-OC-024 — OpenCode 2.0.26 loads a project-local shim that re-exports `opencode-cache-engine/v2`, resolving the subpath via the project `node_modules` exports map (Gate 1b PASS, shim route only)

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - In an isolated OpenCode 2.0.26 runtime with the package offline-installed
    into the disposable project's `node_modules`, a **single** project-local
    plugin file `.opencode/plugins/v2-entry.ts` containing
    `export { default } from "opencode-cache-engine/v2"` was **discovered and
    loaded** by the loader — server log: `INFO msg="loading plugin"
    id=…/project/.opencode/plugins/v2-entry.ts
    entrypoint=file:///…/v2-entry.ts`. No direct `plugins` config entry and no
    other shim were present.
  - The adapter's initialization side effect was observed: the isolated
    `CACHE_ENGINE_METRICS_FILE` directory was created (adapter `setup` ran),
    demonstrating the subpath import resolved from the shim.
  - No shim-related load/import error occurred; the only server error was
    OpenCode's own `models.dev` fetch failing with `getaddrinfo ETIMEOUT`
    (expected under the isolated network namespace).
- Evidence: [O]
- Sources: isolated Gate 1b run 2026-10-12 — `bubblewrap --unshare-net`, private
  HOME/XDG, OpenCode 2.0.26 `serve`; tarball `opencode-cache-engine-0.7.1.tgz`
  from the checkpoint worktree; offline `npm install`; one local shim file;
  loader log line; adapter metrics-dir side effect.
- Justifies: `docs/implementation-plan-v2.md` §2D.4 (Gate 1b) result and its
  PARTIAL classification of the shim route.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `bc01c6b`.
- Re-verify when: OpenCode changes local plugin discovery/loading or module
  resolution, or the package `exports` map changes.
- Superseded by: null
- Notes: **Gate 1b verdict: PASS** for the narrow shim test only.
  **Qualification:** this is **partial evidence for V2 integration** and does
  **not** overturn Gate 1's direct-entry FAIL (`RF-OC-023`), nor show the loader
  accepts a subpath **config entry**. It does **not** establish hook invocation,
  provider-policy transformations, usage accounting, or preview readiness (none
  were exercised). **Isolation/cleanup:** Gate 0 invariants re-verified (distinct
  network namespace; `/proc/net/dev` = `lo` only; no default route; host
  `127.0.0.1:49374` listening with the sandbox connection refused); disposable
  artifacts removed; no test process remained; host managed service unchanged;
  branch/HEAD/status and `package-lock.json` unchanged. **Not executed:** Gates
  2–6.

### RF-OC-025 — Isolated Gate 2/Gate 3 run: the local shim loads, `setup(ctx)` runs, and `context`/`model.request` are actually dispatched (shim route; neutral family)

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - **Gate 2 (discovery + `setup(ctx)`) — PASS:** in an isolated OpenCode 2.0.26
    runtime (`opencode run --standalone`, `bubblewrap --unshare-net`, private
    HOME/XDG) with the package offline-installed and the single local plugin file
    `.opencode/plugins/v2-entry.ts` (no direct `plugins` config entry), the loader
    logged `loading plugin … v2-entry.ts`, `setup(ctx)` executed (adapter-ready
    log `[cache-engine-v2] opencode-cache-engine V2 adapter ready` with
    `CACHE_ENGINE_DEBUG=1`), and the isolated `CACHE_ENGINE_METRICS_FILE`
    directory/file were created.
  - **Gate 3 (hook installation + invocation) — PASS:** a counting wrapper that
    imports the resolved specifier reported registration
    `hooks=["context","model.request"]`, `subscribeCalls=1`; on one neutral turn
    (`mock/synthetic`) the server **actually dispatched** the hooks — `context`
    invoked once and `model.request` invoked twice — and the loopback mock
    received two `POST /v1/chat/completions` (primary + auxiliary); the turn
    completed with exit code 0.
  - No plugin/loader error; no transform is expected for a neutral family
    (provider-policy transform behavior is Gate 4, not tested).
- Evidence: [O]
- Sources: isolated Gate 2/Gate 3 run 2026-10-12 — `bubblewrap --unshare-net`,
  private HOME/XDG, OpenCode 2.0.26; tarball `opencode-cache-engine-0.7.1.tgz`
  from the checkpoint worktree; offline `npm install`; one local
  shim/counting-wrapper file; loader log; wrapper marker; mock request log.
- Justifies: `docs/implementation-plan-v2.md` §2D.5/§2D.6 results and the plan's
  Gate 2/Gate 3 verdicts on the shim route.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `bc01c6b`.
- Re-verify when: OpenCode changes plugin discovery/loading, the session hook
  names/dispatch, or the event subscription mechanism.
- Superseded by: null
- Notes: **Scope:** demonstrates **shim-based initialization** and
  **policy-independent hook dispatch** only. It does **not** establish direct
  package-entry (`plugins: ["opencode-cache-engine/v2"]`) support
  (Gate 1 = FAIL; `RF-OC-023`), provider-policy transformation (Gate 4),
  usage-accounting correctness (Gate 5), or production readiness. The metrics
  record's accounting content was not evaluated. **Isolation/cleanup:** Gate 0
  invariants re-verified (distinct network namespace; `/proc/net/dev` = `lo`
  only; no default route; host `127.0.0.1:49374` listening with the sandbox
  connection refused); disposable artifacts removed; no test process remained;
  host managed service unchanged; branch/HEAD/status and `package-lock.json`
  unchanged. **Not executed:** Gates 4–6.

### RF-OC-026 — Source-level trace of Gate 4: the OpenAI wire fields are `prompt_cache_key`/`prompt_cache_options`, and OpenCode 2.0.26 pre-sets `X-Session-Id`/`promptCacheKey`, confounding the Gate 4 observables

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - Adapter mutation path: `src/cache-engine-v2.mjs` `onContext` (GPT block)
    mutates the `context`-hook `event.options` (`SessionRequestOptions =
    DeepMutable<GenerationOptionsFields> & Record<string, unknown>`,
    `@opencode/plugin@2.0.16` `dist/promise/session.d.ts:21`) via the
    `gptCacheOptionFieldNames` / `gptCacheOptionsDelta` helpers in
    `src/cache-engine-core.mjs`.
  - Embedded OpenCode 2.0.26 request construction builds the model request with a
    session-derived `promptCacheKey` (`promptCacheKey: /^ses_[0-9a-f]{64}$/.test(fH)
    ? fH.slice(4) : fH`) and HTTP headers including `"x-session-affinity": fH` and
    `"X-Session-Id": fH` (plus `x-opencode-session-id`, `x-opencode-project`,
    `x-opencode-session`). The literal lowercase `x-session-id` does **not**
    appear in the binary; OpenCode emits `X-Session-Id`.
  - Wire serialization maps camel→snake: `prompt_cache_key: … i.promptCacheKey ??
    e.promptCacheKey` and `prompt_cache_options: … { mode, ttl }`. The on-wire GPT
    fields are therefore **`prompt_cache_key` / `prompt_cache_options`**, not
    camelCase.
  - Adapter `onModelRequest` checks a pre-existing session header
    **case-insensitively** (`name.toLowerCase() === "x-session-id"`), which
    matches OpenCode's `X-Session-Id`, so it **declines to attach** — matching the
    Gate 4 boundary telemetry (`headerPresent:true, headerAttached:false,
    headerSource:"preexisting"`).
- Evidence: [O]
- Sources: repository `src/cache-engine-v2.mjs` / `src/cache-engine-core.mjs`;
  installed `@opencode/plugin@2.0.16` `dist/promise/session.d.ts`; embedded
  OpenCode 2.0.26 binary strings (request-header build, `promptCacheKey` from the
  session, `prompt_cache_key`/`prompt_cache_options` serialization, model catalog
  `duo-chat-gpt-6-luna`). Read-only source inspection 2026-10-12; **no runtime
  executed**.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 Gate 4 criteria (corrected
  wire fields + adapter-off/on controls) and the Gate 4 INCONCLUSIVE verdict.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `bc01c6b`.
- Re-verify when: OpenCode changes request construction/serialization or the
  session headers it pre-sets, or the transport packages change.
- Superseded by: null
- Notes: **Consequence for Gate 4:** the first run's mock recorded camelCase body
  fields (`promptCacheKey`/`promptCacheOptions`), so their absence is a **harness
  detection mismatch**, not evidence of non-propagation; and because OpenCode
  pre-sets `promptCacheKey`/`X-Session-Id`, presence alone is **not attributable**
  to the adapter. **No adapter defect was confirmed;** Gate 4 remains
  **INCONCLUSIVE (limited/unverified)**. Proposed controls: adapter-off vs
  adapter-on, checking wire fields `prompt_cache_key`/`prompt_cache_options`
  (discriminator: `prompt_cache_options` only in the adapter-on run) and
  case-sensitive lowercase `x-session-id` separately from `X-Session-Id`; the
  `model.request` `kind` (per `RF-OC-018`) discriminates primary vs auxiliary,
  leaving the `gpt-6-luna` purpose **unconfirmed**. Limitations: the binary is the
  embedded, opaque/minified implementation, so the trace is observed behavior, not
  a formal spec.

### RF-OC-027 — Corrected Gate 4 control run: GPT wire fields and adapter-attributed session header remain unverified; the wire session header is lowercase in both controls

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - Corrected control run (fresh disposable project; `bubblewrap --unshare-net`,
    private HOME/XDG; offline tarball install; loopback mock; **OFF** = empty
    `.opencode/plugins/`, **ON** = the adapter via the tested project-local shim;
    identical providers/models/mock/sandbox). Presence-only evidence.
  - **GPT (`openai` / `gpt-5.6`):** the mock body had **neither
    `prompt_cache_key` nor `prompt_cache_options` in either the OFF or ON run**,
    while the ON adapter telemetry reported `cache-options`
    (`policy=gpt56, transport=promptCacheKey, keyInjected=true`). The required
    discriminator (`prompt_cache_options` only ON) was **not** met.
  - **OpenRouter (`openrouter` / `z-ai/glm-5.3`):** case-sensitive raw headers
    showed lowercase `x-session-id` present in **both** OFF and ON, and
    `X-Session-Id` absent in both; the ON adapter reported `headerPresent=true,
    headerAttached=false, headerSource="preexisting"`.
  - **Neutral (`mock` / `synthetic`):** no GPT cache fields; lowercase
    `x-session-id` present in both (OpenCode-supplied).
  - **Request kind (ON):** the marker recorded `model.request kind=title` and
    `kind=primary` per turn (3 each) — the `gpt-6-luna` requests are auxiliary
    **title** requests (established via `kind`, not model-name inference).
- Evidence: [O]
- Sources: isolated corrected Gate 4 run 2026-10-12 (`bubblewrap --unshare-net`;
  OpenCode 2.0.26; offline tarball; mock recording presence-only snake_case body
  fields and case-sensitive raw header names; ON adapter telemetry to
  `CACHE_ENGINE_METRICS_FILE`). No runtime in this documentation task.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 corrected Gate 4 outcomes;
  corrects `RF-OC-026`'s header interpretation.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `d5bd3ab`.
- Re-verify when: the provider route/serialization changes, OpenCode changes the
  session headers it pre-sets, or the transport packages change.
- Superseded by: null
- Notes: **Correction to `RF-OC-026`:** on the wire the session header is observed
  **lowercase** (`x-session-id`) in **both** controls — the HTTP client normalizes
  header-name case — so casing **cannot** establish whether OpenCode or the
  adapter supplied it. **No adapter defect was confirmed.** **Hypotheses
  (unconfirmed):** (1) the GPT fields do not serialize on the
  `@ai-sdk/openai-compatible` route and would require the `@ai-sdk/openai`/Azure
  SDK path; (2) OpenCode's pre-set session header engages the adapter's
  existing-header guard, making adapter-added affinity unobservable in this route.
  **Proposed follow-ups:** validate the GPT fields on the OpenAI/Azure SDK path;
  determine a safe way to demonstrate adapter-added OpenRouter affinity, or
  document the guard limitation instead of forcing a positive result. **Verdicts:**
  GPT INCONCLUSIVE, affinity INCONCLUSIVE, neutral passivity PASS (body scope),
  kind PASS, **overall Gate 4 NOT PASS**. Gate 5 / Gate 6 not run.

### RF-OC-028 — Finalized Gate 4 test design: the GPT cache fields require the `@ai-sdk/openai` (or Azure) SDK route; OpenRouter affinity splits into an integration check and an existing unit-level fallback

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - OpenCode 2.0.26 selects the provider SDK from the provider's `npm` (a mapping
    table routes `@ai-sdk/openai` to a bundled `@opencode/ai/providers/…`; the
    provider SDKs are bundled in the binary), and selects the API type via
    `Im(modelID) => catalog[modelID]?.openaiApiType ?? "chat"` (default `chat`).
    The OpenAI/Azure SDK serializes camel→snake cache options
    (`prompt_cache_key`, `prompt_cache_options`); the `@ai-sdk/openai-compatible`
    route does **not** emit them.
  - The adapter mutation stays at `src/cache-engine-v2.mjs` `onContext` (mutates
    `event.options`) via `gptCacheOptionFieldNames`/`gptCacheOptionsDelta` in
    `src/cache-engine-core.mjs`.
  - Adapter `onModelRequest` adds `x-session-id` for providerID `openrouter` +
    GLM/MiMo **only when no session header is already present** (case-insensitive
    check); OpenCode pre-sets a session header (lowercased on the wire by the HTTP
    client), so the guard prevents attachment on the integration route.
- Evidence: [O] (source tracing), [U] (runtime behavior of the corrected route)
- Sources: repository `src/cache-engine-v2.mjs` / `src/cache-engine-core.mjs`;
  embedded OpenCode 2.0.26 binary (`openaiApiType` selector, npm→SDK mapping,
  `prompt_cache_key`/`prompt_cache_options` serialization);
  `test/cache-engine.test.mjs` existing affinity unit test.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 finalized criteria; keeps
  Gate 4 **NOT PASS**.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `d5bd3ab`.
- Re-verify when: OpenCode changes SDK/API-type selection or the OpenAI/Azure
  serialization, or the session headers it pre-sets.
- Superseded by: null
- Notes: **Confirmed (source tracing):** the wire field names and the SDK/API-type
  selection mechanism; the affinity guard behavior. **Still to verify (runtime):**
  that the GPT fields serialize on the `@ai-sdk/openai` chat route, that V2
  `context` `options` reach the SDK provider options, and the integration
  preservation observation. **Test design:** GPT case uses a custom
  `npm: "@ai-sdk/openai"` provider (`providerID=openai`, model `gpt-5.6`, loopback
  mock `POST /v1/chat/completions`) with adapter-off/on; PASS requires
  `prompt_cache_options` present **only** ON. Affinity splits into (1) integration
  preservation/reach (mock; header presence is **not** attribution) and (2) the
  existing unit-level fallback test. Gate 4 stays **NOT PASS** until the revised
  positive criteria are satisfied. No runtime executed for this finding; no
  adapter defect confirmed.

### RF-OC-029 — Corrected Gate 4 run 3 (isolated): OpenCode selects the Responses API for `openai`/`gpt-5.6`, whose body carries `prompt_cache_key` but not `prompt_cache_options`; OpenRouter fallback unit test passes

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - Isolated run (fresh disposable; `bubblewrap --unshare-net`; private HOME/XDG;
    offline tarball; loopback mock; OFF = empty `.opencode/plugins/`, ON = adapter
    via the project-local shim; identical providers/models/mock/sandbox).
  - **GPT route selection:** with a custom provider `npm: "@ai-sdk/openai"`
    (`providerID=openai`, model `gpt-5.6`, loopback base URL), OpenCode sent
    **`POST /v1/responses`** (the **Responses API**), not `/v1/chat/completions`.
    The mock implemented chat-completions only, so the Responses turn did not
    parse (`Error: Invalid openai/openai-responses stream event`); the **sent
    request body was still captured**.
  - **GPT body (presence only):** `prompt_cache_key` present in **both** OFF and
    ON (OpenCode pre-set); `prompt_cache_options` present in **neither**. The
    adapter's ON telemetry still reported `cache-options` (`policy=gpt56,
    transport=promptCacheKey, keyInjected=true`). The required discriminator
    (`prompt_cache_options` only ON) was **not** met; `prompt_cache_options`
    appears in a chat-completions serialization (`prompt_cache_key:…,
    prompt_cache_retention:…, prompt_cache_options:{mode,ttl}`) and was not emitted
    on the Responses route.
  - **OpenRouter integration (presence only):** lowercase `x-session-id` present in
    **both** OFF and ON; ON telemetry `headerPresent=true, headerAttached=false,
    headerSource="preexisting"` — the pre-existing (OpenCode) header is preserved
    and delivered, and the adapter does not duplicate it.
  - **OpenRouter adapter fallback (unit-level):** the existing test in
    `test/cache-engine.test.mjs` — "v2 adapter: model.request adds x-session-id
    only for OpenRouter GLM/MiMo" — **passes** (1/1): the handler adds the
    lowercase `x-session-id` for an eligible OpenRouter GLM/MiMo request with no
    pre-existing header, and preserves a pre-existing header.
  - **Neutral passivity:** `mock/synthetic` body carried no cache fields in either
    control; the lowercase session header was present in both (OpenCode-supplied).
  - **`kind`:** the ON marker recorded `model.request kind=title` and
    `kind=primary`, confirming the auxiliary-title vs primary distinction.
- Evidence: [O]
- Sources: isolated corrected Gate 4 run 2026-10-12 (`bubblewrap --unshare-net`;
  OpenCode 2.0.26; offline tarball from checkpoint `d5bd3ab`; mock recording
  request **path** + presence-only snake_case body fields + case-sensitive raw
  header names; adapter telemetry to `CACHE_ENGINE_METRICS_FILE`);
  `test/cache-engine.test.mjs`.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 route correction and Gate 4
  outcomes; Gate 4 remains **NOT PASS**.
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `d5bd3ab`.
- Re-verify when: OpenCode changes model→API-type selection (chat vs responses),
  its OpenAI/Azure serialization, or the session headers it pre-sets; or when a
  chat-route GPT-5.6 path or a Responses-capable mock is used.
- Superseded by: null
- Notes: **Confirmed:** OpenCode selects the **Responses API** for
  `openai`/`gpt-5.6`; the Responses body carries `prompt_cache_key` (also pre-set
  by OpenCode) but **not** `prompt_cache_options`; the OpenRouter integration
  preserves OpenCode's header; the adapter fallback unit test passes. **Unresolved
  boundary:** whether V2 `context` options reach the OpenAI SDK provider options on
  the Responses route, and whether `prompt_cache_options` is a chat-only field —
  not isolable here because the Responses stream was not implemented (turn
  unparsed). **No adapter defect confirmed.** Open questions: can a GPT-5.6-policy
  model be forced onto the **chat** route; and does a Responses-capable mock show
  the adapter's options reaching the wire. Verdicts: GPT INCONCLUSIVE, OpenRouter
  integration PASS (preservation; not attribution), adapter fallback PASS
  (unit-level), neutral passivity PASS (body scope), kind PASS, **overall Gate 4
  NOT PASS**. Gate 5 / Gate 6 not run.

### RF-OC-030 — The OpenAI-compatible provider decodes provider options through schema `A = { user, reasoningEffort, textVerbosity, strictJsonSchema }`, stripping the GPT cache fields; the positive GPT criterion must use an OpenAI/Azure schema that accepts `promptCacheKey`

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - The `@opencode/ai/providers/openai-compatible` provider's `getArgs` decodes
    provider options via `KI({provider, providerOptions, schema:A})`, merging
    the `"openai-compatible"` (deprecated), `"openaiCompatible"`, and
    `this.providerOptionsName` namespaces — **each decoded through schema `A`**:
    `var A = Le({ user: ae().optional(), reasoningEffort: ae().optional(),
    textVerbosity: ae().optional(), strictJsonSchema: Ry().optional() })`.
  - `KI({provider:e, providerOptions:t, schema:r})` returns `undefined` when
    `t?.[e]` is absent; otherwise it decodes `t[e]` through `r` and returns the
    **decoded** value (or throws `invalid <e> provider options`). Schema `A`
    accepts only the four keys above — **no** `prompt_cache_key`,
    `prompt_cache_options`, `promptCacheKey`, or `promptCacheOptions`.
    Consequently any cache field (and any synthetic marker) placed under those
    namespaces on this route is not carried into the request body.
  - A **different** (OpenAI/Responses-style) provider-options schema **does**
    include `promptCacheKey` (camel, `ae().nullish()`); the OpenAI SDK serializes
    it to the wire `prompt_cache_key`. No located schema includes
    `promptCacheOptions`.
- Evidence: [O] (embedded 2.0.26 source: schema `A`; `KI`; the openai-compatible
  `getArgs` three-namespace merge) / [U] (`promptCacheOptions` support)
- Sources: embedded OpenCode 2.0.26 binary — openai-compatible provider `getArgs`,
  `function KI({provider,providerOptions,schema})`, and
  `var A=Le({user,reasoningEffort,textVerbosity,strictJsonSchema})`. Read-only
  inspection 2026-10-12; no runtime executed.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 corrected GPT criterion
  (OpenAI/Azure route; drop `promptCacheOptions`; wire-level adapter-off/on).
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `d5bd3ab`.
- Re-verify when: OpenCode changes the openai-compatible provider-options schema
  (`A`) or the `KI` decode, or adds a schema that accepts the cache options.
- Superseded by: null
- Notes: **Verified:** the openai-compatible route **cannot** carry the GPT cache
  fields (schema `A` strips them); OpenCode reads provider options only as
  schema-decoded namespace slices, not verbatim objects. **Consequence:** the
  plan's prior `prompt_cache_options` discriminator is **not** a supported
  positive criterion and is **removed**; the positive GPT criterion must be
  demonstrated on an OpenAI/Azure SDK route whose schema accepts `promptCacheKey`,
  distinguished at the **wire level** from OpenCode's pre-existing
  session-derived key (telemetry `keyInjected=true` is not wire-level proof).
  **Unresolved:** whether any provider-options schema accepts
  `promptCacheOptions`/`prompt_cache_options`; and the exact
  `config.provider`/`providerOptionsName` for a custom provider (moot for the
  openai-compatible route). **Gate 4 remains NOT PASS.** Gate 5 / Gate 6 not run.

### RF-OC-031 — Gate 4 closure: on the OpenAI/Azure route OpenCode pre-populates a session-derived `prompt_cache_key`, so the presence-only adapter-off/on comparison cannot attribute the field to the adapter

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - The OpenAI/Azure SDK provider-options schema accepts `promptCacheKey`
    (camel), which the SDK serializes to the wire field `prompt_cache_key`.
    Separately, `SessionModelRequest.prepare` sets a **session-derived
    `promptCacheKey` on the request** for every request
    (`promptCacheKey: /^ses_[0-9a-f]{64}$/.test(fH) ? fH.slice(4) : fH`).
  - Prior isolated evidence (adapter **off**, `openai`/`gpt-5.6`, Responses route)
    already showed `prompt_cache_key` present in the outbound body, so an
    adapter-off/on **presence-only** comparison cannot attribute the field to the
    adapter. `promptCacheOptions` was not established in any inspected
    provider-options schema.
  - The final Phase 1 attempt (identify a discriminating OpenAI/Azure route)
    **stopped before launching a new runtime**; no new test was run. Building a
    Responses-capable mock or re-running would reproduce the non-discriminating
    result.
- Evidence: [O] (source: request-build `promptCacheKey`; OpenAI schema accepting
  `promptCacheKey`; prior run's OFF body containing the field) / [U] (attribution
  of the wire value to the adapter).
- Sources: embedded OpenCode 2.0.26 binary (`SessionModelRequest.prepare`
  `promptCacheKey`; OpenAI provider-options schema; wire serialization
  `prompt_cache_key`); prior isolated run evidence; `RF-OC-030`. Read-only
  inspection/analysis 2026-10-12.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 result and §2D.13
  (Gate 4 closure / next phase).
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `d5bd3ab`.
- Re-verify when: a supported route is found where OpenCode does not pre-populate
  `promptCacheKey`, or a privacy-safe value-free attribution mechanism becomes
  available.
- Superseded by: null
- Notes: **Consequence:** the GPT positive criterion is **NOT PASS — attribution
  unresolved**; no adapter defect is claimed. **Close the investigation** (no
  further namespace or presence-only cache-key tests under the current
  acceptance criteria); reopen only with a genuinely discriminating, privacy-safe
  measurement. `promptCacheOptions` remains **[U]** and is not a required
  criterion. Preserve Gate 2/Gate 3 (loading/setup/hook-execution) evidence and
  the OpenRouter header findings as preservation/fallback evidence; keep the
  best-effort accounting limitations (no exactly-once claim). Gates 5/6 remain
  unrun and unauthorized.

### RF-OC-032 — OpenCode's `PluginHooks.trigger` returns the same payload object, so V2 `context`-hook mutations of `options` survive dispatch and become the request's generic `providerOptions`

- Status: current
- Verified: 2026-10-12
- Area: opencode-runtime
- Fact:
  - `@opencode/PluginHooks` registers hooks under `<scope>.<name>` and
    `trigger(scope, name, payload)` iterates the matching callbacks, invokes each
    `callback(payload)` with **the same object**, and **returns that same
    `payload`** — no copy, decode, reconstruct, or filter. In-place mutations
    (e.g., of `options`) are therefore preserved.
  - `SessionModelRequest.prepare` calls the producer
    `l = (payload,tools) => H.trigger("session","context", {...payload, agent, tools})`
    and receives `w`; it then splits `oH = Object.entries(w.options)` into `K`
    (generation settings, keys in `_s`) and `$H` (all other keys = provider
    options), and builds the request with `providerOptions: $H`.
  - Therefore a V2 `context`-hook addition to `options` becomes the request's
    generic (flat) `providerOptions`; it is then subject to **provider-side**
    schema decoding (`KI`, `RF-OC-030`), which is where cache fields are dropped
    on the openai-compatible route.
- Evidence: [O]
- Sources: embedded OpenCode 2.0.26 binary (`@opencode/PluginHooks`
  `register`/`trigger`; `SessionModelRequest.prepare` `options` split). Read-only
  inspection 2026-10-12; no runtime executed.
- Justifies: `docs/implementation-plan-v2.md` §2D.7 (forwarding boundary) and
  §2D.13.
- Version context: OpenCode 2.0.26; adapter checkpoint `d5bd3ab`.
- Re-verify when: OpenCode changes the plugin hook registry/dispatch or the
  request-options split.
- Superseded by: null
- Notes: Confirms the loss on the openai-compatible route is **provider-side
  schema processing** (`RF-OC-030`), not hook dispatch. Complements `RF-OC-031`
  (OpenAI-route pre-population of `promptCacheKey`).

### RF-OC-033 — GLM/MiMo `<env>` relocation is a no-op on the captured OpenCode 2.0.26 system-prompt shape (marker precondition unmet); cache benefit unverified

- Status: current
- Verified: 2026-10-13
- Area: opencode-runtime
- Fact:
  - `relocateVolatileEnvBlock` (`src/cache-engine-core.mjs` L379–405) requires
    exactly one `"You are powered by the model named "` START marker, exactly one
    `<env>` and one `</env>` in order, and non-empty remaining content; otherwise
    it returns `changed:false` unchanged. The START marker originates from the
    OpenCode **1.18.34 / V1** system-prompt shape (helper rationale L355–367; the
    tests' `GLM_SYSTEM` at `test/cache-engine.test.mjs` L688 and MiMo at L1136 use
    that marker-bearing shape).
  - In an isolated offline wire-level run (adapter-off vs adapter-on, loopback
    mock, `bwrap --unshare-net`) for `opencode-go/glm-5.3-flash` and
    `opencode-go/mimo-v2.6-flash`, the captured **OpenCode 2.0.26** outgoing
    system prompt contained a `<env>` block (working directory / workspace root /
    git-repo flag / platform / temp-dir preference) but **zero** occurrences of
    the START marker and **no date line**. Adapter-disabled and adapter-enabled
    system content were **byte-identical** for both models, and the top-level
    request body keys were identical.
  - `glm53.stabilizeSystem` / `mimo26.stabilizeSystem` default `true`
    (`src/cache-engine-core.mjs` L87–94), so the policy was **enabled**; the
    helper's precondition was the sole reason no relocation occurred.
- Evidence: [O]
- Sources: repository `src/cache-engine-core.mjs` (`relocateVolatileEnvBlock`,
  rationale) and `src/cache-engine-v2.mjs` (`context` call site L217–227);
  `test/cache-engine.test.mjs` (V1 marker-bearing fixtures L688/L1136, edge cases
  L1195–1216); isolated offline wire capture 2026-10-13 (OpenCode 2.0.26, mock,
  netns). No provider requests; no live runtime.
- Justifies: `docs/implementation-plan-v2.md` §2C (V2 preview compatibility note)
  and `docs/cache-policy-inventory.md` (GLM/MiMo relocation note).
- Version context: OpenCode 2.0.26; `@opencode/plugin`/`@opencode/client` 2.0.16;
  adapter checkpoint `2a00607`.
- Re-verify when: OpenCode changes its system-prompt shape (adds/removes the
  model-name preamble or the `<env>` block), or the relocation helper changes.
- Superseded by: RF-OC-035
- Notes: **Layers (keep distinct):** (1) policy **enabled** — yes for GLM/MiMo;
  (2) helper **accepts the prompt shape** — **no** on the captured 2.0.26 shape
  (marker absent); (3) mutation **reaching the outgoing request** — no (OFF==ON);
  (4) **provider cache benefit** — **unverified** (no provider requests made).
  This is a **compatibility finding for the captured runtime/prompt shape**, not
  proof that every OpenCode 2.x configuration has the same shape (other
  agents/configs are untested). **Safety rationale preserved:** the START marker
  scopes relocation to OpenCode's own env preamble and prevents reordering
  arbitrary user/agent `<env>` content; removing it or adding a broad
  `<env>`-only trigger is **not currently justified**, especially because the
  2.0.26 `<env>` block carried **no date line** (its volatility — the original
  motivation — is unestablished). Cache-read improvement and savings remain
  **unverified**.

### RF-OC-034 — The `<env>` relocation is content- and line-multiset-preserving but not always byte-for-byte (one separator newline may be inserted); the V2 hook relocates only the single eligible system part

- Status: current
- Verified: 2026-10-13
- Area: opencode-runtime
- Fact:
  - `relocateVolatileEnvBlock` / `relocateRange` preserve the moved block's bytes
    and the **non-empty line multiset**, and are deterministic and idempotent.
    They are **not** always a byte-for-byte permutation: when the surviving text
    does not already end in a newline, exactly **one separator `\n`** is inserted
    before the moved block, so the output may be one byte longer than the input.
  - The V2 `context` hook relocates within the **single eligible** system text
    part only; null/non-text and other parts are left byte-for-byte unchanged.
- Evidence: [O] (code + regression test)
- Sources: `src/cache-engine-core.mjs` (`relocateVolatileEnvBlock`,
  `relocateRange`); `src/cache-engine-v2.mjs` (`onContext`); `test/cache-engine.test.mjs`
  (`core: relocateVolatileEnvBlock inserts exactly one separator newline …`).
- Justifies: the corrected relocation comments; the C1 regression test; the plan's
  shared-transform description (`docs/implementation-plan-v2.md`).
- Version context: OpenCode 2.0.26; adapter checkpoint `af154f0`.
- Re-verify when: the relocation helper's newline/separator handling changes.
- Superseded by: null
- Notes: Cosmetic — a single normalized separator; the block content and the
  non-empty line multiset are unchanged, and the reorder is deterministic and
  idempotent. Not a cache-affecting change and does not affect provider cache
  benefit (still unverified).

### RF-OC-035 — OpenCode 2.0.26 delivers the system prompt as four text parts; the daily date is a standalone line in part 2 and the `<env>` relocation is a within-part wire no-op (supersedes the stale reason in RF-OC-033)

- Status: current
- Verified: 2026-10-14
- Area: opencode-runtime
- Fact:
  - The V2 `context` hook payload's `system` field is an array of text parts
    `{ type: "text", text }`. On an offline-captured OpenCode 2.0.26 primary
    request it has **four** parts: `[0]` agent/harness prompt (1471 B);
    `[1]` `# Your Model` (Name / Provider ID / Model ID; 80 B); `[2]` skills/mode +
    date + intro + `<env>` block (5748 B, **ends with `</env>`**); `[3]` worktree
    paragraph (238 B).
  - The daily date is a **standalone line** `Today's date: <EEE MMM D YYYY>`
    **outside** and immediately **before** the `<env>` block, inside **part 2**.
    There is no `You are powered by the model named ` START marker.
  - The `<env>` block is **already terminal in part 2**, so
    `relocateVolatileEnvBlock(part2)` returns `changed:false`; the GLM-5.3 /
    MiMo-V2.6 `<env>` relocation therefore does **not** reach the wire (the neutral,
    GLM-5.3, and MiMo-V2.6 system texts are byte-identical apart from the
    `# Your Model` name/id lines).
  - Telemetry confirms the policy resolves (`policy: "glm53"` / `"mimo26"`,
    `provider: "mock"`), so the no-op is the **part boundary**, not classification
    and not the helper precondition: the helper accepts the structural 2.0.26 shape
    and returns `changed:true` when the block is interior to a part.
  - Consequence: a content-preserving **date-line** relocation within part 2 is
    implementable and would change part 2 (bounded by the part boundary; the date
    cannot move past part 3).
- Evidence: [O] (offline wire capture 2026-10-14, OpenCode 2.0.26, mock, netns;
  temporary read-only instrumentation of `event.system` part shapes, reverted)
- Sources: offline captures for `mock/synthetic` / `mock/glm-5.3-flash` /
  `mock/mimo-v2.6-flash` via `test/harness/capture`; `src/cache-engine-v2.mjs`
  (`onContext`); `src/cache-engine-core.mjs` (`relocateVolatileEnvBlock`);
  `docs/phase2-date-relocation-hook-shape.md`.
- Justifies: the Phase 2 date-relocation design and P2-T1's go/no-go.
- Version context: OpenCode 2.0.26; `@opencode/plugin` 2.0.16; adapter at v1.1.0.
- Re-verify when: OpenCode changes the number or boundaries of the `event.system`
  parts, or the helper's part handling changes.
- Superseded by: null
- Notes: Supersedes **RF-OC-033**'s *reason* (RF-OC-033 concluded "no-op" correctly
  but attributed it to the absent START marker; the current helper accepts the
  structural shape — the wire no-op is the part boundary). Provider cache benefit
  remains **unverified** (no provider requests). 1.18.x wire shape not captured
  (that binary is not installed).

### RF-OC-036 — A V2 `context`-hook mutation of a `system` text part reaches the serialized Chat Completions request (offline wire-verified for the P2-T3 date-line relocation)

- Status: current
- Verified: 2026-10-14
- Area: opencode-runtime
- Fact:
  - With the project-local shim loading the V2 adapter (`RF-OC-024`) and the
    experimental `stabilizeDate` policy enabled, the offline-captured
    **serialized** system content (`messages[0].content`) for both
    `mock/glm-5.3-flash` and `mock/mimo-v2.6-flash` had the single daily date line
    moved from **before** the `<env>` block to **after** it (still before the
    trailing worktree part). A neutral model (`mock/synthetic`) was byte-unchanged.
  - On the wire, exactly one date line remained, its value was unchanged, and —
    order-sensitively — the text with only the date line's bytes removed was
    identical apart from at most one separator newline; the byte length grew by
    **+1** (that separator). A **relocate-only** effect within the eligible
    `event.system` text part.
  - This positively establishes, for the tested shim route, that **this
    relocate-only** `context`-hook `system`-part mutation survives to the
    serialized request — the mapping RF-OC-032 verified only for `options` and
    that RF-OC-035 flagged as unproven for `system`. (It does not establish that
    every `system` mutation round-trips.)
- Evidence: [O] (offline wire capture 2026-10-14, OpenCode 2.0.26, loopback mock,
  `bwrap --unshare-net`; no provider requests)
- Sources: `test/harness/capture/run.sh` + `verify-date-relocation.mjs` +
  `date-relocation.test.sh`; `src/cache-engine-v2.mjs` (`onContext`);
  `docs/phase2-date-relocation-hook-shape.md` (P2-T3 section).
- Justifies: P2-T3 gate G3 (wire) and the Phase 2 report.
- Version context: OpenCode 2.0.26; `@opencode/plugin` 2.0.16; adapter at v1.1.1.
- Re-verify when: OpenCode changes how `event.system` parts are serialized, or the
  adapter's transform/part handling changes.
- Superseded by: null
- Notes: Wire-verified **structurally** for the relocate-only effect; **provider**
  cache benefit remains unmeasured (P2-T4). Transform-off and neutral are
  unchanged.

### RF-OC-037 — OpenCode 2.0.26 loads a project `.opencode/plugins/*` shim only under `run --standalone`, and overrides a provider endpoint via `provider.<id>.options.baseURL`

- Status: current
- Verified: 2026-10-14
- Area: opencode-runtime
- Fact:
  - A project `.opencode/plugins/<name>.ts` that re-exports a package adapter
    (`export { default } from ".../cache-engine-v2.mjs"`) is loaded by
    `opencode run` **only with `--standalone`**: without it the adapter's `setup`
    never runs (no metrics file, no mutation); with it, `setup` runs and the
    `context`-hook mutation reaches the serialized request.
  - A provider's endpoint can be overridden in the project config at
    `provider.<id>.options.baseURL` (schema path; **singular** `provider`); the
    plural `providers` form did not apply the override.
  - The V2 adapter's `session.usage.updated`-driven `usage` telemetry does not fire
    in a headless `opencode run`, so provider cache usage must be read from the
    session DB (`session_message.data.tokens.cache.{read,write}`).
- Evidence: [O] (offline/local runs 2026-10-14; OpenCode 2.0.26; real OpenRouter
  traffic for the routing probe)
- Sources: `test/harness/capture/run.sh` (shim pattern); `~/.config/opencode/opencode.jsonc`
  (pinned providers); OpenCode config schema `provider.<id>.options.baseURL`;
  `~/.local/share/opencode/opencode.db`.
- Justifies: the P2-T4 measurement machinery (`docs/phase2-p2t4-provider-ab-report.md`).
- Version context: OpenCode 2.0.26; `@opencode/plugin` 2.0.16.
- Re-verify when: OpenCode changes plugin discovery, the provider-options schema, or
  the headless usage-events behavior.
- Superseded by: null
- Notes: `--standalone` gating was observed for a project-local shim; the config
  `plugins` entry path (`RF-OC-023`/`RF-OC-024`) is separate.

### RF-OC-038 — Provider A/B (OpenRouter, pinned route): the date line at the tail reuses a longer cached prefix (ON >= OFF in 6/6 nonce-isolated trials); GLM caches on Z.AI; an unpinned route invalidated an earlier pass

- Status: current
- Verified: 2026-10-14
- Area: provider-api
- Fact:
  - On the **pinned** OpenRouter route (GLM `z-ai/fp8` -> Z.AI; MiMo `xiaomi/fp8`
    -> Xiaomi), a **nonce-isolated** A/B (a unique stable prefix per trial, so prior
    runs' caches cannot carry over) with a **simulated** date rollover (a local proxy
    rewrites `Today's date: Wed 14 Oct 2026` -> `Thu 15 Oct 2026`) reported candidate
    (`stabilizeDate`, date at the tail) `cache.read` **>=** baseline (date before
    `<env>`) in **6/6** trials:
    - GLM OFF->ON tokens: `8128->10240` (+2112), `10240->10304` (+64), `10240->10304` (+64)
    - MiMo OFF->ON tokens: `4096->10240` (+6144), `8192->10240` (+2048), `10240->10240` (0)
    No sign flip; deltas 0..+6144; values cluster near ~10240, suggesting a provider
    cached-prefix **cap** can saturate the difference.
  - GLM **does** report caching on Z.AI (an identical ~23.7K repeat reported
    `cached_tokens: 23616` of `23673`). An earlier "no caching" observation applied to
    a *different* pinned upstream set (streamlake/novita fp8) / an unpinned route.
  - An earlier pass pointed `XDG_CONFIG_HOME` at a temp config without the pins, so
    requests carried `provider: null` and OpenRouter load-balanced (GLM served by
    "Near AI"); those numbers are invalid for the pinned-route question.
- Evidence: [O] with a provider-measured component (real OpenRouter requests;
  authorized; small spend; credentials used by OpenCode, never read or logged)
- Sources: local P2-T4 experiment (`/tmp/opencode/t4*`); `docs/phase2-p2t4-provider-ab-report.md`.
- Justifies: the P2-T4 verdict and the P2-T5 decision (keep experimental).
- Version context: OpenRouter, `z-ai/glm-5.3-flash` and `xiaomi/mimo-v2.6-flash`;
  OpenCode 2.0.26.
- Re-verify when: the pinned upstreams change, a real-calendar rollover is measured,
  or a larger volatile region is proposed.
- Superseded by: null
- Notes: **Simulated** rollover (proxy date rewrite), not a real calendar rollover;
  n=3 per condition; OpenRouter routing/TTL are confounders. This is a
  **route-specific** result, not a universal statement about GLM/MiMo caching.

### RF-OC-039 — OpenCode V2 supports the top-level `small_model` config key (title/summary model); it maps to the `title` agent

- Status: current
- Verified: 2026-10-14
- Area: opencode-runtime
- Fact:
  - The OpenCode config schema (`https://opencode.ai/config.json`) has a top-level
    `small_model` (string): "Small model to use for tasks like title generation in the
    format of provider/model".
  - The V2 runtime reads `small_model`, parses it as `provider/model`, and assigns it
    to the `title` agent's model. A value that is **not** `provider/model` is omitted
    with the diagnostic "omitted unsupported legacy model reference" (so a bare value
    like `free` or a `#variant` form can silently fail).
  - Observed: setting the top-level `"small_model": "<provider>/<model>"` changed the
    auxiliary (title) request's model on the wire — from the default
    `openai/gpt-6-luna` to the configured model (with that model's provider pin
    applied). So `small_model` **is** effective in V2.
- Evidence: [O] (OpenCode 2.0.26 config schema; runtime normalization in the binary;
  local request capture with a project `small_model`)
- Sources: `https://opencode.ai/config.json` (`small_model`); OpenCode 2.0.26 binary;
  local capture (P2-T4 proxy).
- Justifies: configuring the OpenCode title/summary (small) model; complements
  RF-OR-006 (aux requests use a different model when it is not pinned/configured).
- Version context: OpenCode 2.0.26.
- Re-verify when: OpenCode changes the config key or the aux-model selection.
- Superseded by: null
- Notes: The user's global config sets no `small_model`, so the aux/title model was
  OpenCode's default (`openai/gpt-6-luna`) — a likely "different provider" source in
  OpenRouter logs. The value must be `provider/model` (e.g.
  `"small_model": "openrouter/<model>"`).

## RF-OR — OpenRouter transport and routing

### RF-OR-001 — OpenRouter's upstream provider selection is not exposed to plugins

- Status: current
- Verified: 2026-09-26
- Area: openrouter-transport
- Fact: Which upstream OpenRouter picks is not observable from a plugin, so
  CacheEngine must never claim or override routing.
- Evidence: [O]
- Sources: local — recorded in `docs/cache-policy-inventory.md` §9; consistent
  with RF-OC-003.
- Justifies: the "never override routing" invariant.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenRouter exposes routing information to plugins.
- Superseded by: null

### RF-OR-002 — `@openrouter/ai-sdk-provider` converts `cacheControl` to wire `cache_control`

- Status: current
- Verified: 2026-10-04
- Area: openrouter-transport
- Fact: OpenRouter serves Anthropic models over an OpenAI-shaped
  `/api/v1/chat/completions` endpoint, but supports Anthropic prompt caching via
  top-level or per-block `cache_control` (translated to a Bedrock breakpoint on
  Bedrock; <=4 breakpoints; 1h TTL supported). The AI SDK provider converts
  `providerOptions.openrouter.cacheControl` to the wire `cache_control` field
  (its README: "will automatically convert these messages to the correct format
  internally"), so OpenCode's `applyCaching` markers survive on the OpenRouter
  route. Usage: `prompt_tokens_details.cached_tokens` / `cache_write_tokens`.
  Sticky routing is best-effort (10-min inactivity; `provider.order` disables).
- Evidence: [D]
- Sources: https://openrouter.ai/docs/guides/best-practices/prompt-caching ;
  `@openrouter/ai-sdk-provider` README. Accessed 2026-10-04.
- Justifies: resolving the prior inventory "OpenRouter serialization UNVERIFIED"
  item; CacheEngine still stays passive (it does not add the marker).
- Version context: OpenRouter docs and provider README as of 2026-10-04.
- Re-verify when: the AI SDK provider or OpenRouter changes cache-field handling.
- Superseded by: null
- Notes: CacheEngine adds no `x-session-id` for Claude (`openRouterAffinity` is
  false for the Claude family).

### RF-OR-003 — OpenRouter's Gemini cache contract self-contradicts (implicit vs explicit cache_control); distinct from response caching

- Status: current
- Verified: 2026-10-05
- Area: openrouter-routing
- Fact: OpenRouter's Prompt Caching page gives two contradictory statements for
  Gemini. (a) "Gemini 2.5 series models and newer support implicit caching ...
  no manual setup or additional `cache_control` breakpoints required." (b) Under
  "How to Enable Gemini Prompt Caching": "Gemini caching in OpenRouter requires
  you to insert `cache_control` breakpoints explicitly within message content,
  similar to Anthropic." The documented shape is an Anthropic-style **block**
  marker `{ "type":"text", "text":"...", "cache_control": { "type":"ephemeral" } }`
  on a text content block inside a `system`/`developer` message's `content`
  array or a later `user` message's `content` array. No top-level `cache_control`
  is documented for Gemini, and no tool-block breakpoint is documented. Only the
  **last** breakpoint is used ("OpenRouter will use only the last breakpoint for
  Gemini caching across normal message content"). OpenRouter abstracts the cache
  lifecycle ("You do not need to manually create, update, or delete caches") and
  does **not** say whether it uses Google implicit caching, native
  `CachedContent`, or a provider abstraction. Minimums: 4,096 (Gemini 2.5 Pro),
  1,024 (Gemini 2.5 Flash); the page also says "typically a 4,096 token
  minimum". TTL: implicit ~3–5 min; cache writes 5 min and do not refresh. Reads
  billed 0.25× input. Sticky routing is best-effort (10-min inactivity;
  `provider.order` disables it; key = body `session_id` > `x-session-id` header,
  ≤256 chars, else a hash of the first system/developer + first non-system
  message). The prompt cache lives upstream, so provider failover can lose the
  warm cache. The endpoints API reports `supports_implicit_caching: false` for
  every `google/gemini-2.5-*` endpoint while still listing `input_cache_read`
  pricing, and `google/gemini-3-pro-preview` currently exposes no endpoints —
  this **contradiction remains unresolved** after a live probe of one endpoint
  (RF-OR-004).
  The Gemini prompt-cache **scope** is not documented ([U]); only the
  response-cache scope (API key) is documented. Reads refresh TTL: [U].
- Distinct mechanism (do not conflate): OpenRouter **response caching** uses the
  `X-OpenRouter-Cache: true` header or preset `cache_enabled`/`cache_ttl_seconds`,
  "operates at the OpenRouter layer before the request reaches any provider",
  keyed by API key + model + endpoint type + streaming + SHA-256(request body),
  default TTL 300 s, hits bill zero. It is NOT provider prompt caching; Gemini's
  caching is the provider prompt cache.
- Evidence: [D]
- Sources: https://openrouter.ai/docs/features/prompt-caching ,
  https://openrouter.ai/docs/features/response-caching ,
  https://openrouter.ai/docs/guides/routing/provider-selection ,
  https://openrouter.ai/api/v1/models/google/gemini-2.5-pro/endpoints and
  .../google/gemini-2.5-flash/endpoints and
  .../google/gemini-3-pro-preview/endpoints. Accessed 2026-10-05.
- Justifies: keeping Gemini passive on OpenRouter — CacheEngine injects neither
  the documented `cache_control` breakpoint nor a `session_id`. The V1
  `chat.params` hook exposes only top-level provider options (RF-OC-010), so a
  block-level `cache_control` cannot be placed with guaranteed serialization.
- Version context: OpenRouter docs as of 2026-10-05.
- Re-verify when: OpenRouter resolves the implicit-vs-explicit Gemini text,
  changes the Gemini cache field, or flips `supports_implicit_caching`.
- Superseded by: null
- Notes: Do not implement a Gemini OpenRouter overlay until the exact block-level
  serialization through the installed transport is verified end to end. A live
  probe of one endpoint was recorded in RF-OR-004 (2026-10-05) with inconclusive
  results; the documentation contradiction above is preserved.

### RF-OR-004 — Live OpenRouter × Gemini probe (`google/gemini-2.5-flash-lite:flex`): unmarked repeats produced no cache reads; block `cache_control` was inconsistent; session-from-start never cached

- Status: current
- Verified: 2026-10-05
- Area: openrouter-routing
- Scope: OpenRouter `google/gemini-2.5-flash-lite:flex` only (direct
  `/api/v1/chat/completions`, not through OpenCode).
- Question: does repeated use of the same large prefix produce prompt-cache reads
  (a) without `cache_control`, (b) with the documented block-level
  `cache_control`, and (c) with a stable `session_id`?
- Experimental design: a locally-generated, deterministic ~10.6k-token stable
  prefix (unique per case, byte-identical within a case) followed by a small
  differing suffix (WARM/ALPHA/BETA/GAMMA). Marker placed **inside** the `system`
  content block as `{ "type":"text", "text":"<prefix>", "cache_control": {
  "type":"ephemeral" } }` — never top-level. No `X-OpenRouter-Cache` /
  `cache_enabled`. Cases ran sequentially with a warm-up + 3 requests each, plus
  isolation and reprobe runs; ~37 requests total, all HTTP 200.
- Cases tested: A no marker / no session; B no marker / stable body `session_id`;
  C block marker / no session; D block marker / stable body `session_id`; E
  isolation (marker, no-session first then session on the same prefix); F reprobe
  (flex vs base model, marker vs no marker, marker + session).
- Wire representation: the marker was on a message content block (harness-
  constructed body), verified in the sanitized request shape; not a top-level
  field and not only `providerOptions`.
- Observed usage: `usage.prompt_tokens_details.cached_tokens` and
  `cache_write_tokens` are **present** (value `0` when there is no cache). No
  `x-openrouter-provider` / `x-openrouter-model` / `x-openrouter-cache` response
  headers are exposed.
- Provider routing observations: the response body `provider` field always read
  `"Google"`; the finer upstream endpoint (Google vs Google AI Studio) is **not
  observable**. Cache behavior varied between otherwise-identical runs with no
  exposed routing change → endpoint selection is opaque.
- Response-cache distinction: suffixes differed per request, so no two whole
  requests were identical, and `X-OpenRouter-Cache` was not set. Hits were
  prompt-cache reads (`cached_tokens`), not the OpenRouter response cache.
- Session-ID observations: (i) no marker → 0 cached tokens with or without a
  session (8/8). (ii) block marker + `session_id` from the **first** request → 0
  cached tokens in every run (Case D 4/4; reprobe body `session_id` 3/3; reprobe
  `x-session-id` header 2/2; reprobe marker+session 2/2 → 11/11). (iii) block
  marker **without** a session → variable: Case C wrote and read (4/4);
  isolation probe wrote and read (5/5); reprobe G1 wrote on the 2nd request;
  probe3 no-session marker missed (2/2). (iv) a session added **after** the cache
  exists did not prevent reads (isolation steps 3/4/6 all read 10,575). So
  `session_id` did not stabilize reuse; starting a session coincided with no
  caching, but the mechanism is not observable.
- Result: **Outcome D — inconclusive** for the marker question, with one
  consistent negative signal for unmarked requests.
- Conclusion: for the tested `:flex` route, unmarked repeated prefixes produced
  no cache reads in any observation; the documented block-level `cache_control`
  was not reliably honored (mixed across runs); a stable `session_id` from the
  first request coincided with no caching. Provider endpoint routing is opaque.
- Implications for CacheEngine: **remain passive.** The effect is provider- and
  endpoint-dependent, and the V1 `chat.params` hook cannot place the documented
  block-level `cache_control` anyway (RF-OC-010, RF-SDK-001). Do not add a Gemini
  overlay or Gemini `session_id`/`x-session-id` affinity.
- Evidence: [O]
- Sources: live OpenRouter calls to
  `https://openrouter.ai/api/v1/chat/completions` with model
  `google/gemini-2.5-flash-lite:flex` and a redacted environment/OpenCode-auth
  credential, 2026-10-05; OpenRouter prompt-caching documentation (RF-OR-003).
- Justifies: keeping Gemini passive on OpenRouter; no `cache_control` overlay and
  no Gemini affinity.
- Version context: OpenCode 1.18.34; OpenRouter live API 2026-10-05; probed
  directly over HTTP (no OpenCode serialization path involved).
- Unknowns: which upstream endpoint served each request; why a session from the
  start coincided with no cache writes (mechanism unresolved); whether behavior
  generalizes to other Gemini models/routes or the non-flex endpoint; whether
  the mixed block-marker results are time/route-dependent.
- Re-verify when: OpenRouter resolves the Gemini cache contract, flips
  `supports_implicit_caching`, or a non-flex / other-model Gemini route is probed.
- Superseded by: null
- Notes: Distinguish live-observed behavior from documentation; the RF-OR-003
  contradiction is preserved. Scoped to one endpoint only — do not generalize.

### RF-OR-005 — OpenRouter documents Qwen/Alibaba caching as explicit-only block `cache_control`, contradicted by per-endpoint metadata

- Status: current
- Verified: 2026-10-05
- Area: openrouter-transport
- Fact: OpenRouter's prompt-caching page documents Alibaba/Qwen caching as
  **explicit-only**: add `cache_control:{type:"ephemeral"}` **inside a text content
  block** (Anthropic-style), with a **5-minute** write TTL; the marker is
  block-level, not top-level. Explicitly cacheable slugs listed: `qwen/qwen3-max`,
  `qwen/qwen-plus`, `qwen/qwen3.6-plus`, `qwen/qwen3-coder-plus`,
  `qwen/qwen3-coder-flash` (plus `deepseek/deepseek-v3.2`); snapshots
  `qwen/qwen3.5-plus-02-15` and `qwen/qwen3.5-flash-02-23` are excluded. Usage is
  reported as `usage.prompt_tokens_details.cached_tokens` (read) and
  `.cache_write_tokens` (write) — separate fields. This contradicts the per-endpoint
  API metadata: `supports_implicit_caching` is `true` for `qwen/qwen3-coder-plus`
  and `qwen/qwen3-max` but `false` for `qwen/qwen-plus`, `qwen/qwen3-coder-flash`,
  and `qwen/qwen3.6-plus` (which also lists `input_cache_write` with no
  `input_cache_read`). Generic sticky routing applies to both implicit and explicit
  caching (body `session_id` > `x-session-id`, ≤256 chars; `provider.order`
  disables it; 10-minute inactivity expiry), but OpenRouter gives **no** Qwen-specific
  `session_id` recommendation.
- Evidence: [D] (docs/API) / [U] (the unknowns below)
- Sources: OpenRouter Prompt Caching
  https://openrouter.ai/docs/features/prompt-caching (Alibaba section: block
  marker, 5m TTL, slugs; sticky routing); usage accounting
  https://openrouter.ai/docs/cookbook/administration/usage-accounting ; per-model
  endpoints https://openrouter.ai/api/v1/models/qwen/<id>/endpoints
  (`supports_implicit_caching` contradiction); catalog
  https://openrouter.ai/api/v1/models . Accessed 2026-10-05.
- Justifies: `src/cache-policy-core.mjs` `alibaba.qwen` staying passive on the
  OpenRouter route — the V1 `chat.params` hook exposes only top-level
  `providerOptions`, which cannot place the documented block-level marker
  (RF-SDK-001/RF-OR-002) — and no Qwen affinity.
- Version context: OpenRouter live docs/API as of 2026-10-05; OpenCode 1.18.34.
- Unknowns: minimum cacheable prefix; maximum breakpoints; eligible roles/content
  types; whether OpenRouter translates the marker to Alibaba-native caching; and
  which `supports_implicit_caching` value (docs vs endpoint metadata) is
  authoritative.
- Re-verify when: OpenRouter resolves or changes the Qwen cache contract, flips
  `supports_implicit_caching` for the Qwen slugs, or adds a Qwen `session_id`
  recommendation; or a live Qwen probe establishes the actual behavior.
- Superseded by: null
- Notes: Complements RF-PRV-006 (provider-side semantics) and mirrors RF-OR-003
  (the same implicit-vs-explicit documentation conflict for Gemini). No
  Qwen-specific live probe has been run.

### RF-OR-006 — OpenCode passes the configured `provider` routing object verbatim; OpenRouter's UI provider slugs (e.g. `z-ai/fp8`) bind (observed); aux (title/summary) requests use a different model with no pin

- Status: current
- Verified: 2026-10-14
- Area: openrouter-transport
- Fact:
  - OpenCode passes a configured `providers.<id>.models.<model>.settings.provider`
    object through to the request body's `provider` field **verbatim** (observed on
    the wire: `{"order":["z-ai/fp8"],"only":["z-ai/fp8"],"allow_fallbacks":false}`).
  - OpenRouter honors those slugs: with `only:["z-ai/fp8"]` the response `provider`
    was **Z.AI**; with `only:["xiaomi/fp8"]` it was **Xiaomi**. The `/fp8` suffix is a
    quantized provider-endpoint slug as surfaced by OpenRouter's UI. (The first-party
    provider-routing docs describe slugs as provider names with an optional endpoint
    suffix and put quantization in a separate `provider.quantizations` field; the UI
    supplies combined slugs that work in practice.)
  - OpenCode's **auxiliary** requests (title/summary) are sent to a **different**
    model — observed `openai/gpt-6-luna` — and carry **no** `provider` routing field,
    so they route elsewhere (observed `provider: "OpenAI"`). This is a likely source
    of "different provider" sightings in OpenRouter logs when the main model is
    pinned. (A pin keyed on a variant id such as `openai/gpt-6-luna:flex` does not
    match the bare `openai/gpt-6-luna` aux request.)
  - `GET /api/v1/generation?id=<x-generation-id>` returned `404 generation not found`
    for these streamed requests in this run (id not queryable that way).
- Evidence: [O] (real OpenRouter requests, 2026-10-14; OpenCode 2.0.26; loopback
  capture proxy; no credentials logged)
- Sources: local P2-T4 experiment (`/tmp/opencode/t4*`);
  `docs/phase2-p2t4-provider-ab-report.md`; OpenRouter "Provider Routing" docs
  (`openrouter.ai/docs/guides/routing/provider-selection`).
- Justifies: interpreting OpenRouter activity logs and the P2-T4 routing setup.
- Version context: OpenRouter; OpenCode 2.0.26.
- Re-verify when: OpenCode changes request assembly or aux-model selection;
  OpenRouter changes provider-slug semantics; or the `/generation` response changes.
- Superseded by: null
- Notes: `allow_fallbacks:false` + `only` binds to the specified slug; the first-party
  docs are not explicit about how an *unrecognized* slug is treated, so a mistyped
  slug may silently fail to bind. Aux-model behavior is harness (OpenCode) behavior,
  not an OpenRouter fact.

## RF-SDK — AI-SDK and provider-package serialization

### RF-SDK-001 — `@openrouter/ai-sdk-provider` forwards `providerOptions.openrouter` verbatim, so OpenRouter needs snake_case keys

- Status: current
- Verified: 2026-09-27
- Area: sdk-serialization
- Fact: The provider spreads `providerOptions.openrouter` into the request body
  without renaming, so OpenRouter must receive snake_case wire names while
  direct OpenAI/Azure receive camelCase SDK option names.
- Evidence: [O]
- Sources: local — `@openrouter/ai-sdk-provider` request-body construction;
  wire body confirmed to carry `promptCacheKey` / `promptCacheOptions` in the
  `v0.4.9` serialization fix; documented in `src/cache-engine-core.mjs`.
- Justifies: `gptCacheOptionFieldNames` transport selection in
  `src/cache-engine.ts`.
- Version context: `@openrouter/ai-sdk-provider@2.9.0`, `@ai-sdk/openai@3.0.88`,
  `@ai-sdk/azure@3.0.93`, `ai@6.0.168`.
- Re-verify when: any pinned package bumps, or OpenRouter changes the accepted
  field names.
- Superseded by: null
- Notes: Sending camelCase to OpenRouter fails silently — the cache key is
  dropped without an error. **Scope note:** this is about the GPT
  `prompt_cache_key` / `prompt_cache_options` options. It does **not** contradict
  RF-OR-002: the provider *does* convert the separate `cacheControl` key to wire
  `cache_control`. Only the GPT cache options are forwarded verbatim.

## RF-PRV — Provider API mechanics (not model-specific)

### RF-PRV-001 — DeepSeek KV-cache isolation is keyed by `user_id`, and there is no write accounting

- Status: current
- Verified: 2026-09-26
- Area: provider-api
- Fact: DeepSeek's context caching is fully automatic (passive), isolates cache
  entries by `user_id`, and reports no cache-write tokens.
- Evidence: [D]
- Sources: local — DeepSeek API documentation, recorded with its source list and
  consultation date in `docs/cache-policy-inventory.md` §3.
- Justifies: the DeepSeek passive-only invariant and its baseline usage fields
  in `src/cache-policy-core.mjs`.
- Version context: DeepSeek chat completions API as of the recorded date.
- Re-verify when: DeepSeek publishes new cache fields or changes `user_id`
  isolation semantics.
- Superseded by: null
- Notes: Never synthesize a DeepSeek cache-write value.

### RF-PRV-002 — Moonshot/Kimi caching is automatic on the OpenAI-compatible path; `prompt_cache_options` only selects a write TTL and the Anthropic path uses `cache_control`

- Status: current
- Verified: 2026-10-04
- Area: provider-api
- Fact: On Moonshot/Kimi's OpenAI-compatible Chat Completions and Responses
  paths, context caching is **automatic/implicit**. The optional
  `prompt_cache_options` object (`{ mode: "implicit", ttl: "5m"|"1h" }`, `mode`
  accepting only `"implicit"`) selects only the write TTL (default `5m`) and is
  not required for caching — omitting it auto-writes the prefix at the `5m` tier
  (Cache Write charges apply); explicit `prompt_cache_breakpoint` in content is
  rejected (HTTP 400). The documented Anthropic-compatible Messages path
  (`/anthropic/v1/messages`) is a **different request shape** that uses a
  top-level `cache_control { type: "ephemeral", ttl: "5m"|"1h" }` (per-message
  markers are ignored; omitting it means read-only at `5m` with no write) and
  currently accepts `kimi-k3` only. Cache Write (separate billing + TTL choice)
  is documented for `kimi-k3` only; `kimi-k2.6`/`kimi-k2.7*` report implicit
  reads only. Usage: Chat `usage.prompt_tokens_details.cached_tokens`/`.cache_write_tokens`,
  Responses `usage.input_tokens_details.*`, Anthropic
  `cache_read_input_tokens`/`cache_creation_input_tokens`; cache-write is also
  surfaced in response headers `Msh-Usage-Cache-Write-Tokens-5m`/`-1h`.
- Evidence: [D]
- Sources: Moonshot/Kimi *Best practices for context caching* —
  https://www.kimi.ai/academy/best-practices-for-context-caching (updated
  2026-09-28) and https://platform.kimi.ai/docs/guide/context-caching; API docs
  https://platform.kimi.ai/docs/api/{chat,responses,messages,models}. Access
  date 2026-10-04.
- Justifies: the **passive** `moonshot.kimi` policy in
  `src/cache-policy-core.mjs` (no request mutation) and the decision not to send
  `prompt_cache_options`/`prompt_cache_key`.
- Version context: Moonshot docs as of 2026-10-04 (docs host now
  `platform.kimi.ai`); current ids `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code`,
  `kimi-k2.7-code-highspeed`.
- Re-verify when: Moonshot changes the cache fields/TTL, adds models, or
  publishes a numeric minimum prefix length.
- Superseded by: null
- Notes: Do NOT apply Anthropic-style `cache_control` to the OpenAI-compatible
  request, and do NOT apply `prompt_cache_options` to unrelated
  OpenAI-compatible providers. CacheEngine stays passive because caching does not
  require a mutation; the Anthropic path is deferred (inventory §11 item 14).
  Conflicting first-party evidence is preserved: the K2.x Chat OpenAPI declares
  `prompt_cache_key`/`prompt_cache_options` while the caching FAQ gates Cache
  Write to `kimi-k3` (unresolved), and the caching academy page names
  `kimi-k2.7`/`-highspeed` while the authoritative Models page lists
  `kimi-k2.7-code`/`-code-highspeed` (CacheEngine matches the Models page).
  Also: no numeric minimum cacheable prefix length is published, and
  `prompt_cache_key`/`metadata.user_id` partitioning semantics are undocumented.


### RF-PRV-003 — Anthropic prompt caching is explicit (cache_control) with ≤4 breakpoints and 5m/1h TTL

- Status: current
- Verified: 2026-10-04
- Area: provider-api
- Fact: Anthropic caches only when `cache_control` markers are present — either a
  top-level `cache_control: {type:"ephemeral"}` (automatic; marks the last
  cacheable block) or per-block `cache_control` on eligible text/image/document
  blocks, `system[]`, or `tools[]` (thinking blocks cannot be marked directly).
  Max 4 breakpoints; automatic + explicit share them; a marker on a block that
  already carries the same TTL is a no-op; a different TTL on the same block, or
  >4 slots, errors; mixing TTLs requires longer-first. TTL default `5m` (write
  1.25x) or `1h` (write 2x); reads 0.1x. Prefix order `tools -> system -> messages`,
  with later levels invalidated by earlier changes; reads look back up to **20
  blocks** (a consecutive `tool_use`/`tool_result` run counts as one position).
  `usage.input_tokens` counts only the tokens **after the last breakpoint**.
  Per-model minimum cacheable length is 512 / 1,024 / 2,048 / 4,096 tokens
  depending on the family. Automatic top-level caching is unsupported on **legacy
  Amazon Bedrock (Opus 4.6 and earlier)**, which requires explicit breakpoints.
  Usage: `cache_read_input_tokens`, `cache_creation_input_tokens`, and
  `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` (the latter two sum to
  the total).
- Evidence: [D]
- Sources: Anthropic *Prompt caching* —
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching ; *Messages*
  — https://platform.claude.com/docs/en/api/messages. Accessed 2026-10-04.
- Justifies: the `anthropic.ephemeral-cache` baseline in `src/cache-policy-core.mjs`
  and the passive Claude policy.
- Version context: Anthropic docs as of 2026-10-04.
- Re-verify when: Anthropic changes cache_control, TTLs, breakpoint caps, or usage fields.
- Superseded by: null
- Notes: CacheEngine sends no cache_control because OpenCode already does (RF-OC-008).

### RF-PRV-004 — Gemini prompt caching is provider-managed implicit (2.5+); explicit caching is a separate resource

- Status: current
- Verified: 2026-10-05
- Area: provider-api
- Fact: Google enables **implicit** context caching by default for Gemini 2.5 and
  newer; there is no request-side cache-control field, and cache hits surface as
  `usageMetadata.cachedContentTokenCount` (no write/creation token field).
  Minimum cacheable input is per-model (AI Studio: 2.5 Flash/Pro 2,048, 3.x
  4,096; Vertex also lists a 6,144 tier for some previews) — model/platform
  specific. Google recommends large/common content first and similar prefixes
  close together. **Explicit** caching is a separate resource lifecycle: `POST
  /v1beta/cachedContents` with `{model, contents, systemInstruction, ttl}`
  (default 1 hour; Vertex default 60 min, min 1 min) returning a `name`, then
  `generateContent` with top-level `cachedContent`. Gemini 2.0 and earlier do
  not have implicit caching (2.0 is shut down). **Gemma is a separate family.**
  Subscription: Gemini Code Assist for individuals / Google AI Pro / Ultra was
  discontinued **2026-06-18**; Standard/Enterprise remain but expose no
  documented cache-control semantics.
- Evidence: [D]
- Sources: https://ai.google.dev/gemini-api/docs/caching ;
  https://ai.google.dev/gemini-api/docs/models ; Vertex context-cache docs
  (docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview);
  https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals .
  Accessed 2026-10-05.
- Justifies: the `google.gemini-implicit` baseline and the passive Gemini policy;
  explicitly NOT managing `cachedContents`.
- Version context: Google docs as of 2026-10-05.
- Re-verify when: Google changes implicit-cache models/minimums/TTL or the CachedContents API.
- Superseded by: null
- Notes: Do not implement `cachedContents` lifecycle management in CacheEngine.

### RF-PRV-005 — Gemini implicit minimums are platform-specific; the only documented `-latest` alias is gemini-flash-latest

- Status: current
- Verified: 2026-10-05
- Area: provider-api
- Fact: Gemini implicit-cache **minimum token** thresholds differ by platform
  (model/platform-specific eligibility, not a contradiction):
  - Google Gemini Developer API (AI Studio): Gemini 2.5 Flash/Pro **2,048**;
    Gemini 3.x Flash / 3.1 Pro Preview **4,096**. Flash-Lite variants are not
    listed.
  - Vertex AI: Gemini **2 family 2,048; 3 family 4,096**, plus a separate
    **6,144** tier for `3.0 Flash Preview`, `3.1 Pro Preview`, `3.7 Flash`,
    `3.8 Flash` (implicit-only). Vertex lists Flash-Lite as implicit-capable.
  Aliases: Google's Models page documents the "Latest" pattern with the single
  example **`gemini-flash-latest`**; it does **not** enumerate
  `gemini-flash-lite-latest` or `gemini-pro-latest`. The installed OpenCode
  catalog carries `gemini-flash-latest` and `gemini-flash-lite-latest` for
  `google`/`google-vertex`, and no `gemini-pro-latest`. Usage: the cached-read
  field is `usageMetadata.cachedContentTokenCount` (present for both implicit and
  explicit hits); `UsageMetadata` has **no cache-write/creation token field**.
- Evidence: [D]/[O]
- Sources: https://ai.google.dev/gemini-api/docs/caching and
  .../generate-content/caching and .../models ; Vertex
  docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview
  and .../reference/rest/v1/GenerateContentResponse ; installed
  `~/.cache/opencode/models.json`. Accessed 2026-10-05.
- Justifies: the matcher accepts `gemini-flash-latest` and
  `gemini-flash-lite-latest` but treats `gemini-pro-latest` as neutral, and
  enforces no minimum (CacheEngine does not own context eligibility).
- Version context: Google/Vertex docs as of 2026-10-05.
- Re-verify when: Google changes implicit-cache minimums, the `-latest` alias set,
  or the usage field; or the OpenCode catalog changes its Gemini aliases.
- Superseded by: null
- Notes: Do not pad prompts or inject tokens to cross a provider minimum.

### RF-PRV-006 — Alibaba/Qwen caching is provider-managed implicit on every route; CacheEngine stays passive

- Status: current
- Verified: 2026-10-05
- Area: provider-api
- Fact: Alibaba Model Studio / DashScope / QwenCloud document two context-cache
  modes:
  - **Implicit:** provider-managed, automatic, **cannot be disabled**; common
    prefix matching; minimum **~1,024 tokens** (the QwenCloud text FAQ table says
    256 — a first-party inconsistency; the detailed guide and the Model Studio
    page say 1,024); **no fixed TTL** (evicted after long disuse); hit probability
    is not guaranteed; cached-token usage is reported.
  - **Explicit:** opt-in marker `cache_control:{type:"ephemeral"}` placed **inside
    a `content` block of a `messages[]` item** (system/user/assistant/tool); the
    Anthropic-compatible route also accepts it in the top-level `system` array.
    Minimum **1,024** tokens; **5-minute** validity, refreshed by each hit;
    **≤4** markers (only the last four take effect); tool definitions are
    serialized into the system-message cache and cannot be marked independently.
  - **Session cache** (Responses API only): header
    `x-dashscope-session-cache: enable` + `previous_response_id`; not available on
    the Chat Completions / DashScope / Anthropic routes.
  Implicit and explicit are mutually exclusive on the Chat/Anthropic routes.
  Usage: OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` (read) +
  `.cache_creation_input_tokens` (write); DashScope native `input_tokens` +
  `prompt_tokens_details.cached_tokens`/`cache_creation_input_tokens` (some VL
  models report `cached_tokens` in Singapore); Anthropic-compatible
  `cache_read_input_tokens` + `cache_creation_input_tokens` (read excluded from
  `input_tokens`). Cache is isolated **per account and per model**. No
  routing/stickiness key is documented. Prefix guidance: static content first,
  variable last; keep `tools` order and JSON field order stable; merge consecutive
  tool messages to stay within the 20-block lookback.
- Evidence: [D]/[I]
- Sources: Model Studio *Context Cache*
  https://www.alibabacloud.com/help/en/model-studio/context-cache ; QwenCloud
  context-cache https://docs.qwencloud.com/developer-guides/run-and-scale/context-cache ;
  QwenCloud text FAQ https://docs.qwencloud.com/resources/faq-text-generation ;
  QwenCloud Anthropic API https://docs.qwencloud.com/api-reference/chat/anthropic ;
  Model Studio Coding Plan https://www.alibabacloud.com/help/en/model-studio/coding-plan
  and .../coding-plan-faq ; Qwen Code auth
  https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/ ; Qwen Code
  token caching https://qwenlm.github.io/qwen-code-docs/en/users/features/token-caching/ ;
  OpenRouter Prompt Caching https://openrouter.ai/docs/features/prompt-caching and
  per-model endpoints https://openrouter.ai/api/v1/models/qwen/<id>/endpoints ;
  OpenCode `provider/transform.ts` + `session/session.ts` @ v1.18.34. Accessed
  2026-10-05.
- Justifies: the `alibaba.qwen` registry entry is passive (`rt("qwen")`: no
  `gptCacheMetadata`, no `envRelocation`, no affinity, `cacheRatio` null); the
  matcher `isQwenModel` classifies Qwen chat families; no explicit-marker overlay
  is implemented.
- Version context: Alibaba/QwenCloud docs as of 2026-10-05; OpenCode 1.18.34.
- Re-verify when: Alibaba changes the implicit/explicit mechanisms, minimum, TTL,
  marker location, or the Qwen model list; OpenCode changes its `applyCaching`
  gate or Qwen provider routes; or OpenRouter changes its Qwen cache contract.
- Superseded by: null
- Notes: **Coding Plan** (`https://coding[-intl].dashscope.aliyuncs.com/v1` OpenAI
  / `.../apps/anthropic` Anthropic) and **Token Plan**
  (`https://token-plan[-cn-beijing].maas.../compatible-mode/v1`) endpoints are
  documented, but their cache semantics are **not** → passive/unknown. Legacy
  **Qwen OAuth** free tier was discontinued 2026-04-15 → not a current route.
  **OpenCode Go** Qwen (`qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-plus`) uses
  `@ai-sdk/anthropic` → OpenCode already applies Anthropic-style breakpoints, so
  CacheEngine must not duplicate. **Zen** Qwen mixes `@ai-sdk/anthropic` and
  `@ai-sdk/openai-compatible`. **OpenRouter** Qwen documents explicit block
  markers (`qwen/qwen3-max`, `qwen/qwen-plus`, `qwen/qwen3.6-plus`,
  `qwen/qwen3-coder-plus`, `qwen/qwen3-coder-flash`; 5m TTL; reads
  `prompt_tokens_details.cached_tokens`, writes `cache_write_tokens`) but its
  endpoint `supports_implicit_caching` metadata contradicts the docs and no
  `session_id` recommendation exists; OpenRouter's Qwen minimum cacheable prefix,
  maximum breakpoints, eligible roles/content types, Alibaba-native translation,
  and which cache-mode statement is authoritative are all **[U]** (see RF-OR-005);
  the V1 `chat.params` hook cannot place a block-level marker
  (`experimental.chat.messages.transform` block serialization unverified), so
  CacheEngine stays passive. `qwen3-embedding-*` and rerankers are excluded from
  the matcher. Harness-side provider/`npm` evidence is RF-OC-012.

### RF-PRV-007 — xAI Grok caching is automatic prefix caching with route-specific affinity hints

- Status: current
- Verified: 2026-10-06
- Area: provider-mechanics
- Fact: xAI's mechanism is **"Prompt Caching"**, and it is **automatic** ("the
  xAI API automatically caches them"; "Prompt caching is available on all `grok`
  language models"). It works from the **start of the messages array**:
  consecutive requests that share the same starting messages reuse the cached
  prefix; any edit, removal, or reorder of earlier messages breaks it
  (append-only). Cache entries are **server-local** and **not guaranteed** —
  they can be evicted due to memory pressure, server load, or restarts (no
  numeric TTL is documented; "at any time"). There is **no explicit breakpoint /
  `cache_control` mechanism**, **no documented TTL**, and **no documented minimum
  token threshold**. The only client inputs are optional, *recommended* routing
  hints ("we recommend setting the `x-grok-conv-id` HTTP header"; best practices
  "Always set `x-grok-conv-id` (or `prompt_cache_key` for Responses API)"), both
  described as "best-effort sticky routing" — routing/affinity, **not** cache
  creation or eligibility:
  - Chat Completions HTTP header **`x-grok-conv-id`** ("routes requests with the
    same conversation ID to the same server").
  - Responses top-level body field **`prompt_cache_key`** ("functions identically
    to setting `x-grok-conv-id`").
  - The Chat Completions REST reference also documents a body **`prompt_cache_key`**
    ("Plumbed to `x-grok-conv-id`, same as on `/v1/responses`").
  - The Vercel AI SDK provider-option name is **`promptCacheKey`**
    (`providerOptions: { xai: { promptCacheKey } }`); the SDK serializes it to the
    wire `prompt_cache_key`.
  - No length/charset constraint on the value is documented; a UUID or the
    application's session ID is suggested.
  - These are the **only** cache-affinity inputs. `safety_identifier` and the
    legacy `user` field are abuse-attribution identifiers, **not** cache affinity.

  Endpoints: `POST https://api.x.ai/v1/chat/completions` (xAI labels Chat
  Completions a **legacy/deprecated** endpoint — "new features will come to the
  Responses API first"); `POST https://api.x.ai/v1/responses` and `POST
  https://api.x.ai/v1/responses/compact`; base `https://api.x.ai/v1`. Regional
  `https://us.api.x.ai/v1` (currently `grok-4.7`/`grok-4.6` only, 1.1× token
  price). Prompt hits are not guaranteed across endpoints.

  First-party inconsistency (flag): xAI's `model-capabilities/text/comparison`
  page claims Chat Completions returns "No reasoning content" and bills "Full
  history … on each request", contradicting the Chat Completions reference
  (`message.reasoning_content`, `prompt_tokens_details.cached_tokens`) and the
  prompt-caching pages. Treat the prompt-caching and API-reference pages as
  authoritative for cache behavior; the comparison table appears stale.

  Economics: cached input is billed at a lower **cached-input** rate (e.g.
  `grok-4.7` $2.00 input / $0.50 cached / $6.00 output per 1M tokens; long-context
  rows apply to cached tokens too); **no separate cache-write fee is documented**.
  The US endpoint 1.1× multiplier applies to cached input with the cache discount
  applied first, and Priority Processing 2× applies after the discount.

  Prefix contents: "The cacheable prefix includes all messages up to and
  including tool call results." Reasoning models require preserving prior
  **`reasoning_content`** or stateful Responses continuation via
  **`previous_response_id`**; encrypted reasoning uses
  `include: ["reasoning.encrypted_content"]` (always returned for `grok-4.7` on
  Responses; Chat Completions has no ciphertext field). Responses are stored 30
  days unless `store:false`.

  Usage: Chat Completions `usage.prompt_tokens_details.cached_tokens`; Responses
  `usage.input_tokens_details.cached_tokens`; gRPC
  `response.usage.cached_prompt_text_tokens`. **There is no cache-write/creation
  field** — xAI reports cached reads only; cost is exposed directly as
  `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks; post-cache-discount).

  Auth: API key via `Authorization: Bearer $XAI_API_KEY`; the Grok consumer
  account is shared with the API but billing is separate. **No first-party
  statement that a SuperGrok / X Premium subscription changes API cache
  semantics**, and the subscription OAuth endpoint is undocumented; the Grok
  Build CLI OAuth flow's target endpoint is undocumented.

  Model scope: language ids `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`,
  `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`,
  `grok-4.20-multi-agent-0309`, `grok-build-0.1`; aliases `<model>`,
  `<model>-latest` / `<model>-<date>` (`grok-latest` is *not* served on the US
  endpoint). Non-language products (not cache-documented; excluded):
  `grok-imagine-image`(-2.0/-quality), `grok-imagine-video`(-1.5/-1.5-lite),
  `grok-voice-*`, transcribe/TTS; no standalone embedding model id is documented
  (Collections embeddings are internal to RAG).

  OpenRouter side: its Prompt Caching page documents a **Grok** section —
  caching "automated and does not require any additional configuration", cache
  **writes at no cost**, cache **reads at 0.25× input** (constant
  `GROK_CACHE_READ_MULTIPLIER = '0.25'`) — but says **nothing Grok-specific**
  about `x-grok-conv-id`, `prompt_cache_key`, TTL, or minimum. OpenRouter applies
  its own generic provider sticky routing (`session_id` / `x-session-id`, 256
  chars, 10-minute inactivity expiry).
- Evidence: [D] (xAI first-party docs; OpenRouter first-party docs) / [U] (the
  unknowns below)
- Sources: xAI — https://docs.x.ai/developers/advanced-api-usage/prompt-caching ,
  .../prompt-caching/how-it-works , .../prompt-caching/maximizing-cache-hits ,
  .../prompt-caching/best-practices , .../prompt-caching/multi-turn ,
  .../prompt-caching/usage-and-pricing ;
  https://docs.x.ai/developers/rest-api-reference/inference/chat-completions ,
  .../inference/responses ; https://docs.x.ai/developers/models ;
  https://docs.x.ai/developers/pricing ; https://docs.x.ai/developers/cost-tracking ;
  https://docs.x.ai/developers/model-capabilities/text/reasoning ,
  .../text/generate-text ; https://docs.x.ai/developers/advanced-api-usage/context-compaction ,
  .../advanced-api-usage/regions ; https://docs.x.ai/developers/quickstart ;
  https://docs.x.ai/developers/faq/accounts . OpenRouter —
  https://openrouter.ai/docs/features/prompt-caching . All accessed 2026-10-06.
- Justifies: the `xai.grok-cache` baseline (`automatic:true`,
  `defaultMode:"implicit"`, `supportsExplicitBreakpoints:false`,
  `minCacheTokens:null`, `ttl:null`, `cacheWriteBilled:false`, usage fields) and
  the passive `xai.grok` policy; **no TTL or minimum is invented** and **no write
  token is fabricated**. OpenCode already supplies the Responses affinity key
  (RF-OC-013).
- Version context: xAI docs fetched 2026-10-06; OpenCode 1.18.34.
- Unknowns: minimum cacheable prefix; numeric TTL; refresh-on-hit behavior;
  per-account/per-model cache scoping and whether entries are shared across
  users; maximum value length/format for `x-grok-conv-id`/`prompt_cache_key`;
  whether the Responses endpoint honors a raw `x-grok-conv-id` header; whether
  the separate `tools` schema array participates in the prefix (only tool
  *messages* are documented); whether a SuperGrok/X Premium subscription changes
  cache semantics or which endpoint its OAuth flow targets; how much of a
  post-compaction prompt remains cache-eligible.
- Re-verify when: xAI changes the prompt-caching mechanism, the affinity field
  names or placement, the usage fields, or the documented model scope; or adds a
  TTL, a minimum, or an explicit breakpoint.
- Superseded by: null
- Notes: xAI's `prompt_cache_key` is a **routing/affinity hint**, not OpenAI's
  `prompt_cache_options` policy — do not reuse GPT cache semantics. xAI documents
  the AI SDK option `providerOptions.xai.promptCacheKey` for `xai.responses(...)`,
  which is the exact option the OpenCode runtime populates. In the installed
  OpenCode 1.18.34 the direct-xAI route is Responses and the harness itself sets
  `promptCacheKey` (RF-OC-013), so CacheEngine stays passive and only observes.
  xAI notes the AI SDK auto-includes encrypted reasoning "as long as `store: false`
  is not specified"; OpenCode sets `store: false` for xAI (RF-OC-013), so whether
  reasoning-state continuation survives on that path is unverified ([U],
  OpenCode-owned, outside CacheEngine's reach).

### RF-PRV-008 — Meta Muse Spark caching is automatic positional prefix caching with an app-stable routing key

- Status: current
- Verified: 2026-10-06
- Area: provider-mechanics
- Fact: Meta's "Prompt Caching" for Muse is **automatic/implicit**: "Meta Model
  API caches the stable prefix automatically — no flag or key to manage"; "It
  runs on every request with no action from you. You do not pass a cache key, set
  a flag, or mark breakpoints." There is **no explicit breakpoint / `cache_control`
  mechanism**. The cache is **positional prefix** matching: "it compares the start
  of your tokenized prompt to recently cached key-value (KV) state. Where the
  leading tokens match, that prefix is served from cache and only the tokens after
  the first difference are computed from scratch." Participating content: stable
  **system prompt/instructions**, **few-shot examples**, **conversation history**,
  and **tool definitions** ("tool definitions are computed once and reused across
  turns"). Breaking content: any difference from the cached prefix, e.g. "an
  edited system prompt" or volatile content early in the prompt; reordering/
  removing earlier messages follows from the prefix rule. Whether
  `temperature`/`top_p`/`max_tokens`/`response_format`/`safety_identifier`,
  tool-schema edits, or multimodal image/file/video items break the prefix is
  **not documented [U]** (params that are not tokenized prompt text should not
  [I]; tool schemas should [I]). Caching is independent of the Responses `store`
  parameter.

  Request inputs (both **optional**):
  - **`prompt_cache_key`** — top-level field, accepted on **both Responses and
    Chat Completions**, replacing the deprecated `user` field. It is a
    **routing/affinity** hint, **not** eligibility: "Requests that share a key
    route together, so a request is more likely to land on a backend that already
    holds its prefix." It **must be stable**: "Pick a stable string that
    identifies the shared prefix, such as an application name or use case, **not
    a per-user or per-request value**"; "Don't over-partition: unique keys per
    user or per session lower hit rates." Examples: `"my-app-system-prompt"`,
    `"customer-support-agent"`, `"code-review-v2"`. No length/charset cap is
    documented **[U]**. The deprecated `user` field is superseded by
    **`safety_identifier`** (abuse attribution) and `prompt_cache_key` (caching);
    `safety_identifier` takes precedence when both are sent. Neither `user` nor
    `safety_identifier` is a cache control.
  - **`prompt_cache_retention`** — Responses-framed and listed in the Chat
    Completions parameter table; values **`"in_memory"`** (default: "Keep the
    cache in memory") and **`"24h"`** ("Request extended retention … up to 24
    hours"). It is a **hint, not a guarantee**: "Actual retention is managed
    server-side based on available resources, and the server may evict entries
    early under load." No documented effect on pricing/eligibility/routing **[U]**.

  Lifecycle: no minimum is documented **[U]**; `in_memory` has no numeric
  lifetime and is "evicted under pressure or after inactivity"; `24h` requests up
  to 24 hours but is best-effort; entries are **backend-local** (requests sharing
  a key "route together … land on a backend that already holds its prefix").
  Whether entries are shared across users, or scoped per account/model, is **[U]**;
  partitioning by `prompt_cache_key` + backend locality is **[I]**.

  Economics (Meta Model API, per 1M tokens): **standard** cached input **$0.15**
  (input $1.25, output $4.25); **contributor** cached input **$0.002** (input
  $0.10, output $0.20). **No cache-write price and no write-billing statement**;
  no separate retention cost; "no long-context premium."

  Usage: Chat Completions `usage.prompt_tokens_details.cached_tokens`; Responses
  `usage.input_tokens_details.cached_tokens`; Messages (Anthropic-compatible)
  `usage.cache_read_input_tokens`. **No cache-write/creation field exists** on any
  Meta surface.

  Endpoints: base `https://api.meta.ai/v1`; `POST /v1/chat/completions`,
  `POST /v1/responses` (+ `/v1/responses/{id}`, `/cancel`, `/compact`), and the
  Anthropic-compatible `POST /v1/messages` (+ `/count_tokens`). Auth is
  `Authorization: Bearer $MODEL_API_KEY`. Muse Code offers a subscription via
  Meta Account, but **no OAuth API route is documented**.

  Reasoning/state: Chat Completions **cannot** carry reasoning across turns for
  external keys (`reasoning_content` is redacted to empty); Responses carries it
  via `previous_response_id` or stateless encrypted replay
  (`include:["reasoning.encrypted_content"]`, `store:false`). Caching is
  **independent of `store`**; with `previous_response_id` the server reconstructs
  prior turns and a follow-up reports only the new turn's tokens.

  Model scope: `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`,
  `muse-spark-1.2-contributor`, `muse-spark-1.1`. `muse-glimmer-*` is
  open-weight/self-hosted and "isn't served on any Meta Model API endpoint";
  caching for it is not documented → excluded.

  OpenRouter: models `meta/muse-spark-1.3` and `meta/muse-spark-1.2`, single
  provider **Meta**; `input_cache_read` **$0.15**/M, **no cache-write price**;
  **`supports_implicit_caching: false`**; `supported_parameters` does **not**
  include `prompt_cache_key`; only Chat Completions is confirmed for Muse; no
  Muse-specific section in OpenRouter's caching doc. OpenRouter's generic sticky
  routing (`session_id`/`x-session-id`, ≤256 chars) applies but is not documented
  as a Muse cache control.
- Evidence: [D] (Meta first-party docs; OpenRouter docs/API) / [U] (the unknowns
  above)
- Sources: https://dev.meta.ai/docs , .../docs/prompt-caching , .../docs/models ,
  .../docs/pricing-rate-limits , .../docs/protocols ,
  .../docs/protocols/responses , .../docs/protocols/chat-completions ,
  .../docs/protocols/messages , .../docs/reasoning ,
  .../docs/muse-code/subscriptions ; https://openrouter.ai/api/v1/models/meta/muse-spark-1.3/endpoints ;
  OpenRouter Prompt Caching. All accessed 2026-10-06.
- Justifies: the `meta.muse-cache` baseline (`automatic:true`,
  `defaultMode:"implicit"`, `supportsExplicitBreakpoints:false`,
  `minCacheTokens:null`, `ttl:null`, `cacheWriteBilled:false`, usage fields) and
  the passive `meta.muse` policy; **no TTL, minimum, or write token is invented**,
  and `prompt_cache_retention` is represented as harness-owned metadata rather
  than an active field. Meta's app-stable (non-per-session) key rule is why
  CacheEngine never synthesizes a `prompt_cache_key`.
- Version context: Meta docs fetched 2026-10-06; OpenCode 1.18.34.
- Unknowns: minimum cacheable prefix; `in_memory` lifetime; whether `24h` is a
  max request or a guarantee (docs say hint); eviction specifics; cross-user/
  account/model cache scope; key value length/charset; whether non-text params/
  modality break the prefix; whether `prompt_cache_retention` affects pricing;
  the subscription OAuth endpoint.
- Re-verify when: Meta changes the caching mechanism, the `prompt_cache_key` /
  `prompt_cache_retention` semantics, the usage fields, or the model scope; or
  adds an explicit breakpoint/TTL/minimum or a write-accounting field.
- Superseded by: null
- Notes: `prompt_cache_key` is a routing/affinity hint, not an OpenAI-style
  `prompt_cache_options` policy — do not reuse GPT cache semantics, and never
  generate a per-session key (Meta states it lowers hit rates). `24h` retention is
  a request-level policy with memory/privacy implications and is left
  harness/user-owned.

### RF-PRV-009 — MiniMax caching: passive automatic prefix caching for all M-series, explicit Anthropic cache_control only for M2.x

- Status: current
- Verified: 2026-10-07
- Area: provider-mechanics
- Fact: MiniMax documents **two** cache modes, split by model. **Passive
  (automatic)**: "Automatic Caching: Passive caching that automatically
  identifies repeated context content without changing API call methods";
  marketing pages say "Full automatic Cache support, no configuration needed."
  Supported: **M3 / M2.7 series / M2.5 series / M2.1 series**. Prefix matching is
  positional in the order **"tool list → system prompts → user messages"**;
  "Caching applies to API calls with 512 or more input tokens" (the 512-token
  **cacheability threshold** is distinct from the models' own context/pricing
  tiers — e.g. M3's 1M-token context — which are not cache thresholds); passive
  TTL is
  **"automatically adjusted based on system load"** (no numeric value). **Explicit
  (Anthropic-compatible endpoint only)**: `cache_control:{"type":"ephemeral"}` on
  `system[]`, `messages[].content[]`, and `tools[]`; cumulative prefix order
  "`tools` → `system` → `messages`"; ≤4 breakpoints ("only the most recent 4");
  20-block lookback; **5-minute TTL refreshed on each hit**. Explicitly supported:
  **M2.7 / M2.5 / M2.1 / M2 series — M3 is NOT listed**, so M3 has no explicit
  breakpoint and no billed write. Request/response cache inputs:
  - `prompt_cache_key` (string) is a **routing identifier** on the **Responses**
    API (`/v1/responses`) only; no documented pricing/eligibility effect. **No**
    `cache_ttl`, `prompt_cache_retention`, `cache_breakpoint`, or `cache_key`
    exists anywhere searched.

  Endpoints: native `POST https://api.minimax.io/v1/text/chatcompletion_v2`;
  OpenAI-compatible `POST https://api.minimax.io/v1/chat/completions` (base
  `https://api.minimax.io/v1`); Anthropic-compatible
  `POST https://api.minimax.io/anthropic/v1/messages` (base
  `https://api.minimax.io/anthropic`); OpenAI Responses-compatible
  `POST https://api.minimax.io/v1/responses`.

  Model IDs: `MiniMax-M3.1-Flash-Preview` (M Plan/Code only), `MiniMax-M3`,
  `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`,
  `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2.1-highspeed`,
  `MiniMax-M2`. (Also noted, not cache-related: `max_tokens` is deprecated in
  favour of `max_completion_tokens` on the OpenAI-compatible schema.)

  Usage fields: OpenAI Chat `usage.prompt_tokens_details.cached_tokens` (read
  only); Responses `usage.input_tokens_details.cached_tokens` (read only);
  Anthropic Messages `usage.cache_read_input_tokens` (read) and
  `usage.cache_creation_input_tokens` (**write**). **A cache-write/creation field
  exists only on the Anthropic-compatible endpoint**; Chat Completions and
  Responses expose reads only. Native v2 `usage` documents only `total_tokens`.

  Economics (USD per 1M tokens): **M3** $0.30 input / $0.06 cached read / **no
  write column**; **M2.7** $0.30 / $0.06 / **$0.375 write**; **M2.7-highspeed**
  $0.60 / $0.06 / $0.375; **M2.5** $0.30 / $0.03 / $0.375; **M2.5-highspeed**
  $0.60 / $0.03 / $0.375. The Cache Comparison table states "No additional charge
  for cache writes" (Passive) vs "First-time cache writes incur additional
  charges" (Explicit). So **M3 and M2.x differ materially on cache-write
  billing.**

  Reasoning: multi-turn function-call conversations must append the complete
  assistant message, and `thinking` blocks must be preserved unchanged (they
  carry a `signature`); this is required for reasoning continuity and preserved
  thinking is part of the prefix. Whether reasoning preservation is specifically
  required for cache hits is not stated **[U]**.

  Subscription: the current product is the **MiniMax Token Plan** (the official
  page titles it "Token Plan" and says it "extends upon our former Coding Plan";
  older documentation also referred to an "M Plan"). External tools use a
  **Subscription Key (`sk-cp-…`), a plain Bearer key on the same direct
  `api.minimax.io/v1` or `/anthropic` endpoints (no OAuth)**; OpenCode provider key
  `minimax-coding-plan` (`MiniMax Token Plan (minimax.io)`). Token Plan is **not** a
  separate cache provider, and cache semantics are not documented as different
  under it.

  OpenRouter: MiniMax is **absent** from OpenRouter's caching doc; every listed
  MiniMax endpoint reports `supports_implicit_caching: false` (contradicting the
  populated `input_cache_read` pricing), **no `input_cache_write`**, and **no
  cache field in `supported_parameters`**; only Chat Completions endpoints are
  listed.
- Evidence: [D] (MiniMax first-party docs; OpenRouter docs/API) / [U] (the
  unknowns below)
- Sources: https://platform.minimax.io/docs/api-reference/text-prompt-caching ,
  https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache ,
  https://platform.minimax.io/docs/api-reference/text-chat-openai ,
  https://platform.minimax.io/docs/api-reference/text-chat-anthropic ,
  https://platform.minimax.io/docs/api-reference/text-post ,
  https://platform.minimax.io/docs/api-reference/responses-create ,
  https://platform.minimax.io/docs/guides/pricing-paygo ,
  https://platform.minimax.io/docs/m-plan/intro ,
  https://platform.minimax.io/docs/m-plan/opencode ;
  https://www.minimax.io/models/text/m3 , .../m27 ;
  https://openrouter.ai/api/v1/models/minimax/minimax-m3/endpoints (and m2.7,
  m2.5); OpenRouter Prompt Caching. All accessed 2026-10-07.
- Justifies: the `minimax.m3-cache` baseline (`supportsExplicitBreakpoints:false`,
  `cacheWriteBilled:false`, read-only usage) and the `minimax.m2-cache` baseline
  (`supportsExplicitBreakpoints:true`, `cacheWriteBilled:true`, write usage field)
  — the two are kept separate rather than flattened. The passive `minimax.m3` /
  `minimax.m2` policies and the `minimax_route` telemetry `cacheWriteBilled` flag.
- Version context: MiniMax docs fetched 2026-10-07; OpenCode 1.18.34.
- Unknowns: passive TTL number; eviction/scope/cross-user sharing; whether
  sampling params (`temperature`/`top_p`), `response_format`, or multimodal
  image/video blocks affect eligibility; the actual effect of `prompt_cache_key`
  on the Responses path; whether direct MiniMax ignores or rejects `cache_control`
  sent to **M3** (which is not in the explicit list); whether OpenRouter sticky
  routing helps MiniMax.
- Re-verify when: MiniMax changes the cache modes, model list, write pricing, or
  usage fields; or adds a TTL/retention/affinity control.
- Superseded by: null
- Notes: `cache_control` is a **cache-eligibility/breakpoint** control, while
  `prompt_cache_key` is routing-only — do not treat them as equivalent. M3 and
  M2.x must not share one `cacheWriteBilled` value. Do not store prompts,
  credentials, bodies, or cache-key values.
