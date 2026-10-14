// Offline WIRE verifier for the Phase 2 date-line relocation (task P2-T3).
//
// It compares the SERIALIZED system content captured from two offline harness
// runs of the SAME model: a baseline (transform off) and a candidate
// (`stabilizeDate` on). It asserts on the WIRE — not on hook or adapter output —
// that the single standalone daily date line moved from BEFORE the <env> block to
// AFTER it, that the date value and the non-date content are preserved, and that
// the byte length changed by at most the one documented separator newline.
//
// The harness writes each run under a fresh `capture.XXXXXX` temp root, so the
// env block's cwd path differs between runs; both systems are normalized by
// replacing that temp-root segment before comparison.
//
// Deliberately does NOT import the transform helper: this is an independent wire
// check (line-level preservation + exact date value + length delta), so it cannot
// pass merely because it shares the implementation's logic.
//
// Exit: 0 as expected; 1 wire mismatch; 2 blocker (missing/invalid input).
//
// Usage:
//   node verify-date-relocation.mjs <offCaptureDir> <onCaptureDir>
//   node verify-date-relocation.mjs <offDir> <onDir> --unchanged   (control)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const DATE_STR = "Today's date:"
const DATE_LINE = /^Today's date:/

export const normalizeCaptureRoot = (s) =>
  typeof s === "string" ? s.replace(/capture\.[A-Za-z0-9]+/g, "capture.RUN") : s

const nonEmptyLines = (s) => s.split("\n").filter((l) => l.trim() !== "")
const multiset = (s) => nonEmptyLines(s).slice().sort().join("\n")

// The primary agent request is the one with the largest role=system content.
// Accepts either a capture root (containing `capture/req-*.json`) or the
// `capture` directory itself.
export function primarySystem(dir) {
  const base = existsSync(join(dir, "capture")) ? join(dir, "capture") : dir
  let names
  try {
    names = readdirSync(base)
  } catch (e) {
    throw new Error(`cannot read capture directory ${base}: ${e.code ?? e.message}`)
  }
  const files = names.filter((f) => /^req-\d+\.json$/.test(f)).sort()
  let best = null
  for (const f of files) {
    let rec
    try {
      rec = JSON.parse(readFileSync(join(base, f), "utf8"))
    } catch {
      throw new Error(`invalid JSON in ${f}`)
    }
    const b = rec && rec.body
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error(`missing request body in ${f}`)
    const s =
      Array.isArray(b.messages) && b.messages[0] && b.messages[0].role === "system" && typeof b.messages[0].content === "string"
        ? b.messages[0].content
        : typeof b.instructions === "string"
          ? b.instructions
          : null
    if (s && (best === null || s.length > best.length)) best = s
  }
  if (best === null) throw new Error(`no serialized system content found in ${base}`)
  return best
}

export function verifyDateRelocation(offRaw, onRaw, options = {}) {
  const off = normalizeCaptureRoot(offRaw)
  const on = normalizeCaptureRoot(onRaw)
  const offDate = off.split("\n").find((l) => DATE_LINE.test(l)) ?? null
  const onDate = on.split("\n").find((l) => DATE_LINE.test(l)) ?? null
  const checks = {
    offCount: (off.match(/^Today's date:/gm) || []).length,
    onCount: (on.match(/^Today's date:/gm) || []).length,
    offBeforeEnv: off.indexOf(DATE_STR) !== -1 && off.indexOf(DATE_STR) < off.indexOf("<env>"),
    onAfterEnv: on.indexOf(DATE_STR) !== -1 && on.indexOf("</env>") !== -1 && on.indexOf(DATE_STR) > on.indexOf("</env>"),
    dateValueSame: offDate !== null && offDate === onDate,
    multisetSame: multiset(off) === multiset(on),
    lengthDelta: on.length - off.length,
    unchanged: on === off,
  }
  const relocationOk =
    checks.offCount === 1 &&
    checks.onCount === 1 &&
    checks.offBeforeEnv === true &&
    checks.onAfterEnv === true &&
    checks.dateValueSame === true &&
    checks.multisetSame === true &&
    checks.lengthDelta >= 0 &&
    checks.lengthDelta <= 1
  const ok = options.expectUnchanged ? checks.unchanged : relocationOk
  return { ok, mode: options.expectUnchanged ? "unchanged" : "relocate", checks }
}

function runCli(argv) {
  const offDir = argv[2]
  const onDir = argv[3]
  const expectUnchanged = argv.includes("--unchanged")
  if (!offDir || !onDir) {
    console.error("usage: node verify-date-relocation.mjs <offCaptureDir> <onCaptureDir> [--unchanged]")
    return 2
  }
  for (const d of [offDir, onDir]) {
    let st
    try {
      st = statSync(d)
    } catch {
      console.error(`error: capture directory not found: ${d}`)
      return 2
    }
    if (!st.isDirectory()) {
      console.error(`error: not a directory: ${d}`)
      return 2
    }
  }
  let report
  try {
    report = verifyDateRelocation(primarySystem(offDir), primarySystem(onDir), { expectUnchanged })
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`)
    return 2
  }
  console.log(JSON.stringify(report, null, 2))
  return report.ok ? 0 : 1
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(runCli(process.argv))
}
