# @gcornut/opencode-otel

OpenTelemetry metrics and structured log events plugin for [OpenCode](https://opencode.ai). Mirrors the telemetry surface of Claude Code so you can reuse the same OTEL collector, dashboards, and env var conventions.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["@gcornut/opencode-otel"]
}
```

Or as a local plugin, copy the `src/` directory to `.opencode/plugins/otel/`.

## Configuration

Configuration can be provided via a **JSON file**, **environment variables**, or both. When both are present, env vars take precedence over the JSON file, which takes precedence over built-in defaults.

### JSON config file

Create `~/.config/opencode/otel.json` (following the standard OpenCode plugin convention):

You can override the path with `OPENCODE_OTEL_CONFIG_PATH=/path/to/otel.json`.

```json
{
  "endpoint": "https://<endpoint>",
  "protocol": "grpc",
  "metricsExporter": "otlp",
  "logsExporter": "otlp",
  "headers": {
    "Authorization": "Bearer <token>"
  },
  "resourceAttributes": {
    "user.email": "yourname@company.com",
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

All fields are optional — only set what you need. See the full schema below.

| Field | Type | Default | Description |
|---|---|---|---|
| `metricsExporter` | string | `"otlp"` | `"otlp"`, `"console"`, or `"none"` |
| `logsExporter` | string | `"otlp"` | `"otlp"`, `"console"`, or `"none"` |
| `protocol` | string | `"grpc"` | `"grpc"`, `"http/json"`, or `"http/protobuf"` |
| `endpoint` | string | `"http://localhost:4317"` | Collector URL |
| `headers` | object | `{}` | HTTP headers for OTLP requests |
| `resourceAttributes` | object | `{}` | Key-value pairs added to all telemetry |
| `metricExportIntervalMs` | number | `60000` | Metrics export interval (ms) |
| `logsExportIntervalMs` | number | `5000` | Logs export interval (ms) |
| `metricsTemporality` | string | `"delta"` | `"delta"` or `"cumulative"` |
| `logUserPrompts` | boolean | `false` | Include prompt text in log events |
| `logToolDetails` | boolean | `false` | Include tool names and args in log events |
| `includeSessionId` | boolean | `true` | Include `session.id` on metrics |
| `includeVersion` | boolean | `false` | Include `app.version` on metrics |
| `includeAccountUuid` | boolean | `true` | Include `user.account_uuid` on metrics |
| `telemetryProfile` | string | `"opencode"` | `"opencode"` or `"claude-code"` — emit events using Claude Code's naming |

### Environment variables

Env vars follow the same conventions as Claude Code, so you can reuse your existing config directly. **Env vars always override JSON config values.**

#### Core OTLP settings

| Variable | Default | Description |
|---|---|---|
| `OTEL_METRICS_EXPORTER` | `otlp` | `otlp`, `console`, or `none` |
| `OTEL_LOGS_EXPORTER` | `otlp` | `otlp`, `console`, or `none` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | `grpc`, `http/json`, or `http/protobuf` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | Collector URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | | `key=value,key=value` auth headers |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | | Override endpoint for metrics only |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | | Override endpoint for logs only |

### Export intervals

| Variable | Default | Description |
|---|---|---|
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metrics export interval (ms) |
| `OTEL_LOGS_EXPORT_INTERVAL` | `5000` | Logs export interval (ms) |

### Temporality

| Variable | Default | Description |
|---|---|---|
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `delta` | `delta` or `cumulative` |

### Privacy controls

| Variable | Default | Description |
|---|---|---|
| `OTEL_LOG_USER_PROMPTS` | `false` | Set `true` to include prompt text in events |
| `OTEL_LOG_TOOL_DETAILS` | `false` | Set `true` to include tool names and args |

### Cardinality controls

| Variable | Default | Description |
|---|---|---|
| `OTEL_METRICS_INCLUDE_SESSION_ID` | `true` | Include `session.id` attribute |
| `OTEL_METRICS_INCLUDE_VERSION` | `false` | Include `app.version` attribute |
| `OTEL_METRICS_INCLUDE_ACCOUNT_UUID` | `true` | Include `user.account_uuid` attribute |

### Telemetry profile

| Variable | Default | Description |
|---|---|---|
| `OTEL_TELEMETRY_PROFILE` | `opencode` | `"opencode"` or `"claude-code"` — see below |

When set to `"claude-code"`, the plugin emits telemetry that is **indistinguishable** from Claude Code's built-in telemetry: same `service.name` (`claude-code`), same meter name (`com.anthropic.claude_code`), same metric names (`claude_code.*`), and same event names (`claude_code.*`). This lets you reuse Claude Code dashboards and alerting rules without any modification.

### Resource attributes

| Variable | Description |
|---|---|
| `OTEL_RESOURCE_ATTRIBUTES` | Custom `key=value,key=value` pairs added to all telemetry |

### Resolution order

When both JSON and env vars are present, the merge works as follows:

1. **Env var** (if set and non-empty) wins
2. **JSON config** (if field is present) fills in the rest
3. **Built-in default** for anything not specified

For `headers` and `resourceAttributes`, values from both sources are **merged** (env var keys override JSON keys on conflict).

### Example: JSON config (recommended for teams)

`~/.config/opencode/otel.json`:
```json
{
  "endpoint": "https://<endpoint>",
  "protocol": "grpc",
  "resourceAttributes": {
    "team": "platform"
  }
}
```

Per-developer override via env:
```bash
export OTEL_RESOURCE_ATTRIBUTES="user.email=yourname@company.com"
```

Result: the endpoint and protocol come from JSON, and the resource attributes are merged (`team=platform` + `user.email=yourname@company.com`).

To use a custom config path:
```bash
export OPENCODE_OTEL_CONFIG_PATH="/path/to/my/otel.json"
```

### Example: env vars only (Claude Code compatible)

```bash
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://<endpoint>"
export OTEL_LOG_USER_PROMPTS="false"
export OTEL_METRICS_INCLUDE_ACCOUNT_UUID="true"
export OTEL_METRICS_INCLUDE_SESSION_ID="true"
export OTEL_METRICS_INCLUDE_VERSION="false"
export OTEL_RESOURCE_ATTRIBUTES="user.email=yourname@company.com"
```

These are the exact same env vars Claude Code uses. The plugin reads them identically.

## Exported Metrics

All metrics use the meter name `com.opencode.telemetry` (or `com.anthropic.claude_code` with `telemetryProfile: "claude-code"`).

The table below shows the default `opencode` profile. With `telemetryProfile: "claude-code"`, the prefix becomes `claude_code` (e.g. `claude_code.session.count`).

| Metric | Unit | Attributes |
|---|---|---|
| `opencode.session.count` | count | `session.id` |
| `opencode.active_time.total` | seconds | `session.id` |
| `opencode.token.usage` | tokens | `type` (input/output/cacheRead/cacheCreation), `model` |
| `opencode.cost.usage` | USD | `model` |
| `opencode.lines_of_code.count` | count | `type` (added/removed/modified) |
| `opencode.commit.count` | count | `session.id` |
| `opencode.pull_request.count` | count | `session.id` |
| `opencode.tool.decision` | count | `tool_name`, `decision` |

## Exported Events (via Logs)

Events are emitted as OTEL Log records with `event.name`. With `telemetryProfile: "claude-code"`, the prefix becomes `claude_code` (e.g. `claude_code.user_prompt`).

| Event | Key Attributes |
|---|---|
| `opencode.user_prompt` | `prompt_length`, `agent`, `model.provider`, `model.id`, `prompt` (if enabled) |
| `opencode.tool_result` | `tool_name`, `duration_ms`, `success`, `tool_args`, `tool_result_size_bytes` |
| `opencode.api_request` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd` |
| `opencode.session.created` | `session.id`, `session.title` |
| `opencode.plugin.started` | `plugin.name`, `otel.endpoint`, `otel.protocol` |

## Resource Attributes

All telemetry includes:

| Attribute | `opencode` profile | `claude-code` profile |
|---|---|---|
| `service.name` | `opencode` | `claude-code` |
| `service.version` | Plugin version | Plugin version |
| `os.type` | `darwin`, `linux`, `win32` | `darwin`, `linux`, `win32` |
| `host.arch` | `arm64`, `x64`, etc. | `arm64`, `amd64`, etc. (Go-style) |
| *(custom)* | From `OTEL_RESOURCE_ATTRIBUTES` | From `OTEL_RESOURCE_ATTRIBUTES` |

## Differences from Claude Code

| Feature | Claude Code | opencode-otel |
|---|---|---|
| Master toggle | `CLAUDE_CODE_ENABLE_TELEMETRY=1` | Always on (set exporters to `none` to disable) |
| Impersonation | N/A | `telemetryProfile: "claude-code"` emits identical naming |
| Prometheus exporter | Supported | Not yet (use OTLP -> Prometheus remote write) |
| Traces | Not supported | Not supported |
| Token/cost tracking | Direct from API | Best-effort from message part events |
| `otelHeadersHelper` | Supported (script for dynamic headers) | Not yet |
| mTLS | Supported | Not yet (use OTEL collector as proxy) |

## Architecture

```
OpenCode
  |
  +-- opencode-otel plugin
        |
        +-- event hook -----> session/file/message events ---> OTEL Metrics + Logs
        +-- chat.message ---> user prompt events ------------> OTEL Logs
        +-- tool.execute.* -> tool timing/result events -----> OTEL Metrics + Logs
        |
        +-- MeterProvider (PeriodicExportingMetricReader)
        +-- LoggerProvider (BatchLogRecordProcessor)
        |
        +-- OTLP gRPC/HTTP Exporter --> your OTEL Collector
```

## Development

```bash
bun install
bun run typecheck
bun run build
```

## License

MIT
