/**
 * Plugin hooks — wires OpenCode events to OTEL metrics and log events.
 */

import type { Attributes } from "@opentelemetry/api"
import type { OtelConfig } from "./config.js"
import type { TelemetryContext } from "./telemetry.js"
import type { Logger } from "./log.js"

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
}

export function createHookState(config: OtelConfig, telemetry: TelemetryContext, log: Logger): HookState {
  return {
    config,
    telemetry,
    log,
    sessions: new Map(),
    pendingToolCalls: new Map(),
    eventSequence: 0,
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

function baseAttributes(state: HookState, sessionId?: string): Attributes {
  const attrs: Attributes = {}
  if (sessionId && state.config.includeSessionId) {
    attrs["session.id"] = sessionId
  }
  if (state.config.includeVersion) {
    attrs["app.version"] = "0.1.0"
  }
  return attrs
}

function eventAttributes(state: HookState, sessionId?: string): Attributes {
  state.eventSequence++
  return {
    ...baseAttributes(state, sessionId),
    "event.timestamp": Date.now(),
    "event.sequence": state.eventSequence,
  }
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

export function handleEvent(state: HookState, event: { type: string; properties?: any }) {
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
        telemetry.metrics.sessionCount.add(1, baseAttributes(state, sessionId))
        telemetry.emitEvent(`${telemetry.prefix}.session.created`, {
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
          ...baseAttributes(state, sessionId),
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
          ...baseAttributes(state),
          type: "added",
        })
      }
      if (removed > 0) {
        telemetry.metrics.linesOfCode.add(removed, {
          ...baseAttributes(state),
          type: "removed",
        })
      }
      break
    }

    // --- Message parts (token/cost tracking) ---
    case "message.part.updated": {
      const part = props.part ?? props
      // The part may contain token usage and cost info when it's an assistant response
      if (part.type === "step-start" || part.type === "step-finish") {
        // Token usage from provider metadata
        const usage = part.usage ?? part.metadata?.usage
        if (usage) {
          const sessionId = part.sessionID ?? props.sessionID
          const model = part.model ?? part.metadata?.model ?? "unknown"
          if (usage.promptTokens || usage.inputTokens) {
            telemetry.metrics.tokenUsage.add(usage.promptTokens ?? usage.inputTokens ?? 0, {
              ...baseAttributes(state, sessionId),
              type: "input",
              model,
            })
          }
          if (usage.completionTokens || usage.outputTokens) {
            telemetry.metrics.tokenUsage.add(
              usage.completionTokens ?? usage.outputTokens ?? 0,
              {
                ...baseAttributes(state, sessionId),
                type: "output",
                model,
              },
            )
          }
          if (usage.cacheReadTokens) {
            telemetry.metrics.tokenUsage.add(usage.cacheReadTokens, {
              ...baseAttributes(state, sessionId),
              type: "cacheRead",
              model,
            })
          }
          if (usage.cacheCreationTokens) {
            telemetry.metrics.tokenUsage.add(usage.cacheCreationTokens, {
              ...baseAttributes(state, sessionId),
              type: "cacheCreation",
              model,
            })
          }

          // Cost
          const cost = part.cost ?? part.metadata?.cost ?? usage.cost
          if (cost !== undefined && cost !== null) {
            telemetry.metrics.costUsage.add(typeof cost === "number" ? cost : 0, {
              ...baseAttributes(state, sessionId),
              model,
            })
          }

          // Emit API request event
          telemetry.emitEvent(`${telemetry.prefix}.api_request`, {
            ...eventAttributes(state, sessionId),
            model,
            "input_tokens": usage.promptTokens ?? usage.inputTokens ?? 0,
            "output_tokens": usage.completionTokens ?? usage.outputTokens ?? 0,
            "cache_read_tokens": usage.cacheReadTokens ?? 0,
            "cache_creation_tokens": usage.cacheCreationTokens ?? 0,
            "cost_usd": typeof cost === "number" ? cost : 0,
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

    default:
      // Unhandled event types are silently ignored
      break
  }
}

// ---------------------------------------------------------------------------
// Tool execution hooks
// ---------------------------------------------------------------------------

export function handleToolBefore(
  state: HookState,
  input: { tool: string; sessionID: string; callID: string },
  args: unknown,
) {
  state.pendingToolCalls.set(input.callID, {
    tool: input.tool,
    startedAt: Date.now(),
    args,
  })

  // Emit tool decision metric
  telemetry(state).metrics.toolDecision.add(1, {
    ...baseAttributes(state, input.sessionID),
    tool_name: input.tool,
    decision: "execute",
  })
}

export function handleToolAfter(
  state: HookState,
  input: { tool: string; sessionID: string; callID: string; args: unknown },
  output: { title: string; output: string; metadata: unknown },
) {
  const pending = state.pendingToolCalls.get(input.callID)
  const durationMs = pending ? Date.now() - pending.startedAt : 0
  state.pendingToolCalls.delete(input.callID)

  // Detect git operations for commit/PR metrics
  if (input.tool === "bash") {
    const cmd = typeof input.args === "object" && input.args !== null
      ? (input.args as Record<string, unknown>).command
      : undefined
    if (typeof cmd === "string") {
      if (/\bgit\s+commit\b/.test(cmd)) {
        state.telemetry.metrics.commitCount.add(1, baseAttributes(state, input.sessionID))
      }
      if (/\bgh\s+pr\s+create\b/.test(cmd) || /\bgit\s+push\b.*--.*pull-request/.test(cmd)) {
        state.telemetry.metrics.pullRequestCount.add(1, baseAttributes(state, input.sessionID))
      }
    }
  }

  // Detect file edits from write/edit tools
  if (input.tool === "write" || input.tool === "edit") {
    // Count lines from the output heuristic
    const outStr = typeof output.output === "string" ? output.output : ""
    const lines = outStr.split("\n").length
    if (lines > 0) {
      state.telemetry.metrics.linesOfCode.add(lines, {
        ...baseAttributes(state, input.sessionID),
        type: input.tool === "write" ? "added" : "modified",
      })
    }
  }

  // Emit tool_result event
  const eventAttrs: Attributes = {
    ...eventAttributes(state, input.sessionID),
    "tool_name": state.config.logToolDetails ? input.tool : "redacted",
    "duration_ms": durationMs,
    "success": !output.output?.includes("Error"),
  }

  if (state.config.logToolDetails) {
    eventAttrs["tool_args"] = JSON.stringify(input.args).slice(0, 2048)
    eventAttrs["tool_result_size_bytes"] =
      typeof output.output === "string" ? output.output.length : 0
  }

  state.telemetry.emitEvent(`${state.telemetry.prefix}.tool_result`, eventAttrs)
  state.log.debug("tool_result emitted", {
    tool: input.tool,
    durationMs,
  })
}

// ---------------------------------------------------------------------------
// Chat message hook (user prompt tracking)
// ---------------------------------------------------------------------------

export function handleChatMessage(
  state: HookState,
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
  parts: Array<{ type: string; text?: string }>,
) {
  const promptText = parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n")

  const attrs: Attributes = {
    ...eventAttributes(state, input.sessionID),
    "prompt_length": promptText.length,
  }

  if (input.agent) {
    attrs["agent"] = input.agent
  }
  if (input.model) {
    attrs["model.provider"] = input.model.providerID
    attrs["model.id"] = input.model.modelID
  }

  if (state.config.logUserPrompts) {
    attrs["prompt"] = promptText.slice(0, 4096) // cap at 4KB
  }

  state.telemetry.emitEvent(`${state.telemetry.prefix}.user_prompt`, attrs)
  state.log.debug("user_prompt emitted", {
    promptLength: promptText.length,
    agent: input.agent,
  })
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function telemetry(state: HookState): TelemetryContext {
  return state.telemetry
}
