# @gcornut/opencode-otel

OpenTelemetry metrics and structured log events plugin for [OpenCode](https://opencode.ai). Mirrors the telemetry surface of Claude Code so you can reuse the same OTEL collector and dashboards.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["@gcornut/opencode-otel"]
}
```

Or as a local plugin, copy the `src/` directory to `.opencode/plugins/otel/`.

## Configuration

Create `~/.config/opencode/otel.json`:

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

All fields are optional except `endpoint` — without it, telemetry is disabled. Only set what you need.

You can override the config file path with `OPENCODE_OTEL_CONFIG_PATH=/path/to/otel.json`.

### Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | *(required)* | Collector URL (e.g. `https://otel.example.com`) |
| `metricsEndpoint` | string | | Override endpoint for metrics only |
| `logsEndpoint` | string | | Override endpoint for logs only |
| `metricsExporter` | string | `"otlp"` | `"otlp"`, `"console"`, or `"none"` |
| `logsExporter` | string | `"otlp"` | `"otlp"`, `"console"`, or `"none"` |
| `protocol` | string | `"grpc"` | `"grpc"`, `"http/json"`, or `"http/protobuf"` |
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

### Telemetry profile

When set to `"claude-code"`, the plugin emits telemetry that is **indistinguishable** from Claude Code's built-in telemetry: same `service.name` (`claude-code`), same meter name (`com.anthropic.claude_code`), same metric names (`claude_code.*`), and same event names (`claude_code.*`). This lets you reuse Claude Code dashboards and alerting rules without any modification.

### Example: minimal config

```json
{
  "endpoint": "https://otel-collector.example.com"
}
```

### Example: with per-signal endpoints

```json
{
  "endpoint": "https://otel-collector.example.com",
  "metricsEndpoint": "https://metrics.example.com/v1/metrics",
  "logsEndpoint": "https://logs.example.com/v1/logs"
}
```

### Disabling telemetry

To disable telemetry without removing the plugin, set both exporters to `"none"`:

```json
{
  "endpoint": "https://otel-collector.example.com",
  "metricsExporter": "none",
  "logsExporter": "none"
}
```

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
| *(custom)* | From `resourceAttributes` config | From `resourceAttributes` config |

## Differences from Claude Code

| Feature | Claude Code | opencode-otel |
|---|---|---|
| Master toggle | `CLAUDE_CODE_ENABLE_TELEMETRY=1` | Always on (set exporters to `none` to disable) |
| Configuration | Env vars (`OTEL_*`) | JSON file (`~/.config/opencode/otel.json`) |
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
