/**
 * Configuration module — loads from a JSON config file.
 *
 * Resolution order (highest priority wins):
 *   1. JSON config file — parsed & validated by JsonConfigSchema
 *   2. Built-in defaults
 *
 * JSON config is loaded from (first found wins):
 *   - $OPENCODE_OTEL_CONFIG_PATH   (env var override for file path)
 *   - ~/.config/opencode/otel.json  (standard location)
 */

import { readFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"
import * as v from "valibot"

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

const ExporterTypeSchema = v.picklist(["otlp", "console", "none"])
const OtelProtocolSchema = v.picklist(["grpc", "http/json", "http/protobuf"])
const TemporalitySchema = v.picklist(["delta", "cumulative"])
const TelemetryProfileSchema = v.picklist(["opencode", "claude-code"])
const StringRecordSchema = v.record(v.string(), v.string())

// ---------------------------------------------------------------------------
// JSON file schema — all fields optional, typed natively
// ---------------------------------------------------------------------------

export const JsonConfigSchema = v.object({
  metricsExporter: v.optional(ExporterTypeSchema),
  logsExporter: v.optional(ExporterTypeSchema),
  protocol: v.optional(OtelProtocolSchema),
  endpoint: v.optional(v.pipe(v.string(), v.url())),
  metricsEndpoint: v.optional(v.pipe(v.string(), v.url())),
  logsEndpoint: v.optional(v.pipe(v.string(), v.url())),
  headers: v.optional(StringRecordSchema),
  metricExportIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  logsExportIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  metricsTemporality: v.optional(TemporalitySchema),
  resourceAttributes: v.optional(StringRecordSchema),
  logUserPrompts: v.optional(v.boolean()),
  logToolDetails: v.optional(v.boolean()),
  includeSessionId: v.optional(v.boolean()),
  includeVersion: v.optional(v.boolean()),
  includeAccountUuid: v.optional(v.boolean()),
  telemetryProfile: v.optional(TelemetryProfileSchema),
})

// ---------------------------------------------------------------------------
// Final resolved config schema — all fields required
// ---------------------------------------------------------------------------

export const OtelConfigSchema = v.object({
  metricsExporter: ExporterTypeSchema,
  logsExporter: ExporterTypeSchema,
  protocol: OtelProtocolSchema,
  endpoint: v.pipe(v.string(), v.url()),
  metricsEndpoint: v.optional(v.pipe(v.string(), v.url())),
  logsEndpoint: v.optional(v.pipe(v.string(), v.url())),
  headers: StringRecordSchema,
  metricExportIntervalMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  logsExportIntervalMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  metricsTemporality: TemporalitySchema,
  resourceAttributes: StringRecordSchema,
  logUserPrompts: v.boolean(),
  logToolDetails: v.boolean(),
  includeSessionId: v.boolean(),
  includeVersion: v.boolean(),
  includeAccountUuid: v.boolean(),
  telemetryProfile: TelemetryProfileSchema,
})

// ---------------------------------------------------------------------------
// Derived types (from schemas — single source of truth)
// ---------------------------------------------------------------------------

export type ExporterType = v.InferOutput<typeof ExporterTypeSchema>
export type OtelProtocol = v.InferOutput<typeof OtelProtocolSchema>
export type TelemetryProfile = v.InferOutput<typeof TelemetryProfileSchema>
export type OtelJsonConfig = v.InferOutput<typeof JsonConfigSchema>
export type OtelConfig = v.InferOutput<typeof OtelConfigSchema>

// ---------------------------------------------------------------------------
// Config validation error
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  constructor(
    public readonly source: string,
    public readonly issues: v.BaseIssue<unknown>[],
  ) {
    const details = issues
      .map((issue) => {
        const path = issue.path?.map((p) => p.key).join(".") ?? "(root)"
        return `  - ${path}: ${issue.message}`
      })
      .join("\n")
    super(`Invalid config from ${source}:\n${details}`)
    this.name = "ConfigValidationError"
  }
}

// ---------------------------------------------------------------------------
// JSON file loader
// ---------------------------------------------------------------------------

async function loadJsonConfig(): Promise<OtelJsonConfig> {
  const envPath = process.env.OPENCODE_OTEL_CONFIG_PATH

  const candidates: string[] = []
  if (envPath) {
    candidates.push(envPath)
  }
  candidates.push(join(homedir(), ".config", "opencode", "otel.json"))

  for (const filePath of candidates) {
    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Failed to parse JSON at ${filePath}`)
    }

    const result = v.safeParse(JsonConfigSchema, parsed)
    if (!result.success) {
      throw new ConfigValidationError(filePath, result.issues)
    }

    return result.output
  }

  return {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate the OTEL config from the JSON config file.
 *
 * Returns `undefined` if no endpoint is configured (telemetry disabled).
 * Throws `ConfigValidationError` if the JSON file has invalid fields.
 * Throws `Error` if the final config is invalid (e.g. bad endpoint URL).
 */
export async function loadConfig(): Promise<OtelConfig | undefined> {
  const json = await loadJsonConfig()

  if (!json.endpoint) {
    return undefined
  }

  const resolved = {
    metricsExporter: json.metricsExporter ?? "otlp",
    logsExporter: json.logsExporter ?? "otlp",
    protocol: json.protocol ?? "grpc",
    endpoint: json.endpoint,
    metricsEndpoint: json.metricsEndpoint,
    logsEndpoint: json.logsEndpoint,
    headers: json.headers ?? {},
    metricExportIntervalMs: json.metricExportIntervalMs ?? 60000,
    logsExportIntervalMs: json.logsExportIntervalMs ?? 5000,
    metricsTemporality: json.metricsTemporality ?? "delta",
    resourceAttributes: json.resourceAttributes ?? {},
    logUserPrompts: json.logUserPrompts ?? false,
    logToolDetails: json.logToolDetails ?? false,
    includeSessionId: json.includeSessionId ?? true,
    includeVersion: json.includeVersion ?? false,
    includeAccountUuid: json.includeAccountUuid ?? true,
    telemetryProfile: json.telemetryProfile ?? "opencode",
  }

  // Final validation
  const result = v.safeParse(OtelConfigSchema, resolved)
  if (!result.success) {
    throw new ConfigValidationError("config file", result.issues)
  }

  return result.output
}
