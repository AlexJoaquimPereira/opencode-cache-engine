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

