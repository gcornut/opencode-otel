/**
 * Configuration module — loads from JSON file and/or env vars.
 *
 * Resolution order (highest priority wins):
 *   1. Environment variables (OTEL_*)     — parsed & validated by EnvConfigSchema
 *   2. JSON config file                   — parsed & validated by JsonConfigSchema
 *   3. Built-in defaults
 *
 * JSON config is loaded from (first found wins):
 *   - $OPENCODE_OTEL_CONFIG_PATH      (env var override)
 *   - ~/.config/opencode/otel.json    (standard location)
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
// Env var coercion helpers (string -> typed value)
// ---------------------------------------------------------------------------

/** Env var that's a non-empty string or undefined. */
const envString = v.pipe(
  v.optional(v.string()),
  v.transform((val) => (val === "" ? undefined : val)),
)

/** Env var coerced to boolean: "true"|"1" -> true, "false"|"0" -> false. */
const envBoolean = v.pipe(
  v.optional(v.string()),
  v.transform((val) => {
    if (val === undefined || val === "") return undefined
    if (val === "true" || val === "1") return true
    if (val === "false" || val === "0") return false
    return undefined
  }),
)

/** Env var coerced to positive integer. */
const envPositiveInt = v.pipe(
  v.optional(v.string()),
  v.transform((val) => {
    if (val === undefined || val === "") return undefined
    const n = parseInt(val, 10)
    return Number.isNaN(n) || n < 1 ? undefined : n
  }),
)

/** Env var parsed as comma-separated key=value pairs into a Record. */
const envKeyValuePairs = v.pipe(
  v.optional(v.string()),
  v.transform((raw): Record<string, string> | undefined => {
    if (raw === undefined || raw === "") return undefined
    const result: Record<string, string> = {}
    let hasAny = false
    for (const pair of raw.split(",")) {
      const eqIdx = pair.indexOf("=")
      if (eqIdx === -1) continue
      const key = pair.slice(0, eqIdx).trim()
      const value = pair.slice(eqIdx + 1).trim()
      if (key) {
        result[key] = value
        hasAny = true
      }
    }
    return hasAny ? result : undefined
  }),
)

/** Env var validated as a picklist after reading as string. */
function envPicklist<const T extends string>(options: readonly T[]) {
  return v.pipe(
    v.optional(v.string()),
    v.transform((val): T | undefined => {
      if (val === undefined || val === "") return undefined
      return (options as readonly string[]).includes(val) ? (val as T) : undefined
    }),
  )
}

// ---------------------------------------------------------------------------
// Env config schema — reads raw process.env, coerces & validates
// ---------------------------------------------------------------------------

const EnvConfigSchema = v.object({
  OTEL_METRICS_EXPORTER: envPicklist(["otlp", "console", "none"]),
  OTEL_LOGS_EXPORTER: envPicklist(["otlp", "console", "none"]),
  OTEL_EXPORTER_OTLP_PROTOCOL: envPicklist(["grpc", "http/json", "http/protobuf"]),
  OTEL_EXPORTER_OTLP_ENDPOINT: envString,
  OTEL_EXPORTER_OTLP_HEADERS: envKeyValuePairs,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: envString,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: envString,
  OTEL_METRIC_EXPORT_INTERVAL: envPositiveInt,
  OTEL_LOGS_EXPORT_INTERVAL: envPositiveInt,
  OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: envPicklist(["delta", "cumulative"]),
  OTEL_RESOURCE_ATTRIBUTES: envKeyValuePairs,
  OTEL_LOG_USER_PROMPTS: envBoolean,
  OTEL_LOG_TOOL_DETAILS: envBoolean,
  OTEL_METRICS_INCLUDE_SESSION_ID: envBoolean,
  OTEL_METRICS_INCLUDE_VERSION: envBoolean,
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: envBoolean,
  OTEL_TELEMETRY_PROFILE: envPicklist(["opencode", "claude-code"]),
})

type EnvConfig = v.InferOutput<typeof EnvConfigSchema>

// ---------------------------------------------------------------------------
// JSON file schema — all fields optional, typed natively
// ---------------------------------------------------------------------------

export const JsonConfigSchema = v.object({
  metricsExporter: v.optional(ExporterTypeSchema),
  logsExporter: v.optional(ExporterTypeSchema),
  protocol: v.optional(OtelProtocolSchema),
  endpoint: v.optional(v.pipe(v.string(), v.url())),
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
// Env var loader
// ---------------------------------------------------------------------------

function loadEnvConfig(): EnvConfig {
  // safeParse never fails here — transforms coerce bad values to undefined
  const result = v.parse(EnvConfigSchema, process.env)
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, merge, and validate the full OTEL config.
 *
 * Throws `ConfigValidationError` if the JSON file has invalid fields.
 * Throws `Error` if the final merged config is invalid (e.g. bad endpoint URL).
 */
export async function loadConfig(): Promise<OtelConfig | undefined> {
  const json = await loadJsonConfig()
  const env = loadEnvConfig()

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? json.endpoint
  if (!endpoint) {
    return undefined
  }

  const protocol =
    env.OTEL_EXPORTER_OTLP_PROTOCOL ?? json.protocol ?? "grpc"

  const resolved = {
    metricsExporter:
      env.OTEL_METRICS_EXPORTER ?? json.metricsExporter ?? "otlp",
    logsExporter:
      env.OTEL_LOGS_EXPORTER ?? json.logsExporter ?? "otlp",

    protocol,
    endpoint,
    // Headers & resource attributes: merge both sources (env wins per-key)
    headers: { ...(json.headers ?? {}), ...(env.OTEL_EXPORTER_OTLP_HEADERS ?? {}) },

    metricExportIntervalMs:
      env.OTEL_METRIC_EXPORT_INTERVAL ?? json.metricExportIntervalMs ?? 60000,
    logsExportIntervalMs:
      env.OTEL_LOGS_EXPORT_INTERVAL ?? json.logsExportIntervalMs ?? 5000,
    metricsTemporality:
      env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ?? json.metricsTemporality ?? "delta",

    resourceAttributes: { ...(json.resourceAttributes ?? {}), ...(env.OTEL_RESOURCE_ATTRIBUTES ?? {}) },

    logUserPrompts:
      env.OTEL_LOG_USER_PROMPTS ?? json.logUserPrompts ?? false,
    logToolDetails:
      env.OTEL_LOG_TOOL_DETAILS ?? json.logToolDetails ?? false,

    includeSessionId:
      env.OTEL_METRICS_INCLUDE_SESSION_ID ?? json.includeSessionId ?? true,
    includeVersion:
      env.OTEL_METRICS_INCLUDE_VERSION ?? json.includeVersion ?? false,
    includeAccountUuid:
      env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID ?? json.includeAccountUuid ?? true,

    telemetryProfile:
      env.OTEL_TELEMETRY_PROFILE ?? json.telemetryProfile ?? "opencode",
  }

  // Final validation of the merged result
  const result = v.safeParse(OtelConfigSchema, resolved)
  if (!result.success) {
    throw new ConfigValidationError("merged config (env + JSON)", result.issues)
  }

  return result.output
}
