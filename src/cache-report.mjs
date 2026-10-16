#!/usr/bin/env node
// Phase 7 (P7-T4) — thin CLI over the pure report core.
//
// Reads the CacheEngine telemetry JSONL (the file `createRecorder` appends to)
// and prints the compact report. Read-only: it never initializes the plugin,
// registers a hook, writes telemetry, or touches the request path.
//
// Usage:
//   node src/cache-report.mjs [--file <path>]
// Path resolution: `--file`, else `CACHE_ENGINE_METRICS_FILE`, else the default
// `~/.cache/opencode/cache-metrics.jsonl`.
//
// Exit codes: 0 = ok; 2 = usage error or unreadable metrics file.
//
// This module is a standalone consumer of the telemetry store. Nothing in
// `./server`, `./v2`, or `./tui` imports it (see the `phase7/p7t4:` isolation
// test); the plugin runtime never calls it.

import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DEFAULT_METRICS_FILE, expandHome } from "./cache-engine-core.mjs"
import { parseReportInput, renderReport } from "./cache-report-core.mjs"

export { DEFAULT_METRICS_FILE }

const HELP = `Usage: node src/cache-report.mjs [--file <path>]

Render a compact CacheEngine observability report from the telemetry JSONL.

  --file <path>   metrics file (default: $CACHE_ENGINE_METRICS_FILE, else
                  ${DEFAULT_METRICS_FILE})
  -h, --help      show this help

Exit codes: 0 ok; 2 usage error or unreadable file.
`

// Pure argument parsing. Returns { help:true } | { error } | { file }.
export function parseCliArgs(argv) {
  let file = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") return { help: true }
    if (a === "--file") {
      const v = argv[++i]
      if (!v) return { error: "--file requires a path" }
      file = v
      continue
    }
    if (a.startsWith("--file=")) {
      const v = a.slice("--file=".length)
      if (!v) return { error: "--file requires a path" }
      file = v
      continue
    }
    return { error: `unknown argument: ${a}` }
  }
  return { file }
}

// Pure path resolution: explicit > env > default. `~` is expanded exactly as the
// plugin does for `CACHE_ENGINE_METRICS_FILE` (cache-engine-core `expandHome`),
// so the report reads the same file the recorder writes.
export function resolveMetricsPath(file, env = process.env) {
  if (typeof file === "string" && file.length > 0) return expandHome(file)
  const e = env?.CACHE_ENGINE_METRICS_FILE
  return expandHome(typeof e === "string" && e.length > 0 ? e : DEFAULT_METRICS_FILE)
}

// Run the CLI. Returns the exit code; writes to `out`/`err` (injectable for
// tests). Never throws on usage or I/O errors.
export function run(argv, env = process.env, out = process.stdout, err = process.stderr) {
  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    out.write(HELP)
    return 0
  }
  if (parsed.error) {
    err.write(`cache-report: ${parsed.error}\n`)
    return 2
  }
  const path = resolveMetricsPath(parsed.file, env)
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    err.write(`cache-report: cannot read metrics file: ${path} (${e?.code ?? "error"})\n`)
    return 2
  }
  const { records, skipped } = parseReportInput(text)
  out.write(renderReport(records))
  if (skipped > 0) err.write(`cache-report: skipped ${skipped} unparseable line(s)\n`)
  return 0
}

// Symlink-safe entry detection. `import.meta.url` is the *realpath* of this
// module while `process.argv[1]` keeps the path as given, so compare real paths
// — a symlinked invocation (`npm link`, a `~/bin` symlink, pnpm's symlinked
// `node_modules`) would otherwise silently print nothing and exit 0.
function invokedDirectly(argv1) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

// `process.exitCode` (not `process.exit`) so a piped stdout is flushed first.
if (invokedDirectly(process.argv[1])) process.exitCode = run(process.argv.slice(2))
