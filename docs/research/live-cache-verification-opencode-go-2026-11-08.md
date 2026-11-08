# Live cache verification — OpenCode Go route (warm-cache audit)

**Evidence class:** **Provider measured** (provider-reported `step_finish.tokens`), plus
*structurally verified* offline wire checks where cited.
**Date:** 2026-11-08 · **Route:** `opencode-go` only · **OpenCode:** 2.2.6 (`opencode run --standalone`)
· **Node:** 22.23.2 · **Adapter:** `src/cache-engine-v2.mjs` via a disposable project shim.
**Findings:** RF-OC-050 … RF-OC-059. **Raw audit:** `docs/audits/audit-report-live-cache-opencode-go-2026-11-08.md`.

---

## 1. Purpose

This is the project's first **provider-measured** evidence that the shipped policies behave as
documented on a real route. It answers three questions that unit/offline tests cannot:

1. **Warm cache** — after the first request, does each family actually reuse its prefix inside a
   session, and how much?
2. **Scope** — does a fresh session with byte-identical content reuse the cache, or is the cache
   keyed per session?
3. **Policy resolution** — which policy does each model get at runtime, and is the adapter
   transparent where it should be passive?

It is a **warm-cache audit**, not a benchmark: the workload is a fixed synthetic block, and the
numbers are provider-reported tokens for that workload. They must not be generalised to real
prompts or to a benefit claim for any mutation.

## 2. Method

| Item | Value |
|---|---|
| Models | `gpt-6-luna`, `claude-haiku-5-5`, `mimo-v2.6-flash`, `glm-5.3-flash`, `muse-spark-1.3-contributor`, `minimax-m3.1-flash`, `kimi-k2.7-code`, `deepseek-v4.1-flash` |
| Arms | plugin **on** (project shim + all family policies enabled) vs **off** (no plugin file/config) |
| Turns per arm | `A1` fresh, ~30 kB synthetic block (unique nonce) → `A2`/`A3` `--continue`; `B1`/`B2` fresh sessions with the identical block; `C1` fresh with a different nonce |
| Cross-session repeat | 4 fresh sessions with the identical block + 1 control, plugin on |
| Measurement | `tokens.input` / `tokens.cache.read` / `tokens.cache.write` from the `step_finish` event |
| Isolation | disposable `HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`; real `XDG_DATA_HOME` for Go credentials; **no managed config modified** |
| Traps avoided | `PWD` set to the project (OpenCode resolves project plugins from `PWD`, RF-OC-055); global plugin list excluded, so `opencode-cache-manager` never loads |

**Hit-rate definitions.** Within-session: `read/(input+read+write)` on turn 2+ — the share of the
rendered prompt served from cache. Cross-session: a fresh session whose byte-identical block reports
a `cache.read` above the different-block control.

## 3. Warm-cache audit (within a session)

| Model | Accounting dialect | A1 (read/write) | A2 hit | A3 hit |
|---|---|---|---:|---:|
| GPT-6 Luna | write+read | 0 / 13 343 | 100% | 100% |
| Claude Haiku 5.5 | write+read | 8 522 / 12 741 | 100% | 100% |
| MiMo-V2.6-Flash | read-only | 4 096 / 0 | 99% | 100% |
| GLM-5.3-Flash | read-only | 3 264 / 0 | 98% | 98% |
| Muse Spark 1.3 Contributor | read-only | 2 801 / 0 | 99% | 99% |
| MiniMax M3.1 Flash | read-only | 1 792 / 0 | 99% | 99% |
| Kimi K2.7 Code | read-only | 4 608 / 0 | 100% | 99% |
| DeepSeek V4.1 Flash | read-only | 1 792 / 0 | 99% | 98% |

**Every family reuses its prefix essentially perfectly once warm.** Two accounting dialects coexist
on the same gateway: OpenAI-style (write then read) for GPT/Claude, read-only for the other six.

## 4. Cross-session audit

4 fresh sessions, byte-identical block, plugin on:

| Model | `cache.read` per fresh session | Control | Verdict |
|---|---|---:|---|
| GPT-6 Luna | 0, 0, 0, 0 | 0 | **no reuse** — each session writes again |
| Claude Haiku 5.5 | 5 971, 21 467, 21 467, 21 467 | 8 522 | **yes**, one warm-up miss |
| MiMo-V2.6-Flash | 4 864, 14 464, 14 464, 14 464 | 4 096 | **yes**, one warm-up miss |
| GLM-5.3-Flash | 3 264, 14 144, 14 144, 14 144 | 0 | **yes** |
| Muse Spark 1.3 Contributor | 2 801, 0, 0, 1 521 | 3 057 | **no reuse** |
| MiniMax M3.1 Flash | 128, 128, 14 464, 14 464 | 483 | **yes**, two warm-up misses |
| Kimi K2.7 Code | 6 144, 14 848, 14 848, 14 848 | 6 144 | **yes**, one warm-up miss |
| DeepSeek V4.1 Flash | 1 920, 256, 4 096, 0 | 4 096 | **no reuse** |

Warm-up is real: the first fresh session often pays full price even when later ones hit. A single
sample understates reuse.

## 5. Policy-resolution audit

| Model | Policy | Why |
|---|---|---|
| `gpt-6-luna` | `gpt56` (after the fix) | provider-id allowlist for Go + GPT slug; the V2 hook payload has no `api` metadata (RF-OC-058/059) |
| `claude-haiku-5-5` | `claude` | family baseline |
| `mimo-v2.6-flash` | `mimo26` | exact id + `<env>` overlay (structurally a no-op on 2.2.6, RF-OC-053) |
| `glm-5.3-flash` | `glm53` | exact id + `<env>` overlay (same no-op) |
| `muse-spark-1.3-contributor` | `muse` | family baseline |
| `minimax-m3.1-flash` | `minimax` | family baseline |
| `kimi-k2.7-code` | `kimi` | exact id |
| `deepseek-v4.1-flash` | `deepseek` | family baseline |

**Transparency:** ON vs OFF shows no systematic difference for any family; deltas track cache warm-up.
The OpenRouter affinity header is correctly withheld on this route
(`reason:"openrouter_affinity_bypassed_non_openrouter"`, `headerAttached:false`).

## 6. Luna post-fix audit

After the resolver fix (RF-OC-059), `gpt-6-luna` on `opencode-go` resolves `gpt56` and the adapter
assigns the missing cache fields. Retest on the fixed code:

| Turn | `cache.read` | `cache.write` |
|---|---:|---:|
| A1 | 0 | 13 098 |
| A2 | 13 098 | 23 |
| A3 | 13 121 | 24 |
| B1 (fresh, same block) | 0 | 13 098 |
| B2 (fresh, same block) | 0 | 13 098 |
| C1 (fresh, different block) | 0 | 13 277 |

Cross-session repeat: `read 0 / write 13 125` on all four fresh sessions (control `write 13 061`) —
**0/4**. Telemetry: `policy:"gpt56"`; one `cache-options` record per session with
`keyInjected:true`, `optionsInjected:true`, `transport:"promptCacheKey"`,
`wireEffect:"not_observed"`; no `telemetry-error`.

**Conclusion.** The fix repairs *policy attribution and assignment* without changing cache behaviour.
That is the honest maximum here: RF-OC-030 established that the `openai-compatible` provider-options
schema strips the GPT cache fields, so the assignment is not a wire claim and must not be sold as a
cache gain. Within-session reuse was already 100% before the fix.

## 7. What this proves — and what it does not

**Proves (provider measured):**
- The V2 adapter loads and runs on a real route; policies resolve to the documented families.
- Passive families are transparent (no request mutation, no cache regression).
- Caching is real and strong within a session for all eight families.
- The `<env>` overlay is a structural no-op on 2.2.6 (offline capture, RF-OC-053).
- The affinity header is withheld off OpenRouter.

**Does not prove:**
- That any CacheEngine mutation *improves* caching — no ON/OFF cache benefit was observed, and none
  is claimed.
- Wire carriage of the GPT cache fields (schema strips them; RF-OC-030/047).
- Provider TTLs, eviction policy, or cross-user cache scope.
- Anything about real prompts beyond the synthetic workload.

## 8. Reproduction

The driver and raw per-run JSON live in `/tmp/opencode/live-cache/` (disposable, untracked). The
procedure is reproducible from §2: one disposable project per arm, `opencode run --standalone
--format json -m opencode-go/<model>`, six turns as above, parse `step_finish.tokens`. The full
per-turn tables and the neutral-vs-fixed comparison are in the audit report.

## 9. Evidence inventory

| Claim | Label | Source |
|---|---|---|
| Per-turn token accounting | *Provider measured* | live `step_finish.tokens` |
| Warm-cache hit rates | *Provider measured* | same |
| Cross-session reuse split | *Provider measured* | 4-repeat fresh sessions |
| Policy resolution | *Observed* | adapter telemetry (`usage.policy`, `cache-options`, `boundary`) |
| `<env>` overlay no-op on 2.2.6 | *Structurally verified* | offline serialized-request capture (RF-OC-053) |
| GPT wire carriage | *Unknown* | schema analysis (RF-OC-030); no live wire capture |
