/**
 * opencode-otel — OpenTelemetry plugin for OpenCode
 *
 * Mirrors Claude Code's telemetry surface: exports metrics and structured
 * log events to an OTEL collector via OTLP (gRPC or HTTP).
 *
 * Enable by adding "opencode-otel" to your opencode.json plugins array
 * and setting the standard OTEL_* env vars.
 *
 * See README.md for full configuration reference.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { initTelemetry } from "./telemetry.js"
import { createLogger } from "./log.js"
import {
  createHookState,
  handleEvent,
  handleToolBefore,
  handleToolAfter,
  handleChatMessage,
} from "./hooks.js"

export const OpenCodeOtelPlugin: Plugin = async (ctx) => {
  const log = createLogger(ctx.client)

  log.info("loading plugin")

  let config
  try {
    config = loadConfig()
  } catch (e) {
    log.error("failed to load config", {
      error: e instanceof Error ? e.message : String(e),
    })
    return {}
  }

  // If no endpoint is configured, warn and disable telemetry
  if (!config) {
    log.warn(
      "no OTLP endpoint configured — set OTEL_EXPORTER_OTLP_ENDPOINT or add " +
      '"endpoint" to ~/.config/opencode/otel.json. Telemetry disabled.',
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

  const telemetry = initTelemetry(config)
  const state = createHookState(config, telemetry, log)

  // Log plugin startup as OTEL event
  telemetry.emitEvent(`${telemetry.prefix}.plugin.started`, {
    "plugin.name": "opencode-otel",
    "plugin.version": "0.1.0",
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

  return {
    // -----------------------------------------------------------------------
    // Global event listener — catches session lifecycle, file edits,
    // message parts (for token/cost tracking), and more.
    // -----------------------------------------------------------------------
    event: async ({ event }) => {
      try {
        handleEvent(state, event as { type: string; properties?: any })
      } catch (e) {
        log.error("error in event hook", {
          eventType: (event as any)?.type,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },

    // -----------------------------------------------------------------------
    // Chat message — track user prompts
    // -----------------------------------------------------------------------
    "chat.message": async (input, output) => {
      try {
        handleChatMessage(
          state,
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
          },
          output.parts as Array<{ type: string; text?: string }>,
        )
      } catch (e) {
        log.error("error in chat.message hook", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },

    // -----------------------------------------------------------------------
    // Tool execution tracking
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input, output) => {
      try {
        handleToolBefore(
          state,
          {
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
          },
          output.args,
        )
      } catch (e) {
        log.error("error in tool.execute.before hook", {
          tool: input.tool,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        handleToolAfter(
          state,
          {
            tool: input.tool,
            sessionID: input.sessionID,
            callID: input.callID,
            args: input.args,
          },
          {
            title: output.title,
            output: output.output,
            metadata: output.metadata,
          },
        )
      } catch (e) {
        log.error("error in tool.execute.after hook", {
          tool: input.tool,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },
  }
}

export default OpenCodeOtelPlugin
