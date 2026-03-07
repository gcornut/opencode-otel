#!/usr/bin/env bun
/**
 * E2E test for the onlyForProvider feature.
 *
 * This script tests the complete telemetry pipeline:
 * 1. Loads config with onlyForProvider set
 * 2. Initializes telemetry with in-memory exporter
 * 3. Simulates events with different providers
 * 4. Verifies that telemetry is only emitted for matching providers
 *
 * Run with: bun scripts/test-only-for-provider.ts
 */

import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics"
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"
import { initTelemetry } from "../src/telemetry.js"
import { createHookState, handleEvent } from "../src/hooks.js"
import type { OtelConfig } from "../src/config.js"

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

interface TestScenario {
  name: string
  onlyForProvider: string | undefined
  events: Array<{ type: string; properties: any }>
  expectedMetrics: number
  expectedEvents: number
  description: string
}

const scenarios: TestScenario[] = [
  {
    name: "No filtering (all providers allowed)",
    onlyForProvider: undefined,
    events: [
      {
        type: "chat.message",
        properties: {
          sessionID: "s1",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          parts: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
      {
        type: "file.edited",
        properties: { linesAdded: 10 },
      },
    ],
    expectedMetrics: 2, // session.count + lines_of_code
    expectedEvents: 2, // user_prompt + session.created
    description: "When onlyForProvider is not set, all providers should emit telemetry",
  },
  {
    name: "Provider matches (vertex)",
    onlyForProvider: "vertex",
    events: [
      {
        type: "chat.message",
        properties: {
          sessionID: "s1",
          model: { providerID: "vertex", modelID: "claude-sonnet-4" },
          parts: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
      {
        type: "file.edited",
        properties: { linesAdded: 10 },
      },
    ],
    expectedMetrics: 2, // session.count + lines_of_code (provider-agnostic)
    expectedEvents: 2, // user_prompt + session.created
    description: "When onlyForProvider matches the chat provider, telemetry should be emitted",
  },
  {
    name: "Provider mismatch (anthropic vs vertex)",
    onlyForProvider: "vertex",
    events: [
      {
        type: "chat.message",
        properties: {
          sessionID: "s1",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          parts: [{ type: "text", text: "hello" }],
        },
      },
      {
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
      {
        type: "file.edited",
        properties: { linesAdded: 10 },
      },
    ],
    expectedMetrics: 2, // session.count + lines_of_code (provider-agnostic, always emitted)
    expectedEvents: 1, // user_prompt (captured before filter), session.created is skipped
    description: "When onlyForProvider doesn't match, provider-specific events are skipped but provider-agnostic metrics still emit",
  },
  {
    name: "Unknown provider (no model info)",
    onlyForProvider: "vertex",
    events: [
      {
        type: "chat.message",
        properties: {
          sessionID: "s1",
          parts: [{ type: "text", text: "hello" }], // no model info
        },
      },
      {
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
    ],
    expectedMetrics: 1, // session.count (provider-agnostic)
    expectedEvents: 1, // user_prompt (always emitted, no provider info available)
    description: "When provider is unknown (no model info), provider-specific events are buffered, provider-agnostic metrics emit, user_prompt still captured",
  },
  {
    name: "Buffering: events before first chat.message are buffered",
    onlyForProvider: "vertex",
    events: [
      {
        // Events before first chat.message should be buffered
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
      {
        type: "file.edited",
        properties: { linesAdded: 10 },
      },
      {
        // First chat.message determines provider and flushes buffer
        type: "chat.message",
        properties: {
          sessionID: "s1",
          model: { providerID: "vertex", modelID: "claude-sonnet-4" },
          parts: [{ type: "text", text: "hello" }],
        },
      },
    ],
    expectedMetrics: 2, // session.count + lines_of_code (provider-agnostic, always emitted)
    expectedEvents: 2, // session.created (flushed from buffer) + user_prompt
    description: "Events before first chat.message are buffered and flushed when provider matches",
  },
  {
    name: "Buffering: buffered events cleared when provider doesn't match",
    onlyForProvider: "vertex",
    events: [
      {
        // Events before first chat.message should be buffered
        type: "session.created",
        properties: { info: { id: "s1", title: "Test" } },
      },
      {
        type: "file.edited",
        properties: { linesAdded: 10 },
      },
      {
        // First chat.message determines provider - doesn't match, so buffer is cleared
        type: "chat.message",
        properties: {
          sessionID: "s1",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
          parts: [{ type: "text", text: "hello" }],
        },
      },
    ],
    expectedMetrics: 2, // session.count + lines_of_code (provider-agnostic, always emitted)
    expectedEvents: 1, // user_prompt (captured before filter is applied)
    description: "Buffered events are cleared when provider doesn't match, but provider-agnostic metrics still emit",
  },
]

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`, meta || "")
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    console.log(`[INFO] ${msg}`, meta || "")
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    console.warn(`[WARN] ${msg}`, meta || "")
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${msg}`, meta || "")
  },
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runScenario(scenario: TestScenario): Promise<boolean> {
  console.log(`\n${"=".repeat(70)}`)
  console.log(`Scenario: ${scenario.name}`)
  console.log(`Description: ${scenario.description}`)
  console.log(`onlyForProvider: ${scenario.onlyForProvider ?? "(not set)"}`)
  console.log(`${"=".repeat(70)}`)

  // Create config
  const config: OtelConfig = {
    metricsExporter: "otlp",
    logsExporter: "otlp",
    protocol: "grpc",
    endpoint: "http://localhost:4317",
    headers: {},
    metricExportIntervalMs: 60000,
    logsExportIntervalMs: 5000,
    metricsTemporality: "delta",
    resourceAttributes: {},
    logUserPrompts: false,
    logToolDetails: false,
    includeSessionId: true,
    includeVersion: false,
    includeAccountUuid: false,
    telemetryProfile: "opencode",
    onlyForProvider: scenario.onlyForProvider 
      ? [scenario.onlyForProvider] 
      : undefined,
  }

  // Create in-memory exporters
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
  const logExporter = new InMemoryLogRecordExporter()

  // Initialize telemetry
  const telemetry = initTelemetry(config, logger, {
    metricExporter,
    logExporter,
  })

  // Create hook state
  const state = createHookState(config, telemetry, logger)

  // Process events
  for (const event of scenario.events) {
    logger.debug(`Processing event: ${event.type}`, { provider: state.currentProvider })
    handleEvent(state, event)
  }

  // Force flush metrics
  await telemetry.meterProvider.forceFlush()

  // Get collected data
  const metrics = metricExporter.getMetrics()
  const logs = logExporter.getFinishedLogRecords()

  // Count metric data points
  let metricCount = 0
  for (const rm of metrics) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if ("dataPoints" in metric) {
          metricCount += metric.dataPoints.length
        }
      }
    }
  }

  // Count log events
  const eventCount = logs.length

  console.log(`\nResults:`)
  console.log(`  Metric data points: ${metricCount} (expected: ${scenario.expectedMetrics})`)
  console.log(`  Log events: ${eventCount} (expected: ${scenario.expectedEvents})`)

  // Verify results
  const metricsMatch = metricCount === scenario.expectedMetrics
  const eventsMatch = eventCount === scenario.expectedEvents

  if (metricsMatch && eventsMatch) {
    console.log(`\n✅ PASSED`)
    await telemetry.shutdown()
    return true
  } else {
    console.log(`\n❌ FAILED`)
    if (!metricsMatch) {
      console.log(`   Metrics mismatch: got ${metricCount}, expected ${scenario.expectedMetrics}`)
    }
    if (!eventsMatch) {
      console.log(`   Events mismatch: got ${eventCount}, expected ${scenario.expectedEvents}`)
    }

    // Debug output
    console.log(`\nCollected metrics:`)
    for (const rm of metrics) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          console.log(`  - ${metric.descriptor.name}: ${"dataPoints" in metric ? metric.dataPoints.length : 0} data points`)
        }
      }
    }

    console.log(`\nCollected events:`)
    for (const log of logs) {
      console.log(`  - ${log.attributes["event.name"] ?? log.body}`)
    }

    await telemetry.shutdown()
    return false
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("🧪 E2E Test: onlyForProvider feature")
  console.log(`Running ${scenarios.length} test scenarios...`)

  let passed = 0
  let failed = 0

  for (const scenario of scenarios) {
    const success = await runScenario(scenario)
    if (success) {
      passed++
    } else {
      failed++
    }
  }

  console.log(`\n${"=".repeat(70)}`)
  console.log("Test Summary")
  console.log(`${"=".repeat(70)}`)
  console.log(`Total: ${scenarios.length}`)
  console.log(`✅ Passed: ${passed}`)
  console.log(`❌ Failed: ${failed}`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error("Test failed with error:", e)
  process.exit(1)
})
