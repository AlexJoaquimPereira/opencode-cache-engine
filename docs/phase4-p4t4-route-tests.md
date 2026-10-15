# Phase 4 — P4-T4: route-specific policy test scaffolding

**Task:** P4-T4 (`TODO.md`) — add route-specific tests for the policies, encoding the
"stripped/unsupported field ≠ wire success" discipline so the P4-T2/P4-T3 results cannot
silently regress (plan §8 acceptance).
**Type:** implementation (offline tests). No request mutated; no provider contacted.
**Depends on:** P4-T2, P4-T3.
**Baseline inputs:** P4-T1 inventory; P4-T2/P4-T3 reports; `RF-OC-030/031/047/048`;
`test/cache-engine.test.mjs`; the V1/V2 hook surface.

## Added

- **`test/fixtures/policy-routes.mjs`** — a data table of every **mutation-bearing** policy:
  hooks, classes, route-conditioned **field names**, the value it **preserves**, its
  **disable path**, and per-route **wire disposition** (`structural` / `stripped` /
  `harness-owned` / `unsupported`) with the evidence ID. Also the **passive-family** list and
  the capability keys that would signal a mutation regression.
- **Three tests** in `test/cache-engine.test.mjs` (run by `npm test`):
  1. **Route-correct GPT field names** — camelCase for `openai`/`azure`/other; snake_case for
     `openrouter` (including via the OpenRouter SDK npm).
  2. **Dispositions + passivity** — every mutation policy declares a disable path and
     route+evidence; each passive family resolves to a policy with **no** mutation
     capability (`gptCacheMetadata`/`envRelocation`/`openRouterAffinity` all falsy); an
     unknown provider fails closed (`isNeutral`).
  3. **V2 hook behavior (assignment ≠ wire)** — a hook probe asserting: GPT adds the key only
     when absent, **preserves** a pre-existing `promptCacheKey`, and **no-ops** without an
     `options` object; affinity attaches `mimo-ses-…` only when absent, **preserves** a
     user-supplied `x-session-id`, and does **nothing** for a non-`openrouter` provider or a
     non-affinity family; a passive family mutates nothing.

## Coverage vs plan §8 acceptance

| Acceptance clause | Covered by |
|---|---|
| Every active policy has route-specific tests | fixture rows + tests 1–3 |
| **Stripped/unsupported fields are not reported as wire success** | fixture `wire` dispositions (`stripped`/`harness-owned`/`unsupported`) + the assignment-only assertions (no test claims wire success) |
| Passive policies remain passive | test 2 (no mutation capability per family) + test 3 (passive mutation-free) |
| Identity and prefix stability remain distinct | pre-existing policy-matching tests + the fixture's separate `preserves` field |
| No promotion on attempted mutation alone | the fixture records disposition per route; the tests pin **preservation**, not injection, on the tested routes |

## Not covered (documented, not silently assumed)

- **Runtime wire lanes** for these routes would require the provider SDKs + a
  Responses-capable mock; the wire facts live in `RF-OC-047`/`RF-OC-048` and the P4-T2/P4-T3
  reports, not in an automated lane. The unit tests pin the **adapter** side (assignment,
  preservation, no-op) which is what can regress locally.
- **Provider-supported semantics / measured outcome** (does the cache actually hit) is out of
  scope offline.
- The V1 `chat.headers`/`chat.params` paths are covered indirectly (pure helpers + existing
  V1 tests); the new hook probe drives the **V2** adapter.

## Result

`npm test` → **373/0** (3 new tests). No runtime source changed. The route-specific
dispositions and the negative (not-wire-effective) results are now pinned in-repo.

## Integrity

No managed config/service touched; the hook probe uses a disposable temp `HOME`. No
credentials, prompt content, or full bodies recorded or committed.
