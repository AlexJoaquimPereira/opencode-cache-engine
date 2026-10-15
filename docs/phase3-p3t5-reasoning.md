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
