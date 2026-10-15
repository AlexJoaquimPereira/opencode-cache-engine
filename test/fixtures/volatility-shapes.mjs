// Offline *shape* fixtures for Phase 3 volatility groundwork (task P3-T1).
//
// Structural observations ONLY (never full request bodies), captured offline from
// OpenCode 2.0.26 through the Phase 1 capture harness (mock provider, loopback,
// `bwrap --unshare-net`). P3-T2..P3-T5 rank volatility against this baseline.
// No transform is implemented here.
//
// Evidence: docs/phases/phase3-other-volatility.md; RF-OC-040.
// Reproduce both pair types:
//   OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 test/harness/capture/run.sh
//
// V2 system text is delivered to the Chat Completions route INSIDE `messages`
// (role "system"), not as a top-level `system` key — so the Phase 1 diff, which
// treats every `messages` change as "expected", cannot see system-prompt drift.

// A request "kind" = top-level body keys minus the conversation/stream/options
// keys (diff-requests.mjs `kindOf`). One fresh `opencode run` emits one aux
// (title/summary) request THEN one main (agent-loop) request.
export const REQUEST_KINDS = {
  aux: "model,store",
  main: "max_completion_tokens,model,store,tools",
}

// Main request: 12 tools on the 2.0.26 Chat Completions route. The first 11 are
// ASCII-sorted; `execute` (the Code Mode tool) is appended AFTER the sorted core
// and is therefore NOT in sort position. Stable across equivalent turns, the
// session-continue turn, and repeated runs.
export const TOOL_ORDER_2_0_26 = [
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
  "execute",
]
export const APPENDED_TOOL = "execute"

// The sorted core (everything except the appended `execute`).
export function sortedCore(tools = TOOL_ORDER_2_0_26) {
  return tools.filter((t) => t !== APPENDED_TOOL)
}

// True when the array is in non-decreasing ASCII order.
export function isAsciiSorted(a) {
  for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) return false
  return true
}

// Pair semantics observed (RF-OC-040). Equivalent turns are byte-identical; a
// session-continue ("subsequent") request differs ONLY in `messages` (history
// growth) — route/model, `tools`, and the system message stay byte-identical.
export const PAIR_EXPECTATIONS = [
  {
    id: "equivalent_turn",
    description: "two fresh runs, same project/prompt/model",
    changedSections: [],
    equal: true,
    systemIdentical: true,
    toolsIdentical: true,
  },
  {
    id: "first_vs_subsequent",
    description: "first request after startup vs a session-continue request",
    changedSections: ["messages"],
    equal: false,
    systemIdentical: true,
    toolsIdentical: true,
  },
]

// Where the (single) system prompt lives on this route.
export const SYSTEM_MESSAGE = { role: "system", messageIndex: 0 }
