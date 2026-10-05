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
  POLICY_CLAUDE,
  POLICY_DEEPSEEK,
  POLICY_GEMINI,
  POLICY_GLM53,
  POLICY_GPT56,
  POLICY_KIMI,
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
  gptCacheOptionFieldNames,
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
import {
  BASELINES,
  MODEL_ALIASES,
  OVERLAYS,
  POLICY_REGISTRY,
  isDeepseekV4OrLater,
  isGlm53OrLater,
  isGpt56OrLater,
  isMimoAfterV26,
  explainPolicyResolution,
  resolveLegacyFamily,
  resolvePolicy,
  resolveRuntimePolicy,
} from "../src/cache-policy-core.mjs"

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
  // Oldest-first (chronological), as returned by the runtime.
  const page = [asst("m1", 100, 20), asst("m2", 50, 10), asst("m3", 25, 5)]
  const first = scanPage(page, null)
  assert.equal(first.count, 3)
  assert.equal(first.read, 175)
  assert.equal(first.write, 35)
  // Boundary becomes the NEWEST processed message (last element, oldest-first).
  const cursor = nextProcessedCursor(page, null)
  assert.equal(cursor, "m3")

  // Second idle: no new messages after the boundary -> nothing counted.
  const second = scanPage(page, cursor)
  assert.equal(second.count, 0)
  assert.equal(second.read, 0)
  assert.equal(second.reachedStart, true)
})

// --- 7. multiple new assistant messages -> each counted once -----------------
test("only messages newer than the cursor are aggregated", () => {
  const oldPage = [asst("m1", 100, 20), asst("m2", 50, 10)]
  const cursor = nextProcessedCursor(oldPage, null)
  assert.equal(cursor, "m2")

  // A new assistant message appends at the END (newest).
  const nextPage = [asst("m1", 100, 20), asst("m2", 50, 10), asst("m0", 10, 2)]
  const scan = scanPage(nextPage, cursor)
  assert.equal(scan.count, 1)
  assert.equal(scan.read, 10)
  assert.equal(scan.reachedStart, true)
})

test("missing boundary without a watermark counts nothing and advances cursor to newest", () => {
  const page = [asst("m1", 10, 2), asst("m2", 20, 4)]
  const scan = scanPage(page, "ghost-cursor")
  assert.equal(scan.reachedStart, false)
  // No watermark known -> safe undercount rather than a double count.
  assert.equal(scan.count, 0)
  const cursor = nextProcessedCursor(page, "ghost-cursor")
  assert.equal(cursor, "m2")
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

test("v0.5.0: hit-rate ratio is safe for zero, write-only, and non-finite inputs", () => {
  assert.equal(hitRatePct(0, 20), 0) // write-only, no fabricated hit
  assert.equal(hitRatePct(20, 0), 100) // read-only
  assert.equal(hitRatePct(0, 0), null) // no data
  assert.equal(hitRatePct(NaN, 5), null)
  assert.equal(hitRatePct(5, Infinity), null)
  assert.equal(hitRatePct(undefined, 5), null)
  assert.equal(hitRatePct(-1, 0), null) // denom <= 0
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

// --- v0.4.7 K-A: metricsFile precedence is defaults -> file -> env override ---
test("v0.4.7 K-A: metricsFile precedence is defaults -> file -> env override", () => {
  // file metricsFile only -> file path used
  const fileOnly = parseConfig({ metricsFile: "~/file/metrics.jsonl" }, {})
  assert.equal(fileOnly.metricsFile, join(homedir(), "file/metrics.jsonl"))

  // environment only -> env path used
  const envOnly = parseConfig(undefined, { CACHE_ENGINE_METRICS_FILE: "~/env/metrics.jsonl" })
  assert.equal(envOnly.metricsFile, join(homedir(), "env/metrics.jsonl"))

  // file + env -> env wins (regression: env used to be applied first, then the
  // config file silently overrode it)
  const both = parseConfig(
    { metricsFile: "~/file/metrics.jsonl" },
    { CACHE_ENGINE_METRICS_FILE: "~/env/metrics.jsonl" },
  )
  assert.equal(both.metricsFile, join(homedir(), "env/metrics.jsonl"))

  // empty env -> file remains active
  const emptyEnv = parseConfig({ metricsFile: "~/file/metrics.jsonl" }, { CACHE_ENGINE_METRICS_FILE: "" })
  assert.equal(emptyEnv.metricsFile, join(homedir(), "file/metrics.jsonl"))

  // absolute env path -> preserved, not expanded or rewritten
  const abs = parseConfig({ metricsFile: "~/file/metrics.jsonl" }, { CACHE_ENGINE_METRICS_FILE: "/abs/metrics.jsonl" })
  assert.equal(abs.metricsFile, "/abs/metrics.jsonl")

  // unrelated values are untouched by the env override
  const unrelated = parseConfig({ compactTemplate: false }, { CACHE_ENGINE_METRICS_FILE: "~/env/metrics.jsonl" })
  assert.equal(unrelated.compactTemplate, false)
  assert.equal(unrelated.metricsFile, join(homedir(), "env/metrics.jsonl"))
})

test("v0.4.7 K-A: malformed file + env still uses env (via loadConfig)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-"))
  const bad = join(dir, "cache-engine.json")
  writeFileSync(bad, "{ this is not json")
  const cfg = loadConfig({ configPath: bad, env: { CACHE_ENGINE_METRICS_FILE: "~/env/metrics.jsonl" } })
  assert.equal(cfg.metricsFile, join(homedir(), "env/metrics.jsonl"))
  assert.equal(cfg.enabled, true)
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

test("v0.4.7 P-B: package metadata is valid Node ESM and ships only runtime files", async () => {
  const { readFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"))

  // Valid module type; no "main" pointing at a TypeScript source file.
  assert.equal(pkg.type, "module")
  assert.equal(pkg.main, undefined)

  // Files whitelist ships the runtime entries and docs, but not dev material.
  assert.ok(Array.isArray(pkg.files), "files whitelist must exist")
  const files = pkg.files.join("\n")
  for (const required of ["src/", "README.md", "LICENSE"]) {
    assert.ok(files.includes(required), `files whitelist must include ${required}`)
  }
  for (const excluded of ["test", "docs", "AGENTS.md", ".opencode", "examples"]) {
    assert.ok(!files.includes(excluded), `files whitelist must exclude ${excluded}`)
  }

  // Exports point inside the whitelisted src/ directory.
  for (const entry of Object.values(pkg.exports)) {
    assert.ok(entry.startsWith("src/") || entry.startsWith("./src/"), `export ${entry} must be under src/`)
  }
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

test("MiMo V2.5 stays neutral; V2.6 Pro UltraSpeed now resolves (v0.4.5)", () => {
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2.5-pro")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.5")), POLICY_NEUTRAL)
  // v0.4.5: UltraSpeed is a documented V2.6 series member (baseline only).
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-pro-ultraspeed")), POLICY_MIMO26)
  // Undocumented V2.6 variants remain neutral (narrow detection preserved).
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-flashx")), POLICY_NEUTRAL)
})

test("unrelated MiMo/other models do NOT match MiMo policy", () => {
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openrouter", "xiaomi/mimo-v2-flash")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("mistral", "mistral-large-latest")), POLICY_NEUTRAL)
})

// --- v0.5.0 Moonshot/Kimi (passive) ---------------------------------------
// Moonshot context caching is automatic on the OpenAI-compatible Chat/Responses
// path, so the Kimi policy is passive and must not mutate the request. The
// Anthropic-compatible `cache_control` path is a different request shape and is
// deliberately not implemented here.
test("v0.5.0: current Moonshot/Kimi models match the Kimi policy", () => {
  // Bare and gateway-prefixed forms for every supported id.
  for (const id of ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
    assert.equal(detectPolicy(M("moonshot", id)), POLICY_KIMI, id)
    assert.equal(detectPolicy(M("moonshotai", "moonshotai/" + id)), POLICY_KIMI, "moonshotai/" + id)
  }
  // OpenRouter gateway shape + nested gateway path + batch suffix.
  assert.equal(detectPolicy(M("openrouter", "moonshotai/kimi-k3")), POLICY_KIMI)
  assert.equal(detectPolicy({ providerID: "openrouter", api: { id: "moonshotai/kimi-k3", npm: "@openrouter/ai-sdk-provider" } }), POLICY_KIMI)
  assert.equal(detectPolicy(M("acme", "accounts/team/models/kimi-k3")), POLICY_KIMI)
  assert.equal(detectPolicy(M("openrouter", "moonshotai/kimi-k3:batch")), POLICY_KIMI)
})

test("v0.5.0: retired/renamed Kimi models stay neutral", () => {
  assert.equal(detectPolicy(M("moonshot", "kimi-k2")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshot", "kimi-k2-0905")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshotai", "kimi-k2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshot", "kimi-k2-thinking")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshot", "moonshot-v1-128k")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshot", "kimi-thinking-preview")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("moonshot", "kimi-latest")), POLICY_NEUTRAL)
  // Kimi Code Plan aliases are not first-party cache-documented here.
  assert.equal(detectPolicy(M("kimi-code-plan-global", "kimi-for-coding")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("kimi-code-plan-global", "k3")), POLICY_NEUTRAL)
})

test("v0.5.0: similarly named non-Kimi models stay neutral", () => {
  assert.equal(detectPolicy(M("acme", "kimiko-9")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "kimi-clone")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "acme/kimi-9000")), POLICY_NEUTRAL)
  // Anchored: a prefixed/suffixed look-alike must not match the Kimi family.
  assert.equal(detectPolicy(M("acme", "mykimi-k3")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "acme/kimix-k3")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "acme/notkimi-k3")), POLICY_NEUTRAL)
  // A Kimi-looking but unsupported generation stays neutral.
  assert.equal(detectPolicy(M("acme", "kimi-k9")), POLICY_NEUTRAL)
})

test("v0.5.0: the Kimi policy is passive (no overlays, no mutation capabilities)", () => {
  const r = resolvePolicy(M("moonshot", "kimi-k3"))
  assert.equal(r.creator, "moonshot")
  assert.equal(r.family, "kimi")
  assert.equal(r.baseline.id, "moonshot.implicit-cache")
  assert.deepEqual(r.overlays, [])
  const caps = resolveRuntimePolicy(M("moonshot", "kimi-k3"))
  assert.equal(caps.policy, "kimi")
  assert.equal(caps.isNeutral, false)
  assert.equal(caps.gptCacheMetadata, false)
  assert.equal(caps.envRelocation, null)
  assert.equal(caps.thinkingIntegrity, false)
  assert.equal(caps.cacheRatio, null) // generic read/(read+write) applies
  assert.equal(caps.openRouterAffinity, false)
  // OpenRouter Kimi is still not an affinity family.
  assert.equal(resolveRuntimePolicy(M("openrouter", "moonshotai/kimi-k3")).openRouterAffinity, false)
  // Resolver and legacy classifier agree.
  assert.equal(caps.policy, detectPolicy(M("moonshot", "kimi-k3")))
})

// --- v0.5.2 Anthropic Claude (passive) ------------------------------------
// OpenCode already applies Anthropic `cache_control` breakpoints itself, so
// CacheEngine classifies and accounts for Claude but does not mutate the request.
test("v0.5.2: current Anthropic Claude models match the Claude policy", () => {
  const ids = [
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5",
    "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-5-20250929",
    "claude-fable-5-1", "claude-mythos-5-1",
  ]
  for (const id of ids) {
    assert.equal(detectPolicy(M("anthropic", id)), POLICY_CLAUDE, id)
    assert.equal(detectPolicy(M("openrouter", "anthropic/" + id)), POLICY_CLAUDE, "anthropic/" + id)
  }
  // legacy 3.x naming
  assert.equal(detectPolicy(M("anthropic", "claude-3-5-sonnet-20241022")), POLICY_CLAUDE)
  assert.equal(detectPolicy(M("anthropic", "claude-3-opus")), POLICY_CLAUDE)
  assert.equal(detectPolicy(M("anthropic", "claude-haiku-4-5-20251001")), POLICY_CLAUDE)
  // Bedrock / vendor-qualified ids (dot namespace) are an in-scope Claude route.
  assert.equal(detectPolicy(M("amazon-bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0")), POLICY_CLAUDE)
  assert.equal(detectPolicy(M("amazon-bedrock", "us.anthropic.claude-opus-4-5-20251101-v1:0")), POLICY_CLAUDE)
  assert.equal(detectPolicy(M("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0")), POLICY_CLAUDE)
})

test("v0.5.2: Claude look-alikes and non-Claude models stay neutral", () => {
  assert.equal(detectPolicy(M("acme", "claude-opus-clone")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "myclaude-opus-5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "claude-2")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "claude-instant-1")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("anthropic", "claude")), POLICY_NEUTRAL)
  // other providers unchanged
  assert.equal(detectPolicy(M("openai", "gpt-5.6")), POLICY_GPT56)
  assert.equal(detectPolicy(M("moonshot", "kimi-k3")), POLICY_KIMI)
})

test("v0.5.2: the Claude policy is passive (no overlays, no mutation capabilities)", () => {
  const r = resolvePolicy(M("anthropic", "claude-sonnet-4-5"))
  assert.equal(r.creator, "anthropic")
  assert.equal(r.family, "claude")
  assert.equal(r.baseline.id, "anthropic.ephemeral-cache")
  assert.deepEqual(r.overlays, [])
  const caps = resolveRuntimePolicy(M("anthropic", "claude-sonnet-4-5"))
  assert.equal(caps.policy, "claude")
  assert.equal(caps.isNeutral, false)
  assert.equal(caps.gptCacheMetadata, false)
  assert.equal(caps.envRelocation, null)
  assert.equal(caps.thinkingIntegrity, false)
  assert.equal(caps.cacheRatio, null) // generic read/(read+write)
  assert.equal(caps.openRouterAffinity, false)
  // Resolver and legacy classifier agree.
  assert.equal(caps.policy, detectPolicy(M("anthropic", "claude-sonnet-4-5")))
})

// --- v0.5.3 Google Gemini (passive) ---------------------------------------
// Gemini caches implicitly for 2.5+; there is no request-side cache-control
// field and OpenCode's applyCaching gate excludes Gemini, so CacheEngine
// classifies and accounts but does not mutate.
test("v0.5.3: current Google Gemini models match the Gemini policy", () => {
  const ids = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]
  for (const id of ids) {
    assert.equal(detectPolicy(M("google", id)), POLICY_GEMINI, id)
    assert.equal(detectPolicy(M("google-vertex", id)), POLICY_GEMINI, "google-vertex/" + id)
    assert.equal(detectPolicy(M("openrouter", "google/" + id)), POLICY_GEMINI, "google/" + id)
  }
  // versioned snapshots / region suffixes / moving aliases
  assert.equal(detectPolicy(M("google", "gemini-2.5-pro-002")), POLICY_GEMINI)
  assert.equal(detectPolicy(M("google", "gemini-2.5-flash@eu")), POLICY_GEMINI)
  assert.equal(detectPolicy(M("google", "gemini-flash-latest")), POLICY_GEMINI)
  assert.equal(detectPolicy(M("google", "gemini-flash-lite-latest")), POLICY_GEMINI)
})

test("v0.5.3: Gemma and non-Gemini look-alikes stay neutral", () => {
  // Gemma is a separate family.
  assert.equal(detectPolicy(M("google", "gemma-4-31b-it")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("google-vertex", "gemma-3-27b-it")), POLICY_NEUTRAL)
  // pre-2.5 generations and non-text variants
  assert.equal(detectPolicy(M("google", "gemini-2.0-flash")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("google", "gemini-1.5-pro")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("google", "gemini-embedding-2")), POLICY_NEUTRAL)
  // malformed / look-alikes
  assert.equal(detectPolicy(M("acme", "mygemini-2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "gemini-2.50")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "gemini-2.5.1")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "gemini-2.5foo")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("acme", "gemini")), POLICY_NEUTRAL)
  // `gemini-pro-latest` is not documented by Google nor in the OpenCode catalog
  assert.equal(detectPolicy(M("google", "gemini-pro-latest")), POLICY_NEUTRAL)
  // other providers unchanged
  assert.equal(detectPolicy(M("openai", "gpt-5.6")), POLICY_GPT56)
  assert.equal(detectPolicy(M("anthropic", "claude-sonnet-4-5")), POLICY_CLAUDE)
})

test("v0.5.3: the Gemini policy is passive (no overlays, no mutation capabilities)", () => {
  const r = resolvePolicy(M("google", "gemini-2.5-pro"))
  assert.equal(r.creator, "google")
  assert.equal(r.family, "gemini")
  assert.equal(r.baseline.id, "google.gemini-implicit")
  assert.deepEqual(r.overlays, [])
  const caps = resolveRuntimePolicy(M("google", "gemini-2.5-pro"))
  assert.equal(caps.policy, "gemini")
  assert.equal(caps.isNeutral, false)
  assert.equal(caps.gptCacheMetadata, false)
  assert.equal(caps.envRelocation, null)
  assert.equal(caps.thinkingIntegrity, false)
  assert.equal(caps.cacheRatio, null) // generic read/(read+write)
  assert.equal(caps.openRouterAffinity, false)
  assert.equal(caps.policy, detectPolicy(M("google", "gemini-2.5-pro")))
})

test("unrelated models match neutral policy", () => {
  assert.equal(detectPolicy(M("mistral", "mistral-large-latest")), POLICY_NEUTRAL)
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

test("config defaults enable all seven policies", () => {
  const cfg = parseConfig({}, {})
  assert.deepEqual(cfg.policies.claude, { enabled: true })
  assert.deepEqual(cfg.policies.gemini, { enabled: true })
  assert.deepEqual(cfg.policies.deepseek, { enabled: true })
  assert.deepEqual(cfg.policies.glm53, { enabled: true, stabilizeSystem: true, preserveThinkingIntegrity: true })
  assert.deepEqual(cfg.policies.mimo26, {
    enabled: true,
    stabilizeSystem: true,
    stickySession: true,
    preserveThinkingIntegrity: true,
  })
  assert.deepEqual(cfg.policies.kimi, { enabled: true })
  assert.deepEqual(cfg.policies.claude, { enabled: true })
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
// v0.4.10: <env> relocation correctness (content, determinism, ambiguity)
// ===========================================================================

test("v0.4.10: relocation is deterministic and idempotent for GLM and MiMo", () => {
  for (const sys of [GLM_SYSTEM, MIMO_SYSTEM]) {
    const once = relocateVolatileEnvBlock(sys)
    assert.equal(once.changed, true)
    // Deterministic across repeated calls on the same input.
    assert.equal(relocateVolatileEnvBlock(sys).text, once.text)
    // Idempotent: applying to the already-relocated text is a no-op.
    const twice = relocateVolatileEnvBlock(once.text)
    assert.equal(twice.changed, false)
    assert.equal(twice.text, once.text)
  }
})

test("v0.4.10: relocation preserves the env block bytes and all other text", () => {
  for (const sys of [GLM_SYSTEM, MIMO_SYSTEM]) {
    const r = relocateVolatileEnvBlock(sys)
    const start = sys.indexOf("You are powered by the model named ")
    const end = sys.indexOf("</env>") + "</env>".length
    const block = sys.slice(start, end)
    assert.ok(r.text.includes(block), "env block preserved byte-for-byte")
    // Removing the block from both texts leaves identical remaining content.
    const strip = (t) => t.replace(block, "").replace(/\n{2,}/g, "\n").trim()
    assert.equal(strip(r.text), strip(sys))
  }
})

test("v0.4.10: relocation leaves multiple/ambiguous/malformed markers unchanged", () => {
  const base = ["INSTR", "You are powered by the model named X", "<env>", "date", "</env>", "TAIL"].join("\n")
  // Control: the unambiguous case relocates.
  assert.equal(relocateVolatileEnvBlock(base).changed, true)

  const cases = {
    "two START markers": base + "\nYou are powered by the model named Y",
    "two <env> opens": base.replace("<env>", "<env>\n<env>"),
    "two </env> closes": base + "\n</env>",
    "missing <env>": base.replace("<env>\n", ""),
    "missing </env>": base.replace("\n</env>", ""),
    "missing START": base.replace("You are powered by the model named X\n", ""),
    "markers out of order": ["You are powered by the model named X", "</env>", "<env>", "date"].join("\n"),
  }
  for (const [name, input] of Object.entries(cases)) {
    const r = relocateVolatileEnvBlock(input)
    assert.equal(r.changed, false, `${name} must be left unchanged`)
    assert.equal(r.text, input, `${name} text must be byte-identical`)
  }
})

test("v0.4.10: relocation never touches non-string or env-less system text", () => {
  for (const bad of [null, undefined, 7, "plain system prompt with no env block"]) {
    const r = relocateVolatileEnvBlock(bad)
    assert.equal(r.changed, false)
    assert.equal(r.text, bad)
  }
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

// ===========================================================================
// v0.4.0 policy registry + resolvePolicy() (research-backed, pure, unwired)
//
// The inventory (docs/cache-policy-inventory.md) is the authority. These tests
// assert the structured resolution layer and that detectPolicy() remains
// byte-compatible with its pre-v0.4.0 behavior.
// ===========================================================================

const overlayIds = (r) => r.overlays.map((o) => o.id)
const baseId = (r) => (r.baseline ? r.baseline.id : null)

test("resolvePolicy: GPT-5.6 exact + inventory aliases resolve to the gpt-5.6 family", () => {
  const exact = resolvePolicy(M("openai", "gpt-5.6-sol"))
  assert.equal(exact.creator, "openai")
  assert.equal(exact.family, "gpt-5.6")
  assert.equal(exact.matchType, "exact")
  assert.equal(baseId(exact), "openai.gpt56.cache")
  assert.deepEqual(overlayIds(exact), ["gpt56.prompt-cache-options"])
  assert.equal(exact.transport.kind, "direct")

  // Inventory alias: gpt-5.6 -> gpt-5.6-sol
  const alias = resolvePolicy(M("openai", "gpt-5.6"))
  assert.equal(alias.family, "gpt-5.6")
  assert.equal(alias.matchType, "exact")
  assert.ok(alias.matchReason.startsWith("alias:gpt-5.6"))
  assert.deepEqual(overlayIds(alias), ["gpt56.prompt-cache-options"])

  // OpenRouter-prefixed documented variant resolves by exact id (prefix stripped)
  const orVariant = resolvePolicy(M("openrouter", "openai/gpt-5.6-luna"))
  assert.equal(orVariant.family, "gpt-5.6")
  assert.equal(orVariant.matchType, "exact")
})

test("v0.4.2: GPT-6 resolves through the documented GPT-5.6-and-later boundary", () => {
  const r = resolvePolicy(M("openrouter", "openai/gpt-6-luna"))
  assert.equal(r.creator, "openai")
  assert.equal(r.family, "gpt-5.6")
  assert.equal(baseId(r), "openai.gpt56.cache")
  // GPT-6 is documented in the same cache regime, so it gets the same overlay.
  assert.deepEqual(overlayIds(r), ["gpt56.prompt-cache-options"])
  assert.equal(resolvePolicy(M("openai", "gpt-6-astra")).family, "gpt-5.6")

  // The boundary is version-based, not an exact-model list.
  const entry = POLICY_REGISTRY.find((e) => e.id === "openai.gpt-5.6-plus")
  assert.equal(entry.boundary, "GPT-5.6 and later")
  assert.equal(typeof entry.predicate, "function")
  assert.ok(entry.inventoryRef)
})

test("v0.4.2: the legacy detectPolicy wrapper follows the same boundary", () => {
  assert.equal(detectPolicy(M("openai", "gpt-6-astra")), POLICY_GPT56)
  assert.equal(detectPolicy(M("openai", "gpt-5.6")), POLICY_GPT56)
  assert.equal(detectPolicy(M("openai", "gpt-5.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("openai", "gpt-5.60")), POLICY_NEUTRAL)
})

test("resolvePolicy: pre-5.6 GPT negative controls are neutral with no overlays", () => {
  for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]) {
    const r = resolvePolicy(M("openai", id))
    assert.equal(r.family, "neutral", `${id} must be neutral`)
    assert.deepEqual(overlayIds(r), [])
    assert.equal(r.matchType, "neutral")
  }
})

test("resolvePolicy: DeepSeek V4 / V4.1 resolve to the passive baseline (no overlay)", () => {
  const v4 = resolvePolicy(M("deepseek", "deepseek-v4-pro"))
  assert.equal(v4.creator, "deepseek")
  assert.equal(v4.family, "deepseek")
  // v0.4.3: deepseek-v4-pro is a documented canonical id, so it matches exactly.
  assert.equal(v4.matchType, "exact")
  assert.equal(baseId(v4), "deepseek.kv-cache")
  assert.deepEqual(overlayIds(v4), [])

  assert.equal(resolvePolicy(M("deepseek", "deepseek-flash")).family, "deepseek")

  // Inventory alias: retired deepseek-v4-flash -> deepseek-flash
  const legacy = resolvePolicy(M("deepseek", "deepseek-v4-flash"))
  assert.equal(legacy.family, "deepseek")
  assert.ok(legacy.matchReason.startsWith("alias:deepseek-v4-flash"))

  // pre-V4 negative control still resolves to the creator baseline
  assert.equal(resolvePolicy(M("deepseek", "deepseek-chat")).family, "deepseek")
})

test("resolvePolicy: GLM-5.3 + documented 5.3 variants carry the overlay; 5.2 and earlier do not", () => {
  const r = resolvePolicy(M("zai", "glm-5.3"))
  assert.equal(r.creator, "z.ai")
  assert.equal(r.family, "glm-5.3")
  assert.equal(baseId(r), "zai.implicit-cache")
  assert.deepEqual(overlayIds(r), ["glm53.env-relocation"])

  assert.equal(resolvePolicy(M("zai", "glm-5.3-flash")).family, "glm-5.3")
  assert.equal(resolvePolicy(M("z-ai", "glm-5.3-flashx")).family, "glm-5.3")

  for (const id of ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5"]) {
    const g = resolvePolicy(M("zai", id))
    assert.equal(g.family, "neutral", `${id} must be neutral`)
    assert.deepEqual(overlayIds(g), [])
  }
})

test("resolvePolicy: MiMo V2.6 Flash/Pro carry the overlay; Pro UltraSpeed is an explicit no-overlay series member", () => {
  const flash = resolvePolicy(M("xiaomi", "mimo-v2.6-flash"))
  assert.equal(flash.creator, "xiaomi")
  assert.equal(flash.family, "mimo-v2.6")
  assert.equal(baseId(flash), "xiaomi.implicit-cache")
  assert.deepEqual(overlayIds(flash), ["mimo26.env-relocation"])

  const pro = resolvePolicy(M("xiaomi", "mimo-v2.6-pro"))
  assert.equal(pro.family, "mimo-v2.6")
  assert.deepEqual(overlayIds(pro), ["mimo26.env-relocation"])

  // Documented as the same V2.6 series but with NO registered overlay.
  const ultraspeed = resolvePolicy(M("xiaomi", "mimo-v2.6-pro-ultraspeed"))
  assert.equal(ultraspeed.family, "mimo-v2.6")
  assert.equal(ultraspeed.matchType, "exact")
  assert.deepEqual(overlayIds(ultraspeed), [])
  const uEntry = POLICY_REGISTRY.find((e) => e.id === "xiaomi.mimo-v2.6-pro-ultraspeed")
  assert.equal(uEntry.policyStatus, "documented-series-member-baseline-only")

  const v25 = resolvePolicy(M("xiaomi", "mimo-v2.5"))
  assert.equal(v25.family, "neutral")
  assert.deepEqual(overlayIds(v25), [])
})

test("resolvePolicy: overlays are never implied by creator/family classification", () => {
  // Being GLM/MiMo/DeepSeek does not by itself grant a transformation overlay.
  assert.deepEqual(overlayIds(resolvePolicy(M("zai", "glm-4.6"))), [])
  assert.deepEqual(overlayIds(resolvePolicy(M("xiaomi", "mimo-v2.5"))), [])
  assert.deepEqual(overlayIds(resolvePolicy(M("deepseek", "deepseek-v4-pro"))), [])
  // A hypothetical future GLM does not silently inherit the 5.3 overlay.
  assert.deepEqual(overlayIds(resolvePolicy(M("zai", "glm-5.4"))), [])
})

test("resolvePolicy: malformed and unknown model ids resolve safely", () => {
  for (const bad of [undefined, null, {}, 42, "gpt-5.6", [], true]) {
    const r = resolvePolicy(bad)
    assert.equal(r.family, "neutral")
    assert.equal(r.matchType, "neutral")
    assert.equal(baseId(r), "neutral.none")
    assert.deepEqual(r.overlays, [])
  }
  // A provider with no model identity gets no family.
  assert.equal(resolvePolicy({ providerID: "openai" }).family, "neutral")
})

test("resolvePolicy: unknown providers/creators do not gain policy from transport identity", () => {
  const orUnknown = resolvePolicy(M("openrouter", "acme/mystery-model-9"))
  assert.equal(orUnknown.family, "neutral")
  assert.deepEqual(orUnknown.overlays, [])
  assert.equal(orUnknown.transport.kind, "openrouter")
  assert.equal(orUnknown.transport.sessionAffinityHeader, "x-session-id")

  // gpt-5.6 on a non-OpenAI gateway stays neutral even though the id looks OpenAI
  assert.equal(resolvePolicy(M("some-gateway", "gpt-5.6")).family, "neutral")
  assert.equal(resolvePolicy(M("xiaomi", "not-a-mimo")).family, "neutral")
})

test("resolvePolicy: transport is computed independently from cache policy", () => {
  const ds = resolvePolicy(M("deepseek", "deepseek-v4-pro"))
  assert.equal(ds.transport.kind, "direct")
  assert.equal(ds.transport.sessionAffinityHeader, null)

  const or = resolvePolicy(M("openrouter", "openai/gpt-5.6-luna"))
  assert.equal(or.family, "gpt-5.6")
  assert.equal(or.transport.kind, "openrouter")
  assert.equal(or.transport.sessionAffinityHeader, "x-session-id")

  const zai = resolvePolicy(M("zai", "glm-5.3"))
  assert.equal(zai.transport.kind, "direct")
  assert.equal(zai.transport.sessionAffinityHeader, null)

  const noProvider = resolvePolicy({ modelID: "gpt-6-astra" })
  assert.equal(noProvider.transport.kind, "unknown")
})

test("resolvePolicy is pure and does not mutate its input", () => {
  const model = Object.freeze({ providerID: "openai", modelID: "gpt-5.6-sol" })
  const r = resolvePolicy(model)
  assert.equal(r.family, "gpt-5.6")
  assert.equal(model.modelID, "gpt-5.6-sol")
})

test("detectPolicy remains compatible with the legacy family resolution", () => {
  const legacyMap = {
    "gpt-5.6": POLICY_GPT56,
    "glm-5.3": POLICY_GLM53,
    "mimo-v2.6": POLICY_MIMO26,
    deepseek: POLICY_DEEPSEEK,
    kimi: POLICY_KIMI,
    claude: POLICY_CLAUDE,
    gemini: POLICY_GEMINI,
  }
  const samples = [
    M("openrouter", "openai/gpt-5.6-luna"),
    M("openai", "gpt-5.6"),
    M("openai-compatible", "gpt-5.6"),
    M("openai", "gpt-5.5"),
    M("zai", "glm-5.3-flash"),
    M("zai", "glm-4.6"),
    M("xiaomi", "mimo-v2.6-flash"),
    M("xiaomi", "mimo-v2.6-pro-ultraspeed"),
    M("xiaomi", "mimo-v2.5"),
    M("deepseek", "deepseek-chat"),
    M("moonshot", "kimi-k3"),
    M("openrouter", "x-ai/grok-4"),
    M("anthropic", "claude-sonnet-4-5"),
    M("google", "gemini-2.5-pro"),
    {},
    null,
    undefined,
    42,
  ]
  for (const m of samples) {
    const expected = legacyMap[resolveLegacyFamily(m)] ?? POLICY_NEUTRAL
    assert.equal(detectPolicy(m), expected)
  }
})

test("registry is traceable and internally consistent", () => {
  for (const entry of POLICY_REGISTRY) {
    assert.ok(entry.inventoryRef, `${entry.id} must cite the inventory`)
    assert.ok(BASELINES[entry.baseline], `${entry.id} baseline must exist`)
    for (const overlayId of entry.overlays) {
      assert.ok(OVERLAYS[overlayId], `${entry.id} overlay ${overlayId} must exist`)
    }
  }
  for (const [id, alias] of Object.entries(MODEL_ALIASES)) {
    assert.ok(alias.inventoryRef, `alias ${id} must cite the inventory`)
    assert.ok(alias.family)
  }
})

// ===========================================================================
// v0.4.1 runtime policy migration (behavior preservation)
//
// The runtime now classifies via resolveRuntimePolicy(). These tests prove the
// resolved policy equals the legacy detectPolicy() string for every supported
// model, and that the hook-observable behavior (GPT cache options, <env>
// relocation, OpenRouter affinity) is unchanged. Newer/unknown models must
// gain no mutation.
// ===========================================================================

const policyCoreURL = new URL("../src/cache-policy-core.mjs", import.meta.url).href

test("v0.4.1: resolveRuntimePolicy.policy matches detectPolicy across a broad matrix", () => {
  const samples = [
    M("openai", "gpt-5.6"),
    M("openai", "gpt-5.6-sol"),
    M("openrouter", "openai/gpt-5.6-luna"),
    M("openai-compatible", "gpt-5.6"),
    M("openai", "gpt-6-astra"),
    M("openai", "gpt-5.5"),
    M("openai", "gpt-daybreak-blue-latest"),
    M("openai", "gpt-daybreak-red-latest"),
    M("zai", "glm-5.3"),
    M("zai", "glm-5.3-flash"),
    M("zai", "glm-5.2"),
    M("xiaomi", "mimo-v2.6-flash"),
    M("xiaomi", "mimo-v2.6-pro"),
    M("xiaomi", "mimo-v2.6-pro-ultraspeed"),
    M("xiaomi", "mimo-v2.5"),
    M("deepseek", "deepseek-v4-pro"),
    M("deepseek", "deepseek-flash"),
    M("deepseek", "deepseek-v4-flash"),
    M("deepseek", "deepseek-chat"),
    M("openrouter", "x-ai/grok-4"),
    {},
    null,
    undefined,
    42,
  ]
  for (const m of samples) {
    assert.equal(resolveRuntimePolicy(m).policy, detectPolicy(m))
  }
})

test("v0.4.1: GPT-5.6 alias keeps the overlay but a newer alias stays runtime-neutral", () => {
  // Legacy alias: gpt-5.6 -> gpt-5.6-sol (was matched by the old regex).
  const legacy = resolveRuntimePolicy(M("openai", "gpt-5.6"))
  assert.equal(legacy.policy, "gpt56")
  assert.equal(legacy.gptCacheMetadata, true)
  // Newer documented alias that the old classifier did NOT match: no mutation.
  const newer = resolveRuntimePolicy(M("openai", "gpt-daybreak-blue-latest"))
  assert.equal(newer.policy, "neutral")
  assert.equal(newer.gptCacheMetadata, false)
  assert.equal(resolvePolicy(M("openai", "gpt-daybreak-blue-latest")).family, "gpt-5.6")
})

async function runPolicyMigrationProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-policy-migration-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const coreURL = new URL("../src/cache-engine-core.mjs", import.meta.url).href
  const script = `
    import assert from "node:assert/strict"
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/policy-migration.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const { detectPolicy } = await import(${JSON.stringify(coreURL)})
    const { resolvePolicy, resolveRuntimePolicy } = await import(${JSON.stringify(policyCoreURL)})
    const client = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }) },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client, directory: process.env.HOME })
    assert.equal(typeof hooks["chat.params"], "function")
    assert.equal(typeof hooks["chat.headers"], "function")
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
    const SYS = ["A: keep1", "B: You are powered by the model named x. The exact model ID is acme/x", "C: <env>", "D: Today's date: 2026-08-17", "E: </env>", "F: keep2"].join("\\n")
    const CASES = [
      { name: "gpt-5.6", model: { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" } }, expect: { policy: "gpt56", env: false, gpt: true, header: false } },
      { name: "gpt-5.6-openrouter", model: { providerID: "openrouter", id: "openai/gpt-5.6-sol", api: { id: "openai/gpt-5.6-sol" } }, expect: { policy: "gpt56", env: false, gpt: true, header: false } },
      { name: "gpt-6-astra", model: { providerID: "openai", id: "gpt-6-astra", api: { id: "gpt-6-astra", npm: "@ai-sdk/openai" } }, expect: { policy: "gpt56", env: false, gpt: true, header: false } },
      { name: "gpt-6-openrouter", model: { providerID: "openrouter", id: "openai/gpt-6-luna", api: { id: "openai/gpt-6-luna" } }, expect: { policy: "gpt56", env: false, gpt: true, header: false } },
      { name: "gpt-6-openai-compatible", model: { providerID: "openai-compatible", id: "gpt-6-astra", api: { id: "gpt-6-astra" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "gpt-5.60-malformed", model: { providerID: "openai", id: "gpt-5.60", api: { id: "gpt-5.60", npm: "@ai-sdk/openai" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "gpt-5.5", model: { providerID: "openai", id: "gpt-5.5", api: { id: "gpt-5.5", npm: "@ai-sdk/openai" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "gpt-daybreak-alias", model: { providerID: "openai", id: "gpt-daybreak-blue-latest", api: { id: "gpt-daybreak-blue-latest", npm: "@ai-sdk/openai" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "deepseek-v4-pro", model: { providerID: "deepseek", id: "deepseek-v4-pro", api: { id: "deepseek-v4-pro" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-flash", model: { providerID: "deepseek", id: "deepseek-flash", api: { id: "deepseek-flash" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-v5-future", model: { providerID: "deepseek", id: "deepseek-v5", api: { id: "deepseek-v5" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-v3-pre", model: { providerID: "deepseek", id: "deepseek-v3", api: { id: "deepseek-v3" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-openrouter", model: { providerID: "openrouter", id: "deepseek/deepseek-v4-pro", api: { id: "deepseek/deepseek-v4-pro" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-gateway", model: { providerID: "acme-gateway", id: "my-deepseek-mirror", api: { id: "my-deepseek-mirror" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "glm-5.3-direct", model: { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3" } }, expect: { policy: "glm53", env: true, gpt: false, header: false } },
      { name: "glm-5.3-openrouter", model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash", api: { id: "z-ai/glm-5.3-flash" } }, expect: { policy: "glm53", env: true, gpt: false, header: true } },
      { name: "glm-5.4-direct", model: { providerID: "zai", id: "glm-5.4", api: { id: "glm-5.4" } }, expect: { policy: "glm53", env: false, gpt: false, header: false } },
      { name: "glm-5.4-openrouter", model: { providerID: "openrouter", id: "z-ai/glm-5.4", api: { id: "z-ai/glm-5.4" } }, expect: { policy: "glm53", env: false, gpt: false, header: true } },
      { name: "glm-5.2", model: { providerID: "zai", id: "glm-5.2", api: { id: "glm-5.2" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "mimo-v2.6-flash-direct", model: { providerID: "xiaomi", id: "mimo-v2.6-flash", api: { id: "mimo-v2.6-flash" } }, expect: { policy: "mimo26", env: true, gpt: false, header: false } },
      { name: "mimo-v2.6-pro-openrouter", model: { providerID: "openrouter", id: "xiaomi/mimo-v2.6-pro", api: { id: "xiaomi/mimo-v2.6-pro" } }, expect: { policy: "mimo26", env: true, gpt: false, header: true } },
      { name: "mimo-v2.6-pro-ultraspeed", model: { providerID: "xiaomi", id: "mimo-v2.6-pro-ultraspeed", api: { id: "mimo-v2.6-pro-ultraspeed" } }, expect: { policy: "mimo26", env: false, gpt: false, header: false } },
      { name: "mimo-v2.7-future", model: { providerID: "xiaomi", id: "mimo-v2.7-flash", api: { id: "mimo-v2.7-flash" } }, expect: { policy: "mimo26", env: false, gpt: false, header: false } },
      { name: "mimo-v2.7-openrouter", model: { providerID: "openrouter", id: "xiaomi/mimo-v2.7-flash", api: { id: "xiaomi/mimo-v2.7-flash" } }, expect: { policy: "mimo26", env: false, gpt: false, header: true } },
      { name: "mimo-v2.6-pro-ultraspeed-openrouter", model: { providerID: "openrouter", id: "xiaomi/mimo-v2.6-pro-ultraspeed", api: { id: "xiaomi/mimo-v2.6-pro-ultraspeed" } }, expect: { policy: "mimo26", env: false, gpt: false, header: true } },
      { name: "mimo-v2.5", model: { providerID: "xiaomi", id: "mimo-v2.5", api: { id: "mimo-v2.5" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "unknown-provider", model: { providerID: "mystery-provider", id: "xiaomi/mimo-v2.6-flash", api: { id: "xiaomi/mimo-v2.6-flash" } }, expect: { policy: "mimo26", env: true, gpt: false, header: false } },
      { name: "unknown-openrouter", model: { providerID: "openrouter", id: "acme/mystery-9", api: { id: "acme/mystery-9" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "gpt-7-future-openai", model: { providerID: "openai", id: "gpt-7-codex", api: { id: "gpt-7-codex", npm: "@ai-sdk/openai" } }, expect: { policy: "gpt56", env: false, gpt: true, header: false } },
      { name: "gpt-7-future-nonopenai-gateway", model: { providerID: "acme-gateway", id: "gpt-7-codex", api: { id: "gpt-7-codex" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "deepseek-v9-future", model: { providerID: "deepseek", id: "deepseek-v9", api: { id: "deepseek-v9" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "deepseek-v9-future-openrouter", model: { providerID: "openrouter", id: "deepseek/deepseek-v9", api: { id: "deepseek/deepseek-v9" } }, expect: { policy: "deepseek", env: false, gpt: false, header: false } },
      { name: "glm-6-future", model: { providerID: "zai", id: "glm-6", api: { id: "glm-6" } }, expect: { policy: "glm53", env: false, gpt: false, header: false } },
      { name: "glm-6-future-openrouter", model: { providerID: "openrouter", id: "z-ai/glm-6", api: { id: "z-ai/glm-6" } }, expect: { policy: "glm53", env: false, gpt: false, header: true } },
      { name: "mimo-v3-future", model: { providerID: "xiaomi", id: "mimo-v3-flash", api: { id: "mimo-v3-flash" } }, expect: { policy: "mimo26", env: false, gpt: false, header: false } },
      { name: "mimo-v3-future-openrouter", model: { providerID: "openrouter", id: "xiaomi/mimo-v3-flash", api: { id: "xiaomi/mimo-v3-flash" } }, expect: { policy: "mimo26", env: false, gpt: false, header: true } },
      { name: "unknown-vendor-model", model: { providerID: "acme", id: "acme/nova-9", api: { id: "acme/nova-9" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "missing-provider-identity", model: { id: "acme/nova-9", api: { id: "acme/nova-9" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "kimi-k3-direct", model: { providerID: "moonshot", id: "kimi-k3", api: { id: "kimi-k3" } }, expect: { policy: "kimi", env: false, gpt: false, header: false } },
      { name: "kimi-k3-openrouter", model: { providerID: "openrouter", id: "moonshotai/kimi-k3", api: { id: "moonshotai/kimi-k3" } }, expect: { policy: "kimi", env: false, gpt: false, header: false } },
      { name: "kimi-k2.6", model: { providerID: "moonshotai", id: "kimi-k2.6", api: { id: "kimi-k2.6" } }, expect: { policy: "kimi", env: false, gpt: false, header: false } },
      { name: "kimi-k2.7-code-highspeed", model: { providerID: "moonshotai-cn", id: "kimi-k2.7-code-highspeed", api: { id: "kimi-k2.7-code-highspeed" } }, expect: { policy: "kimi", env: false, gpt: false, header: false } },
      { name: "kimi-deprecated-k2", model: { providerID: "moonshot", id: "kimi-k2", api: { id: "kimi-k2" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "kimi-for-coding", model: { providerID: "kimi-code-plan-global", id: "kimi-for-coding", api: { id: "kimi-for-coding" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "claude-sonnet-direct", model: { providerID: "anthropic", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" } }, expect: { policy: "claude", env: false, gpt: false, header: false } },
      { name: "claude-opus-openrouter", model: { providerID: "openrouter", id: "anthropic/claude-opus-4-8", api: { id: "anthropic/claude-opus-4-8" } }, expect: { policy: "claude", env: false, gpt: false, header: false } },
      { name: "claude-lookalike", model: { providerID: "acme", id: "acme/claude-opus-clone", api: { id: "acme/claude-opus-clone" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
      { name: "gemini-2.5-pro", model: { providerID: "google", id: "gemini-2.5-pro", api: { id: "gemini-2.5-pro", npm: "@ai-sdk/google" } }, expect: { policy: "gemini", env: false, gpt: false, header: false } },
      { name: "gemini-vertex", model: { providerID: "google-vertex", id: "gemini-2.5-flash", api: { id: "gemini-2.5-flash", npm: "@ai-sdk/google-vertex" } }, expect: { policy: "gemini", env: false, gpt: false, header: false } },
      { name: "gemini-openrouter", model: { providerID: "openrouter", id: "google/gemini-2.5-pro", api: { id: "google/gemini-2.5-pro", npm: "@openrouter/ai-sdk-provider" } }, expect: { policy: "gemini", env: false, gpt: false, header: false } },
      { name: "gemma-negative", model: { providerID: "google", id: "gemma-4-31b-it", api: { id: "gemma-4-31b-it", npm: "@ai-sdk/google" } }, expect: { policy: "neutral", env: false, gpt: false, header: false } },
    ]
    const results = []
    for (const c of CASES) {
      const model = c.model
      const sid = "ses_" + c.name
      const provider = { source: "config", info: { id: String(model.providerID ?? "") }, options: {} }
      const existing = { "User-Agent": "preserve", "x-custom": "preserve" }
      const paramsOut = { options: {} }
      const headersOut = { headers: { ...existing } }
      const sysOut = { system: [SYS] }
      await hooks["chat.params"]({ sessionID: sid, agent: "build", model, provider, message: { id: "msg-" + c.name, sessionID: sid, role: "user", content: "probe" } }, paramsOut)
      await hooks["experimental.chat.system.transform"]({ sessionID: sid, model, provider }, sysOut)
      await hooks["chat.headers"]({ sessionID: sid, agent: "build", model, provider, message: { id: "msg-" + c.name, sessionID: sid, role: "user", content: "probe" } }, headersOut)
      const rt = resolveRuntimePolicy(model)
      const existingHeadersPreserved = Object.entries(existing).every(([k, v]) => headersOut.headers[k] === v)
      results.push({
        name: c.name,
        runtimePolicy: rt.policy,
        detectPolicy: detectPolicy(model),
        richFamily: resolvePolicy(model).family,
        overlays: resolvePolicy(model).overlays.map((o) => o.id),
        systemRelocated: sysOut.system[0] !== SYS,
        gptOptionInjected: paramsOut.options.promptCacheKey !== undefined || paramsOut.options.prompt_cache_key !== undefined,
        gptOptions: paramsOut.options.promptCacheOptions ?? paramsOut.options.prompt_cache_options ?? null,
        gptKeyCamel: paramsOut.options.promptCacheKey ?? null,
        gptKeySnake: paramsOut.options.prompt_cache_key ?? null,
        gptOptionsCamel: paramsOut.options.promptCacheOptions ?? null,
        gptOptionsSnake: paramsOut.options.prompt_cache_options ?? null,
        affinityHeaderAttached: headersOut.headers["x-session-id"] !== undefined,
        existingHeadersPreserved,
        expect: c.expect,
      })
    }
    // Repeat the first case in its own session: the resolution record must not
    // be re-emitted for an unchanged resolution (observability, not per-request
    // noise).
    const repeat = CASES[0]
    const repeatSid = "ses_" + repeat.name
    const repeatProvider = { source: "config", info: { id: String(repeat.model.providerID ?? "") }, options: {} }
    await hooks["chat.params"]({ sessionID: repeatSid, agent: "build", model: repeat.model, provider: repeatProvider, message: { id: "msg-repeat", sessionID: repeatSid, role: "user", content: "probe" } }, { options: {} })
    await hooks["chat.params"]({ sessionID: repeatSid, agent: "build", model: repeat.model, provider: repeatProvider, message: { id: "msg-repeat-2", sessionID: repeatSid, role: "user", content: "probe" } }, { options: {} })

    // A session that alternates between two models (the main model plus a small
    // title/summary model) must record each distinct resolution once, not once
    // per request.
    const alternationSid = "ses_alternating"
    const altA = { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" } }
    const altB = { providerID: "openai", id: "gpt-4.1-mini", api: { id: "gpt-4.1-mini", npm: "@ai-sdk/openai" } }
    for (let i = 0; i < 5; i++) {
      const m = i % 2 === 0 ? altA : altB
      const p = { source: "config", info: { id: m.providerID }, options: {} }
      await hooks["chat.params"]({ sessionID: alternationSid, agent: "build", model: m, provider: p, message: { id: "msg-alt-" + i, sessionID: alternationSid, role: "user", content: "probe" } }, { options: {} })
    }

    const lines = readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n")
    const records = lines.map((l) => JSON.parse(l))
    const resolutions = records.filter((r) => r.kind === "policy-resolution")
    const repeatEmission = resolutions.filter((r) => r.sid === repeatSid).length
    const alternationEmission = resolutions.filter((r) => r.sid === alternationSid).length
    process.stdout.write(JSON.stringify({ results, resolutions, repeatEmission, alternationEmission, allKinds: [...new Set(records.map((r) => r.kind))].sort() }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let policyMigrationProbe
const policyMigrationResults = async () => (policyMigrationProbe ??= runPolicyMigrationProbe())

test("v0.4.1: runtime policy is the resolver's and stays equal to detectPolicy (hook path)", async () => {
  const { results } = await policyMigrationResults()
  assert.ok(results.length >= 15)
  for (const r of results) {
    assert.equal(r.runtimePolicy, r.detectPolicy, `${r.name}: resolver policy must equal legacy detectPolicy`)
    assert.equal(r.runtimePolicy, r.expect.policy, `${r.name}: unexpected policy`)
  }
})

test("v0.4.1: every supported model keeps its pre-migration hook behavior", async () => {
  const { results } = await policyMigrationResults()
  for (const r of results) {
    assert.equal(r.systemRelocated, r.expect.env, `${r.name}: <env> relocation`)
    assert.equal(r.gptOptionInjected, r.expect.gpt, `${r.name}: GPT cache-options injection`)
    assert.equal(r.affinityHeaderAttached, r.expect.header, `${r.name}: OpenRouter affinity header`)
    // No provider in the matrix mutates or drops pre-existing headers.
    assert.equal(r.existingHeadersPreserved, true, `${r.name}: existing headers preserved`)
  }
})

test("v0.4.1: GPT-5.6 keeps promptCacheOptions implicit/30m through the resolver", async () => {
  const { results } = await policyMigrationResults()
  const gpt = results.find((r) => r.name === "gpt-5.6")
  assert.deepEqual(gpt.gptOptions, { mode: "implicit", ttl: "30m" })
})

test("v0.4.1: future-looking and unknown models gain no mutation", async () => {
  const { results } = await policyMigrationResults()
  const noMutation = [
    "gpt-daybreak-alias",
    "gpt-5.5",
    "gpt-6-openai-compatible",
    "gpt-5.60-malformed",
    "glm-5.2",
    "mimo-v2.6-pro-ultraspeed",
    "mimo-v2.5",
    "unknown-openrouter",
  ]
  for (const name of noMutation) {
    const r = results.find((x) => x.name === name)
    assert.ok(r, `${name} present`)
    assert.equal(r.gptOptionInjected, false, `${name}: no GPT options`)
    assert.equal(r.systemRelocated, false, `${name}: no <env> relocation`)
    assert.equal(r.affinityHeaderAttached, false, `${name}: no affinity header`)
  }
})

test("v0.4.1: non-OpenRouter models never receive the OpenRouter header", async () => {
  const { results } = await policyMigrationResults()
  for (const name of ["glm-5.3-direct", "mimo-v2.6-flash-direct", "unknown-provider", "gpt-5.6", "deepseek-v4-pro"]) {
    const r = results.find((x) => x.name === name)
    assert.equal(r.affinityHeaderAttached, false, `${name}: no affinity header off OpenRouter`)
  }
})

// ===========================================================================
// v0.4.2 GPT-5.6-and-later boundary
//
// Source: OpenAI *Prompt caching* guide, "GPT-5.6 and later" generation
// boundary, re-verified 2026-09-27 (docs/cache-policy-inventory.md §1). GPT-6
// is documented in the same regime with no cache-control exception.
// ===========================================================================

test("v0.4.2: isGpt56OrLater matches the documented boundary by version", () => {
  const inFamily = [
    "gpt-5.6",
    "gpt-5.6-luna",
    "openai/gpt-5.6-sol",
    "gpt-6",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.7",
    "gpt-7",
    "gpt-6.1",
  ]
  for (const id of inFamily) assert.equal(isGpt56OrLater(id), true, `${id} is in family`)
  const outOfFamily = [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
    "gpt-5.60",
    "gpt-5.6.1",
    "gpt-4",
    "claude-sonnet-4-5",
  ]
  for (const id of outOfFamily) assert.equal(isGpt56OrLater(id), false, `${id} is out of family`)
})

test("v0.4.2: GPT boundary respects OpenAI/provider gating", () => {
  assert.equal(resolveRuntimePolicy(M("openai", "gpt-5.6")).gptCacheMetadata, true)
  assert.equal(resolveRuntimePolicy(M("openai", "gpt-6-astra")).gptCacheMetadata, true)
  assert.equal(resolveRuntimePolicy(M("azure", "gpt-6-sol")).gptCacheMetadata, true)
  assert.equal(resolveRuntimePolicy(M("openrouter", "openai/gpt-6-luna")).gptCacheMetadata, true)
  assert.equal(resolveRuntimePolicy(M("openai-compatible", "gpt-6-astra")).gptCacheMetadata, false)
  assert.equal(resolveRuntimePolicy(M("llama.cpp", "gpt-5.6")).gptCacheMetadata, false)
  assert.equal(resolveRuntimePolicy(M("openai", "gpt-5.5")).gptCacheMetadata, false)
  assert.equal(resolveRuntimePolicy(M("openai", "gpt-5.60")).gptCacheMetadata, false)
})

test("v0.4.2: covered later GPT requests receive the same documented baseline at runtime", async () => {
  const { results } = await policyMigrationResults()
  const gpt6 = results.find((r) => r.name === "gpt-6-astra")
  assert.equal(gpt6.runtimePolicy, "gpt56")
  assert.equal(gpt6.gptOptionInjected, true)
  assert.deepEqual(gpt6.gptOptions, { mode: "implicit", ttl: "30m" })
  // Same baseline as GPT-5.6, no new mechanism.
  const gpt56 = results.find((r) => r.name === "gpt-5.6")
  assert.deepEqual(gpt6.gptOptions, gpt56.gptOptions)
  // No prompt transformation or affinity was introduced for gpt-6.
  assert.equal(gpt6.systemRelocated, false)
  assert.equal(gpt6.affinityHeaderAttached, false)
})

test("v0.4.2: pre-5.6 and out-of-family GPT ids get no GPT options", async () => {
  const { results } = await policyMigrationResults()
  for (const name of ["gpt-5.5", "gpt-5.60-malformed", "gpt-6-openai-compatible"]) {
    const r = results.find((x) => x.name === name)
    assert.equal(r.gptOptionInjected, false, `${name}: no GPT options`)
    assert.equal(r.runtimePolicy, "neutral", `${name}: neutral runtime`)
  }
})

// ===========================================================================
// v0.4.3 DeepSeek V4-and-later passive coverage
//
// Source: DeepSeek first-party docs re-verified 2026-09-27
// (docs/cache-policy-inventory.md §2). Caching is provider-wide and passive:
// no cache key/flag/breakpoint; Anthropic `cache_control` is ignored.
// ===========================================================================

test("v0.4.3: isDeepseekV4OrLater matches V4+ version tokens only", () => {
  const inFamily = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4.1", "deepseek-v4.5-pro", "deepseek-v5", "deepseek-v10", "deepseek/deepseek-v4-pro"]
  for (const id of inFamily) assert.equal(isDeepseekV4OrLater(id), true, `${id} is V4+`)
  const outOfFamily = ["deepseek-v3", "deepseek-v2", "deepseek-chat", "deepseek-reasoner", "deepseek-coder", "deepseek-flash", "my-deepseek-mirror", ""]
  for (const id of outOfFamily) assert.equal(isDeepseekV4OrLater(id), false, `${id} is not a V4+ version token`)
})

test("v0.4.3: canonical V4 ids and aliases resolve to the passive DeepSeek family", () => {
  for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
    const r = resolvePolicy(M("deepseek", id))
    assert.equal(r.creator, "deepseek")
    assert.equal(r.family, "deepseek")
    assert.equal(baseId(r), "deepseek.kv-cache")
    assert.deepEqual(overlayIds(r), [])
    const rt = resolveRuntimePolicy(M("deepseek", id))
    assert.equal(rt.policy, "deepseek")
    assert.equal(rt.gptCacheMetadata, false)
    assert.equal(rt.envRelocation, null)
    assert.equal(rt.cacheRatio, null)
    assert.equal(rt.openRouterAffinity, false)
  }
  // v0.4.0 alias handling is preserved.
  const alias = resolvePolicy(M("deepseek", "deepseek-v4-flash"))
  assert.equal(alias.family, "deepseek")
  assert.ok(alias.matchReason.startsWith("alias:deepseek-v4-flash"))
  assert.equal(resolveRuntimePolicy(M("deepseek", "deepseek-v4-flash")).policy, "deepseek")
  assert.equal(resolvePolicy(M("deepseek", "deepseek-chat")).family, "deepseek")
})

test("v0.4.3: later and unknown DeepSeek ids stay passive (no speculative mutation)", () => {
  for (const id of ["deepseek-v5", "deepseek-v6.2", "deepseek-v4.1-pro", "deepseek-nova"]) {
    const r = resolvePolicy(M("deepseek", id))
    assert.equal(r.creator, "deepseek")
    assert.equal(r.family, "deepseek")
    assert.deepEqual(overlayIds(r), [], `${id}: no overlay`)
    const rt = resolveRuntimePolicy(M("deepseek", id))
    assert.equal(rt.policy, "deepseek", `${id}: passive policy`)
    assert.equal(rt.gptCacheMetadata, false)
    assert.equal(rt.envRelocation, null)
    assert.equal(rt.cacheRatio, null)
    assert.equal(rt.openRouterAffinity, false)
  }
})

test("v0.4.3: pre-V4 DeepSeek ids remain passive and outside the V4+ family entry", () => {
  for (const id of ["deepseek-v3", "deepseek-v2", "deepseek-coder"]) {
    const r = resolvePolicy(M("deepseek", id))
    assert.equal(r.family, "deepseek")
    // handled by the safe creator fallback, not the V4+ family predicate
    assert.equal(r.matchType, "creator", `${id}: creator fallback`)
    assert.equal(resolveRuntimePolicy(M("deepseek", id)).policy, "deepseek")
  }
})

test("v0.4.3: DeepSeek keeps the generic read/write ratio and no family-specific fields", () => {
  const rt = resolveRuntimePolicy(M("deepseek", "deepseek-v4-pro"))
  assert.equal(rt.cacheRatio, null) // generic read/(read+write) accounting is used
  assert.equal(hitRatePct(30, 70), 30)
})

test("v0.4.3: DeepSeek never receives OpenRouter affinity or GPT/GLM/MiMo fields", async () => {
  const { results } = await policyMigrationResults()
  const deepseekCases = [
    "deepseek-v4-pro",
    "deepseek-flash",
    "deepseek-v5-future",
    "deepseek-v3-pre",
    "deepseek-openrouter",
    "deepseek-gateway",
  ]
  for (const name of deepseekCases) {
    const r = results.find((x) => x.name === name)
    assert.ok(r, `${name} present`)
    assert.equal(r.runtimePolicy, "deepseek", `${name}: passive policy`)
    assert.equal(r.detectPolicy, "deepseek", `${name}: detectPolicy agrees`)
    assert.equal(r.gptOptionInjected, false, `${name}: no GPT options leak`)
    assert.equal(r.systemRelocated, false, `${name}: no GLM/MiMo env relocation`)
    assert.equal(r.affinityHeaderAttached, false, `${name}: no OpenRouter affinity`)
    assert.equal(r.existingHeadersPreserved, true, `${name}: headers preserved`)
  }
})

// ===========================================================================
// v0.4.4 GLM-5.3-and-later family baseline vs the GLM-5.3-specific overlay
//
// Source: Z.AI docs re-verified 2026-09-27 (docs/cache-policy-inventory.md §3).
// Z.AI documents implicit caching (no cache control) and publishes no
// generational-inheritance rule; the `<env>` relocation is a CacheEngine overlay
// with no first-party basis. GLM-5.2 and earlier stay neutral.
// ===========================================================================

test("v0.4.4: isGlm53OrLater matches GLM-5.3+ version tokens only", () => {
  const inFamily = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.4", "glm-5.9", "glm-6", "z-ai/glm-5.3-flash"]
  for (const id of inFamily) assert.equal(isGlm53OrLater(id), true, `${id} is 5.3+`)
  const outOfFamily = ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-32b-0414-128k", ""]
  for (const id of outOfFamily) assert.equal(isGlm53OrLater(id), false, `${id} is pre-5.3`)
})

test("v0.4.4: GLM-5.3 keeps its overlay; a later GLM gets the baseline only", () => {
  const g53 = resolvePolicy(M("zai", "glm-5.3"))
  assert.equal(g53.family, "glm-5.3")
  assert.equal(baseId(g53), "zai.implicit-cache")
  assert.deepEqual(overlayIds(g53), ["glm53.env-relocation"])

  const g54 = resolvePolicy(M("zai", "glm-5.4"))
  assert.equal(g54.creator, "z.ai")
  assert.equal(g54.family, "glm-5.3")
  assert.equal(baseId(g54), "zai.implicit-cache") // same family baseline
  assert.deepEqual(overlayIds(g54), []) // overlay is NOT inherited

  // Runtime capability separation: baseline diagnostics/transport yes, prompt rewrite no.
  const c53 = resolveRuntimePolicy(M("zai", "glm-5.3"))
  const c54 = resolveRuntimePolicy(M("zai", "glm-5.4"))
  assert.equal(c54.policy, "glm53")
  assert.equal(c54.envRelocation, null)
  assert.equal(c54.thinkingIntegrity, true)
  assert.equal(c54.cacheRatio, "glm")
  assert.equal(c54.providerChange, "glm")
  assert.equal(c54.openRouterAffinity, true)
  assert.equal(c53.envRelocation, "glm")

  // Boundary metadata is traceable and the overlay is registered separately.
  const plus = POLICY_REGISTRY.find((e) => e.id === "zai.glm-5.3-plus")
  assert.equal(plus.boundary, "GLM-5.3 and later")
  assert.deepEqual(plus.overlays, [])
  assert.ok(plus.inventoryRef)
})

test("v0.4.4: GLM-5.2 and earlier stay neutral", () => {
  for (const id of ["glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5"]) {
    const r = resolvePolicy(M("zai", id))
    assert.equal(r.family, "neutral", `${id} neutral`)
    assert.deepEqual(overlayIds(r), [])
    assert.equal(resolveRuntimePolicy(M("zai", id)).policy, "neutral")
  }
})

test("v0.4.4: legacy detectPolicy follows the GLM-5.3-and-later boundary", () => {
  assert.equal(detectPolicy(M("zai", "glm-5.3-flash")), POLICY_GLM53)
  assert.equal(detectPolicy(M("zai", "glm-5.4")), POLICY_GLM53)
  assert.equal(detectPolicy(M("zai", "glm-5.2")), POLICY_NEUTRAL)
})

test("v0.4.4: <env> absent leaves system content unchanged", () => {
  const plain = "Stable instructions only.\nNo environment block here."
  const r = relocateVolatileEnvBlock(plain)
  assert.equal(r.changed, false)
  assert.equal(r.text, plain)
})

test("v0.4.4: later GLM inherits the baseline but never the <env> rewrite (runtime)", async () => {
  const { results } = await policyMigrationResults()
  const g53 = results.find((r) => r.name === "glm-5.3-direct")
  const g54 = results.find((r) => r.name === "glm-5.4-direct")
  assert.ok(g53 && g54)
  // Identical system text with a valid <env> block present in both cases.
  assert.equal(g53.systemRelocated, true) // 5.3 overlay fires
  assert.equal(g54.systemRelocated, false) // later GLM does NOT inherit it
  assert.equal(g54.runtimePolicy, "glm53") // but the family baseline applies
  assert.equal(g54.gptOptionInjected, false)
  assert.equal(g54.affinityHeaderAttached, false)
})

test("v0.4.4: GLM OpenRouter affinity is transport-gated for later GLM too", async () => {
  const { results } = await policyMigrationResults()
  const or = results.find((r) => r.name === "glm-5.4-openrouter")
  const direct = results.find((r) => r.name === "glm-5.4-direct")
  assert.equal(or.affinityHeaderAttached, true)
  assert.equal(or.systemRelocated, false)
  assert.equal(direct.affinityHeaderAttached, false)
  assert.equal(or.existingHeadersPreserved, true)
  assert.equal(direct.existingHeadersPreserved, true)
})

// ===========================================================================
// v0.4.5 MiMo V2.6+ family baseline vs the validated MiMo overlay
//
// Source: Xiaomi MiMo docs re-verified 2026-09-27
// (docs/cache-policy-inventory.md §4). Caching is provider-managed/implicit with
// no cache-control field; the `<env>` relocation is a CacheEngine overlay with
// no first-party basis; V2.5 deprecates 2026-10-21. No V2.7+/inheritance rule is
// documented, so future coverage is a safe passive baseline only.
// ===========================================================================

test("v0.4.5: isMimoAfterV26 matches generations strictly after V2.6", () => {
  const inFamily = ["mimo-v2.7-flash", "mimo-v2.7", "mimo-v2.8-pro", "mimo-v3", "mimo-v3.1-flash", "xiaomi/mimo-v2.7-flash"]
  for (const id of inFamily) assert.equal(isMimoAfterV26(id), true, `${id} is after V2.6`)
  const outOfFamily = ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flashx", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-flash", ""]
  for (const id of outOfFamily) assert.equal(isMimoAfterV26(id), false, `${id} is not after V2.6`)
})

test("v0.4.5: Flash/Pro keep the overlay; UltraSpeed and later get the baseline only", () => {
  const flash = resolvePolicy(M("xiaomi", "mimo-v2.6-flash"))
  assert.equal(flash.family, "mimo-v2.6")
  assert.equal(baseId(flash), "xiaomi.implicit-cache")
  assert.deepEqual(overlayIds(flash), ["mimo26.env-relocation"])
  assert.deepEqual(overlayIds(resolvePolicy(M("xiaomi", "mimo-v2.6-pro"))), ["mimo26.env-relocation"])

  for (const id of ["mimo-v2.6-pro-ultraspeed", "mimo-v2.7-flash"]) {
    const r = resolvePolicy(M("xiaomi", id))
    assert.equal(r.family, "mimo-v2.6", `${id}: family`)
    assert.equal(baseId(r), "xiaomi.implicit-cache", `${id}: same baseline`)
    assert.deepEqual(overlayIds(r), [], `${id}: no overlay`)
    const c = resolveRuntimePolicy(M("xiaomi", id))
    assert.equal(c.policy, "mimo26", `${id}: policy`)
    assert.equal(c.envRelocation, null, `${id}: no prompt rewrite`)
    assert.equal(c.cacheRatio, "mimo", `${id}: cached-token ratio`)
    assert.equal(c.providerChange, "mimo", `${id}: provider diagnostics`)
    assert.equal(c.openRouterAffinity, true, `${id}: affinity capability`)
    assert.equal(c.gptCacheMetadata, false, `${id}: no leak`)
  }

  // Same baseline object family for the overlay and non-overlay members.
  assert.equal(baseId(resolvePolicy(M("xiaomi", "mimo-v2.7-flash"))), baseId(flash))
})

test("v0.4.5: MiMo V2.5 and earlier stay neutral", () => {
  for (const id of ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-flash", "mimo-v2"]) {
    const r = resolvePolicy(M("xiaomi", id))
    assert.equal(r.family, "neutral", `${id}: neutral`)
    assert.deepEqual(overlayIds(r), [], `${id}: no overlay`)
    assert.equal(resolveRuntimePolicy(M("xiaomi", id)).policy, "neutral", `${id}: neutral runtime`)
  }
})

test("v0.4.5: legacy detectPolicy follows the MiMo V2.6+ boundary", () => {
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-flash")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-pro-ultraspeed")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.7-flash")), POLICY_MIMO26)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.5")), POLICY_NEUTRAL)
  assert.equal(detectPolicy(M("xiaomi", "mimo-v2.6-flashx")), POLICY_NEUTRAL)
})

test("v0.4.5: <env> absent is a no-op for MiMo transforms", () => {
  const plain = "Stable MiMo instructions.\nNo environment block."
  const r = relocateVolatileEnvBlock(plain)
  assert.equal(r.changed, false)
  assert.equal(r.text, plain)
})

test("v0.4.5: later MiMo inherits the baseline but never the <env> overlay (runtime)", async () => {
  const { results } = await policyMigrationResults()
  const flash = results.find((r) => r.name === "mimo-v2.6-flash-direct")
  const ultra = results.find((r) => r.name === "mimo-v2.6-pro-ultraspeed")
  const future = results.find((r) => r.name === "mimo-v2.7-future")
  assert.ok(flash && ultra && future)
  // Identical system text with a valid <env> block present in every case.
  assert.equal(flash.systemRelocated, true) // validated Flash overlay fires
  assert.equal(ultra.systemRelocated, false) // UltraSpeed: baseline only
  assert.equal(future.systemRelocated, false) // future model: baseline only
  assert.equal(ultra.runtimePolicy, "mimo26")
  assert.equal(future.runtimePolicy, "mimo26")
})

test("v0.4.5: MiMo OpenRouter affinity stays transport-gated", async () => {
  const { results } = await policyMigrationResults()
  const orFuture = results.find((r) => r.name === "mimo-v2.7-openrouter")
  const orUltra = results.find((r) => r.name === "mimo-v2.6-pro-ultraspeed-openrouter")
  const direct = results.find((r) => r.name === "mimo-v2.7-future")
  assert.equal(orFuture.affinityHeaderAttached, true)
  assert.equal(orUltra.affinityHeaderAttached, true)
  assert.equal(direct.affinityHeaderAttached, false)
  assert.equal(orFuture.systemRelocated, false) // affinity is transport, not the overlay
})

test("v0.4.5: MiMo baseline invents no cache fields and keeps cached-token telemetry", () => {
  const c = resolveRuntimePolicy(M("xiaomi", "mimo-v2.7-flash"))
  assert.equal(c.gptCacheMetadata, false)
  assert.equal(c.envRelocation, null)
  assert.equal(c.cacheRatio, "mimo") // cachedTokens / promptTokens
  assert.equal(mimoHitRate(75, 100), 75)
})

// ===========================================================================
// v0.4.6 unknown / future model safety + policy-match telemetry
//
// Synthetic future identifiers only. No network calls. The resolver must stay
// deterministic and total, must never invent cache controls, and must never
// apply a model-specific prompt overlay without an explicit registry entry.
// ===========================================================================

test("v0.4.6: explainPolicyResolution classifies every match category", () => {
  // exact documented model id
  const exact = explainPolicyResolution(M("openai", "gpt-5.6-sol"))
  assert.equal(exact.matchCategory, "exact-id")
  assert.equal(exact.matchKind, "exact-id")
  assert.equal(exact.family, "gpt-5.6")
  assert.equal(exact.policy, "gpt56")
  assert.equal(exact.matchedId, "gpt-5.6-sol")

  // documented alias
  const alias = explainPolicyResolution(M("openai", "gpt-5.6"))
  assert.equal(alias.matchCategory, "alias")
  assert.equal(alias.matchKind, "alias")

  // family pattern match (no version predicate, and not a registered exact id)
  const pattern = explainPolicyResolution(M("zai", "glm-5.3-preview"))
  assert.equal(pattern.matchCategory, "family")
  assert.equal(pattern.matchKind, "pattern")

  // family version-range match
  const range = explainPolicyResolution(M("openai", "gpt-7-codex"))
  assert.equal(range.matchCategory, "family")
  assert.equal(range.matchKind, "version-range")

  // creator baseline
  const creator = explainPolicyResolution(M("acme-gateway", "my-deepseek-mirror"))
  assert.equal(creator.matchCategory, "creator")
  assert.equal(creator.matchKind, "creator-baseline")
  assert.equal(creator.family, "deepseek")

  // neutral / unknown
  const neutral = explainPolicyResolution(M("acme", "acme/nova-9"))
  assert.equal(neutral.matchCategory, "neutral")
  assert.equal(neutral.matchKind, "unknown")
  assert.equal(neutral.isNeutral, true)
  assert.equal(neutral.family, "neutral")
})

test("v0.4.6: overlay application is reported, and unvalidated overlays are explicit", () => {
  const validated = explainPolicyResolution(M("zai", "glm-5.3"))
  assert.equal(validated.overlayApplied, true)
  assert.deepEqual(validated.overlays, ["glm53.env-relocation"])
  assert.equal(validated.overlaySkipped, false)
  assert.equal(validated.overlaySkippedReason, null)

  // Same family, not a validated model: baseline only, overlay explicitly skipped.
  const future = explainPolicyResolution(M("zai", "glm-6"))
  assert.equal(future.family, "glm-5.3")
  assert.equal(future.policy, "glm53")
  assert.equal(future.overlayApplied, false)
  assert.equal(future.overlaySkipped, true)
  assert.equal(future.overlaySkippedReason, "overlay-not-validated-for-model")
  assert.deepEqual(future.overlaySkippedCandidates, ["glm53.env-relocation"])

  const mimoFuture = explainPolicyResolution(M("xiaomi", "mimo-v3-flash"))
  assert.equal(mimoFuture.family, "mimo-v2.6")
  assert.equal(mimoFuture.overlayApplied, false)
  assert.equal(mimoFuture.overlaySkippedReason, "overlay-not-validated-for-model")

  // A family with no registered overlay is not reported as "skipped".
  const deepseekFuture = explainPolicyResolution(M("deepseek", "deepseek-v9"))
  assert.equal(deepseekFuture.overlayApplied, false)
  assert.equal(deepseekFuture.overlaySkipped, false)
  assert.equal(deepseekFuture.overlaySkippedReason, null)

  // A registered overlay on an entry whose runtime is neutral is NOT applied and
  // must not be reported as applied. A non-runtime-active alias is the real case.
  const inactiveAlias = explainPolicyResolution(M("openai", "gpt-daybreak-blue-latest"))
  assert.deepEqual(inactiveAlias.overlays, ["gpt56.prompt-cache-options"])
  assert.equal(inactiveAlias.isNeutral, true)
  assert.equal(inactiveAlias.policy, "neutral")
  assert.equal(inactiveAlias.overlayApplied, false, "must not claim an unapplied overlay")
  assert.equal(inactiveAlias.overlaySkipped, true)
  assert.equal(inactiveAlias.overlaySkippedReason, "registry-entry-not-runtime-active")
  assert.deepEqual(inactiveAlias.overlaySkippedCandidates, ["gpt56.prompt-cache-options"])
})

test("v0.4.6: provider identity is reported, never guessed", () => {
  const known = explainPolicyResolution(M("openrouter", "z-ai/glm-6"))
  assert.equal(known.providerIdentityKnown, true)
  assert.equal(known.provider, "openrouter")
  assert.equal(known.transportKind, "openrouter")

  const direct = explainPolicyResolution(M("zai", "glm-6"))
  assert.equal(direct.providerIdentityKnown, true)
  assert.equal(direct.transportKind, "direct")
  assert.equal(direct.sessionAffinityHeader, null)

  // No provider identity at all: unknown, and no affinity capability claimed.
  const missing = explainPolicyResolution({ id: "acme/nova-9", api: { id: "acme/nova-9" } })
  assert.equal(missing.providerIdentityKnown, false)
  assert.equal(missing.provider, null)
  assert.equal(missing.transportKind, "unknown")
  assert.equal(missing.sessionAffinityHeader, null)
  assert.equal(missing.matchCategory, "neutral")
})

test("v0.4.6: the resolver is total and deterministic for synthetic future ids", () => {
  const futureIds = [
    ["openai", "gpt-9-ultra"],
    ["azure", "gpt-12-reasoner"],
    ["deepseek", "deepseek-v12"],
    ["zai", "glm-9.9"],
    ["xiaomi", "mimo-v4-pro"],
    ["acme", "acme/nova-9"],
  ]
  for (const [providerID, id] of futureIds) {
    const model = M(providerID, id)
    let first
    assert.doesNotThrow(() => {
      first = explainPolicyResolution(model)
    }, `${id} must not throw`)
    // Deterministic: same input, same explanation.
    assert.deepEqual(explainPolicyResolution(model), first, `${id} must be deterministic`)
    // Always usable: a well-formed result with a known policy string.
    assert.equal(typeof first.policy, "string", `${id} must resolve a policy`)
    assert.equal(typeof first.matchCategory, "string", `${id} must report a category`)
  }
  // Garbage input is neutral, never a throw.
  for (const bad of [null, undefined, {}, { providerID: "" }, { providerID: 42 }, "nope", 7]) {
    let r
    assert.doesNotThrow(() => {
      r = explainPolicyResolution(bad)
    })
    assert.equal(r.isNeutral, true, `${JSON.stringify(bad)} must be neutral`)
  }
  // No provider identity at all is reported as unknown, not invented.
  for (const bad of [null, undefined, {}, { providerID: "" }, "nope", 7]) {
    assert.equal(explainPolicyResolution(bad).providerIdentityKnown, false)
  }
})

test("v0.4.6: future models inherit a baseline only where the registry says so", () => {
  // OpenAI documents a "GPT-5.6 and later" class, so a future GPT generation on
  // an OpenAI-context endpoint inherits the documented cache metadata.
  const gpt = explainPolicyResolution(M("openai", "gpt-9-ultra"))
  assert.equal(gpt.family, "gpt-5.6")
  assert.equal(gpt.policy, "gpt56")
  assert.equal(resolveRuntimePolicy(M("openai", "gpt-9-ultra")).gptCacheMetadata, true)

  // The same id on a non-OpenAI endpoint must not gain GPT-specific fields.
  const leak = explainPolicyResolution(M("acme-gateway", "gpt-9-ultra"))
  assert.equal(leak.isNeutral, true)
  assert.equal(leak.policy, "neutral")
  assert.equal(resolveRuntimePolicy(M("acme-gateway", "gpt-9-ultra")).gptCacheMetadata, false)

  // DeepSeek stays passive: baseline telemetry only, no cache fields.
  const ds = resolveRuntimePolicy(M("deepseek", "deepseek-v12"))
  assert.equal(ds.policy, "deepseek")
  assert.equal(ds.gptCacheMetadata, false)
  assert.equal(ds.envRelocation, null)

  // GLM/MiMo future models keep the family baseline but lose the prompt overlay.
  for (const [providerID, id] of [["zai", "glm-9.9"], ["xiaomi", "mimo-v4-pro"]]) {
    const caps = resolveRuntimePolicy(M(providerID, id))
    assert.equal(caps.envRelocation, null, `${id} must not relocate the prompt`)
    assert.equal(caps.gptCacheMetadata, false, `${id} must not gain GPT options`)
    assert.equal(caps.openRouterAffinity, true, `${id} keeps transport affinity`)
  }

  // An unknown vendor is fully neutral: no guessed cache controls at all.
  const unknown = resolveRuntimePolicy(M("acme", "acme/nova-9"))
  assert.equal(unknown.policy, "neutral")
  assert.equal(unknown.isNeutral, true)
  assert.equal(unknown.gptCacheMetadata, false)
  assert.equal(unknown.envRelocation, null)
  assert.equal(unknown.openRouterAffinity, false)
})

test("v0.4.6: unknown/future hooks stay safe end to end (no model calls)", async () => {
  const { results } = await policyMigrationResults()
  const futureCases = [
    "gpt-7-future-openai", "gpt-7-future-nonopenai-gateway", "deepseek-v9-future",
    "deepseek-v9-future-openrouter", "glm-6-future", "glm-6-future-openrouter",
    "mimo-v3-future", "mimo-v3-future-openrouter", "unknown-vendor-model",
    "missing-provider-identity",
  ]
  for (const name of futureCases) {
    const r = results.find((x) => x.name === name)
    assert.ok(r, `${name} must be in the probe matrix`)
    // No unvalidated prompt transformation anywhere.
    assert.equal(r.systemRelocated, false, `${name} must not transform the prompt`)
    // GPT options only for the OpenAI-context future GPT case, and never any
    // other provider option.
    assert.equal(r.gptOptionInjected, r.expect.gpt, `${name} gpt option leak`)
    if (r.expect.gpt) assert.deepEqual(r.gptOptions, { mode: "implicit", ttl: "30m" }, `${name} gpt options`)
    else assert.equal(r.gptOptions, null, `${name} must not add promptCacheOptions`)
    // Pre-existing headers are always preserved.
    assert.equal(r.existingHeadersPreserved, true, `${name} must preserve headers`)
    // Resolver and legacy classification agree.
    assert.equal(r.runtimePolicy, r.detectPolicy, `${name} classification agreement`)
  }
})

test("v0.4.6: OpenRouter affinity still requires a real OpenRouter identity", async () => {
  const { results } = await policyMigrationResults()
  const byName = (n) => results.find((x) => x.name === n)
  // Same future model id, different provider identity -> different transport.
  assert.equal(byName("glm-6-future-openrouter").affinityHeaderAttached, true)
  assert.equal(byName("glm-6-future").affinityHeaderAttached, false)
  assert.equal(byName("mimo-v3-future-openrouter").affinityHeaderAttached, true)
  assert.equal(byName("mimo-v3-future").affinityHeaderAttached, false)
  // DeepSeek is never an affinity family, even on OpenRouter.
  assert.equal(byName("deepseek-v9-future-openrouter").affinityHeaderAttached, false)
  // A future GPT on OpenRouter is not an affinity family either.
  assert.equal(byName("gpt-7-future-openai").affinityHeaderAttached, false)
  // Missing provider identity never gets the header.
  assert.equal(byName("missing-provider-identity").affinityHeaderAttached, false)
})

test("v0.4.6: policy-match telemetry records the resolution reason and nothing sensitive", async () => {
  const { resolutions, repeatEmission, alternationEmission, allKinds } = await policyMigrationResults()

  // Every probe session produced exactly one resolution record.
  assert.ok(resolutions.length >= 35, "one policy-resolution record per probe session")
  // Repeating an unchanged resolution in the same session does not re-emit.
  assert.equal(repeatEmission, 1, "resolution telemetry must be deduplicated per session")
  // Alternating between two models records each distinct resolution once, not
  // once per request. This is the real title/summary pattern.
  assert.equal(alternationEmission, 2, "alternating models must dedupe per distinct resolution")
  assert.ok(allKinds.includes("policy-resolution"))
  // One record per session per distinct resolution, no duplicates.
  const keys = resolutions.map((r) => `${r.sid}|${r.matchCategory}|${r.matchKind}|${r.family}|${r.matchReason}|${r.provider}|${r.model}`)
  assert.equal(new Set(keys).size, keys.length)

  const bySidPrefix = (prefix) => resolutions.find((r) => r.sid === "ses_" + prefix)
  const pick = (r) => ({ category: r.matchCategory, kind: r.matchKind, family: r.family, policy: r.policy, overlayApplied: r.overlayApplied, overlaySkipped: r.overlaySkipped, known: r.providerIdentityKnown, provider: r.provider, isNeutral: r.isNeutral })

  // documented alias resolution
  const gpt = pick(bySidPrefix("gpt-5.6"))
  assert.equal(gpt.category, "alias")
  assert.equal(gpt.family, "gpt-5.6")
  assert.equal(gpt.policy, "gpt56")

  // exact documented model id
  assert.equal(pick(bySidPrefix("deepseek-flash")).category, "exact-id")

  // version-range match for a future GPT generation on an OpenAI endpoint
  const gptFuture = pick(bySidPrefix("gpt-7-future-openai"))
  assert.equal(gptFuture.category, "family")
  assert.equal(gptFuture.kind, "version-range")
  assert.equal(gptFuture.overlayApplied, true)

  // GPT options must not leak to a non-OpenAI endpoint
  const gptLeak = pick(bySidPrefix("gpt-7-future-nonopenai-gateway"))
  assert.equal(gptLeak.category, "neutral")
  assert.equal(gptLeak.isNeutral, true)

  // DeepSeek future generation: passive family baseline, no overlay concept
  const dsFuture = pick(bySidPrefix("deepseek-v9-future"))
  assert.equal(dsFuture.category, "family")
  assert.equal(dsFuture.family, "deepseek")
  assert.equal(dsFuture.overlayApplied, false)
  assert.equal(dsFuture.overlaySkipped, false)

  // creator baseline match (mirror slug on a third-party gateway)
  const creator = pick(bySidPrefix("deepseek-gateway"))
  assert.equal(creator.category, "creator")

  // GLM/MiMo future generations: baseline with the overlay explicitly skipped
  for (const prefix of ["glm-6-future", "mimo-v3-future"]) {
    const r = bySidPrefix(prefix)
    assert.equal(r.overlayApplied, false, prefix)
    assert.equal(r.overlaySkipped, true, prefix)
    assert.equal(r.overlaySkippedReason, "overlay-not-validated-for-model", prefix)
  }

  // unknown vendor -> neutral
  const unknown = pick(bySidPrefix("unknown-vendor-model"))
  assert.equal(unknown.category, "neutral")
  assert.equal(unknown.provider, "acme")

  // A resolved-but-inactive alias must not claim its overlay was applied, and
  // the withheld overlay is named so a reviewer can act on it.
  const aliasRec = bySidPrefix("gpt-daybreak-alias")
  assert.equal(aliasRec.overlayApplied, false, "inactive alias must not claim an applied overlay")
  assert.equal(aliasRec.overlaySkipped, true)
  assert.equal(aliasRec.overlaySkippedReason, "registry-entry-not-runtime-active")
  assert.deepEqual(aliasRec.overlaySkippedCandidates, ["gpt56.prompt-cache-options"])
  assert.equal(aliasRec.isNeutral, true)

  // The withheld-overlay detail is present on the record, not just in the helper.
  const glmFutureRec = bySidPrefix("glm-6-future")
  assert.deepEqual(glmFutureRec.overlaySkippedCandidates, ["glm53.env-relocation"])

  // missing provider identity is reported, not guessed
  const missing = pick(bySidPrefix("missing-provider-identity"))
  assert.equal(missing.known, false)
  assert.equal(missing.provider, null)
  assert.equal(missing.isNeutral, true)

  // Never log prompt/system/tool content, credentials, authorization headers, or
  // the raw x-session-id value. Registry identifiers and the model id are fine
  // (the model id is what makes a new model reviewable).
  const forbiddenKey = /^(system|prompt|prompts|tool|tools|content|apiKey|api_key|authorization|auth|headers?|x-session-id|sessionId)$/i
  const forbiddenValue = /today's date|keep1|keep2|powered by|api[-_ ]?key|authorization|bearer|x-session-id|mimo-ses-|oc-ses-/i
  for (const r of resolutions) {
    for (const k of Object.keys(r)) assert.ok(!forbiddenKey.test(k), `forbidden telemetry key: ${k}`)
    for (const v of Object.values(r)) {
      if (typeof v === "string") assert.ok(!forbiddenValue.test(v), `forbidden telemetry value: ${v}`)
    }
    // The derived session id is never recorded.
    assert.equal(r.stickySessionId, undefined)
  }
})

// ===========================================================================
// v0.4.6 K1/K2: the usage collector must use the V1.18.33 SDK call shape and
// must actually aggregate provider-reported cache tokens into a `usage` record.
//
// Regression intent: the previous collector called
//   client.session.messages({ sessionID, limit, before })
// which does not match the V1 SDK ({ path: { id } }) and produced no usage
// telemetry in live use. These tests fail against the old shape.
// ===========================================================================

async function runUsageCollectionProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-usage-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/usage-probe.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})

    const calls = []
    const responses = {}
    const fake = {
      app: { log: async () => ({}) },
      session: {
        get: async () => ({ data: { parentID: null } }),
        async messages(opts) {
          calls.push({ opts: JSON.parse(JSON.stringify(opts)), thisIsSession: this === fake.session })
          const id = opts && opts.path && opts.path.id
          const r = responses[id]
          if (r === "THROW") throw new Error("boom")
          return r
        },
      },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME })
    const tick = () => new Promise((r) => setTimeout(r, 30))
    const mkAst = (id, read, write, input) => ({ info: { id, role: "assistant", tokens: { input, output: 1, cache: { read, write } } }, parts: [] })
    const mkUser = (id) => ({ info: { id, role: "user" }, parts: [] })
    const providerFor = (id) => ({ source: "config", info: { id }, options: {} })
    const setModel = async (sid, providerID, modelID) => {
      await hooks["chat.params"]({
        sessionID: sid, agent: "build",
        model: { providerID, id: modelID, api: { id: modelID } },
        provider: providerFor(providerID),
        message: { id: "u-" + sid, sessionID: sid, role: "user", content: "x" },
      }, { options: {} })
    }
    const idle = async (sid) => { await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } }); await tick() }

    const SID_BASIC = "ses_usage_basic"
    responses[SID_BASIC] = { data: [mkAst("a1", 3000, 500, 1000)] }
    await setModel(SID_BASIC, "deepseek", "deepseek-flash")
    await idle(SID_BASIC)

    const SID_MULTI = "ses_usage_multi"
    responses[SID_MULTI] = { data: [mkAst("m3", 100, 0, 10), mkUser("m2"), mkAst("m1", 50, 5, 5)] }
    await setModel(SID_MULTI, "deepseek", "deepseek-flash")
    await idle(SID_MULTI)
    await idle(SID_MULTI)

    const SID_EMPTY = "ses_usage_empty"
    responses[SID_EMPTY] = { data: [] }
    await idle(SID_EMPTY)

    const SID_UNDEF = "ses_usage_undef"
    responses[SID_UNDEF] = undefined
    await idle(SID_UNDEF)

    const SID_THROW = "ses_usage_throw"
    responses[SID_THROW] = "THROW"
    await idle(SID_THROW)

    // v0.5.0: Kimi uses the same generic accounting path (read/(read+write)).
    const SID_KIMI = "ses_usage_kimi"
    responses[SID_KIMI] = { data: [mkAst("k1", 4000, 400, 2000)] }
    await setModel(SID_KIMI, "moonshot", "kimi-k3")
    await idle(SID_KIMI)

    // v0.5.2: Claude uses the same generic accounting path.
    const SID_CLAUDE = "ses_usage_claude"
    responses[SID_CLAUDE] = { data: [mkAst("c1", 5000, 800, 1200)] }
    await setModel(SID_CLAUDE, "anthropic", "claude-sonnet-4-5")
    await idle(SID_CLAUDE)

    // v0.5.3: Gemini reports cache reads only (no write field); generic path.
    const SID_GEMINI = "ses_usage_gemini"
    responses[SID_GEMINI] = { data: [mkAst("g1", 3000, 0, 5000)] }
    await setModel(SID_GEMINI, "google", "gemini-2.5-pro")
    await idle(SID_GEMINI)

    const lines = readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n")
    const records = lines.map((l) => JSON.parse(l))
    process.stdout.write(JSON.stringify({ calls, records }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let usageProbe
const usageResults = async () => (usageProbe ??= runUsageCollectionProbe())

test("v0.4.6 K2: session.messages is called with the V1 SDK shape and a bound receiver", async () => {
  const { calls } = await usageResults()
  assert.ok(calls.length >= 5, "collector should call session.messages per idle")
  const sids = ["ses_usage_basic", "ses_usage_multi", "ses_usage_empty", "ses_usage_undef", "ses_usage_throw", "ses_usage_kimi", "ses_usage_claude", "ses_usage_gemini"]
  for (const c of calls) {
    // exactly { path: { id } }, nothing else
    assert.deepEqual(Object.keys(c.opts), ["path"])
    assert.deepEqual(Object.keys(c.opts.path), ["id"])
    assert.ok(sids.includes(c.opts.path.id), "path.id must be the session id")
    // no top-level sessionID, limit, or before, and no invented cursor field
    assert.equal(c.opts.sessionID, undefined)
    assert.equal(c.opts.limit, undefined)
    assert.equal(c.opts.before, undefined)
    // receiver binding preserved (methods use this._client)
    assert.equal(c.thisIsSession, true)
  }
})

test("v0.4.6 K1: idle aggregation emits a usage record with exact semantics", async () => {
  const { records } = await usageResults()
  const usage = records.filter((r) => r.kind === "usage")
  const basic = usage.find((r) => r.sid === "ses_usage_basic")
  assert.ok(basic, "a usage record must be produced for a session with cache tokens")
  assert.equal(basic.read, 3000)
  assert.equal(basic.write, 500)
  assert.equal(basic.input, 1000)
  assert.equal(basic.messages, 1)
  assert.equal(basic.sampleHitRate, 86) // round(100*3000/3500)
  assert.deepEqual(basic.cumulative, { read: 3000, write: 500 })
  assert.equal(basic.cumulativeHitRate, 86)
  assert.equal(basic.cursor, "a1")
  assert.equal(basic.provider, "deepseek")
  assert.equal(basic.model, "deepseek-flash")
  assert.equal(basic.policy, "deepseek")
})

test("v0.4.6 K1: multi-message aggregation counts only assistant cache data, once", async () => {
  const { records } = await usageResults()
  const usage = records.filter((r) => r.kind === "usage" && r.sid === "ses_usage_multi")
  assert.equal(usage.length, 1, "second idle must not re-aggregate the same messages")
  const u = usage[0]
  assert.equal(u.read, 150) // 100 + 50
  assert.equal(u.write, 5)
  assert.equal(u.input, 15) // 10 + 5
  assert.equal(u.messages, 2) // user message excluded
  assert.equal(u.cursor, "m1") // newest = last element (oldest-first runtime order)
})

test("v0.5.0: Kimi uses the generic cache accounting path (read/(read+write))", async () => {
  const { records } = await usageResults()
  const usage = records.filter((r) => r.kind === "usage" && r.sid === "ses_usage_kimi")
  assert.equal(usage.length, 1)
  const u = usage[0]
  assert.equal(u.read, 4000)
  assert.equal(u.write, 400)
  assert.equal(u.input, 2000)
  assert.equal(u.messages, 1)
  assert.equal(u.sampleHitRate, 91) // round(100*4000/4400)
  assert.equal(u.provider, "moonshot")
  assert.equal(u.model, "kimi-k3")
  assert.equal(u.policy, "kimi")
  // Generic ratio only: no GLM/MiMo-specific fields are fabricated.
  assert.equal(u.promptTokens, undefined)
  assert.equal(u.glmHitRate, undefined)
  assert.equal(u.cacheHitRate, undefined)
})

test("v0.5.2: Claude uses the generic cache accounting path (read/(read+write))", async () => {
  const { records } = await usageResults()
  const usage = records.filter((r) => r.kind === "usage" && r.sid === "ses_usage_claude")
  assert.equal(usage.length, 1)
  const u = usage[0]
  assert.equal(u.read, 5000)
  assert.equal(u.write, 800)
  assert.equal(u.input, 1200)
  assert.equal(u.messages, 1)
  assert.equal(u.sampleHitRate, 86) // round(100*5000/5800)
  assert.equal(u.provider, "anthropic")
  assert.equal(u.model, "claude-sonnet-4-5")
  assert.equal(u.policy, "claude")
  // Generic ratio only: no GLM/MiMo/Kimi-specific fields are fabricated.
  assert.equal(u.promptTokens, undefined)
  assert.equal(u.glmHitRate, undefined)
  assert.equal(u.cacheHitRate, undefined)
  assert.equal(u.stickySessionId, undefined)
})

test("v0.5.3: Gemini uses the generic cache accounting path (read-only, no fabricated write)", async () => {
  const { records } = await usageResults()
  const usage = records.filter((r) => r.kind === "usage" && r.sid === "ses_usage_gemini")
  assert.equal(usage.length, 1)
  const u = usage[0]
  assert.equal(u.read, 3000)
  assert.equal(u.write, 0) // Gemini exposes no cache-write field; not fabricated
  assert.equal(u.input, 5000)
  assert.equal(u.messages, 1)
  assert.equal(u.sampleHitRate, 100) // round(100*3000/3000); write is 0
  assert.equal(u.provider, "google")
  assert.equal(u.model, "gemini-2.5-pro")
  assert.equal(u.policy, "gemini")
  assert.equal(u.promptTokens, undefined)
  assert.equal(u.cacheHitRate, undefined)
})

test("v0.4.6 K1: empty/undefined/throwing messages fail safely without breaking the plugin", async () => {
  const { records } = await usageResults()
  const usageSids = records.filter((r) => r.kind === "usage").map((r) => r.sid)
  assert.ok(!usageSids.includes("ses_usage_empty"))
  assert.ok(!usageSids.includes("ses_usage_undef"))
  assert.ok(!usageSids.includes("ses_usage_throw"))
  const errs = records.filter((r) => r.kind === "telemetry-error")
  assert.ok(errs.some((r) => /boom/.test(String(r.error))), "the throw must be recorded, not propagated")
})

// ===========================================================================
// v0.4.8 P-A: compaction-safe cursor correctness.
//
// OpenCode V1 v1.18.34 returns client.session.messages() OLDEST-FIRST
// (chronological); verified against the live runtime and its SQLite store during
// this release. The collector counts assistant messages AFTER the cursor, uses
// the newest message (last element) as the new cursor, and falls back to a
// `time.created` watermark when the cursor message is pruned/reverted so
// historical messages can never be recounted.
// ===========================================================================

const asstT = (id, read, write, created, input = 0) => ({
  info: { id, role: "assistant", time: { created }, tokens: { input, cache: { read, write } } },
})
const userT = (id, created) => ({ info: { id, role: "user", time: { created } } })

test("v0.4.8: chronological scan counts only assistant messages after the cursor", () => {
  const page = [asstT("a1", 100, 10, 1000), userT("u1", 1100), asstT("a2", 50, 5, 1200)]
  const first = scanPage(page, null)
  assert.equal(first.count, 2)
  assert.equal(first.read, 150)
  assert.equal(first.write, 15)
  assert.equal(nextProcessedCursor(page, null), "a2")

  const next = [asstT("a1", 100, 10, 1000), userT("u1", 1100), asstT("a2", 50, 5, 1200), userT("u2", 1300), asstT("a3", 7, 1, 1400)]
  const scan = scanPage(next, "a2")
  assert.equal(scan.count, 1)
  assert.equal(scan.read, 7)
  assert.equal(scan.reachedStart, true)
})

test("v0.4.8: a pruned cursor cannot double-count (watermark bounds the scan)", () => {
  const before = [asstT("a1", 100, 10, 1000), asstT("a2", 50, 5, 2000)]
  const first = scanPage(before, null)
  assert.equal(first.count, 2)
  assert.equal(first.maxCreated, 2000)

  // Compaction removed the cursor message a2; a3 is genuinely new.
  const after = [asstT("a1", 100, 10, 1000), userT("u", 1900), asstT("a3", 30, 3, 2100)]
  const scan = scanPage(after, "a2", 2000)
  assert.equal(scan.reachedStart, false)
  assert.equal(scan.count, 1, "only the genuinely new assistant message is counted")
  assert.equal(scan.read, 30)
  assert.equal(scan.write, 3)
})

test("v0.4.8: missing cursor + multiple new messages after compaction counted once", () => {
  const after = [asstT("a1", 100, 10, 1000), asstT("a4", 11, 1, 2100), userT("u", 2200), asstT("a5", 22, 2, 2300)]
  const scan = scanPage(after, "a2", 2000)
  assert.equal(scan.count, 2)
  assert.equal(scan.read, 33)
  assert.equal(scan.write, 3)
})

test("v0.4.8: cursor missing with no watermark counts nothing (safe undercount)", () => {
  const after = [asstT("a1", 100, 10, 1000), asstT("a3", 30, 3, 2100)]
  const scan = scanPage(after, "a2", null)
  assert.equal(scan.count, 0)
  assert.equal(scan.read, 0)
})

test("v0.4.8: watermark is strictly-greater so timestamp ties undercount, never double-count", () => {
  const page = [asstT("a1", 100, 10, 1000), asstT("a2", 50, 5, 2000), asstT("a3", 30, 3, 2000)]
  const scan = scanPage(page, "ghost", 2000)
  assert.equal(scan.count, 0, "ties at the watermark are treated as already counted")
})

test("v0.4.8: empty post-compaction history is safe", () => {
  let scan
  assert.doesNotThrow(() => {
    scan = scanPage([], "a2", 2000)
  })
  assert.equal(scan.count, 0)
  assert.equal(nextProcessedCursor([], "a2"), "a2")
})

test("v0.4.8: missing timestamp metadata is not fabricated", () => {
  const page = [{ info: { id: "a1", role: "assistant", tokens: { cache: { read: 100, write: 0 } } } }]
  const first = scanPage(page, null)
  assert.equal(first.count, 1)
  assert.equal(first.maxCreated, null)
  const scan = scanPage(page, "gone", null)
  assert.equal(scan.count, 0)
})

test("v0.4.8: repeated idles after a pruned cursor never duplicate", () => {
  const after = [asstT("a1", 100, 10, 1000), asstT("a3", 30, 3, 2100)]
  const scan1 = scanPage(after, "a2", 2000)
  assert.equal(scan1.count, 1)
  const cursor = nextProcessedCursor(after, "a2")
  assert.equal(cursor, "a3")
  const scan2 = scanPage(after, cursor, 2100)
  assert.equal(scan2.count, 0)
})

test("v0.4.8: scanPage returns reasoning in chronological order", () => {
  const page = [
    { info: { id: "r1", role: "assistant", time: { created: 1000 }, tokens: { cache: { read: 1, write: 0 } } }, parts: [{ type: "reasoning", text: "first" }] },
    { info: { id: "r2", role: "assistant", time: { created: 2000 }, tokens: { cache: { read: 1, write: 0 } } }, parts: [{ type: "reasoning", text: "second" }] },
  ]
  const scan = scanPage(page, null)
  assert.deepEqual(scan.reasoning.map((r) => r.id), ["r1", "r2"])
})

test("v0.4.8 REGRESSION: a cursor at the newest message must not recount older messages", () => {
  // Fails against the previous newest-first implementation (which counted m1).
  const page = [asst("m1", 100, 20), asst("m2", 50, 10)]
  const scan = scanPage(page, "m2")
  assert.equal(scan.count, 0)
  assert.equal(scan.read, 0)
  assert.equal(scan.reachedStart, true)
})

async function runCompactionUsageProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-pa-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/pa.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const calls = []
    const responses = {}
    const fake = {
      app: { log: async () => ({}) },
      session: {
        get: async () => ({ data: { parentID: null } }),
        async messages(opts) {
          calls.push(JSON.parse(JSON.stringify(opts)))
          return responses[opts && opts.path && opts.path.id]
        },
      },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME })
    const tick = () => new Promise((r) => setTimeout(r, 30))
    const asst = (id, read, write, created) => ({ info: { id, role: "assistant", time: { created }, tokens: { input: 0, cache: { read, write } } }, parts: [] })
    const user = (id, created) => ({ info: { id, role: "user", time: { created } }, parts: [] })
    const setModel = (sid) => hooks["chat.params"]({ sessionID: sid, agent: "build", model: { providerID: "deepseek", id: "deepseek-flash", api: { id: "deepseek-flash" } }, provider: { source: "config", info: { id: "deepseek" }, options: {} }, message: { id: "u-"+sid, sessionID: sid, role: "user", content: "x" } }, { options: {} })
    const idle = async (sid) => { await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } }); await tick() }

    const SID = "ses_pa"
    responses[SID] = { data: [asst("a1", 100, 10, 1000), user("u1", 1100), asst("a2", 50, 5, 2000)] }
    await setModel(SID)
    await idle(SID)
    await idle(SID)

    // Simulate compaction: cursor a2 removed, new assistant a3 appended.
    responses[SID] = { data: [asst("a1", 100, 10, 1000), user("u1", 1100), user("c", 1900), asst("a3", 30, 3, 2100)] }
    await idle(SID)
    await idle(SID)

    const SID2 = "ses_pa_empty"
    responses[SID2] = { data: [] }
    await setModel(SID2)
    await idle(SID2)

    const records = readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n").map((l) => JSON.parse(l))
    process.stdout.write(JSON.stringify({ calls, records }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let compactionProbe
const compactionResults = async () => (compactionProbe ??= runCompactionUsageProbe())

test("v0.4.8: compaction does not duplicate usage; only new messages are added", async () => {
  const { records } = await compactionResults()
  const usage = records.filter((r) => r.kind === "usage" && r.sid === "ses_pa")
  assert.equal(usage.length, 2, "one usage record before compaction, one after")
  const [before, after] = usage
  assert.equal(before.read, 150)
  assert.equal(before.messages, 2)
  assert.equal(before.cumulative.read, 150)
  // After compaction: only a3 is counted; a1 is NOT recounted.
  assert.equal(after.read, 30)
  assert.equal(after.messages, 1)
  assert.equal(after.cumulative.read, 180)
  assert.equal(after.cursor, "a3")
})

test("v0.4.8: existing usage telemetry schema and attribution are unchanged", async () => {
  const { records } = await compactionResults()
  const u = records.find((r) => r.kind === "usage" && r.sid === "ses_pa")
  assert.ok(u)
  for (const k of ["kind", "sid", "ts", "read", "write", "input", "messages", "sampleHitRate", "cumulative", "cumulativeHitRate", "cursor", "provider", "model", "policy"]) {
    assert.ok(k in u, `usage record must contain ${k}`)
  }
  assert.equal(u.provider, "deepseek")
  assert.equal(u.model, "deepseek-flash")
  assert.equal(u.policy, "deepseek")
})

test("v0.4.8: empty post-compaction history produces no fabricated usage and does not throw", async () => {
  const { records, calls } = await compactionResults()
  assert.ok(!records.some((r) => r.kind === "usage" && r.sid === "ses_pa_empty"))
  // K2 payload shape preserved end to end.
  for (const c of calls) {
    assert.deepEqual(Object.keys(c), ["path"])
    assert.equal(typeof c.path.id, "string")
  }
})

// ===========================================================================
// v0.4.9: GPT prompt-cache option serialization is transport-aware.
//
// The OpenAI/Azure AI SDK providers accept camelCase options and serialize them
// to snake_case wire fields. The OpenRouter AI SDK provider spreads
// providerOptions verbatim into the request body, so it must receive the
// snake_case wire names directly. Verified by capturing the serialized body
// with the installed versions (@openrouter/ai-sdk-provider@2.9.0,
// @ai-sdk/openai@3.0.88, @ai-sdk/azure@3.0.93, ai@6.0.168).
// ===========================================================================

test("v0.4.9: gptCacheOptionFieldNames maps OpenRouter to snake_case and OpenAI/Azure to camelCase", () => {
  assert.deepEqual(gptCacheOptionFieldNames({ providerID: "openai", npm: "@ai-sdk/openai" }), {
    key: "promptCacheKey",
    options: "promptCacheOptions",
  })
  assert.deepEqual(gptCacheOptionFieldNames({ providerID: "azure", npm: "@ai-sdk/azure" }), {
    key: "promptCacheKey",
    options: "promptCacheOptions",
  })
  assert.deepEqual(gptCacheOptionFieldNames({ providerID: "openrouter", npm: "@openrouter/ai-sdk-provider" }), {
    key: "prompt_cache_key",
    options: "prompt_cache_options",
  })
  // providerID alone is sufficient (OpenRouter routing)
  assert.deepEqual(gptCacheOptionFieldNames({ providerID: "openrouter" }), {
    key: "prompt_cache_key",
    options: "prompt_cache_options",
  })
})

test("v0.4.9: gptCacheOptionsDelta honours transport field names and preserves existing values", () => {
  const orFields = gptCacheOptionFieldNames({ providerID: "openrouter" })
  const d = gptCacheOptionsDelta({}, { key: "ce-root", fieldNames: orFields })
  assert.equal(d.prompt_cache_key, "ce-root")
  assert.equal(d.promptCacheKey, undefined)
  assert.deepEqual(d.prompt_cache_options, { mode: "implicit", ttl: "30m" })
  assert.equal(d.promptCacheOptions, undefined)

  // Existing snake_case values are preserved (never overwritten).
  assert.deepEqual(
    gptCacheOptionsDelta(
      { prompt_cache_key: "existing", prompt_cache_options: { mode: "explicit", ttl: "1h" } },
      { key: "new", fieldNames: orFields },
    ),
    {},
  )

  // Default remains camelCase for the OpenAI/Azure SDKs.
  const dflt = gptCacheOptionsDelta({}, { key: "ce-root" })
  assert.equal(dflt.promptCacheKey, "ce-root")
  assert.deepEqual(dflt.promptCacheOptions, { mode: "implicit", ttl: "30m" })
  assert.equal(dflt.prompt_cache_key, undefined)
})

test("v0.4.9 REGRESSION: OpenRouter GPT gets snake_case fields; OpenAI keeps camelCase", async () => {
  const { results } = await policyMigrationResults()
  const byName = (n) => results.find((r) => r.name === n)

  // Direct OpenAI: camelCase plugin options (the SDK serializes to snake_case).
  for (const name of ["gpt-5.6", "gpt-6-astra", "gpt-7-future-openai"]) {
    const r = byName(name)
    assert.equal(typeof r.gptKeyCamel, "string", `${name}: camelCase key expected`)
    assert.equal(r.gptKeySnake, null, `${name}: must not set snake_case`)
    assert.deepEqual(r.gptOptionsCamel, { mode: "implicit", ttl: "30m" }, `${name}: camelCase options`)
    assert.equal(r.gptOptionsSnake, null, `${name}: must not set snake_case options`)
  }

  // OpenRouter: snake_case wire fields (the adapter forwards them verbatim).
  for (const name of ["gpt-5.6-openrouter", "gpt-6-openrouter"]) {
    const r = byName(name)
    assert.equal(typeof r.gptKeySnake, "string", `${name}: snake_case key expected`)
    assert.equal(r.gptKeyCamel, null, `${name}: must not set camelCase`)
    assert.deepEqual(r.gptOptionsSnake, { mode: "implicit", ttl: "30m" }, `${name}: snake_case options`)
    assert.equal(r.gptOptionsCamel, null, `${name}: must not set camelCase options`)
  }

  // Key derivation is unchanged: default cacheRootKey=false keys on the session.
  assert.equal(byName("gpt-5.6").gptKeyCamel, "ses_gpt-5.6")
  assert.equal(byName("gpt-5.6-openrouter").gptKeySnake, "ses_gpt-5.6-openrouter")
})

// ===========================================================================
// v0.4.11: GPT prompt-cache key ownership and isolation.
//
// OpenCode pre-sets promptCacheKey = sessionID for direct OpenAI/Azure (its
// provider `options()`), but not for OpenRouter. CacheEngine must:
//   - preserve an existing key on ordinary live requests under the default
//     (cacheRootKey disabled);
//   - own the key when cache-root affinity is enabled; and
//   - apply the compaction-isolation namespace even when a key already exists,
//     otherwise a compaction request shares the live-session GPT cache.
// ===========================================================================

async function runGptKeyProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-gptkey-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/gptkey.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const mkClient = (parents) => ({
      app: { log: async () => ({}) },
      session: { get: async (o) => ({ data: { parentID: parents[o?.path?.id] ?? null } }) },
      tool: { list: async () => ({ data: [] }) },
    })
    const run = async (hooks, { sid, agent, providerID, modelID, npm, pre }) => {
      const out = { options: { ...(pre ?? {}) } }
      await hooks["chat.params"]({
        sessionID: sid, agent,
        model: { providerID, id: modelID, api: { id: modelID, npm } },
        provider: { source: "config", info: { id: providerID }, options: {} },
        message: { id: "m-"+sid+"-"+agent, sessionID: sid, role: "user", content: "x" },
      }, out)
      return out.options
    }
    const hooksDefault = await CacheEngine({ client: mkClient({}), directory: process.env.HOME })
    const OA = { providerID: "openai", modelID: "gpt-5.6", npm: "@ai-sdk/openai" }
    const OR = { providerID: "openrouter", modelID: "openai/gpt-5.6-sol", npm: "@openrouter/ai-sdk-provider" }
    const result = {
      liveNoKey: await run(hooksDefault, { sid: "ses_A", agent: "build", ...OA }),
      liveExisting: await run(hooksDefault, { sid: "ses_A", agent: "build", ...OA, pre: { promptCacheKey: "opencode-sid" } }),
      liveUserKey: await run(hooksDefault, { sid: "ses_A", agent: "build", ...OA, pre: { promptCacheKey: "user-key" } }),
      compExisting: await run(hooksDefault, { sid: "ses_A", agent: "compaction", ...OA, pre: { promptCacheKey: "ses_A" } }),
      compNoKey: await run(hooksDefault, { sid: "ses_A", agent: "compaction", ...OA }),
      liveRepeat: await run(hooksDefault, { sid: "ses_A", agent: "build", ...OA }),
      otherSession: await run(hooksDefault, { sid: "ses_B", agent: "build", ...OA }),
      orLive: await run(hooksDefault, { sid: "ses_A", agent: "build", ...OR }),
      orComp: await run(hooksDefault, { sid: "ses_A", agent: "compaction", ...OR }),
    }
    mkdirSync(process.env.HOME + "/.config/opencode", { recursive: true })
    writeFileSync(process.env.HOME + "/.config/opencode/cache-engine.json", JSON.stringify({ policies: { gpt56: { cacheRootKey: true } } }))
    const hooksRoot = await CacheEngine({ client: mkClient({ ses_child: "ses_parent" }), directory: process.env.HOME })
    result.rootLive = await run(hooksRoot, { sid: "ses_child", agent: "build", ...OA })
    result.rootComp = await run(hooksRoot, { sid: "ses_child", agent: "compaction", ...OA })
    process.stdout.write(JSON.stringify(result))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let gptKeyProbe
const gptKeyResults = async () => (gptKeyProbe ??= runGptKeyProbe())

test("v0.4.11: live requests preserve an existing GPT key under the default config", async () => {
  const r = await gptKeyResults()
  assert.equal(r.liveNoKey.promptCacheKey, "ses_A") // no key -> session-derived
  assert.equal(r.liveExisting.promptCacheKey, "opencode-sid") // OpenCode key preserved
  assert.equal(r.liveUserKey.promptCacheKey, "user-key") // user key preserved
  assert.deepEqual(r.liveNoKey.promptCacheOptions, { mode: "implicit", ttl: "30m" })
})

test("v0.4.11 REGRESSION: compaction isolation overrides an existing live key", async () => {
  const r = await gptKeyResults()
  // OpenCode pre-set the live-session key; the compaction request must not share it.
  assert.equal(r.compExisting.promptCacheKey, "ses_A:compact")
  assert.equal(r.compNoKey.promptCacheKey, "ses_A:compact")
  // OpenRouter (no pre-set key) already isolates; keep it working.
  assert.equal(r.orComp.prompt_cache_key, "ses_A:compact")
})

test("v0.4.11: keys are stable per session and distinct across sessions", async () => {
  const r = await gptKeyResults()
  assert.equal(r.liveRepeat.promptCacheKey, r.liveNoKey.promptCacheKey) // repeated request
  assert.equal(r.otherSession.promptCacheKey, "ses_B")
  assert.notEqual(r.otherSession.promptCacheKey, r.liveNoKey.promptCacheKey)
})

test("v0.4.11: cache-root mode uses the root key; disabled mode ignores the root", async () => {
  const r = await gptKeyResults()
  // Default (cacheRootKey false): a child session keys on its own session id.
  assert.equal(r.liveNoKey.promptCacheKey, "ses_A")
  // Enabled: the descendant keys on the resolved root, with its own compact namespace.
  assert.equal(r.rootLive.promptCacheKey, "ses_parent")
  assert.equal(r.rootComp.promptCacheKey, "ses_parent:compact")
})

test("v0.4.11: transport field names are respected for live and compaction keys", async () => {
  const r = await gptKeyResults()
  assert.equal(r.liveNoKey.promptCacheKey, "ses_A")
  assert.equal(r.liveNoKey.prompt_cache_key, undefined)
  assert.equal(r.orLive.prompt_cache_key, "ses_A")
  assert.equal(r.orLive.promptCacheKey, undefined)
})

// ===========================================================================
// v0.4.12: hooks follow the LIVE model across a mid-session family/provider
// switch. A latched family must never authorize a mutation for a different live
// model, and transport field names must follow the live provider.
// ===========================================================================

async function runModelSwitchProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-switch-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/switch.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const fake = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }) },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME })
    const GLM = { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" } }
    const MIMO = { providerID: "xiaomi", id: "mimo-v2.6-flash", api: { id: "mimo-v2.6-flash" } }
    const GPT = { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" } }
    const ORGPT = { providerID: "openrouter", id: "openai/gpt-5.6-sol", api: { id: "openai/gpt-5.6-sol", npm: "@openrouter/ai-sdk-provider" } }
    const SYS = ["A: keep1", "You are powered by the model named X. The exact model ID is test/X", "Here is some useful information about the environment you are running in:", "<env>", "Today's date: 2026-08-17", "</env>", "B: keep2"].join("\\n")
    const step = async (sid, model) => {
      const provider = { source: "config", info: { id: model.providerID }, options: {} }
      const params = { options: {} }
      await hooks["chat.params"]({ sessionID: sid, agent: "build", model, provider, message: { id: "m", sessionID: sid, role: "user", content: "x" } }, params)
      const sys = { system: [SYS] }
      await hooks["experimental.chat.system.transform"]({ sessionID: sid, model, provider }, sys)
      const headers = { headers: {} }
      await hooks["chat.headers"]({ sessionID: sid, agent: "build", model, provider, message: { id: "m", sessionID: sid, role: "user", content: "x" } }, headers)
      return {
        gptKeyCamel: params.options.promptCacheKey ?? null,
        gptKeySnake: params.options.prompt_cache_key ?? null,
        gptOptsCamel: params.options.promptCacheOptions ?? null,
        gptOptsSnake: params.options.prompt_cache_options ?? null,
        relocated: sys.system[0] !== SYS,
        affinity: headers.headers["x-session-id"] ?? null,
      }
    }
    const sequences = {
      glm_then_gpt: ["ses_glm_gpt", [GLM, GPT]],
      gpt_then_glm: ["ses_gpt_glm", [GPT, GLM]],
      mimo_then_gpt: ["ses_mimo_gpt", [MIMO, GPT]],
      gpt_then_mimo: ["ses_gpt_mimo", [GPT, MIMO]],
      oa_then_or: ["ses_oa_or", [GPT, ORGPT]],
      or_then_oa: ["ses_or_oa", [ORGPT, GPT]],
      gpt_twice: ["ses_gpt_twice", [GPT, GPT]],
      glm_twice: ["ses_glm_twice", [GLM, GLM]],
    }
    const out = {}
    for (const [name, [sid, models]] of Object.entries(sequences)) {
      out[name] = []
      for (const m of models) out[name].push(await step(sid, m))
    }
    const telemetry = readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse)
    process.stdout.write(JSON.stringify({ out, telemetry }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let switchProbe
const switchResults = async () => (switchProbe ??= runModelSwitchProbe())

test("v0.4.12 REGRESSION: GLM→GPT crosses families safely", async () => {
  const { out } = await switchResults()
  const [glm, gpt] = out.glm_then_gpt
  assert.equal(gpt.gptKeyCamel, "ses_glm_gpt") // GPT gets its cache metadata
  assert.deepEqual(gpt.gptOptsCamel, { mode: "implicit", ttl: "30m" })
  assert.equal(gpt.gptKeySnake, null)
  assert.equal(gpt.relocated, false) // GPT system text is not rewritten by GLM policy
  assert.equal(glm.relocated, true) // GLM (first) relocates
  assert.equal(glm.gptKeyCamel, null) // GLM never gets GPT cache options
})

test("v0.4.12 REGRESSION: GPT→GLM crosses families safely", async () => {
  const { out } = await switchResults()
  const [gpt, glm] = out.gpt_then_glm
  assert.equal(gpt.gptKeyCamel, "ses_gpt_glm")
  assert.equal(gpt.relocated, false)
  assert.equal(glm.relocated, true) // GLM relocation follows the LIVE model
  assert.equal(glm.gptKeyCamel, null) // no GPT injection into GLM
  assert.equal(glm.gptKeySnake, null)
})

test("v0.4.12 REGRESSION: MiMo↔GPT crosses families safely", async () => {
  const { out } = await switchResults()
  const [mimo, gpt] = out.mimo_then_gpt
  assert.equal(gpt.gptKeyCamel, "ses_mimo_gpt")
  assert.equal(gpt.relocated, false)
  assert.equal(mimo.relocated, true)
  assert.equal(mimo.gptKeyCamel, null)

  const [gpt2, mimo2] = out.gpt_then_mimo
  assert.equal(gpt2.gptKeyCamel, "ses_gpt_mimo")
  assert.equal(mimo2.relocated, true)
  assert.equal(mimo2.gptKeyCamel, null)
})

test("v0.4.12 REGRESSION: GPT transport follows the live provider (OpenAI ↔ OpenRouter)", async () => {
  const { out } = await switchResults()
  const [, orGpt] = out.oa_then_or
  assert.equal(orGpt.gptKeySnake, "ses_oa_or")
  assert.equal(orGpt.gptKeyCamel, null)

  const [, oaGpt] = out.or_then_oa
  assert.equal(oaGpt.gptKeyCamel, "ses_or_oa")
  assert.equal(oaGpt.gptKeySnake, null)
})

test("v0.4.12: direct OpenAI never receives OpenRouter-only affinity headers", async () => {
  const { out } = await switchResults()
  assert.equal(out.glm_then_gpt[1].affinity, null)
  assert.equal(out.oa_then_or[0].affinity, null)
  assert.equal(out.or_then_oa[1].affinity, null)
  // OpenRouter GPT is not an affinity family either (GPT is not GLM/MiMo).
  assert.equal(out.oa_then_or[1].affinity, null)
})

test("v0.4.12: provider-change telemetry reflects the live family, not a stale one", async () => {
  const { telemetry } = await switchResults()
  // No cross-family transition should emit a GLM/MiMo provider-change event for
  // a GPT request (the live model is GPT, and no two same-family observations).
  const providerChanges = telemetry.filter((r) => r.reason === "glm_provider_changed" || r.reason === "mimo_provider_changed")
  assert.equal(providerChanges.length, 0)
  // policy-resolution reflects the live family for both steps.
  const families = new Set(telemetry.filter((r) => r.kind === "policy-resolution").map((r) => r.family))
  assert.ok(families.has("gpt-5.6"))
  assert.ok(families.has("glm-5.3"))
  assert.ok(families.has("mimo-v2.6"))
})

test("v0.4.12: same-model repeated requests are unchanged", async () => {
  const { out } = await switchResults()
  assert.deepEqual(out.gpt_twice[0], out.gpt_twice[1])
  assert.deepEqual(out.glm_twice[0], out.glm_twice[1])
  assert.equal(out.gpt_twice[0].relocated, false)
  assert.equal(out.glm_twice[0].relocated, true)
})

// ===========================================================================
// v0.4.12: low-severity findings F3 (session-state retention), F4 (compaction
// error telemetry), F5 (OpenRouter provider-ID normalization).
// ===========================================================================

async function runLowSeverityProbe() {
  const home = mkdtempSync(join(tmpdir(), "ce-lowsev-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/lowsev.jsonl"
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const fake = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }), messages: async () => ({ data: [] }) },
      tool: { list: async () => ({ data: [] }) },
    }
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME })
    const tick = () => new Promise((r) => setTimeout(r, 30))
    const GPT = { providerID: "openai", id: "gpt-5.6", api: { id: "gpt-5.6", npm: "@ai-sdk/openai" } }
    const GLM = { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" } }
    const prov = (id) => ({ source: "config", info: { id }, options: {} })
    const doParams = async (sid, model) => {
      const o = { options: {} }
      await hooks["chat.params"]({ sessionID: sid, agent: "build", model, provider: prov(model.providerID), message: { id: "m", sessionID: sid, role: "user", content: "x" } }, o)
      return o
    }
    const doHeaders = async (providerID) => {
      const model = { providerID, id: "glm-5.3", api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" } }
      const sid = "ses_h_" + providerID
      const o = { headers: {} }
      await hooks["chat.headers"]({ sessionID: sid, agent: "build", model, provider: prov(providerID), message: { id: "m", sessionID: sid, role: "user", content: "x" } }, o)
      return o.headers["x-session-id"] ?? null
    }

    // F3: state exists, is dropped on session.deleted, and is recreated.
    await doParams("ses_f3", GPT)
    await doParams("ses_f3", GPT)
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_f3" } } } })
    await doParams("ses_f3", GPT)

    // F3 active-safety: idle/compacted must NOT evict; state is retained.
    await doParams("ses_f3b", GPT)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_f3b" } } })
    await tick()
    await doParams("ses_f3b", GPT)

    // F4: compaction succeeds normally, and a forced failure is recorded once.
    const okOut = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "ses_f4_ok" }, okOut)
    let threw = false
    try { await hooks["experimental.session.compacting"]({ sessionID: "ses_f4_bad" }, {}) } catch { threw = true }

    // F5: provider-ID normalization for the OpenRouter affinity gate.
    const affinity = {}
    for (const p of ["openrouter", " OpenRouter ", "OpenRouter", "openai", "zai"]) affinity[p] = await doHeaders(p)

    await tick()
    const records = readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse)
    process.stdout.write(JSON.stringify({
      cacheOptionsF3: records.filter((r) => r.kind === "cache-options" && r.sid === "ses_f3").length,
      cacheOptionsF3b: records.filter((r) => r.kind === "cache-options" && r.sid === "ses_f3b").length,
      compactContext: okOut.context.length,
      compactThrew: threw,
      telemetryErrors: records.filter((r) => r.kind === "telemetry-error").map((r) => r.error),
      affinity,
      affinityProviders: records.filter((r) => r.kind === "boundary" && String(r.reason).startsWith("openrouter_affinity")).map((r) => r.provider),
    }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let lowSevProbe
const lowSevResults = async () => (lowSevProbe ??= runLowSeverityProbe())

test("v0.4.12 F3: session state is dropped on session.deleted and recreated", async () => {
  const { cacheOptionsF3, cacheOptionsF3b } = await lowSevResults()
  // First request emits cache-options once; the repeat is suppressed. After the
  // session is deleted, a new request recreates fresh state and re-emits.
  assert.equal(cacheOptionsF3, 2)
  // Active safety: idle does not evict, so the repeat stays suppressed.
  assert.equal(cacheOptionsF3b, 1)
})

test("v0.4.12 F4: compaction records one error without changing output or throwing", async () => {
  const { compactContext, compactThrew, telemetryErrors } = await lowSevResults()
  assert.equal(compactContext, 1) // normal compaction still injects the digest
  assert.equal(compactThrew, false) // the failure is contained
  assert.equal(telemetryErrors.length, 1) // exactly one bounded error record
  assert.match(String(telemetryErrors[0]), /undefined|Cannot read/i)
})

test("v0.4.12 F5: OpenRouter affinity normalizes the provider ID, direct providers isolated", async () => {
  const { affinity, affinityProviders } = await lowSevResults()
  assert.ok(affinity["openrouter"], "canonical openrouter gets the header")
  assert.ok(affinity[" OpenRouter "], "whitespace/case variant gets the header")
  assert.ok(affinity["OpenRouter"], "case variant gets the header")
  assert.equal(affinity["openai"], null)
  assert.equal(affinity["zai"], null)
  // Telemetry reports the normalized provider identity.
  assert.equal(affinityProviders.filter((p) => p === "openrouter").length, 3)
  assert.ok(affinityProviders.includes("openai"))
  assert.ok(affinityProviders.includes("zai"))
})

// ===========================================================================
// v0.4.13: N1 usage-collection concurrency, N2 OpenRouter option telemetry,
// N5 telemetry attribution (per-message identity, key strategy, per-model tool
// TTL). N3 is a pure field-name normalization covered by a direct unit test.
// ===========================================================================

async function runN1N5Probe() {
  const home = mkdtempSync(join(tmpdir(), "ce-n1n5-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/n1n5.jsonl"
    mkdirSync(process.env.HOME + "/.config/opencode", { recursive: true })
    // Enable GPT cache-root keys so the N5 key-strategy telemetry is observable.
    writeFileSync(process.env.HOME + "/.config/opencode/cache-engine.json", JSON.stringify({ policies: { gpt56: { cacheRootKey: true } } }))
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)})
    const responses = {}
    const toollistQueries = []
    let n1Calls = 0
    let releaseN1
    const n1Gate = new Promise((r) => { releaseN1 = r })
    const fake = {
      app: { log: async () => ({}) },
      session: {
        get: async () => ({ data: { parentID: null } }),
        messages: async (opts) => {
          const id = opts && opts.path && opts.path.id
          const r = responses[id]
          if (typeof r === "function") return await r()
          return r || { data: [] }
        },
      },
      tool: {
        list: async (opts) => {
          const m = opts && opts.query && opts.query.model
          toollistQueries.push(m)
          const n = String(m).indexOf("alt") >= 0 ? 2 : 1
          const data = []
          for (let i = 0; i < n; i++) data.push({ id: String(m) + "-" + i })
          return { data }
        },
      },
    }
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME })
    const tick = () => new Promise((r) => setTimeout(r, 30))
    const mkAst = (id, read, write, input, providerID, modelID) => ({
      info: { id, role: "assistant", providerID, modelID, tokens: { input, output: 1, cache: { read, write } }, time: { created: Date.now() } },
      parts: [],
    })
    const setModel = async (sid, providerID, modelID) => {
      const o = { options: {} }
      await hooks["chat.params"]({
        sessionID: sid, agent: "build",
        model: { providerID, id: modelID, api: { id: modelID } },
        provider: { source: "config", info: { id: providerID }, options: {} },
        message: { id: "u-" + sid, sessionID: sid, role: "user", content: "x" },
      }, o)
      return o
    }
    const idle = (sid) => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })

    // N1: first messages call is gated; a second idle arrives before it resolves.
    responses["ses_n1"] = () => {
      n1Calls += 1
      const page = { data: [mkAst("n1a", 100, 20, 5)] }
      return n1Calls === 1 ? n1Gate.then(() => page) : page
    }
    await setModel("ses_n1", "deepseek", "deepseek-flash")
    await idle("ses_n1")
    await idle("ses_n1")
    releaseN1()
    await tick()

    // N2: OpenRouter GPT cache-options telemetry must carry the injected options.
    await setModel("ses_n2", "openrouter", "openai/gpt-5.6-sol")

    // N5.1: assistant message identity differs from the latched session model.
    responses["ses_attr"] = { data: [mkAst("at1", 100, 0, 10, "openai", "gpt-5.6")] }
    await setModel("ses_attr", "deepseek", "deepseek-flash")
    await idle("ses_attr")

    // N5.2: GPT usage key strategy must reflect the enabled cache-root mode.
    responses["ses_key"] = { data: [mkAst("k1", 100, 0, 10, "openai", "gpt-5.6")] }
    await setModel("ses_key", "openai", "gpt-5.6")
    await idle("ses_key")

    // N5.3: a second model within the TTL window must trigger its own fetch.
    const transform = (sid, model) => hooks["experimental.chat.system.transform"](
      { sessionID: sid, model, provider: { source: "config", info: { id: model.providerID }, options: {} } },
      { system: ["base system"] },
    )
    await transform("ses_tools", { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3" } })
    await transform("ses_tools", { providerID: "zai", id: "glm-5.3-alt", api: { id: "glm-5.3-alt" } })
    // Repeat the FIRST identity within its own window: it must be suppressed
    // independently (not merely because it was the most recently seen identity).
    await transform("ses_tools", { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3" } })

    // N1 recovery: a failed collection must not block later collections.
    let recCalls = 0
    responses["ses_rec"] = () => {
      recCalls += 1
      if (recCalls === 1) throw new Error("boom-rec")
      return { data: [mkAst("r1", 100, 20, 5)] }
    }
    await setModel("ses_rec", "deepseek", "deepseek-flash")
    await idle("ses_rec")
    await idle("ses_rec")
    await tick()

    // N4: a late idle after session.deleted must not resurrect per-session state.
    responses["ses_del"] = { data: [mkAst("d1", 100, 20, 5)] }
    await setModel("ses_del", "deepseek", "deepseek-flash")
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_del" } } } })
    await idle("ses_del")
    await tick()

    // N4 in-flight: a QUEUED collection (idle2 behind a slow idle1) must not
    // resurrect state after delete, even when tombstones are flooded past the
    // cap. The captured object flag (not the bounded set) is what protects it.
    let delCalls = 0
    let releaseDel
    const delGate = new Promise((r) => { releaseDel = r })
    responses["ses_del2"] = () => {
      delCalls += 1
      if (delCalls === 1) return delGate.then(() => ({ data: [mkAst("d2", 100, 20, 5)] }))
      return { data: [mkAst("d2", 100, 20, 5), mkAst("d3", 50, 10, 5)] }
    }
    await setModel("ses_del2", "deepseek", "deepseek-flash")
    await idle("ses_del2")
    await idle("ses_del2")
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_del2" } } } })
    for (let i = 0; i < 9000; i++) {
      await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_flood_" + i } } } })
    }
    releaseDel()
    await tick()

    const readRecords = () => readFileSync(process.env.CACHE_ENGINE_METRICS_FILE, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l))
    const usage = (recs, sid) => recs.filter((r) => r.kind === "usage" && r.sid === sid)
    let records = readRecords()
    const n1 = usage(records, "ses_n1")
    const n4AfterDelete = usage(records, "ses_del").length
    const n4InFlight = usage(records, "ses_del2").length
    const n1Recovery = usage(records, "ses_rec").length
    const n1RecoveryErrors = records.filter((r) => r.kind === "telemetry-error" && String(r.error).indexOf("boom-rec") >= 0).length

    // A genuine new request for the same id clears the tombstone (legit reuse).
    await setModel("ses_del", "deepseek", "deepseek-flash")
    await idle("ses_del")
    await tick()
    records = readRecords()
    const n4AfterRecreate = usage(records, "ses_del").length

    process.stdout.write(JSON.stringify({
      n1UsageCount: n1.length,
      n1Cumulative: n1[0] ? n1[0].cumulative : null,
      n2Options: (records.find((r) => r.kind === "cache-options" && r.sid === "ses_n2") || {}).options || null,
      attr: usage(records, "ses_attr")[0] || null,
      keyStrategy: (usage(records, "ses_key")[0] || {}).keyStrategy || null,
      toollistQueries,
      toolsToolCounts: records
        .filter((r) => r.sid === "ses_tools" && (r.kind === "prefix-observation" || r.kind === "prefix-change"))
        .map((r) => r.toolCount),
      n4AfterDelete,
      n4AfterRecreate,
      n4InFlight,
      n1Recovery,
      n1RecoveryErrors,
    }))
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let n1n5Probe
const n1n5Results = async () => (n1n5Probe ??= runN1N5Probe())

test("v0.4.13 N3: provider-id normalization selects snake_case fields for OpenRouter", () => {
  const SNAKE = { key: "prompt_cache_key", options: "prompt_cache_options" }
  const CAMEL = { key: "promptCacheKey", options: "promptCacheOptions" }
  for (const p of ["openrouter", "OpenRouter", " OpenRouter ", String.fromCharCode(9) + "OPENROUTER "]) {
    assert.deepEqual(gptCacheOptionFieldNames({ providerID: p }), SNAKE, "openrouter variant: " + p)
  }
  for (const p of ["openai", "azure", "zai", "xiaomi"]) {
    assert.deepEqual(gptCacheOptionFieldNames({ providerID: p }), CAMEL, "direct provider: " + p)
  }
  assert.deepEqual(gptCacheOptionFieldNames({ npm: "@openrouter/ai-sdk-provider" }), SNAKE)
  assert.deepEqual(gptCacheOptionFieldNames({}), CAMEL)
})

test("v0.4.13 N5: scanPage reports the newest counted assistant identity", () => {
  const page = [
    { info: { id: "a1", role: "assistant", providerID: "openai", modelID: "gpt-5.6", tokens: { input: 1, output: 1, cache: { read: 10, write: 0 } } }, parts: [] },
    { info: { id: "a2", role: "assistant", providerID: "xiaomi", modelID: "mimo-v2.6-flash", tokens: { input: 1, output: 1, cache: { read: 20, write: 0 } } }, parts: [] },
  ]
  const scan = scanPage(page, null)
  assert.equal(scan.providerID, "xiaomi")
  assert.equal(scan.modelID, "mimo-v2.6-flash")
})

test("v0.4.13 N1: concurrent idle collections count each message once", async () => {
  const { n1UsageCount, n1Cumulative } = await n1n5Results()
  assert.equal(n1UsageCount, 1)
  assert.deepEqual(n1Cumulative, { read: 100, write: 20 })
})

test("v0.4.13 N2: OpenRouter cache-options telemetry reports the injected options", async () => {
  const { n2Options } = await n1n5Results()
  assert.deepEqual(n2Options, { mode: "implicit", ttl: "30m" })
})

test("v0.4.13 N5: usage is attributed to the message identity, not the latched model", async () => {
  const { attr } = await n1n5Results()
  assert.ok(attr, "a usage record is emitted")
  assert.equal(attr.provider, "openai")
  assert.equal(attr.model, "gpt-5.6")
})

test("v0.4.13 N5: usage key strategy follows cache-root mode", async () => {
  const { keyStrategy } = await n1n5Results()
  assert.equal(keyStrategy, "cache-root")
})

test("v0.4.13 N5: tool fetch TTL is enforced independently per provider+model", async () => {
  const { toollistQueries, toolsToolCounts } = await n1n5Results()
  // A, B, then A again: A's own window is still open, so the second A is
  // suppressed without relying on A being the most-recent identity.
  assert.deepEqual(toollistQueries, ["glm-5.3", "glm-5.3-alt"])
  // The suppressed repeat must also RESTORE A's fingerprints (1 tool), not
  // leave B's (2 tools) in the per-session slot.
  assert.deepEqual(toolsToolCounts, [1, 2, 1])
})

test("v0.4.13 N4: a late idle after session.deleted does not resurrect state", async () => {
  const { n4AfterDelete, n4AfterRecreate } = await n1n5Results()
  assert.equal(n4AfterDelete, 0) // stale background work cannot recreate deleted state
  assert.equal(n4AfterRecreate, 1) // a genuine new request still creates state
})

test("v0.4.13 N4: a queued collection cannot resurrect a deleted session after tombstone eviction", async () => {
  const { n4InFlight } = await n1n5Results()
  // The in-flight collection (started before delete) counts its message once;
  // the queued follow-up is skipped via the captured object flag, not the set.
  assert.equal(n4InFlight, 1)
})

test("v0.4.13 N1: a failed collection does not block later collections", async () => {
  const { n1Recovery, n1RecoveryErrors } = await n1n5Results()
  assert.equal(n1RecoveryErrors, 1) // the failure is recorded
  assert.equal(n1Recovery, 1) // the next idle still collects and emits
})

// ===========================================================================
// v0.5.0 Kimi passivity + config isolation (real hook path, no model calls)
//
// The Kimi policy is passive, so a supported Kimi request must be byte-for-byte
// unchanged, pre-existing options/headers preserved, and the family config
// switch must not leak into other families.
// ===========================================================================

async function runKimiPassiveProbe(configPolicies) {
  const home = mkdtempSync(join(tmpdir(), "ce-kimi-passive-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/kimi-passive.jsonl"
    const cfgPolicy = ${JSON.stringify(configPolicies ?? null)};
    if (cfgPolicy) {
      mkdirSync(process.env.HOME + "/.config/opencode", { recursive: true });
      writeFileSync(process.env.HOME + "/.config/opencode/cache-engine.json", JSON.stringify({ policies: cfgPolicy }));
    }
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)});
    const fake = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }), messages: async () => ({ data: [] }) },
      tool: { list: async () => ({ data: [] }) },
    };
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME });
    const SYS = ["A", "You are powered by the model named kimi-k3. The exact model ID is moonshot/kimi-k3", "<env>", "Today date: 2026-10-04", "</env>", "Z"].join("\\n");
    const run = async (sid, model, opts0, hdrs0) => {
      const paramsOut = { options: { ...opts0 } };
      const sysOut = { system: [SYS] };
      const headersOut = { headers: { ...hdrs0 } };
      const provider = { source: "config", info: { id: model.providerID }, options: {} };
      const message = { id: "m", sessionID: sid, role: "user", content: "x" };
      await hooks["chat.params"]({ sessionID: sid, agent: "build", model, provider, message }, paramsOut);
      await hooks["experimental.chat.system.transform"]({ sessionID: sid, model, provider }, sysOut);
      await hooks["chat.headers"]({ sessionID: sid, agent: "build", model, provider, message }, headersOut);
      return { options: paramsOut.options, systemChanged: sysOut.system[0] !== SYS, headers: headersOut.headers };
    };
    const kimi = { providerID: "moonshot", id: "kimi-k3", api: { id: "kimi-k3", npm: "@ai-sdk/openai-compatible" } };
    const kimiOR = { providerID: "openrouter", id: "moonshotai/kimi-k3", api: { id: "moonshotai/kimi-k3", npm: "@openrouter/ai-sdk-provider" } };
    const look = { providerID: "acme", id: "acme/kimi-k9", api: { id: "acme/kimi-k9" } };
    const glm = { providerID: "zai", id: "glm-5.3", api: { id: "glm-5.3", npm: "@ai-sdk/openai-compatible" } };
    const claude = { providerID: "anthropic", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" } };
    const claudeOR = { providerID: "openrouter", id: "anthropic/claude-opus-4-8", api: { id: "anthropic/claude-opus-4-8", npm: "@openrouter/ai-sdk-provider" } };
    const claudeLook = { providerID: "acme", id: "acme/claude-opus-clone", api: { id: "acme/claude-opus-clone" } };
    const preOpts = { promptCacheKey: "user-key", promptCacheOptions: { mode: "implicit", ttl: "5m" }, cache_control: { type: "ephemeral" }, temperature: 0.3 };
    const preHdrs = { "x-session-id": "user-sess", "x-custom": "keep" };
    const out = {
      direct: await run("ses_kimi_passive_direct", kimi, preOpts, preHdrs),
      openrouter: await run("ses_kimi_passive_or", kimiOR, {}, {}),
      lookalike: await run("ses_kimi_passive_look", look, {}, {}),
      glm: await run("ses_kimi_passive_glm", glm, {}, {}),
      claude: await run("ses_claude_passive", claude, preOpts, preHdrs),
      claudeOR: await run("ses_claude_passive_or", claudeOR, {}, {}),
      claudeLook: await run("ses_claude_passive_look", claudeLook, {}, {}),
      preOpts,
      preHdrs,
    };
    process.stdout.write(JSON.stringify(out));
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let kimiPassiveProbe
const kimiPassiveResults = async () => (kimiPassiveProbe ??= runKimiPassiveProbe(null))

test("v0.5.0: a supported Kimi request is passive and preserves existing options/headers", async () => {
  const out = await kimiPassiveResults()
  // No Kimi-specific mutation: existing options (incl. a user cache key and a
  // foreign `cache_control`) are preserved byte-for-byte.
  assert.deepEqual(out.direct.options, out.preOpts)
  // No `<env>` relocation for Kimi.
  assert.equal(out.direct.systemChanged, false)
  // Pre-existing headers (incl. x-session-id) are preserved untouched.
  assert.deepEqual(out.direct.headers, out.preHdrs)
  // OpenRouter Kimi still receives no affinity header.
  assert.deepEqual(out.openrouter.headers, {})
  assert.equal(out.openrouter.systemChanged, false)
})

test("v0.5.0: a Kimi look-alike under an unrelated provider is neutral and unchanged", async () => {
  const out = await kimiPassiveResults()
  assert.deepEqual(out.lookalike.options, {})
  assert.equal(out.lookalike.systemChanged, false)
  assert.deepEqual(out.lookalike.headers, {})
})

test("v0.5.0: disabling the Kimi policy does not change passivity or leak into other families", async () => {
  const out = await runKimiPassiveProbe({ kimi: { enabled: false } })
  // Kimi stays passive whether enabled or disabled (no Kimi-specific effects).
  assert.deepEqual(out.direct.options, out.preOpts)
  assert.equal(out.direct.systemChanged, false)
  assert.deepEqual(out.direct.headers, out.preHdrs)
  // The Kimi switch must not disable another family: GLM still relocates.
  assert.equal(out.glm.systemChanged, true)
})

test("v0.5.2: a supported Claude request is passive and preserves existing options/headers", async () => {
  const out = await kimiPassiveResults()
  // No Claude-specific mutation: existing options (incl. a user cache key and a
  // foreign cache_control) and headers are preserved byte-for-byte.
  assert.deepEqual(out.claude.options, out.preOpts)
  assert.equal(out.claude.systemChanged, false)
  assert.deepEqual(out.claude.headers, out.preHdrs)
  // OpenRouter Claude also receives no affinity header and no mutation.
  assert.deepEqual(out.claudeOR.options, {})
  assert.deepEqual(out.claudeOR.headers, {})
  assert.equal(out.claudeOR.systemChanged, false)
})

test("v0.5.2: a Claude look-alike under an unrelated provider is neutral and unchanged", async () => {
  const out = await kimiPassiveResults()
  assert.deepEqual(out.claudeLook.options, {})
  assert.equal(out.claudeLook.systemChanged, false)
  assert.deepEqual(out.claudeLook.headers, {})
})

test("v0.5.2: disabling the Claude policy does not change passivity or leak into other families", async () => {
  const out = await runKimiPassiveProbe({ claude: { enabled: false } })
  assert.deepEqual(out.claude.options, out.preOpts)
  assert.equal(out.claude.systemChanged, false)
  assert.deepEqual(out.claude.headers, out.preHdrs)
  // The Claude switch must not disable other families: GLM still relocates and
  // Kimi stays passive.
  assert.equal(out.glm.systemChanged, true)
  assert.deepEqual(out.direct.options, out.preOpts)
})

// ===========================================================================
// v0.5.2 route-support audit: CacheEngine must be passive for Claude on EVERY
// access route (direct Anthropic, OpenCode Zen/Go, OpenRouter, Bedrock, Vertex,
// OpenAI-compatible gateways). It injects no `cache_control`/`cacheControl` and
// no affinity header on any of them — OpenCode owns Anthropic caching.
// ===========================================================================

async function runClaudeRouteProbe(configPolicies) {
  const home = mkdtempSync(join(tmpdir(), "ce-claude-routes-"))
  const pluginURL = new URL("../src/cache-engine.ts", import.meta.url).href
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs"
    process.env.CACHE_ENGINE_METRICS_FILE = process.env.HOME + "/claude-routes.jsonl"
    const cfgPolicy = ${JSON.stringify(configPolicies ?? null)};
    if (cfgPolicy) {
      mkdirSync(process.env.HOME + "/.config/opencode", { recursive: true });
      writeFileSync(process.env.HOME + "/.config/opencode/cache-engine.json", JSON.stringify({ policies: cfgPolicy }));
    }
    const { CacheEngine } = await import(${JSON.stringify(pluginURL)});
    const fake = {
      app: { log: async () => ({}) },
      session: { get: async () => ({ data: { parentID: null } }), messages: async () => ({ data: [] }) },
      tool: { list: async () => ({ data: [] }) },
    };
    const hooks = await CacheEngine({ client: fake, directory: process.env.HOME });
    const SYS = ["A", "You are powered by the model named claude-sonnet-4-5", "<env>", "Today date: 2026-10-04", "</env>", "Z"].join("\\n");
    const routes = {
      direct: { providerID: "anthropic", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" } },
      zen: { providerID: "opencode", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" } },
      go: { providerID: "opencode-go", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/anthropic" } },
      openrouter: { providerID: "openrouter", id: "anthropic/claude-opus-4-8", api: { id: "anthropic/claude-opus-4-8", npm: "@openrouter/ai-sdk-provider" } },
      bedrock: { providerID: "amazon-bedrock", id: "anthropic.claude-3-5-sonnet-20241022-v2:0", api: { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", npm: "@ai-sdk/amazon-bedrock" } },
      vertex: { providerID: "google-vertex-anthropic", id: "claude-sonnet-4-5@20250929", api: { id: "claude-sonnet-4-5@20250929", npm: "@ai-sdk/google-vertex/anthropic" } },
      openaiCompat: { providerID: "some-gateway", id: "claude-sonnet-4-5", api: { id: "claude-sonnet-4-5", npm: "@ai-sdk/openai-compatible" } },
      lookalike: { providerID: "acme", id: "acme/claude-opus-clone", api: { id: "acme/claude-opus-clone" } },
      geminiGoogle: { providerID: "google", id: "gemini-2.5-pro", api: { id: "gemini-2.5-pro", npm: "@ai-sdk/google" } },
      geminiVertex: { providerID: "google-vertex", id: "gemini-2.5-flash", api: { id: "gemini-2.5-flash", npm: "@ai-sdk/google-vertex" } },
      geminiOpenrouter: { providerID: "openrouter", id: "google/gemini-2.5-pro", api: { id: "google/gemini-2.5-pro", npm: "@openrouter/ai-sdk-provider" } },
      gemma: { providerID: "google", id: "gemma-4-31b-it", api: { id: "gemma-4-31b-it", npm: "@ai-sdk/google" } },
    };
    const preOpts = { promptCacheKey: "user-key", cache_control: { type: "ephemeral" }, temperature: 0.3 };
    const preHdrs = { "x-session-id": "user-sess", "x-custom": "keep" };
    const out = {};
    for (const [name, model] of Object.entries(routes)) {
      const paramsOut = { options: { ...preOpts } };
      const sysOut = { system: [SYS] };
      const headersOut = { headers: { ...preHdrs } };
      const provider = { source: "config", info: { id: model.providerID }, options: {} };
      const sid = "ses_route_" + name;
      const message = { id: "m", sessionID: sid, role: "user", content: "x" };
      await hooks["chat.params"]({ sessionID: sid, agent: "build", model, provider, message }, paramsOut);
      await hooks["experimental.chat.system.transform"]({ sessionID: sid, model, provider }, sysOut);
      await hooks["chat.headers"]({ sessionID: sid, agent: "build", model, provider, message }, headersOut);
      out[name] = {
        options: paramsOut.options,
        systemChanged: sysOut.system[0] !== SYS,
        headers: headersOut.headers,
        addedCacheKeys: Object.keys(paramsOut.options).filter((k) => !(k in preOpts) && /cache/i.test(k)),
      };
    }
    out.preOpts = preOpts;
    out.preHdrs = preHdrs;
    process.stdout.write(JSON.stringify(out));
  `
  const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  })
  return JSON.parse(stdout.trim())
}

let claudeRouteProbe
const claudeRouteResults = async () => (claudeRouteProbe ??= runClaudeRouteProbe(null))

test("v0.5.2: CacheEngine is passive for Claude on every access route", async () => {
  const out = await claudeRouteResults()
  for (const name of ["direct", "zen", "go", "openrouter", "bedrock", "vertex", "openaiCompat", "lookalike"]) {
    assert.deepEqual(out[name].options, out.preOpts, `${name}: options must be preserved`)
    assert.equal(out[name].systemChanged, false, `${name}: system must be unchanged`)
    assert.deepEqual(out[name].headers, out.preHdrs, `${name}: headers must be preserved`)
    assert.deepEqual(out[name].addedCacheKeys, [], `${name}: must add no cache-control field`)
  }
})

test("v0.5.2: disabling Claude leaves every route request unchanged", async () => {
  const out = await runClaudeRouteProbe({ claude: { enabled: false } })
  for (const name of ["direct", "zen", "go", "openrouter", "bedrock", "vertex", "openaiCompat"]) {
    assert.deepEqual(out[name].options, out.preOpts, `${name}: options preserved`)
    assert.equal(out[name].systemChanged, false, `${name}: no relocation`)
    assert.deepEqual(out[name].headers, out.preHdrs, `${name}: headers preserved`)
  }
})

test("v0.5.3: CacheEngine is passive for Gemini on every access route", async () => {
  const out = await claudeRouteResults()
  for (const name of ["geminiGoogle", "geminiVertex", "geminiOpenrouter", "gemma"]) {
    assert.deepEqual(out[name].options, out.preOpts, `${name}: options must be preserved`)
    assert.equal(out[name].systemChanged, false, `${name}: system must be unchanged`)
    assert.deepEqual(out[name].headers, out.preHdrs, `${name}: headers must be preserved`)
    assert.deepEqual(out[name].addedCacheKeys, [], `${name}: must add no cache-control field`)
  }
})

test("v0.5.3: OpenRouter Gemini is classified but left unmutated (no overlay, no affinity)", async () => {
  // Decision record: OpenRouter documents a Gemini-specific cache-control
  // contract, but CacheEngine does not implement it (see RF-OR-003). Gemini
  // carries no transport capability and the OpenRouter request is byte-preserved,
  // including no x-session-id affinity header.
  const caps = resolveRuntimePolicy(M("openrouter", "google/gemini-2.5-pro"))
  assert.equal(caps.policy, "gemini")
  assert.equal(caps.openRouterAffinity, false)
  assert.equal(caps.gptCacheMetadata, false)
  assert.equal(caps.envRelocation, null)
  const out = await claudeRouteResults()
  const or = out.geminiOpenrouter
  assert.deepEqual(or.options, out.preOpts, "OpenRouter Gemini options preserved")
  assert.equal(or.systemChanged, false, "OpenRouter Gemini system unchanged")
  assert.deepEqual(or.headers, out.preHdrs, "OpenRouter Gemini adds no affinity header")
  assert.deepEqual(or.addedCacheKeys, [], "OpenRouter Gemini adds no cache-control field")
})

test("v0.5.4: the probed OpenRouter Gemini endpoint stays classified-but-passive", () => {
  // Boundary established by the live probe RF-OR-004 (2026-10-05):
  // google/gemini-2.5-flash-lite:flex classifies as the gemini family, and
  // CacheEngine injects neither a cache_control breakpoint nor an affinity header.
  const model = M("openrouter", "google/gemini-2.5-flash-lite:flex")
  const caps = resolveRuntimePolicy(model)
  assert.equal(caps.policy, "gemini")
  assert.equal(caps.isNeutral, false)
  assert.equal(caps.openRouterAffinity, false)
  assert.equal(caps.gptCacheMetadata, false)
  assert.equal(caps.envRelocation, null)
  assert.equal(caps.cacheRatio, null)
  const ex = explainPolicyResolution(model)
  assert.equal(ex.family, "gemini")
  assert.equal(ex.overlayApplied, false)
  assert.deepEqual(ex.overlays, [])
  assert.equal(ex.transportKind, "openrouter")
})
