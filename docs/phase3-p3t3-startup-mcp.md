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
| Frequency | MCP connects **after** the first request is assembled (~403 ms in our capture) on every process start (0/≥5 probes put an MCP tool on the wire) |
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
  array), and (b) the first request **races** the forked MCP connect (`mcp connected` at
  ~403 ms, *after* the request was answered). See `RF-OC-044` (which supersedes
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
