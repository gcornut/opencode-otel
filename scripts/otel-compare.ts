#!/usr/bin/env bun
/**
 * Compare two OTLP JSONL captures (e.g. Claude Code vs opencode-otel).
 *
 * Reads two JSONL files produced by otel-collector.ts and prints a
 * structured comparison of:
 *   - Resource attributes
 *   - Metric names, units, and attribute keys
 *   - Event names and attribute keys
 *
 * Usage:
 *   bun scripts/otel-compare.ts claude.jsonl opencode.jsonl
 */

import { readFileSync } from "fs"

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [fileA, fileB] = Bun.argv.slice(2)

if (!fileA || !fileB) {
  console.error("Usage: bun scripts/otel-compare.ts <baseline.jsonl> <comparison.jsonl>")
  console.error("")
  console.error("Example:")
  console.error("  bun scripts/otel-compare.ts claude.jsonl opencode.jsonl")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Parse JSONL
// ---------------------------------------------------------------------------

interface ParsedTelemetry {
  resourceAttributes: Record<string, unknown>
  metrics: Map<string, MetricInfo>
  events: Map<string, EventInfo>
}

interface MetricInfo {
  name: string
  unit: string
  descriptions: Set<string>
  attributeKeys: Set<string>
  dataPointCount: number
  sampleAttributes: Record<string, unknown>[]
}

interface EventInfo {
  name: string
  attributeKeys: Set<string>
  count: number
  sampleAttributes: Record<string, unknown>[]
}

function parseTelemetry(filePath: string): ParsedTelemetry {
  const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean)
  const result: ParsedTelemetry = {
    resourceAttributes: {},
    metrics: new Map(),
    events: new Map(),
  }

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    // Metrics
    if (obj.resourceMetrics) {
      for (const rm of obj.resourceMetrics) {
        // Resource attributes (take last seen)
        if (rm.resource?.attributes) {
          for (const attr of rm.resource.attributes) {
            result.resourceAttributes[attr.key] = extractValue(attr.value)
          }
        }

        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            const name = m.name ?? "unknown"
            if (!result.metrics.has(name)) {
              result.metrics.set(name, {
                name,
                unit: m.unit ?? "",
                descriptions: new Set(),
                attributeKeys: new Set(),
                dataPointCount: 0,
                sampleAttributes: [],
              })
            }
            const info = result.metrics.get(name)!
            if (m.description) info.descriptions.add(m.description)

            // Collect data points from sum, gauge, histogram
            const dataPoints = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? []
            for (const dp of dataPoints) {
              info.dataPointCount++
              if (dp.attributes) {
                const attrs: Record<string, unknown> = {}
                for (const a of dp.attributes) {
                  info.attributeKeys.add(a.key)
                  attrs[a.key] = extractValue(a.value)
                }
                if (info.sampleAttributes.length < 3) {
                  info.sampleAttributes.push(attrs)
                }
              }
            }
          }
        }
      }
    }

    // Logs
    if (obj.resourceLogs) {
      for (const rl of obj.resourceLogs) {
        if (rl.resource?.attributes) {
          for (const attr of rl.resource.attributes) {
            result.resourceAttributes[attr.key] = extractValue(attr.value)
          }
        }

        for (const sl of rl.scopeLogs ?? []) {
          for (const lr of sl.logRecords ?? []) {
            let eventName = "unknown"
            const attrs: Record<string, unknown> = {}

            for (const a of lr.attributes ?? []) {
              const val = extractValue(a.value)
              attrs[a.key] = val
              if (a.key === "event.name") {
                eventName = String(val)
              }
            }

            if (!result.events.has(eventName)) {
              result.events.set(eventName, {
                name: eventName,
                attributeKeys: new Set(),
                count: 0,
                sampleAttributes: [],
              })
            }
            const info = result.events.get(eventName)!
            info.count++
            for (const key of Object.keys(attrs)) {
              info.attributeKeys.add(key)
            }
            if (info.sampleAttributes.length < 2) {
              info.sampleAttributes.push(attrs)
            }
          }
        }
      }
    }
  }

  return result
}

function extractValue(v: any): unknown {
  if (!v || typeof v !== "object") return v
  if ("stringValue" in v) return v.stringValue
  if ("intValue" in v) return v.intValue
  if ("doubleValue" in v) return v.doubleValue
  if ("boolValue" in v) return v.boolValue
  if ("arrayValue" in v) return v.arrayValue?.values?.map(extractValue)
  return v
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const a = parseTelemetry(fileA)
const b = parseTelemetry(fileB)

const labelA = fileA.replace(/.*\//, "")
const labelB = fileB.replace(/.*\//, "")

console.log("=" .repeat(72))
console.log(`OTLP Telemetry Comparison`)
console.log(`  Baseline:   ${fileA}`)
console.log(`  Comparison: ${fileB}`)
console.log("=".repeat(72))

// --- Resource Attributes ---
console.log()
console.log("## Resource Attributes")
console.log()

const allResKeys = new Set([
  ...Object.keys(a.resourceAttributes),
  ...Object.keys(b.resourceAttributes),
])

const resRows: string[][] = [["Attribute", labelA, labelB, "Match"]]
for (const key of [...allResKeys].sort()) {
  const va = a.resourceAttributes[key]
  const vb = b.resourceAttributes[key]
  const match =
    va === undefined ? "missing in baseline" :
    vb === undefined ? "missing in comparison" :
    String(va) === String(vb) ? "yes" : "DIFFERS"
  resRows.push([key, fmt(va), fmt(vb), match])
}
printTable(resRows)

// --- Metrics ---
console.log()
console.log("## Metrics")
console.log()

const allMetricNames = new Set([
  ...a.metrics.keys(),
  ...b.metrics.keys(),
])

const metricRows: string[][] = [["Metric Name", `${labelA} (unit)`, `${labelB} (unit)`, "Attr Keys Match"]]
for (const name of [...allMetricNames].sort()) {
  const ma = a.metrics.get(name)
  const mb = b.metrics.get(name)

  const unitA = ma ? `${ma.dataPointCount} pts (${ma.unit || "?"})` : "-"
  const unitB = mb ? `${mb.dataPointCount} pts (${mb.unit || "?"})` : "-"

  let attrMatch: string
  if (!ma) {
    attrMatch = "missing in baseline"
  } else if (!mb) {
    attrMatch = "missing in comparison"
  } else {
    const keysA = [...ma.attributeKeys].sort().join(",")
    const keysB = [...mb.attributeKeys].sort().join(",")
    attrMatch = keysA === keysB ? "yes" : "DIFFERS"
  }

  metricRows.push([name, unitA, unitB, attrMatch])
}
printTable(metricRows)

// Detail: per-metric attribute keys diff
for (const name of [...allMetricNames].sort()) {
  const ma = a.metrics.get(name)
  const mb = b.metrics.get(name)
  if (!ma || !mb) continue

  const keysA = [...ma.attributeKeys].sort()
  const keysB = [...mb.attributeKeys].sort()
  if (keysA.join(",") !== keysB.join(",")) {
    console.log()
    console.log(`  ${name} attribute keys:`)
    const onlyA = keysA.filter((k) => !mb.attributeKeys.has(k))
    const onlyB = keysB.filter((k) => !ma.attributeKeys.has(k))
    if (onlyA.length) console.log(`    Only in ${labelA}: ${onlyA.join(", ")}`)
    if (onlyB.length) console.log(`    Only in ${labelB}: ${onlyB.join(", ")}`)
  }
}

// --- Events ---
console.log()
console.log("## Events (Log Records)")
console.log()

const allEventNames = new Set([
  ...a.events.keys(),
  ...b.events.keys(),
])

const eventRows: string[][] = [["Event Name", `${labelA} (count)`, `${labelB} (count)`, "Attr Keys Match"]]
for (const name of [...allEventNames].sort()) {
  const ea = a.events.get(name)
  const eb = b.events.get(name)

  const countA = ea ? String(ea.count) : "-"
  const countB = eb ? String(eb.count) : "-"

  let attrMatch: string
  if (!ea) {
    attrMatch = "missing in baseline"
  } else if (!eb) {
    attrMatch = "missing in comparison"
  } else {
    const keysA = [...ea.attributeKeys].sort().join(",")
    const keysB = [...eb.attributeKeys].sort().join(",")
    attrMatch = keysA === keysB ? "yes" : "DIFFERS"
  }

  eventRows.push([name, countA, countB, attrMatch])
}
printTable(eventRows)

// Detail: per-event attribute keys diff
for (const name of [...allEventNames].sort()) {
  const ea = a.events.get(name)
  const eb = b.events.get(name)
  if (!ea || !eb) continue

  const keysA = [...ea.attributeKeys].sort()
  const keysB = [...eb.attributeKeys].sort()
  if (keysA.join(",") !== keysB.join(",")) {
    console.log()
    console.log(`  ${name} attribute keys:`)
    const onlyA = keysA.filter((k) => !eb.attributeKeys.has(k))
    const onlyB = keysB.filter((k) => !ea.attributeKeys.has(k))
    if (onlyA.length) console.log(`    Only in ${labelA}: ${onlyA.join(", ")}`)
    if (onlyB.length) console.log(`    Only in ${labelB}: ${onlyB.join(", ")}`)
  }
}

// --- Summary ---
console.log()
console.log("=".repeat(72))
console.log("Summary")
console.log("=".repeat(72))

const metricsOnlyA = [...allMetricNames].filter((n) => a.metrics.has(n) && !b.metrics.has(n))
const metricsOnlyB = [...allMetricNames].filter((n) => !a.metrics.has(n) && b.metrics.has(n))
const eventsOnlyA = [...allEventNames].filter((n) => a.events.has(n) && !b.events.has(n))
const eventsOnlyB = [...allEventNames].filter((n) => !a.events.has(n) && b.events.has(n))

if (metricsOnlyA.length) console.log(`Metrics only in ${labelA}: ${metricsOnlyA.join(", ")}`)
if (metricsOnlyB.length) console.log(`Metrics only in ${labelB}: ${metricsOnlyB.join(", ")}`)
if (eventsOnlyA.length) console.log(`Events only in ${labelA}:  ${eventsOnlyA.join(", ")}`)
if (eventsOnlyB.length) console.log(`Events only in ${labelB}:  ${eventsOnlyB.join(", ")}`)

if (!metricsOnlyA.length && !metricsOnlyB.length && !eventsOnlyA.length && !eventsOnlyB.length) {
  console.log("All metric names and event names are present in both files.")
}

console.log()

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(v: unknown): string {
  if (v === undefined) return "-"
  if (typeof v === "string") return v
  return String(v)
}

function printTable(rows: string[][]) {
  if (rows.length === 0) return
  const cols = rows[0].length
  const widths: number[] = Array(cols).fill(0)
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? "").length)
    }
  }

  for (let r = 0; r < rows.length; r++) {
    const line = rows[r].map((cell, i) => cell.padEnd(widths[i])).join("  ")
    console.log(`  ${line}`)
    if (r === 0) {
      console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`)
    }
  }
}
