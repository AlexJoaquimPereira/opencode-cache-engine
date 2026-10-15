# Phase 3 — ranked volatility inventory and go/no-go (P3-T6)

**Task:** P3-T6 (`TODO.md`) — consolidate the Phase-3 ranked entries into one ranked
volatility inventory, apply the Phase-3 advance rule, and record an explicit go/no-go on
the conditional implementation task (P3-T7).
**Type:** gate (research synthesis) — read-only. No request mutated; no provider contacted.
**Depends on:** P3-T2, P3-T3, P3-T4, P3-T5 (all complete).
**Evidence labels:** *Structurally verified* / *Offline-verified* / *Documented* /
*Unknown*. **Provider measured: not performed** for every row.

## Scope investigated

Phase 3 ("other volatility sources", plan §7) covered four threads after the P3-T1 capture
groundwork: tool ordering (P3-T2), startup / MCP readiness (P3-T3), dynamic instructions &
project context (P3-T4), and reasoning / thinking blocks (P3-T5). Each produced a ranked
entry with cited evidence.

## Ranked volatility inventory

Ranked by **expected impact × observability** (highest first). "Advance?" applies the
Phase-3 rule: a cause advances only if it is **recurring AND avoidable AND safely
correctable**.

| # | Cause | Evidence | Recurring? | Avoidable & safely correctable? | Expected impact | Risk | Next experiment | Source |
|---|---|---|---|---|---|---|---|---|
| 1 | **Startup / MCP readiness** — the first request after process start can be assembled before the forked MCP connect completes | Observed + **structurally verified** (source) | **Yes** (every process start) | **No** — inherent to OpenCode's non-blocking design; a fix = blocking on readiness, deferred (plan §13) | A first request omitting MCP-provided tools differs from later requests → a real prefix invalidator (wire effect not directly observed) | High (blocking adds latency/hang risk) | Same-process **second request** (tool-loop) to wire-observe the pending→connected transition | `docs/phase3-p3t3-startup-mcp.md`; `RF-OC-044` |
| 2 | **Reasoning / thinking blocks** — route-specific reasoning replay vs cache boundaries | Documented (route matrix) + offline structure | Unknown (not on the verified route) | **No** — no captured evidence; generalizing a fix is forbidden (plan §7) | Potentially real on reasoning-replaying routes (GLM preserved thinking; Grok/Muse/Anthropic Responses) — unverified here | High (no evidence) | A real GLM-5.3 preserved-thinking multi-turn session; compare `cache.read` intact vs broken replay (**provider experiment; authorization**) | `docs/phase3-p3t5-reasoning.md`; `RF-OC-046` |
| 3 | **Dynamic instructions / project context** — system-prompt content over time | Offline-verified | **No** (within-session byte-stable; cross-root differs only in `<env>`) | **No** — the `<env>`/date regions already have opt-in relocations; project instructions are intentional and must **not** be frozen | Low — already scoped to the two shipped opt-in relocations | High (freezing user context) | None required; re-verify anchors per OpenCode version | `docs/phase3-p3t4-dynamic-instructions.md`; `RF-OC-045` |
| 4 | **Tool ordering / definitions** — order and schema of request tools | Offline-verified | **No** (deterministic; upstream sorts) | **No** — upstream already sorts; forcing a sort risks duplicating/changing semantics (plan §13) | None observed | High (unnecessary) | Only if a second appended (non-sorted) tool source appears | `docs/phase3-p3t2-tool-ordering.md`; `RF-OC-041`/`RF-OC-042` |

## Advance decision

No cause satisfies **recurring AND avoidable AND safely correctable**:

- **(1) Startup/MCP** is recurring and real, but **not** client-side correctable — the only
  "fix" (block on readiness) is explicitly deferred (plan §13) and adds latency/hang risk.
- **(2) Reasoning** is unobserved offline (insufficient evidence); no fix may be generalized.
- **(3) Instructions/context** is not *unintentional* volatility (user edits are intentional;
  the env/date anchors already have opt-in relocations).
- **(4) Tool ordering** is not recurring (deterministic, correctly sorted).

## Go/no-go

**NO-GO on P3-T7.** No cause advances to a conditional implementation. The Phase-3 exit is
"document and stop": nothing is shipped, and the two shipped Phase-2 capabilities
(`stabilizeSystem` `<env>` relocation; `stabilizeDate`, off) stay as they are.

## Phase-3 kill criterion

**Met.** "No recurring, avoidable, safely-correctable cause ⇒ stop." Phase 3 therefore
closes with **all four threads documented and none advanced** — a valid, evidence-backed
outcome (§15: negative/inconclusive results are valid; completion is not a promotion
criterion).

## Next-experiment backlog (authorization-gated; not Phase-3 work)

1. **Startup/MCP (highest value):** force a same-process second request (tool loop) to
   wire-observe the pending→connected transition and confirm whether MCP tools ever reach
   the wire (`codemode:false` test included).
2. **Reasoning:** a real GLM-5.3 preserved-thinking session to measure `cache.read` with
   intact vs broken reasoning replay (provider experiment).
3. **Tool ordering:** only if a second appended (non-sorted) tool source appears.
4. **Instructions:** whether a project file created *after* first open is re-read (possible
   per-workspace cache; observed/inferred).

## Limitations and integrity

- All Phase-3 evidence is **offline / structural / documented**; **no** provider-measured
  cache effect is claimed. The offline route carries no reasoning, no MCP tool on the wire,
  and a deterministic tool order.
- No managed config/plugin/service/state was touched; captures stayed in the temp root. No
  credentials, prompt/reasoning content, or full bodies were recorded or committed.
