#!/usr/bin/env bun
/**
 * Minimal OTLP HTTP/JSON collector.
 *
 * Receives OTLP metrics and logs over HTTP/JSON, writes each batch as
 * a single JSON line to an output file. Use this to capture Claude Code
 * or opencode-otel telemetry without Docker or a full OTEL Collector.
 *
 * Usage:
 *   bun scripts/otel-collector.ts                          # writes to ./telemetry.jsonl
 *   bun scripts/otel-collector.ts -o claude.jsonl           # custom output file
 *   bun scripts/otel-collector.ts -p 4318                   # custom port
 *   bun scripts/otel-collector.ts -o claude.jsonl -p 4318   # both
 *
 * OTLP endpoints served:
 *   POST /v1/metrics   — receives ExportMetricsServiceRequest
 *   POST /v1/logs      — receives ExportLogsServiceRequest
 *
 * Configuring Claude Code to send here:
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1 \
 *   OTEL_METRICS_EXPORTER=otlp \
 *   OTEL_LOGS_EXPORTER=otlp \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
 *   OTEL_LOG_USER_PROMPTS=true \
 *   OTEL_LOG_TOOL_DETAILS=true \
 *     claude
 *
 * Configuring opencode-otel (otel.json):
 *   {
 *     "endpoint": "http://localhost:4318",
 *     "protocol": "http/json",
 *     "logUserPrompts": true,
 *     "logToolDetails": true,
 *     "telemetryProfile": "claude-code"
 *   }
 *
 * Press Ctrl+C to stop. The file is flushed after every batch.
 */

import { writeFileSync, appendFileSync, existsSync } from "fs"
import { parseArgs } from "util"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o", default: "telemetry.jsonl" },
    port: { type: "string", short: "p", default: "4318" },
  },
})

const OUTPUT_FILE = values.output!
const PORT = parseInt(values.port!, 10)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let metricBatches = 0
let logBatches = 0

// Ensure output file exists (truncate if it already does)
writeFileSync(OUTPUT_FILE, "")

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // OTLP endpoints
    if (req.method === "POST" && (url.pathname === "/v1/metrics" || url.pathname === "/v1/logs")) {
      const contentType = req.headers.get("content-type") ?? ""

      let body: unknown
      if (contentType.includes("application/json")) {
        body = await req.json()
      } else if (contentType.includes("application/x-protobuf") || contentType.includes("application/protobuf")) {
        // We don't decode protobuf — store as base64 so nothing is lost
        const buf = await req.arrayBuffer()
        body = {
          _encoding: "protobuf-base64",
          _endpoint: url.pathname,
          _data: Buffer.from(buf).toString("base64"),
        }
        console.warn(
          `  Warning: received protobuf on ${url.pathname}. ` +
          `Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json for readable output.`,
        )
      } else {
        // Try JSON anyway
        try {
          body = await req.json()
        } catch {
          return new Response("Unsupported content type", { status: 415 })
        }
      }

      const signal = url.pathname === "/v1/metrics" ? "metrics" : "logs"
      const record = {
        _signal: signal,
        _receivedAt: new Date().toISOString(),
        ...body as Record<string, unknown>,
      }

      appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n")

      if (signal === "metrics") {
        metricBatches++
        const count = countMetrics(body)
        console.log(`  [metrics] batch #${metricBatches} — ${count} data point(s)`)
      } else {
        logBatches++
        const count = countLogs(body)
        console.log(`  [logs]    batch #${logBatches} — ${count} log record(s)`)
      }

      // OTLP success response (partial success with no rejections)
      return Response.json({})
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        status: "ok",
        metricBatches,
        logBatches,
        outputFile: OUTPUT_FILE,
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`OTLP HTTP/JSON collector listening on http://localhost:${server.port}`)
console.log(`Writing to: ${OUTPUT_FILE}`)
console.log()
console.log("Endpoints:")
console.log(`  POST http://localhost:${server.port}/v1/metrics`)
console.log(`  POST http://localhost:${server.port}/v1/logs`)
console.log()
console.log("Press Ctrl+C to stop.")
console.log()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countMetrics(body: unknown): number {
  if (!body || typeof body !== "object") return 0
  const b = body as any
  let count = 0
  for (const rm of b.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        count += (m.sum?.dataPoints?.length ?? 0)
        count += (m.gauge?.dataPoints?.length ?? 0)
        count += (m.histogram?.dataPoints?.length ?? 0)
      }
    }
  }
  return count
}

function countLogs(body: unknown): number {
  if (!body || typeof body !== "object") return 0
  const b = body as any
  let count = 0
  for (const rl of b.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      count += (sl.logRecords?.length ?? 0)
    }
  }
  return count
}
