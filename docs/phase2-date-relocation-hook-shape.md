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
> implemented for V1 and V2, **default off** (experimental). Provider-side benefit
> is still unmeasured (P2-T4).

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
