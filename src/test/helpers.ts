/**
 * Test helpers — in-memory OTEL collectors, config factory, mock logger.
 *
 * Uses the OTEL SDK's built-in InMemoryMetricExporter and
 * InMemoryLogRecordExporter to capture telemetry emitted by the plugin,
 * then provides query helpers to inspect the collected data.
 */

import {
  InMemoryMetricExporter,
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type SumMetricData,
} from "@opentelemetry/sdk-metrics"
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs"
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { Attributes } from "@opentelemetry/api"

import { initTelemetry, type TelemetryContext } from "../telemetry.js"
import { createHookState, handleEvent, type HookState } from "../hooks.js"
import type { OtelConfig, TelemetryProfile } from "../config.js"
import type { Logger } from "../log.js"

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

const DEFAULT_TEST_CONFIG: OtelConfig = {
  metricsExporter: "otlp",
  logsExporter: "otlp",
  protocol: "grpc",
  endpoint: "http://localhost:4317",
  headers: {},
  metricExportIntervalMs: 100, // fast for tests
  logsExportIntervalMs: 100,
  metricsTemporality: "delta",
  resourceAttributes: {},
  logUserPrompts: false,
  logToolDetails: false,
  includeSessionId: true,
  includeVersion: false,
  includeAccountUuid: false,
  telemetryProfile: "opencode",
}

/** Create a test config with optional overrides. */
export function testConfig(overrides?: Partial<OtelConfig>): OtelConfig {
  return { ...DEFAULT_TEST_CONFIG, ...overrides }
}

// ---------------------------------------------------------------------------
// No-op logger (silent in tests)
// ---------------------------------------------------------------------------

export function noopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

// ---------------------------------------------------------------------------
// Test harness — wires everything together
// ---------------------------------------------------------------------------

export interface TestHarness {
  config: OtelConfig
  telemetry: TelemetryContext
  state: HookState
  metricExporter: InMemoryMetricExporter
  logExporter: InMemoryLogRecordExporter

  /** Dispatch an event through the hook system. */
  emit: (event: { type: string; properties?: any }) => void

  /**
   * Force-flush metrics so they appear in the in-memory exporter.
   * Must be called before querying metrics (counters are async).
   */
  flush: () => Promise<void>

  /** Tear down the OTEL providers. */
  shutdown: () => Promise<void>

  // -- Query helpers --

  /** Get all collected log events. */
  getEvents: () => ReadableLogRecord[]

  /** Get log events matching a given event name. */
  getEventsByName: (name: string) => ReadableLogRecord[]

  /**
   * Get all metric data points, flattened into a simple list.
   * Each entry has { name, value, attributes }.
   */
  getMetricDataPoints: () => MetricDataPoint[]

  /**
   * Get metric data points matching a given metric name.
   */
  getMetricsByName: (name: string) => MetricDataPoint[]

  /** Get resource attributes from the metric exporter. */
  getResourceAttributes: () => Attributes

  /** Reset both exporters (clear collected data). */
  reset: () => void
}

export interface MetricDataPoint {
  name: string
  description: string
  unit: string
  value: number
  attributes: Attributes
}

/**
 * Create a fully wired test harness with in-memory exporters.
 * Each call creates an isolated telemetry context.
 */
export function createTestHarness(
  configOverrides?: Partial<OtelConfig>,
): TestHarness {
  const config = testConfig(configOverrides)
  const log = noopLogger()

  const metricExporter = new InMemoryMetricExporter(
    config.metricsTemporality === "cumulative"
      ? AggregationTemporality.CUMULATIVE
      : AggregationTemporality.DELTA,
  )
  const logExporter = new InMemoryLogRecordExporter()

  const telemetry = initTelemetry(config, log, {
    metricExporter,
    logExporter,
  })
  const state = createHookState(config, telemetry, log)

  function emit(event: { type: string; properties?: any }) {
    handleEvent(state, event)
  }

  async function flush() {
    await telemetry.meterProvider.forceFlush()
  }

  async function shutdown() {
    await telemetry.shutdown()
  }

  function getEvents(): ReadableLogRecord[] {
    return logExporter.getFinishedLogRecords()
  }

  function getEventsByName(name: string): ReadableLogRecord[] {
    return getEvents().filter(
      (r) => r.attributes["event.name"] === name,
    )
  }

  function getMetricDataPoints(): MetricDataPoint[] {
    const result: MetricDataPoint[] = []
    for (const rm of metricExporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          if (metric.dataPointType === DataPointType.SUM) {
            const sumMetric = metric as SumMetricData
            for (const dp of sumMetric.dataPoints) {
              result.push({
                name: metric.descriptor.name,
                description: metric.descriptor.description,
                unit: metric.descriptor.unit,
                value: dp.value,
                attributes: dp.attributes,
              })
            }
          }
        }
      }
    }
    return result
  }

  function getMetricsByName(name: string): MetricDataPoint[] {
    return getMetricDataPoints().filter((dp) => dp.name === name)
  }

  function getResourceAttributes(): Attributes {
    const metrics = metricExporter.getMetrics()
    if (metrics.length === 0) return {}
    return metrics[0].resource.attributes
  }

  function reset() {
    metricExporter.reset()
    logExporter.reset()
  }

  return {
    config,
    telemetry,
    state,
    metricExporter,
    logExporter,
    emit,
    flush,
    shutdown,
    getEvents,
    getEventsByName,
    getMetricDataPoints,
    getMetricsByName,
    getResourceAttributes,
    reset,
  }
}
