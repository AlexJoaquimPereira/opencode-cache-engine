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

`CacheEngine` is an OpenCode plugin designed for long-running agent sessions where prompt-cache efficiency affects both latency and cost. It keeps the harness conservative for providers whose cache behavior is already automatic, while applying provider-specific optimizations where the provider exposes useful cache controls or where prompt structure can be safely improved.

The plugin currently has four cache-policy families:

* **DeepSeek** — passive cache observability; request structure is preserved.
* **GPT-5.6** — documented cache-key/options metadata, with prompt text unchanged.
* **GLM-5.3** — narrow, content-preserving `<env>` relocation and diagnostics.
* **MiMo-V2.6** — narrow, content-preserving `<env>` relocation and diagnostics.

For both MiMo-V2.6 and GLM-5.3, CacheEngine adds its deterministic
`x-session-id` request header only when OpenCode identifies the actual provider
as `openrouter`. It does not add that OpenRouter-specific header for
non-OpenRouter providers; direct provider endpoints retain their provider-native
caching behavior.

The central design principle is:

> Optimize the request structure only when there is a clear provider-specific reason to do so. Otherwise, preserve OpenCode's native request behavior and measure what the provider actually reports.


## What this plugin does

The plugin operates at the OpenCode harness level rather than implementing a provider-specific client.

It:

1. Detects the model/provider family in use.
2. Applies only the policy appropriate for that family.
3. Observes system-prompt and tool-definition stability.
4. Records provider-reported cache token usage.
5. Adds a deterministic compaction continuation block.
6. Applies GPT-5.6 cache-control metadata.
7. Applies the GLM-5.3 and MiMo-V2.6 volatile-environment relocation.
8. Records diagnostics that help determine whether prompt-shape changes correlate with cache behavior.
9. Records MiMo/GLM affinity outcomes and provider-identity changes.

The plugin deliberately avoids pretending that a local hash is proof of a provider cache hit. Provider-reported token usage remains the authoritative signal.


# Provider behavior

## DeepSeek V4.1 Flash

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


## GPT-5.6 Luna

### Policy: active cache control

GPT-5.6 is the only current policy that actively injects cache-control request metadata.

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

The key is derived from the OpenCode session identity and is independent of transient request data. The implementation also preserves existing provider-supplied cache settings rather than overwriting them.

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

This prevents a compaction-specific prompt from sharing the same GPT cache namespace as the normal live-session prompt. The behavior is deterministic and tested explicitly.


## GLM-5.3 Flash

### Policy: input-shape optimization

GLM-5.3 and MiMo-V2.6 use the only prompt-text transformation in the current
plugin: a narrow, content-preserving relocation of the identifiable `<env>`
block for the eligible model family.

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


## MiMo-V2.6 (Flash / Pro)

### Policy: prefix stability + OpenRouter session affinity

MiMo-V2.6 is Xiaomi's current model family. The plugin targets exactly two
identifiers:

* `xiaomi/mimo-v2.6-flash` / `mimo-v2.6-flash`
* `xiaomi/mimo-v2.6-pro` / `mimo-v2.6-pro`

Detection also tolerates `provider/model` shapes where `api.id` contains those
slugs. It deliberately does **not** match `mimo-v2.5`, `mimo-v2.5-pro`,
`mimo-v2.6-pro-ultraspeed`, or unrelated MiMo models.

### Implicit context caching

Xiaomi documents context caching for both V2.6 Flash and Pro, and exposes
`usage.prompt_tokens_details.cached_tokens` as the number of prompt tokens
served from cache. The V2.6 API documents implicit context caching, not a
user-supplied cache key or explicit breakpoint.

Accordingly the plugin **injects no cache-control parameter** for MiMo. It does
not send `promptCacheKey`, `cacheControl`, `cacheBreakpoint`, or `ttl`.
Implicit caching is the default assumption.

### Environment-block stabilization

MiMo uses the same narrow, content-preserving transformation as GLM-5.3: the
identifiable volatile `<env>` block is relocated to the **tail** of the single
system string. Contents are preserved byte-for-byte; only position changes. This
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

For MiMo-V2.6 requests whose actual OpenCode provider identity is `openrouter`,
CacheEngine adds its existing deterministic, session-scoped `x-session-id`
request header. If a case-insensitive `x-session-id` already exists in model or
plugin headers, CacheEngine preserves it and does not replace it. Eligibility
uses both the MiMo-V2.6 family and the actual provider identity; a matching model
slug on another endpoint is not enough.

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


# Provider comparison

| Policy family | Detection | Prompt text changed? | Cache metadata changed? | OpenRouter affinity header | Primary cache signal |
| ------------- | --------- | ------------------- | ----------------------- | -------------------------- | -------------------- |
| DeepSeek | `deepseek` | No | No | None | provider `cache.read` / `cache.write` |
| GPT-5.6 | `gpt-5.6*` on OpenAI-ish endpoints | No | Yes: `prompt_cache_key` + options | None | provider cache tokens |
| GLM-5.3 | `glm-5.3*` | Yes, narrowly (`<env>` tail) | No provider cache key | `x-session-id` on OpenRouter only | provider cache tokens (GLM ratio) |
| MiMo-V2.6 | Flash / Pro only | Yes, narrowly (`<env>` tail) | No: implicit caching only | `x-session-id` on OpenRouter only | `cached_tokens / prompt_tokens` |

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


# Metrics examples

A usage record can contain fields such as:

```json
{
  "kind": "usage-event",
  "sid": "session-id",
  "ts": 1750000000000,
  "read": 120000,
  "write": 3000,
  "cost": 0.0123,
  "provider": "z-ai",
  "model": "glm-5.3-flash",
  "policy": "glm53"
}
```

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

Affinity observations are `boundary` records. They contain provider/model
identity and booleans/source classification such as `eligible`,
`headerPresent`, `headerAttached`, and `headerSource`; they do not include the
`x-session-id` header value or full request headers.

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


# Model detection

The plugin classifies requests into:

```text
deepseek
gpt56
glm53
mimo26
neutral
```

The model detector recognizes:

* DeepSeek model/provider identifiers
* GPT-5.6 variants
* GLM-5.3 variants
* MiMo-V2.6 Flash and Pro (`xiaomi/mimo-v2.6-flash`, `mimo-v2.6-pro`, ...)

GPT-5.6 has an additional OpenAI/Azure-context check so a string containing `gpt-5.6` does not automatically cause GPT-specific fields to be sent to an unrelated endpoint.

MiMo detection targets exactly Flash and Pro: it excludes `mimo-v2.5`,
`mimo-v2.5-pro`, and `mimo-v2.6-pro-ultraspeed`.

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

The implementation is split into two layers.

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

* provider classification
* configuration parsing
* hashing
* canonicalization
* tool fingerprints
* system-shape decomposition
* GPT cache-key generation
* cache-option generation
* GLM environment relocation
* reasoning diagnostics
* usage aggregation
* compaction guards

Keeping these functions in plain JavaScript allows the logic to be tested independently with Node's built-in test runner.

---

## Tests

The repository's test suite validates the provider-independent and provider-specific logic.

Coverage includes:

* model detection
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
* configuration behavior
* JSONL telemetry behavior

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
│   └── tui.mjs
├── test/
│   └── cache-engine.test.mjs
├── examples/
│   └── cache-engine.json
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
    "opencode-cache-engine@0.3.6"
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
```

---

# Troubleshooting

## DeepSeek cache rate dropped

First check provider stability and whether OpenCode's system/tool prefix changed.

The plugin itself does not intentionally mutate DeepSeek request options.

Inspect the telemetry for:

```text
prefix-change
usage-event
compaction
```

A prefix change is a diagnostic signal, not automatic proof of a cache miss.

---

## GPT-5.6 cache options are missing

Verify that the model is actually classified as GPT-5.6 and that the endpoint is recognized as OpenAI/Azure-compatible.

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

`mimo-v2.5`, `mimo-v2.5-pro`, and `mimo-v2.6-pro-ultraspeed` are intentionally
not matched.

---

## OpenRouter affinity header is not added

CacheEngine adds its `x-session-id` only for a detected MiMo-V2.6 or GLM-5.3
request when the actual OpenCode `providerID` is exactly `openrouter`. A direct
provider route or missing provider identity is bypassed. If a case-insensitive
`x-session-id` is already present in model or plugin headers, it is preserved
and CacheEngine does not replace it. Check the `openrouter_affinity_*` boundary
records for eligibility, provider identity, and whether CacheEngine added the
header; the record does not include the header value.

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
DeepSeek  -> preserve and measure
GPT-5.6   -> documented cache key/options; user/harness controls the 272K pricing boundary
GLM-5.3   -> preserve-content <env> relocation + OpenRouter affinity header
MiMo-V2.6 -> preserve-content <env> relocation + OpenRouter affinity header
```

That separation is the core design of the project.

The plugin should be evaluated using real provider-reported usage and real task cost rather than assuming that any particular local transformation guarantees a cache hit.
