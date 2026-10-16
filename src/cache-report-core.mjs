// Phase 7 (P7-T2/P7-T3) — pure, dependency-light report core.
//
// Reads CacheEngine telemetry JSONL and renders a compact, content-free
// observability report: policy mode · last structural change · first differing
// section · transformation status · wire verification · provider cache usage ·
// accounting limitations · cost estimate.
//
// Contract (P7-T2):
//   parseReportInput(text) -> { records, skipped }
//   renderReport(records)  -> string
//
// Binding invariants:
//   * pure — no filesystem/network/clock/environment/OpenCode access; importing
//     this module has no side effects;
//   * NEVER on the request path — nothing in `./server`, `./v2` or `./tui`
//     imports it (see the `phase7/p7t4:` isolation test);
//   * allow-listed fields only — never prompt/reasoning content, credentials,
//     headers, request bodies, session ids, or arbitrary unknown fields;
//   * a missing metric is *unavailable*, never zero; no ratio without
//     provider-reported data with a non-zero denominator;
//   * estimates are omitted (no assumptions are produced here).
//
// See `docs/phases/phase7-observability.md` (P7-T1 inventory, P7-T2 decision).
// Evidence: `RF-OC-017`–`RF-OC-021`; P5-T1 record catalogue.

const LIMITS = [
  "best-effort, never exactly-once; a missing metric is unavailable, not zero.",
  "ratios are provider-specific and never universalised:",
  "  generic read/(read+write); GLM read/(read+write+input); MiMo cachedTokens/(read+input).",
]

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v) => (typeof v === "string" && v.length > 0 ? v : undefined)

// Parse JSONL tolerantly: blank lines are ignored; malformed or partial lines are
// skipped and counted (never fatal).
export function parseReportInput(text) {
  const out = { records: [], skipped: 0 }
  if (typeof text !== "string") return out
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (t === "") continue
    let rec
    try {
      rec = JSON.parse(t)
    } catch {
      out.skipped += 1
      continue
    }
    if (isObj(rec)) out.records.push(rec)
    else out.skipped += 1
  }
  return out
}

// The newest record matching `pred` by numeric `ts` (ties keep the later entry);
// records without a numeric `ts` sort last.
function newestByTs(records, pred) {
  let best
  let bestTs = -Infinity
  for (const r of records) {
    if (!pred(r)) continue
    const t = num(r.ts) ?? -Infinity
    if (best === undefined || t >= bestTs) {
      best = r
      bestTs = t
    }
  }
  return best
}

function tsLine(r) {
  const t = num(r.ts)
  if (t === undefined) return ""
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? "" : ` @ ${d.toISOString()}`
}

function policySection(records) {
  const pr = newestByTs(records, (r) => r.kind === "policy-resolution")
  if (pr) {
    const name = str(pr.family) ?? str(pr.policy) ?? "unknown"
    const pol = str(pr.policy) && pr.policy !== name ? ` (policy ${pr.policy})` : ""
    return `  ${name}${pol} — last recorded${tsLine(pr)}\n  Source: policy-resolution`
  }
  const withPolicy = newestByTs(records, (r) => str(r.policy) !== undefined)
  if (withPolicy) {
    const kind = str(withPolicy.kind) ?? "telemetry"
    return `  ${str(withPolicy.policy)} — policy recorded on a ${kind} event${tsLine(withPolicy)}\n  Source: ${kind}`
  }
  return "  unavailable — no policy-resolution record"
}

// A "structural change" is a prefix change or an applied hook-object change.
const isChange = (r) =>
  r.kind === "prefix-change" ||
  (r.kind === "cache-options" && (r.keyInjected === true || r.optionsInjected === true)) ||
  r.stage === "applied"

function describeChange(r) {
  if (r.kind === "prefix-change") {
    const f = Array.isArray(r.changedFields) && r.changedFields.length ? ` [${r.changedFields.join(", ")}]` : ""
    return `system prefix changed${f}`
  }
  if (r.kind === "cache-options") return "GPT cache options applied"
  if (str(r.reason)) return `policy applied: ${r.reason}`
  return `${str(r.kind) ?? "change"} applied`
}

function changeSection(records) {
  const c = newestByTs(records, isChange)
  if (!c) return "  unavailable — no structural-change record"
  const reason = str(c.reason) ? ` (${c.reason})` : ""
  return `  ${describeChange(c)}${tsLine(c)}\n  Source: ${str(c.kind) ?? "telemetry"}${reason}`
}

function sectionSection(records) {
  const c = newestByTs(records, (r) => r.kind === "prefix-change")
  if (!c) return "  unavailable — no prefix-change record"
  const parts = []
  if (Array.isArray(c.changedFields) && c.changedFields.length) parts.push(c.changedFields.join(", "))
  else if (Array.isArray(c.dimensions) && c.dimensions.length) parts.push(c.dimensions.join(", "))
  if (Array.isArray(c.reasons) && c.reasons.length) parts.push(`reasons: ${c.reasons.join(", ")}`)
  return parts.length ? `  ${parts.join("  ")}` : "  unavailable — the change carries no field detail"
}

function statusSection(records) {
  const applied = newestByTs(records, (r) => r.stage === "applied")
  if (applied) {
    const flags = []
    if (applied.kind === "cache-options") {
      if (applied.keyInjected === true) flags.push("key injected")
      if (applied.optionsInjected === true) flags.push("options injected")
      if (applied.keyPreserved === true) flags.push("key preserved")
    }
    const extra = flags.length ? ` (${flags.join(", ")})` : ""
    return `  applied${extra} — ${str(applied.kind) ?? "record"}${tsLine(applied)}`
  }
  const decision = newestByTs(records, (r) => r.stage === "decision")
  if (decision) return `  attempt/decision only — ${str(decision.kind) ?? "record"}; no applied change recorded`
  return "  unavailable — no decision or applied record"
}

function wireSection(records) {
  const applied = records.filter((r) => r.stage === "applied")
  // The wire status of the *newest* applied change — like every other section,
  // newest-first (an older positive signal must not outrank a newer one).
  const newest = newestByTs(applied, () => true)
  if (!newest) return "  unknown — no applied change to assess"
  const w = str(newest.wireEffect)
  if (w && w !== "not_observed") return `  ${w}`
  return "  not observed — no evidence the change reached the provider wire (a local/hook change is not wire carriage)"
}

function usageSection(records) {
  const u = newestByTs(records, (r) => r.kind === "usage")
  if (!u) return "  unavailable — no usage record (missing is not zero)"
  const read = num(u.read)
  const write = num(u.write)
  const input = num(u.input)
  if (read === undefined && write === undefined && input === undefined) {
    return "  unavailable — no provider-reported cache data (missing is not zero)"
  }
  const parts = []
  if (read !== undefined) parts.push(`cache_read_tokens=${read}`)
  if (write !== undefined) parts.push(`cache_write_tokens=${write}`)
  if (input !== undefined) parts.push(`input_tokens=${input}`)
  if (read !== undefined && write !== undefined && read + write > 0) {
    parts.push(`observed_cache_read_ratio=${((read / (read + write)) * 100).toFixed(1)}%`)
  }
  if (num(u.glmHitRate) !== undefined) parts.push(`GLM ratio=${u.glmHitRate}%`)
  if (num(u.cacheHitRate) !== undefined) parts.push(`MiMo ratio=${u.cacheHitRate}%`)
  const src = str(u.tokenSource) ? ` (tokenSource=${u.tokenSource})` : ""
  return `  ${parts.join("  ")}\n  Source: usage${src}`
}

// Pure: records (as parsed from JSONL) -> the compact report string.
export function renderReport(records) {
  const list = Array.isArray(records) ? records.filter(isObj) : []
  const out = []
  const section = (title, body) => {
    out.push(title, body, "")
  }
  out.push("OPENCODE CACHE ENGINE — cache report", "")
  section("Policy mode", policySection(list))
  section("Last structural change", changeSection(list))
  section("First differing section", sectionSection(list))
  section("Transformation status", statusSection(list))
  section("Wire verification", wireSection(list))
  section("Provider cache usage", usageSection(list))
  section("Accounting limitations", `  ${LIMITS.join("\n  ")}`)
  section("Estimated cost impact", "  omitted — no explicit assumptions provided")
  return out.join("\n")
}
