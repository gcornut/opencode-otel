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
| `includeSessionId` | boolean | `true` | Include `session.id` on metrics and events |
| `includeVersion` | boolean | `false` | Include `app.version` on metrics and events |
| `includeAccountUuid` | boolean | `true` | Include `user.account_uuid` on metrics |
| `telemetryProfile` | string | `"opencode"` | `"opencode"` or `"claude-code"` — emit events using Claude Code's naming |

### Telemetry profile

When set to `"claude-code"`, the plugin emits telemetry that closely matches Claude Code's built-in telemetry: same `service.name` (`claude-code`), same meter name (`com.anthropic.claude_code`), same logger name (`com.anthropic.claude_code.events`), same metric names (`claude_code.*`), and same event body format (`claude_code.*`). This lets you reuse Claude Code dashboards and alerting rules without modification.

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

## Telemetry signals

**8 metrics** (counters): `session.count`, `active_time.total`, `token.usage`, `cost.usage`, `lines_of_code.count`, `commit.count`, `pull_request.count`, `tool.decision`

**3 events** (OTEL Log records): `user_prompt`, `tool_result`, `api_request`

All signals include `user.id`, `session.id`, and `terminal.type` attributes. Events also include `event.timestamp` (ISO 8601), `event.sequence`, and `prompt.id`.

With `telemetryProfile: "claude-code"`, metric names use the `claude_code.*` prefix and the wire format closely matches Claude Code's built-in telemetry. See [docs/claude-code-vs-opencode-otel.md](docs/claude-code-vs-opencode-otel.md) for a detailed comparison.

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

### Local testing with collector

```bash
# Start the built-in OTLP collector
bun run otel:collect -o telemetry.jsonl

# In another terminal, run opencode or claude with telemetry pointed at localhost:4318
# Then compare captures:
bun run otel:compare claude.jsonl opencode.jsonl
```

## License

MIT
