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
  /** Set of message IDs that have already had their api_request event emitted
   *  via message.updated, so we can skip duplicate emission from step-finish parts. */
  emittedMessageIds: Set<string>
  eventSequence: number
  /** Runtime toggle — when false, telemetry emission is skipped. */
  enabled: boolean
  /** Persistent anonymous user ID (64-char hex, matches Claude Code format). */
  userId: string
  /** Detected terminal type (e.g. "vscode", "zed", "tmux"). */
  terminalType: string | undefined
  /** Current prompt ID (randomUUID, set per user prompt). */
  promptId: string | undefined
  /** OpenCode version, captured from the first session.created event. */
  opencodeVersion: string | undefined
}

export function createHookState(config: OtelConfig, telemetry: TelemetryContext, log: Logger): HookState {
  return {
    config,
    telemetry,
    log,
    sessions: new Map(),
    pendingToolCalls: new Map(),
    emittedMessageIds: new Set(),
    eventSequence: 0,
    enabled: true,
    userId: getUserId(),
    terminalType: detectTerminal(),
    promptId: undefined,
    opencodeVersion: undefined,
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
  const seq = state.eventSequence
  state.eventSequence++
  const attrs: Attributes = {
    ...commonAttributes(state, sessionId),
    "event.timestamp": new Date().toISOString(),
    "event.sequence": seq,
  }
  if (state.promptId) {
    attrs["prompt.id"] = state.promptId
  }
  return attrs
}

/**
 * Convert numeric attribute values to strings.
 * Claude Code's Go SDK serializes all event attribute values as strings,
 * while the Node.js SDK preserves native types (intValue, doubleValue).
 * This helper converts numeric values to match Claude Code's wire format.
 */
function stringifyNumericAttrs(attrs: Attributes): Attributes {
  const result: Attributes = {}
  for (const [k, v] of Object.entries(attrs)) {
    result[k] = typeof v === "number" ? String(v) : v
  }
  return result
}

// ---------------------------------------------------------------------------
// Token metrics helper
// ---------------------------------------------------------------------------

/**
 * Emit token usage metrics from a tokens object.
 * Works with both StepFinishPart.tokens and AssistantMessage.tokens format:
 *   { input, output, reasoning?, cache: { read, write } }
 */
function emitTokenMetrics(
  state: HookState,
  sessionId: string | undefined,
  tokens: { input?: number; output?: number; cache?: { read?: number; write?: number } },
  model: string,
): void {
  const { telemetry } = state
  if (tokens.input) {
    telemetry.metrics.tokenUsage.add(tokens.input, {
      ...commonAttributes(state, sessionId),
      type: "input",
      model,
    })
  }
  if (tokens.output) {
    telemetry.metrics.tokenUsage.add(tokens.output, {
      ...commonAttributes(state, sessionId),
      type: "output",
      model,
    })
  }
  if (tokens.cache?.read) {
    telemetry.metrics.tokenUsage.add(tokens.cache.read, {
      ...commonAttributes(state, sessionId),
      type: "cacheRead",
      model,
    })
  }
  if (tokens.cache?.write) {
    telemetry.metrics.tokenUsage.add(tokens.cache.write, {
      ...commonAttributes(state, sessionId),
      type: "cacheCreation",
      model,
    })
  }
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
        // Capture OpenCode version from the Session object
        if (!state.opencodeVersion && props.info?.version) {
          state.opencodeVersion = props.info.version
        }
        telemetry.metrics.sessionCount.add(1, commonAttributes(state, sessionId))
        // Claude Code does not emit a session.created log event — only the metric.
        // Skip this event in claude-code profile to match.
        if (telemetry.profile !== "claude-code") {
          telemetry.emitEvent(`${telemetry.prefix}.session.created`, "session.created", {
            ...eventAttributes(state, sessionId),
            "session.title": props.info?.title ?? "",
          })
        }
        state.log.debug("session.created", { sessionId })
      }
      break
    }

    case "session.idle": {
      const sessionId = props.info?.id ?? props.id ?? props.sessionID
      const session = sessionId ? state.sessions.get(sessionId) : undefined
      if (session) {
        const activeSeconds = (Date.now() - session.lastActivityAt) / 1000
        // Only emit non-zero active time to avoid noise
        if (activeSeconds > 0) {
          telemetry.metrics.activeTime.add(activeSeconds, {
            ...commonAttributes(state, sessionId),
          })
        }
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

    // --- Message parts (retry error tracking) ---
    case "message.part.updated": {
      const part = props.part ?? props

      // Handle retry parts — emit api_error event
      if (part.type === "retry") {
        const sessionId = part.sessionID ?? props.sessionID
        const error = part.error
        const errorPayload: Attributes = {
          "error.name": error?.name ?? "APIError",
          "error.message": error?.data?.message ?? "unknown",
          "attempt": part.attempt ?? 0,
        }
        if (error?.data?.statusCode) {
          errorPayload["error.status_code"] = error.data.statusCode
        }
        if (error?.data?.isRetryable !== undefined) {
          errorPayload["error.is_retryable"] = error.data.isRetryable
        }
        telemetry.emitEvent(
          `${telemetry.prefix}.api_error`,
          "api_error",
          {
            ...eventAttributes(state, sessionId),
            ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(errorPayload) : errorPayload),
          },
        )
        state.log.debug("api_error emitted (retry part)", {
          attempt: part.attempt,
          error: error?.data?.message,
        })
      }

      break
    }

    // --- Message updated (authoritative token/cost source) ---
    case "message.updated": {
      const msg = props.info
      // Only process assistant messages (they have tokens/cost)
      if (!msg || msg.role !== "assistant") break
      const sessionId = msg.sessionID
      const messageId = msg.id
      const model = msg.modelID ?? "unknown"
      const tokens = msg.tokens
      const cost = msg.cost

      // Only emit once per message, and only when complete
      if (!tokens || state.emittedMessageIds.has(messageId)) break
      if (msg.time?.completed === undefined) break

      state.emittedMessageIds.add(messageId)

      // Token metrics
      emitTokenMetrics(state, sessionId, tokens, model)

      // Cost metric
      if (typeof cost === "number" && cost > 0) {
        telemetry.metrics.costUsage.add(cost, {
          ...commonAttributes(state, sessionId),
          model,
        })
      }

      // Compute duration from time.created → time.completed
      const durationMs = (msg.time.completed && msg.time.created)
        ? msg.time.completed - msg.time.created
        : 0

      // api_request event
      const apiPayload: Attributes = {
        model,
        "input_tokens": tokens.input ?? 0,
        "output_tokens": tokens.output ?? 0,
        "cache_read_tokens": tokens.cache?.read ?? 0,
        "cache_creation_tokens": tokens.cache?.write ?? 0,
        "cost_usd": typeof cost === "number" ? cost : 0,
        "duration_ms": durationMs,
        "speed": "normal",
      }
      telemetry.emitEvent(
        `${telemetry.prefix}.api_request`,
        "api_request",
        {
          ...eventAttributes(state, sessionId),
          ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(apiPayload) : apiPayload),
        },
      )

      // Emit api_error event if the message has an error
      if (msg.error) {
        const errorPayload: Attributes = {
          "error.name": msg.error.name ?? "UnknownError",
          "error.message": msg.error.data?.message ?? "unknown",
        }
        if (msg.error.data?.statusCode) {
          errorPayload["error.status_code"] = msg.error.data.statusCode
        }
        telemetry.emitEvent(
          `${telemetry.prefix}.api_error`,
          "api_error",
          {
            ...eventAttributes(state, sessionId),
            ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(errorPayload) : errorPayload),
          },
        )
      }

      state.log.debug("api_request emitted (message.updated)", {
        model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cost,
      })
      break
    }

    // --- Session error (API errors, auth errors, etc.) ---
    case "session.error": {
      const sessionId = props.sessionID
      const error = props.error
      if (error) {
        const errorPayload: Attributes = {
          "error.name": error.name ?? "UnknownError",
          "error.message": error.data?.message ?? "unknown",
        }
        if (error.data?.statusCode) {
          errorPayload["error.status_code"] = error.data.statusCode
        }
        if (error.data?.isRetryable !== undefined) {
          errorPayload["error.is_retryable"] = error.data.isRetryable
        }
        telemetry.emitEvent(
          `${telemetry.prefix}.api_error`,
          "api_error",
          {
            ...eventAttributes(state, sessionId),
            ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(errorPayload) : errorPayload),
          },
        )
        state.log.debug("api_error emitted (session.error)", {
          name: error.name,
          message: error.data?.message,
        })
      }
      break
    }

    // --- Permission replied (tool accept/reject decisions) ---
    case "permission.replied": {
      const { sessionID, permissionID, response } = props
      // Map response to decision: "once"/"always" → accept, everything else → reject
      const decision = (response === "once" || response === "always")
        ? "accept" : "reject"
      telemetry.metrics.toolDecision.add(1, {
        ...commonAttributes(state, sessionID),
        decision,
      })
      state.log.debug("permission.replied", { permissionID, response, decision })
      break
    }

    // --- Session diff (accurate line counts) ---
    case "session.diff": {
      const sessionId = props.sessionID
      const diffs = props.diff as Array<{ additions?: number; deletions?: number }> | undefined
      if (diffs) {
        let totalAdded = 0
        let totalRemoved = 0
        for (const d of diffs) {
          totalAdded += d.additions ?? 0
          totalRemoved += d.deletions ?? 0
        }
        if (totalAdded > 0) {
          telemetry.metrics.linesOfCode.add(totalAdded, {
            ...commonAttributes(state, sessionId),
            type: "added",
          })
        }
        if (totalRemoved > 0) {
          telemetry.metrics.linesOfCode.add(totalRemoved, {
            ...commonAttributes(state, sessionId),
            type: "removed",
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
      // Note: tool.decision metric is now emitted from permission.replied
      // (accept/reject) rather than unconditionally on every tool execution.
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
      const toolPayload: Attributes = {
        "tool_name": state.config.logToolDetails ? tool : "redacted",
        "duration_ms": durationMs,
        "success": !output?.includes("Error"),
      }
      if (state.config.logToolDetails) {
        toolPayload["tool_args"] = JSON.stringify(args ?? {}).slice(0, 2048)
        toolPayload["tool_result_size_bytes"] =
          typeof output === "string" ? output.length : 0
      }

      telemetry.emitEvent(
        `${telemetry.prefix}.tool_result`,
        "tool_result",
        {
          ...eventAttributes(state, sessionID),
          ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(toolPayload) : toolPayload),
        },
      )
      state.log.debug("tool_result emitted", { tool, durationMs })
      break
    }

    // --- Chat message (user prompt) ---
    case "chat.message": {
      const { sessionID, agent, model, parts } = props
      let promptText = (parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n")

      // Clean up prompt text: trim whitespace and strip surrounding quotes
      // that OpenCode's `run -p` adds around the prompt argument.
      promptText = promptText.trim().replace(/^"(.*)"$/s, "$1")

      // Generate a new prompt ID for this user prompt (matches Claude Code's randomUUID())
      state.promptId = randomUUID()

      const payload: Attributes = {
        "prompt_length": promptText.length,
      }
      if (agent) payload["agent"] = agent
      if (model) {
        payload["model.provider"] = model.providerID
        payload["model.id"] = model.modelID
      }
      if (state.config.logUserPrompts) {
        payload["prompt"] = promptText.slice(0, 4096)
      }

      telemetry.emitEvent(
        `${telemetry.prefix}.user_prompt`,
        "user_prompt",
        {
          ...eventAttributes(state, sessionID),
          ...(telemetry.profile === "claude-code" ? stringifyNumericAttrs(payload) : payload),
        },
      )
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
