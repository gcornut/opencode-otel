/**
 * Core telemetry module — sets up OTEL MeterProvider + LoggerProvider
 * and exposes metric instruments + event emitter.
 */

import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  type MetricReader,
} from "@opentelemetry/sdk-metrics"
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs"
import { OTLPMetricExporter as OTLPMetricExporterGrpc } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { OTLPMetricExporter as OTLPMetricExporterHttp } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPLogExporter as OTLPLogExporterGrpc } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPLogExporter as OTLPLogExporterHttp } from "@opentelemetry/exporter-logs-otlp-http"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import { release } from "os"
import { SeverityNumber } from "@opentelemetry/api-logs"

import type { OtelConfig, TelemetryProfile } from "./config.js"
import type { Counter, Attributes, Meter } from "@opentelemetry/api"
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics"
import type { LogRecordExporter } from "@opentelemetry/sdk-logs"
import type { Logger } from "./log.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OtelMetrics {
  sessionCount: Counter
  linesOfCode: Counter
  pullRequestCount: Counter
  commitCount: Counter
  costUsage: Counter
  tokenUsage: Counter
  toolDecision: Counter
  activeTime: Counter
}

export interface TelemetryContext {
  meter: Meter
  metrics: OtelMetrics
  loggerProvider: LoggerProvider
  meterProvider: MeterProvider
  /** Metric/event name prefix — "opencode" or "claude_code" */
  prefix: string
  emitEvent: (prefixedName: string, unprefixedName: string, attrs: Attributes) => void
  shutdown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Telemetry profiles
// ---------------------------------------------------------------------------

interface ProfileConfig {
  serviceName: string
  meterName: string
  loggerName: string
  prefix: string
}

const PROFILES: Record<TelemetryProfile, ProfileConfig> = {
  opencode: {
    serviceName: "opencode",
    meterName: "com.opencode.telemetry",
    loggerName: "com.opencode.telemetry.events",
    prefix: "opencode",
  },
  "claude-code": {
    serviceName: "claude-code",
    meterName: "com.anthropic.claude_code",
    loggerName: "com.anthropic.claude_code.events",
    prefix: "claude_code",
  },
}

/**
 * Map Node.js process.arch values to Go-style values used by Claude Code.
 * Only applied when using the "claude-code" profile.
 */
const ARCH_MAP: Record<string, string> = {
  x64: "amd64",
  ia32: "386",
  arm64: "arm64",
  arm: "arm",
}

// ---------------------------------------------------------------------------
// Resource builder
// ---------------------------------------------------------------------------

function buildResource(config: OtelConfig, pluginVersion: string): Resource {
  const profile = PROFILES[config.telemetryProfile]
  const arch =
    config.telemetryProfile === "claude-code"
      ? (ARCH_MAP[process.arch] ?? process.arch)
      : process.arch

  const attrs: Attributes = {
    [ATTR_SERVICE_NAME]: profile.serviceName,
    [ATTR_SERVICE_VERSION]: pluginVersion,
    "os.type": process.platform,
    "os.version": release(),
    "host.arch": arch,
  }

  // Merge user-provided resource attributes
  for (const [k, v] of Object.entries(config.resourceAttributes)) {
    attrs[k] = v
  }

  return new Resource(attrs)
}

// ---------------------------------------------------------------------------
// Exporter factories
// ---------------------------------------------------------------------------

function createMetricReader(config: OtelConfig): MetricReader | null {
  if (config.metricsExporter === "none") return null

  if (config.metricsExporter === "console") {
    return new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis: config.metricExportIntervalMs,
    })
  }

  // OTLP
  const exporterOpts = {
    url: buildMetricsUrl(config),
    headers: config.headers,
    temporalityPreference:
      config.metricsTemporality === "cumulative" ? 0 : 1, // 0=CUMULATIVE, 1=DELTA
  }

  const exporter =
    config.protocol === "grpc"
      ? new OTLPMetricExporterGrpc(exporterOpts)
      : new OTLPMetricExporterHttp(exporterOpts)

  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: config.metricExportIntervalMs,
  })
}

function createLogProcessor(config: OtelConfig): LogRecordProcessor | null {
  if (config.logsExporter === "none") return null

  if (config.logsExporter === "console") {
    return new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
  }

  // OTLP
  const exporterOpts = {
    url: buildLogsUrl(config),
    headers: config.headers,
  }

  const exporter =
    config.protocol === "grpc"
      ? new OTLPLogExporterGrpc(exporterOpts)
      : new OTLPLogExporterHttp(exporterOpts)

  return new BatchLogRecordProcessor(exporter, {
    scheduledDelayMillis: config.logsExportIntervalMs,
  })
}

function buildMetricsUrl(config: OtelConfig): string {
  if (config.metricsEndpoint) return config.metricsEndpoint
  if (config.protocol === "grpc") return config.endpoint
  return `${config.endpoint}/v1/metrics`
}

function buildLogsUrl(config: OtelConfig): string {
  if (config.logsEndpoint) return config.logsEndpoint
  if (config.protocol === "grpc") return config.endpoint
  return `${config.endpoint}/v1/logs`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PLUGIN_VERSION = "0.1.0"

/**
 * Optional overrides for dependency injection (used by tests).
 * When provided, these exporters replace the ones that would normally
 * be created from the config.
 */
export interface TelemetryOptions {
  /** Override the metric exporter (e.g. InMemoryMetricExporter for tests). */
  metricExporter?: PushMetricExporter
  /** Override the log record exporter (e.g. InMemoryLogRecordExporter for tests). */
  logExporter?: LogRecordExporter
}

export function initTelemetry(
  config: OtelConfig,
  log: Logger,
  options?: TelemetryOptions,
): TelemetryContext {
  const profile = PROFILES[config.telemetryProfile]
  const p = profile.prefix
  const resource = buildResource(config, PLUGIN_VERSION)

  // --- Metrics ---
  const meterProvider = new MeterProvider({ resource })
  if (options?.metricExporter) {
    // Test mode: use the injected exporter
    meterProvider.addMetricReader(
      new PeriodicExportingMetricReader({
        exporter: options.metricExporter,
        exportIntervalMillis: config.metricExportIntervalMs,
      }),
    )
  } else {
    const metricReader = createMetricReader(config)
    if (metricReader) {
      meterProvider.addMetricReader(metricReader)
    }
  }
  const meter = meterProvider.getMeter(profile.meterName, PLUGIN_VERSION)

  const metrics: OtelMetrics = {
    sessionCount: meter.createCounter(`${p}.session.count`, {
      description: "Count of CLI sessions started",
    }),
    linesOfCode: meter.createCounter(`${p}.lines_of_code.count`, {
      description: "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
    }),
    pullRequestCount: meter.createCounter(`${p}.pull_request.count`, {
      description: "Number of pull requests created",
    }),
    commitCount: meter.createCounter(`${p}.commit.count`, {
      description: "Number of git commits created",
    }),
    costUsage: meter.createCounter(`${p}.cost.usage`, {
      description: "Cost of the Claude Code session",
      unit: "USD",
    }),
    tokenUsage: meter.createCounter(`${p}.token.usage`, {
      description: "Number of tokens used",
      unit: "tokens",
    }),
    toolDecision: meter.createCounter(`${p}.tool.decision`, {
      description: "Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools",
    }),
    activeTime: meter.createCounter(`${p}.active_time.total`, {
      description: "Total active time in seconds",
      unit: "s",
    }),
  }

  // --- Logs (Events) ---
  const loggerProvider = new LoggerProvider({ resource })
  if (options?.logExporter) {
    // Test mode: use the injected exporter with SimpleLogRecordProcessor
    // for immediate (synchronous) export
    loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(options.logExporter),
    )
  } else {
    const logProcessor = createLogProcessor(config)
    if (logProcessor) {
      loggerProvider.addLogRecordProcessor(logProcessor)
    }
  }
  const logger = loggerProvider.getLogger(profile.loggerName, PLUGIN_VERSION)

  /**
   * Emit an OTEL log event.
   *
   * @param prefixedName - Full event name with profile prefix (e.g. "claude_code.user_prompt").
   *                       Used as the log body.
   * @param unprefixedName - Short event name without prefix (e.g. "user_prompt").
   *                         Used as the `event.name` attribute (matches Claude Code behavior).
   * @param attrs - Additional attributes for the log record.
   */
  function emitEvent(prefixedName: string, unprefixedName: string, attrs: Attributes) {
    log.debug("emitEvent", { name: prefixedName, attributes: attrs })
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: prefixedName,
      attributes: {
        "event.name": unprefixedName,
        ...attrs,
      },
    })
  }

  async function shutdown() {
    await Promise.allSettled([
      meterProvider.forceFlush(),
      loggerProvider.forceFlush(),
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
    ])
  }

  return {
    meter,
    metrics,
    loggerProvider,
    meterProvider,
    prefix: p,
    emitEvent,
    shutdown,
  }
}
