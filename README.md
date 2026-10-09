# OpenCode Cache Engine

Provider-aware prompt-cache optimization and observability for
[OpenCode](https://opencode.ai).

`opencode-cache-engine` is distributed as an npm package. The Git repository is
the development source of truth; the published package is a release artifact.
The package exposes two separate targets required by OpenCode's installed
plugin model:

- **`./server`** — the CacheEngine runtime, hooks, provider policies, and telemetry.
- **`./tui`** — plugin-manager registration and enable/disable integration; it
  has no CacheEngine-specific UI.

For local development, use the package from this Git checkout through the
repository's OpenCode/package development path. Do not maintain or edit a copied
plugin under `~/.config/opencode/plugins/`. For released installs where
reproducibility matters, pin an exact package version rather than relying on
`@latest` resolution or a moving cache entry; see [Installation](#installation).

Quick Installation (TUI): 
``` text
opencode plugin opencode-cache-engine
```

`CacheEngine` is an OpenCode plugin designed for long-running agent sessions where prompt-cache efficiency affects both latency and cost. It keeps the harness conservative for providers whose cache behavior is already automatic, while applying provider-specific optimizations where the provider exposes useful cache controls or where prompt structure can be safely improved.

The plugin currently has eleven cache-policy families:

* **DeepSeek** — passive cache observability; request structure is preserved.
* **GPT-5.6 and later** — documented cache-key/options metadata, with prompt text
  unchanged. GPT-6 and future 5.6+/6+/7+ versions resolve through the same
  documented boundary.
* **GLM-5.3 and later** — GLM implicit-cache baseline and diagnostics; GLM-5.3 additionally uses a narrow, content-preserving `<env>` relocation overlay.
* **MiMo V2.6 and later** — MiMo implicit-cache baseline and diagnostics; MiMo V2.6 Flash/Pro additionally use a narrow, content-preserving `<env>` relocation overlay.
* **Kimi** — passive Moonshot/Kimi implicit-cache observability; the request is
  left unchanged. The Anthropic-compatible `cache_control` route is not
  implemented.
* **Claude (Anthropic)** — passive classification and accounting; the request is
  left unchanged because OpenCode itself applies Anthropic `cache_control`
  breakpoints.
* **Google Gemini** — passive classification and accounting; Gemini 2.5+
  provider-managed implicit caching is left untouched. CacheEngine creates no
  `CachedContent` resources and injects no Gemini cache-control field.
* **Alibaba Qwen** — passive classification and accounting; Qwen's
  provider-managed implicit caching is left untouched on every route. CacheEngine
  places no explicit block-level `cache_control` marker and adds no affinity,
  because the V1 hook cannot reach message content blocks and OpenCode already
  applies breakpoints on the Qwen Messages routes.
* **xAI Grok** — passive classification and accounting. Grok caching is
  automatic on all Grok language models, and direct xAI already receives a stable
  conversation affinity key from OpenCode itself, so CacheEngine injects no
  header or key and rewrites nothing.
* **Meta Muse** — passive classification and accounting. Muse caching is
  automatic positional prefix caching; Meta's `prompt_cache_key` must be an
  application-stable routing hint (never per-session) and `prompt_cache_retention`
  is a request-level policy, so CacheEngine injects neither and rewrites nothing.
* **MiniMax** — passive classification and accounting, route-aware. MiniMax
  caching is automatic; M2.x additionally supports explicit Anthropic
  `cache_control` (M3 does not), but OpenCode already owns those breakpoints on
  the Anthropic-compatible routes, so CacheEngine injects nothing.

Family classification is not hard-coded in the runtime. A pure policy registry
and resolver in `src/cache-policy-core.mjs` returns a structured result
(`creator`, `family`, `baseline`, `overlays`, `transport`, `matchType`,
`matchReason`), and the hooks gate their behavior on that result. The registry is
the single runtime source of policy classification. The first-party research
behind each registry entry is recorded in
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md).

For the MiMo V2.6-and-later family and the GLM-5.3-and-later family, CacheEngine adds its deterministic
`x-session-id` request header only when OpenCode identifies the actual provider
as `openrouter`. It does not add that OpenRouter-specific header for
non-OpenRouter providers; direct provider endpoints retain their provider-native
caching behavior.

The central design principle is:

> Optimize the request structure only when there is a clear provider-specific reason to do so. Otherwise, preserve OpenCode's native request behavior and measure what the provider actually reports.


## What this plugin does

The plugin operates at the OpenCode harness level rather than implementing a provider-specific client.

It:

1. Resolves the model/provider policy through the registry resolver (creator,
   family, baseline, overlays, transport, match reason).
2. Applies only the mutations registered for that policy — currently GPT-5.6+
   cache-key/options metadata, the GLM-5.3 and MiMo-V2.6 volatile-`<env>`
   relocation, the OpenRouter `x-session-id` affinity for those two families, and
   the deterministic compaction continuation block.
3. Leaves every other family's request structure unchanged. DeepSeek, Kimi,
   Claude, Gemini, Qwen, Grok/xAI, Meta Muse, and MiniMax are classified and
   accounted for but never mutated, because the provider or OpenCode already owns
   the relevant cache behavior or no safe mutation is justified. **Passive does
   not mean "no cache support"** — it means CacheEngine does not change the request.
4. Observes system-prompt and tool-definition stability.
5. Records provider-reported cache token usage (reads always; writes only when the
   provider reports them — never fabricated).
6. Emits diagnostics and route/affinity telemetry that correlate prompt-shape
   changes with cache behavior.
7. Never enforces pricing boundaries or context/output limits, and never records
   prompts, reasoning, credentials, or full request bodies.

The plugin deliberately avoids pretending that a local hash is proof of a provider cache hit. Provider-reported token usage remains the authoritative signal.


# Provider behavior

## DeepSeek V4 and later

### Policy: passive

DeepSeek receives **no cache-specific request mutation**.

The plugin does not:

* rewrite the system prompt
* reorder tools
* modify messages
* inject cache-control fields
* inject a prompt-cache key
* alter provider request options

The DeepSeek branch exists primarily to preserve a stable harness while providing observability around the prefix structure and cache usage.

This is intentional. The implementation describes DeepSeek as a passive policy whose purpose is to preserve the existing high-cache-rate behavior rather than introduce new request mutations.

Since v0.4.3 this is formalized as the documented **"DeepSeek V4 and later"**
family. Canonical ids (`deepseek-flash`, `deepseek-v4-pro`) and the accepted
`deepseek-v4-flash` aliases resolve to this passive baseline, and pre-V4 or
unknown future `*deepseek*` ids fall back to the same passive baseline. No cache
key, cache-control field, prompt rewrite, or OpenRouter affinity is ever added
for DeepSeek.

The plugin still observes:

* system-prompt shape
* semantic tool definitions
* wire-order tool definitions
* prefix changes
* cache read tokens
* cache write tokens
* compaction boundaries

### Why passive?

DeepSeek's cache behavior is provider-managed. Introducing unnecessary prompt mutations would risk changing the prefix that the provider can reuse.

Therefore the plugin follows a simple rule:

```text
DeepSeek:
    preserve request
    preserve prefix
    measure cache
```

rather than:

```text
DeepSeek:
    rewrite request
    guess cache key
    force cache behavior
```


## GPT-5.6 and later

### Policy: active cache control

GPT-5.6 and later is the only policy family that actively injects cache-control request metadata.

The plugin adds:

```json
{
  "promptCacheKey": "<stable-session-key>",
  "promptCacheOptions": {
    "mode": "implicit",
    "ttl": "30m"
  }
}
```

Field names are transport-aware: direct OpenAI/Azure receive the camelCase SDK
option names above, while OpenRouter receives snake_case `prompt_cache_key` and
`prompt_cache_options`, because the OpenRouter provider forwards provider options
onto the wire verbatim. Only missing fields are added; existing values are never
overwritten.

The key is derived from the OpenCode session identity (or the resolved cache root when that is enabled) and is independent of transient request data, so it is stable across a session.

Key ownership depends on the transport. OpenCode itself pre-sets `promptCacheKey` to the session id for direct OpenAI/Azure, so on ordinary live requests CacheEngine preserves that existing key and writes its own key only when cache-root affinity is enabled. On OpenRouter, where OpenCode sets no key, CacheEngine supplies it. In both cases a cache key provides namespace **stability and isolation**; it does not by itself guarantee a cache hit — provider-reported usage remains the authoritative signal.

### Important: the prompt text is not rewritten

For GPT-5.6:

```text
system prompt     -> unchanged
conversation      -> unchanged
tool definitions  -> unchanged

request metadata  -> cache key/options added
```

This means the plugin is controlling the cache namespace and cache behavior without performing prompt surgery.

### Default GPT configuration

```json
{
  "promptCacheKey": true,
  "cacheRootKey": false,
  "compactionCacheIsolation": true,
  "reasoningEffortDiagnostics": true,
  "mode": "implicit",
  "ttl": "30m"
}
```

The current implementation intentionally leaves `cacheRootKey` disabled because the OpenCode runtime does not currently expose sufficiently reliable fork lineage for safe parent-cache inheritance. The code path remains available for a future runtime that exposes reliable parent relationships.

### Compaction isolation

Compaction uses a deterministic separate cache-key namespace:

```text
live session:
    ses_abc123

compaction:
    ses_abc123:compact
```

This prevents a compaction-specific prompt from sharing the same GPT cache namespace as the normal live-session prompt. The behavior is deterministic and tested explicitly, and it is enforced even when OpenCode has already pre-set a live-session key (direct OpenAI/Azure), so a compaction request never reuses the live namespace.


## GLM-5.3 and later

### Policy: input-shape optimization

GLM-5.3 and MiMo-V2.6 use the only prompt-text transformation in the current
plugin: a narrow, content-preserving relocation of the identifiable `<env>`
block for the eligible model family.

Since v0.4.4 the GLM **family baseline** and the GLM-5.3 **overlay** are
separate. A resolved GLM-5.3-and-later model inherits the implicit-cache baseline
and the non-mutating GLM diagnostics/transport, but the `<env>` relocation below
is a GLM-5.3-specific overlay and is **not** inherited by a newer GLM merely
because its version number is higher.

The plugin identifies OpenCode's volatile `<env>` section and moves it to the **tail of the system prompt**.

Conceptually:

```text
BEFORE

[large stable instructions]
[volatile environment/date block]
[more stable instructions]
```

becomes:

```text
AFTER

[large stable instructions]
[more stable instructions]
[volatile environment/date block]
```

The contents of the environment block are preserved exactly. The operation changes its location, not its contents.

### Why?

The environment block can contain volatile information such as a changing date.

Keeping that material at the end allows the earlier portion of the system prompt to remain stable across requests.

This is a prompt-shape heuristic, not an established cache win. A controlled
A/B through OpenRouter (ordinary short prompts; env block early vs relocated to
the tail; a changed date between a warm and a test request) did **not** show a
position-dependent cache benefit — the upstream implicit caches reported high
cached-token counts regardless of block position. The cache improvement is
therefore **unverified**. Provider-reported usage remains the only authoritative
signal.

The plugin therefore attempts to isolate volatility:

```text
stable prefix
---------------------------
unchanged across requests

volatile suffix
---------------------------
allowed to change
```

The system-shape diagnostics explicitly distinguish the stable prefix from the volatile suffix for this purpose.

### GLM safety constraints

The transformation is deliberately narrow.

It only occurs when:

* the selected model is GLM-5.3
* GLM stabilization is enabled
* there is exactly one system string
* the expected environment markers exist
* the block can be identified unambiguously

The plugin does not arbitrarily rearrange unrelated prompt content.

### OpenRouter session affinity

For GLM-5.3 requests whose actual OpenCode provider identity is `openrouter`,
CacheEngine adds its deterministic `x-session-id` request header unless a
case-insensitive `x-session-id` is already present in model or plugin headers.
The existing value is preserved. This header is affinity metadata, not a prompt
transformation or cache-control field.

For direct Z.AI or any other non-OpenRouter endpoint, CacheEngine does not add
the OpenRouter-specific affinity header. It leaves the endpoint's native cache
behavior intact.

Affinity observations record eligibility, the observed provider identity,
whether a header was already present or added, and provider-identity changes
(`glm_provider_changed`). They do not record the header value.


## MiMo V2.6 and later

### Policy: prefix stability + OpenRouter session affinity

MiMo-V2.6 is Xiaomi's current model family. Since v0.4.5 the plugin separates
three concerns:

* **Family baseline** — the implicit-cache baseline plus cached-token telemetry,
  provider-change/prefix diagnostics, and OpenRouter session affinity. This
  applies to the documented V2.6 Flash and Pro identifiers, the
  `mimo-v2.6-pro-ultraspeed` mode id, and any future MiMo generation after V2.6.
* **Validated overlay** — the `<env>` relocation described below, registered only
  for MiMo V2.6 Flash/Pro.
* **Transport affinity** — OpenRouter `x-session-id`, gated on the actual
  `openrouter` provider identity.

The documented V2.6 identifiers are:

* `xiaomi/mimo-v2.6-flash` / `mimo-v2.6-flash`
* `xiaomi/mimo-v2.6-pro` / `mimo-v2.6-pro`
* `xiaomi/mimo-v2.6-pro-ultraspeed` / `mimo-v2.6-pro-ultraspeed`

Detection also tolerates `provider/model` shapes where `api.id` contains those
slugs. Future generations after V2.6 (for example `mimo-v2.7-*`) resolve to the
family baseline so a new model remains usable even when its exact id is unknown.
`mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2`, and undocumented V2.6 variants such as
`mimo-v2.6-flashx` remain neutral.

### Implicit context caching

Xiaomi documents context caching for both V2.6 Flash and Pro, and exposes
`usage.prompt_tokens_details.cached_tokens` as the number of prompt tokens
served from cache. The V2.6 API documents implicit context caching, not a
user-supplied cache key or explicit breakpoint.

Accordingly the plugin **injects no cache-control parameter** for MiMo. It does
not send `promptCacheKey`, `cacheControl`, `cacheBreakpoint`, or `ttl`.
Implicit caching is the default assumption.

### Environment-block stabilization

MiMo V2.6 Flash/Pro use the same narrow, content-preserving transformation as
GLM-5.3: the identifiable volatile `<env>` block is relocated to the **tail** of
the single system string. Contents are preserved byte-for-byte; only position changes. This
keeps the large reusable prefix stable when only the environment/date changes.

The transformation is applied only when:

* the selected model is MiMo-V2.6 Flash/Pro
* `mimo26.stabilizeSystem` is `true`
* there is exactly one system string
* the expected `<env>` markers exist and the block is identified unambiguously
* the block is not already at the tail

### No generic system-prompt freezing

MiMo-Code's own harness freezes its per-session system prefix. This plugin does
**not** copy that mechanism. System instructions can legitimately change because
of permissions, tools, agent mode, skills, MCP state, or project configuration;
a plugin-level snapshot must never override a legitimate change.

Instead the plugin:

* records a first-seen system baseline per session;
* computes the full system hash, stable prefix hash, and volatile suffix hash;
* records changes for MiMo sessions;
* allows the `<env>` relocation when that is the only identified volatility;
* reports other system changes diagnostically and never overwrites the new
  content.

Explicit telemetry events:

* `mimo_system_env_relocated`
* `mimo_system_prefix_changed`

### OpenRouter session affinity

For MiMo V2.6-and-later requests whose actual OpenCode provider identity is
`openrouter`, CacheEngine adds its existing deterministic, session-scoped
`x-session-id` request header. If a case-insensitive `x-session-id` already
exists in model or plugin headers, CacheEngine preserves it and does not replace
it. Eligibility uses both the MiMo V2.6-and-later family and the actual provider
identity; a matching model slug on another endpoint is not enough. This is
transport affinity, separate from the V2.6 Flash/Pro `<env>` overlay.

For Xiaomi's direct endpoint and every other non-OpenRouter provider, CacheEngine
does not add its OpenRouter-specific `x-session-id`. Direct provider endpoints
retain their provider-native caching behavior. Any header already supplied by
the user or runtime is left untouched.

The `x-session-id` header is not a top-level request-body `session_id`, a
`promptCacheKey`, or a cache-control option. MiMo uses provider-managed implicit
caching: CacheEngine sends no undocumented `promptCacheKey`, `cacheControl`,
cache breakpoint, or TTL.

### MiMo cache metrics

MiMo caches are provider-managed, so the authoritative metric is provider
reported. For MiMo the plugin emits the preferred ratio:

```text
cacheHitRate = cachedTokens / promptTokens
```

This is intentionally **not** the `read / (read + write)` form used by other
families. It is not GLM's `read / (read + write + input)` either.

Derivation: the runtime exposes assistant tokens as `{ input, output,
cache:{ read, write } }`, where `input` is the non-cached prompt input and
`cache.read` is the cached prompt input. Total prompt tokens are therefore
derived as `read + input`, and `cachedTokens = read`. `cache.write` is a
separate accounting bucket and is not folded in; no cache-write value is
fabricated, and the ratio is `null` when `promptTokens` is zero.

A MiMo usage record looks conceptually like:

```json
{
  "kind": "usage",
  "policy": "mimo26",
  "provider": "openrouter",
  "model": "xiaomi/mimo-v2.6-flash",
  "promptTokens": 50000,
  "cachedTokens": 47000,
  "cacheHitRate": 94
}
```

### Provider-switch diagnostics

Because MiMo caches live at the provider side, a provider change within one
session can silently invalidate them. The plugin records provider identity on
every MiMo request and emits a `mimo_provider_changed` boundary event when the
OpenCode `providerID` changes within a session. It never forces or overrides the
user's provider selection.

Limitation: OpenRouter's *upstream* provider selection (for example
`xiaomi/fp8` vs `atlas-cloud/fp8`) is not exposed to plugins, so only the
OpenCode `providerID`/`modelID` are observable.

### Reasoning / thinking

MiMo-V2.6 supports deep thinking and reports reasoning tokens. The plugin does
not treat reasoning replay as a cache requirement: reasoning diagnostics are
instrumentation only, and the plugin never rewrites, duplicates, reorders, or
re-injects reasoning content, nor changes reasoning effort for caching.

### Skill-catalog / history limitation

MiMo-Code moved skill catalogs out of repeatedly rewritten user messages and
toward the system tail. In this OpenCode runtime the skill guidance
(`<available_skills>`) and MCP instructions already live in the **system
prefix**, not in user-message history. The plugin therefore performs no
message-history rewrite. Skill/MCP changes simply appear as system-prefix changes
and are reported diagnostically; the message content is left untouched.


## Kimi (K2.6 / K2.7-code / K3)

### Policy: passive (automatic implicit caching)

Moonshot/Kimi's OpenAI-compatible Chat Completions and Responses paths cache
**automatically**. CacheEngine therefore leaves the request **unchanged** for the
Kimi family: it adds no cache key, cache options, or markers. It classifies the
documented current model ids and relies on OpenCode's provider-reported cache
usage for accounting.

The optional `prompt_cache_options` object
(`{ "mode": "implicit", "ttl": "5m" | "1h" }`) only selects the cache-write TTL and
is not required for caching, so CacheEngine does not send it. Moonshot documents
Cache Write (separate billing and TTL choice) for `kimi-k3` only. Explicit
per-block `prompt_cache_breakpoint` is rejected by the API.

**Recognized ids** (bare or gateway-prefixed such as `moonshotai/kimi-k3`):
`kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`.

**Not recognized (neutral):** deprecated or renamed ids such as `kimi-k2`,
`kimi-k2-0905`, `kimi-k2.5`, `kimi-k2-thinking`, `moonshot-v1-*`,
`kimi-thinking-preview`, `kimi-latest`, and the Kimi Code Plan aliases
(`kimi-for-coding`, `k3`).

### Anthropic-compatible route (not implemented)

Moonshot also documents an Anthropic-compatible Messages path
(`/anthropic/v1/messages`) that uses a **top-level `cache_control`** instead of
`prompt_cache_options`, and currently accepts `kimi-k3` only. This is a different
request shape; CacheEngine does **not** apply it, and it is never applied to the
OpenAI-compatible request. Implementing it is deferred to a later release.

### Evidence and status

Automatic caching and the `prompt_cache_options` write-TTL semantics were verified
against first-party Moonshot/Kimi documentation on 2026-10-04 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §5). Status:
**documented but not live-validated**; no numeric minimum cacheable prefix length
is published, and the Anthropic-compatible route is not implemented.


## Claude (Anthropic)

### Policy: passive (OpenCode applies the cache breakpoints)

Anthropic prompt caching is **explicit**: a request must carry `cache_control`
markers (a top-level automatic marker, or per-block breakpoints — max 4, `5m`
default or `1h` TTL). **OpenCode already applies these breakpoints itself**:
`ProviderTransform.applyCaching` marks the first two `system` messages and the last
two non-system messages (default `5m`) for Claude/Anthropic transports. CacheEngine
therefore leaves the Claude request **unchanged** — it adds no `cache_control`, no
cache key, no TTL, and no breakpoints.

Injecting a top-level `cacheControl` from CacheEngine would *replace* OpenCode's
breakpoint strategy with automatic caching and risk duplicate or TTL-conflicting
markers (Anthropic returns HTTP 400), so the policy is deliberately passive.

Cache usage is read from OpenCode's normalized `tokens.cache.{read,write}` (from
Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`); the generic
`read/(read+write)` ratio applies.

**Recognized ids** (bare or gateway-prefixed such as `anthropic/claude-sonnet-4-5`):
`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`, `claude-fable-*`,
`claude-mythos-*`, and legacy `claude-3-*`.

**Not recognized (neutral):** look-alikes such as `claude-opus-clone`,
`myclaude-opus-5`, and retired `claude-2` / `claude-instant`.

### Transport and platform limitations

OpenCode applies Anthropic breakpoints for native `@ai-sdk/anthropic`,
`google-vertex-anthropic`, Bedrock (`cachePoint`), and OpenRouter when the model id
contains `anthropic`/`claude`; the `@ai-sdk/gateway` exclusion targets the Vercel
AI Gateway. CacheEngine adds nothing on any of these routes. Automatic top-level
caching is unsupported on legacy Amazon Bedrock (Opus 4.6 and earlier); since
CacheEngine does not choose the strategy, that constraint is OpenCode-owned.

Route summary (all Claude routes are passive for CacheEngine):

| Route | Anthropic caching | Notes |
| ----- | ----------------- | ----- |
| Direct Anthropic API | supported | OpenCode applies the breakpoints; per-workspace cache scope |
| OpenCode Zen (`opencode`) | supported | Claude via `@ai-sdk/anthropic`; Cached Read/Write pricing |
| OpenCode Go (`opencode-go`) | not applicable | serves no Claude models (MiniMax/Qwen only) |
| Claude subscription (OAuth) | unknown / outside scope | not built into OpenCode 1.18.34; Anthropic prohibits third-party subscription use |
| OpenRouter → Claude | supported | `cacheControl` converted to wire `cache_control`; sticky routing is best-effort |
| Amazon Bedrock Claude | supported | `cachePoint`; legacy Opus ≤4.6 explicit-only |
| Google Vertex Claude | supported | Messages `cache_control`; per-org cache scope |
| OpenAI-compatible gateway serving Claude | conditional/unknown | Anthropic `cache_control` is not in the OpenAI schema; honoring it depends on the gateway |

CacheEngine performs no mutation on any of these routes, so it cannot make an
incompatible endpoint reject a request; where a gateway drops cache fields, that
is a gateway limitation. Whether cache reuse actually occurs on a given route is
owned by OpenCode and the provider — CacheEngine only classifies and accounts.

### Evidence and status

Verified against first-party Anthropic documentation and the OpenCode v1.18.34
source on 2026-10-04 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §6). Status:
**documented; not live-validated.** Whether
`providerOptions.openrouter.cacheControl` serializes to Anthropic-style
`cache_control` through OpenRouter is unverified.


## Google Gemini

### Policy: passive (provider-managed implicit caching)

On the **native Google Gemini Developer API and Vertex AI**, prompt caching is
**implicit** for Gemini 2.5 and newer: Google enables it automatically, there is
no request-side cache-control field, and hits are reported as
`usageMetadata.cachedContentTokenCount`. CacheEngine therefore leaves the native
Gemini request **unchanged** — it adds no cache-control field, no cache key, no
TTL, and no breakpoints.

Google's *explicit* caching is a different mechanism: it creates a separate
`CachedContent` resource (`POST /v1beta/cachedContents`) referenced from a later
`generateContent` call. That is an out-of-band resource lifecycle, not an inline
request marker, and CacheEngine **does not** create, refresh, or delete
`cachedContents` resources on any route.

The request is also left unchanged because OpenCode already handles Gemini
completely: its `applyCaching` gate excludes Gemini/Google (`@ai-sdk/google` is
not in the gate), so OpenCode adds no Gemini cache marker itself, and it
normalizes `cachedContentTokenCount` into `tokens.cache.read` with no write field.
CacheEngine adds nothing on top.

On **OpenRouter**, OpenRouter documents a *different*, gateway-specific Gemini
contract: its docs both claim implicit caching needs no setup **and** say Gemini
"requires you to insert `cache_control` breakpoints explicitly within message
content", and its endpoints API reports `supports_implicit_caching: false` while
listing cache-read pricing. A live probe of `google/gemini-2.5-flash-lite:flex`
(2026-10-05) was **inconclusive**: unmarked repeated prefixes never produced cache
reads, the documented block-level `cache_control` was honored only inconsistently
across runs, and a `session_id` present from the first request coincided with no
caching; the upstream endpoint is not observable (the response exposes only
`provider: "Google"`). Because OpenCode's V1 `chat.params` hook exposes only
top-level provider options and cannot place the documented **block-level**
`cache_control` with guaranteed serialization, CacheEngine **does not implement**
an OpenRouter Gemini overlay and adds no `session_id`/`x-session-id` affinity. See
`docs/research-findings.md` RF-OR-003 and RF-OR-004.

**Recognized ids** (bare, `google/`-prefixed, or Vertex): `gemini-2.5-*`,
`gemini-3.*`, and the aliases `gemini-flash-latest` / `gemini-flash-lite-latest`.

**Not recognized (neutral):** Gemma (`gemma-*`), pre-2.5 generations
(`gemini-2.0-*`, `gemini-1.5-*`), `gemini-embedding-*`, `gemini-pro-latest` (not
documented by Google nor in the OpenCode catalog), and look-alikes such as
`mygemini-2.5` / `gemini-2.5foo`.

### Routes

All Gemini routes are passive for CacheEngine:

| Route | Gemini caching | Notes |
| ----- | -------------- | ----- |
| Direct Google Gemini API (`google`, `@ai-sdk/google`) | provider-managed implicit (2.5+) | no request field; OpenCode adds none |
| Google Vertex AI (`google-vertex`, `@ai-sdk/google-vertex`) | provider-managed implicit (2.5+) | per-family minimums differ |
| OpenCode Zen (`opencode`) | provider-managed implicit (2.5+) | Gemini via `@ai-sdk/google`; Cached Read priced, no Cached Write |
| OpenCode Go (`opencode-go`) | not applicable | exposes no Gemini models in 1.18.34 |
| OpenRouter → Gemini | gateway-specific: docs claim implicit caching **and** explicit `cache_control` breakpoints (self-contradictory); live probe of `google/gemini-2.5-flash-lite:flex` was inconclusive | CacheEngine stays passive: no breakpoint, no affinity (RF-OR-003, RF-OR-004) |
| Gemini Code Assist (subscription) | unknown / passive | consumer access discontinued 2026-06-18; Standard/Enterprise expose no documented cache-control semantics |

CacheEngine performs no mutation on any of these routes, so it cannot make an
incompatible endpoint reject a request. Whether cache reuse actually occurs is
owned by OpenCode and the provider — CacheEngine only classifies and accounts.

### Usage accounting

Native Gemini reports cached reads only: OpenCode normalizes
`usageMetadata.cachedContentTokenCount` → `tokens.cache.read`, and there is no
native Gemini cache-write field, so CacheEngine never fabricates one. On the
OpenRouter route the transport may expose both `cached_tokens` and
`cache_write_tokens` (RF-OR-004); CacheEngine records only what OpenCode reports,
and the generic `read/(read+write)` ratio applies to whatever OpenCode provides.

### Evidence and status

Verified against first-party Google and OpenRouter documentation, the OpenCode
v1.18.34 source, and the installed OpenCode Go/Zen catalogs on 2026-10-05 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §7 and
`docs/research-findings.md` RF-OC-010, RF-OC-011, RF-OR-003, RF-OR-004,
RF-PRV-004, RF-PRV-005). The native Google/Vertex and Zen/Go routes remain
**documented but not live-validated**. A direct live probe of the OpenRouter route
(`google/gemini-2.5-flash-lite:flex`, 2026-10-05) was **inconclusive**: unmarked
repeated prefixes never produced cache reads, the documented block-level
`cache_control` was honored only inconsistently across runs, and a `session_id`
from the first request coincided with no caching; the upstream endpoint is not
observable. Direct Google vs Vertex implicit minimum-token tables disagree, and
OpenRouter's Gemini caching guidance is internally inconsistent — which is why
CacheEngine remains passive on every Gemini route.


## Alibaba Qwen (Qwen3.x / Max / Plus / Flash / Coder / VL)

### Policy: passive (provider-managed implicit caching)

Alibaba Model Studio / DashScope enables **implicit** prefix caching automatically
for Qwen; it cannot be disabled, has a ~1,024-token minimum, and reports hits as
`prompt_tokens_details.cached_tokens` (OpenAI-compatible) or
`cache_read_input_tokens` (Anthropic-compatible). CacheEngine leaves the Qwen
request **unchanged** on every route — it adds no cache-control field, no cache
key, no TTL, and no breakpoints.

Alibaba also documents an **explicit** marker
(`cache_control:{type:"ephemeral"}`) inside a message content block (1,024-token
minimum, 5-minute TTL, ≤4 markers). CacheEngine does **not** place it: the V1
`chat.params` hook exposes only top-level provider options and cannot reach
content blocks, and OpenCode already applies Anthropic-style breakpoints on the
Qwen **Messages** routes (`@ai-sdk/anthropic`), so adding one would duplicate or
replace OpenCode's breakpoints.

**Recognized ids** (bare, `qwen/`-prefixed, or gateway): the `qwen-<family>`
aliases (`qwen-max`, `qwen-plus`, `qwen-flash`, `qwen-turbo`, `qwen-plus-latest`)
and version-typed ids (`qwen3-max`, `qwen3.8-max`, `qwen3.7-plus`, `qwen3.6-plus`,
`qwen3.5-flash`, `qwen3-coder-plus`, `qwen3-vl-plus`, `qwen3.8-omni-flash`, …).

**Not recognized (neutral):** embeddings and rerankers (`qwen3-embedding-*`,
`qwen3-reranker`), malformed versions (`qwen3.5.1`, `qwen3.5foo`), bare `qwen`,
and look-alikes such as `myqwen-max` / `qwenx-3`.

### Routes

All Qwen routes are passive for CacheEngine:

| Route | Qwen caching | Notes |
| ----- | ------------ | ----- |
| Alibaba Model Studio / DashScope (intl + CN, OpenAI-compatible) | provider-managed implicit | no request field; CacheEngine adds none |
| Alibaba Anthropic-compatible | implicit; explicit top-level `cache_control` supported | CacheEngine adds none |
| Alibaba Coding Plan (intl + CN) | undocumented → passive/unknown | subscription/billing route |
| Alibaba Token Plan | undocumented → passive/unknown | subscription/billing route |
| OpenCode Go (`opencode-go`) | OpenCode applies Anthropic-style breakpoints (`@ai-sdk/anthropic`) | CacheEngine must not duplicate |
| OpenCode Zen (`opencode`) | Messages routes → OpenCode breakpoints; `qwen3.8-max` is OpenAI-compatible → provider implicit | mixed transport, all passive |
| OpenRouter → Qwen | explicit block `cache_control` documented; endpoint metadata contradicts the docs | CacheEngine stays passive (V1 hook cannot place block markers); no affinity |
| Qwen OAuth (legacy) | discontinued 2026-04-15 | not implemented |

### Usage accounting

OpenCode normalizes the provider's cache fields into `tokens.cache.read` /
`tokens.cache.write`; the generic `read/(read+write)` ratio applies. Implicit
caching reports reads only (no distinct write field); explicit caching on the
Anthropic-compatible route reports `cache_creation_input_tokens` as the write.
CacheEngine never fabricates a write.

### Evidence and status

Verified against first-party Alibaba Model Studio / QwenCloud documentation, the
OpenRouter prompt-caching docs and endpoint metadata, and the OpenCode v1.18.34
source/catalogs on 2026-10-05 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §8 and
`docs/research-findings.md` RF-PRV-006, RF-OC-008, RF-OC-011, RF-OC-012,
RF-OR-005). No live Qwen probe
was performed: every route is provider-managed implicit or OpenCode-managed, and
the explicit marker cannot be placed through the V1 hook, so there is no
implementation decision a live probe would change.


## xAI Grok (Grok-4.x language models)

### Policy: passive (provider-managed automatic caching)

xAI's Prompt Caching is **automatic** on all `grok` language models: consecutive
requests that share the same starting messages reuse the cached prefix, entries
are server-local and best-effort (evictable under load/restart), and xAI reports
hits as cached reads only. There is **no** explicit cache-breakpoint mechanism,
**no** documented TTL, and **no** documented minimum. CacheEngine leaves the Grok
request **unchanged** on every route — no cache key, no affinity header, no TTL,
no breakpoints, and no prompt rewriting.

**Affinity is route-specific and, for direct xAI, harness-owned.** xAI documents
Chat Completions `x-grok-conv-id` and Responses `prompt_cache_key` as optional
"best-effort sticky routing" hints. In OpenCode 1.18.34, direct xAI
(`providerID: xai`, `@ai-sdk/xai`) is driven through the **Responses API**, and
OpenCode itself sets `providerOptions.xai.promptCacheKey = sessionID`, which
`@ai-sdk/xai` serializes to the wire `prompt_cache_key`. CacheEngine therefore
**preserves** that stable conversation affinity rather than overwriting it. The
Chat Completions header path is not reachable in this runtime, so it is not
implemented.

**Recognized ids** (bare, `xai/`- or `x-ai/`-prefixed, or gateway): version-typed
`grok-<major>[.<minor>]` (`grok-4`, `grok-4.7`, `grok-4.3`,
`grok-4.20-0309-reasoning`, `grok-4.7-latest`, …) and the generative aliases
`grok-build-0.1` and `grok-code`.

**Not recognized (neutral):** non-language products (`grok-imagine-image`,
`grok-imagine-video`, `grok-voice-*`, audio/TTS), embeddings, malformed ids
(`grok-4..7`, `grok-4foo`, bare `grok`), and look-alikes such as `mygrok-4` /
`grokster-4`.

### Routes

All Grok routes are passive for CacheEngine:

| Route | Grok caching | Notes |
| ----- | ------------ | ----- |
| Direct xAI (API key or SuperGrok / X Premium) | automatic; affinity `prompt_cache_key` on Responses | OpenCode supplies the key; CacheEngine preserves it. Auth method is not a policy distinction |
| Direct xAI Chat Completions | automatic; affinity `x-grok-conv-id` | xAI labels this endpoint legacy/deprecated; not reachable in OpenCode 1.18.34 (xai always uses Responses) |
| OpenCode Go | Go routing uses `x-opencode-session` | not direct xAI; CacheEngine sends no xAI header/key and does not duplicate the Go session header |
| OpenCode Zen | OpenCode-owned | not direct xAI |
| OpenRouter → Grok | automated caching (writes no-cost, reads 0.25× input); OpenRouter sticky routing | no xAI-specific field and no `x-session-id`; no Grok affinity policy |
| Generic OpenAI-compatible gateway | unknown | passive (fail closed): provider identity not verified as direct xAI |

### Usage accounting

xAI reports cached reads only (`prompt_tokens_details.cached_tokens` on Chat
Completions, `input_tokens_details.cached_tokens` on Responses); OpenCode
normalizes these into `tokens.cache.read`. There is no cache-write field, so the
generic `read/(read+write)` ratio applies with `write = 0`, and CacheEngine never
fabricates a write.

### Evidence and status

Verified against first-party xAI prompt-caching documentation (2026-10-06) and
the OpenCode 1.18.34 runtime (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §8b and
`docs/research-findings.md` RF-PRV-007, RF-OC-013). No live xAI probe was
performed: the direct route is harness-managed and CacheEngine performs no
mutation, so a live probe would not change the implementation.


## Meta Muse (Muse Spark 1.3 / 1.2 / 1.1)

### Policy: passive (provider-managed automatic positional prefix caching)

Meta Model API caches the **stable prefix automatically** — no flag, key, or
breakpoint. It is **positional prefix** matching from the start of the tokenized
prompt: system/instructions, few-shot examples, conversation history, and tool
definitions participate, and editing or reordering earlier content (for example
the system prompt) breaks the prefix. Cache entries are backend-local and
best-effort. CacheEngine leaves the Muse request **unchanged** on every route —
no cache key, no retention value, no cache-control field, and no prompt rewriting.

**Two optional request inputs exist, and both stay harness/user-owned:**

- **`prompt_cache_key`** — a routing/affinity hint on **both Chat Completions and
  Responses**. Meta requires it to be an **application-stable** value (for example
  an application or use-case name) and explicitly **not** a per-user or
  per-session value, because unique keys lower hit rates. CacheEngine therefore
  never synthesizes one. On direct Meta (and Zen/Go) OpenCode already sets
  `promptCacheKey` to the session id; CacheEngine preserves it rather than
  overwriting.
- **`prompt_cache_retention`** — Responses field with `"in_memory"` (default) and
  `"24h"`. It is a **best-effort hint** with memory/privacy implications, so
  CacheEngine does not set it (and OpenCode exposes no control for it).

**Recognized ids** (bare, `meta/`-prefixed, or gateway): `muse-spark-<version>`
with optional `-contributor` / `-free` suffixes — `muse-spark-1.3`,
`muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.1`, ….

**Not recognized (neutral):** the open-weight `muse-glimmer-*` family (not served
on the Meta Model API), image/video/voice products, lookalikes
(`my-muse-spark-1.3`, `museum`), and malformed ids.

### Routes

All Muse routes are passive for CacheEngine:

| Route | Cache mechanism | Notes |
| ----- | --------------- | ----- |
| Direct Meta Chat Completions / Responses | automatic; optional `prompt_cache_key` / `prompt_cache_retention` | OpenCode pre-sets `promptCacheKey = sessionID`; CacheEngine preserves it |
| OpenCode Go (`/zen/go/v1/responses`, `@ai-sdk/openai`) | OpenCode-owned routing; `x-opencode-session` | not direct Meta; CacheEngine does not duplicate the Go session header |
| OpenCode Zen (`/zen/v1/responses`, `@ai-sdk/openai`) | OpenCode-owned | not direct Meta |
| OpenRouter (`meta/muse-spark-*`) | OpenRouter sticky routing; `supports_implicit_caching:false`; `prompt_cache_key` not in `supported_parameters` | passive; no `x-session-id` injection |
| Generic OpenAI-compatible gateway | unknown | passive (fail closed) |

### Usage accounting

Meta reports cached reads only (`prompt_tokens_details.cached_tokens` on Chat
Completions, `input_tokens_details.cached_tokens` on Responses,
`cache_read_input_tokens` on Messages); OpenCode normalizes these into
`tokens.cache.read`. There is no cache-write field, so the generic
`read/(read+write)` ratio applies with `write = 0`, and CacheEngine never
fabricates a write.

### Evidence and status

Verified against first-party Meta Model API documentation and the OpenCode 1.18.34
runtime on 2026-10-06 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §8c and
`docs/research-findings.md` RF-PRV-008, RF-OC-014). No live Meta probe was
performed: the route is provider-managed and CacheEngine performs no mutation, so
a live probe would not change the implementation.


## MiniMax (M3 / M2.7 / M2.5 / M2.1 / M2)

### Policy: passive (provider-managed caching), route-aware

MiniMax caches the **stable prefix automatically** on all M-series models, with
no configuration; matching is positional in the order "tool list → system prompts
→ user messages" and applies to requests with ≥512 input tokens (a **cacheability
threshold**, distinct from the models' own context/pricing tiers, such as M3's
1M-token context). M2.x additionally supports **explicit** Anthropic-style
`cache_control:{type:"ephemeral"}` breakpoints (≤4, 5-minute TTL refreshed on hit)
on the Anthropic-compatible endpoint — **M3 does not**, and M3 has no documented
cache-write charge while M2.x explicit writes are billed. CacheEngine leaves the
request **unchanged** on every route; it injects no `cache_control`, no
`prompt_cache_key`, and no cache field, and rewrites nothing.

**Route and subscription spread matter.** Direct MiniMax (`minimax`, `minimax-cn`)
and the **MiniMax Token Plan** providers (`minimax-coding-plan`,
`minimax-cn-coding-plan`; an `sk-cp-…` subscription key on the same direct
`/anthropic/v1` endpoints) use the Anthropic-compatible Messages API via
`@ai-sdk/anthropic`, so **OpenCode itself inserts the `cache_control` breakpoints**
— CacheEngine must not duplicate them, and Token Plan is **not** a separate cache
provider. OpenCode **Go** serves MiniMax M3 and M2.7 over `/zen/go/v1/messages`
(`@ai-sdk/anthropic`) and adds its own `x-opencode-session`; OpenCode **Zen**
serves MiniMax M3, M2.7, and M2.5 over `/zen/v1/chat/completions`
(`@ai-sdk/openai-compatible`), which gets passive-only caching. OpenRouter exposes
MiniMax over Chat Completions with no documented cache control.

**Recognized ids** (bare, `MiniMaxAI/`- / `minimax/`-prefixed, or gateway):
`minimax-m<2|3>` with optional version/`-highspeed`/`-lightning`/`-turbo`/
`-flash-preview`/`-her` suffixes — `MiniMax-M3`, `MiniMax-M3.1-Flash-Preview`,
`MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.1`, ….

**Not recognized (neutral):** other/older MiniMax families (`minimax-text-01`,
`minimax-m1`, `minimax-01`), video/utility products (`minimax-h3`), lookalikes
(`my-minimax-m3`), and malformed ids.

### Routes

All MiniMax routes are passive for CacheEngine:

| Route | SDK | Cache mechanism | Notes |
| ----- | --- | --------------- | ----- |
| Direct MiniMax + MiniMax Token Plan (`minimax*`, `/anthropic/v1/messages`) | `@ai-sdk/anthropic` | automatic + explicit `cache_control` (M2.x) | OpenCode owns the breakpoints; CacheEngine preserves |
| OpenCode Go (`/zen/go/v1/messages`; M3, M2.7) | `@ai-sdk/anthropic` | automatic + OpenCode breakpoints; subscription | Go owns `x-opencode-session`; CacheEngine does not duplicate it |
| OpenCode Zen (`/zen/v1/chat/completions`; M3, M2.7, M2.5) | `@ai-sdk/openai-compatible` | automatic only | passive |
| OpenRouter (`minimax/minimax-*`) | `@openrouter/ai-sdk-provider` | sticky routing; `supports_implicit_caching:false`; no cache param | no `x-session-id`, no MiniMax field |
| Generic OpenAI-compatible gateway | unknown | unknown | passive (fail closed) |

### Usage accounting

MiniMax reports cached reads via `usage.prompt_tokens_details.cached_tokens`
(Chat Completions) or `usage.input_tokens_details.cached_tokens` (Responses), and
on the Anthropic-compatible endpoint `usage.cache_read_input_tokens` plus
`usage.cache_creation_input_tokens` (write). OpenCode normalizes these into
`tokens.cache.read` / `tokens.cache.write`; CacheEngine uses the generic
`read/(read+write)` accounting and never fabricates a write.

### Evidence and status

Verified against first-party MiniMax documentation and the OpenCode 1.18.34
runtime on 2026-10-07 (see
[docs/cache-policy-inventory.md](docs/cache-policy-inventory.md) §8d and
`docs/research-findings.md` RF-PRV-009, RF-OC-015). No live MiniMax probe was
performed: the route is provider-managed and CacheEngine performs no mutation, so
a live probe would not change the implementation.


# Provider comparison

| Policy family | Detection | Prompt text changed? | Cache metadata changed? | OpenRouter affinity header | Primary cache signal |
| ------------- | --------- | ------------------- | ----------------------- | -------------------------- | -------------------- |
| DeepSeek | `deepseek` (V4-and-later family + passive fallback) | No | No | None | provider `cache.read` / `cache.write` |
| GPT-5.6 and later | version boundary `gpt-<major>[.<minor>] ≥ 5.6` on OpenAI-ish endpoints (includes GPT-6) | No | Yes: `prompt_cache_key` + options | None | provider cache tokens |
| GLM-5.3 and later | `glm-5.3+` | Yes, narrowly (`<env>` tail) on GLM-5.3 only | No provider cache key | `x-session-id` on OpenRouter only | provider cache tokens (GLM ratio) |
| MiMo V2.6 and later | `mimo-v2.6+` (family) | Yes, narrowly (`<env>` tail) on V2.6 Flash/Pro only | No: implicit caching only | `x-session-id` on OpenRouter only | `cached_tokens / prompt_tokens` |
| Kimi K2.6 / K2.7-code / K3 | `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code(-highspeed)` (bare or gateway-prefixed) | No | No: implicit caching only | None | provider `cache.read` / `cache.write` |
| Claude (Anthropic) | `claude-{opus,sonnet,haiku,fable,mythos}-*`, legacy `claude-3-*` (bare or gateway-prefixed) | No | No: OpenCode applies `cache_control` breakpoints | None | provider `cache.read` / `cache.write` |
| Google Gemini | `gemini-2.5-*`, `gemini-3.*`, `gemini-flash-latest`/`gemini-flash-lite-latest` (bare, `google/`-prefixed, or Vertex) | No | No: provider-managed implicit caching | None | provider `cache.read` (no write field) |
| Alibaba Qwen | `qwen-<family>` aliases + version-typed ids (`qwen3.*`, `qwen-max`, `qwen3-coder*`, `qwen3-vl-*`, …; bare, `qwen/`-prefixed, or gateway) | No | No: provider-managed implicit caching; OpenCode applies breakpoints on Messages routes | None | provider `cache.read` / `cache.write` |
| xAI Grok | `grok-<version>` + generative aliases (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-4.20-*`, `grok-build-0.1`, `grok-code`; bare, `xai/`/`x-ai/`-prefixed, or gateway) | No | No: automatic provider-managed caching; OpenCode supplies the Responses affinity key | None | provider `cache.read` (no write field) |
| Meta Muse | `muse-spark-<version>[-contributor][-free]` (`muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`, …; bare, `meta/`-prefixed, or gateway) | No | No: automatic positional prefix caching; OpenCode supplies `prompt_cache_key` on direct Meta/Zen/Go | None | provider `cache.read` (no write field) |
| MiniMax | `minimax-m<2\|3>...` (`MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.5`, `-highspeed`; bare, `MiniMaxAI/`/`minimax/`-prefixed, or gateway) | No | No: automatic prefix caching; M2.x also explicit `cache_control`, applied by OpenCode on Anthropic-SDK routes | None | provider `cache.read` (no write on Zen/OpenRouter; `cache.write` only on the Anthropic path) |

`x-session-id` is an HTTP affinity header, not a provider cache key or
cache-control field. Non-OpenRouter endpoints do not receive CacheEngine's
OpenRouter-specific affinity value; their native cache behavior is unchanged.


# Prompt-cache strategy

The plugin uses different strategies because cache mechanisms differ by provider.
The table above summarises them; the essential point is the distinction between
*changing prompt text* and *changing cache metadata*.

This distinction is fundamental.

The plugin is **not** a generic "rewrite every prompt for caching" engine.

It is a provider-aware cache policy engine.


# System-prompt diagnostics

The plugin fingerprints the system prompt to detect structural changes between requests.

For newer provider-aware diagnostics it tracks:

* full system hash
* stable system-prefix hash
* volatile system-suffix hash

The stable/volatile decomposition is based on the longest common prefix against the session baseline.

A change in a hash means:

> The observed request bytes changed.

It does **not** mean:

> The provider definitely generated a cache miss.

This distinction is intentional. Provider-reported cache token counts are the authoritative cache signal.


# Tool-definition diagnostics

Tool definitions are normalized before fingerprinting.

Runtime-only fields such as:

* object identity
* function references
* timestamps
* arbitrary runtime metadata

are excluded.

The semantic fingerprint is order-insensitive and represents the model-visible tool definitions.

The plugin also tracks wire-order fingerprints so that it can distinguish:

```text
same tools, different ordering
```

from:

```text
different tool definitions
```

This distinction matters because semantic equality and byte-level request equality are not necessarily the same thing.

The plugin uses these fingerprints for **diagnostics only**. It does not reorder the tools to force a particular fingerprint.


# Compaction handling

OpenCode sessions eventually undergo compaction as their conversation history grows.

The plugin adds a deterministic continuation template:

```text
## Session digest (cache-stable continuation block)
- Goal:
- Decisions made:
- Pending:
- Active files:
```

The digest is inserted once per compaction operation using a guard that prevents duplicate insertion if the compaction hook fires multiple times.
The objective is to provide a deterministic continuation structure rather than generating a different arbitrary cache-affecting block on every compaction.


# Cache metrics

The plugin records cache usage from OpenCode assistant-message token data.

At minimum it tracks:

```text
cache.read
cache.write
```

and aggregates those values across the session.

The default cache ratio reported by the core helper is:

```text
hit rate = read / (read + write)
```

This is deliberately an accounting metric based on cache read/write tokens.

For GLM, the implementation additionally calculates a prompt-token ratio:

```text
cached / (cached + cache-write + input)
```

using:

```text
read / (read + write + input)
```

as implemented by `glmHitRatio()`.

For MiMo, the implementation uses the provider-documented prompt-cache ratio:

```text
cacheHitRate = cachedTokens / promptTokens
```

implemented by `mimoHitRate()`. `hitRatePct()` itself is left untouched so other
providers are unaffected.

### Important metric distinction

These ratios answer different questions.

`read / (read + write)` answers approximately:

> Of the tokens represented as cache reads/writes, how much was reused?

`read / (read + write + input)` answers:

> How much of the total prompt-token accounting was represented by cached reads?

`cachedTokens / promptTokens` (MiMo) answers:

> Of the prompt tokens the provider processed, what fraction was served from
> cache?

Do not treat these percentages as interchangeable.

---

# Telemetry

Metrics are written as JSONL.

The default location is:

```text
~/.cache/opencode/cache-metrics.jsonl
```

The default configuration path is:

```text
~/.config/opencode/cache-engine.json
```

These paths are defined by the plugin core.

Telemetry is best-effort.

A failed metrics write must never break an OpenCode request. The recorder catches write failures rather than allowing telemetry failures to affect execution.

The plugin writes these record kinds (one JSON object per line):

| `kind` | Emitted when |
| ------ | ------------ |
| `usage` | An idle session aggregated provider-reported cache tokens |
| `usage` (fields) | May carry `promptTokens`/`glmHitRate` (GLM) or `promptTokens`/`cachedTokens`/`cacheHitRate` (MiMo) in addition to the generic read/write fields |
| `prefix-observation` | First observation of a session's system/tool shape |
| `prefix-change` | A later observation differs (system and/or tools) |
| `reasoning-integrity` | GLM preserved-thinking check flags duplicate/reordered/modified reasoning |
| `cache-options` | GPT cache metadata was applied for a session |
| `boundary` | Affinity outcomes, provider switches, env relocation, compaction namespace |
| `policy-resolution` | How a model was classified (`matchCategory`, overlay applied/skipped) |
| `compaction` | A session compaction occurred |
| `telemetry-error` | A telemetry/collection operation failed (best-effort; never fatal) |

Provider-reported usage remains the authoritative cache signal; local hashes are
diagnostics only.


# Metrics examples

A usage record can contain fields such as:

```json
{
  "kind": "usage",
  "sid": "session-id",
  "ts": 1750000000000,
  "read": 120000,
  "write": 3000,
  "input": 40000,
  "messages": 3,
  "sampleHitRate": 97,
  "cumulative": {
    "read": 360000,
    "write": 9000
  },
  "cumulativeHitRate": 97,
  "cursor": "message-id",
  "provider": "z-ai",
  "model": "glm-5.3-flash",
  "policy": "glm53"
}
```

Usage is aggregated from assistant messages when a session goes idle. Messages
are read in chronological (oldest-first) order and only those newer than the
session's last-processed cursor are counted, so repeated idle events never
double-count. The cursor is backed by a `time.created` watermark, so a
compaction or revert that removes the cursor message cannot inflate the totals;
when no safe boundary is available the collector undercounts rather than
double-counts.

A prefix-change record can look like:

```json
{
  "kind": "prefix-change",
  "sid": "session-id",
  "ts": 1750000000000,
  "dimensions": [
    "system"
  ]
}
```

A compaction record can contain:

```json
{
  "kind": "compaction",
  "sid": "session-id",
  "ts": 1750000000000,
  "reason": "compaction",
  "usageSamples": 7,
  "cumulative": {
    "read": 900000,
    "write": 12000
  }
}
```

Telemetry is intended to answer questions such as:

* Did the system prompt change?
* Did the tool definitions change?
* Did cache reads increase?
* Did cache writes increase?
* Did a compaction occur?
* Which provider/model/policy was active?
* Did the GLM system stabilization actually change the observed prompt shape?
* Did MiMo's environment relocation fire (`mimo_system_env_relocated`)?
* Did MiMo's stable system prefix change (`mimo_system_prefix_changed`)?
* Was MiMo/GLM affinity eligible, and did CacheEngine add its header?
* Was affinity bypassed for a non-OpenRouter or missing provider identity?
* Did the MiMo provider change (`mimo_provider_changed`) or the GLM provider
  change (`glm_provider_changed`) within a session?
* What was MiMo's provider-reported cache hit rate (`cacheHitRate`)?
* Why was a model classified the way it was (`policy-resolution`)?
* Which newly released model is currently resolving to a range match, a creator
  baseline, or neutral, and therefore deserves review?

Affinity observations are `boundary` records. They contain provider/model
identity and booleans/source classification such as `eligible`,
`headerPresent`, `headerAttached`, and `headerSource`; they do not include the
`x-session-id` header value or full request headers.

A `policy-resolution` record (since v0.4.6) explains how a model was classified.
It is emitted once per distinct resolution per session, so a model that appears
for the first time is reported without producing per-request noise:

```json
{
  "kind": "policy-resolution",
  "sid": "session-id",
  "ts": 1750000000000,
  "matchCategory": "family",
  "matchKind": "version-range",
  "matchReason": "family-pattern:zai.glm-5.3-plus",
  "matchedId": null,
  "creator": "z.ai",
  "family": "glm-5.3",
  "policy": "glm53",
  "isNeutral": false,
  "baselineId": "zai.implicit-cache",
  "overlays": [],
  "overlayApplied": false,
  "overlaySkipped": true,
  "overlaySkippedReason": "overlay-not-validated-for-model",
  "overlaySkippedCandidates": ["glm53.env-relocation"],
  "providerIdentityKnown": true,
  "provider": "zai",
  "model": "glm-6",
  "transport": "direct"
}
```

The fields are:

| Field | Meaning |
| ----- | ------- |
| `matchCategory` | `exact-id`, `alias`, `family`, `creator`, or `neutral` |
| `matchKind` | `exact-id`, `alias`, `version-range`, `pattern`, `creator-baseline`, or `unknown` |
| `matchReason` | The registry match that produced the result |
| `policy` / `family` / `creator` | The resolved policy identity |
| `overlayApplied` | A model-specific prompt overlay actually applied to this model |
| `overlaySkippedReason` | `overlay-not-validated-for-model` (family has an overlay, this model was never validated for it) or `registry-entry-not-runtime-active` (the entry carries an overlay but its runtime is neutral) |
| `overlaySkippedCandidates` | Which overlay ids were withheld |
| `providerIdentityKnown` | Whether the provider identity was actually observed; it is never guessed |

`overlayApplied` is false whenever no overlay was applied, so a model that
resolves to an inactive registry entry is never reported as optimized. These
records contain only resolver and registry facts. They never include prompt,
system, or tool content, credentials, authorization headers, or the raw
`x-session-id` value.

A MiMo usage record adds the provider-reported cache fields:

```json
{
  "kind": "usage",
  "sid": "session-id",
  "ts": 1750000000000,
  "policy": "mimo26",
  "provider": "openrouter",
  "model": "xiaomi/mimo-v2.6-flash",
  "read": 47000,
  "input": 3000,
  "promptTokens": 50000,
  "cachedTokens": 47000,
  "cacheHitRate": 94,
  "stickySessionId": "mimo-ses-0123456789abcdef"
}
```


# Configuration

The default configuration is:

```json
{
  "enabled": true,
  "metricsFile": "~/.cache/opencode/cache-metrics.jsonl",
  "compactTemplate": true,
  "logPrefixChanges": true,
  "policies": {
    "deepseek": {
      "enabled": true
    },
    "gpt56": {
      "enabled": true,
      "promptCacheKey": true,
      "cacheRootKey": false,
      "compactionCacheIsolation": true,
      "reasoningEffortDiagnostics": true,
      "mode": "implicit",
      "ttl": "30m"
    },
    "glm53": {
      "enabled": true,
      "stabilizeSystem": true,
      "preserveThinkingIntegrity": true
    },
    "mimo26": {
      "enabled": true,
      "stabilizeSystem": true,
      "stickySession": true,
      "preserveThinkingIntegrity": true
    },
    "kimi": {
      "enabled": true
    },
    "claude": {
      "enabled": true
    },
    "gemini": {
      "enabled": true
    },
    "qwen": {
      "enabled": true
    },
    "grok": {
      "enabled": true
    },
    "muse": {
      "enabled": true
    },
    "minimax": {
      "enabled": true
    }
  }
}
```

The configuration parser starts from these defaults and applies valid file/environment overrides without mutating the caller's configuration object.


# Configuration options

## Global

### `enabled`

```json
{
  "enabled": true
}
```

Enables or disables the entire plugin.

---

### `metricsFile`

```json
{
  "metricsFile": "~/.cache/opencode/cache-metrics.jsonl"
}
```

Controls where JSONL telemetry is written.

---

### `compactTemplate`

```json
{
  "compactTemplate": true
}
```

Controls whether the deterministic compaction continuation block is inserted.

---

### `logPrefixChanges`

```json
{
  "logPrefixChanges": true
}
```

Controls warning logs for observed prefix-shape changes.


# DeepSeek configuration

```json
"deepseek": {
  "enabled": true
}
```

There are intentionally very few settings here.

DeepSeek is treated as the conservative/passive policy.


# GPT-5.6 configuration

```json
"gpt56": {
  "enabled": true,
  "promptCacheKey": true,
  "cacheRootKey": false,
  "compactionCacheIsolation": true,
  "reasoningEffortDiagnostics": true,
  "mode": "implicit",
  "ttl": "30m"
}
```

### `promptCacheKey`

Controls whether the plugin provides a stable session-derived GPT cache key.

### `cacheRootKey`

Controls whether a parent/fork cache root is used.

Disabled by default because reliable fork lineage is not currently guaranteed by the runtime.

### `compactionCacheIsolation`

Uses a separate deterministic cache namespace for compaction requests.

### `reasoningEffortDiagnostics`

Tracks GPT reasoning-effort changes for diagnostics.

### `mode`

Defaults to:

```text
implicit
```

### `ttl`

Defaults to:

```text
30m
```

Existing request options are not overwritten by the plugin.

The established **272K pricing boundary** is controlled by user/harness-side
configuration and remains unchanged. CacheEngine does not set or raise GPT
context or output limits; apply the existing harness/user-side limits.


# GLM-5.3 configuration

```json
"glm53": {
  "enabled": true,
  "stabilizeSystem": true,
  "preserveThinkingIntegrity": true
}
```

### `stabilizeSystem`

Enables relocation of the volatile `<env>` section to the system-prompt tail.

### `preserveThinkingIntegrity`

Enables diagnostic checks around reasoning continuity.

The reasoning instrumentation is intended to identify anomalies such as:

* duplicate reasoning
* reordered reasoning
* modified reasoning

It is diagnostic rather than a reason to rewrite or fabricate reasoning content. The implementation maps these conditions to explicit diagnostic reasons.


# MiMo-V2.6 configuration

```json
{
  "mimo26": {
    "enabled": true,
    "stabilizeSystem": true,
    "stickySession": true,
    "preserveThinkingIntegrity": true
  }
}
```

### `enabled`

Enables the MiMo-V2.6 policy.

### `stabilizeSystem`

Enables relocation of the volatile `<env>` section to the system-prompt tail
(same narrow, content-preserving transformation as GLM-5.3).

### `stickySession`

Controls whether MiMo usage/provider-change telemetry includes the derived
`stickySessionId` field. It does not control the existing `x-session-id` header
injection, which is gated by MiMo family plus actual `openrouter` provider
identity. The telemetry field contains the derived identifier, not request
headers or prompt data.

### `preserveThinkingIntegrity`

Enables reasoning diagnostics as instrumentation. It never rewrites, duplicates,
reorders, or re-injects reasoning content, and it is not a cache requirement.

No `cacheBlockSize`, `cacheTTL`, `cacheBreakpoint`, or `minimumCacheTokens`
knobs are exposed: those values are not established by authoritative V2.6
documentation.


# Kimi configuration

```json
{
  "kimi": {
    "enabled": true
  }
}
```

### `enabled`

Enables the Kimi policy classification. Kimi is a **passive** family: Moonshot's
OpenAI-compatible caching is automatic, so CacheEngine never mutates the request.
There are no other Kimi knobs, and `prompt_cache_options`, `prompt_cache_key`, and
the Anthropic-compatible `cache_control` route are neither exposed nor sent.


# Claude configuration

```json
{
  "claude": {
    "enabled": true
  }
}
```

### `enabled`

Enables the Claude policy classification. Claude is a **passive** family:
OpenCode applies Anthropic `cache_control` breakpoints itself, so CacheEngine never
mutates the request. There are no other Claude knobs, and `cache_control`,
`cacheControl`, cache keys, and TTLs are neither exposed nor sent.

---

# Gemini configuration

```json
{
  "gemini": {
    "enabled": true
  }
}
```

### `enabled`

Enables the Google Gemini policy classification. Gemini is a **passive** family:
Google's implicit caching for Gemini 2.5+ is provider-managed and OpenCode's
`applyCaching` gate excludes Gemini, so CacheEngine never mutates the request and
never creates `CachedContent` resources. There are no other Gemini knobs, and
cache keys, TTLs, and cache-control fields are neither exposed nor sent.


# Qwen configuration

```json
{
  "qwen": {
    "enabled": true
  }
}
```

### `enabled`

Enables the Alibaba/Qwen policy classification. Qwen is a **passive** family on
every route: Alibaba/DashScope implicit caching is provider-managed, OpenCode
already applies Anthropic-style breakpoints on the Qwen Messages routes
(`@ai-sdk/anthropic`), and the V1 hook cannot place the documented block-level
marker on the others. CacheEngine never mutates the Qwen request. There are no
other Qwen knobs, and cache keys, TTLs, and cache-control fields are neither
exposed nor sent.


# Grok configuration

```json
{
  "grok": {
    "enabled": true
  }
}
```

### `enabled`

Enables the xAI/Grok policy classification. Grok is a **passive** family on every
route: caching is automatic and provider-managed, and on the direct xAI Responses
route OpenCode itself supplies the stable conversation affinity key, so
CacheEngine never mutates the Grok request. There are no other Grok knobs, and
cache keys, TTLs, affinity headers, and cache-control fields are neither exposed
nor sent.


# Muse configuration

```json
{
  "muse": {
    "enabled": true
  }
}
```

### `enabled`

Enables the Meta/Muse policy classification. Muse is a **passive** family on every
route: caching is automatic positional prefix caching, Meta requires
`prompt_cache_key` to be application-stable (never per-session), and
`prompt_cache_retention` is a request-level policy. CacheEngine never mutates the
Muse request, and there are no other Muse knobs: cache keys, retention values,
affinity headers, and cache-control fields are neither exposed nor sent.


# MiniMax configuration

```json
{
  "minimax": {
    "enabled": true
  }
}
```

### `enabled`

Enables the MiniMax policy classification. MiniMax is a **passive** family on
every route: caching is automatic, and on the Anthropic-compatible routes OpenCode
already inserts the `cache_control` breakpoints (M2.x; M3 does not support them),
so CacheEngine never mutates the MiniMax request. There are no other MiniMax
knobs: cache keys, cache-control fields, and affinity headers are neither exposed
nor sent.


# Model detection

The plugin classifies requests into:

```text
deepseek
gpt56
glm53
mimo26
kimi
claude
gemini
qwen
neutral
```

The model detector recognizes:

* DeepSeek model/provider identifiers
* GPT-5.6-and-later variants
* GLM-5.3-and-later variants
* MiMo V2.6-and-later family (`mimo-v2.6-flash`, `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`, ...)
* Kimi current ids (`kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`; bare or gateway-prefixed)
* Claude current ids (`claude-opus-*`, `claude-sonnet-*`, `claude-haiku-*`, `claude-fable-*`, `claude-mythos-*`, legacy `claude-3-*`; bare or gateway-prefixed)
* Gemini 2.5-and-later ids (`gemini-2.5-*`, `gemini-3.*`, `gemini-flash-latest`, `gemini-flash-lite-latest`; bare, `google/`-prefixed, or Vertex)
* Alibaba/Qwen ids (`qwen-max`, `qwen-plus`, `qwen-flash`, `qwen-turbo`, `qwen3.*`, `qwen3-coder-*`, `qwen3-vl-*`, ...; bare, `qwen/`-prefixed, or gateway)

The GPT-5.6-and-later family has an additional OpenAI/Azure-context check, so a string containing a qualifying GPT version (for example `gpt-5.6` or `gpt-6`) does not automatically cause GPT-specific fields to be sent to an unrelated endpoint.

MiMo detection keeps the documented V2.6 ids and covers future generations after
V2.6; it excludes `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2`, and undocumented V2.6
variants such as `mimo-v2.6-flashx`.

Unknown models use the neutral policy.

Neutral means:

```text
no provider-specific request mutation
```


# OpenRouter usage

This plugin is compatible with OpenRouter because the cache policy is based on the model/provider signals available to OpenCode.

For cache-sensitive workloads, provider stability remains important.

The plugin does not attempt to compensate for provider switching by rewriting
prompts. For MiMo and GLM it records observed provider identity and provider
changes so routing instability is observable; it never overrides the selected
provider or inspects OpenRouter's hidden upstream provider selection.

For that reason, a stable provider route is preferable when your goal is to measure and maximize prefix reuse.


# Architecture

The implementation is split across a hook entry point, a pure logic core, and a
pure policy registry.

## `cache-engine.ts`

This is the OpenCode plugin entry point.

It owns:

* OpenCode hooks
* session state
* provider-policy selection
* telemetry integration
* request mutation
* system-prompt transformation
* compaction handling

The exported plugin is:

```ts
export const CacheEngine: Plugin = async ({ client, directory }) => {
  // ...
}
```

`CacheEngine` is the exported plugin factory. The npm package name remains
`opencode-cache-engine`; the server and TUI package exports are listed in
[File layout](#file-layout).

---

## `cache-engine-core.mjs`

This contains dependency-light pure logic.

It owns:

* the legacy `detectPolicy()` compatibility wrapper (delegating to the registry)
* configuration parsing
* canonicalization
* tool fingerprints
* system-shape decomposition
* GPT cache-key generation
* cache-option generation
* GLM environment relocation
* reasoning diagnostics
* cache-identity helpers (`stableSessionIdFor`, `mimoSessionIdFor`, `gptCacheKeyFor`)
* compaction guards

Keeping these functions in plain JavaScript allows the logic to be tested independently with Node's built-in test runner. Usage/accounting primitives are re-exported from `cache-usage-core.mjs` so callers keep a single import.

---

## `cache-usage-core.mjs`

The runtime-independent usage/accounting module (v0.6.x core consolidation). It
has no OpenCode client, hook, routing, or V2 dependency (only `node:crypto`), so
the same normalized accounting can be reused by a future adapter without pulling
in the provider registry.

It owns:

* `shorthash` — the shared 16-hex-char digest used for fingerprints/diagnostics
* `hitRatePct` / `glmHitRatio` / `mimoHitRate` — the provider-specific cache ratios
* `shouldAggregate` — the "only emit a usage record when a cache token was actually observed" guard
* `scanPage` / `nextProcessedCursor` — chronological message scanning and the id/`time.created` cursor
* `reasoningHashesFor` (internal) — reasoning-block hashes for the GLM integrity diagnostics

It never mutates requests and never fabricates usage: a cache read is the
provider-reported read, a cache write is the provider-reported write, and a read
never implies a write.

---

## `cache-policy-core.mjs`

This is the pure policy registry and resolver. It separates cache policy from
request mutation:

* creator / family classification
* baseline cache-policy descriptors (documented facts)
* model-specific overlays (for example GLM/MiMo `<env>` relocation)
* transport capabilities (for example OpenRouter `x-session-id` affinity)
* inventory-traceable family boundaries (a documented version range or an
  explicit baseline/overlay registration, never an implicit "newer model inherits")
* safe neutral fallback for unknown or future models

`resolvePolicy(model)` returns `creator`, `family`, `baseline`, `overlays`,
`transport`, `matchType`, and `matchReason`. `resolveRuntimePolicy(model)`
returns the runtime-facing descriptor the hooks consume: the legacy policy
string plus explicit capability flags.

Only registry entries marked `legacy` enable runtime behavior; documented but
non-legacy aliases (for example `gpt-daybreak-blue-latest`) and all unknown
models resolve to a neutral runtime. A newer or unknown model therefore never
inherits a current model's mutation unless the registry explicitly registers it.
The GPT family is a documented exception in the sense that its boundary is
version-based (`GPT-5.6 and later`), so GPT-6 and future 5.6+/6+/7+ versions are
covered by the registered boundary rather than by an exact-model list.

Transport is kept separate from cache policy: OpenRouter affinity is a transport
capability, not part of a creator's cache semantics. Overlays are also explicit,
so being classified into a family does not by itself enable a prompt
transformation.

The module is pure: no network calls and no runtime documentation lookups. The
legacy `detectPolicy()` in `cache-engine-core.mjs` remains a thin compatibility
wrapper over the resolver's legacy path.

### Unknown and future models

`explainPolicyResolution(model)` (since v0.4.6) is a pure, total function that
explains why a model resolved the way it did. It never throws, and it is the
source of the `policy-resolution` telemetry record described under
[Telemetry](#telemetry).

Detection is never a "highest numeric version wins" rule. A future or unknown
model resolves as follows:

| Case | Result |
| ---- | ------ |
| Unknown OpenAI model at 5.6 or later, on an OpenAI/Azure-compatible endpoint | Inherits the documented `GPT-5.6 and later` baseline and cache metadata, because a registry entry registers that version range |
| Same model id on a non-OpenAI endpoint | Neutral. GPT-specific options are never guessed outside an OpenAI context |
| Unknown DeepSeek model | Passive. Baseline telemetry only; no cache-control field is invented |
| Unknown GLM model at 5.3 or later | Family baseline only. The `<env>` relocation overlay is not applied unless the model is validated for it |
| Unknown MiMo model after V2.6 | Family baseline only. The `<env>` relocation overlay is not applied unless the model is validated for it |
| Unknown Kimi model after V2.6 | Family baseline only; Moonshot caching is automatic, so no overlay is registered |
| Unknown Claude model after the current families | Family baseline only; OpenCode applies Anthropic `cache_control` itself, so CacheEngine mutates nothing |
| Unknown Qwen model (`qwen-*` / `qwen3.*`) | Family baseline only; Alibaba caching is provider-managed implicit and no overlay is registered |
| Unknown creator or provider | Fully neutral. No guessed cache controls, and no OpenRouter-specific header unless the actual provider identity is `openrouter` and the family is already eligible |

Two rules follow from this. A model-specific prompt transformation always
requires an explicit registry entry that names the overlay, so being classified
into a family never enables a rewrite on its own. And every resolution is
reported, so a newly released model becomes visible for review instead of
silently inheriting or silently missing behavior.

---

## Tests

The repository's test suite validates the provider-independent and provider-specific logic.

Coverage includes:

* model detection
* policy registry resolution and runtime-policy equivalence
* GPT cache-key stability
* GPT cache-option defaults
* protection against overwriting existing cache options
* GLM environment relocation
* deterministic hashing
* system-prefix decomposition
* tool fingerprints
* reasoning diagnostics
* compaction isolation
* cache-hit calculations
* unknown and future model resolution, using synthetic identifiers
* policy-match telemetry classification and content safety
* chronological usage-cursor aggregation and compaction-safe (watermark) accounting
* configuration behavior
* JSONL telemetry behavior
* Kimi classification, passive (no-mutation) resolution, and generic usage accounting
* Claude classification, passive (no-mutation) resolution, and generic usage accounting
* Gemini classification, passive (no-mutation) resolution, and generic usage accounting
* Qwen classification, matcher boundaries, passive (no-mutation) route resolution, and generic usage accounting

The tests are designed around the pure core logic, while OpenCode runtime behavior is validated separately through actual plugin loading.

---

# Design principles

## 1. Provider-specific behavior

Different providers expose different cache mechanisms.

The plugin therefore does not assume that one strategy is optimal everywhere.

---

## 2. Preserve working behavior

The plugin should not modify a provider's request merely because a mutation is technically possible.

This is especially important for DeepSeek, where the current policy is intentionally passive.

---

## 3. Measure provider reality

Local hashes are diagnostics.

Provider-reported cache token counts are the authoritative signal.

The implementation explicitly distinguishes:

```text
observed prefix change
```

from:

```text
confirmed provider cache miss
```

because the plugin cannot infer the latter reliably from local prompt hashes alone.

---

## 4. Never overwrite explicit provider configuration

Where GPT cache options already exist, the plugin leaves them alone.

This allows the runtime or user configuration to remain authoritative.

---

## 5. Keep mutations deterministic

When the plugin does transform the request, the transformation should be:

* narrow
* deterministic
* content-preserving where possible
* provider-specific
* easy to disable

The GLM environment relocation follows these rules.

---

## 6. Keep telemetry out of the critical path

A metrics failure must not break model execution.

Telemetry is therefore best-effort.

---

# What the plugin does NOT do

The plugin does not:

* invent cache hits
* claim a local hash proves a provider cache hit
* rewrite DeepSeek prompts
* reorder tools
* fabricate reasoning
* modify conversation history arbitrarily
* force explicit GPT cache breakpoints by default
* silently overwrite existing GPT cache options
* assume every model named `gpt-5.6` is an OpenAI-compatible endpoint
* use fork inheritance unless reliable lineage is available

---

# Cost optimization philosophy

Cache hit rate is useful, but it is not the only cost metric.

The economic objective is:

```text
total task cost
=
prompt/cache cost
+
output/reasoning cost
+
additional requests
```

A model with a slightly lower cache hit rate can still be cheaper if it completes the task with fewer tokens or fewer model calls.

For that reason, this plugin is primarily an **instrumentation + targeted optimization layer**, not a cache-rate maximizer at any cost.

The recommended evaluation unit is:

```text
cost per completed task
```

rather than:

```text
cache percentage alone
```

---

# Operational recommendations

For reliable cache measurements:

1. Keep the provider fixed whenever possible.
2. Avoid changing unrelated system-prompt content during a benchmark.
3. Keep tool definitions stable.
4. Compare equivalent tasks across models.
5. Record actual provider cache token counts.
6. Compare total task cost, not only cache percentage.
7. Treat compaction as a separate cache boundary when analyzing results.
8. Avoid interpreting a local prefix hash change as definitive proof of a cache miss.

---

# File layout

This Git repository is the canonical development source. The npm package is
built from this tree and exposes the runtime entry points separately:

```text
opencode-cache-engine/
├── src/
│   ├── cache-engine.ts
│   ├── cache-engine-core.mjs
│   ├── cache-policy-core.mjs
│   └── tui.mjs
├── test/
│   └── cache-engine.test.mjs
├── examples/
│   └── cache-engine.json
├── docs/
│   └── cache-policy-inventory.md
├── package.json
├── README.md
└── LICENSE
```

The package exports in `package.json` are:

```json
{
  "./server": "./src/cache-engine.ts",
  "./tui": "./src/tui.mjs"
}
```

The server target owns all CacheEngine runtime hooks and request behavior. The
TUI target only registers the package with OpenCode's plugin manager; it does
not duplicate server logic.

---

# Installation

### Local development

Develop against this repository/package checkout using the project's OpenCode
plugin development path. Edit and test the Git working tree as the source of
truth; do not copy the plugin into `~/.config/opencode/plugins/` or keep a
second active source tree there.

### Released package

OpenCode loads the server and TUI targets from the npm package's separate
exports. For reproducible released installs, pin an exact version. For this
release, use:

```json
{
  "plugin": [
    "opencode-cache-engine@0.6.0"
  ]
}
```

Avoid a bare package name that resolves a moving `@latest` version when
reproducibility matters. Update the pinned version deliberately when upgrading.

After installation, verify that OpenCode loads the plugin successfully before
benchmarking cache behavior.

---

# Validation

The core test suite can be run with Node:

```bash
node --test test/cache-engine.test.mjs
```

The tests are intentionally dependency-light and exercise the pure logic independently of the OpenCode runtime.

Runtime validation should additionally confirm:

```text
DeepSeek:
    no request mutation

GPT-5.6:
    promptCacheKey present
    promptCacheOptions present

GLM-5.3:
    volatile env block relocated when eligible

MiMo-V2.6:
    volatile env block relocated when eligible
    no GPT/GLM-only cache fields present
    x-session-id added only for actual OpenRouter provider identity
    telemetry carries provider/model/promptTokens/cachedTokens/cacheHitRate

Kimi / Claude / Gemini / Qwen / Grok / Meta Muse / MiniMax (passive families):
    no request mutation of any kind
    no cache-control field, cache key, or affinity header injected
    classification and cache-read usage recorded when the provider reports them
    no fabricated cache-write tokens
```

---

# Troubleshooting

## DeepSeek cache rate dropped

First check provider stability and whether OpenCode's system/tool prefix changed.

The plugin itself does not intentionally mutate DeepSeek request options.

Inspect the telemetry for:

```text
prefix-change
usage
compaction
```

A prefix change is a diagnostic signal, not automatic proof of a cache miss.

---

## GPT-5.6 cache options are missing

Verify that the model is within the documented GPT-5.6-and-later boundary (for example `gpt-5.6-*` or `gpt-6-*`) and that the endpoint is recognized as OpenAI/Azure-compatible.

The detector intentionally rejects ambiguous OpenAI-compatible providers rather than guessing.

Also check whether the outgoing request already supplied its own cache options. Existing settings are intentionally preserved.

---

## GLM-5.3 prompt is not being changed

The environment relocation only occurs when the plugin can identify the expected block unambiguously.

The relevant block must contain the expected beginning and closing marker, and the system structure must meet the plugin's eligibility rules.

---

## MiMo-V2.6 prompt is not being changed

MiMo uses the same eligibility rules as GLM-5.3: exactly one system string, both
`<env>` markers present, block identified unambiguously, and
`mimo26.stabilizeSystem` enabled. If the block is already at the tail, the
operation is a no-op.

---

## MiMo provider is not classified as `mimo26`

Verify the model identifier is exactly Flash or Pro:

```text
mimo-v2.6-flash
mimo-v2.6-pro
xiaomi/mimo-v2.6-flash
xiaomi/mimo-v2.6-pro
```

`mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2`, and undocumented V2.6 variants such as
`mimo-v2.6-flashx` are intentionally not matched.

---

## OpenRouter affinity header is not added

CacheEngine adds its `x-session-id` only for a detected MiMo V2.6-and-later or GLM-5.3-and-later
request when the actual OpenCode `providerID` is exactly `openrouter`. A direct
provider route or missing provider identity is bypassed. If a case-insensitive
`x-session-id` is already present in model or plugin headers, it is preserved
and CacheEngine does not replace it. Check the `openrouter_affinity_*` boundary
records for eligibility, provider identity, and whether CacheEngine added the
header; the record does not include the header value.

---

## A new model was released and CacheEngine does not recognize it

This is expected and is safe. A model that CacheEngine has not seen resolves
deterministically instead of guessing:

* an unknown creator or provider resolves to neutral, with no cache controls and
  no affinity header;
* a known family inherits its baseline only when a registry entry registers that
  version range;
* a model-specific prompt overlay applies only when a registry entry names it for
  that model.

To see how a specific model resolved, look for its `policy-resolution` record:

```bash
grep '"kind":"policy-resolution"' ~/.cache/opencode/cache-metrics.jsonl | tail
```

`matchCategory` tells you which path it took (`exact-id`, `alias`, `family`,
`creator`, `neutral`) and `matchReason` names the registry entry responsible. A
`version-range` match means the model inherited a documented boundary, and
`overlaySkippedReason` tells you whether a family overlay was deliberately not
applied because the model is not validated for it.

---

## Metrics file is missing

Telemetry is best-effort.

Check:

```text
~/.cache/opencode/cache-metrics.jsonl
```

and verify that the configured parent directory is writable.

A telemetry failure is intentionally swallowed so it does not break model execution.

---

# Status

The current implementation is intentionally conservative:

```text
DeepSeek    -> preserve and measure
GPT-5.6+    -> documented cache key/options; user/harness controls the 272K pricing boundary
GLM-5.3+    -> family baseline; GLM-5.3 only: preserve-content <env> relocation + OpenRouter affinity header
MiMo V2.6+  -> family baseline; V2.6 Flash/Pro only: preserve-content <env> relocation (+ OpenRouter affinity header)
Kimi        -> passive; Moonshot caching is automatic (V2.6/K2.7-code/K3); request unchanged
Claude      -> passive; OpenCode applies Anthropic cache_control breakpoints; request unchanged
Gemini      -> passive; Google implicit caching (2.5+); request unchanged, no CachedContent created
```

That separation is the core design of the project.

The plugin should be evaluated using real provider-reported usage and real task cost rather than assuming that any particular local transformation guarantees a cache hit.
