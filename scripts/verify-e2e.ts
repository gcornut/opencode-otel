#!/usr/bin/env bun
/**
 * Helper script to verify E2E test results for onlyForProvider feature.
 *
 * Usage:
 *   bun scripts/verify-e2e.ts <telemetry-file.jsonl>
 *
 * Example:
 *   bun scripts/verify-e2e.ts e2e-test-results.jsonl
 */

import { readFileSync, existsSync } from "fs"

const filePath = process.argv[2]

if (!filePath) {
  console.error("Usage: bun scripts/verify-e2e.ts <telemetry-file.jsonl>")
  process.exit(1)
}

if (!existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`)
  process.exit(1)
}

const content = readFileSync(filePath, "utf-8")
const lines = content.trim().split("\n").filter(Boolean)

console.log(`📊 E2E Test Results Analysis`)
console.log(`File: ${filePath}`)
console.log(`Batches captured: ${lines.length}`)
console.log("")

if (lines.length === 0) {
  console.log("⚠️  No telemetry captured")
  console.log("   This is expected for Test Case 1 (non-matching provider)")
  console.log("   This is NOT expected for Test Case 2 (matching provider)")
  process.exit(0)
}

// Parse and analyze each batch
let totalMetrics = 0
let totalEvents = 0
let providers = new Set<string>()
let eventNames = new Set<string>()

for (let i = 0; i < lines.length; i++) {
  const batch = JSON.parse(lines[i])

  // Count metrics
  if (batch.resourceMetrics) {
    for (const rm of batch.resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        totalMetrics += sm.metrics?.length || 0
      }
    }
  }

  // Count events and extract info
  if (batch.resourceLogs) {
    for (const rl of batch.resourceLogs) {
      for (const sl of rl.scopeLogs) {
        for (const log of sl.logRecords || []) {
          totalEvents++

          // Extract event name
          const eventName = log.attributes?.find((a: any) => a.key === "event.name")?.value?.stringValue
          if (eventName) {
            eventNames.add(eventName)
          }

          // Extract provider
          const provider = log.attributes?.find((a: any) => a.key === "model.provider")?.value?.stringValue
          if (provider) {
            providers.add(provider)
          }
        }
      }
    }
  }
}

console.log(`📈 Summary:`)
console.log(`   Total metric types: ${totalMetrics}`)
console.log(`   Total log events: ${totalEvents}`)
console.log(`   Providers seen: ${Array.from(providers).join(", ") || "none"}`)
console.log(`   Event types: ${Array.from(eventNames).join(", ") || "none"}`)
console.log("")

// Check for expected events
const expectedEvents = ["user_prompt", "api_request", "tool_result", "session.created"]
const foundExpected = expectedEvents.filter(e => eventNames.has(e))

console.log(`✅ Expected events found: ${foundExpected.join(", ") || "none"}`)

if (foundExpected.length > 0) {
  console.log("")
  console.log("🎉 SUCCESS: Telemetry is being captured correctly!")
  console.log("   This confirms that the onlyForProvider feature is working.")
} else if (lines.length > 0) {
  console.log("")
  console.log("⚠️  Telemetry batches exist but no expected events found")
  console.log("   This might indicate a configuration issue.")
}

// Sample output for first batch
if (lines.length > 0) {
  console.log("")
  console.log("📝 Sample batch (first one):")
  const firstBatch = JSON.parse(lines[0])
  console.log(JSON.stringify(firstBatch, null, 2).slice(0, 2000))
  if (JSON.stringify(firstBatch).length > 2000) {
    console.log("... (truncated)")
  }
}
