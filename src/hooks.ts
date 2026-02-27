/**
 * Plugin hooks — wires OpenCode events to OTEL metrics and log events.
 *
 * All hook types (server events, tool execution, chat messages, commands)
 * are unified through a single `handleEvent` dispatcher. Each hook in
 * index.ts packages its input into a `{ type, properties }` event and
 * delegates here.
 */

import { randomUUID } from "crypto"
import type { Attributes } from "@opentelemetry/api"
import type { OtelConfig } from "./config.js"
import type { TelemetryContext } from "./telemetry.js"
import type { Logger } from "./log.js"
import { detectTerminal, getUserId } from "./runtime.js"

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string
  startedAt: number
  lastActivityAt: number
}

interface ToolCallState {
  tool: string
  startedAt: number
  args: unknown
}

export interface HookState {
  config: OtelConfig
  telemetry: TelemetryContext
  log: Logger
  sessions: Map<string, SessionState>
  pendingToolCalls: Map<string, ToolCallState> // keyed by callID
  eventSequence: number
  /** Runtime toggle — when false, telemetry emission is skipped. */
  enabled: boolean
  /** Persistent anonymous user ID (64-char hex, matches Claude Code format). */
  userId: string
  /** Detected terminal type (e.g. "vscode", "zed", "tmux"). */
  terminalType: string | undefined
  /** Current prompt ID (randomUUID, set per user prompt). */
  promptId: string | undefined
}

export function createHookState(config: OtelConfig, telemetry: TelemetryContext, log: Logger): HookState {
  return {
    config,
    telemetry,
    log,
    sessions: new Map(),
    pendingToolCalls: new Map(),
    eventSequence: 0,
    enabled: true,
    userId: getUserId(),
    terminalType: detectTerminal(),
    promptId: undefined,
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Common attributes added to every metric data point and log event.
 * Mirrors Claude Code's `AG6()` function.
 */
function commonAttributes(state: HookState, sessionId?: string): Attributes {
  const attrs: Attributes = {
    "user.id": state.userId,
  }
  if (sessionId && state.config.includeSessionId) {
    attrs["session.id"] = sessionId
  }
  if (state.terminalType) {
    attrs["terminal.type"] = state.terminalType
  }
  if (state.config.includeVersion) {
    attrs["app.version"] = "0.1.0"
  }
  return attrs
}

function eventAttributes(state: HookState, sessionId?: string): Attributes {
  state.eventSequence++
  const attrs: Attributes = {
    ...commonAttributes(state, sessionId),
    "event.timestamp": new Date().toISOString(),
    "event.sequence": state.eventSequence,
  }
  if (state.promptId) {
    attrs["prompt.id"] = state.promptId
  }
  return attrs
}

// ---------------------------------------------------------------------------
// /otel command name
// ---------------------------------------------------------------------------

/** Name of the slash command this plugin intercepts. */
export const OTEL_COMMAND_NAME = "otel"

// ---------------------------------------------------------------------------
// Unified event handler
// ---------------------------------------------------------------------------

/**
 * Result returned by `handleEvent` for events that need the caller to
 * perform side-effects (e.g. show a toast).
 */
export interface HandleEventResult {
  /** Present when the /otel toggle command was handled. */
  otelToggled?: { enabled: boolean }
}

/**
 * Central dispatcher — every hook type is routed here as a
 * `{ type, properties }` event.
 *
 * Synthetic event types used by index.ts:
 *   - "command.execute.before" — slash command interception
 *   - "tool.execute.before"   — tool call start
 *   - "tool.execute.after"    — tool call end
 *   - "chat.message"          — user prompt
 *
 * Server-pushed event types (forwarded as-is):
 *   - "session.created", "session.idle", "session.status"
 *   - "file.edited", "message.part.updated", …
 */
export function handleEvent(
  state: HookState,
  event: { type: string; properties?: any },
): HandleEventResult | undefined {
  // --- Command interception (always processed, even when disabled) ---
  if (event.type === "command.execute.before") {
    return handleCommandBefore(state, event.properties)
  }

  // --- Skip everything else when telemetry is disabled ---
  if (!state.enabled) return

  const { telemetry } = state
  const props = event.properties ?? {}

  switch (event.type) {
    // --- Session lifecycle ---
    case "session.created": {
      const sessionId = props.info?.id ?? props.id
      if (sessionId) {
        state.sessions.set(sessionId, {
          sessionId,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
        })
        telemetry.metrics.sessionCount.add(1, commonAttributes(state, sessionId))
        telemetry.emitEvent(`${telemetry.prefix}.session.created`, "session.created", {
          ...eventAttributes(state, sessionId),
          "session.title": props.info?.title ?? "",
        })
        state.log.debug("session.created", { sessionId })
      }
      break
    }

    case "session.idle": {
      const sessionId = props.info?.id ?? props.id ?? props.sessionID
      const session = sessionId ? state.sessions.get(sessionId) : undefined
      if (session) {
        const activeSeconds = (Date.now() - session.lastActivityAt) / 1000
        telemetry.metrics.activeTime.add(activeSeconds, {
          ...commonAttributes(state, sessionId),
        })
        session.lastActivityAt = Date.now()
      }
      break
    }

    case "session.status": {
      const sessionId = props.info?.id ?? props.id ?? props.sessionID
      const session = sessionId ? state.sessions.get(sessionId) : undefined
      if (session) {
        session.lastActivityAt = Date.now()
      }
      break
    }

    // --- File edits (lines of code) ---
    case "file.edited": {
      const added = props.linesAdded ?? props.added ?? 0
      const removed = props.linesRemoved ?? props.removed ?? 0
      if (added > 0) {
        telemetry.metrics.linesOfCode.add(added, {
          ...commonAttributes(state),
          type: "added",
        })
      }
      if (removed > 0) {
        telemetry.metrics.linesOfCode.add(removed, {
          ...commonAttributes(state),
          type: "removed",
        })
      }
      break
    }

    // --- Message parts (token/cost tracking) ---
    case "message.part.updated": {
      const part = props.part ?? props
      if (part.type === "step-start" || part.type === "step-finish") {
        const usage = part.usage ?? part.metadata?.usage
        if (usage) {
          const sessionId = part.sessionID ?? props.sessionID
          const model = part.model ?? part.metadata?.model ?? "unknown"
          if (usage.promptTokens || usage.inputTokens) {
            telemetry.metrics.tokenUsage.add(usage.promptTokens ?? usage.inputTokens ?? 0, {
              ...commonAttributes(state, sessionId),
              type: "input",
              model,
            })
          }
          if (usage.completionTokens || usage.outputTokens) {
            telemetry.metrics.tokenUsage.add(
              usage.completionTokens ?? usage.outputTokens ?? 0,
              {
                ...commonAttributes(state, sessionId),
                type: "output",
                model,
              },
            )
          }
          if (usage.cacheReadTokens) {
            telemetry.metrics.tokenUsage.add(usage.cacheReadTokens, {
              ...commonAttributes(state, sessionId),
              type: "cacheRead",
              model,
            })
          }
          if (usage.cacheCreationTokens) {
            telemetry.metrics.tokenUsage.add(usage.cacheCreationTokens, {
              ...commonAttributes(state, sessionId),
              type: "cacheCreation",
              model,
            })
          }

          const cost = part.cost ?? part.metadata?.cost ?? usage.cost
          if (cost !== undefined && cost !== null) {
            telemetry.metrics.costUsage.add(typeof cost === "number" ? cost : 0, {
              ...commonAttributes(state, sessionId),
              model,
            })
          }

          // Determine request speed — Claude Code uses "fast" vs "normal" based on model
          const duration = part.duration ?? part.metadata?.duration
          const durationMs = typeof duration === "number" ? duration : 0
          const speed = part.speed ?? part.metadata?.speed ?? "normal"

          telemetry.emitEvent(`${telemetry.prefix}.api_request`, "api_request", {
            ...eventAttributes(state, sessionId),
            model,
            "input_tokens": usage.promptTokens ?? usage.inputTokens ?? 0,
            "output_tokens": usage.completionTokens ?? usage.outputTokens ?? 0,
            "cache_read_tokens": usage.cacheReadTokens ?? 0,
            "cache_creation_tokens": usage.cacheCreationTokens ?? 0,
            "cost_usd": typeof cost === "number" ? cost : 0,
            "duration_ms": durationMs,
            "speed": speed,
          })
          state.log.debug("api_request emitted", {
            model,
            inputTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
            outputTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
          })
        }
      }
      break
    }

    // --- Tool execution (before) ---
    case "tool.execute.before": {
      const { tool, sessionID, callID, args } = props
      state.pendingToolCalls.set(callID, {
        tool,
        startedAt: Date.now(),
        args,
      })
      telemetry.metrics.toolDecision.add(1, {
        ...commonAttributes(state, sessionID),
        tool_name: tool,
        decision: "execute",
      })
      break
    }

    // --- Tool execution (after) ---
    case "tool.execute.after": {
      const { tool, sessionID, callID, args, title, output, metadata } = props
      const pending = state.pendingToolCalls.get(callID)
      const durationMs = pending ? Date.now() - pending.startedAt : 0
      state.pendingToolCalls.delete(callID)

      // Detect git operations for commit/PR metrics
      if (tool === "bash") {
        const cmd = typeof args === "object" && args !== null
          ? (args as Record<string, unknown>).command
          : undefined
        if (typeof cmd === "string") {
          if (/\bgit\s+commit\b/.test(cmd)) {
            telemetry.metrics.commitCount.add(1, commonAttributes(state, sessionID))
          }
          if (/\bgh\s+pr\s+create\b/.test(cmd) || /\bgit\s+push\b.*--.*pull-request/.test(cmd)) {
            telemetry.metrics.pullRequestCount.add(1, commonAttributes(state, sessionID))
          }
        }
      }

      // Detect file edits from write/edit tools
      if (tool === "write" || tool === "edit") {
        const outStr = typeof output === "string" ? output : ""
        const lines = outStr.split("\n").length
        if (lines > 0) {
          telemetry.metrics.linesOfCode.add(lines, {
            ...commonAttributes(state, sessionID),
            type: tool === "write" ? "added" : "modified",
          })
        }
      }

      // Emit tool_result event
      const eventAttrs: Attributes = {
        ...eventAttributes(state, sessionID),
        "tool_name": state.config.logToolDetails ? tool : "redacted",
        "duration_ms": durationMs,
        "success": !output?.includes("Error"),
      }
      if (state.config.logToolDetails) {
        eventAttrs["tool_args"] = JSON.stringify(args ?? {}).slice(0, 2048)
        eventAttrs["tool_result_size_bytes"] =
          typeof output === "string" ? output.length : 0
      }

      telemetry.emitEvent(`${telemetry.prefix}.tool_result`, "tool_result", eventAttrs)
      state.log.debug("tool_result emitted", { tool, durationMs })
      break
    }

    // --- Chat message (user prompt) ---
    case "chat.message": {
      const { sessionID, agent, model, parts } = props
      const promptText = (parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n")

      // Generate a new prompt ID for this user prompt (matches Claude Code's randomUUID())
      state.promptId = randomUUID()

      const attrs: Attributes = {
        ...eventAttributes(state, sessionID),
        "prompt_length": promptText.length,
      }
      if (agent) attrs["agent"] = agent
      if (model) {
        attrs["model.provider"] = model.providerID
        attrs["model.id"] = model.modelID
      }
      if (state.config.logUserPrompts) {
        attrs["prompt"] = promptText.slice(0, 4096)
      }

      telemetry.emitEvent(`${telemetry.prefix}.user_prompt`, "user_prompt", attrs)
      state.log.debug("user_prompt emitted", {
        promptLength: promptText.length,
        agent,
      })
      break
    }

    default:
      // Unhandled event types are silently ignored
      break
  }
}

// ---------------------------------------------------------------------------
// Command handler (internal)
// ---------------------------------------------------------------------------

function handleCommandBefore(
  state: HookState,
  props: { command: string; arguments: string },
): HandleEventResult | undefined {
  if (props.command !== OTEL_COMMAND_NAME) return

  const arg = props.arguments.trim().toLowerCase()

  if (arg === "on") {
    state.enabled = true
  } else if (arg === "off") {
    state.enabled = false
  } else {
    // No argument or unknown argument → toggle
    state.enabled = !state.enabled
  }

  const status = state.enabled ? "enabled" : "disabled"
  state.log.info(`telemetry ${status} via /otel command`)
  state.telemetry.emitEvent(`${state.telemetry.prefix}.telemetry.toggled`, "telemetry.toggled", {
    "telemetry.enabled": state.enabled,
  })

  return { otelToggled: { enabled: state.enabled } }
}
