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
  `docs/cache-policy-inventory.md` §5a.
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

## RF-OR — OpenRouter transport and routing

### RF-OR-001 — OpenRouter's upstream provider selection is not exposed to plugins

- Status: current
- Verified: 2026-09-26
- Area: openrouter-transport
- Fact: Which upstream OpenRouter picks is not observable from a plugin, so
  CacheEngine must never claim or override routing.
- Evidence: [O]
- Sources: local — recorded in `docs/cache-policy-inventory.md` §5; consistent
  with RF-OC-003.
- Justifies: the "never override routing" invariant.
- Version context: OpenCode 1.18.34.
- Re-verify when: OpenRouter exposes routing information to plugins.
- Superseded by: null

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
  dropped without an error.

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
