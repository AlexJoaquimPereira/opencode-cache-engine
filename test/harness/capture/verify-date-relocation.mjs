// Offline WIRE verifier for the Phase 2 date-line relocation (task P2-T3).
//
// Compares the SERIALIZED system content captured from two offline harness runs
// of the SAME model: a baseline (transform off) and a candidate (`stabilizeDate`
// on). It asserts on the WIRE — not on hook or adapter output — that the single
// standalone daily date line moved from BEFORE the <env> block to AFTER it, that
// the date value is unchanged, and (order-sensitively) that the content with the
// date line removed is identical between the two, i.e. the only change is the
// relocation (plus at most the one documented separator newline).
//
// The harness writes each run under a fresh `capture.XXXXXX` temp root, so the env
// block's cwd path differs between runs; both systems are normalized by replacing
// that temp-root segment before comparison (the report labels comparisons as
// "after temp-root normalization").
//
// Deliberately does NOT import the transform helper: this is an independent wire
// check, so it cannot pass merely because it shares the implementation's logic.
//
// Exit: 0 as expected; 1 wire mismatch; 2 blocker (missing/invalid input).
//
// Usage:
//   node verify-date-relocation.mjs <offCaptureDir> <onCaptureDir>
//   node verify-date-relocation.mjs <offDir> <onDir> --unchanged   (control)
//
// A capture dir may be either the harness capture root (containing
// `capture/req-*.json`) or the `capture` directory itself.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const DATE_STR = "Today's date:"
const DATE_LINE = /^Today's date:/
const isEnvOpen = (l) => l.trim() === "<env>"
const isEnvClose = (l) => l.trim() === "</env>"

export const normalizeCaptureRoot = (s) =>
  typeof s === "string" ? s.replace(/capture\.[A-Za-z0-9]+/g, "capture.RUN") : s

// Remove the date line's CHARACTERS (leaving its newline) — the exact bytes the
// transform moves. Two texts processed this way then differ only by the optional
// separator newline.
const stripDateBlock = (s) => {
  const L = s.split("\n")
  const idx = L.findIndex((l) => DATE_LINE.test(l))
  return idx < 0 ? s : L.slice(0, idx).concat([""]).concat(L.slice(idx + 1)).join("\n")
}

// True when a and b are equal, or differ by at most one optional "\n" (the one
// separator newline the relocation may insert).
const differsByAtMostOneNewline = (a, b) => {
  let p = 0
  while (p < Math.min(a.length, b.length) && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const am = a.slice(p, a.length - s)
  const bm = b.slice(p, b.length - s)
  return am.replace(/\n/g, "") === "" && bm.replace(/\n/g, "") === "" && am.length + bm.length <= 1
}

// The primary agent request is the one with the largest role=system content.
// Returns { file, text } so the compared request is attributable.
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
    if (s && (best === null || s.length > best.text.length)) best = { file: f, text: s }
  }
  if (best === null) throw new Error(`no serialized system content found in ${base}`)
  return best
}

export function verifyDateRelocation(offRaw, onRaw, options = {}) {
  const offText = normalizeCaptureRoot(typeof offRaw === "string" ? offRaw : offRaw.text)
  const onText = normalizeCaptureRoot(typeof onRaw === "string" ? onRaw : onRaw.text)
  const offL = offText.split("\n")
  const onL = onText.split("\n")
  const offDateIdx = offL.findIndex((l) => DATE_LINE.test(l))
  const onDateIdx = onL.findIndex((l) => DATE_LINE.test(l))
  const offEnvOpenIdx = offL.findIndex(isEnvOpen)
  const offEnvCloseIdx = offL.findIndex(isEnvClose)
  const onEnvOpenIdx = onL.findIndex(isEnvOpen)
  const onEnvCloseIdx = onL.findIndex(isEnvClose)

  const checks = {
    offDateCount: offL.filter((l) => DATE_LINE.test(l)).length,
    onDateCount: onL.filter((l) => DATE_LINE.test(l)).length,
    singleEnvPair:
      offL.filter(isEnvOpen).length === 1 && offL.filter(isEnvClose).length === 1 &&
      onL.filter(isEnvOpen).length === 1 && onL.filter(isEnvClose).length === 1,
    offDateBeforeEnv: offDateIdx >= 0 && offEnvOpenIdx >= 0 && offDateIdx < offEnvOpenIdx,
    onDateAfterEnv: onDateIdx >= 0 && onEnvCloseIdx >= 0 && onDateIdx > onEnvCloseIdx,
    dateValueSame: offDateIdx >= 0 && onDateIdx >= 0 && offL[offDateIdx] === onL[onDateIdx],
    // Order-sensitive: with ONLY the date line's bytes removed, the two texts are
    // identical apart from at most the one optional separator newline.
    sameWithoutDateBlock: differsByAtMostOneNewline(stripDateBlock(offText), stripDateBlock(onText)),
    unchanged: offText === onText,
  }
  const relocationOk =
    checks.offDateCount === 1 &&
    checks.onDateCount === 1 &&
    checks.singleEnvPair === true &&
    checks.offDateBeforeEnv === true &&
    checks.onDateAfterEnv === true &&
    checks.dateValueSame === true &&
    checks.sameWithoutDateBlock === true
  const ok = options.expectUnchanged ? checks.unchanged : relocationOk
  return {
    ok,
    mode: options.expectUnchanged ? "unchanged" : "relocate",
    offFile: options.offFile ?? null,
    onFile: options.onFile ?? null,
    offLength: offText.length,
    onLength: onText.length,
    offDateOffset: offText.indexOf(DATE_STR),
    onDateOffset: onText.indexOf(DATE_STR),
    offEnvOffset: [offText.indexOf("<env>"), offText.indexOf("</env>")],
    onEnvOffset: [onText.indexOf("<env>"), onText.indexOf("</env>")],
    checks,
  }
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
    const off = primarySystem(offDir)
    const on = primarySystem(onDir)
    report = verifyDateRelocation(off.text, on.text, { offFile: off.file, onFile: on.file, expectUnchanged })
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
