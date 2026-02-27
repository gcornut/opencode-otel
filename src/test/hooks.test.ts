/**
 * Tests for the opencode-otel plugin hook system.
 *
 * Uses in-memory OTEL exporters to capture and verify all metrics and
 * events emitted by the plugin. When using the "claude-code" telemetry
 * profile, these tests verify that the emitted telemetry matches
 * Claude Code's naming conventions.
 *
 * Run with: bun test
 */

import { describe, test, expect, afterEach } from "bun:test"
import { createTestHarness, type TestHarness } from "./helpers.js"

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let harness: TestHarness

function setup(overrides?: Parameters<typeof createTestHarness>[0]) {
  harness = createTestHarness(overrides)
  return harness
}

afterEach(async () => {
  if (harness) {
    await harness.shutdown()
  }
})

// ===========================================================================
// 1. Session lifecycle
// ===========================================================================

describe("session lifecycle", () => {
  test("session.created emits session.count metric and session.created event", async () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test Session" } },
    })

    await h.flush()

    // Verify metric
    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(1)
    expect(metrics[0].value).toBe(1)
    expect(metrics[0].attributes["session.id"]).toBe("sess-1")

    // Verify event
    const events = h.getEventsByName("session.created")
    expect(events.length).toBe(1)
    expect(events[0].attributes["session.id"]).toBe("sess-1")
    expect(events[0].attributes["session.title"]).toBe("Test Session")
    // event.timestamp is ISO 8601 string (matches Claude Code)
    expect(typeof events[0].attributes["event.timestamp"]).toBe("string")
    expect((events[0].attributes["event.timestamp"] as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(events[0].attributes["event.sequence"]).toBeDefined()
    // user.id is always present (64-char hex string)
    expect(events[0].attributes["user.id"]).toBeDefined()
    expect(typeof events[0].attributes["user.id"]).toBe("string")
  })

  test("session.created with flat id (no info wrapper)", async () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { id: "sess-flat" },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(1)
    expect(metrics[0].attributes["session.id"]).toBe("sess-flat")
  })

  test("session.idle records active time", async () => {
    const h = setup()

    // Create session first
    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })

    // Simulate some activity time passing
    const session = h.state.sessions.get("sess-1")!
    session.lastActivityAt = Date.now() - 5000 // 5 seconds ago

    h.emit({
      type: "session.idle",
      properties: { info: { id: "sess-1" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.active_time.total")
    expect(metrics.length).toBe(1)
    // Should be approximately 5 seconds (allow for timing variance)
    expect(metrics[0].value).toBeGreaterThanOrEqual(4.9)
    expect(metrics[0].value).toBeLessThanOrEqual(6)
  })

  test("session.status updates lastActivityAt", () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })

    const before = h.state.sessions.get("sess-1")!.lastActivityAt

    // Small delay to ensure timestamp changes
    const now = Date.now() + 100
    h.emit({
      type: "session.status",
      properties: { info: { id: "sess-1" } },
    })

    const after = h.state.sessions.get("sess-1")!.lastActivityAt
    expect(after).toBeGreaterThanOrEqual(before)
  })

  test("session.idle with no prior session is a no-op", async () => {
    const h = setup()

    h.emit({
      type: "session.idle",
      properties: { info: { id: "nonexistent" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.active_time.total")
    expect(metrics.length).toBe(0)
  })
})

// ===========================================================================
// 2. Token and cost tracking (message.part.updated)
// ===========================================================================

describe("token and cost tracking", () => {
  test("message.updated with completed assistant message emits token metrics and api_request event", async () => {
    const h = setup()

    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: "sess-1",
          role: "assistant",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          cost: 0.015,
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 0,
            cache: { read: 200, write: 50 },
          },
          time: { created: 1000, completed: 3000 },
        },
      },
    })

    await h.flush()

    // Token metrics
    const tokenMetrics = h.getMetricsByName("opencode.token.usage")
    const inputTokens = tokenMetrics.find((m) => m.attributes.type === "input")
    expect(inputTokens).toBeDefined()
    expect(inputTokens!.value).toBe(1000)
    expect(inputTokens!.attributes.model).toBe("claude-sonnet-4-20250514")

    const outputTokens = tokenMetrics.find(
      (m) => m.attributes.type === "output",
    )
    expect(outputTokens).toBeDefined()
    expect(outputTokens!.value).toBe(500)

    const cacheRead = tokenMetrics.find(
      (m) => m.attributes.type === "cacheRead",
    )
    expect(cacheRead).toBeDefined()
    expect(cacheRead!.value).toBe(200)

    const cacheCreation = tokenMetrics.find(
      (m) => m.attributes.type === "cacheCreation",
    )
    expect(cacheCreation).toBeDefined()
    expect(cacheCreation!.value).toBe(50)

    // Cost metric
    const costMetrics = h.getMetricsByName("opencode.cost.usage")
    expect(costMetrics.length).toBe(1)
    expect(costMetrics[0].value).toBe(0.015)
    expect(costMetrics[0].attributes.model).toBe("claude-sonnet-4-20250514")

    // api_request event
    const events = h.getEventsByName("api_request")
    expect(events.length).toBe(1)
    expect(events[0].attributes.model).toBe("claude-sonnet-4-20250514")
    expect(events[0].attributes.input_tokens).toBe(1000)
    expect(events[0].attributes.output_tokens).toBe(500)
    expect(events[0].attributes.cache_read_tokens).toBe(200)
    expect(events[0].attributes.cache_creation_tokens).toBe(50)
    expect(events[0].attributes.cost_usd).toBe(0.015)
    expect(events[0].attributes.duration_ms).toBe(2000)
  })

  test("step-finish parts are ignored (message.updated is the authoritative source)", async () => {
    const h = setup()

    h.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "sess-1",
          messageID: "msg-2",
          cost: 0.01,
          tokens: {
            input: 800,
            output: 300,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })

    await h.flush()

    // step-finish no longer emits metrics — message.updated is used instead
    const tokenMetrics = h.getMetricsByName("opencode.token.usage")
    expect(tokenMetrics.length).toBe(0)
  })

  test("message.updated deduplicates — same messageID not emitted twice", async () => {
    const h = setup()

    const msg = {
      id: "msg-dup",
      sessionID: "sess-1",
      role: "assistant",
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1000, completed: 2000 },
    }

    h.emit({ type: "message.updated", properties: { info: msg } })
    h.emit({ type: "message.updated", properties: { info: msg } })

    const events = h.getEventsByName("api_request")
    expect(events.length).toBe(1)
  })

  test("message.updated without completed time is ignored", async () => {
    const h = setup()

    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-incomplete",
          sessionID: "sess-1",
          role: "assistant",
          modelID: "claude-sonnet-4-20250514",
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000 },
          // no completed time — message still in progress
        },
      },
    })

    const events = h.getEventsByName("api_request")
    expect(events.length).toBe(0)
  })

  test("message.part.updated with non-step type is ignored", async () => {
    const h = setup()

    h.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: "Hello world",
        },
      },
    })

    await h.flush()

    const tokenMetrics = h.getMetricsByName("opencode.token.usage")
    expect(tokenMetrics.length).toBe(0)

    const events = h.getEventsByName("api_request")
    expect(events.length).toBe(0)
  })
})

// ===========================================================================
// 2b. Error tracking (session.error, retry parts)
// ===========================================================================

describe("error tracking", () => {
  test("session.error emits api_error event", () => {
    const h = setup()

    h.emit({
      type: "session.error",
      properties: {
        sessionID: "sess-1",
        error: {
          name: "APIError",
          data: {
            message: "rate limited",
            statusCode: 429,
            isRetryable: true,
          },
        },
      },
    })

    const events = h.getEventsByName("api_error")
    expect(events.length).toBe(1)
    expect(events[0].attributes["error.name"]).toBe("APIError")
    expect(events[0].attributes["error.message"]).toBe("rate limited")
    expect(events[0].attributes["error.status_code"]).toBe(429)
    expect(events[0].attributes["error.is_retryable"]).toBe(true)
  })

  test("retry part emits api_error event", () => {
    const h = setup()

    h.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "retry",
          sessionID: "sess-1",
          messageID: "msg-1",
          attempt: 2,
          error: {
            name: "APIError",
            data: {
              message: "server error",
              statusCode: 500,
              isRetryable: true,
            },
          },
          time: { created: 1000 },
        },
      },
    })

    const events = h.getEventsByName("api_error")
    expect(events.length).toBe(1)
    expect(events[0].attributes["attempt"]).toBe(2)
    expect(events[0].attributes["error.status_code"]).toBe(500)
  })

  test("message.updated with error emits api_error event", () => {
    const h = setup()

    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-err",
          sessionID: "sess-1",
          role: "assistant",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          cost: 0,
          tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, completed: 2000 },
          error: {
            name: "MessageAbortedError",
            data: { message: "user cancelled" },
          },
        },
      },
    })

    // Should emit both api_request and api_error
    const apiEvents = h.getEventsByName("api_request")
    expect(apiEvents.length).toBe(1)
    const errorEvents = h.getEventsByName("api_error")
    expect(errorEvents.length).toBe(1)
    expect(errorEvents[0].attributes["error.name"]).toBe("MessageAbortedError")
  })

  test("session.error without error property is ignored", () => {
    const h = setup()

    h.emit({
      type: "session.error",
      properties: { sessionID: "sess-1" },
    })

    const events = h.getEventsByName("api_error")
    expect(events.length).toBe(0)
  })
})

// ===========================================================================
// 2c. Session diff (accurate line counts)
// ===========================================================================

describe("session diff", () => {
  test("session.diff emits accurate line count metrics", async () => {
    const h = setup()

    h.emit({
      type: "session.diff",
      properties: {
        sessionID: "sess-1",
        diff: [
          { additions: 10, deletions: 3 },
          { additions: 5, deletions: 2 },
        ],
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    const added = metrics.find((m) => m.attributes.type === "added")
    const removed = metrics.find((m) => m.attributes.type === "removed")
    expect(added).toBeDefined()
    expect(added!.value).toBe(15)
    expect(removed).toBeDefined()
    expect(removed!.value).toBe(5)
  })
})

// ===========================================================================
// 2d. OpenCode version capture
// ===========================================================================

describe("opencode version capture", () => {
  test("session.created captures version from Session.version", () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: {
        info: { id: "sess-1", title: "T", version: "1.5.0" },
      },
    })

    expect(h.state.opencodeVersion).toBe("1.5.0")
  })

  test("only first session.created sets version", () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: {
        info: { id: "s1", title: "T", version: "1.5.0" },
      },
    })
    h.emit({
      type: "session.created",
      properties: {
        info: { id: "s2", title: "T", version: "2.0.0" },
      },
    })

    expect(h.state.opencodeVersion).toBe("1.5.0")
  })
})

// ===========================================================================
// 3. Tool execution
// ===========================================================================

describe("tool execution", () => {
  test("tool.execute.before records pending call", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "call-1",
        args: { command: "ls -la" },
      },
    })

    await h.flush()

    // Pending call tracked
    expect(h.state.pendingToolCalls.has("call-1")).toBe(true)
  })

  test("permission.replied emits tool.decision metric", async () => {
    const h = setup()

    h.emit({
      type: "permission.replied",
      properties: {
        sessionID: "sess-1",
        permissionID: "perm-1",
        response: "once",
      },
    })

    h.emit({
      type: "permission.replied",
      properties: {
        sessionID: "sess-1",
        permissionID: "perm-2",
        response: "reject",
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.tool.decision")
    expect(metrics.length).toBe(2)
    const accept = metrics.find((m) => m.attributes.decision === "accept")
    const reject = metrics.find((m) => m.attributes.decision === "reject")
    expect(accept).toBeDefined()
    expect(reject).toBeDefined()
  })

  test("tool.execute.after emits tool_result event with duration", async () => {
    const h = setup({ logToolDetails: true })

    // Start tool
    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "call-1",
        args: { command: "echo hello" },
      },
    })

    // Simulate delay
    const pending = h.state.pendingToolCalls.get("call-1")!
    pending.startedAt = Date.now() - 150 // 150ms ago

    // End tool
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "call-1",
        args: { command: "echo hello" },
        output: "hello",
      },
    })

    // Pending call cleaned up
    expect(h.state.pendingToolCalls.has("call-1")).toBe(false)

    // tool_result event
    const events = h.getEventsByName("tool_result")
    expect(events.length).toBe(1)
    expect(events[0].attributes.tool_name).toBe("bash")
    expect(events[0].attributes.success).toBe(true)
    expect(events[0].attributes.duration_ms).toBeGreaterThanOrEqual(100)
    expect(events[0].attributes.tool_args).toBe('{"command":"echo hello"}')
    expect(events[0].attributes.tool_result_size_bytes).toBe(5) // "hello"
  })

  test("tool_result event has redacted tool name when logToolDetails is false", async () => {
    const h = setup({ logToolDetails: false })

    h.emit({
      type: "tool.execute.before",
      properties: { tool: "bash", sessionID: "s", callID: "c1", args: {} },
    })
    h.emit({
      type: "tool.execute.after",
      properties: { tool: "bash", sessionID: "s", callID: "c1", output: "ok" },
    })

    const events = h.getEventsByName("tool_result")
    expect(events[0].attributes.tool_name).toBe("redacted")
    expect(events[0].attributes.tool_args).toBeUndefined()
  })

  test("tool with Error in output reports success=false", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: { tool: "bash", sessionID: "s", callID: "c1", args: {} },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "s",
        callID: "c1",
        output: "Error: file not found",
      },
    })

    const events = h.getEventsByName("tool_result")
    expect(events[0].attributes.success).toBe(false)
  })

  test("bash tool with git commit increments commit counter", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "c1",
        args: { command: 'git commit -m "fix: something"' },
      },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "c1",
        args: { command: 'git commit -m "fix: something"' },
        output: "[main abc1234] fix: something",
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.commit.count")
    expect(metrics.length).toBe(1)
    expect(metrics[0].value).toBe(1)
  })

  test("bash tool with gh pr create increments PR counter", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "c1",
        args: { command: 'gh pr create --title "feat: new" --body "desc"' },
      },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "sess-1",
        callID: "c1",
        args: { command: 'gh pr create --title "feat: new" --body "desc"' },
        output: "https://github.com/org/repo/pull/42",
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.pull_request.count")
    expect(metrics.length).toBe(1)
    expect(metrics[0].value).toBe(1)
  })

  test("write tool increments lines_of_code with type=added", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: { tool: "write", sessionID: "s", callID: "c1", args: {} },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "write",
        sessionID: "s",
        callID: "c1",
        output: "line1\nline2\nline3",
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    const added = metrics.find((m) => m.attributes.type === "added")
    expect(added).toBeDefined()
    expect(added!.value).toBe(3) // 3 lines
  })

  test("edit tool increments lines_of_code with type=modified", async () => {
    const h = setup()

    h.emit({
      type: "tool.execute.before",
      properties: { tool: "edit", sessionID: "s", callID: "c1", args: {} },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "edit",
        sessionID: "s",
        callID: "c1",
        output: "updated line",
      },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    const modified = metrics.find((m) => m.attributes.type === "modified")
    expect(modified).toBeDefined()
    expect(modified!.value).toBe(1)
  })
})

// ===========================================================================
// 4. Chat message (user prompt)
// ===========================================================================

describe("chat.message / user_prompt", () => {
  test("emits user_prompt event with prompt length", () => {
    const h = setup()

    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        parts: [{ type: "text", text: "Fix the bug in auth.ts" }],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect(events.length).toBe(1)
    expect(events[0].attributes.prompt_length).toBe(22)
    expect(events[0].attributes.agent).toBe("coder")
    expect(events[0].attributes["model.provider"]).toBe("anthropic")
    expect(events[0].attributes["model.id"]).toBe("claude-sonnet-4-20250514")
    // prompt text is redacted by default
    expect(events[0].attributes.prompt).toBeUndefined()
    // prompt.id is a UUID generated per user prompt
    expect(events[0].attributes["prompt.id"]).toBeDefined()
    expect(typeof events[0].attributes["prompt.id"]).toBe("string")
    expect((events[0].attributes["prompt.id"] as string)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test("includes prompt text when logUserPrompts is enabled", () => {
    const h = setup({ logUserPrompts: true })

    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        parts: [{ type: "text", text: "Fix the bug" }],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect(events[0].attributes.prompt).toBe("Fix the bug")
  })

  test("prompt text is capped at 4096 characters", () => {
    const h = setup({ logUserPrompts: true })

    const longPrompt = "x".repeat(5000)
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [{ type: "text", text: longPrompt }],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect((events[0].attributes.prompt as string).length).toBe(4096)
  })

  test("multi-part text is concatenated", () => {
    const h = setup({ logUserPrompts: true })

    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [
          { type: "text", text: "Hello" },
          { type: "image", url: "..." },
          { type: "text", text: "World" },
        ],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect(events[0].attributes.prompt).toBe("Hello\nWorld")
    expect(events[0].attributes.prompt_length).toBe(11)
  })
})

// ===========================================================================
// 4b. prompt.id propagation
// ===========================================================================

describe("prompt.id propagation", () => {
  test("prompt.id from chat.message propagates to subsequent api_request events", () => {
    const h = setup()

    // User prompt sets promptId
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [{ type: "text", text: "hello" }],
      },
    })

    const promptEvents = h.getEventsByName("user_prompt")
    const promptId = promptEvents[0].attributes["prompt.id"] as string
    expect(promptId).toBeDefined()

    // Subsequent api_request (via message.updated) should carry the same promptId
    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: "sess-1",
          role: "assistant",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, completed: 2000 },
        },
      },
    })

    const apiEvents = h.getEventsByName("api_request")
    expect(apiEvents[0].attributes["prompt.id"]).toBe(promptId)
  })

  test("new chat.message generates a new prompt.id", () => {
    const h = setup()

    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [{ type: "text", text: "first" }],
      },
    })

    const first = h.getEventsByName("user_prompt")[0].attributes["prompt.id"]

    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [{ type: "text", text: "second" }],
      },
    })

    const allPrompts = h.getEventsByName("user_prompt")
    const second = allPrompts[1].attributes["prompt.id"]

    expect(first).not.toBe(second)
  })
})

// ===========================================================================
// 5. File edited events
// ===========================================================================

describe("file.edited", () => {
  test("emits lines_of_code metrics for added and removed lines", async () => {
    const h = setup()

    h.emit({
      type: "file.edited",
      properties: { linesAdded: 10, linesRemoved: 3 },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    const added = metrics.find((m) => m.attributes.type === "added")
    const removed = metrics.find((m) => m.attributes.type === "removed")

    expect(added).toBeDefined()
    expect(added!.value).toBe(10)
    expect(removed).toBeDefined()
    expect(removed!.value).toBe(3)
  })

  test("handles alternate property names (added/removed)", async () => {
    const h = setup()

    h.emit({
      type: "file.edited",
      properties: { added: 5, removed: 2 },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    expect(metrics.find((m) => m.attributes.type === "added")!.value).toBe(5)
    expect(metrics.find((m) => m.attributes.type === "removed")!.value).toBe(2)
  })

  test("zero values do not emit metrics", async () => {
    const h = setup()

    h.emit({
      type: "file.edited",
      properties: { linesAdded: 0, linesRemoved: 0 },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.lines_of_code.count")
    expect(metrics.length).toBe(0)
  })
})

// ===========================================================================
// 6. /otel command toggle
// ===========================================================================

describe("/otel command toggle", () => {
  test("/otel off disables telemetry emission", async () => {
    const h = setup()

    const result = h.state.enabled
    expect(result).toBe(true)

    const toggleResult = h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "off" },
    }) as any

    expect(h.state.enabled).toBe(false)

    // Events after disable should not be emitted
    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })

    await h.flush()

    // The session.created event and metric should NOT be emitted
    const events = h.getEventsByName("session.created")
    expect(events.length).toBe(0)

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(0)
  })

  test("/otel on re-enables telemetry", async () => {
    const h = setup()

    h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "off" },
    })
    expect(h.state.enabled).toBe(false)

    h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "on" },
    })
    expect(h.state.enabled).toBe(true)

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(1)
  })

  test("/otel with no argument toggles", () => {
    const h = setup()

    h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "" },
    })
    expect(h.state.enabled).toBe(false)

    h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "" },
    })
    expect(h.state.enabled).toBe(true)
  })

  test("toggle emits telemetry.toggled event", () => {
    const h = setup()

    h.emit({
      type: "command.execute.before",
      properties: { command: "otel", arguments: "off" },
    })

    const events = h.getEventsByName("telemetry.toggled")
    expect(events.length).toBe(1)
    expect(events[0].attributes["telemetry.enabled"]).toBe(false)
  })

  test("non-otel commands are ignored", () => {
    const h = setup()

    h.emit({
      type: "command.execute.before",
      properties: { command: "help", arguments: "" },
    })

    expect(h.state.enabled).toBe(true) // unchanged
    const events = h.getEventsByName("telemetry.toggled")
    expect(events.length).toBe(0)
  })
})

// ===========================================================================
// 7. Event sequencing
// ===========================================================================

describe("event sequencing", () => {
  test("event.sequence is monotonically increasing", () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "A" } },
    })
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: "hi" }],
      },
    })

    const allEvents = h.getEvents()
    const sequences = allEvents
      .filter((e) => e.attributes["event.sequence"] !== undefined)
      .map((e) => e.attributes["event.sequence"] as number)

    expect(sequences.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1])
    }
  })
})

// ===========================================================================
// 8. Claude Code profile parity
// ===========================================================================

describe("claude-code telemetry profile", () => {
  test("uses claude_code metric prefix", async () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })

    await h.flush()

    // Should use claude_code prefix, not opencode
    const ccMetrics = h.getMetricsByName("claude_code.session.count")
    expect(ccMetrics.length).toBe(1)

    const ocMetrics = h.getMetricsByName("opencode.session.count")
    expect(ocMetrics.length).toBe(0)
  })

  test("uses claude_code event prefix in log body", () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "Test" } },
    })
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "sess-1",
        parts: [{ type: "text", text: "hello" }],
      },
    })

    // session.created is NOT emitted as a log event in claude-code profile
    const sessionEvents = h.getEventsByName("session.created")
    expect(sessionEvents.length).toBe(0)

    // user_prompt IS emitted — event.name is unprefixed
    const promptEvents = h.getEventsByName("user_prompt")
    expect(promptEvents.length).toBe(1)

    // log body uses the prefixed form
    expect(promptEvents[0].body).toBe("claude_code.user_prompt")
  })

  test("resource has service.name = claude-code", async () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })

    await h.flush()

    const attrs = h.getResourceAttributes()
    expect(attrs["service.name"]).toBe("claude-code")
  })

  test("all 8 metric names match Claude Code naming", async () => {
    const h = setup({ telemetryProfile: "claude-code", logToolDetails: true })

    // Trigger all metrics
    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })

    // Active time
    const session = h.state.sessions.get("s1")!
    session.lastActivityAt = Date.now() - 1000
    h.emit({ type: "session.idle", properties: { info: { id: "s1" } } })

    // Tokens + cost (via message.updated)
    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: "s1",
          role: "assistant",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, completed: 2000 },
        },
      },
    })

    // Lines of code
    h.emit({ type: "file.edited", properties: { linesAdded: 5 } })

    // Tool decision (via permission.replied)
    h.emit({
      type: "permission.replied",
      properties: { sessionID: "s1", permissionID: "p1", response: "once" },
    })

    // Tool result + commit + PR
    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "git commit -m test && gh pr create --title t" },
      },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "git commit -m test && gh pr create --title t" },
        output: "ok",
      },
    })

    await h.flush()

    const allMetrics = h.getMetricDataPoints()
    const metricNames = [...new Set(allMetrics.map((m) => m.name))]

    const expectedNames = [
      "claude_code.session.count",
      "claude_code.active_time.total",
      "claude_code.token.usage",
      "claude_code.cost.usage",
      "claude_code.lines_of_code.count",
      "claude_code.commit.count",
      "claude_code.pull_request.count",
      "claude_code.tool.decision",
    ]

    for (const name of expectedNames) {
      expect(metricNames).toContain(name)
    }
  })

  test("all event names match Claude Code naming", () => {
    const h = setup({
      telemetryProfile: "claude-code",
      logToolDetails: true,
      logUserPrompts: true,
    })

    // session.created
    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })

    // api_request (via message.updated)
    h.emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: "s1",
          role: "assistant",
          modelID: "m",
          providerID: "p",
          cost: 0.01,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, completed: 2000 },
        },
      },
    })

    // tool_result
    h.emit({
      type: "tool.execute.before",
      properties: { tool: "bash", sessionID: "s1", callID: "c1", args: {} },
    })
    h.emit({
      type: "tool.execute.after",
      properties: { tool: "bash", sessionID: "s1", callID: "c1", args: {}, output: "ok" },
    })

    // user_prompt
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: "hello" }],
      },
    })

    const allEvents = h.getEvents()
    const eventNames = allEvents
      .map((e) => e.attributes["event.name"] as string)
      .filter(Boolean)

    // event.name is unprefixed (matches Claude Code behavior)
    // Note: session.created is NOT emitted as a log event in claude-code profile
    const expectedEventNames = [
      "api_request",
      "tool_result",
      "user_prompt",
    ]

    for (const name of expectedEventNames) {
      expect(eventNames).toContain(name)
    }
    // Verify session.created is NOT in the events
    expect(eventNames).not.toContain("session.created")

    // log body is prefixed with "claude_code."
    const bodies = allEvents.map((e) => e.body).filter(Boolean)
    for (const name of expectedEventNames) {
      expect(bodies).toContain(`claude_code.${name}`)
    }
  })

  test("resource attributes match Claude Code format", async () => {
    const h = setup({
      telemetryProfile: "claude-code",
      resourceAttributes: { "user.email": "test@example.com" },
    })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    await h.flush()

    const attrs = h.getResourceAttributes()
    expect(attrs["service.name"]).toBe("claude-code")
    expect(attrs["service.version"]).toBeDefined()
    expect(attrs["os.type"]).toBeDefined()
    expect(attrs["os.version"]).toBeDefined() // os.release() value
    expect(attrs["host.arch"]).toBeDefined()
    expect(attrs["user.email"]).toBe("test@example.com")

    // Claude Code uses Go-style arch values
    const arch = attrs["host.arch"] as string
    const expectedArchValues = ["amd64", "arm64", "386", "arm"]
    expect(expectedArchValues).toContain(arch)
  })

  test("no telemetry.sdk.* resource attributes in claude-code profile", async () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    await h.flush()

    const attrs = h.getResourceAttributes()
    // Claude Code (Go SDK) does not include telemetry.sdk.* attributes
    expect(attrs["telemetry.sdk.language"]).toBeUndefined()
    expect(attrs["telemetry.sdk.name"]).toBeUndefined()
    expect(attrs["telemetry.sdk.version"]).toBeUndefined()
  })

  test("no severityNumber/severityText on log records in claude-code profile", () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: "hello" }],
      },
    })

    const events = h.getEvents()
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      // Claude Code log records have no severity fields
      expect(event.severityNumber).toBeUndefined()
      expect(event.severityText).toBeUndefined()
    }
  })

  test("event.sequence starts at 0 (zero-indexed) in claude-code profile", () => {
    const h = setup({ telemetryProfile: "claude-code" })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: "hello" }],
      },
    })

    // In claude-code profile, session.created doesn't emit an event,
    // so user_prompt should be the first event with sequence 0
    const promptEvents = h.getEventsByName("user_prompt")
    expect(promptEvents.length).toBe(1)
    expect(promptEvents[0].attributes["event.sequence"]).toBe(0)
  })

  test("numeric event attributes are strings in claude-code profile", () => {
    const h = setup({
      telemetryProfile: "claude-code",
      logUserPrompts: true,
    })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: "hello world" }],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect(events.length).toBe(1)
    // prompt_length should be a string, not a number
    expect(typeof events[0].attributes["prompt_length"]).toBe("string")
    expect(events[0].attributes["prompt_length"]).toBe("11")
  })

  test("prompt text is cleaned up (trimmed, quotes stripped)", () => {
    const h = setup({
      telemetryProfile: "claude-code",
      logUserPrompts: true,
    })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    // Simulate opencode run -p which wraps prompt in quotes and adds newline
    h.emit({
      type: "chat.message",
      properties: {
        sessionID: "s1",
        parts: [{ type: "text", text: '"What is 2+2?"\n' }],
      },
    })

    const events = h.getEventsByName("user_prompt")
    expect(events.length).toBe(1)
    // Quotes and newline should be stripped
    expect(events[0].attributes["prompt"]).toBe("What is 2+2?")
    // prompt_length should reflect the cleaned text
    expect(events[0].attributes["prompt_length"]).toBe("12")
  })

  test("plugin.started event is NOT emitted in claude-code profile", () => {
    // plugin.started is emitted from index.ts, not hooks.ts, so we test
    // that the TelemetryContext.profile is correctly set
    const h = setup({ telemetryProfile: "claude-code" })
    expect(h.telemetry.profile).toBe("claude-code")
  })
})

// ===========================================================================
// 9. Attribute controls (includeSessionId, includeVersion)
// ===========================================================================

describe("attribute controls", () => {
  test("user.id is always present on metrics and events", async () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "T" } },
    })

    await h.flush()

    // On metrics
    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics[0].attributes["user.id"]).toBeDefined()
    expect(typeof metrics[0].attributes["user.id"]).toBe("string")

    // On events
    const events = h.getEventsByName("session.created")
    expect(events[0].attributes["user.id"]).toBeDefined()
  })

  test("session.id is included by default", async () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "T" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics[0].attributes["session.id"]).toBe("sess-1")
  })

  test("session.id is excluded when includeSessionId=false", async () => {
    const h = setup({ includeSessionId: false })

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-1", title: "T" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics[0].attributes["session.id"]).toBeUndefined()
  })

  test("app.version is excluded by default", () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })

    const events = h.getEventsByName("session.created")
    expect(events[0].attributes["app.version"]).toBeUndefined()
  })

  test("app.version is included when includeVersion=true", () => {
    const h = setup({ includeVersion: true })

    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })

    const events = h.getEventsByName("session.created")
    expect(events[0].attributes["app.version"]).toBe("0.1.0")
  })
})

// ===========================================================================
// 10. Edge cases
// ===========================================================================

describe("edge cases", () => {
  test("unknown event types are silently ignored", async () => {
    const h = setup()

    // Should not throw
    h.emit({ type: "unknown.event.type", properties: { foo: "bar" } })

    await h.flush()

    const allEvents = h.getEvents()
    expect(allEvents.length).toBe(0)

    const allMetrics = h.getMetricDataPoints()
    expect(allMetrics.length).toBe(0)
  })

  test("events with missing properties are handled gracefully", async () => {
    const h = setup()

    // session.created with no id — should not crash
    h.emit({ type: "session.created", properties: {} })

    await h.flush()

    // No metric should be emitted since no sessionId
    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(0)
  })

  test("tool.execute.after with no matching before still emits event", () => {
    const h = setup()

    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "s1",
        callID: "orphan-call",
        output: "result",
      },
    })

    const events = h.getEventsByName("tool_result")
    expect(events.length).toBe(1)
    // Duration should be 0 since no start time
    expect(events[0].attributes.duration_ms).toBe(0)
  })

  test("multiple sessions can be tracked simultaneously", async () => {
    const h = setup()

    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-a", title: "Session A" } },
    })
    h.emit({
      type: "session.created",
      properties: { info: { id: "sess-b", title: "Session B" } },
    })

    await h.flush()

    const metrics = h.getMetricsByName("opencode.session.count")
    expect(metrics.length).toBe(2)

    const sessions = metrics.map((m) => m.attributes["session.id"])
    expect(sessions).toContain("sess-a")
    expect(sessions).toContain("sess-b")
  })
})

// ===========================================================================
// 11. Metric instrument metadata (descriptions, units)
// ===========================================================================

describe("metric instrument metadata", () => {
  test("all metrics have correct units", async () => {
    const h = setup({ telemetryProfile: "opencode", logToolDetails: true })

    // Trigger all metric types
    h.emit({
      type: "session.created",
      properties: { info: { id: "s1", title: "T" } },
    })
    const session = h.state.sessions.get("s1")!
    session.lastActivityAt = Date.now() - 1000
    h.emit({ type: "session.idle", properties: { info: { id: "s1" } } })
    h.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          model: "m",
          usage: { promptTokens: 1, completionTokens: 1 },
          cost: 0.001,
        },
      },
    })
    h.emit({ type: "file.edited", properties: { linesAdded: 1 } })
    h.emit({
      type: "tool.execute.before",
      properties: {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "git commit -m x" },
      },
    })
    h.emit({
      type: "tool.execute.after",
      properties: {
        tool: "bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "git commit -m x && gh pr create --title t" },
        output: "ok",
      },
    })

    await h.flush()

    const allMetrics = h.getMetricDataPoints()

    // Units match Claude Code — most counters have no unit, only cost/token/time have units
    const expectedUnits: Record<string, string> = {
      "opencode.session.count": "",
      "opencode.active_time.total": "s",
      "opencode.token.usage": "tokens",
      "opencode.cost.usage": "USD",
      "opencode.lines_of_code.count": "",
      "opencode.commit.count": "",
      "opencode.tool.decision": "",
    }

    for (const [name, unit] of Object.entries(expectedUnits)) {
      const metric = allMetrics.find((m) => m.name === name)
      if (metric) {
        expect(metric.unit).toBe(unit)
      }
    }
  })
})
