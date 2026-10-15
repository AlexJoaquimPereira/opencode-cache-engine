# Phase 3 — other volatility sources (P3-T1 … P3-T6)

Consolidated Phase 3 record: capture groundwork (T1), tool ordering (T2), startup/MCP
readiness (T3), dynamic instructions/project context (T4), reasoning/thinking (T5), and the
ranked volatility inventory + go/no-go (T6).

---

# Phase 3 — P3-T1: volatility capture groundwork

**Task:** P3-T1 (`TODO.md`) — establish a reusable **offline** procedure that
reproduces the two comparison pairs every Phase-3 thread needs, commit a fixture
set for them, and state an explicit go/no-go **before** ranking any volatility.

**Type:** research — read-only; **offline/mock only**. No request is mutated; no
provider is contacted.
**Depends on:** Phase 1 (G1 met — diagnostics + capture harness).
**Evidence basis:** OpenCode 2.0.26, Node 22.23.2, the Phase 1 capture harness
(loopback mock `127.0.0.1`, `bwrap --unshare-net`, private HOME/XDG).

Evidence labels used here: *Structurally verified* / *Offline/mock verified*.
**Provider measured: not performed.**

## 1. What changed (harness only)

The existing harness ran exactly **two equivalent turns**; it could not produce a
first-vs-subsequent pair nor a ≥3-repeat determinism check. Per the kickoff
contract's "extend only if needed" clause, `inner.sh`/`run.sh` gained two opt-in
knobs (defaults preserve the original two-turn behavior exactly):

- `OC_CAPTURE_TURNS=<n>` — number of equivalent turns (integer ≥ 2; default 2).
- `OC_CAPTURE_CONTINUE=1` — append ONE session-continue turn (`opencode run … --continue`),
  which yields a "subsequent" request in the last session (default 0).

Invalid values fail closed (exit 2), matching the existing timeout validation.
`run.sh` passes both through into the sandbox. Hermetic coverage lives in
`test/harness/capture/exit-contract.test.sh`; the fixture data lives in
`test/fixtures/volatility-shapes.mjs`.

## 2. Procedure

Both pair types are reproduced by the committed harness:

```sh
# equivalent-turn pair (two fresh runs) — unchanged default:
test/harness/capture/run.sh

# first-vs-subsequent pair + ≥3-repeat determinism (3 equivalent turns + 1 continue):
OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 test/harness/capture/run.sh
```

Each run writes serialized request bodies to `<root>/capture/req-NNN.json`; the
post-capture decision (`decide.sh` → `diff-requests.mjs`) pairs requests of the
same *kind* and reports the first differing section/byte with an expected /
unexpected classification. Captured bodies stay in the temp root (only the
harness's own synthetic prompt ever appears) and are never committed.

## 3. Findings (Q1–Q6)

- **Q1 — requests per run / kinds.** One fresh `opencode run --standalone` emits
  **two** requests: first an **aux** (title/summary) request — kind `model,store`,
  **no tools**, roles `system>user` — then the **main** (agent-loop) request —
  kind `max_completion_tokens,model,store,tools`, **12 tools**. A session-continue
  run emits **one** request (the main; the title is not regenerated).
- **Q2 — subsequent-request mechanism.** `opencode run … --continue` produces a
  genuine **subsequent same-session request** (roles grow `system>user>assistant>user`).
  Variadic messages (`opencode run "a" "b"`) do **not** create multiple turns (they
  collapse to one). Hook observability of "startup" is deferred to P3-T3.
- **Q3 — per-section stability.** Across equivalent turns the main requests are
  **byte-identical** (all sections). First-vs-subsequent differs **only** in
  `messages` (conversation growth); `model`, `tools`, and the system message are
  byte-identical (first differing canonical byte ≈ immediately after the system
  message).
- **Q4 — startup tool readiness.** With no MCP configured, no pending/connected/missing
  tool difference was observable on the local warm route (tools byte-identical across all
  requests). The MCP case was investigated in P3-T3 (`RF-OC-044`): a connected MCP server's
  tool never entered the request on this route (Code-Mode default + a readiness race).
- **Q5 — determinism.** Three equivalent turns in one capture were **byte-identical** →
  deterministic ≥3 repeats; a second independent capture reproduced the same structural
  result (same kinds/tools — the `<env>` path differs by capture root, so full bodies are
  **not** cross-root byte-equal).
- **Q6 — non-mutation.** The V2 adapter shim is loaded during capture and the
  requests are byte-identical across repeats; the Phase 1 §3C "diagnostics-only
  leaves the serialized request byte-identical" threshold is met by the existing
  diagnostics tests.

## 4. Observed request shapes (2.0.26, Chat Completions route)

- Main top-level keys: `max_completion_tokens, messages, model, store, stream,
  stream_options, tools`. No `prompt_cache_key` on this (non-GPT, mock) provider.
- **Tool order** (stable across all runs): `edit, glob, grep, question, read, shell,
  skill, subagent, webfetch, websearch, write, execute`. The first **11 are
  ASCII-sorted**; `execute` (the Code Mode tool) is **appended after the sorted
  core** and is therefore **not** in sort position — an ordering signal for P3-T2.
- The **system prompt is inside `messages[0]`** (role `system`, ~7.5 KB on the
  harness project), not a top-level `system` key.
- The system prompt embeds the working directory (`<env>` block), so it varies by
  project path — relevant to P3-T4 (project-context classification).

## 5. Gap surfaced (feeds P3-T4/P3-T3)

Because the system prompt rides inside `messages`, and `diff-requests.mjs`
classifies **every** `messages` change as *expected*, **system-prompt drift is
invisible** to the current classifier. Any Phase-3 thread that must rank system /
instruction volatility (P3-T4) has to compare the system message explicitly
(`messages[0].content`) rather than rely on the section classifier. This is
recorded now so P3-T4 does not mistake "expected" for "stable".

## 6. Deliverables

- Harness knobs + pass-through + hermetic coverage (`inner.sh`, `run.sh`,
  `exit-contract.test.sh`).
- Fixture set: `test/fixtures/volatility-shapes.mjs` (request kinds, tool order,
  pair expectations), consumed by `test/cache-engine.test.mjs`.
- This procedure/report.

## 7. Go/no-go

**GO.** Both pair types reproduce deterministically offline; the downstream ranking
(P3-T2..P3-T5) is supported by these captures. P3-T2 (tool ordering) can proceed
using the recorded tool-order baseline and the equivalent/subsequent pair harness.
Caveat: P3-T4 must use an explicit system-message comparison (see §5).

## 8. Risks and limitations

- The route is a local mock (OpenAI-compatible), not a real provider; §7's
  "provider measured" is explicitly not claimed.
- "Subsequent" is a session-continue request across processes; a *second request
  within one process* (tool-loop) was not required by the contract and is not
  covered.
- Tool order and system size are OpenCode-version-coupled; re-verify per version.

## 9. Cleanup and integrity

- No managed OpenCode config, plugin, service, or user state was touched; captures
  live under the temp root and are not committed.
- No credentials, authorization values, prompt/reasoning content, or full request
  bodies were recorded or committed.


---

## P3-T2 — tool ordering

# Phase 3 — P3-T2: tool ordering (ranked entry)

**Task:** P3-T2 (`TODO.md`) — determine, **from captures**, whether tool ordering /
tool definitions are a recurring, avoidable, safely-correctable cache-volatility
source, and record **one ranked inventory entry** (feeds P3-T6).
**Type:** research — read-only; **offline/mock only**. No request mutated; no provider
contacted.
**Depends on:** P3-T1 (harness `OC_CAPTURE_TURNS`/`OC_CAPTURE_CONTINUE` + fixtures).
**Evidence basis:** OpenCode 2.0.26, Node 22.23.2, mock provider, `bwrap --unshare-net`.

Evidence labels: *Structurally verified* / *Offline/mock verified*.
**Provider measured: not performed.**

## Ranked entry (P3-T6 input)

| Field | Value |
|---|---|
| Cause | Tool ordering / tool definitions on the main request |
| Status | **Observed → NOT a volatility source (no-op)** |
| Frequency | **0 drift** across >=3 runs, equivalent turns, the session-continue turn, and a tool-set change |
| Expected impact | none on the verified route (order and definitions are deterministic) |
| Risk of intervention | high — forcing a sort could duplicate OpenCode's own sort or change semantics; plan §13 defers "Automatic tool sorting" until captures prove avoidable instability |
| Next experiment | only if a **second** non-sorted (appended) tool source appears; the single appended `execute` is the only non-core entry observed |
| Recommendation | **no-op** — do not add tool sorting/normalization |

## Evidence (Q1–Q6)

- **Q1 — order + upstream sort.** The wire order is: 11 core tools ASCII-ascending
  (`edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch,
  write`) with `execute` **appended after** the sorted core (not in sort position).
  Identical across 3 equivalent turns, the session-continue turn, and repeated runs —
  deterministic (`RF-OC-041`).
- **Q2 — definition stability.** The tool **definitions** (name/description/JSON
  schema) are **byte-identical** across equivalent turns / startup / session-continue,
  *and* across **three distinct project roots** with different working directories —
  i.e. descriptions do **not** interpolate the cwd/paths. (The strings "Working
  directory" / "session" appear only as static prose in tool descriptions.) New fact:
  `RF-OC-042`.
- **Q3 — tool-set change.** Disabling built-in tools via a disposable project config
  (`"tools": { "webfetch": false, "websearch": false }`) re-sorts the core cleanly to 9
  tools and keeps `execute` **last** (`edit, glob, grep, question, read, shell, skill,
  subagent, write, execute`). No order drift; the tail position of `execute` is stable.
- **Q4 — fingerprints.** `toolFingerprint` (order-insensitive) and
  `toolWireFingerprint` (order-sensitive) are **equal and stable** across all captured
  mains (semantic `08fa2584…`, wire `65ffbde1…`) — no reorder with a fixed set, no
  definition change.
- **Q5 — linter.** `lintSystemVolatility` emits **no** tool finding on equivalent
  requests and correctly flags `VOL-TOOL-SET` on a 12→10 set change and
  `VOL-TOOL-ORDER` (worst `medium`) on a same-set reorder — i.e. the tool rules are
  true-positive-capable, no false positive on the stable case.
- **Q6 — correction.** No semantic-safe correction is warranted: upstream already sorts,
  and the only non-sorted element (`execute`) is appended deterministically. **Outcome:
  no-op.**

## Structural notes

- OpenCode sorts the core tools ASCII-ascending before sending, then `execute` (the Code
  Mode tool) is appended after the sort. This matches the `toolWireFingerprint` caveat
  (`src/cache-engine-core.mjs`): the plugin's wire fingerprint is *registry order*, not
  byte-equal to the provider's sorted order; here both were stable anyway.
- Tool definitions are static text; only `messages[0]` (the system prompt) embeds the
  working directory (see `RF-OC-040` §5 of the P3-T1 report) — not the tools.

## Risks and limitations

- The route is a local mock; **no provider-measured** claim.
- Only one non-core (appended) tool (`execute`) was observable; a scenario with two+
  appended tools was not exercised (recorded as the next experiment).
- "Upstream sorts" is inferred from the ASCII-sorted wire order for a varying set
  (12 vs 10 tools); it is consistent and repeatable but not read from OpenCode source.

## Cleanup and integrity

- No managed config/plugin/service/state touched; captures under the temp root only.
- No credentials, prompt/reasoning content, or full bodies recorded or committed.


---

## P3-T3 — startup / MCP readiness

# Phase 3 — P3-T3: startup / MCP readiness (ranked entry)

**Task:** P3-T3 (`TODO.md`) — determine, **from captures**, whether OpenCode startup /
MCP readiness introduces a recurring, avoidable, safely-correctable prefix difference
between the first request after process start and subsequent requests, and whether the
plugin hook can observe readiness. One ranked inventory entry (feeds P3-T6).
**Type:** research — read-only; **offline/mock only**. No request mutated; no provider.
**Depends on:** P3-T1 (harness + pair capture).
**Evidence basis:** OpenCode 2.0.26; our offline captures (mock provider, local stdio MCP
server, private HOME/XDG, `--print-logs`), plus a first-party **source** review of the
`v2.0.26` tree.

Evidence labels: *Observed* / *Structurally verified* / *Offline-verified*.
**Provider measured: not performed.**

## Ranked entry (P3-T6 input)

| Field | Value |
|---|---|
| Cause | Startup / MCP readiness (first request after process start vs subsequent) |
| Status | **Observed + structurally verified → a real race, but no safe correction now (no-op / watch item)** |
| Frequency | MCP connects around/after the request's tool snapshot (~0.6 s after spawn; log `http.span=403`) on every process start (0/≥5 probes put an MCP tool on the wire) |
| Expected impact | a first request that omits MCP-provided tools can differ from later requests (a prefix invalidator) — **mechanism confirmed**, wire effect not directly observed (one-shot `run`) |
| Risk of intervention | high — blocking on MCP readiness adds latency/hang risk; plan §13 defers "Blocking on MCP readiness" |
| Next experiment | a **same-process second request** (tool-loop) to wire-observe a pending→connected transition; confirm whether a `codemode:false` tool reaches the wire |
| Recommendation | **no-op** — do not block; do not normalize |

## Evidence (Q1–Q5)

- **Q1 — no-MCP baseline.** The first request after startup and the session-continue
  request are identical in `tools`/`system`; only `messages` grows (`RF-OC-040`).
- **Q2 — with a local MCP server.** A local stdio MCP server connects
  (`mcp connected server=slow tools=1`) but its tool **never** appeared in the request
  `tools` (12 built-ins) across probes — under the default, under global
  `tools: {"*": true}`, under a per-agent `agents.<name>.tools` enable (both are **v1
  legacy** keys here), and even with `codemode: false`. The cause is now explained: (a)
  MCP tools default to **Code Mode** (folded into `execute`, absent from the `tools`
  array), and (b) the first request **races** the forked MCP connect (`mcp connected`
  ≈0.6 s after spawn, around/after the tool snapshot). See `RF-OC-044` (which supersedes
  `RF-OC-043`).
- **Q3 — hook visibility.** The V2 `context` hook payload **includes `tools`**, and it
  **is the on-wire list** (`direct` tools + `execute`), not the full registry — Code-Mode
  / MCP tools are absent from it (`RF-OC-018`, `RF-OC-044`). So a plugin can observe the
  *on-wire* tool list per request, but there is **no dedicated "tools ready" signal**; MCP
  readiness is only visible indirectly (the `context` map + MCP bus events
  `mcp.status.changed` / `mcp.tools.changed`).
- **Q4 — avoidable?** The race is inherent to OpenCode's non-blocking design
  (`mcpTools.flush` awaits only the first discovery pass; connect is forked; a 100 ms
  debounced reload publishes tools later). Making the prefix deterministic would require
  OpenCode to block, which is out of scope (and deferred). No safe correction on our side.
- **Q5 — rank.** Watch item with a **confirmed mechanism**. Not advanceable to a fix
  without a same-process second-request capture (to prove the wire difference) and an
  explicit decision about blocking.

## Structural notes

- **MCP tools are Code-Mode by default** (`codemode: true`) and are folded into the single
  `execute` tool (id namespace `<server>_<tool>`); `codemode: false` is the (undocumented)
  way to expose one as a native wire tool. This also explains why `execute` is appended
  after the sorted core (`RF-OC-041`).
- **Config keys:** v2 native is `permissions` + `agents` (plural) + MCP `disabled`; the
  v1 surface (`tools` map, `permission`, `agent` singular, MCP `enabled`) is migrated.
  Tool admission is subtractive (only a whole-tool `deny` removes a tool). `opencode run`
  has no MCP-specific admission branch; its only run-mode difference is permission
  auto-answering.
- The system prompt (not the tools) embeds the working directory (`RF-OC-040`).

## Risks and limitations

- **Not wire-observed:** the pending→connected *transition* was not captured directly
  (one-shot `run` cannot produce a same-process second request); the race is structurally
  verified from source + timing-observed. A `codemode:false` tool reaching the wire was
  likewise not confirmed offline.
- Local mock route only; **no provider-measured** claim. The MCP server was a minimal
  synthetic stdio server.
- Source review is at `v2.0.26`; the public docs still describe the v1 surface
  (`tools`/`agent`/`enabled`), so docs vs schema drift is expected.

## Cleanup and integrity

- No managed config/plugin/service/state touched; all probes used a disposable temp
  HOME/project + loopback mock; the probe MCP server lived in `/tmp` only.
- No credentials, prompt/reasoning content, or full bodies recorded or committed.


---

## P3-T4 — dynamic instructions & project context

# Phase 3 — P3-T4: dynamic instructions & project context (ranked entry)

**Task:** P3-T4 (`TODO.md`) — classify the dynamic content of the system prompt / project
context observed between requests as unintentional volatility, intentional update, or
potentially-stale frozen content, and record one ranked inventory entry (feeds P3-T6).
**Type:** research — read-only; **offline/mock only**. No request mutated; no provider.
**Depends on:** P3-T1 (harness + pair capture).
**Evidence basis:** OpenCode 2.0.26, Node 22.23.2, mock provider + disposable projects,
private HOME/XDG.

Evidence labels: *Structurally verified* / *Offline-verified*.
**Provider measured: not performed.**

## Ranked entry (P3-T6 input)

| Field | Value |
|---|---|
| Cause | Dynamic content of the **system prompt / project context** |
| Status | **Observed → no-op** (no *unintentional* volatility beyond the two already-shipped opt-in relocations) |
| Frequency | within a session: **0** change (system byte-identical); **cross-root**: `<env>` block only (cwd/workspace paths); instruction-file edits: user-driven (**intentional**) |
| Expected impact | cross-root `<env>` — already handled by the opt-in `stabilizeSystem` (`<env>` relocation, GLM-5.3/MiMo-V2.6) and the daily date by `stabilizeDate` (off) |
| Risk of intervention | high — freezing project instructions, skills, or workspace state is explicitly forbidden (plan §7/§13) |
| Next experiment | none required; re-verify the anchors per OpenCode version. (Optional: confirm whether a project file created *after* first open is re-read — see limitation.) |
| Recommendation | **no-op** — do not freeze project instructions/skills/workspace |

## Evidence (Q1–Q5)

- **Q1 — what varies.** Within one capture (equivalent turns + session-continue) the
  system content (`messages[0].content`) is **byte-identical** (8267 chars, first
  difference at end-of-string). Across **two project roots** it differs **only** inside
  the `<env>` block — `Working directory:` / `Workspace root folder:` — first differing
  byte ~7782, localized to the cwd/workspace paths. No other region varied.
- **Q2 — instruction files.** A project `AGENTS.md` is **injected into the system prompt**
  as `<absolute path>\n<contents>`, positioned immediately **before** the daily date line
  (e.g. `…/AGENTS.md\nRule: … PINEAPPLE …\n\n\nToday's date: …`). It loaded in a **git
  repo** and in a **non-git** directory (both observed). Editing it is therefore an
  **intentional update** (user-authored), *not* volatility. (One probe created the file
  *after* the project was first opened and a later run did **not** reflect it — see the
  limitation.) New fact: `RF-OC-045`.
- **Q3 — linter.** `lintSystemVolatility` flagged exactly `VOL-CWD-PATH` and `VOL-DATE`,
  both **`info`** (allowlisted intentional volatility) — true positives, no false `high`.
- **Q4 — avoidable?** The only dynamic regions are (a) the `<env>` block (cwd/workspace),
  (b) the daily date, and (c) user instruction files. (a) and (b) already have opt-in,
  content-preserving relocations; (c) must **not** be frozen. Nothing new is *unintentional*
  and *safely* correctable → **no-op**.
- **Q5 — rank.** No new cause. This entry mainly **confirms the scope** of the two shipped
  opt-in relocations and the prohibition on freezing user context.

## Structural notes

- The system prompt embeds the working directory (the `<env>` block); the tools do not
  (`RF-OC-042`). Instruction-file bytes sit just before the daily date line (`RF-OC-045`).
- Because the system rides inside `messages`, the section diff classifies any system change
  as "expected" (`RF-OC-040`); P3-T4 therefore compared `messages[0].content` explicitly.

## Risks and limitations

- **One anomaly, unresolved:** a project `AGENTS.md` created *after* the project was first
  opened was **not** reflected in a subsequent run in one probe (possibly a per-workspace
  instruction cache, or a watcher timing effect). This does not affect the conclusion (the
  file is not *cache-engine* volatility and must not be frozen either way) but is recorded
  as observed/inferred, not verified.
- Local mock route only; **no provider-measured** claim.

## Cleanup and integrity

- No managed config/plugin/service/state touched; disposable temp HOME/projects + loopback
  mock only. No credentials, prompt/reasoning content, or full bodies recorded or committed.


---

## P3-T5 — reasoning / thinking blocks

# Phase 3 — P3-T5: reasoning / thinking blocks (ranked entry)

**Task:** P3-T5 (`TODO.md`) — determine whether reasoning/thinking blocks produce a
route-specific cache-boundary/prefix effect we can **observe**, and record one ranked
entry (feeds P3-T6). A no-op / insufficient-evidence outcome is acceptable; do not
generalize a fix without captured evidence.
**Type:** research — read-only; **offline/mock only**. No request mutated; no provider.
**Depends on:** P3-T1 (harness + pair capture).
**Evidence basis:** OpenCode 2.0.26; our offline captures; the plugin's reasoning
diagnostics; the tracked inventory.

Evidence labels: *Structurally verified* / *Offline-verified* / *Documented* / *Unknown*.
**Provider measured: not performed.**

## Ranked entry (P3-T6 input)

| Field | Value |
|---|---|
| Cause | Reasoning / thinking blocks — route-specific interaction with cache boundaries |
| Status | **Insufficient evidence on the verified route → no-op** (route matrix documented) |
| Frequency | **0** on the offline mock route (no reasoning content in any captured request); route-specific elsewhere (documented) |
| Expected impact | potentially real on reasoning-replaying routes (GLM preserved thinking; Grok/Muse/Anthropic Responses) — **not observed** offline |
| Risk of intervention | high — no captured evidence; generalizing a fix is explicitly forbidden (plan §7) |
| Next experiment | observe a route that actually **carries reasoning in the request** (e.g. a real GLM-5.3 preserved-thinking multi-turn session) and compare `cache.read` with intact vs broken replay |
| Recommendation | **no-op** — keep the existing GLM reasoning-integrity diagnostic; add nothing |

## Evidence (Q1–Q5)

- **Q1 — does reasoning appear on the verified route?** No. Across a fresh capture (2
  equivalent turns + a session-continue turn), every request's messages are
  `system:{role,content}` / `user:{role,content}` / `assistant:{role,content}` only — no
  `reasoning` / `reasoning_content` / `reasoning_details` / `thinking` fields, and no
  top-level reasoning keys (`max_completion_tokens, messages, model, store, stream,
  stream_options, tools`). New fact: `RF-OC-046`.
- **Q2 — existing diagnostic.** `detectReasoningIssues(currentSeq, lastSeq, seen)` fires
  correctly on all four issue classes — within-message duplicate, cross-message duplicate,
  reordered replay, and modified (substituted) block — and returns clean on a no-issue
  case; `reasoningIssueReasons` maps them to `reasoning_duplicate_detected`,
  `reasoning_reordered`, `reasoning_modified`. It is wired in **V1** only, gated by the GLM
  policy capability `thinkingIntegrity` **and** the config `preserveThinkingIntegrity`
  (MiMo's `preserveThinkingIntegrity` is instrumentation-only and never rewrites content).
  V2 intentionally does not port reasoning diagnostics (adapter header).
- **Q3 — route matrix (documented, `docs/cache-policy-inventory.md`).** Reasoning handling
  is **route-specific**: GLM-5.3 *preserved thinking* is cache-friendly only when the prior
  `reasoning_content` is replayed complete, unmodified, and in original order; Grok
  preserves prior `reasoning_content` or uses stateful Responses continuation
  (`previous_response_id` / encrypted reasoning); Muse: Chat cannot carry reasoning for
  external keys → Responses `previous_response_id` / encrypted replay; Anthropic: preserve
  the full assistant message and `thinking` blocks (with `signature`) in multi-turn tool
  use (**not** stated as a cache requirement); GPT: `reasoning.effort` affects prefix
  matching; Kimi K3: `reasoning_effort` switching invalidates prefix hits.
- **Q4 — observed avoidable effect?** None: the verified route carries no reasoning, so no
  prefix effect is observable offline. Any real effect is on routes we cannot exercise
  without a provider — **insufficient evidence**.
- **Q5 — rank.** Documented-and-route-specific, not observable here → no-op. The one
  actionable signal (GLM replay integrity) is already instrumented; no new cause.

## Structural notes

- The offline route's assistant messages carry only `content` — reasoning is dropped from
  the request on a plain OpenAI-compatible Chat Completions path, consistent with the
  inventory's "Chat cannot carry reasoning for external keys" (Muse) and the general
  route-specificity.

## Risks and limitations

- Reasoning/thinking effects are inherently provider-specific and were **not** observed;
  conclusions rest on documents + offline structure, not measurement.
- A fix cannot be validated offline; any future reasoning-related change needs a provider
  experiment plus the existing diagnostic as the structural guard.

## Cleanup and integrity

- No managed config/plugin/service/state touched; harness captures under the temp root
  only. No credentials, prompt/reasoning content, or full bodies recorded or committed.


---

## P3-T6 — ranked volatility inventory + go/no-go

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
| 1 | **Startup / MCP readiness** — the first request after process start can be assembled before the forked MCP connect completes | Observed + **structurally verified** (source) | **Yes** (every process start) | **No** — inherent to OpenCode's non-blocking design; a fix = blocking on readiness, deferred (plan §13) | A first request omitting MCP-provided tools differs from later requests → a real prefix invalidator (wire effect not directly observed) | High (blocking adds latency/hang risk) | Same-process **second request** (tool-loop) to wire-observe the pending→connected transition | `docs/phases/phase3-other-volatility.md`; `RF-OC-044` |
| 2 | **Reasoning / thinking blocks** — route-specific reasoning replay vs cache boundaries | Documented (route matrix) + offline structure | Unknown (not on the verified route) | **No** — no captured evidence; generalizing a fix is forbidden (plan §7) | Potentially real on reasoning-replaying routes (GLM preserved thinking; Grok/Muse/Anthropic Responses) — unverified here | High (no evidence) | A real GLM-5.3 preserved-thinking multi-turn session; compare `cache.read` intact vs broken replay (**provider experiment; authorization**) | `docs/phases/phase3-other-volatility.md`; `RF-OC-046` |
| 3 | **Dynamic instructions / project context** — system-prompt content over time | Offline-verified | **No** (within-session byte-stable; cross-root differs only in `<env>`) | **No** — the `<env>`/date regions already have opt-in relocations; project instructions are intentional and must **not** be frozen | Low — already scoped to the two shipped opt-in relocations | High (freezing user context) | None required; re-verify anchors per OpenCode version | `docs/phases/phase3-other-volatility.md`; `RF-OC-045` |
| 4 | **Tool ordering / definitions** — order and schema of request tools | Offline-verified | **No** (deterministic; upstream sorts) | **No** — upstream already sorts; forcing a sort risks duplicating/changing semantics (plan §13) | None observed | High (unnecessary) | Only if a second appended (non-sorted) tool source appears | `docs/phases/phase3-other-volatility.md`; `RF-OC-041`/`RF-OC-042` |

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
