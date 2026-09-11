# OpenCode Cache Engine

Provider-aware prompt-cache optimization and observability for [OpenCode](https://opencode.ai).

`CacheEngine` is an OpenCode plugin designed for long-running agent sessions where prompt-cache efficiency affects both latency and cost. It keeps the harness conservative for providers whose cache behavior is already automatic, while applying provider-specific optimizations where the provider exposes useful cache controls or where prompt structure can be safely improved.

The plugin currently has three cache-policy families:

* **DeepSeek V4.1 Flash** — passive cache-stability and observability
* **GPT-5.6 Luna** — active cache-control configuration
* **GLM-5.3 Flash** — conservative system-prompt stabilization

The central design principle is:

> Optimize the request structure only when there is a clear provider-specific reason to do so. Otherwise, preserve OpenCode's native request behavior and measure what the provider actually reports.

---

## What this plugin does

The plugin operates at the OpenCode harness level rather than implementing a provider-specific client.

It:

1. Detects the model/provider family in use.
2. Applies only the policy appropriate for that family.
3. Observes system-prompt and tool-definition stability.
4. Records provider-reported cache token usage.
5. Adds a deterministic compaction continuation block.
6. Applies GPT-5.6 cache-control metadata.
7. Applies the GLM-5.3 volatile-environment relocation.
8. Records diagnostics that help determine whether prompt-shape changes correlate with cache behavior.

The plugin deliberately avoids pretending that a local hash is proof of a provider cache hit. Provider-reported token usage remains the authoritative signal.

---

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

---

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

---

## GLM-5.3 Flash

### Policy: input-shape optimization

GLM-5.3 receives the only prompt-text transformation in the current plugin.

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

---

# Prompt-cache strategy

The plugin uses three different strategies because cache mechanisms differ by provider.

| Provider          | Prompt text changed? | Cache metadata changed? | Main strategy                     |
| ----------------- | -------------------: | ----------------------: | --------------------------------- |
| DeepSeek V4.1 Flash |                   No |                      No | Preserve stable harness + observe |
| GPT-5.6 Luna      |                   No |                     Yes | Stable cache key + cache options  |
| GLM-5.3 Flash     |        Yes, narrowly |   No provider cache key | Isolate volatile system content   |

This distinction is fundamental.

The plugin is **not** a generic "rewrite every prompt for caching" engine.

It is a provider-aware cache policy engine.

---

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

---

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

---

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

---

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

### Important metric distinction

These ratios answer different questions.

`read / (read + write)` answers approximately:

> Of the tokens represented as cache reads/writes, how much was reused?

`read / (read + write + input)` answers:

> How much of the total prompt-token accounting was represented by cached reads?

Do not treat the two percentages as interchangeable.

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

---

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

---

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
    }
  }
}
```

The configuration parser starts from these defaults and applies valid file/environment overrides without mutating the caller's configuration object.

---

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

---

# DeepSeek configuration

```json
"deepseek": {
  "enabled": true
}
```

There are intentionally very few settings here.

DeepSeek is treated as the conservative/passive policy.

---

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

---

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

---

# Model detection

The plugin classifies requests into:

```text
deepseek
gpt56
glm53
neutral
```

The model detector recognizes:

* DeepSeek model/provider identifiers
* GPT-5.6 variants
* GLM-5.3 variants

GPT-5.6 has an additional OpenAI/Azure-context check so a string containing `gpt-5.6` does not automatically cause GPT-specific fields to be sent to an unrelated endpoint.

Unknown models use the neutral policy.

Neutral means:

```text
no provider-specific request mutation
```

---

# OpenRouter usage

This plugin is compatible with OpenRouter because the cache policy is based on the model/provider signals available to OpenCode.

For cache-sensitive workloads, provider stability remains important.

The plugin does not attempt to compensate for provider switching by rewriting prompts.

For that reason, a stable provider route is preferable when your goal is to measure and maximize prefix reuse.

---

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

The identifier `CacheEngine` is the OpenCode plugin export name. It does not determine the eventual npm package name.

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

A typical standalone repository can use:

```text
opencode-cache-engine/
├── src/
│   ├── cache-engine.ts
│   └── cache-engine-core.mjs
├── test/
│   └── cache-engine.test.mjs
├── examples/
│   └── cache-engine.json
├── README.md
├── LICENSE
└── package.json
```

The OpenCode plugin export remains:

```ts
export const CacheEngine
```

regardless of the eventual npm package name.

For example, the npm package could be named:

```text
opencode-cache-engine
```

without changing the `CacheEngine` export identifier.

---

# Installation

Install the plugin into the OpenCode plugins directory according to your OpenCode plugin-loading setup.

The runtime entry should expose:

```ts
export const CacheEngine: Plugin = async ({ client, directory }) => {
  // ...
}
```

After installation, verify that OpenCode loads the plugin successfully before benchmarking cache behavior.

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
GPT-5.6   -> configure cache controls
GLM-5.3   -> isolate volatile prompt content
```

That separation is the core design of the project.

The plugin should be evaluated using real provider-reported usage and real task cost rather than assuming that any particular local transformation guarantees a cache hit.
