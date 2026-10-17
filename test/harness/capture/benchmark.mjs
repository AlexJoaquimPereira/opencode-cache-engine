// Phase 8 (P8-T2/P8-T3) — benchmark envelope writer.
//
// Assembles a machine-readable `benchmark.json` for a capture root so a third
// party can compare the *structural* result and see the conditions it was
// obtained under. Read-only over the capture; it never contacts a provider.
//
// Usage:
//   node benchmark.mjs <captureRoot>
//
// The envelope records versions (G1), the injected engine config (G2), the
// workload, per-turn rc + duration (G3), request-kind counts (G8) and a
// repetition summary (G5). `evidence.conclusionClass` is always `structural`:
// the offline harness cannot produce a provider-measured result, and
// `providerMetrics` / `wireVerification` are labelled accordingly (G4/G7).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { diffCapture, kindOf, loadCapture } from "./diff-requests.mjs"

// --- pure helpers -----------------------------------------------------------

// Parse the `status` file into per-turn records. Lines:
//   runN_rc=<int>  runN_ms=<int>  turn_failed=1  turnN_failed=true
export function parseStatus(text) {
  const byN = new Map()
  const entry = (n) => {
    if (!byN.has(n)) byN.set(n, { n })
    return byN.get(n)
  }
  let turnFailed = false
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim()
    let m
    if ((m = /^run(\d+)_rc=(-?\d+)$/.exec(line))) {
      entry(Number(m[1])).rc = Number(m[2])
      continue
    }
    if ((m = /^run(\d+)_ms=(\d+)$/.exec(line))) {
      entry(Number(m[1])).durationMs = Number(m[2])
      continue
    }
    if (line === "turn_failed=1") turnFailed = true
  }
  const turns = [...byN.values()].sort((a, b) => a.n - b.n)
  return { turns, turnFailed }
}

// Total captured requests + a per-kind census.
export function summarizeRequests(captureDir) {
  const reqs = loadCapture(captureDir)
  const kinds = {}
  for (const r of reqs) {
    const k = kindOf(r.body)
    kinds[k] = (kinds[k] ?? 0) + 1
  }
  return { total: reqs.length, kinds }
}

// Per-kind repetition summary from a diff report (identical / expected / unexpected).
export function summarizeRepetitions(diffReport) {
  const byKind = new Map()
  for (const p of diffReport?.pairs ?? []) {
    const e = byKind.get(p.kind) ?? { kind: p.kind, pairs: 0, identical: 0, expected: 0, unexpected: 0 }
    e.pairs += 1
    if (p.equal) e.identical += 1
    if (p.expected) e.expected += 1
    else e.unexpected += 1
    byKind.set(p.kind, e)
  }
  return [...byKind.values()]
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function readTextIfPresent(path) {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return ""
  }
}

// Assemble the envelope. `extra` supplies host-side values the capture root
// cannot know (plugin identity, the injected workload).
export function buildBenchmark(root, extra = {}) {
  const status = parseStatus(readTextIfPresent(join(root, "status")))
  const opencodeVersion = readTextIfPresent(join(root, "opencode-version.txt"))
  const engineConfig = readJsonIfPresent(join(root, "home", ".config", "opencode", "cache-engine.json"))
  const project = readJsonIfPresent(join(root, "proj", ".opencode", "opencode.json"))
  const model = typeof project?.model === "string" ? project.model : null
  const provider = model && model.includes("/") ? model.split("/")[0] : null

  const captureDir = join(root, "capture")
  let requests = { total: 0, kinds: {} }
  let diff = { pairs: 0, expected: 0, unexpected: 0, verdict: "no-captures" }
  let repetitions = []
  if (existsSync(captureDir)) {
    try {
      requests = summarizeRequests(captureDir)
      const report = diffCapture(captureDir)
      const expected = report.pairs.filter((p) => p.expected).length
      const unexpected = report.pairs.length - expected
      diff = {
        pairs: report.pairs.length,
        expected,
        unexpected,
        verdict: report.pairs.length === 0 ? "no-pairs" : unexpected > 0 ? "unexpected" : "expected",
      }
      repetitions = summarizeRepetitions(report)
    } catch (e) {
      diff = { pairs: 0, expected: 0, unexpected: 0, verdict: "error", error: String(e?.message ?? e) }
    }
  }

  return {
    schema: 1,
    plugin: extra.plugin ?? null,
    opencode: { version: opencodeVersion || null },
    model,
    provider,
    engineConfig,
    workload: extra.workload ?? {},
    turns: status.turns,
    turnFailed: status.turnFailed,
    requests,
    diff,
    repetitions,
    evidence: {
      conclusionClass: "structural",
      providerMetrics: "unavailable",
      wireVerification: "not_observed",
    },
  }
}

// --- CLI --------------------------------------------------------------------

function pluginIdentity(repoRoot) {
  const pkg = readJsonIfPresent(join(repoRoot, "package.json"))
  return pkg ? { name: pkg.name ?? null, version: pkg.version ?? null } : null
}

function runCli(argv, env = process.env) {
  const root = argv[2]
  if (!root) {
    console.error("usage: node benchmark.mjs <captureRoot>")
    return 2
  }
  if (!existsSync(root)) {
    console.error(`error: capture root not found: ${root}`)
    return 2
  }
  const repoRoot = new URL("../../..", import.meta.url).pathname
  const prompt = typeof env.OC_CAPTURE_PROMPT === "string" ? env.OC_CAPTURE_PROMPT : ""
  const workload = {
    turns: Number(env.OC_CAPTURE_TURNS ?? 0) || null,
    continue: env.OC_CAPTURE_CONTINUE === "1",
    promptBytes: prompt.length,
    mockPort: Number(env.MOCK_PORT ?? 0) || null,
  }
  let envelope
  try {
    envelope = buildBenchmark(root, { plugin: pluginIdentity(repoRoot), workload })
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`)
    return 1
  }
  try {
    writeFileSync(join(root, "benchmark.json"), JSON.stringify(envelope, null, 2) + "\n")
  } catch (e) {
    console.error(`error: cannot write benchmark.json: ${e?.code ?? e}`)
    return 1
  }
  return 0
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(runCli(process.argv))
