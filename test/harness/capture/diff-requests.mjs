// Structural first-difference reporter for two captured provider requests.
//
// This is the offline analysis half of the Phase 1 capture harness. It compares
// two captured request bodies section by section (in cache-prefix order), reports
// the first differing section and the first differing byte offset of the
// canonicalized (key-sorted) body, and classifies the difference as expected or unexpected using
// explicit criteria:
//
//   expected   — every differing section is one of `expectedChangingSections`
//                (default: the conversation `messages` / `input`), or the two
//                requests are identical.
//   unexpected — any of the structural cache-prefix sections differs (route,
//                system/instructions, tools, cache options/keys).
//
// Read-only and pure. It never mutates its inputs.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Sections compared first, in cache-prefix order. Anything else is appended.
const SECTION_ORDER = [
  "model",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "input",
  "messages",
  "prompt_cache_key",
  "promptCacheKey",
  "prompt_cache_options",
  "promptCacheOptions",
  "options",
]

function stable(v) {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === "object") {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k])
    return out
  }
  return v
}

export function canonical(v) {
  try {
    const s = JSON.stringify(stable(v))
    // JSON.stringify(undefined) is undefined; normalize so hashing is total.
    return s === undefined ? "undefined" : s
  } catch {
    return String(v)
  }
}

const sha = (v) => createHash("sha256").update(canonical(v)).digest("hex").slice(0, 16)

function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export function diffRequests(prev, cur, options = {}) {
  const p = prev && typeof prev === "object" ? prev : {}
  const c = cur && typeof cur === "object" ? cur : {}
  const expectedChanging = new Set(options.expectedChangingSections ?? ["messages", "input"])
  const ignore = new Set(options.ignoreSections ?? ["stream", "stream_options"])

  const keys = [...new Set([...Object.keys(p), ...Object.keys(c)])].filter((k) => !ignore.has(k))
  const ordered = [
    ...SECTION_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !SECTION_ORDER.includes(k)),
  ]
  const changedSections = ordered.filter((k) => sha(p[k]) !== sha(c[k]))
  const firstDiffSection = changedSections.length > 0 ? changedSections[0] : null

  // The byte offset and lengths are measured on the canonical (key-sorted)
  // serialization used for comparison, NOT on the raw wire bytes.
  const before = canonical(p)
  const after = canonical(c)
  const firstDiffCanonicalByte = before === after ? -1 : commonPrefix(before, after)

  const expected = changedSections.length === 0 || changedSections.every((k) => expectedChanging.has(k))
  return {
    equal: changedSections.length === 0,
    changedSections,
    firstDiffSection,
    firstDiffCanonicalByte,
    beforeLength: before.length,
    afterLength: after.length,
    expected,
  }
}

// Load and validate captured requests (req-NNN.json) from a capture directory.
// Throws a clear Error on an unreadable directory, invalid JSON, or a record
// without a request body; malformed requests are never silently skipped.
export function loadCapture(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch (e) {
    throw new Error(`cannot read capture directory ${dir}: ${e.code ?? e.message}`)
  }
  const files = names.filter((f) => /^req-\d+\.json$/.test(f)).sort()
  return files.map((f) => {
    let raw
    try {
      raw = readFileSync(join(dir, f), "utf8")
    } catch (e) {
      throw new Error(`cannot read ${f}: ${e.code ?? e.message}`)
    }
    let rec
    try {
      rec = JSON.parse(raw)
    } catch {
      throw new Error(`invalid JSON in ${f}`)
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(`malformed record in ${f}`)
    }
    if (!rec.body || typeof rec.body !== "object" || Array.isArray(rec.body)) {
      throw new Error(`missing request body in ${f}`)
    }
    return rec
  })
}

// A request "kind" is its structural shape minus the conversation payload:
// distinct code paths (agent loop vs title/summary) have different key sets.
function kindOf(body) {
  const volatile = new Set(["messages", "input", "stream", "stream_options", "options"])
  return Object.keys(body || {})
    .filter((k) => !volatile.has(k))
    .sort()
    .join(",")
}

// Pair each captured request with the previous request of the SAME kind, so
// equivalent requests (e.g. run A's agent-loop request vs run B's) are compared
// rather than a primary request against an auxiliary one. CLI-friendly.
export function diffCapture(dir) {
  const reqs = loadCapture(dir)
  const byKind = new Map()
  const pairs = []
  for (let i = 0; i < reqs.length; i++) {
    const kind = kindOf(reqs[i].body)
    const seen = byKind.get(kind) ?? []
    if (seen.length > 0) {
      const prev = seen[seen.length - 1]
      pairs.push({ kind, pair: [prev, i], ...diffRequests(reqs[prev].body, reqs[i].body) })
    }
    seen.push(i)
    byKind.set(kind, seen)
  }
  return { count: reqs.length, pairs }
}

// CLI. Exit 0 (identical or expected-only), 1 (unexpected structural
// difference), 2 (invalid or insufficient input).
function runCli(argv) {
  const dir = argv[2]
  if (!dir) {
    console.error("usage: node diff-requests.mjs <captureDir>")
    return 2
  }
  let stat
  try {
    stat = statSync(dir)
  } catch {
    console.error(`error: capture directory not found: ${dir}`)
    return 2
  }
  if (!stat.isDirectory()) {
    console.error(`error: not a directory: ${dir}`)
    return 2
  }
  let report
  try {
    report = diffCapture(dir)
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`)
    return 2
  }
  if (report.pairs.length === 0) {
    console.error(`error: no comparable request pairs in ${dir} (need >=2 same-kind captures)`)
    return 2
  }
  console.log(JSON.stringify(report, null, 2))
  return report.pairs.some((p) => !p.expected) ? 1 : 0
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(runCli(process.argv))
}
