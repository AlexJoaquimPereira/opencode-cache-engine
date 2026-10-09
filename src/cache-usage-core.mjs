// cache-usage-core.mjs
//
// Runtime-independent, provider-agnostic usage/accounting primitives for the
// cache-engine plugin. Extracted from cache-engine-core.mjs (v0.6.x core
// consolidation) so the same normalized accounting can be reused without pulling
// in the V1 runtime, the plugin hooks, or the provider policy registry.
//
// This module:
//   * has no OpenCode client/runtime dependency (only node:crypto);
//   * never mutates request objects and knows nothing about routing or V2;
//   * never fabricates usage: a cache read is the provider-reported read and a
//     cache write is the provider-reported write. A read never implies a write,
//     and no synthetic zero-write record is produced.
//
// `cache-engine-core.mjs` re-exports these helpers, so the existing public
// surface (used by the V1 entry and the tests) is unchanged.

import { createHash } from "node:crypto"

// Small, stable 16-hex-char digest used for observed-bytes fingerprints and
// reasoning diagnostics. It is a diagnostic primitive only: it never proves a
// provider cache hit or miss.
export function shorthash(s) {
  return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16)
}

// Generic read/(read+write) cache-hit percentage. Returns null when the inputs
// are not finite numbers or the denominator is zero, so no fabricated hit rate
// is ever emitted.
export function hitRatePct(read, write) {
  if (!Number.isFinite(read) || !Number.isFinite(write)) return null
  const denom = read + write
  if (denom <= 0) return null
  return Math.round((100 * read) / denom)
}

// GLM-5.3 hit ratio vs TOTAL prompt tokens: cached / (read + write + input).
// Returns null when the denominator is unknown/zero.
export function glmHitRatio(read, write, input) {
  const denom = read + write + input
  if (denom <= 0 || !Number.isFinite(read)) return null
  return Math.round((100 * read) / denom)
}

// ---------------------------------------------------------------------------
// MiMo-V2.6 cache metrics
//
// MiMo caching is provider-managed (implicit context caching). Xiaomi documents
// usage.prompt_tokens_details.cached_tokens as the number of PROMPT tokens
// served from cache and prompt_tokens as the total prompt-token count, so the
// authoritative cache metric is cachedTokens / promptTokens -- NOT the
// read/(read+write) form used by other families. `hitRatePct` is intentionally
// left untouched so existing providers are unaffected.
//
// The runtime exposes `Message.info.tokens` as { input, output, cache:{read,
// write} } where `input` is the NON-cached prompt input and `cache.read` is the
// cached prompt input. Total prompt tokens are therefore derived as
// read + input (cache.write is a separate accounting bucket and is NOT folded
// in). We never fabricate cache-write values.
// ---------------------------------------------------------------------------

// cachedTokens / promptTokens, rounded to a percentage. Returns null when the
// denominator is unknown/zero or the inputs are not finite numbers, so no
// fabricated hit rate is ever emitted.
export function mimoHitRate(cachedTokens, promptTokens) {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(promptTokens)) return null
  if (promptTokens <= 0 || cachedTokens < 0) return null
  return Math.round((100 * cachedTokens) / promptTokens)
}

// Decide whether a `usage` record should be emitted for an aggregation sample.
// We must not fabricate a zero-valued cache event merely because the session
// became idle: a sample only counts when at least one assistant message with
// cache token data was aggregated.
export function shouldAggregate(count, read, write) {
  return count > 0 && (read > 0 || write > 0)
}

// ---------------------------------------------------------------------------
// Message scanning / cursor
//
// OpenCode V1 (verified empirically against v1.18.34) returns
// `client.session.messages` in CHRONOLOGICAL order: oldest first, newest last
// (`time.created` is non-decreasing across the array).
//
// We track two boundaries:
//   * `lastProcessedMessageID` — the newest message id already processed.
//     Everything AFTER it in the chronological array is unprocessed.
//   * `lastProcessedAt` — the newest `time.created` observed in a prior scan
//     (it can come from a trailing user or token-less message, so it is a
//     conservative upper bound rather than "newest counted"). It is a monotonic
//     floor applied to EVERY scan: a message with a finite `time.created` <= the
//     watermark is never counted, even if a prune/revert reset the id boundary
//     behind it. This is what guarantees historical messages are never
//     recounted; an assistant message that shares the watermark's exact
//     millisecond undercounts rather than double-counts.
//
// This prevents repeated `session.idle` events from double-counting and needs no
// unbounded per-message Set.
// ---------------------------------------------------------------------------

function reasoningHashesFor(m) {
  const parts = m && m.parts
  if (!Array.isArray(parts)) return []
  const hashes = []
  for (const p of parts) {
    if (p && p.type === "reasoning" && typeof p.text === "string" && p.text.length > 0) {
      hashes.push(shorthash(p.text))
    }
  }
  return hashes
}

// page: Array<{ info: { id, role, tokens, time }, parts }>, OLDEST-FIRST.
// startCursor: lastProcessedMessageID or null (first aggregation).
// sinceCreated: monotonic timestamp watermark (ms) — the newest `time.created`
//   observed in a prior scan. Assistant messages with a finite `time.created`
//   <= sinceCreated are treated as already processed on every path, so a prune
//   or revert that resets the id cursor can never recount them.
//
// When the cursor is missing and no watermark is known, nothing is counted: a
// safe undercount is preferred over a double count.
export function scanPage(page, startCursor, sinceCreated = null) {
  const list = Array.isArray(page) ? page : []
  const cursorIndex = startCursor == null ? -1 : list.findIndex((m) => m && m.info && m.info.id === startCursor)
  const found = startCursor == null || cursorIndex >= 0
  let read = 0
  let write = 0
  let input = 0
  let count = 0
  let maxCreated = null
  const reasoning = []
  // Identity of the NEWEST counted assistant message (per-message attribution).
  let providerID = null
  let modelID = null
  for (let i = found ? cursorIndex + 1 : 0; i < list.length; i++) {
    const m = list[i]
    const info = m && m.info
    const id = info && info.id
    if (typeof id !== "string" || id.length === 0) continue
    const created = info && info.time && info.time.created
    if (Number.isFinite(created)) maxCreated = maxCreated == null ? created : Math.max(maxCreated, created)
    if (!found) {
      // Cursor message was pruned/reverted: only count strictly newer messages.
      if (sinceCreated == null || !Number.isFinite(created) || created <= sinceCreated) continue
    } else if (sinceCreated != null && Number.isFinite(created) && created <= sinceCreated) {
      // Cursor located, but this message is at or below the already-counted
      // watermark. A prune/revert can reset the id boundary behind an already
      // counted message; skipping it here means it is never recounted (ties
      // undercount rather than double-count).
      continue
    }
    if (info.role !== "assistant") continue
    const t = info.tokens
    if (t) {
      read += t.cache && Number.isFinite(t.cache.read) ? t.cache.read : 0
      write += t.cache && Number.isFinite(t.cache.write) ? t.cache.write : 0
      input += Number.isFinite(t.input) ? t.input : 0
      count += 1
      if (typeof info.providerID === "string" && info.providerID.length > 0) providerID = info.providerID
      if (typeof info.modelID === "string" && info.modelID.length > 0) modelID = info.modelID
      const rh = reasoningHashesFor(m)
      if (rh.length > 0) reasoning.push({ id, hashes: rh })
    }
  }
  // `reachedStart` reports whether the id boundary was located (or none was set).
  return { read, write, input, count, reachedStart: found, seenIds: [], reasoning, maxCreated, providerID, modelID }
}

// Compute the new `lastProcessedMessageID` after scanning. The page is
// OLDEST-FIRST, so the newest processed message is the LAST element.
export function nextProcessedCursor(page, startCursor) {
  if (!Array.isArray(page) || page.length === 0) return startCursor
  const newest = page[page.length - 1]
  const id = newest && newest.info && newest.info.id
  return typeof id === "string" && id.length > 0 ? id : startCursor
}
