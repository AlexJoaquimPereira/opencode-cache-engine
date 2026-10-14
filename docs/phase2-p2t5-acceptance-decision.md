# Phase 2 — P2-T5: acceptance decision (date relocation)

**Task:** P2-T5 (see `TODO.md`) — decide **promote / keep experimental / revise /
reject** for the `stabilizeDate` date-line relocation, and satisfy the operations and
publication gates.
**Decision:** **Keep experimental (default off). Do not promote.** Phase 2 closes
with the transform available but disabled; a real-calendar rollover confirmation is
optional follow-up, not a precondition for closure.

## Basis (release gates, plan §15)
| Gate | Requirement | Result |
|---|---|---|
| G2 — Safety | Invariants and no-op conditions pass. | **PASS** — P2-T2 + audit (guard, ambiguity, already-at-tail, byte preservation). |
| G3 — Wire | Serialized request contains the intended change only. | **PASS** — P2-T3 (`RF-OC-036`): the date line moves past `<env>` in the serialized request for GLM-5.3/MiMo-V2.6; neutral unchanged. |
| G4 — Outcome | Provider evidence supports claimed benefit. | **NOT cleanly passed** — P2-T4 (`RF-OC-038`): directional support (ON >= OFF in 6/6 nonce-isolated trials on the pinned OpenRouter route) but the rollover was **simulated**, the magnitude varied, and a provider cached-prefix cap can saturate it. |
| G5 — Operations | Privacy, failure handling, rollback, limits documented. | **PASS** — see below. |
| G6 — Publication | Docs and claims match tested routes/evidence. | **PASS** — claims stay structural/*directional*; no provider-benefit claim. |

Per §3C a non-clean `cache.read` result is **inconclusive for promotion**; per §15
completion is not a promotion criterion.

## Operations (G5)
- **Disable path:** `policies.<family>.stabilizeDate = false` (the default). The
  transform is additive and independently controllable.
- **Staleness window:** none introduced — the daily date line is **relocated**, never
  **pinned**; the date value/format is unchanged and stays current.
- **Privacy / failure handling:** the transform is content-preserving and read-free of
  prompt content beyond the anchored date line; diagnostics/telemetry never carry
  prompt text; a failure is fail-closed (no-op).
- **Limits:** the anchor is intentionally narrow (OpenCode's `Today's date:` template);
  a format change makes it a safe no-op.

## Residual / optional follow-up
- A **real-calendar >=2-rollover** confirmation (not run) could upgrade G4; until then
  the transform stays off.
- A materially larger (non-date) volatile-region move would be a separate,
  safety-cased investigation (deferred, plan §13).

## Status
- **Phase 2: complete** (P2-T1..P2-T5). P2-T4's real-rollover confirmation remains
  optional/open (tracked in `TODO.md`).
- `stabilizeDate` ships **off**; the shipped structural capabilities are the `<env>`
  relocation (`stabilizeSystem`) and the (off-by-default) date-line relocation.

## Phase 2 completion record (2026-10-14)
Verified complete at HEAD `70f8e93` (package **1.1.2**; `npm test` **368/0**; all four
capture-harness suites pass; worktree clean apart from the local `TODO.md` and the
preserved untracked `package-lock.json`).

| Task | Deliverable | Artifact(s) | Status |
|---|---|---|---|
| P2-T1 | Hook-shape research (per route) | `docs/phase2-date-relocation-hook-shape.md`; `RF-OC-035`; `test/fixtures/date-relocation-shapes.mjs` | done |
| P2-T2 | Content-preserving date relocation | `relocateVolatileDateLine` + `stabilizeDate` (V1/V2); tests + audit hardening | done |
| P2-T3 | Offline wire verification (gate G3) | `test/harness/capture/{verify-date-relocation.mjs,date-relocation.test.sh,run.sh}`; `RF-OC-036` | done |
| P2-T4 | Provider-side A/B | `docs/phase2-p2t4-provider-ab-report.md`; `RF-OC-038`; `RF-OR-006` | performed (directional support) |
| P2-T5 | Acceptance decision | this document | done |

**Plan §6 acceptance:** hook shape and wire behavior documented; invariants pass; no
stale date introduced; **provider-benefit threshold not met** → keep experimental
(explicitly accepted).

**§3C thresholds:** transform invariants **met**; provider benefit **not met** →
`stabilizeDate` default **off**.

