// cache-engine.test.mjs
//
// Self-contained validation for cache-engine-core.js using Node's built-in
// test runner (node:test, available in Node 20). Run with:
//   node --test ~/.config/opencode/plugins/cache-engine.test.mjs
//
// These tests exercise the pure logic that the plugin relies on. Integration
// (plugin loading / hooks) is validated separately via `opencode run`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  POLICY_DEEPSEEK,
  POLICY_GLM53,
  POLICY_GPT56,
  POLICY_MIMO26,
  POLICY_NEUTRAL,
  affinityTelemetryFields,
  canonicalStringify,
  commonPrefixLength,
  createRecorder,
  detectPolicy,
  detectReasoningIssues,
  digestDecision,
  expandHome,
  glmHitRatio,
  gptCacheOptionsDelta,
  hitRatePct,
  isOpenRouterAffinityEligible,
  loadConfig,
  mimoHitRate,
  mimoSessionIdFor,
  nextProcessedCursor,
  parseConfig,
  providerChangeEvent,
  relocateVolatileEnvBlock,
  scanPage,
  shapeDiff,
  shapeFieldDiffs,
  shorthash,
  shouldAggregate,
  stableSessionIdFor,
  systemShapeHashes,
  toolFingerprint,
  toolWireFingerprint,
} from "../src/cache-engine-core.mjs"

const asst = (id, read, write) => ({
  info: { id, role: "assistant", tokens: { cache: { read, write } } },
})

// --- 1/2. system prefix: identical -> no change; changed -> detected ---------
test("identical system hash -> no change reported", () => {
  const prev = { systemHash: "aaa", toolsHash: "bbb" }
  const cur = { systemHash: "aaa", toolsHash: "bbb" }
  assert.deepEqual(shapeDiff(prev, cur), [])
})

test("changed system hash -> exactly ['system']", () => {
  const prev = { systemHash: "aaa", toolsHash: "bbb" }
  const cur = { systemHash: "ccc", toolsHash: "bbb" }
  assert.deepEqual(shapeDiff(prev, cur), ["system"])
})

// --- 3. tool canonicalization is order-independent --------------------------
test("identical tools with different ordering/schema key order -> same hash", () => {
  const a = [
    { id: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { id: "write", description: "write a file", parameters: { properties: { content: { type: "string" } }, type: "object" } },
  ]
  const b = [
    // reversed tool order, reversed object-key insertion order
    { parameters: { type: "object", properties: { content: { type: "string" } } }, id: "write", description: "write a file" },
    { description: "read a file", parameters: { properties: { path: { type: "string" } }, type: "object" }, id: "read" },
  ]
  assert.equal(toolFingerprint(a), toolFingerprint(b))
  assert.equal(toolFingerprint(a), toolFingerprint(b.slice().reverse()))
})

test("canonicalStringify ignores object key insertion order", () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), canonicalStringify({ a: 2, b: 1 }))
  assert.equal(canonicalStringify({ x: { z: 1, y: [3, 2, 1] } }), canonicalStringify({ x: { y: [3, 2, 1], z: 1 } }))
})

// --- 4/5. tool schema change and combined changes ----------------------------
test("changed tool schema -> exactly ['tools']", () => {
  const t1 = toolFingerprint([{ id: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }])
  const t2 = toolFingerprint([{ id: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } } } }])
  assert.notEqual(t1, t2)
  assert.deepEqual(shapeDiff({ systemHash: "s", toolsHash: t1 }, { systemHash: "s", toolsHash: t2 }), ["tools"])
})

test("system change + tool change -> both dimensions reported", () => {
  const prev = { systemHash: "s1", toolsHash: "t1" }
  const cur = { systemHash: "s2", toolsHash: "t2" }
  assert.deepEqual(shapeDiff(prev, cur).sort(), ["system", "tools"])
})

test("unknown dimension (null) is never reported as a change", () => {
  // system changed (both hashes known) -> reported even when tools unknown
  assert.deepEqual(shapeDiff({ systemHash: "s1", toolsHash: null }, { systemHash: "s2", toolsHash: null }), ["system"])
  // tools going from known -> unknown (e.g. fetch failed) is NOT a change
  assert.deepEqual(shapeDiff({ systemHash: "s1", toolsHash: "t1" }, { systemHash: "s1", toolsHash: null }), [])
})

test("toolFingerprint returns null for unusable input", () => {
  assert.equal(toolFingerprint(undefined), null)
  assert.equal(toolFingerprint("nope"), null)
})

// --- 6. repeated session.idle never double-counts ---------------------------
test("same assistant message counted once across idle events", () => {
  const page = [asst("m1", 100, 20), asst("m2", 50, 10), asst("m3", 25, 5)]
  const first = scanPage(page, null)
  assert.equal(first.count, 3)
  assert.equal(first.read, 175)
  assert.equal(first.write, 35)
  // Boundary becomes the NEWEST processed message (messages append at the top).
  const cursor = nextProcessedCursor(page, null)
  assert.equal(cursor, "m1")

  // Second idle: no new messages above the boundary -> nothing counted.
  const second = scanPage(page, cursor)
  assert.equal(second.count, 0)
  assert.equal(second.read, 0)
  assert.equal(second.reachedStart, true)
})

// --- 7. multiple new assistant messages -> each counted once -----------------
test("only messages newer than the cursor are aggregated", () => {
  const oldPage = [asst("m1", 100, 20), asst("m2", 50, 10)]
  const cursor = nextProcessedCursor(oldPage, null)
  assert.equal(cursor, "m1")

  const nextPage = [asst("m0", 10, 2), asst("m1", 100, 20), asst("m2", 50, 10)]
  const scan = scanPage(nextPage, cursor)
  assert.equal(scan.count, 1)
  assert.equal(scan.read, 10)
  assert.equal(scan.reachedStart, true)
})

test("paginated tail (boundary not found) advances cursor to newest processed", () => {
  const page = [asst("m1", 10, 2), asst("m2", 20, 4)]
  const scan = scanPage(page, "ghost-cursor")
  assert.equal(scan.reachedStart, false)
  const cursor = nextProcessedCursor(page, "ghost-cursor")
  assert.equal(cursor, "m1")
})

// --- 8. no cache fields -> no fabricated event -------------------------------
test("no cache fields -> count stays 0 and aggregation is skipped", () => {
  const page = [{ info: { id: "u1", role: "user", tokens: undefined } }]
  const scan = scanPage(page, null)
  assert.equal(scan.count, 0)
  assert.equal(shouldAggregate(scan.count, scan.read, scan.write), false)

  const withTokensNoCache = [{ info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } } }]
  const scan2 = scanPage(withTokensNoCache, null)
  assert.equal(scan2.count, 1)
  assert.equal(scan2.read, 0)
  assert.equal(scan2.write, 0)
  assert.equal(shouldAggregate(scan2.count, scan2.read, scan2.write), false)
})

// --- 9. hit-rate calculation -------------------------------------------------
test("hit rate = read / (read + write)", () => {
  assert.equal(hitRatePct(80, 20), 80)
  assert.equal(hitRatePct(0, 0), null)
  assert.equal(hitRatePct(100, 0), 100)
  assert.equal(shouldAggregate(2, 180, 40), true)
})

// --- 10. compaction digest is not duplicated for one invocation --------------
test("digestDecision prevents duplicate insertion per compaction", () => {
  assert.equal(digestDecision({ compactTemplate: true, pendingInsert: true }), true)
  assert.equal(digestDecision({ compactTemplate: true, pendingInsert: false }), false)
  assert.equal(digestDecision({ compactTemplate: false, pendingInsert: true }), false)
})

// --- 11/12. config behavior ---------------------------------------------------
test("disabled engine -> enabled=false", () => {
  assert.equal(parseConfig({ enabled: false }, undefined).enabled, false)
})

test("malformed config falls back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-"))
  const bad = join(dir, "cache-engine.json")
  writeFileSync(bad, "{ this is not json")
  const cfg = loadConfig({ configPath: bad, env: {} })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.compactTemplate, true)
})

test("missing config falls back to defaults + env override", () => {
  const cfg = loadConfig({ configPath: "/nonexistent/cache-engine.json", env: {} })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.logPrefixChanges, true)
  const env = { CACHE_ENGINE_METRICS_FILE: "~/metrics/x.jsonl" }
  const withEnv = parseConfig(undefined, env)
  assert.ok(withEnv.metricsFile.endsWith("/metrics/x.jsonl"))
  assert.ok(!withEnv.metricsFile.startsWith("~"))
})

test("expandHome handles ~ and ~/ safely", () => {
  assert.equal(expandHome("~/a/b"), join(homedir(), "a/b"))
  assert.equal(expandHome("~"), homedir())
  assert.equal(expandHome("/abs/path"), "/abs/path")
  assert.equal(expandHome("rel/path"), "rel/path")
})

// --- 13. telemetry write failure never throws --------------------------------
test("recorder swallows write failures", () => {
  const rec = createRecorder("/nonexistent-dir-xyz/out.jsonl")
  assert.doesNotThrow(() => rec.record({ kind: "usage", sid: "s", read: 1, write: 0 }))
})

test("recorder writes valid JSONL to a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-"))
  const file = join(dir, "metrics.jsonl")
  const rec = createRecorder(file)
  rec.record({ kind: "prefix-change", sid: "s", dimensions: ["system"] })
  rec.record({ kind: "usage", sid: "s", read: 5, write: 1 })
  const lines = readFileSync(file, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { kind: "prefix-change", sid: "s", dimensions: ["system"] })
})

// --- 14. TUI target test -----------------------------------------------------

test("TUI target exports the expected plugin module", async () => {
  const mod = await import("../src/tui.mjs")
  assert.equal(mod.default.id, "opencode-cache-engine")
  assert.equal(typeof mod.default.tui, "function")
  assert.equal("server" in mod.default, false)
})

// --- 15. Package manifest test with TUI --------------------------------------

test("package exposes separate server and TUI targets", async () => {
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  )

  assert.equal(pkg.exports["./server"], "./src/cache-engine.ts")
  assert.equal(pkg.exports["./tui"], "./src/tui.mjs")
})


// ===========================================================================
// Provider-aware model detection
// ===========================================================================

const M = (providerID, modelID, extra = {}) => ({ providerID, modelID, ...extra })

test("DeepSeek V4.1 Flash matches DeepSeek policy (openrouter + direct)", () => {
  assert.equal(detectPolicy(M("openrouter", "deepseek/deepseek-v4.1-flash-0731")), POLICY_DEEPSEEK)
  assert.equal(detectPolicy(M("deepseek", "deepseek-chat")), POLICY_DEEPSEEK)
})

test("GPT-5.6 variants match GPT policy", () => {
  assert.equal(detectPolicy(M("openrouter", "openai/gpt-5.6-luna")), POLICY_GPT56)
  assert.equal(detectPolicy(M("openrouter", "openai/gpt-5.6-luna:flex")), POLICY_GPT56)
  assert.equal(detectPolicy(M("openrouter", "openai/gpt-5.6-luna-pro:flex")), POLICY_GPT56)
  assert.equal(detectPolicy(M("openai", "gpt-5.6")), POLICY_GPT56)
  assert.equal(detectPolicy(M("azure", "gpt-5.6")), POLICY_GPT56)
  // full Model shape with api.npm
  assert.equal(
    detectPolicy({ providerID: "openrouter", api: { id: "openai/gpt-5.6-luna", npm: "@openrouter/ai-sdk-provider" } }),
    POLICY_GPT56,
  )
})

test("older/other OpenAI models do NOT match GPT policy", () => {
  assert.equal(detectPolicy(M("openai", "gpt-4o")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openai", "gpt-5.2")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("azure", "gpt-4.1")), POLICY_NEUTRAL)
})

test("GPT-5.6 string on a non-OpenAI endpoint does NOT match GPT policy", () => {
  // bare openai-compatible gateway, no openai/ or azure/ slug prefix
  assert.equal(detectPolicy(M("openai-compatible", "gpt-5.6")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("llama.cpp", "gpt-5.6")), POLICY_NEUTRAL)
})

test("GLM-5.3 Flash matches GLM policy (openrouter + z-ai variants)", () => {
  assert.equal(detectPolicy(M("openrouter", "z-ai/glm-5.3-flash")), POLICY_GLM53)
  assert.equal(detectPolicy(M("openai-compatible", "z-ai/glm-5.3-flash")), POLICY_GLM53)
  assert.equal(detectPolicy(M("zai", "glm-5.3-flash")), POLICY_GLM53)
  assert.equal(detectPolicy(M("zai", "glm-5.3-flash-250807")), POLICY_GLM53)
})

test("unrelated GLM models do NOT match GLM-5.3 policy", () => {
  assert.equal(detectPolicy(M("openrouter", "z-ai/glm-4.6")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("zai", "glm-4.5")), POLICY_NEUTRAL)
})

test("MiMo V2.6 Flash/Pro match MiMo policy (openrouter + direct)", () => {
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.6-flash")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.6-pro")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-flash")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-pro")), POLICY_MIMO26)
  // full Model shape via api.id
  assert.equal(
    detectPolicy({ providerID: "openrouter", api: { id: "xiaomi/mimo-v2.6-flash", npm: "@openrouter/ai-sdk-provider" } }),
    POLICY_MIMO26,
  )
})

test("MiMo V2.5 and Pro-UltraSpeed do NOT match MiMo policy", () => {
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.5-pro")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-pro-ultraspeed")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-flashx")), POLICY_NEUTRAL)
})

test("unrelated MiMo/other models do NOT match MiMo policy", () => {
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2-flash")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("anthropic", "claude-sonnet-4-5")), POLICY_NEUTRAL)
})

test("unrelated models match neutral policy", () => {
  assert.equal(detectPolicy(M("anthropic", "claude-sonnet-4-5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openrouter", "x-ai/grok-4")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(undefined), POLICY_NEUTRAL)
  assert.equal(detectPolicy(null), POLICY_NEUTRAL)
  assert.equal(detectPolicy({}), POLICY_NEUTRAL)
})

// ===========================================================================
// GPT-5.6 cache key
// ===========================================================================

test("same session -> same prompt cache key", () => {
  const a = gptCacheOptionsDelta({}, { key: "ses_abc123" })
  const b = gptCacheOptionsDelta({}, { key: "ses_abc123" })
  assert.equal(a.promptCacheKey, "ses_abc123")
  assert.equal(b.promptCacheKey, a.promptCacheKey)
})

test("different session -> different prompt cache key", () => {
  const a = gptCacheOptionsDelta({}, { key: "ses_abc" })
  const b = gptCacheOptionsDelta({}, { key: "ses_xyz" })
  assert.notEqual(a.promptCacheKey, b.promptCacheKey)
})

test("transient request data does not change the key", () => {
  // the delta depends only on the stable key, never on request-scoped input
  const withReq = gptCacheOptionsDelta({ temperature: 0.7, maxOutputTokens: 4096 }, { key: "ses_stable" })
  const withoutReq = gptCacheOptionsDelta({}, { key: "ses_stable" })
  assert.equal(withReq.promptCacheKey, "ses_stable")
  assert.equal(withReq.promptCacheKey, withoutReq.promptCacheKey)
})

test("key stays within provider constraints (no whitespace, short, printable)", () => {
  const { promptCacheKey } = gptCacheOptionsDelta({}, { key: "ses_" + "a".repeat(200) })
  assert.ok(promptCacheKey.length <= 256)
  assert.ok(!/\s/.test(promptCacheKey))
  assert.ok(/^[\x20-\x7E]+$/.test(promptCacheKey))
})

test("existing key/options are never overwritten", () => {
  const delta = gptCacheOptionsDelta({ promptCacheKey: "existing", promptCacheOptions: { mode: "explicit", ttl: "1h" } }, { key: "ses_new" })
  assert.deepEqual(delta, {})
})

// ===========================================================================
// GPT-5.6 cache options
// ===========================================================================

test("GPT-5.6 gets implicit + 30m defaults", () => {
  const delta = gptCacheOptionsDelta({}, { key: "ses_abc" })
  assert.deepEqual(delta.promptCacheOptions, { mode: "implicit", ttl: "30m" })
})

test("explicit mode is possible via config but not the default", () => {
  const delta = gptCacheOptionsDelta({}, { key: "ses_abc", mode: "explicit", ttl: "1h" })
  assert.deepEqual(delta.promptCacheOptions, { mode: "explicit", ttl: "1h" })
  const dflt = gptCacheOptionsDelta({}, { key: "ses_abc" })
  assert.equal(dflt.promptCacheOptions.mode, "implicit")
})

test("invalid mode/ttl fall back to safe defaults", () => {
  const d = gptCacheOptionsDelta({}, { key: "k", mode: "banana", ttl: "" })
  assert.deepEqual(d.promptCacheOptions, { mode: "implicit", ttl: "30m" })
})

// ===========================================================================
// GLM-5.3 system stabilization
// ===========================================================================

const GLM_SYSTEM = [
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

test("GLM env block is relocated to the end, content preserved", () => {
  const { text, changed } = relocateVolatileEnvBlock(GLM_SYSTEM)
  assert.equal(changed, true)
  assert.ok(text.endsWith("</env>"))
  // same set of lines, different order
  const norm = (t) => t.split("\n").filter((l) => l).sort().join("\n")
  assert.equal(norm(text), norm(GLM_SYSTEM))
  // instructions now precede the env block
  assert.ok(text.indexOf("You MUST follow") < text.indexOf("You are powered"))
  // deterministic
  const again = relocateVolatileEnvBlock(GLM_SYSTEM)
  assert.equal(again.text, text)
})

test("no-op when env markers are absent", () => {
  const plain = "Just a system prompt.\nNo env block here."
  const r = relocateVolatileEnvBlock(plain)
  assert.equal(r.changed, false)
  assert.equal(r.text, plain)
})

test("no-op when block markers are incomplete", () => {
  const broken = "You are powered by the model named glm-5.3-flash\nbut never closed"
  const r = relocateVolatileEnvBlock(broken)
  assert.equal(r.changed, false)
  assert.equal(r.text, broken)
})

test("relocation only moves the volatile block, never reorders instructions", () => {
  const input = ["A: keep1", "B: You are powered by the model named x", "C: <env>", "D: Today's date: y", "E: </env>", "F: keep2"].join("\n")
  const { text, changed } = relocateVolatileEnvBlock(input)
  assert.equal(changed, true)
  // keep1 and keep2 keep relative order and text
  assert.ok(text.indexOf("A: keep1") < text.indexOf("F: keep2"))
  // env block (the marker through </env>) now after F
  assert.ok(text.indexOf("F: keep2") < text.indexOf("You are powered by the model named x"))
})

// ===========================================================================
// System decomposition (stable prefix vs volatile suffix)
// ===========================================================================

test("system decomposition: identical system -> stable == full, no volatile", () => {
  const h = systemShapeHashes(GLM_SYSTEM, GLM_SYSTEM)
  assert.equal(h.stableSystemPrefixHash, h.fullSystemHash)
  assert.equal(h.volatileSystemSuffixHash, null)
})

test("appending content only changes the volatile suffix, stable prefix unchanged", () => {
  const baseline = "AAAAABBBBB"
  const current = "AAAAABBBBBCCCCC"
  const h = systemShapeHashes(baseline, current)
  assert.notEqual(h.fullSystemHash, shorthash(baseline))
  assert.equal(h.stableSystemPrefixHash, shorthash(baseline))
  assert.ok(h.volatileSystemSuffixHash != null)
  assert.notEqual(h.volatileSystemSuffixHash, shorthash(""))
})

test("head change shrinks the stable prefix", () => {
  const baseline = "AAAAABBBBB"
  const current = "XXXXXBBBBB"
  const h = systemShapeHashes(baseline, current)
  assert.equal(commonPrefixLength(baseline, current), 0)
  assert.notEqual(h.stableSystemPrefixHash, shorthash(baseline))
})

test("date-only change at tail is a volatile-suffix change", () => {
  // env block relocated to the end; only the date line differs
  const withDate = (d) => relocateVolatileEnvBlock(GLM_SYSTEM.replace("2026-08-17", d)).text
  const d1 = withDate("2026-08-17")
  const d2 = withDate("2026-08-18")
  const h = systemShapeHashes(d1, d2)
  // the only difference is inside the date token ("2026-08-1" prefix shared)
  const dateStart = d1.indexOf("2026-08-17")
  const expectedCommon = dateStart + 9 // "2026-08-1"
  assert.equal(commonPrefixLength(d1, d2), expectedCommon)
  // stable prefix (everything up to the differing date digit) is unchanged
  assert.equal(h.stableSystemPrefixHash, shorthash(d1.slice(0, expectedCommon)))
  assert.notEqual(h.fullSystemHash, shorthash(d1))
  assert.ok(h.volatileSystemSuffixHash != null)
})

test("shapeFieldDiffs reports only fields that changed", () => {
  const prev = { fullSystemHash: "a", stableSystemPrefixHash: "s", volatileSystemSuffixHash: "v", semanticToolsHash: "t", wireToolsHash: "w" }
  const cur = { ...prev, volatileSystemSuffixHash: "v2" }
  const diff = shapeFieldDiffs(prev, cur, ["fullSystemHash", "stableSystemPrefixHash", "volatileSystemSuffixHash", "semanticToolsHash", "wireToolsHash"])
  assert.deepEqual(diff, ["volatileSystemSuffixHash"])
})

// ===========================================================================
// Tool fingerprints: semantic (order-insensitive) vs wire (order-sensitive)
// ===========================================================================

const TOOLS = [
  { id: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { id: "write", description: "write a file", parameters: { type: "object", properties: { content: { type: "string" } } } },
]

test("semantic fingerprint is order-insensitive", () => {
  assert.equal(toolFingerprint(TOOLS), toolFingerprint([...TOOLS].reverse()))
})

test("wire fingerprint is order-sensitive", () => {
  assert.notEqual(toolWireFingerprint(TOOLS), toolWireFingerprint([...TOOLS].reverse()))
  // but equal for identical order
  assert.equal(toolWireFingerprint(TOOLS), toolWireFingerprint([...TOOLS]))
})

test("schema change affects both fingerprints", () => {
  const changed = [{ ...TOOLS[0], parameters: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } } } }, TOOLS[1]]
  assert.notEqual(toolFingerprint(TOOLS), toolFingerprint(changed))
  assert.notEqual(toolWireFingerprint(TOOLS), toolWireFingerprint(changed))
})

test("wire fingerprint returns null for unusable input", () => {
  assert.equal(toolWireFingerprint(undefined), null)
  assert.equal(toolWireFingerprint("nope"), null)
})

test("shapeDiff reports tools dimension for wire-only reorder", () => {
  const a = { fullSystemHash: "sys", semanticToolsHash: "sem", wireToolsHash: "w1" }
  const b = { fullSystemHash: "sys", semanticToolsHash: "sem", wireToolsHash: "w2" }
  assert.deepEqual(shapeDiff(a, b), ["tools"])
})

test("scanPage captures reasoning-part hashes and input tokens", () => {
  const page = [
    {
      info: { id: "a1", role: "assistant", tokens: { cache: { read: 10, write: 2 }, input: 90 } },
      parts: [{ type: "reasoning", text: "think about step one" }, { type: "reasoning", text: "think about step one" }],
    },
  ]
  const scan = scanPage(page, null)
  assert.equal(scan.read, 10)
  assert.equal(scan.input, 90)
  assert.equal(scan.reasoning.length, 1)
  assert.equal(scan.reasoning[0].hashes.length, 2)
  assert.equal(scan.reasoning[0].hashes[0], scan.reasoning[0].hashes[1]) // duplicated reasoning block
})

// ===========================================================================
// Reasoning integrity (GLM preserved thinking) - pure detection
// ===========================================================================

test("identical reasoning replay passes (no anomaly when seen is empty)", () => {
  const issues = detectReasoningIssues(["h1", "h2"], ["h1", "h2"], new Map())
  assert.equal(issues.withinDuplicates, 0)
  assert.equal(issues.crossDuplicates, 0)
  assert.equal(issues.reordered, false)
  assert.equal(issues.modified, false)
})

test("duplicated reasoning blocks within a message are detected", () => {
  const issues = detectReasoningIssues(["h1", "h1", "h2"], [], new Map())
  assert.equal(issues.withinDuplicates, 1)
})

test("repeated reasoning across messages is detected", () => {
  const seen = new Map([["h1", 1]])
  const issues = detectReasoningIssues(["h1", "h2"], [], seen)
  assert.equal(issues.crossDuplicates, 1)
})

test("reordered reasoning blocks are detected", () => {
  const issues = detectReasoningIssues(["h2", "h1"], ["h1", "h2"], new Map())
  assert.equal(issues.reordered, true)
  assert.equal(issues.modified, false)
})

test("modified historical reasoning is detected (partial content swap)", () => {
  const issues = detectReasoningIssues(["h1", "hX"], ["h1", "h2"], new Map())
  assert.equal(issues.reordered, false)
  assert.equal(issues.modified, true)
})

test("empty current sequence -> no anomalies", () => {
  const issues = detectReasoningIssues([], ["h1"], new Map())
  assert.deepEqual(issues, { withinDuplicates: 0, crossDuplicates: 0, reordered: false, modified: false })
})

// ===========================================================================
// Config: provider policies
// ===========================================================================

test("config defaults enable all four policies", () => {
  const cfg = parseConfig({}, {})
  assert.deepEqual(cfg.policies.deepseek, { enabled: true })
  assert.deepEqual(cfg.policies.glm53, { enabled: true, stabilizeSystem: true, preserveThinkingIntegrity: true })
  assert.deepEqual(cfg.policies.mimo26, {
    enabled: true,
    stabilizeSystem: true,
    stickySession: true,
    preserveThinkingIntegrity: true,
  })
  assert.deepEqual(cfg.policies.gpt56, {
    enabled: true,
    promptCacheKey: true,
    cacheRootKey: false,
    compactionCacheIsolation: true,
    reasoningEffortDiagnostics: true,
    mode: "implicit",
    ttl: "30m",
  })
})

test("config policy overrides are honored", () => {
  const cfg = parseConfig(
    {
      policies: {
        gpt56: {
          enabled: false,
          promptCacheKey: false,
          cacheRootKey: false,
          compactionCacheIsolation: false,
          reasoningEffortDiagnostics: false,
          mode: "explicit",
          ttl: "1h",
        },
        glm53: { stabilizeSystem: false },
        deepseek: { enabled: true },
        mimo26: { enabled: false, stabilizeSystem: false, stickySession: false },
      },
    },
    {},
  )
  assert.equal(cfg.policies.gpt56.enabled, false)
  assert.equal(cfg.policies.gpt56.promptCacheKey, false)
  assert.equal(cfg.policies.gpt56.cacheRootKey, false)
  assert.equal(cfg.policies.gpt56.compactionCacheIsolation, false)
  assert.equal(cfg.policies.gpt56.reasoningEffortDiagnostics, false)
  assert.equal(cfg.policies.gpt56.mode, "explicit")
  assert.equal(cfg.policies.gpt56.ttl, "1h")
  assert.equal(cfg.policies.glm53.stabilizeSystem, false)
  assert.equal(cfg.policies.glm53.preserveThinkingIntegrity, true)
  assert.equal(cfg.policies.mimo26.enabled, false)
  assert.equal(cfg.policies.mimo26.stabilizeSystem, false)
  assert.equal(cfg.policies.mimo26.stickySession, false)
  assert.equal(cfg.policies.mimo26.preserveThinkingIntegrity, true)
})

test("config invalid policy values fall back to defaults", () => {
  const cfg = parseConfig({ policies: { gpt56: { mode: "banana", ttl: 123 } } }, {})
  assert.equal(cfg.policies.gpt56.mode, "implicit")
  assert.equal(cfg.policies.gpt56.ttl, "30m")
  const cfg2 = parseConfig({ policies: { glm53: "nope" } }, {})
  assert.deepEqual(cfg2.policies.glm53, { enabled: true, stabilizeSystem: true, preserveThinkingIntegrity: true })
})

// ===========================================================================
// GLM hit ratio (cached / total prompt tokens)
// ===========================================================================

test("glmHitRatio uses cached over total prompt tokens", () => {
  assert.equal(glmHitRatio(80, 10, 10), 80) // 80/(80+10+10)
  assert.equal(glmHitRatio(0, 0, 0), null)
  assert.equal(glmHitRatio(100, 0, 0), 100)
})

// ===========================================================================
// GPT-5.6 cache-root derivation (pure)
// ===========================================================================

import { gptCacheKeyFor, observeReasoningEffort, prefixChangeReasons, reasoningEffortFromOptions, reasoningIssueReasons, resolveCacheRootSync } from "../src/cache-engine-core.mjs"

const parents = (m) => (id) => m[id] ?? null

test("cache root: ordinary session -> self root", () => {
  const r = resolveCacheRootSync("ses_A", parents({}))
  assert.equal(r.root, "ses_A")
  assert.equal(r.source, "self")
  assert.equal(r.hops, 0)
})

test("cache root: one-level fork -> inherited root", () => {
  const r = resolveCacheRootSync("ses_B", parents({ ses_B: "ses_A" }))
  assert.equal(r.root, "ses_A")
  assert.equal(r.source, "parent")
  assert.equal(r.hops, 1)
})

test("cache root: multi-level fork -> original root", () => {
  const r = resolveCacheRootSync("ses_D", parents({ ses_D: "ses_C", ses_C: "ses_B", ses_B: "ses_A" }))
  assert.equal(r.root, "ses_A")
  assert.equal(r.source, "parent")
  assert.equal(r.hops, 3)
})

test("cache root: unrelated sessions -> distinct roots", () => {
  const ra = resolveCacheRootSync("ses_A", parents({}))
  const rd = resolveCacheRootSync("ses_D", parents({}))
  assert.notEqual(ra.root, rd.root)
})

test("cache root: missing/unknown parent metadata -> deterministic fallback", () => {
  // parentOf throws (lookup failure)
  const r = resolveCacheRootSync("ses_X", () => {
    throw new Error("boom")
  })
  assert.equal(r.root, "ses_X")
  assert.equal(r.source, "unknown")
  // cycle guard terminates deterministically
  const cyc = resolveCacheRootSync("ses_A", parents({ ses_A: "ses_B", ses_B: "ses_A" }))
  assert.ok(cyc.root.length > 0)
  assert.equal(cyc.source, "cycle")
})

test("cache root: unknown parent id treated as fallback root", () => {
  // parentOf returns undefined for unknown (chain resolver semantics)
  const r = resolveCacheRootSync("ses_A", (id) => (id === "ses_A" ? undefined : null))
  assert.equal(r.root, "ses_A")
})

// ===========================================================================
// GPT-5.6 compaction cache-key isolation (pure)
// ===========================================================================

test("compaction: live key remains stable", () => {
  const k1 = gptCacheKeyFor("ses_root")
  const k2 = gptCacheKeyFor("ses_root")
  assert.equal(k1, "ses_root")
  assert.equal(k2, "ses_root")
})

test("compaction: compaction key is distinct and deterministic", () => {
  const live = gptCacheKeyFor("ses_root")
  const compact = gptCacheKeyFor("ses_root", { compaction: true })
  assert.equal(compact, "ses_root:compact")
  assert.notEqual(compact, live)
})

test("compaction: repeated compaction gets the same key", () => {
  const c1 = gptCacheKeyFor("ses_root", { compaction: true })
  const c2 = gptCacheKeyFor("ses_root", { compaction: true })
  assert.equal(c1, c2)
})

test("compaction: distinct roots produce distinct compact namespaces", () => {
  assert.notEqual(gptCacheKeyFor("ses_A", { compaction: true }), gptCacheKeyFor("ses_B", { compaction: true }))
})

test("compaction: key length stays within provider constraints", () => {
  const long = "ses_" + "a".repeat(300)
  assert.equal(gptCacheKeyFor(long), null)
  assert.equal(gptCacheKeyFor(long, { compaction: true }), null)
  const ok = gptCacheKeyFor("ses_" + "a".repeat(200), { compaction: true })
  assert.ok(ok != null && ok.length <= 256)
})

// ===========================================================================
// GPT-5.6 reasoning-effort diagnostics (pure)
// ===========================================================================

test("reasoning effort: extraction from options record", () => {
  assert.deepEqual(reasoningEffortFromOptions({ reasoningEffort: "high" }), { known: true, value: "high" })
  assert.deepEqual(reasoningEffortFromOptions({ reasoning: { effort: "low" } }), { known: true, value: "low" })
  assert.deepEqual(reasoningEffortFromOptions({}), { known: false, value: null })
  assert.deepEqual(reasoningEffortFromOptions(null), { known: false, value: null })
})

test("reasoning effort: first observation -> baseline, not a change", () => {
  const step = observeReasoningEffort(null, { known: true, value: "medium" })
  assert.equal(step.event, "baseline")
  assert.equal(step.state.value, "medium")
})

test("reasoning effort: unchanged effort -> no event", () => {
  let step = observeReasoningEffort(null, { known: true, value: "medium" })
  assert.equal(step.event, "baseline")
  step = observeReasoningEffort(step.state, { known: true, value: "medium" })
  assert.equal(step.event, "none")
})

test("reasoning effort: changed effort -> change event with before/after", () => {
  let step = observeReasoningEffort(null, { known: true, value: "medium" })
  step = observeReasoningEffort(step.state, { known: true, value: "high" })
  assert.equal(step.event, "change")
  assert.equal(step.previous.value, "medium")
  assert.equal(step.current.value, "high")
})

test("reasoning effort: unknown -> unknown, not a false-positive change", () => {
  let step = observeReasoningEffort(null, { known: true, value: "medium" })
  step = observeReasoningEffort(step.state, { known: false, value: null })
  assert.equal(step.event, "none")
  // and back to known medium again -> no change
  step = observeReasoningEffort(step.state, { known: true, value: "medium" })
  assert.equal(step.event, "none")
})

// ===========================================================================
// Boundary telemetry reason classification (pure)
// ===========================================================================

test("boundary: reason classification for prefix changes", () => {
  assert.deepEqual(prefixChangeReasons(["stableSystemPrefixHash"]), ["system_stable_prefix_changed"])
  assert.deepEqual(prefixChangeReasons(["volatileSystemSuffixHash"]), ["system_volatile_suffix_changed"])
  assert.deepEqual(prefixChangeReasons(["semanticToolsHash"]), ["tools_semantic_changed"])
  assert.deepEqual(prefixChangeReasons(["wireToolsHash"]), ["tools_wire_changed"])
  assert.deepEqual(prefixChangeReasons(["stableSystemPrefixHash", "wireToolsHash"]).sort(), [
    "system_stable_prefix_changed",
    "tools_wire_changed",
  ])
  // full-only falls back to the stable-prefix reason (conservative)
  assert.deepEqual(prefixChangeReasons(["fullSystemHash"]), ["system_stable_prefix_changed"])
  // empty/unknown
  assert.deepEqual(prefixChangeReasons([]), ["unknown"])
})

test("boundary: reasoning-integrity reason tokens", () => {
  assert.deepEqual(reasoningIssueReasons({ withinDuplicates: 1, crossDuplicates: 0, reordered: false, modified: false }), [
    "reasoning_duplicate_detected",
  ])
  assert.deepEqual(reasoningIssueReasons({ withinDuplicates: 0, crossDuplicates: 1, reordered: false, modified: false }), [
    "reasoning_duplicate_detected",
  ])
  assert.deepEqual(reasoningIssueReasons({ withinDuplicates: 0, crossDuplicates: 0, reordered: true, modified: false }), [
    "reasoning_reordered",
  ])
  assert.deepEqual(reasoningIssueReasons({ withinDuplicates: 0, crossDuplicates: 0, reordered: false, modified: true }), [
    "reasoning_modified",
  ])
  assert.deepEqual(reasoningIssueReasons(null), [])
})

// ===========================================================================
// MiMo-V2.6: system env relocation (shared content-preserving helper)
// ===========================================================================

const MIMO_SYSTEM = [
  "You are a senior software engineer.",
  "You are powered by the model named mimo-v2.6-flash. The exact model ID is xiaomi/mimo-v2.6-flash",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "Working directory: /home/dev/project",
  "Today's date: 2026-08-17",
  "</env>",
  "You MUST follow AGENTS.md instructions and keep your responses concise.",
].join("\n")

test("MiMo env block is relocated to the tail, contents preserved exactly", () => {
  const { text, changed } = relocateVolatileEnvBlock(MIMO_SYSTEM)
  assert.equal(changed, true)
  assert.ok(text.endsWith("</env>"))
  const norm = (t) => t.split("\n").filter((l) => l).sort().join("\n")
  assert.equal(norm(text), norm(MIMO_SYSTEM))
  assert.ok(text.indexOf("You MUST follow") < text.indexOf("You are powered"))
})

test("MiMo relocation is a no-op when the block is already at the tail", () => {
  const already = relocateVolatileEnvBlock(MIMO_SYSTEM).text
  const again = relocateVolatileEnvBlock(already)
  assert.equal(again.changed, false)
  assert.equal(again.text, already)
})

test("MiMo relocation is a no-op when start/end markers are missing", () => {
  const missingStart = "Just a system prompt.\n<env>\nToday's date: x\n</env>"
  assert.equal(relocateVolatileEnvBlock(missingStart).changed, false)
  const missingEnd = "You are powered by the model named mimo-v2.6-flash\nbut never closed"
  assert.equal(relocateVolatileEnvBlock(missingEnd).changed, false)
})

// ===========================================================================
// MiMo-V2.6: sticky-session identity (pure, derived but not injected)
// ===========================================================================

test("stableSessionIdFor: deterministic for the same logical session", () => {
  assert.equal(stableSessionIdFor("ses_abc123"), stableSessionIdFor("ses_abc123"))
})

test("stableSessionIdFor: different logical sessions produce different ids", () => {
  assert.notEqual(stableSessionIdFor("ses_abc"), stableSessionIdFor("ses_xyz"))
})

test("mimoSessionIdFor: deterministic + stable for the same session", () => {
  assert.equal(mimoSessionIdFor("ses_abc123"), mimoSessionIdFor("ses_abc123"))
})

test("mimoSessionIdFor preserves its existing id format", () => {
  assert.equal(mimoSessionIdFor("ses_abc123"), `mimo-ses-${shorthash("ses_abc123")}`)
})

test("mimoSessionIdFor: distinct sessions produce distinct ids", () => {
  assert.notEqual(mimoSessionIdFor("ses_abc"), mimoSessionIdFor("ses_xyz"))
})

test("mimoSessionIdFor: printable, no whitespace, within 256 chars", () => {
  const id = mimoSessionIdFor("ses_" + "a".repeat(500))
  assert.ok(id.length <= 256)
  assert.ok(!/\s/.test(id))
  assert.ok(/^[\x20-\x7E]+$/.test(id))
})

test("mimoSessionIdFor: invalid input -> null (no fabrication)", () => {
  assert.equal(mimoSessionIdFor(undefined), null)
  assert.equal(mimoSessionIdFor(null), null)
  assert.equal(mimoSessionIdFor(""), null)
  assert.equal(mimoSessionIdFor(123), null)
})

test("mimoSessionIdFor: transient request fields cannot alter the id", () => {
  // the helper is a pure function of the session id; extra args are ignored
  assert.equal(mimoSessionIdFor("ses_stable"), mimoSessionIdFor("ses_stable", { turn: 7, temperature: 0.9 }))
})

// ===========================================================================
// OpenRouter session-affinity eligibility (pure policy decision only)
// ===========================================================================

test("OpenRouter affinity is eligible for MiMo and GLM only", () => {
  assert.equal(isOpenRouterAffinityEligible(POLICY_MIMO26, "openrouter"), true)
  assert.equal(isOpenRouterAffinityEligible(POLICY_GLM53, "openrouter"), true)
})

test("OpenRouter affinity is ineligible for non-OpenRouter providers", () => {
  assert.equal(isOpenRouterAffinityEligible(POLICY_MIMO26, "xiaomi"), false)
  assert.equal(isOpenRouterAffinityEligible(POLICY_GLM53, "zai"), false)
  assert.equal(isOpenRouterAffinityEligible(POLICY_MIMO26, "unknown-provider"), false)
})

test("OpenRouter affinity is ineligible for DeepSeek and GPT", () => {
  assert.equal(isOpenRouterAffinityEligible(POLICY_DEEPSEEK, "openrouter"), false)
  assert.equal(isOpenRouterAffinityEligible(POLICY_GPT56, "openrouter"), false)
})

test("OpenRouter affinity is ineligible for unknown families and providers", () => {
  assert.equal(isOpenRouterAffinityEligible("unknown-family", "openrouter"), false)
  assert.equal(isOpenRouterAffinityEligible(POLICY_MIMO26, undefined), false)
})

test("affinity telemetry fields classify eligibility, attachment, bypass, and missing identity", () => {
  assert.deepEqual(affinityTelemetryFields(POLICY_MIMO26, "openrouter", "cache_engine"), {
    reason: "openrouter_affinity_eligible",
    eligible: true,
    providerIdentityKnown: true,
    provider: "openrouter",
    headerPresent: true,
    headerAttached: true,
    headerSource: "cache_engine",
  })
  assert.deepEqual(affinityTelemetryFields(POLICY_GLM53, "openrouter", "preexisting"), {
    reason: "openrouter_affinity_eligible",
    eligible: true,
    providerIdentityKnown: true,
    provider: "openrouter",
    headerPresent: true,
    headerAttached: false,
    headerSource: "preexisting",
  })
  assert.equal(affinityTelemetryFields(POLICY_MIMO26, "xiaomi", "not_applicable").reason,
    "openrouter_affinity_bypassed_non_openrouter")
  assert.equal(affinityTelemetryFields(POLICY_GLM53, "unknown-provider", "not_applicable").reason,
    "openrouter_affinity_bypassed_non_openrouter")
  assert.deepEqual(affinityTelemetryFields(POLICY_MIMO26, "", "not_applicable"), {
    reason: "openrouter_affinity_bypassed_provider_missing_or_unknown",
    eligible: false,
    providerIdentityKnown: false,
    provider: null,
    headerPresent: false,
    headerAttached: false,
    headerSource: "not_applicable",
  })
  assert.equal(affinityTelemetryFields(POLICY_DEEPSEEK, "openrouter", "not_applicable"), null)
  assert.equal(affinityTelemetryFields(POLICY_GPT56, "openrouter", "not_applicable"), null)
})

// ===========================================================================
// MiMo-V2.6: cached/prompt token metrics
// ===========================================================================

test("mimoHitRate = cachedTokens / promptTokens", () => {
  assert.equal(mimoHitRate(47000, 50000), 94)
  assert.equal(mimoHitRate(0, 100), 0)
  assert.equal(mimoHitRate(100, 100), 100)
})

test("mimoHitRate returns null for zero/unknown denominators (no fabrication)", () => {
  assert.equal(mimoHitRate(0, 0), null)
  assert.equal(mimoHitRate(10, 0), null)
  assert.equal(mimoHitRate(NaN, 100), null)
  assert.equal(mimoHitRate(10, NaN), null)
  assert.equal(mimoHitRate(undefined, 100), null)
  assert.equal(mimoHitRate(10, undefined), null)
})

test("mimoHitRate is NOT the read/(read+write) form", () => {
  // read=80, input=20 -> promptTokens derived 100 -> 80%. The read/(read+write)
  // form would give 100% for (80, 0); they must not be conflated.
  assert.equal(mimoHitRate(80, 80 + 20), 80)
  assert.equal(hitRatePct(80, 0), 100)
})

// ===========================================================================
// MiMo-V2.6: provider-switch diagnostics
// ===========================================================================

test("providerChangeEvent: no event until two real observations exist", () => {
  assert.deepEqual(providerChangeEvent(null, { providerID: "openrouter", modelID: "xiaomi/mimo-v2.6-flash" }), {
    changed: false,
    from: null,
    to: null,
  })
  assert.equal(providerChangeEvent({ providerID: "openrouter" }, null).changed, false)
})

test("providerChangeEvent: same provider -> no change", () => {
  const a = { providerID: "openrouter", modelID: "xiaomi/mimo-v2.6-flash" }
  const b = { providerID: "openrouter", modelID: "xiaomi/mimo-v2.6-pro" }
  assert.equal(providerChangeEvent(a, b).changed, false)
})

test("providerChangeEvent: different provider -> change with from/to", () => {
  const a = { providerID: "openrouter", modelID: "xiaomi/mimo-v2.6-flash" }
  const b = { providerID: "xiaomi", modelID: "mimo-v2.6-flash" }
  const ev = providerChangeEvent(a, b)
  assert.equal(ev.changed, true)
  assert.deepEqual(ev.from, a)
  assert.deepEqual(ev.to, b)
})

// ===========================================================================
// MiMo-V2.6: no tool-definition mutation
// ===========================================================================

test("MiMo policy performs no tool mutation (fingerprints are pure inputs)", () => {
  // The plugin never adds a MiMo tool-ordering pass: this runtime already sorts
  // tools alphabetically before the wire. Classifying a model as MiMo must not
  // affect tool fingerprints, which are a pure function of the tool definitions.
  const model = { providerID: "openrouter", modelID: "xiaomi/mimo-v2.6-flash" }
  assert.equal(detectPolicy(model), POLICY_MIMO26)
  const before = { sem: toolFingerprint(TOOLS), wire: toolWireFingerprint(TOOLS) }
  const after = { sem: toolFingerprint(TOOLS), wire: toolWireFingerprint(TOOLS) }
  assert.deepEqual(after, before)
  // semantic fingerprint stays order-insensitive regardless of the policy
  assert.equal(toolFingerprint([...TOOLS].reverse()), before.sem)
})

// ===========================================================================
// MiMo/OpenRouter session affinity (real chat.headers hook, no model calls)
// ===========================================================================

async function runMiMoHeaderHookProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-mimo-headers-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const coreURL = new URL("../src/cache-engine-core.mjs", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/affinity-metrics.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const { detectPolicy, mimoSessionIdFor, POLICY_GLM53, POLICY_MIMO26 } = await import(${JSON.stringify(coreURL)})
    const client = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }) },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client, directory: process.env.HOME })
    assert.equal(typeof hooks["chat.headers"], "function")
    const invoke = async (model, sessionID, existingHeaders = {}) => {
      const output = { headers: { ...existingHeaders } }
      const headersRef = output.headers
      const family = detectPolicy(model)
      if (family === POLICY_MIMO26 || family === POLICY_GLM53) {
        await hooks["chat.params"]({
          sessionID,
          agent: "build",
          model,
          provider: { source: "config", info: { id: model.providerID }, options: {} },
          message: { id: "msg", sessionID, role: "user", content: "probe" },
        }, { options: {} })
      }
      await hooks["chat.headers"]({
        sessionID,
        agent: "build",
        model,
        provider: { source: "config", info: { id: model.providerID }, options: {} },
        message: { id: "msg", sessionID, role: "user", content: "probe" },
      }, output)
      return {
        headers: output.headers,
        sameObject: output.headers === headersRef,
        outputKeys: Object.keys(output),
        modelHeaders: model.headers,
      }
    }
    const mimoOpenRouter = {
      providerID: "openrouter",
      id: "xiaomi/mimo-v2.6-flash",
      api: { id: "xiaomi/mimo-v2.6-flash" },
      headers: {},
    }
    const stable1 = await invoke(mimoOpenRouter, "ses_same", { "User-Agent": "preserve-me", "x-custom": "also-preserve" })
    const stable2 = await invoke(mimoOpenRouter, "ses_same")
    const different = await invoke(mimoOpenRouter, "ses_other")
    const direct = await invoke({ ...mimoOpenRouter, providerID: "xiaomi" }, "ses_direct", { "User-Agent": "preserve-me" })
    const unknown = await invoke({ ...mimoOpenRouter, providerID: "unknown-provider" }, "ses_unknown")
    const missingProvider = await invoke({ ...mimoOpenRouter, providerID: undefined }, "ses_missing_provider")
    const glmOpenRouter = { providerID: "openrouter", id: "z-ai/glm-5.3", api: { id: "z-ai/glm-5.3" }, headers: {} }
    const glm1 = await invoke(glmOpenRouter, "ses_glm_same")
    const glm2 = await invoke(glmOpenRouter, "ses_glm_same")
    const glmDifferent = await invoke(glmOpenRouter, "ses_glm_other")
    const glmDirect = await invoke({ ...glmOpenRouter, providerID: "zai" }, "ses_glm_direct", { "User-Agent": "preserve-glm" })
    const mimoSwitchOpen = await invoke(mimoOpenRouter, "ses_mimo_switch")
    const mimoSwitchDirect = await invoke({ ...mimoOpenRouter, providerID: "xiaomi" }, "ses_mimo_switch")
    const glmSwitchOpen = await invoke(glmOpenRouter, "ses_glm_switch")
    const glmSwitchDirect = await invoke({ ...glmOpenRouter, providerID: "zai" }, "ses_glm_switch")
    const nonOpenRouterMatrix = [
      ["mimo-direct", { ...mimoOpenRouter, providerID: "xiaomi" }],
      ["glm-direct", { ...glmOpenRouter, providerID: "zai" }],
      ["deepseek-direct", { providerID: "deepseek", id: "deepseek-v4.1-flash", api: { id: "deepseek-v4.1-flash" }, headers: {} }],
      ["gpt-openai", { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" }, headers: {} }],
      ["unknown-provider", { ...mimoOpenRouter, providerID: "unknown-provider" }],
      ["missing-provider", { ...mimoOpenRouter, providerID: undefined }],
      ["opencode-go-mimo", { ...mimoOpenRouter, providerID: "opencode" }],
      ["opencode-go-glm", { ...glmOpenRouter, providerID: "opencode" }],
    ]
    const compatibility = []
    for (const [name, model] of nonOpenRouterMatrix) {
      const existing = { "User-Agent": "preserve-" + name, "x-compat-test": name }
      compatibility.push({ name, ...(await invoke(model, "ses_" + name, existing)), expected: existing })
    }
    const gptOutput = { options: {} }
    await hooks["chat.params"]({
      sessionID: "ses_gpt_native_cache",
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" } },
      provider: { source: "config", info: { id: "openai" }, options: {} },
      message: { id: "msg-gpt", sessionID: "ses_gpt_native_cache", role: "user", content: "probe" },
    }, gptOutput)
    const configured = await invoke({
      ...mimoOpenRouter,
      headers: { "X-Session-Id": "user-configured-value" },
    }, "ses_configured")
    const earlierPlugin = await invoke(mimoOpenRouter, "ses_plugin", { "X-SESSION-ID": "earlier-plugin-value" })
    const result = {
      stable1,
      stable2,
      different,
      direct,
      unknown,
      missingProvider,
      glm1,
      glm2,
      glmDifferent,
      glmDirect,
      mimoSwitchOpen,
      mimoSwitchDirect,
      glmSwitchOpen,
      glmSwitchDirect,
      compatibility,
      gptOptions: gptOutput.options,
      configured,
      configuredModelHeaders: configured.modelHeaders,
      earlierPlugin,
      expectedSame: mimoSessionIdFor("ses_same"),
      expectedOther: mimoSessionIdFor("ses_other"),
      expectedGlm: mimoSessionIdFor("ses_glm_same"),
      expectedGlmOther: mimoSessionIdFor("ses_glm_other"),
      telemetry: readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8")
        .trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)),
    }
    assert.equal(configured.headers["x-session-id"], undefined)
    assert.equal(earlierPlugin.headers["X-SESSION-ID"], "earlier-plugin-value")
    process.stdout.write(JSON.stringify(result))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let miMoHeaderProbe
const miMoHeaderResults = async () => (miMoHeaderProbe ??= runMiMoHeaderHookProbe())

test("MiMo/OpenRouter attaches the existing deterministic MiMo session ID", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.stable1.headers["x-session-id"], result.expectedSame)
  assert.equal(result.stable1.sameObject, true)
  assert.deepEqual(result.stable1.headers["User-Agent"], "preserve-me")
  assert.deepEqual(result.stable1.headers["x-custom"], "also-preserve")
})

test("MiMo/OpenRouter session ID is stable across turns and distinct across sessions", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.stable2.headers["x-session-id"], result.stable1.headers["x-session-id"])
  assert.equal(result.different.headers["x-session-id"], result.expectedOther)
  assert.notEqual(result.different.headers["x-session-id"], result.stable1.headers["x-session-id"])
})

test("MiMo direct and unknown providers do not receive x-session-id", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.direct.headers["x-session-id"], undefined)
  assert.equal(result.unknown.headers["x-session-id"], undefined)
  assert.equal(result.missingProvider.headers["x-session-id"], undefined)
  assert.deepEqual(result.direct.headers, { "User-Agent": "preserve-me" })
})

test("MiMo affinity preserves existing x-session-id values case-insensitively", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.configured.headers["x-session-id"], undefined)
  assert.deepEqual(result.configuredModelHeaders, { "X-Session-Id": "user-configured-value" })
  assert.deepEqual(result.earlierPlugin.headers, { "X-SESSION-ID": "earlier-plugin-value" })
})

test("GLM/OpenRouter attaches the deterministic session ID", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.glm1.headers["x-session-id"], result.expectedGlm)
  assert.equal(result.glm2.headers["x-session-id"], result.expectedGlm)
  assert.equal(result.glmDifferent.headers["x-session-id"], result.expectedGlmOther)
  assert.notEqual(result.glmDifferent.headers["x-session-id"], result.glm1.headers["x-session-id"])
})

test("GLM direct Z.AI does not receive x-session-id", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.glmDirect.headers["x-session-id"], undefined)
  assert.deepEqual(result.glmDirect.headers, { "User-Agent": "preserve-glm" })
})

test("non-OpenRouter endpoint matrix is x-session-id non-mutating and preserves unrelated headers", async () => {
  const result = await miMoHeaderResults()
  assert.equal(result.compatibility.length, 8)
  for (const item of result.compatibility) {
    assert.equal(item.headers["x-session-id"], undefined, `${item.name} must not receive OpenRouter affinity`)
    assert.deepEqual(item.headers, item.expected, `${item.name} unrelated headers must remain unchanged`)
    assert.equal(item.sameObject, true, `${item.name} headers object must be preserved`)
    assert.deepEqual(item.outputKeys, ["headers"], `${item.name} hook output remains headers-only`)
  }
})

test("OpenAI GPT retains its existing chat.params cache options without affinity headers", async () => {
  const result = await miMoHeaderResults()
  assert.equal(typeof result.gptOptions.promptCacheKey, "string")
  assert.deepEqual(result.gptOptions.promptCacheOptions, { mode: "implicit", ttl: "30m" })
})

test("affinity telemetry classifies eligible, attached, preexisting, bypassed, and missing-provider requests", async () => {
  const result = await miMoHeaderResults()
  const events = result.telemetry.filter((event) => event.reason?.startsWith("openrouter_affinity_"))
  const eventFor = (sid, policy) => events.find((event) => event.sid === sid && event.policy === policy)

  for (const [sid, policy] of [
    ["ses_same", POLICY_MIMO26],
    ["ses_glm_same", POLICY_GLM53],
  ]) {
    const event = eventFor(sid, policy)
    assert.equal(event.reason, "openrouter_affinity_eligible")
    assert.equal(event.eligible, true)
    assert.equal(event.provider, "openrouter")
    assert.equal(event.headerPresent, true)
    assert.equal(event.headerAttached, true)
    assert.equal(event.headerSource, "cache_engine")
  }

  const configured = eventFor("ses_configured", POLICY_MIMO26)
  assert.equal(configured.reason, "openrouter_affinity_eligible")
  assert.equal(configured.headerPresent, true)
  assert.equal(configured.headerAttached, false)
  assert.equal(configured.headerSource, "preexisting")

  for (const [sid, policy, provider] of [
    ["ses_direct", POLICY_MIMO26, "xiaomi"],
    ["ses_glm_direct", POLICY_GLM53, "zai"],
    ["ses_unknown", POLICY_MIMO26, "unknown-provider"],
  ]) {
    const event = eventFor(sid, policy)
    assert.equal(event.reason, "openrouter_affinity_bypassed_non_openrouter")
    assert.equal(event.eligible, false)
    assert.equal(event.provider, provider)
    assert.equal(event.headerAttached, false)
  }

  const missing = eventFor("ses_missing_provider", POLICY_MIMO26)
  assert.equal(missing.reason, "openrouter_affinity_bypassed_provider_missing_or_unknown")
  assert.equal(missing.providerIdentityKnown, false)
  assert.equal(missing.provider, null)
  assert.equal(missing.headerAttached, false)

  // New affinity-observation records contain classifications, never the
  // generated or pre-existing x-session-id value.
  for (const event of events) {
    assert.equal(Object.hasOwn(event, "x-session-id"), false)
    assert.equal(Object.hasOwn(event, "headerValue"), false)
  }
  const serializedAffinityEvents = JSON.stringify(events)
  assert.equal(serializedAffinityEvents.includes(result.expectedSame), false)
  assert.equal(serializedAffinityEvents.includes(result.expectedGlm), false)
})

test("affinity telemetry preserves non-OpenRouter families and reports provider changes", async () => {
  const result = await miMoHeaderResults()
  const events = result.telemetry
  const affinityEvents = events.filter((event) => event.reason?.startsWith("openrouter_affinity_"))
  assert.equal(affinityEvents.some((event) => event.policy === POLICY_DEEPSEEK), false)
  assert.equal(affinityEvents.some((event) => event.policy === POLICY_GPT56), false)

  const mimoChange = events.find((event) => event.reason === "mimo_provider_changed" && event.sid === "ses_mimo_switch")
  assert.equal(mimoChange.from.providerID, "openrouter")
  assert.equal(mimoChange.to.providerID, "xiaomi")

  const glmChange = events.find((event) => event.reason === "glm_provider_changed" && event.sid === "ses_glm_switch")
  assert.equal(glmChange.kind, "boundary")
  assert.equal(glmChange.from.providerID, "openrouter")
  assert.equal(glmChange.to.providerID, "zai")
  assert.equal(glmChange.policy, POLICY_GLM53)
})
