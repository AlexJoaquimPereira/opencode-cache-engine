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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  POLICY_DEEPSEEK,
  POLICY_GLM53,
  POLICY_GPT56,
  POLICY_NEUTRAL,
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
  loadConfig,
  nextProcessedCursor,
  parseConfig,
  relocateVolatileEnvBlock,
  scanPage,
  shapeDiff,
  shapeFieldDiffs,
  shorthash,
  shouldAggregate,
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

test("config defaults enable all three policies", () => {
  const cfg = parseConfig({}, {})
  assert.deepEqual(cfg.policies.deepseek, { enabled: true })
  assert.deepEqual(cfg.policies.glm53, { enabled: true, stabilizeSystem: true, preserveThinkingIntegrity: true })
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
