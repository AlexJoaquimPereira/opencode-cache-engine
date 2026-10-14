# Phase 2 — P2-T4 report: provider-side A/B for the date-line relocation

**Task:** P2-T4 (see `TODO.md`) — measure whether the `stabilizeDate` date-line
relocation improves provider-reported prefix-cache reuse across a date change.
**Type:** measurement (authorized). **Evidence label:** *Provider measured*.
**Status:** **inconclusive** — G4 **NOT passed** (no reproducible benefit).
**Still open:** a real-calendar-rollover confirmation and the GLM re-pin.

## Objective
From provider-reported usage, determine whether relocating the daily date line to
the system-prompt tail (candidate) yields a **larger reused cached prefix** than
leaving it before `<env>` (baseline) when the date changes (§6, §3C).

## Initial state
- Branch / HEAD: `master` @ `c5927d4`; package version **1.1.2**.
- Test baseline: `npm test` 368/0; `npm run test:harness` all pass.
- Lockfile integrity: `package-lock.json` SHA1 `bcf39bba1806d74418eedb4decdb97aefd43c409` (untouched).
- Route: OpenRouter, pinned models `z-ai/glm-5.3-flash` and `xiaomi/mimo-v2.6-flash`.

## Findings
- **Observed — measurement path.** The plugin's own `usage` telemetry does **not**
  fire under headless `opencode run`; provider cache usage is read from OpenCode's
  session DB (`~/.local/share/opencode/opencode.db`, `session_message.data.tokens.cache.{read,write}`).
- **Observed — project plugin load.** A project `.opencode/plugins/<shim>.ts`
  (re-exporting `src/cache-engine-v2.mjs`) loads only under `opencode run
  --standalone`; without it the adapter's `setup` never runs (no metrics file).
- **Documented — provider endpoint override.** A provider endpoint can be
  overridden via `provider.<id>.options.baseURL` (OpenCode config schema; singular
  `provider`).
- **Observed — GLM route not measurable.** With the pinned upstreams
  (streamlake/novita/z-ai fp8), two identical ~23K-token requests reported
  `cache.read: 0`, `cache.write: 0`. Historical direct-route sessions have shown
  `cache.read` (~185K), so this is route-dependent.
- **Observed — MiMo route measurable.** With xiaomi/fp8, identical repeat requests
  reported `cache.read` (e.g. 23872 of ~24K input).
- **Provider measured — result (MiMo v2.6 Flash, simulated rollover).** Using a
  local forwarding proxy that rewrites the date value (Wed 14 -> Thu 15 Oct 2026):

  | trial | OFF `cache.read` (date before `<env>`) | ON `cache.read` (date at tail) | delta |
  |---|---:|---:|---:|
  | non-isolated | 3072 / 4608 / 15552 | 4672 / 15552 / 15552 | 0..+10944 (confounded by cache carryover) |
  | **nonce-isolated** | **0 / 4672 / 4736** | **4608 / 4096 / 4736** | **+4608 / -576 / 0** |

- **Inferred / unresolved.** With independent caches (unique stable prefix per
  trial) there is **no reproducible, directionally consistent** `cache.read`
  increase — a sign flip is present and the variance (0..+4608) far exceeds the
  expected effect (~368 B / ~90 tokens). The effect is **below the cache signal's
  noise** on this route/design.

## Changes
- **Files changed:** none in the repository (this task used disposable projects and
  a local proxy under `/tmp/opencode`).
- **Behavior changed:** none (the `stabilizeDate` default remains **off**).
- **Behavior intentionally unchanged:** the shipped transform and its defaults.

## Validation
- Commands and tests: N/A (no repo change); the structural gates G2/G3 were closed
  in P2-T2/P2-T3.
- Offline isolation: the plugin loaded via the project shim and relocated the date
  (`dateAfterEnv: true`) under the candidate condition.
- **Provider requests made: yes** (OpenRouter; small spend).
- **Credentials accessed: no** (auth used by OpenCode from its store; never read or logged).

## Acceptance criteria
- [ ] A reproducible `cache.read` increase vs baseline, directionally consistent
      (no sign flip), across >=2 rollovers — **NOT met** (inconclusive).
- [x] Measurement machinery established and reproducible.
- [x] Provider requests made under authorization.

## Risks and limitations
- **Simulated** rollover (proxy date rewrite), not a real calendar rollover (§6).
- **GLM blocked** on the pinned route (pending re-pin to `z-ai/fp8`).
- Small effect below the cache signal's noise; n=3 per condition.
- OpenRouter upstream routing and cache TTL are confounders.

## Cleanup and integrity
- Temporary artifacts: `/tmp/opencode/{t4proxy.mjs,t4ab.sh,t4probe,t4route,t4home,phase2-p2t4-*}`.
- Worktree status: repository unchanged by this task.
- Lockfile hash: `bcf39bba1806d74418eedb4decdb97aefd43c409` (untouched).
- Managed config/services untouched.

## Recommendation
**Inconclusive.** Keep `stabilizeDate` **experimental (default off)**; do **not**
promote. Per §3C/§15 a non-reproducible `cache.read` delta is inconclusive. The
structural work (G2/G3) stands. Revisit with a real-calendar rollover confirmation
and, if desired, the GLM `z-ai/fp8` re-pin; a materially larger (non-date) volatile
region would be a separate, safety-cased investigation (deferred).
