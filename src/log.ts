/**
 * Structured logging via the OpenCode SDK client.
 *
 * Uses `client.app.log()` so messages appear in OpenCode's log files
 * (`~/.local/share/opencode/log/`) instead of being swallowed by console.
 */

import type { PluginInput } from "@opencode-ai/plugin"

const SERVICE = "opencode-otel"

type Level = "debug" | "info" | "warn" | "error"
type Client = PluginInput["client"]

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export function createLogger(client: Client): Logger {
  function log(level: Level, message: string, extra?: Record<string, unknown>) {
    // Fire-and-forget — logging must never block or throw
    client.app.log({
      body: { service: SERVICE, level, message, extra },
    }).catch(() => {})
  }

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  }
}
