# Phase 2 — date relocation (P2-T1 … P2-T5)

Consolidated Phase 2 record: P2-T1 hook-shape research, P2-T4 provider A/B, and P2-T5
acceptance decision. (P2-T2 implementation and P2-T3 wire verification live in `src/` and
`test/`.)

---

# Phase 2 — P2-T1 report: date-relocation hook shape

**Task:** P2-T1 (see `TODO.md`) — verify the date-relocation hook shape, per route.
**Type:** research — read-only; **offline/mock only**. No request mutation.
**Toolchain:** OpenCode **v2.0.26** (`~/.opencode/bin/opencode`); Node 22.23.2;
`@opencode/plugin` 2.0.16.
**Harness:** `test/harness/capture/` (`bwrap --unshare-net`, loopback mock,
`opencode run --standalone`).
**Evidence labels:** *Observed* / *Structurally verified* / *Offline-mock verified*.
**Provider measured: not performed** (no provider requests, no credentials).

> Status: **complete** — §4/§5 confirmed by both lanes. **P2-T2:** the date-line
> relocation (`relocateVolatileDateLine` + the `stabilizeDate` policy flag) is
> implemented for V1 and V2, **default off** (experimental). **P2-T3:** the
> relocation is **wire-verified** (§5A, gate G3) for GLM-5.3 / MiMo-V2.6; the
> neutral control is unchanged. Provider-side benefit is still unmeasured (P2-T4).

---

## 1. What was captured

`test/harness/capture/run.sh` with `OC_CAPTURE_TURN_TIMEOUT=60`, model
`mock/synthetic` (neutral family → **no CacheEngine transform** runs; this is the
raw OpenCode shape). Exit `0`; 4 requests captured (2 request kinds × 2 turns).

The **primary agent request** (pair kind `max_completion_tokens,model,store,tools`)
carried a serialized Chat Completions system message of **7532 bytes / 165 lines**.
The auxiliary request (title/summary kind) had no `<env>`/date section.

## 2. Verified OpenCode 2.0.26 system shape (*Observed*, offline-mock)

Byte/line map of the primary system message:

| Marker | Line | Byte offset |
|---|---:|---:|
| `# Your Model` | 20 | 1472 |
| `</available_skills>` | 153 | 6862 |
| **`Today's date: Wed Oct 14 2026`** | **155** | **6883** |
| `Here is some useful information about the environment you are running in:` | 157 | 6914 |
| `<env>` | 158 | 6988 |
| `</env>` | 164 | 7287 |
| `When you create a worktree outside the current working directory …` | 165 | 7294 |

- **The daily date is a standalone line, OUTSIDE the `<env>` block**, immediately
  **before** the intro line and the block. Format: `Today's date: <EEE MMM D YYYY>`
  (e.g. `Today's date: Wed Oct 14 2026`), not `YYYY-MM-DD`.
- The `<env>` interior fields: `Working directory:` / `Workspace root folder:` /
  `Is directory a git repo:` / `Platform:` / `Prefer /tmp/opencode …`. **No date
  line inside `<env>`.**
- **No `You are powered by the model named ` START marker.**
- Stable prefix before the date line = **6883 B of 7532 (91 %)**.
- The only other session-varying field is the `Working directory:` path (stable
  within a session; it contains the project path).

## 3. Current transform and linter behavior on this shape (*Observed*, code-level)

- `relocateVolatileEnvBlock(sysText)` → `changed: true` (7532 → **7533**): it moves
  the `<env>…</env>` block to the tail (structural path, `isOpenCodeEnvInterior`),
  inserting one separator `\n`. The **date line does not move** — it stays
  mid-prompt, so a daily change still truncates the stable prefix at byte 6883.
- `lintSystemVolatility(sysText)` → `VOL-DATE` (info, allowlisted) and
  `VOL-CWD-PATH` (info, allowlisted). Nothing high-severity.

**Consequence:** the existing `<env>` overlay fires on 2.0.26 but does **not**
address the daily-volatile byte (the date line). Phase 2's candidate transform
("move only the date line to the end of the containing system text") targets a
different element than the current overlay.

## 4. V2 `context`-hook part shape — *confirmed* (offline instrumentation)

`event.system` is an **array of text parts** `{ type: "text", text }`. The verified
2.0.26 primary request delivers **four** parts:

| # | len | content | `<env>` | date |
|---|---:|---|:--:|:--:|
| 0 | 1471 | agent/harness prompt (ends `…investigate before deleting or overwriting them.`) | no | no |
| 1 | 80 | `# Your Model` (Name / Provider ID / Model ID) | no | no |
| 2 | **5748** | skills/mode + **date line** + intro + **`<env>` block**; **ends with `</env>`** | **yes** | **yes** |
| 3 | 238 | worktree paragraph | no | no |

- The **date line and the `<env>` block share part 2**, and the `<env>` block is
  **already at part 2's end**.
- Therefore `relocateVolatileEnvBlock(part2)` → `changed:false` (the block is
  already terminal), so the env relocation is a **wire no-op** (§5).
- A **date-line relocation within part 2** *does* change it (moving the date from
  before the intro to after `</env>`): implementable as a single-part transform,
  **bounded by the part boundary** — the date cannot move past part 3.

**Cross-checks (Lane A memo; `RF-OC-018`, `RF-OC-032`):** `SystemPart = { type, text }`
confirmed (`@opencode/plugin` 2.0.16 types). The wire merges all parts into **one**
`messages[0].content` system message; the **inter-part join separator is not pinned**
(open gap). There is **no positive evidence that hook `system` mutations reach the
wire** — RF-OC-032's same-object dispatch is verified only for `options`, and the
plan's *Wire verified* bar requires reading the serialized request, so P2-T3 must
attribute any wire effect by capture.
Binary probe: `"You are powered by the model named"` is **absent** from the 2.0.26
binary; `"Today's date: "`, `"Here is some useful information about the environment"`,
`"Workspace root folder"` are present.

## 5. Per-family wire behavior (neutral / GLM-5.3 / MiMo-V2.6) — *directly verified*

Three offline captures (`OC_CAPTURE_MODEL` = `mock/synthetic`, `mock/glm-5.3-flash`,
`mock/mimo-v2.6-flash`; roots `capture.Fo1E74`/`capture.kheAiC`/`capture.LJSyQs`):

- Telemetry confirms the adapter ran and classified correctly:
  `policy: "glm53"` / `"mimo26"`, `provider: "mock"`, `model` = the set id
  (neutral produced no telemetry).
- **The serialized system text is byte-identical across the three models except the
  `# Your Model` Name/Model-ID lines** (first difference at byte 1493; length deltas
  only from those names).
- In every capture the `<env>` block is still followed by the worktree paragraph
  (GLM: `</env>` at 7295, worktree at 7302; the message ends with the worktree
  text). **The `<env>` relocation did not reach the wire for GLM or MiMo.**
- Per-model wire numbers (primary request): baseline **7532 B** (date@6883, `<env>`
  6988–7287) · GLM **7540 B** (date@6891, 6996–7295) · MiMo **7544 B** (date@6895,
  7000–7299). The only cross-model deltas are the `# Your Model` name/id lines.
- **So the effective 2.0.26 wire behavior is still a no-op** — not because the
  helper rejects the shape (it accepts it and returns `changed:true` in isolation,
  §3), but because of the **part boundary**: the eligible part ends at `</env>`
  (or is the block itself), so relocating the block *within its own text part*
  changes nothing. This is the decisive structural constraint for any
  date-relocation design: **a within-part move cannot reorder content across part
  boundaries.** The exact part structure is confirmed in §4 (4 parts; date + `<env>`
  share part 2, which ends at `</env>`).

*(Lane B memo `ses_ec56c6d30ffeSi2G7xgM4zM6l3` merged — independently confirms
§4–§5 with a second capture set and matches `RF-OC-035`.)*

## 5A. P2-T3 — serialized-request (wire) verification (gate G3)

Offline, on the **serialized** request (not hook/adapter output): the harness
(`run.sh` with `OC_CAPTURE_MODEL` and `OC_CAPTURE_ENGINE_CONFIG`, which writes
`~/.config/opencode/cache-engine.json` into the sandbox) ran an off/on pair per
model, and `verify-date-relocation.mjs` compared the primary system content. Byte
lengths/offsets below are on the temp-root-normalized text (`capture.XXXXXX` →
`capture.RUN`), exactly as the verifier reports them.

| model | off root / req | off len | off date / `<env>` | on root / req | on len | on date / `<env>` | Δlen |
|---|---|---|---|---|---|---|---|
| GLM-5.3 | `capture.BkwWDE` / `req-002` | 7534 | 6891 / 6996–7289 | `capture.Wk7oPP` / `req-002` | 7535 | 7267 / 6967–7260 | +1 |
| MiMo-V2.6 | `capture.OYXMRU` / `req-002` | 7538 | 6895 / 7000–7293 | `capture.lAtKeA` / `req-002` | 7539 | 7271 / 6971–7264 | +1 |
| neutral | `capture.EORRzN` / `req-002` | 7526 | 6883 / 6988–7281 | `capture.CWdRpz` / `req-002` | 7526 | 6883 / 6988–7281 | 0 |

Checks (all pass for GLM/MiMo; the neutral control is `--unchanged`): exactly one
anchored date line and one `<env>` pair in each text; **off** date before `<env>`;
**on** date after `</env>` with the date value unchanged; and — order-sensitively —
the text with only the date line's bytes removed identical apart from at most the
one optional separator `\n`. The neutral run (transform on) is identical after
temp-root normalization. (The roots are ephemeral harness temp dirs; the numbers
above are the verifier's report for that run.)

This establishes **G3** (the serialized request carries the intended change) for
the tested shim route and positively closes the `system` hook→wire gap flagged in
§4 (`RF-OC-036`). It is a **structural** result — provider cache benefit remains
unmeasured (P2-T4).

Hermetic coverage: `date-relocation.test.sh` (part of `npm run test:harness`)
checks the verifier's exit contract (correct relocation; no-relocation; unchanged
control with temp-root normalization; changed date value; duplicate date line;
`capture/` subdir layout; multi-file largest-selection; two blockers).
`verify-date-relocation.mjs` deliberately does **not** import the transform helper,
so it cannot pass by sharing the implementation's logic.

## 6. Anchor-per-version table

| OpenCode version | Delivery | Date position | Date format | Inside `<env>`? | Current transform |
|---|---|---|---|---|---|
| **2.0.26** (verified) | V2 `context` hook (shim route) | standalone line before `<env>` | `EEE MMM D YYYY` | **no** | `<env>` relocated to tail; **date not moved** |
| 1.18.34 | V1 `experimental.chat.system.transform` | inside `<env>`, after the model-name preamble (fixture shape; real 1.18.34 wire **not** captured — that binary is not installed) | `YYYY-MM-DD` in fixtures (normalized; real format unconfirmed) | **yes** | legacy marker path |
| 1.18.27 | (competitor `C5`, **author-reported**) | inside `<env>` | `Today's date: …` | **yes** | n/a |

## 7. Reconciliation

- **Competitor `C5`** (`opencode-consistent`) states the date lives **inside `<env>`**
  on **1.18.27** — *author-reported*, not verified. It does **not** match our
  verified 2.0.26 shape (date **outside**, before `<env>`). The anchor is
  **version-dependent**; do not assume one anchor across versions.
- **`RF-OC-033`** and **plan §2C** both claim the GLM/MiMo `<env>` relocation is a
  **no-op** on the captured 2.0.26 shape (START marker absent). This is **stale**:
  `RF-OC-033` was verified at checkpoint **`2a00607` (2026-10-12 22:49)**, which
  **predates** the structural-eligibility commit **`7b085c6` (2026-10-13 16:32)**
  and its hardening (`4ed1a8f`, `36323e7`). The helper changed, which is
  `RF-OC-033`'s own re-verify trigger. Current code fires the structural path.
- The competitor research report (§ "Lesson for us", line ~116) repeats the stale
  "relocation is currently a no-op" claim and should not be cited as current.
- **Supersede `RF-OC-033`** with a finding recording the structural path and the
  verified 2.0.26 date anchor.

## 8. Fixture corpus

`test/fixtures/date-relocation-shapes.mjs` — offline *shape* fixtures (P2-T1
deliverable; consumed by P2-T3). Cases: the verified `oc2_0_26` tail (date outside
`<env>`), the legacy `1.18.34` marker shape (date inside `<env>`), no-date,
duplicate-date, malformed-value, label-without-value, no-`<env>`, a multi-part
eligible case, and a non-text-part case; plus a `FAMILY_CLASSIFICATION` sample
(GLM-5.3 / MiMo-V2.6 / neutral). Validated for count/marker consistency (9/9).

## 9. Go/no-go

**GO (research level) — the shape permits a content-preserving date-line relocation.**
The daily date is a **single identifiable standalone line inside one mutable text
part** (part 2), with a stable anchor `Today's date: `; it is the only
daily-volatile byte (the `<env>` block and cwd are session-stable). Moving it to the
end of part 2 preserves every non-date byte and the non-empty line multiset with the
date value/format unchanged.

**Constraints the implementation (P2-T2) must respect**

- **Bounded by part 2**: the date can move only within part 2, not past part 3
  (worktree paragraph). Expected stable-prefix gain is modest (~the intro + `<env>`
  block ≈ 400 B of 7532).
- **Interaction with the existing `<env>` relocation**: on 2.0.26 that overlay is
  already a wire no-op (§5), so a date move must not reintroduce a competing
  reorder; define ordering (env first, then date — or a single combined move) and
  keep it idempotent.
- **Version guard**: 1.18.34's real wire shape was **not** captured (its binary is
  not installed); the legacy fixture shape differs (date *inside* `<env>`), so the
  transform must be version/shape-gated and no-op on the legacy shape.
- **Benefit is a provider-measurement question** (P2-T4), not proven by structure.

**No-go conditions**: duplicate / malformed / absent date; date not confined to a
single eligible text part; ambiguous anchor; part boundary not as captured.

## 10. Open questions

1. ~~Hook part structure~~ — **resolved** (§4): four text parts; date + `<env>` share
   part 2, which ends at `</env>`.
2. Ordering of a date move relative to the (2.0.26 no-op) env move — a design
   decision for P2-T2.
3. Whether the date line ever appears inside `<env>` on **1.18.x** — needs a 1.18.x
   capture (that binary is not installed); the legacy fixtures assume it does.


---

## P2-T4 — provider A/B report

# Phase 2 — P2-T4 report: provider-side A/B for the date-line relocation

**Task:** P2-T4 (see `TODO.md`) — measure whether the `stabilizeDate` date-line
relocation improves provider-reported prefix-cache reuse across a date change.
**Type:** measurement (authorized). **Evidence label:** *Provider measured*.
**Status:** **directional support** (on the pinned route, every nonce-isolated trial
showed ON >= OFF), but **G4 not cleanly passed** — the rollover was simulated and the
magnitude is variable. **Still open:** a real-calendar >=2-rollover confirmation.

## Objective
From provider-reported usage, determine whether relocating the daily date line to
the system-prompt tail (candidate) yields a larger reused cached prefix than
leaving it before `<env>` (baseline) when the date changes (§6, §3C).

## Measurement machinery
- **Route:** OpenRouter with the user's pinned providers — GLM `z-ai/fp8` -> **Z.AI**,
  MiMo `xiaomi/fp8` -> **Xiaomi** (observed via the response `provider` field).
- **Capture/rewrite:** a disposable project overrides the endpoint
  (`provider.openrouter.options.baseURL` -> local proxy); the proxy captures routing
  metadata and rewrites the `Today's date: ...` value to **simulate** a rollover.
- **Plugin:** the project `.opencode/plugins/<shim>.ts` loads only under
  `opencode run --standalone`; `stabilizeDate` is enabled by pointing `HOME` at a
  temp dir holding `~/.config/opencode/cache-engine.json` while `XDG_CONFIG_HOME`
  stays **real** (so the pins load). No managed config was modified.
- **Isolation:** each trial uses a **unique stable prefix** (nonce) so prior runs'
  caches cannot carry over.
- **Usage:** OpenCode session DB `session_message.data.tokens.cache.{read,write}`
  (the plugin's own telemetry does not fire headless).

## Findings — provider measured (pinned route, nonce-isolated, simulated rollover "Wed 14" -> "Thu 15" Oct 2026)
| model | trial | OFF `cache.read` | ON `cache.read` | delta |
|---|---|---:|---:|---:|
| GLM-5.3 Flash (Z.AI) | A | 8128 | 10240 | +2112 |
| GLM-5.3 Flash (Z.AI) | B | 10240 | 10304 | +64 |
| GLM-5.3 Flash (Z.AI) | C | 10240 | 10304 | +64 |
| MiMo v2.6 Flash (Xiaomi) | A | 4096 | 10240 | +6144 |
| MiMo v2.6 Flash (Xiaomi) | B | 8192 | 10240 | +2048 |
| MiMo v2.6 Flash (Xiaomi) | C | 10240 | 10240 | 0 |

- **ON >= OFF in 6/6** (no sign flip): directionally consistent with the mechanism
  (date at the tail -> a longer surviving prefix after the rollover).
- Magnitude varies (0..+6144) and values cluster near ~10240, suggesting a provider
  cached-prefix **cap** can saturate the difference (when the baseline already hits
  the cap, the delta is 0).

## Corrections to earlier statements (this session)
- The **first A/B pass was invalid**: it used a *temp* `XDG_CONFIG_HOME` (no pins),
  so the requests carried `provider: null` and OpenRouter load-balanced (GLM was
  served by "Near AI", not Z.AI). Those numbers are discarded.
- "GLM reports no caching" was measured on the **old pin** (streamlake/novita) / an
  unpinned route. With the pin binding to Z.AI, GLM **does** report reads (e.g.
  23616 of 23673 cached on an identical repeat).
- The provider pins are sent verbatim and honored (GLM -> z-ai, MiMo -> xiaomi);
  the earlier novita/makora sighting was the pre-binding state.

## Changes
- **Files changed:** none in the repository (disposable projects + a local proxy
  under `/tmp/opencode`). **Behavior changed:** none (`stabilizeDate` stays off by default).

## Validation
- **Provider requests made: yes** (OpenRouter; small spend). **Credentials accessed: no**
  (used by OpenCode from its store; never read or logged).
- No offline/structural change (G2/G3 unchanged from P2-T2/P2-T3).

## Acceptance criteria
- [ ] Reproducible `cache.read` increase, directionally consistent, across >=2
      **real** rollovers — **partial**: directionally consistent on the pinned route
      (6/6, no sign flip), but **simulated** rollovers and a variable magnitude.
- [x] Measurement machinery established and reproducible.

## Risks and limitations
- **Simulated** rollover (proxy date rewrite), not a real calendar rollover (§6).
- Variable magnitude; a possible provider cached-prefix cap saturates the delta.
- n=3 per model; OpenRouter routing/TTL remain confounders.

## Cleanup and integrity
- Temporary artifacts: `/tmp/opencode/{t4proxy.mjs,t4ab.sh,t4route,t4home,phase2-p2t4-*}`
  (plus the disposable experiment project).
- Worktree status: repository unchanged by this task.
- Managed config/services untouched.

## Recommendation
**Directional support, not a clean provider-measured benefit.** Keep `stabilizeDate`
**experimental (default off)**; the signal justifies a **real-calendar >=2-rollover
confirmation** before any promotion (G4). The structural work (G2/G3) stands.

## Reproduction (measurement procedure)
1. **Route/pins:** OpenRouter with the pinned providers (GLM `z-ai/fp8` -> Z.AI,
   MiMo `xiaomi/fp8` -> Xiaomi). Real `XDG_CONFIG_HOME` must be used so the pins load.
2. **Disposable project:** `.opencode/plugins/<shim>.ts` ->
   `export { default } from "<repo>/src/cache-engine-v2.mjs"`, and
   `.opencode/opencode.json` with
   `provider.openrouter.options.baseURL = http://127.0.0.1:<port>/api/v1`.
3. **Proxy:** a loopback proxy forwards to `https://openrouter.ai`, captures routing
   metadata, and (for the simulated rollover) rewrites the `Today's date: ...` value.
4. **Candidate toggle:** run `opencode run --standalone -m <model> "<prompt>"`; enable
   `stabilizeDate` by pointing `HOME` at a temp dir holding
   `.config/opencode/cache-engine.json` (`{"policies":{"<family>":{"stabilizeDate":true}}}`)
   while `XDG_CONFIG_HOME` stays real.
5. **Per trial:** prime (no rewrite) then measure (rewrite the date), with a **unique
   nonce** in the stable prompt so prior runs' caches cannot carry over. Read
   `cache.read`/`write` from the session DB
   (`session_message.data.tokens.cache.{read,write}`) or the OpenRouter usage.
6. **Threshold (§3C):** a reproducible `cache.read` increase vs baseline, directionally
   consistent (no sign flip), across >=2 rollovers.



---

## P2-T5 — acceptance decision

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
| P2-T1 | Hook-shape research (per route) | `docs/phases/phase2-date-relocation.md`; `RF-OC-035`; `test/fixtures/date-relocation-shapes.mjs` | done |
| P2-T2 | Content-preserving date relocation | `relocateVolatileDateLine` + `stabilizeDate` (V1/V2); tests + audit hardening | done |
| P2-T3 | Offline wire verification (gate G3) | `test/harness/capture/{verify-date-relocation.mjs,date-relocation.test.sh,run.sh}`; `RF-OC-036` | done |
| P2-T4 | Provider-side A/B | `docs/phases/phase2-date-relocation.md`; `RF-OC-038`; `RF-OR-006` | performed (directional support) |
| P2-T5 | Acceptance decision | this document | done |

**Plan §6 acceptance:** hook shape and wire behavior documented; invariants pass; no
stale date introduced; **provider-benefit threshold not met** → keep experimental
(explicitly accepted).

**§3C thresholds:** transform invariants **met**; provider benefit **not met** →
`stabilizeDate` default **off**.
