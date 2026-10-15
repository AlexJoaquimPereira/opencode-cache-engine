# Phase 4 — P4-T3: OpenRouter affinity verification

**Task:** P4-T3 (`TODO.md`) — verify the OpenRouter session-affinity policy: route
eligibility, header precedence, user-header preservation, serialized attachment, and route
semantics (plan §8).
**Type:** research + wire (offline/mock). No real provider contacted.
**Depends on:** P4-T1 (policy inventory).
**Evidence basis:** OpenCode 2.0.26; the offline capture harness; the V2 adapter telemetry;
the existing V2 `model.request` unit test.

Evidence labels: *Structurally verified* / *Offline-wire verified* / *Telemetry-verified*.
**Provider measured: not performed.**

## What the policy does (inventory row A6)

For the GLM-5.3 / MiMo-V2.6 families with `providerID === "openrouter"`, the adapter adds a
deterministic `x-session-id` (V1 `chat.headers`; V2 `model.request`), **only when no
`x-session-id` is already present** (case-insensitive), and never for direct/unknown
providers. The derived value is `mimo-ses-<shorthash(sessionID)>` (`mimoSessionIdFor`).

## Findings (each requested aspect)

| Aspect | Result | Evidence |
|---|---|---|
| **Eligibility** | ✅ **Verified (logic).** The hook fires and classifies OpenRouter GLM as eligible; non-eligible cases do not inject. | V2 `model.request` unit test; telemetry below |
| **Header precedence / user-header preservation** | ✅ **Verified.** With a pre-existing `x-session-id` the adapter **preserves** it: telemetry `headerPresent:true, headerAttached:false, headerSource:"preexisting"`. | telemetry record (below) |
| **Serialized attachment** | ✅ **The header IS on the wire** — but it is **OpenCode's** value (`x-session-id: ses_…`), not the adapter's (`mimo-ses-…`). | wire capture |
| **Attribution to the adapter** | ❌ **Not attributable.** The wire header is present **with the adapter disabled** and on a **neutral** model — so OpenCode sets it natively; the adapter never attaches its own value. | OFF control + neutral-route capture |
| **Route semantics (does reuse improve?)** | **Not measurable offline**, and moot while the adapter is not the header setter. | — |

### Telemetry (adapter ON, `openrouter/glm-5.3-flash`)

```json
{"kind":"boundary","policy":"glm53","model":"glm-5.3-flash","reason":"openrouter_affinity_eligible",
 "eligible":true,"providerIdentityKnown":true,"provider":"openrouter",
 "headerPresent":true,"headerAttached":false,"headerSource":"preexisting"}
```

The hook ran, judged the route eligible, saw an existing header, and **did not attach** one.

### Wire evidence (offline, `@ai-sdk/openai-compatible` → loopback mock)

| Case | adapter | model | `x-session-id` on the wire |
|---|---|---|---|
| A | ON | `openrouter/glm-5.3-flash` | `ses_ec0371…` (session id) |
| E | **OFF** (`enabled:false`) | `openrouter/glm-5.3-flash` | `ses_ec0371…` (session id) |
| — | OFF/neutral | `mock/synthetic` | `ses_…` (session id) |

`x-session-id` is present in **all** cases → it is **OpenCode's**, not the adapter's. (The
adapter's own value shape `mimo-ses-…` was **never** observed.)

## Verdict

**The OpenRouter affinity header is NOT wire-attributable on the tested route.** On the
**tested openai-compatible route** (offline capture only; **no source confirmation**),
`x-session-id = <sessionID>` is set by the **harness**, not the adapter, so the adapter's
eligibility-gated injection has **no observable wire effect** (it preserves the pre-existing
header and stays silent). **No adapter defect is claimed** — the logic is correct; the
harness simply provides the header itself. Scope: the V1 `chat.headers` path was **not**
wire-captured (logic only).

> This mirrors P4-T2: on the routes we can test, **OpenCode's harness already supplies the
> session affinity** (the GPT `prompt_cache_key` and the OpenRouter `x-session-id`). The
> CacheEngine overlay is redundant on the wire there.

## Residual / next

- Whether a route exists where OpenCode does **not** set `x-session-id` (so the adapter's
  injection would be attributable) is **unknown**; on the tested offline route it is present.
- The V1 `chat.headers` path is unit-tested but was not wire-captured here (the harness loads
  the V2 adapter).
- Route semantics (whether affinity reuse improves hits) requires a provider experiment and
  is moot while the adapter is not the setter.

## Recommendation

Record the affinity policy as **not wire-effective on the tested route**; keep it as-is
(preserves rather than overwrites; harmless). Note the OpenCode-native `x-session-id` as the
route's actual affinity source (new finding, `RF-OC-048`).

## Integrity

No managed config/service touched; disposable temp HOME/project + loopback mock. No
credentials, prompt content, or full bodies recorded or committed.
