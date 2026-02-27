/**
 * opencode-otel — OpenTelemetry plugin for OpenCode
 *
 * Mirrors Claude Code's telemetry surface: exports metrics and structured
 * log events to an OTEL collector via OTLP (gRPC or HTTP).
 *
 * Enable by adding "opencode-otel" to your opencode.json plugins array
 * and creating a config file at ~/.config/opencode/otel.json.
 *
 * See README.md for full configuration reference.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { initTelemetry } from "./telemetry.js"
import { createLogger } from "./log.js"
import { createHookState, handleEvent } from "./hooks.js"

export const OpenCodeOtelPlugin: Plugin = async (ctx) => {
  const log = createLogger(ctx.client)

  log.info("loading plugin")

  let config
  try {
    config = await loadConfig()
  } catch (e) {
    log.error("failed to load config", {
      error: e instanceof Error ? e.message : String(e),
    })
    return {}
  }

  // If no endpoint is configured, warn and disable telemetry
  if (!config) {
    log.warn(
      'no OTLP endpoint configured — add "endpoint" to ' +
      "~/.config/opencode/otel.json. Telemetry disabled.",
    )
    return {}
  }

  // If both exporters are disabled, return empty hooks (no-op)
  if (config.metricsExporter === "none" && config.logsExporter === "none") {
    log.info("both exporters set to 'none', telemetry disabled")
    return {}
  }

  log.info("initializing telemetry", {
    profile: config.telemetryProfile,
    metricsExporter: config.metricsExporter,
    logsExporter: config.logsExporter,
    protocol: config.protocol,
    endpoint: config.endpoint,
  })

  const telemetry = initTelemetry(config, log)
  const state = createHookState(config, telemetry, log)

  // Log plugin startup as OTEL event
  telemetry.emitEvent(`${telemetry.prefix}.plugin.started`, "plugin.started", {
    "plugin.name": "opencode-otel",
    "plugin.version": "0.2.0",
    "otel.metrics_exporter": config.metricsExporter,
    "otel.logs_exporter": config.logsExporter,
    "otel.protocol": config.protocol,
    "otel.endpoint": config.endpoint,
  })

  log.info("plugin started, hooks registered")

  // Register shutdown handler for clean teardown
  process.on("beforeExit", async () => {
    log.info("shutting down telemetry")
    await telemetry.shutdown()
  })

  /** Shared error handler for all hooks. */
  function onError(hook: string, e: unknown, extra?: Record<string, unknown>) {
    log.error(`error in ${hook} hook`, {
      ...extra,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  return {
    // -----------------------------------------------------------------------
    // Command interceptor — handles /otel toggle command
    // -----------------------------------------------------------------------
    "command.execute.before": async (input, _output) => {
      try {
        const result = handleEvent(state, {
          type: "command.execute.before",
          properties: { command: input.command, arguments: input.arguments },
        })
        if (result?.otelToggled) {
          const status = result.otelToggled.enabled ? "enabled" : "disabled"
          const variant = result.otelToggled.enabled ? "success" : "warning"
          await (ctx.client.tui as any).showToast({
            body: { title: "OpenTelemetry", message: `Telemetry ${status}`, variant, duration: 3000 },
          })
        }
      } catch (e) {
        onError("command.execute.before", e, { command: input.command })
      }
    },

    // -----------------------------------------------------------------------
    // Global event listener — catches session lifecycle, file edits,
    // message parts (for token/cost tracking), and more.
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      try {
        handleEvent(state, event as { type: string; properties?: any })
      } catch (e) {
        onError("event", e, { eventType: (event as any)?.type })
      }
    },

    // -----------------------------------------------------------------------
    // Chat message — track user prompts
    // -----------------------------------------------------------------------
    "chat.message": async (input, output) => {
      try {
        handleEvent(state, {
          type: "chat.message",
          properties: {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            parts: output.parts,
          },
        })
      } catch (e) {
        onError("chat.message", e)
      }
    },

    // -----------------------------------------------------------------------
    // Tool execution tracking
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input, output) => {
      try {
        handleEvent(state, {
          type: "tool.execute.before",
          properties: {
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            args: output.args,
          },
        })
      } catch (e) {
        onError("tool.execute.before", e, { tool: input.tool })
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        handleEvent(state, {
          type: "tool.execute.after",
          properties: {
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            args: input.args,
            title: output.title,
            output: output.output,
            metadata: output.metadata,
          },
        })
      } catch (e) {
        onError("tool.execute.after", e, { tool: input.tool })
      }
    },
  }
}

export default OpenCodeOtelPlugin
