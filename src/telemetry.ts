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
import { SeverityNumber } from "@opentelemetry/api-logs"

import type { OtelConfig, TelemetryProfile } from "./config.js"
import type { Counter, Attributes, Meter } from "@opentelemetry/api"

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
  emitEvent: (name: string, attrs: Attributes) => void
  shutdown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Telemetry profiles
// ---------------------------------------------------------------------------

interface ProfileConfig {
  serviceName: string
  meterName: string
  prefix: string
}

const PROFILES: Record<TelemetryProfile, ProfileConfig> = {
  opencode: {
    serviceName: "opencode",
    meterName: "com.opencode.telemetry",
    prefix: "opencode",
  },
  "claude-code": {
    serviceName: "claude-code",
    meterName: "com.anthropic.claude_code",
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
  const override = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  if (override) return override
  if (config.protocol === "grpc") return config.endpoint
  return `${config.endpoint}/v1/metrics`
}

function buildLogsUrl(config: OtelConfig): string {
  const override = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (override) return override
  if (config.protocol === "grpc") return config.endpoint
  return `${config.endpoint}/v1/logs`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PLUGIN_VERSION = "0.1.0"

export function initTelemetry(config: OtelConfig): TelemetryContext {
  const profile = PROFILES[config.telemetryProfile]
  const p = profile.prefix
  const resource = buildResource(config, PLUGIN_VERSION)

  // --- Metrics ---
  const meterProvider = new MeterProvider({ resource })
  const metricReader = createMetricReader(config)
  if (metricReader) {
    meterProvider.addMetricReader(metricReader)
  }
  const meter = meterProvider.getMeter(profile.meterName, PLUGIN_VERSION)

  const metrics: OtelMetrics = {
    sessionCount: meter.createCounter(`${p}.session.count`, {
      description: "Number of sessions started",
      unit: "count",
    }),
    linesOfCode: meter.createCounter(`${p}.lines_of_code.count`, {
      description: "Lines of code added or removed",
      unit: "count",
    }),
    pullRequestCount: meter.createCounter(`${p}.pull_request.count`, {
      description: "Number of pull requests created",
      unit: "count",
    }),
    commitCount: meter.createCounter(`${p}.commit.count`, {
      description: "Number of commits created",
      unit: "count",
    }),
    costUsage: meter.createCounter(`${p}.cost.usage`, {
      description: "LLM API cost in USD",
      unit: "USD",
    }),
    tokenUsage: meter.createCounter(`${p}.token.usage`, {
      description: "Token usage by type",
      unit: "tokens",
    }),
    toolDecision: meter.createCounter(`${p}.tool.decision`, {
      description: "Tool execution decisions",
      unit: "count",
    }),
    activeTime: meter.createCounter(`${p}.active_time.total`, {
      description: "Active session time",
      unit: "seconds",
    }),
  }

  // --- Logs (Events) ---
  const loggerProvider = new LoggerProvider({ resource })
  const logProcessor = createLogProcessor(config)
  if (logProcessor) {
    loggerProvider.addLogRecordProcessor(logProcessor)
  }
  const logger = loggerProvider.getLogger(profile.meterName, PLUGIN_VERSION)

  function emitEvent(name: string, attrs: Attributes) {
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: name,
      attributes: {
        "event.name": name,
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
