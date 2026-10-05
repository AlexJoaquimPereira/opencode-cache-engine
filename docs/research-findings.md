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
  `docs/cache-policy-inventory.md` §8a.
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

## RF-OR — OpenRouter transport and routing

### RF-OR-001 — OpenRouter's upstream provider selection is not exposed to plugins

- Status: current
- Verified: 2026-09-26
- Area: openrouter-transport
- Fact: Which upstream OpenRouter picks is not observable from a plugin, so
  CacheEngine must never claim or override routing.
- Evidence: [O]
- Sources: local — recorded in `docs/cache-policy-inventory.md` §8; consistent
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
  this **contradiction is unresolved** without a live OpenRouter Gemini probe.
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
  serialization through the installed transport is verified end to end.

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
  require a mutation; the Anthropic path is deferred (inventory §10 item 14).
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
