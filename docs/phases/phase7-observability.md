# Phase 7 — minimal user-facing observability (P7-T1 …)

**Plan:** `docs/plans/v1.x.x-implementation-plan.md` §11 (+ §3B/§3C row 7). **Parent task list:**
`TODO.md` (Phase 7). Gated implementation — no request mutation, no provider calls, **0 bytes added
to any prompt**.

---

## P7-T1 — observability requirements + data-source inventory

**Task:** P7-T1 (`TODO.md`) — map every element plan §11 requires to a telemetry source (or mark it
**unavailable**), and fix the "must not show" list — before any renderer is designed.

**Evidence:** every row traces to a record kind/field in the P5-T1 catalogue
(`docs/phases/phase5-usage-accounting.md` §1–§5) and the emitters
(`src/cache-engine.ts`, `src/cache-engine-v2.mjs`, `src/cache-engine-core.mjs`). `[O]` structurally
verified. **Provider measured: not performed.**

### 1. Required element → data source

| Element (plan §11) | Record kind + field(s) | Adapter | Availability |
|---|---|---|---|
| **policy mode** | `boundary.policy` (+ `reason`); `policy-resolution.policy`/`family`/`matchCategory`/`matchReason`/`overlayApplied`/`overlaySkippedReason`; `usage.policy` | both; `policy-resolution` V1-only | available (V1 richest) |
| **last structural change** | `prefix-change` (`ts`, `dimensions`, `reasons`, `changedFields`, `before`/`after`, `systemStablePrefixLength`); `boundary` (`system_date_relocated`, `mimo_system_env_relocated`, `system_volatility`) | `prefix-change` V1-only; some `boundary` both | available (V1); V2 → boundary events only |
| **first differing section** | `prefix-change.changedFields` / `dimensions` / `reasons` (system-stable-prefix · volatile-suffix · semantic-tools · wire-tools hashes); `boundary.system_volatility.rules` | V1 | available (V1-only) |
| **transformation attempt vs applied** | `stage` on every record (`decision` vs `applied`; `observation`/`outcome`/`error`); `cache-options.keyInjected`/`keyPreserved`/`optionsInjected` | both | available |
| **wire verification** | `wireEffect` — **currently always `"not_observed"`** | both | **constant "not observed"** (never a wire claim) |
| **provider cache metrics (when available)** | `usage.read`/`write`/`input`, `sampleHitRate`, `cumulative`/`cumulativeHitRate`, `glmHitRate`, `cachedTokens`/`cacheHitRate`, `tokenSource` | both | **often unavailable** — only when the provider reports them |
| **accounting limitations** | static text from P5-T4 (best-effort; unavailable ≠ zero; restart recount; eviction undercount; provider-specific formulas) | — | static |
| **estimated cost impact** | **not produced** by the plugin (no pricing); only a P6-T3-style model | — | **only with explicit assumptions** |

### 2. Elements with no defensible source (must render as *unavailable*)

1. **Wire verification** — `wireEffect` is always `"not_observed"`; the report may show *attempted/
   applied hook-object* status but **must not** claim a wire effect (P4-T2/T3).
2. **Provider cache metrics** — absent when the provider reports none; the report shows *unavailable*,
   never `0` (P5-T4: missing ≠ zero).
3. **Estimated cost impact** — not computed anywhere; appears **only** with the assumptions spelled
   out, or is omitted.
4. **V2 diagnostics** — the V1-only kinds (`policy-resolution`, `prefix-observation`,
   `prefix-change`, `compaction`, `reasoning-integrity`) and `usage.provider`/`model` do not exist on
   V2; the report states "no V1 diagnostic available" rather than inventing a value.

### 3. Never-show list

- Prompt or reasoning content, tool schemas, message bodies — **none of the records carry them**
  (P5-T4 privacy guard); the report must not reconstruct or inline any.
- Credentials, authorization headers, full request/response bodies.
- **A ratio when provider data is insufficient** — omitted, not zero.
- An **estimate without its assumptions** — or any estimate presented as measured savings.
- A wire claim derived from `stage:"applied"` — always paired with `wireEffect:"not_observed"`.

### 4. Surface recommendation (input to P7-T2; decision deferred to the user)

**Recommend Option A — a pure renderer + a thin CLI over the metrics store:**

- `renderReport(records) → string`: a **pure** function in a dependency-light core module
  (`records` = the parsed `cache-metrics.jsonl` lines).
- A thin entry point reads `CACHE_ENGINE_METRICS_FILE` (else `DEFAULT_METRICS_FILE`,
  `~/.cache/opencode/cache-metrics.jsonl`) and prints the report.

Rationale: it is **never on the request path** (0 bytes to any prompt), fully **testable** (a pure
function over synthetic records, matching the repo's core-module ethos), adds **no dependency** and
touches no OpenCode runtime API.

**Option B (`./tui` panel)** is named by §3B but higher-risk: `src/tui.mjs` is a deliberate V1/V2
**registration no-op**, and the OpenCode TUI-panel API is **unverified** — building a panel would
need its own `RF-*` finding first. **Option C (staged)** = ship A now; revisit B only if that API is
verified. (Recommendation only — the choice is P7-T2.)

### 5. Evidence & acceptance

- Labels: **Structurally verified** / **Documented**. **Provider measured: not performed.**
- Acceptance: every required element is mapped or explicitly marked unavailable (§1/§2); the
  never-show list is explicit (§3); a surface recommendation is recorded (§4). **P7-T2 may proceed
  (subject to explicit authorization for the surface decision).**
