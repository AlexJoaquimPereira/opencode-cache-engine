// Offline shape fixtures for Phase 2 date relocation (task P2-T1 deliverable).
//
// These are *shape* samples only: system text / system parts as OpenCode delivers
// them. P2-T3 consumes them to verify a content-preserving date relocation and its
// no-op conditions. No transform is implemented here.
//
// Evidence basis — see docs/phase2-date-relocation-hook-shape.md:
//   - origin "2.0.26": verified by offline capture of an OpenCode v2.0.26 primary
//     request (mock provider, `bwrap --unshare-net`). The daily date is a STANDALONE
//     line `Today's date: <EEE MMM D YYYY>` OUTSIDE and immediately BEFORE the
//     <env> block; there is NO "You are powered by the model named " START marker.
//   - origin "1.18.34": the legacy marker-bearing V1 shape (mirrors the existing
//     GLM_SYSTEM / MIMO_SYSTEM test fixtures); the date sits INSIDE the <env> block
//     after the model-name preamble.
//   - origin "synthetic": hand-built edge cases for the no-op conditions.
//
// V2 `context` hook `system` is an array of parts `{ type: "text", text }`
// (confirmed by test/cache-engine.test.mjs multi-part cases).

/** @typedef {{ type: string, text?: string }} SystemPart */
/**
 * @typedef {Object} ShapeFixture
 * @property {string} id
 * @property {string} origin                 "2.0.26" | "1.18.34" | "synthetic"
 * @property {string} description
 * @property {string | SystemPart[]} input   system text or system parts
 * @property {number} dateCount              expected count of daily-date lines
 * @property {boolean} dateInsideEnv         date line inside <env> (single-text cases)
 * @property {boolean} hasStartMarker        "You are powered by the model named " present
 * @property {string} expect                 "eligible" | "no-op"
 */

const ENV_26 = [
  "<env>",
  "  Working directory: /tmp/opencode/capture.P5OaSX/proj",
  "  Workspace root folder: /tmp/opencode/capture.P5OaSX/proj",
  "  Is directory a git repo: no",
  "  Platform: linux",
  "  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.",
  "</env>",
].join("\n")

// Exact tail of the captured 2.0.26 primary system message (from `</available_skills>`).
const OC2_TAIL = [
  "</available_skills>",
  "",
  "Today's date: Wed Oct 14 2026",
  "",
  "Here is some useful information about the environment you are running in:",
  ENV_26,
  "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.",
].join("\n")

// Legacy (1.18.34) marker-bearing shape: date INSIDE <env>, after the preamble.
const LEGACY = [
  "You are a senior software engineer.",
  "You are powered by the model named glm-5.3-flash. The exact model ID is z-ai/glm-5.3-flash",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "Working directory: /home/dev/project",
  "Is directory a git repo: yes",
  "Today's date: 2026-08-17",
  "</env>",
  "You MUST follow AGENTS.md instructions and keep your responses concise.",
].join("\n")

/** @type {ShapeFixture[]} */
export const SHAPES = [
  {
    id: "oc2_0_26",
    origin: "2.0.26",
    description: "captured 2.0.26 tail: single date line OUTSIDE <env>, before it; no START marker",
    input: OC2_TAIL,
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "eligible",
  },
  {
    id: "oc2_0_26_no_date",
    origin: "synthetic",
    description: "same 2.0.26 shape but the date line removed (no daily volatility)",
    input: OC2_TAIL.replace("Today's date: Wed Oct 14 2026\n\n", ""),
    dateCount: 0,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "no-op",
  },
  {
    id: "legacy_1_18_34",
    origin: "1.18.34",
    description: "legacy marker shape: date INSIDE <env>, after the model-name preamble",
    input: LEGACY,
    dateCount: 1,
    dateInsideEnv: true,
    hasStartMarker: true,
    expect: "eligible",
  },
  {
    id: "duplicate_date",
    origin: "synthetic",
    description: "two date lines (ambiguous anchor) -> must be a no-op",
    input: OC2_TAIL.replace("</available_skills>", "</available_skills>\nToday's date: Tue Oct 13 2026"),
    dateCount: 2,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "no-op",
  },
  {
    id: "malformed_date_value",
    origin: "synthetic",
    description: "date label present with an unparseable value -> must be a no-op",
    input: OC2_TAIL.replace("Today's date: Wed Oct 14 2026", "Today's date: someday"),
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "no-op",
  },
  {
    id: "date_label_no_value",
    origin: "synthetic",
    description: "date label with no value -> must be a no-op",
    input: OC2_TAIL.replace("Today's date: Wed Oct 14 2026", "Today's date:"),
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "no-op",
  },
  {
    id: "no_env_block",
    origin: "synthetic",
    description: "date line but no <env> block",
    input: ["INSTR", "Today's date: Wed Oct 14 2026", "TAIL"].join("\n"),
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "eligible",
  },
  {
    id: "multi_part_eligible",
    origin: "synthetic",
    description: "V2 parts array: date+env live in a non-first text part",
    input: [
      { type: "text", text: "HEAD-PART" },
      { type: "text", text: "middle 80" },
      { type: "text", text: "Intro.\n" + OC2_TAIL },
      { type: "text", text: "TAIL-PART" },
    ],
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "eligible",
  },
  {
    id: "unexpected_part_types",
    origin: "synthetic",
    description: "V2 parts array containing non-text / null parts alongside the eligible text part",
    input: [
      { type: "image", text: undefined },
      { type: "text", text: OC2_TAIL },
      { type: "file", text: undefined },
    ],
    dateCount: 1,
    dateInsideEnv: false,
    hasStartMarker: false,
    expect: "eligible",
  },
]

// Classification is model-id-only; the same shape is treated differently per family.
export const FAMILY_CLASSIFICATION = [
  { model: "glm-5.3-flash", providerID: "mock", family: "glm53", envRelocation: "glm" },
  { model: "mimo-v2.6-flash", providerID: "mock", family: "mimo26", envRelocation: "mimo" },
  { model: "synthetic", providerID: "mock", family: "neutral", envRelocation: null },
]

export const FIXTURES = { ENV_26, OC2_TAIL, LEGACY }
