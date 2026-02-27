# Claude Code OTEL vs opencode-otel: Detailed Comparison

This document provides a comprehensive comparison between Claude Code's built-in
OpenTelemetry implementation and the `opencode-otel` plugin for OpenCode. It
covers architecture, configuration, data model, and migration considerations.

Based on analysis of Claude Code v2.1.49+ source code and verified against
actual OTLP captures from both tools.

---

## 1. Architecture

### Claude Code

Telemetry is built directly into the Claude Code binary (Node.js/TypeScript).
It initializes the OTEL SDK at startup inside the main process, with direct
access to all internal state: API responses, token counts, cost calculations,
session metadata, and tool execution results.

```
Claude Code process
  ├── CLI / TUI
  ├── LLM client (Anthropic API)
  │     └── token counts, cost, model info ← direct access
  ├── Tool executor
  │     └── decisions, results, timing ← direct access
  └── OTEL SDK (MeterProvider + LoggerProvider)
        └── OTLP Exporter → Collector
```

Telemetry is opt-in via a master toggle (`CLAUDE_CODE_ENABLE_TELEMETRY=1`).
Without it, no OTEL SDK is initialized and zero overhead is incurred.

### opencode-otel

Telemetry runs as an external plugin loaded by OpenCode at startup. It has no
access to OpenCode internals — it can only observe what OpenCode exposes
through the plugin hook system (`event`, `chat.message`, `tool.execute.before`,
`tool.execute.after`).

```
OpenCode process
  ├── TUI / Server
  ├── LLM client (Vercel AI SDK)
  │     └── token counts, cost → exposed via message.part.updated events (partial)
  ├── Tool executor
  │     └── exposed via tool.execute.before/after hooks
  └── Plugin host
        └── opencode-otel plugin
              ├── Runtime detection (terminal.type, user.id from ~/.claude.json)
              ├── OTEL SDK (MeterProvider + LoggerProvider)
              └── OTLP Exporter → Collector
```

The plugin is always loaded when listed in `opencode.json`. To disable telemetry
without removing the plugin, set both exporters to `"none"` (returns empty hooks,
no OTEL SDK initialized).

### Key architectural difference

Claude Code has **first-party access** to all data. The plugin has
**observer-only access** through hooks, which means some data (particularly
cost and cache token counts) may not be available or may require heuristics.

---

## 2. Configuration

### 2.1 Enable/disable

| | Claude Code | opencode-otel |
|---|---|---|
| Master toggle | `CLAUDE_CODE_ENABLE_TELEMETRY=1` required | Always active when plugin is loaded |
| Disable | Unset the env var | Set `metricsExporter` and `logsExporter` to `"none"` in JSON config |
| No-op cost | Zero (SDK not initialized) | Zero (empty hooks returned, SDK not initialized) |

### 2.2 Configuration sources

| | Claude Code | opencode-otel |
|---|---|---|
| Env vars | Standard `OTEL_*` + Claude-specific vars | Not supported |
| JSON config file | No (env vars or MDM managed settings only) | `~/.config/opencode/otel.json` |
| MDM / managed settings | macOS: `/Library/Application Support/ClaudeCode/managed-settings.json` | Not supported |
| Config validation | Runtime type checks | Valibot schema validation |
| Config path override | N/A | `OPENCODE_OTEL_CONFIG_PATH` env var |

### 2.3 JSON config file

`~/.config/opencode/otel.json`:

```json
{
  "endpoint": "https://otel-collector.example.com",
  "protocol": "grpc",
  "metricsExporter": "otlp",
  "logsExporter": "otlp",
  "headers": {
    "Authorization": "Bearer <token>"
  },
  "resourceAttributes": {
    "user.email": "dev@company.com",
    "department": "engineering"
  },
  "logUserPrompts": false,
  "logToolDetails": false,
  "includeSessionId": true,
  "includeVersion": false,
  "includeAccountUuid": true,
  "metricExportIntervalMs": 60000,
  "logsExportIntervalMs": 5000,
  "metricsTemporality": "delta"
}
```

All fields are optional except `endpoint`. Without it, telemetry is disabled.

### 2.4 Claude Code env vars (not supported by opencode-otel)

The following Claude Code env vars have JSON config equivalents in opencode-otel:

| Claude Code env var | opencode-otel JSON field |
|---|---|
| `OTEL_METRICS_EXPORTER` | `metricsExporter` |
| `OTEL_LOGS_EXPORTER` | `logsExporter` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `protocol` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `headers` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `metricsEndpoint` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `logsEndpoint` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `metricExportIntervalMs` |
| `OTEL_LOGS_EXPORT_INTERVAL` | `logsExportIntervalMs` |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `metricsTemporality` |
| `OTEL_RESOURCE_ATTRIBUTES` | `resourceAttributes` |
| `OTEL_LOG_USER_PROMPTS` | `logUserPrompts` |
| `OTEL_LOG_TOOL_DETAILS` | `logToolDetails` |
| `OTEL_METRICS_INCLUDE_SESSION_ID` | `includeSessionId` |
| `OTEL_METRICS_INCLUDE_VERSION` | `includeVersion` |
| `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | `includeAccountUuid` |

The following Claude Code env vars have no equivalent in opencode-otel:

| Env var | Description | Why not supported |
|---|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Master toggle | Not needed (plugin presence = enabled) |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | Per-signal protocol override | Not implemented yet |
| `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Per-signal protocol override | Not implemented yet |
| `OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY` | mTLS client key path | Not implemented (use collector as mTLS proxy) |
| `OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE` | mTLS client cert path | Not implemented |
| `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` | Dynamic header refresh interval | Not implemented |

### 2.5 opencode-otel-only features

| Feature | Description |
|---|---|
| JSON config file | `~/.config/opencode/otel.json` — structured config with schema validation |
| `OPENCODE_OTEL_CONFIG_PATH` | Override config file location |
| Valibot validation | Config errors surface clear messages with field paths |
| Per-signal endpoints | `metricsEndpoint` and `logsEndpoint` as JSON fields |

---

## 3. OTEL Signals

| Signal | Claude Code | opencode-otel |
|---|---|---|
| **Metrics** | Yes (8 counters) | Yes (8 counters, same names with profile) |
| **Logs / Events** | Yes (5+ event types) | Yes (5 event types) |
| **Traces** | No | No |

Neither tool exports OTEL traces. Both use the OTEL Logs SDK to emit structured
events (not the Traces SDK).

---

## 4. Metrics Comparison

### 4.1 Side-by-side

| Claude Code Metric | opencode-otel Metric | Match | Notes |
|---|---|---|---|
| `claude_code.session.count` | `opencode.session.count` | Equivalent | Both increment on session creation |
| `claude_code.active_time.total` | `opencode.active_time.total` | Equivalent | Both track seconds of active time |
| `claude_code.token.usage` | `opencode.token.usage` | Partial | Same `type` attribute. Plugin depends on OpenCode exposing usage in `message.part.updated` events |
| `claude_code.cost.usage` | `opencode.cost.usage` | Partial | Claude Code computes cost directly from API response. Plugin relies on cost data in message part events |
| `claude_code.lines_of_code.count` | `opencode.lines_of_code.count` | Partial | Claude Code counts actual diff lines. Plugin uses `file.edited` events + heuristics from `write`/`edit` tool output |
| `claude_code.commit.count` | `opencode.commit.count` | Equivalent | Both detect `git commit` in bash commands |
| `claude_code.pull_request.count` | `opencode.pull_request.count` | Equivalent | Both detect `gh pr create` in bash commands |
| `claude_code.code_edit_tool.decision` | `opencode.tool.decision` | Adapted | Claude Code tracks accept/reject decisions with `source` and `language`. Plugin tracks all tool executions with `tool_name` and `decision` |

### 4.2 Scope names

| | Claude Code | opencode-otel (`opencode` profile) | opencode-otel (`claude-code` profile) |
|---|---|---|---|
| Meter scope | `com.anthropic.claude_code` | `com.opencode.telemetry` | `com.anthropic.claude_code` |
| Logger scope | `com.anthropic.claude_code.events` | `com.opencode.telemetry.events` | `com.anthropic.claude_code.events` |
| Metric prefix | `claude_code.*` | `opencode.*` | `claude_code.*` |

### 4.3 Metric units and descriptions

| Metric | Claude Code unit | opencode-otel unit | Claude Code description | opencode-otel description |
|---|---|---|---|---|
| `session.count` | *(empty)* | *(empty)* | Count of CLI sessions started | Count of CLI sessions started |
| `active_time.total` | `s` | `s` | Total active time in seconds | Total active time in seconds |
| `token.usage` | `tokens` | `tokens` | Number of tokens used | Number of tokens used |
| `cost.usage` | `USD` | `USD` | Cost of the Claude Code session | Cost of the Claude Code session |
| `lines_of_code.count` | *(empty)* | *(empty)* | *(long description)* | *(matching description)* |
| `commit.count` | *(empty)* | *(empty)* | Number of git commits created | Number of git commits created |
| `pull_request.count` | *(empty)* | *(empty)* | Number of pull requests created | Number of pull requests created |
| `tool.decision` | *(empty)* | *(empty)* | *(description)* | *(matching description)* |

### 4.4 Metric attributes

**Common attributes on all metrics (both tools):**

| Attribute | Claude Code | opencode-otel | Match |
|---|---|---|---|
| `user.id` | Random 64-char hex from `~/.claude.json` | Same (reads from `~/.claude.json`) | Yes |
| `session.id` | Yes (controlled by env var, default on) | Yes (controlled by `includeSessionId`, default on) | Yes |
| `terminal.type` | Auto-detected from env vars | Auto-detected (same logic) | Yes |
| `app.version` | Yes (controlled by env var, default off) | Yes (controlled by `includeVersion`, default off) | Yes |
| `organization.id` | Yes (OAuth only) | No (OpenCode has no org concept) | N/A |
| `user.account_uuid` | Yes (controlled by env var) | No (OpenCode has no account UUID) | N/A |
| `user.email` | Yes (OAuth only) | Via `resourceAttributes` config | Compatible |

### 4.5 Data accuracy

| Metric | Claude Code accuracy | opencode-otel accuracy |
|---|---|---|
| Session count | Exact | Exact |
| Active time | Exact (internal timer) | Approximate (delta between `session.status` and `session.idle` events) |
| Token usage | Exact (from API response) | Best-effort (from `message.part.updated` events; depends on OpenCode exposing usage data) |
| Cost | Exact (computed from known pricing) | Best-effort (from message part events; cost field may not always be populated) |
| Lines of code | Exact (git diff) | Approximate (from `file.edited` events + write/edit tool output line counting) |
| Commits | Exact (detects `git commit` in bash) | Same |
| Pull requests | Exact (detects `gh pr create`) | Same |

---

## 5. Events Comparison (Logs)

### 5.1 Side-by-side

| Claude Code Event | opencode-otel Event | Match | Notes |
|---|---|---|---|
| `claude_code.user_prompt` | `opencode.user_prompt` | **Full parity** | 100% attribute match verified against OTLP captures |
| `claude_code.tool_result` | `opencode.tool_result` | Equivalent | Both track tool name, duration, success, args |
| `claude_code.api_request` | `opencode.api_request` | Equivalent | Both include model, tokens, cost, duration_ms, speed |
| `claude_code.api_error` | — | Not implemented | No hook available for API errors in OpenCode plugin system |
| `claude_code.tool_decision` | — | Not implemented | OpenCode plugin system doesn't expose accept/reject decisions separately |
| — | `opencode.session.created` | Plugin-only (`opencode` profile) | Emitted on session creation with title. Suppressed in `claude-code` profile |
| — | `opencode.plugin.started` | Plugin-only (`opencode` profile) | Emitted on plugin initialization with config summary. Suppressed in `claude-code` profile |

### 5.2 Event naming convention

Both tools use the same convention:
- **Log record body**: prefixed name (e.g. `claude_code.user_prompt` or `opencode.user_prompt`)
- **`event.name` attribute**: unprefixed name (e.g. `user_prompt`)

### 5.3 Event attributes

**Common attributes on all events (both tools):**

| Attribute | Claude Code | opencode-otel | Match |
|---|---|---|---|
| `user.id` | 64-char hex from `~/.claude.json` | Same | Yes |
| `session.id` | Session UUID | Session ID | Yes |
| `terminal.type` | Auto-detected | Auto-detected (same logic) | Yes |
| `event.name` | Unprefixed (e.g. `user_prompt`) | Unprefixed (same format) | Yes |
| `event.timestamp` | ISO 8601 string | ISO 8601 string | Yes |
| `event.sequence` | Zero-indexed monotonic counter | Zero-indexed monotonic counter | Yes |
| `prompt.id` | UUID v4 per prompt | UUID v4 per prompt | Yes |

**`user_prompt` event (verified 100% attribute parity):**

| Attribute | Claude Code | opencode-otel |
|---|---|---|
| `prompt_length` | Character count (string) | Character count (string in `claude-code` profile, int in `opencode` profile) |
| `prompt` | Redacted unless env var enabled | Same (controlled by `logUserPrompts`), capped at 4096 chars. Surrounding quotes and whitespace from `opencode run -p` are stripped |
| `prompt.id` | UUID v4 | UUID v4 |
| `agent` | Not present | Present (agent name, e.g. `coder`, `task`) |
| `model.provider` | Not present | Present (provider ID) |
| `model.id` | Not present | Present (model ID) |

**`tool_result` event:**

| Attribute | Claude Code | opencode-otel |
|---|---|---|
| `tool_name` | Always present | Redacted unless `logToolDetails` config is `true` |
| `duration_ms` | Exact | Exact (measured via before/after hooks) |
| `success` | Boolean | Boolean (heuristic: checks if output contains "Error") |
| `tool_result_size_bytes` | Size | Present (when `logToolDetails` is `true`) |
| `tool_args` | JSON parameters | JSON of args (when `logToolDetails` is `true`, capped at 2048 chars) |

**`api_request` event:**

| Attribute | Claude Code | opencode-otel |
|---|---|---|
| `model` | Model ID | Model ID |
| `cost_usd` | Exact | Best-effort |
| `duration_ms` | Request duration | From event properties |
| `input_tokens` | Exact | Best-effort |
| `output_tokens` | Exact | Best-effort |
| `cache_read_tokens` | Exact | Best-effort |
| `cache_creation_tokens` | Exact | Best-effort |
| `speed` | `"fast"` or `"normal"` | `"normal"` (default, or from event properties) |

---

## 6. Resource Attributes

| Attribute | Claude Code | opencode-otel | Match |
|---|---|---|---|
| `service.name` | `claude-code` | `claude-code` (with profile) | Yes |
| `service.version` | Claude Code version (e.g. `2.1.49`) | Plugin version (from `package.json`) | Different apps |
| `os.type` | `darwin\|linux\|windows` | `darwin\|linux\|win32` | Yes |
| `os.version` | `os.release()` (e.g. `25.3.0`) | `os.release()` | Yes |
| `host.arch` | `arm64\|amd64` (Go-style) | `arm64\|amd64` (mapped to Go-style with profile) | Yes |
| `user.email` | From OAuth | From `resourceAttributes` config | Compatible |
| `telemetry.sdk.*` | Not present (Go SDK) | Suppressed in `claude-code` profile; present in `opencode` profile | Matching in `claude-code` profile |
| Custom | From `OTEL_RESOURCE_ATTRIBUTES` env var | From `resourceAttributes` JSON config | Compatible |

---

## 7. User Identity

### `user.id`

Both tools use `~/.claude.json` to store and retrieve a persistent anonymous user ID.

| | Claude Code | opencode-otel |
|---|---|---|
| Format | `randomBytes(32).toString("hex")` — 64-char hex | Same format |
| Storage | `~/.claude.json` → `userID` field | Reads from same file, creates if missing |
| Scope | Per-device (persists across sessions) | Same (shared with Claude Code) |

If you use both Claude Code and opencode-otel on the same machine, they will
share the same `user.id`. This is intentional — it allows correlating usage
across both tools in your OTEL backend.

### `terminal.type`

Both tools auto-detect the terminal emulator from environment variables using
the same priority chain:

1. IDE-specific vars: `VSCODE_GIT_ASKPASS_MAIN` (cursor, windsurf, vscode), `TERMINAL_EMULATOR` (JetBrains)
2. Terminal-specific: `TERM` (ghostty, kitty), `TERM_PROGRAM` (fallback)
3. Multiplexers: `TMUX`, `STY` (screen)
4. Other terminals: `KONSOLE_VERSION`, `WT_SESSION`, `ALACRITTY_LOG`, etc.

---

## 8. Exporters

| Exporter | Claude Code | opencode-otel |
|---|---|---|
| OTLP gRPC | Yes | Yes |
| OTLP HTTP/JSON | Yes | Yes |
| OTLP HTTP/Protobuf | Yes | Yes |
| Prometheus (pull) | Yes (metrics only) | No |
| Console (stdout) | Yes | Yes |
| Multiple exporters | Yes (`OTEL_METRICS_EXPORTER=console,otlp`) | No (single exporter only) |

---

## 9. Privacy Controls

| Control | Claude Code | opencode-otel |
|---|---|---|
| Prompt text redaction | `OTEL_LOG_USER_PROMPTS` env var (default: off) | `logUserPrompts` JSON config (default: off) |
| Tool name/args redaction | `OTEL_LOG_TOOL_DETAILS` env var (default: off) | `logToolDetails` JSON config (default: off). Tool names show as `"redacted"` when off |
| Prompt text cap | Not documented | 4096 characters |
| Tool args cap | Not documented | 2048 characters |
| MCP server names | Controlled by `OTEL_LOG_TOOL_DETAILS` | N/A (OpenCode doesn't expose MCP tool provenance in hooks) |

---

## 10. SDK Implementation

| Aspect | Claude Code | opencode-otel |
|---|---|---|
| Runtime | Node.js (built-in) | Bun (OpenCode plugin runtime) |
| OTEL SDK | `@opentelemetry/*` JS packages | Same packages |
| Metrics SDK | `MeterProvider` + `PeriodicExportingMetricReader` | Same |
| Logs SDK | `LoggerProvider` + `BatchLogRecordProcessor` | Same |
| Metric type | All counters (monotonic) | All counters (monotonic) |
| Default temporality | Delta | Delta |
| Shutdown | Flushes on process exit | `beforeExit` + `SIGINT`/`SIGTERM` + flush after chat.message |
| Error handling | Internal (cannot crash CLI) | `try/catch` in every hook (telemetry never crashes OpenCode) |
| Config validation | Runtime type checks | Valibot schema validation |
| Dynamic headers | `otelHeadersHelper` setting | Not supported |
| mTLS | `OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY/CERTIFICATE` | Not supported |

---

## 11. Enterprise / Admin Features

| Feature | Claude Code | opencode-otel |
|---|---|---|
| Managed settings (MDM) | Yes — `/Library/Application Support/ClaudeCode/managed-settings.json` | No |
| Server-managed settings | Yes — organization admins can push telemetry config | No |
| Per-signal endpoint overrides | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `metricsEndpoint`, `logsEndpoint` JSON config |
| Per-signal protocol overrides | `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL` | Not supported |
| Reference monitoring stack | [claude-code-monitoring-guide](https://github.com/anthropics/claude-code-monitoring-guide) | Compatible with the same stack |

---

## 12. Migration Guide: Claude Code OTEL -> opencode-otel

### 12.1 Converting env vars to JSON config

Create `~/.config/opencode/otel.json` and translate your env vars:

```bash
# Before (Claude Code env vars):
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otel.example.com"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_LOG_USER_PROMPTS="false"
export OTEL_METRICS_INCLUDE_SESSION_ID="true"
export OTEL_RESOURCE_ATTRIBUTES="user.email=dev@company.com"
```

```json
// After (~/.config/opencode/otel.json):
{
  "endpoint": "https://otel.example.com",
  "protocol": "grpc",
  "metricsExporter": "otlp",
  "logsExporter": "otlp",
  "logUserPrompts": false,
  "includeSessionId": true,
  "resourceAttributes": {
    "user.email": "dev@company.com"
  }
}
```

### 12.2 Dashboard adaptation

**Option A: Use the `claude-code` telemetry profile (recommended)**

Set `telemetryProfile: "claude-code"` in your JSON config. The plugin will emit
telemetry with matching naming: `service.name: "claude-code"`, meter scope
`com.anthropic.claude_code`, logger scope `com.anthropic.claude_code.events`,
metric prefix `claude_code.*`. The `user_prompt` event has been verified to
produce 100% attribute parity with Claude Code's output.

**Option B: Update dashboard queries**

If you prefer keeping separate identities, update the metric names:

| Claude Code query | opencode-otel query |
|---|---|
| `claude_code.session.count` | `opencode.session.count` |
| `claude_code.token.usage` | `opencode.token.usage` |
| `claude_code.cost.usage` | `opencode.cost.usage` |
| `claude_code.lines_of_code.count` | `opencode.lines_of_code.count` |
| `claude_code.commit.count` | `opencode.commit.count` |
| `claude_code.pull_request.count` | `opencode.pull_request.count` |
| `claude_code.code_edit_tool.decision` | `opencode.tool.decision` |
| `claude_code.active_time.total` | `opencode.active_time.total` |

The `service.name` resource attribute changes from `claude-code` to `opencode`.

### 12.3 Running both side by side

If you use both Claude Code and OpenCode, both can export to the same collector.
With the `claude-code` profile, they share the same `user.id` (from `~/.claude.json`)
and the same metric/event naming, making telemetry appear unified.

| | Claude Code | OpenCode (default) | OpenCode (`claude-code` profile) |
|---|---|---|---|
| `service.name` | `claude-code` | `opencode` | `claude-code` |
| Metric prefix | `claude_code.*` | `opencode.*` | `claude_code.*` |
| Meter scope | `com.anthropic.claude_code` | `com.opencode.telemetry` | `com.anthropic.claude_code` |
| Logger scope | `com.anthropic.claude_code.events` | `com.opencode.telemetry.events` | `com.anthropic.claude_code.events` |
| `user.id` | From `~/.claude.json` | From `~/.claude.json` (shared) | From `~/.claude.json` (shared) |

---

## 13. Verified Parity (OTLP Wire Format)

The following was verified by capturing actual OTLP HTTP/JSON payloads from
both Claude Code v2.1.49 and opencode-otel with `telemetryProfile: "claude-code"`,
using the built-in `otel-collector.ts` script.

### Matching

| Aspect | Status |
|---|---|
| Meter scope name | `com.anthropic.claude_code` |
| Logger scope name | `com.anthropic.claude_code.events` |
| `service.name` | `claude-code` |
| `os.type`, `os.version`, `host.arch` | Identical values |
| `user.id` | Same 64-char hex (shared `~/.claude.json`) |
| `terminal.type` | Same auto-detection |
| `session.count` metric (name, unit, attributes) | Identical |
| `user_prompt` event (all attributes) | **100% parity** |
| `event.name` format | Unprefixed in both |
| `event.timestamp` format | ISO 8601 string in both |
| `event.sequence` | Zero-indexed in both |
| `prompt.id` | UUID v4 in both |
| `telemetry.sdk.*` resource attributes | Suppressed (not present in either) |
| Aggregation temporality | Delta in both |
| Numeric event attribute types | String values in both (`stringValue` on the wire) |
| Severity fields on log records | Absent in both |
| No extra events | `plugin.started` and `session.created` suppressed |

### Expected differences

| Difference | Why |
|---|---|
| `service.version` values differ | Different apps, different version numbers |
| Token/cost metrics missing in short `opencode run` sessions | OpenCode may exit before `message.part.updated` fires |

---

## 14. Limitations of opencode-otel

| Limitation | Root cause | Workaround |
|---|---|---|
| Token/cost accuracy | Plugin observes `message.part.updated` events, which may not always include full usage data | None — depends on OpenCode exposing this data |
| No `api_error` events | OpenCode plugin system has no hook for LLM API errors | None — requires upstream support |
| No `tool_decision` events (accept/reject) | OpenCode plugin system only has `tool.execute.before/after`, not permission decision hooks | The `permission.ask` hook exists but doesn't carry tool execution decision metadata |
| Lines of code accuracy | `file.edited` events may not carry line counts; falls back to tool output heuristics | None — depends on OpenCode event data |
| No Prometheus exporter | Not implemented | Use OTLP exporter with Prometheus remote write on the collector |
| No multiple exporters | Not implemented | Use an OTEL Collector to fan out to multiple backends |
| No mTLS | Not implemented | Use an OTEL Collector as a local mTLS-terminating proxy |
| No dynamic header refresh | `otelHeadersHelper` not implemented | Restart OpenCode to pick up new credentials |
| `success` heuristic | Tool success is inferred by checking if output contains "Error" | May produce false positives/negatives |
| Short session data loss | `opencode run` may exit before periodic export fires | Plugin flushes after `chat.message` and on `session.idle`; add `metricExportIntervalMs: 5000` for shorter sessions |
