// Offline *shape* fixtures for Phase 6 compaction groundwork (task P6-T2).
//
// Structural observations ONLY (never full request bodies), captured offline from
// OpenCode 2.0.30 through the Phase 1 capture harness (mock provider, loopback,
// `bwrap --unshare-net`). No transform is implemented here.
//
// Evidence: docs/phases/phase6-compaction-research.md; RF-OC-049.
//
// Reproduce (from the repo root):
//   OC_CAPTURE_CONTEXT_LIMIT=2000 OC_CAPTURE_SUMMARY_OK=1 \
//   OC_CAPTURE_TURNS=3 OC_CAPTURE_CONTINUE=1 \
//   OC_CAPTURE_PROMPT="$(head -c 8192 /dev/zero | tr '\0' x)" \
//   test/harness/capture/run.sh
//
// A forced small context limit + an overflowing user message makes OpenCode run
// its compaction/summarizer step BEFORE the agent request. The cache prefix
// (model + system + tools) is preserved across the boundary; only the message
// history changes.

// How an offline compaction is triggered.
export const COMPACTION_TRIGGER = {
  // The mock model entry gains `"limit": { "context": N, "output": 4096 }`.
  configKey: "limit.context",
  defaultOutputLimit: 4096,
  mechanism: "the session token estimate exceeds the model context limit",
  runsBeforeAgentRequest: true,
  // The summary must satisfy OpenCode's template or the turn fails
  // (`Session.StepFailedError: Compaction summary did not match the required template`).
  validatesSummaryTemplate: true,
  // On a template mismatch OpenCode retries the summarizer with a corrective user
  // message before failing the turn (so a failed boundary emits no post request).
  retriesOnTemplateMismatch: true,
}

// The substring OpenCode appends to the user turn for the summarizer request.
export const SUMMARIZER_MARKER = "You MUST summarize the conversation"

// The marker of the single user message that replaces the history after compaction.
export const CHECKPOINT_MARKER = "<conversation-checkpoint>"

// Per-turn request sequence observed in the forced configuration, repeated
// deterministically for every equivalent turn.
export const TURN_SEQUENCE = [
  { id: "aux_title", messages: 2, tools: 0, summarizer: false, checkpoint: false },
  { id: "compaction_summarizer", messages: 3, tools: 12, summarizer: true, checkpoint: false },
  { id: "post_compaction_agent", messages: 2, tools: 12, summarizer: false, checkpoint: true },
]

// Invariants across the compaction boundary (before = the summarizer request that
// carries the full history; after = the post-compaction agent request).
export const BOUNDARY_INVARIANTS = {
  topLevelKeys: "max_completion_tokens,messages,model,store,stream,stream_options,tools",
  systemIdentical: true,
  toolsIdentical: true,
  toolCount: 12,
  before: { summarizer: true, messages: 3 },
  after: { checkpoint: true, messages: 2 },
}

// Equivalent turns repeat the same 3-request sequence (structural determinism).
export const DETERMINISM_REPEATS = 3

// Classify a serialized body structurally (never returns content).
export function classifyRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const hasText = (s) => messages.some((m) => String(m?.content ?? "").includes(s))
  return {
    messageCount: messages.length,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    summarizer: hasText(SUMMARIZER_MARKER),
    checkpoint: hasText(CHECKPOINT_MARKER),
  }
}

// True when the cache prefix (the system message + the tool definitions) is
// byte-identical across the boundary. Deliberately content-agnostic: it compares
// the structural prefix, not the conversation.
export function prefixPreserved(before, after) {
  const sys = (b) => JSON.stringify((b?.messages ?? []).find((m) => m?.role === "system") ?? null)
  return sys(before) === sys(after) && JSON.stringify(before?.tools ?? null) === JSON.stringify(after?.tools ?? null)
}
