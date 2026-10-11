# opencode-cache-engine — Implementation Roadmap (0.7.x → 1.0.0)

This is the single authoritative roadmap for the project. It consolidates the
historical provider/architecture plan with the current V2 migration state.
Where older documents disagreed, this file wins.

- Historical per-model evidence lives in
  [`docs/cache-policy-inventory.md`](cache-policy-inventory.md).
- Cross-model harness/transport/API evidence lives in
  [`docs/research-findings.md`](research-findings.md).

Last reconciled: 2026-10-11 against `master` @ package version **0.7.1**
(299 tests). Historical figures in older revisions may be stale.

---

## 1. Purpose and current status

`opencode-cache-engine` is an [OpenCode](https://opencode.ai) plugin that adds
provider-aware prompt-cache handling and cache-usage observability. It classifies
the model/provider through a pure registry, applies only verified, narrow request
mutations, and records provider-reported cache usage without fabricating values.

**Current status (summary):**

- **V1 (OpenCode 1.x): shipped and in production use.** Eleven provider families;
  verified against OpenCode 1.18.x. This line is stable and must not regress.
- **V2 (`@opencode/plugin` 2.x / OpenCode 2.0.26): adapter implemented and
  offline-tested, but runtime registration and hook installation are
  UNVERIFIED.** The adapter imports and passes synthetic contract tests; it has
  not been observed loading and installing hooks in the real runtime.
- The shared policy resolver and usage/accounting core are reused by both
  adapters and remain free of runtime dependencies.
- The default priority is correctness, runtime compatibility, provider-policy
  safety, usage accounting, lifecycle integrity, documentation, and
  reproducible tests — **not** cache-hit maximization. The maintainer uses a
  subscription, so cold/warm cache-hit experiments are optional, never a
  development gate.

---

## 2. Architecture and invariants

**Two adapters over one shared core:**

| Layer | File | Responsibility |
| --- | --- | --- |
| Shared policy | `src/cache-policy-core.mjs` | Pure classification/resolution: matchers, `BASELINES`, `OVERLAYS`, `TRANSPORTS`, `POLICY_REGISTRY`, `resolvePolicy`, `resolveRuntimePolicy`, diagnostics. No runtime imports. |
| Shared core | `src/cache-engine-core.mjs` | Runtime-independent helpers: config load, transforms, identity, GPT cache helpers, diagnostics; re-exports the usage core. `node:*` + sibling `.mjs` only. |
| Shared usage | `src/cache-usage-core.mjs` | Runtime-independent usage scanning/cursor/aggregation/ratios (`node:crypto` only). |
| V1 adapter | `src/cache-engine.ts` | OpenCode 1.x `Plugin`: hooks `chat.headers`, `chat.params`, `experimental.chat.system.transform`, `experimental.session.compacting`, `event` (`session.idle`). |
| V2 adapter | `src/cache-engine-v2.mjs` | OpenCode 2.x plain `{ id, setup(ctx) }`: `session.hook("context")`, `session.hook("model.request")`, `event.subscribe()` (`session.idle`, `session.deleted`), `session.context({ sessionID })`. |
| TUI | `src/tui.mjs` | Plugin-manager registration only; no CacheEngine UI. |

**Binding invariants** (also in `AGENTS.md`):

- **Fail closed** on unknown provider identity; never guess a policy.
- **Mutate only for verified behavior**; preserve caller-supplied values.
- DeepSeek is passive; GPT‑5.6+ adds only missing `promptCacheKey`/options; GLM‑5.3
  and MiMo‑V2.6 use the exact content-preserving `<env>` relocation; OpenRouter
  `x-session-id` affinity is limited to `providerID === "openrouter"` for
  GLM/MiMo; Grok/Muse/MiniMax/Kimi/Claude/Gemini/Qwen are passive.
- **Never fabricate** cache reads/writes, TTIs, keys, or zero-usage records.
- **Never record** prompts, reasoning, credentials, authorization headers, or
  full request bodies.
- The shared core must stay free of OpenCode client/hook/routing/V2 dependencies.

---

## 3. Historical milestones (completed)

| Milestone | Status | Evidence |
| --- | --- | --- |
| v0.4.x | done | K1/K2 maintenance; tag `v0.4.13` |
| v0.5.x provider coverage | shipped | DeepSeek, GPT‑5.6+, GLM‑5.3, MiMo‑V2.6, Kimi, Claude, Gemini, Qwen, xAI Grok, Meta Muse, MiniMax (`v0.5.8` last family) |
| v0.6.0 shared-core consolidation | shipped | `src/cache-usage-core.mjs` extracted + re-exported; provider conformance matrix; tag `v0.6.0` |
| v0.7.0 core/adapter contract | shipped | boundary audited + documented; 4 contract tests; tag `v0.7.0` |
| v0.7.1 session-state lifecycle | shipped | watermark floor fix (no recount after prune/revert); 3 tests; tag `v0.7.1` |

These are history; they are not current instructions. The v0.5.x per-provider
recipes are intentionally superseded by §4–§5 and the inventory.

---

## 4. Current capability matrix

Legend: **Offline** = implemented + covered by synthetic tests; **Runtime** =
verified in the real runtime; **Partial** = implemented with known gaps;
**Deferred** = not implemented by choice; **Blocked** = cannot be verified yet.

| Capability | V1 | V2 | Notes |
| --- | --- | --- | --- |
| Policy resolution (11 families) | Runtime | Offline (reuses core) | shared registry/resolver |
| Passive families unchanged | Runtime | Offline | DeepSeek, Kimi, Claude, Gemini, Qwen, Grok, Muse, MiniMax |
| GPT‑5.6+ cache key/options | Runtime | Offline | missing-field only; no fork-root on V2 |
| GLM/MiMo `<env>` relocation | Runtime | Offline | single system text part; multi-part skipped |
| OpenRouter `x-session-id` affinity | Runtime | Offline | OpenRouter-only; shared telemetry schema |
| Usage accounting | Runtime | Offline | shared `scanPage`/`nextProcessedCursor`; ratios preserved |
| Telemetry (usage/boundary/cache-options) | Runtime | Offline | shared field names; no sensitive data |
| Bounded session state | Runtime | Offline | V2: LRU + tombstones + evicted marks |
| Session-state lifecycle (delete/prune/revert) | Runtime | Offline | V2: `session.deleted` + skip-backlog re-entry |
| Async cancellation / stale-reference safety | n/a | Offline | abort race + current-entry re-check |
| History ordering | Runtime | Partial | V2 sorts by `info.time.created`; not a total order |
| V2 runtime registration / hook install | n/a | **Blocked** | not observed in the real runtime |
| `session.usage.updated` semantics | n/a | Blocked/unused | delta-vs-cumulative unverified |
| Compaction cache isolation | Runtime | Deferred | needs verified `kind`/agent mapping |
| Fork cache-root resolution | opt-in | Deferred | fork ancestry unreliable |
| Prefix/tool diagnostics, reasoning integrity | Runtime | Deferred | secondary |
| Auxiliary request-kind handling (V2) | n/a | Resolved (server source) | `context` fires for `primary` only; auxiliary kinds use their own hooks (`compaction`/`generate`/`title`) |
| TUI | Runtime (`./tui`) | n/a | unchanged |

---

## 5. Remaining work packages

### Phase A — 0.7.x stabilization (current)

- Preserve V1 and the shared core; keep the V2 adapter and its regression suite.
- Finish locally-answerable investigations: auxiliary `context` request kinds
  (§4, §10); `session.usage.updated` semantics (§10); ordering guarantees (§4).
- Keep runtime registration **unverified**; do not edit shared config or restart
  services to force a smoke test.
- Keep session-state eviction bounded and documented (undercount tradeoffs).
- Remove stale speculative API examples from active instructions (done: the old
  `Plugin.define`/`context`/`model.request` snippets are superseded by §2).

### Phase B — 0.8.x V2 runtime integration

- Establish a **supported, safe** runtime validation procedure (isolated config;
  no shared-service replacement). If isolation remains blocked, keep the
  milestone open and document the exact blocker.
- Verify: package `./v2` entry resolution, `setup(ctx)` execution, and hook
  installation; confirm hook names/shapes against the installed API.
- Resolve usage-source semantics and ordering from local types/source where
  possible; otherwise record as open.
- Fix real integration defects with narrow patches + regression tests. V1
  unchanged.

### Phase C — 0.9.x dual-runtime stabilization

- Validate V1 and V2 independently; decide the V1→V2 parity contract for the
  first stable release.
- Explicitly decide whether V2 compaction isolation and fork cache-root are
  required for 1.0.0 (default: not required; documented as excluded).
- Complete installation/export/telemetry/lifecycle/failure documentation; add
  CI checks where the repository supports them.
- Cut a release candidate only when the §6 acceptance gates pass.

### Phase D — 1.0.0 stable dual-runtime release

Requires all of: demonstrated V1 compatibility; **demonstrated V2 registration
and hook installation**; adequate provider-policy regression coverage; usage
semantics documented to the degree the runtime supports; no fabricated usage or
exactly-once claims; explicit include/exclude decision for compaction/fork-root;
correct exports and package contents; accurate install/troubleshooting docs; full
tests + packaging checks green. No calendar deadlines — exit criteria only.

---

## 6. Dependencies and acceptance criteria

**Dependencies:** Phase B needs a safe runtime-isolation path (or maintainer
authorization for a temporary, reverted config change). Phase C needs Phase B's
registration evidence. Phase D needs Phase C's parity decisions.

**Phase acceptance:**

| Phase | Exit criteria |
| --- | --- |
| A | V1 suite green; V2 adapter imports + synthetic tests green; blockers documented; docs consolidated. |
| B | V2 plugin resolves, `setup` runs, expected hooks install in the real runtime; or a precise, documented blocker. |
| C | V1 and V2 validated independently; parity contract written; export/telemetry/lifecycle docs complete; RC candidate gated. |
| D | All §6/§7 gates pass; no fabricated usage; compaction/fork decision recorded. |

---

## 7. Testing strategy

- **Shared core + V1:** the existing suite (`npm test`, Node's built-in runner)
  imports the local source and uses fake clients/temp metrics — no network.
- **V2 adapter:** synthetic `ctx` fixtures grounded in the installed
  `@opencode/plugin` 2.x types: registration/isolation, `context` transforms
  (+ negatives), `model.request` affinity + telemetry parity, usage dedup/empty/
  ordering, `session.deleted`, capacity eviction + re-entry, GPT telemetry
  accuracy, malformed options, cancellable cleanup, pending-history abort, and
  eviction during retrieval.
- **Standing commands:** `npm test`; V1/V2/core import smoke checks;
  `git diff --check`; `npm pack --dry-run`. Synthetic fixtures are preferred.
- **Live-model probes are optional**, never a routine gate; any future probe
  requires explicit authorization, a stated offline-impossible reason, one
  request, a minimal prompt, and no cache-hit chasing.

---

## 8. Release and versioning policy

- Small, logically coherent, tested changes; one concern per commit.
- **Patch** releases for fixes/stabilization; **minor 0.x** for capability
  milestones; **1.0.0** only after both runtime integrations meet §6.
- Every release requires: full tests; V1/V2/core import checks;
  `git diff --check`; `npm pack --dry-run` + content inspection; README/plan/
  version consistency; explicit blocker sign-off; a documented rollback.
- Publishing/tagging is a separate, explicitly-authorized step (`postpublish`
  creates the `vX.Y.Z` tag on `npm publish`). Do not bump versions in routine
  commits.

---

## 9. Risk register and rollback plan

| Risk | Likelihood | Impact | Mitigation | Rollback |
| --- | --- | --- | --- | --- |
| V2 runtime registration cannot be verified | High | High | Keep the milestone open; document the isolation blocker; never fake a smoke test | Ship V1-only; keep V2 adapter dormant |
| Undocumented V2 hook/event semantics | Medium | High | Use only type/implementation-verified behavior; fail safe; mark unknowns | Disable V2 usage path |
| Usage double-count under lifecycle edges | Low | High | Watermark floor; skip-backlog on eviction; bounded state | Revert the shared/v2 change; keep V1 |
| Provider policy drift | Low | High | Registry + conformance tests; audit-first for new models | Revert the policy entry |
| Bounded-state eviction undercounts | Medium | Low | LRU + bounded marks; documented tradeoff | Raise/remove the cap (with a recount caveat) |
| Packaging/export regression | Low | Medium | `npm pack --dry-run` + import smokes | Fix `exports`/`files`; patch release |
| Shared-core refactor bug | Low | High | Small changes + tests; keep V1 greens | Revert to the tagged release |

---

## 10. Deferred work and explicit non-goals

**Deferred (may be selected for a future release):**

- Compaction cache isolation and fork cache-root support on V2.
- Prefix/tool-definition diagnostics, reasoning-integrity checks, and
  provider-observation telemetry on V2 (V1 retains them).
- TUI/V2 management integration.
- Mistral (requires its own audit-first evidence note).

**Non-goals:**

- Cache-hit maximization, performance benchmarking, or repeated cold/warm
  experiments as a development or release gate.
- Pricing-boundary or context/output-limit enforcement.
- Mutating requests for providers whose behavior is not first-party verified.
- Durable/exactly-once accounting across restarts (out of scope unless a future
  milestone explicitly adds persistence).
- Changing V1 behavior to accommodate V2.

**Open questions (must be resolved before 1.0.0 or explicitly excluded):**

- V2 runtime plugin registration/hook installation (blocking).
- `session.usage.updated` delta vs cumulative semantics (event currently unused).
- `session.context()` ordering guarantee (defensive sort in place).
- **Resolved (server source, 2.0.26):** the `context` hook fires only for the
  `primary` request kind; `compaction`/`generate`/`title` use their own hook
  names (see RF-OC-018). No adapter change is needed. (Live runtime plugin
  registration remains unverified.)
