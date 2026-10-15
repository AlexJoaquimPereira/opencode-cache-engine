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
