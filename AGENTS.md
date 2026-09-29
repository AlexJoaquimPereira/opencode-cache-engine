# Repository instructions

OpenCode plugin for provider-aware prompt-cache behavior and telemetry. Change
request structure only for verified provider behavior, and keep each mutation
narrow, deterministic, and tested; otherwise preserve the request and observe
provider-reported usage.

## Commands

```bash
npm test
node --test --test-name-pattern='OpenRouter|affinity' test/cache-engine.test.mjs
node --experimental-strip-types -e "import('./src/cache-engine.ts').then(m=>console.log(Object.keys(m)))"
npm pack --dry-run
```

- Node 22.23.2 and OpenCode 1.18.32 are the verified toolchain. Re-check runtime
  assumptions when OpenCode changes.
- The root package has no dependencies or build/lint/typecheck scripts. Tests
  use Node's built-in runner and import the plain-JS core; the server entry can
  be loaded with `--experimental-strip-types`. Don't add a bundler or `tsc` just
  to satisfy a harness.
- `postpublish` creates and pushes a `v<version>` Git tag. Never publish as a
  test; publish only when explicitly requested.

## Ownership and runtime

- `src/cache-engine.ts` owns OpenCode hooks, client/session state, request
  mutation, and plugin wiring. `src/cache-engine-core.mjs` is dependency-light
  pure JS for config, classification, transforms, IDs, and metrics; keep new
  testable logic there. `src/tui.mjs` only registers the plugin; it has no
  CacheEngine-specific UI or server behavior.
- Package exports are separate: `./server` → `src/cache-engine.ts` and `./tui`
  → `src/tui.mjs`. Check packaging changes with `npm pack --dry-run`.
- Hooks registered: `chat.headers`, `chat.params`,
  `experimental.chat.system.transform`, `experimental.session.compacting`, and
  `event` (notably `session.idle` usage aggregation).
- Runtime facts (verified on OpenCode 1.18.32): `client.session.get` takes
  `{ path: { id } }`; SDK methods use `this._client`, so call them as members or
  bind them. `chat.params` marks compaction with `input.agent === "compaction"`.
- The system-transform runtime passes one `output.system` element and ignores
  reassignment; mutate `output.system[0]` in place. The plugin's fake-client
  affinity tests exercise `chat.headers` without model calls, but do not prove
  OpenCode's network adapter sends the header upstream.
- OpenCode sorts tools before sending them. `toolWireFingerprint` is a
  registry-order diagnostic, not a byte-exact wire fingerprint. Tool-list
  failures leave fingerprints unknown; never emit a fabricated tool change.
- Fork message ancestry is not reliable in the verified runtime, so GPT's
  `cacheRootKey` default stays `false`. Do not invent fork-ancestry heuristics.

## Provider invariants

- **DeepSeek:** passive only. Never mutate its system, tools, messages, provider
  options, or cache keys.
- **GPT-5.6:** prompt text stays unchanged. For OpenAI/Azure-compatible GPT-5.6
  models, add only missing `promptCacheKey` and `promptCacheOptions` (default
  `implicit`, `30m`) in `chat.params`; preserve runtime-supplied values.
  Compaction has its separate `<root>:compact` namespace. Reasoning effort is
  observe-only. Context/output limits and the 272K pricing boundary belong to
  user/harness configuration; never set or raise them here.
- **GLM-5.3 and MiMo-V2.6:** the only prompt mutation is the exact,
  content-preserving relocation of the identifiable `<env>` block to the
  system tail, only when enabled and eligible. Don't reorder instructions,
  rewrite reasoning, or move generic dynamic content. MiMo detection must stay
  narrow: `/mimo-v2\.6-(flash|pro)(?![\w-])/i`.
- **OpenRouter affinity:** `chat.headers` adds deterministic `x-session-id`
  only for GLM-5.3/MiMo-V2.6 when the actual `providerID` is exactly
  `openrouter`. Preserve any case-insensitive pre-existing header; never add it
  for direct/unknown providers. This is an HTTP header, not a body `session_id`,
  cache key, or cache-control field. `mimo26.stickySession` gates the derived
  ID in telemetry, not header injection. Never invent MiMo cache keys,
  breakpoints, or TTLs, and never override routing.
- Fail closed on unknown provider identity. Model availability through
  OpenRouter does not authorize sending OpenRouter-specific fields to direct
  endpoints.

## Telemetry and safety

- Keep the ratios distinct: generic `read/(read+write)`; GLM
  `read/(read+write+input)`; MiMo `cachedTokens/promptTokens`, where MiMo
  `promptTokens = read + input`. Provider token counts are authoritative; local
  hashes show only observed byte changes, not cache hits.
- Do not fabricate cache-write values or emit zero-usage records on idle.
  Telemetry is best-effort and must not break requests. Never record prompt or
  reasoning contents, credentials, authorization headers, or full request
  bodies. MiMo's optional `stickySessionId` telemetry field is an intentional
  derived identifier (the same deterministic ID used for affinity), not a dump
  of captured request headers.
- Preserve the current compaction continuation behavior (at most one insert per
  invocation); do not change thresholds, context limits, or token budgets as an
  incidental change.

## Repository workflow

- The Git working tree is the source of truth; don't maintain a second active
  plugin copy under `~/.config/opencode/plugins/`. `.opencode/` and telemetry,
  session, archive, and lockfile artifacts may be local state; don't delete or
  commit them opportunistically. The local `.opencode/opencode.json` loads the
  package by name and is not the package source.
- The example config must match parser defaults; update it and default
  assertions together when defaults change.
- Keep changes task-scoped; run focused checks first, then `npm test`. For
  runtime-facing changes, use the fake-client/no-model harness where applicable
  and distinguish tested hook logic from unverified network behavior.

## Future-model maintenance procedure (audit first)

Use this whenever a newly released model needs a compatibility review. It is an
AUDIT FIRST task: web search is allowed, runtime code changes are not.

Establish the model id and creator, then determine from **first-party creator
documentation**:

1. model family/generation
2. prompt-cache mechanism
3. cache prefix rules
4. cache-control fields
5. cache-key semantics
6. retention/TTL
7. usage fields
8. documented prompt-stability guidance
9. whether the model inherits the creator's existing family cache policy
10. whether any existing CacheEngine overlay is applicable

Compare the findings against `docs/cache-policy-inventory.md`, the current policy
resolver (`src/cache-policy-core.mjs`), and the current tests.

Classify the model as exactly one of:

- existing family policy applies unchanged
- existing family baseline applies but no existing overlay applies
- new exact-model override required
- new family policy required
- insufficient evidence; remain passive/neutral

Never add a code change merely because a model is new.

**If no change is required:** update the compatibility inventory with the model
and its verification date, run tests, stop.

**If a code change is required:** do not implement it in that session. Report the
smallest justified follow-up release, the exact source evidence and the exact
runtime behavior that must change, and the regression tests required.

Hard rules:

- Don't speculate about undocumented cache behavior.
- Don't use pricing as proof of cache semantics.
- Don't broaden an existing prompt transformation merely because the new model
  has a similar name.

OpenCode is the harness. Use `policy-resolution` telemetry
(`matchCategory`, `matchReason`, `overlaySkippedReason`) to see how a model
actually resolved before assuming anything about it.
