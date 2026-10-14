// Loopback mock provider for the Phase 1 capture harness.
//
// It listens on 127.0.0.1 only, records each request's method/url/redacted
// headers and JSON body to CAPTURE_DIR (one req-NNN.json per request), and
// replies with a minimal OpenAI-compatible response (SSE when the request asks
// for streaming). It never contacts a real provider. Authorization header
// VALUES are never recorded — only their presence.

import http from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PORT = Number(process.env.MOCK_PORT || 39420)
const OUT = process.env.CAPTURE_DIR
if (!OUT) {
  console.error("CAPTURE_DIR is required")
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

let seq = 0

// Record only non-sensitive header metadata. Never the authorization value.
function redactHeaders(headers) {
  const keep = ["content-type", "accept", "x-session-id", "x-stainless-lang"]
  const out = {}
  for (const k of keep) if (headers[k] !== undefined) out[k] = headers[k]
  out["authorization-present"] = headers["authorization"] !== undefined
  return out
}

function parse(body) {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function sse(res, model) {
  const base = { id: "mock-1", object: "chat.completion.chunk", created: 1, model }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`)
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    })}\n\n`,
  )
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    seq += 1
    const parsed = parse(body)
    const record = {
      seq,
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers),
      body: parsed,
    }
    writeFileSync(join(OUT, `req-${String(seq).padStart(3, "0")}.json`), JSON.stringify(record, null, 2))

    if (!/^\/v1\/chat\/completions$/.test(req.url ?? "")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `mock: unsupported path ${req.url}`, type: "invalid_request_error" } }))
      return
    }
    if (parsed && parsed.stream === true) {
      sse(res, parsed.model ?? "synthetic")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: `mock-${seq}`,
        object: "chat.completion",
        created: 1,
        model: parsed?.model ?? "synthetic",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    )
  })
})

server.listen(PORT, "127.0.0.1", () => console.error(`mock provider listening on 127.0.0.1:${PORT}`))
