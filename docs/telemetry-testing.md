# Telemetry Testing & Comparison

How to capture OTLP telemetry from Claude Code and opencode-otel, and compare
them side-by-side to verify wire-format parity.

## Prerequisites

- [Bun](https://bun.sh) installed
- Claude Code CLI (`claude`) installed
- OpenCode CLI (`opencode`) installed with the opencode-otel plugin

## Overview

The testing flow is:

1. Start a local OTLP collector
2. Point Claude Code at it, run a prompt, capture the output
3. Point opencode-otel at it, run the same prompt, capture the output
4. Compare the two captures

The project includes two helper scripts:

- `scripts/otel-collector.ts` — minimal HTTP/JSON OTLP receiver that writes each batch as a JSONL line
- `scripts/otel-compare.ts` — reads two JSONL captures and prints a structured diff of resource attributes, metrics, and events

## Step 1: Build and install the plugin locally

```bash
bun run install-local
```

This builds the plugin and symlinks it into `~/.config/opencode/plugins/`.

## Step 2: Configure both tools

Back up your existing configs first:

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak
cp ~/.config/opencode/otel.json ~/.config/opencode/otel.json.bak
```

### Claude Code

Edit `~/.claude/settings.json` and set (or add) the telemetry env vars to point at localhost:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_LOG_USER_PROMPTS": "true",
    "OTEL_RESOURCE_ATTRIBUTES": "user.email=you@example.com"
  }
}
```

### opencode-otel

Edit `~/.config/opencode/otel.json`:

```json
{
  "endpoint": "http://localhost:4318",
  "protocol": "http/json",
  "logUserPrompts": true,
  "telemetryProfile": "claude-code",
  "resourceAttributes": {
    "user.email": "you@example.com"
  }
}
```

Use `telemetryProfile: "claude-code"` so the naming matches and the comparison
is meaningful.

## Step 3: Capture Claude Code telemetry

Start the collector, run a prompt, then stop it:

```bash
# Terminal 1: start collector
bun run otel:collect -o claude-capture.jsonl

# Terminal 2: run a prompt
claude -p "What is 2+2? Answer in one word."

# Wait a few seconds for the export to flush, then Ctrl+C the collector
```

The collector logs each batch it receives. You should see at least one `[logs]`
batch and one `[metrics]` batch.

## Step 4: Capture opencode-otel telemetry

Start the collector again with a different output file, run the same prompt:

```bash
# Terminal 1: start collector
bun run otel:collect -o opencode-capture.jsonl

# Terminal 2: run the same prompt
opencode run "What is 2+2? Answer in one word."

# Wait a few seconds, then Ctrl+C the collector
```

## Step 5: Compare

```bash
bun run otel:compare claude-capture.jsonl opencode-capture.jsonl
```

This prints a table comparing:

- **Resource attributes** — key-by-key match (service.name, os.type, etc.)
- **Metrics** — names, units, data point counts, attribute keys
- **Events** — names, counts, attribute keys
- **Summary** — any metrics or events present in one file but not the other

Example output:

```
========================================================================
OTLP Telemetry Comparison
  Baseline:   claude-capture.jsonl
  Comparison: opencode-capture.jsonl
========================================================================

## Resource Attributes

  Attribute        claude-capture.jsonl  opencode-capture.jsonl  Match
  ---------------  --------------------  ----------------------  -----
  host.arch        arm64                 arm64                   yes
  os.type          darwin                darwin                  yes
  os.version       25.3.0                25.3.0                  yes
  service.name     claude-code           claude-code             yes
  service.version  2.1.49                0.2.0                   DIFFERS
  user.email       you@example.com       you@example.com         yes

## Metrics

  Metric Name                 claude-capture.jsonl  opencode-capture.jsonl  Attr Keys Match
  --------------------------  --------------------  ----------------------  ---------------
  claude_code.cost.usage      1 pts (USD)           1 pts (USD)             yes
  claude_code.session.count   1 pts ()              1 pts ()                yes
  claude_code.token.usage     4 pts (tokens)        3 pts (tokens)          yes

## Events (Log Records)

  Event Name   claude-capture.jsonl  opencode-capture.jsonl  Attr Keys Match
  -----------  --------------------  ----------------------  ---------------
  api_request  1                     1                       yes
  user_prompt  1                     1                       yes
```

## Step 6: Restore configs

```bash
cp ~/.claude/settings.json.bak ~/.claude/settings.json
cp ~/.config/opencode/otel.json.bak ~/.config/opencode/otel.json
```

## Tips

### Inspecting raw payloads

The JSONL files contain one JSON object per OTLP batch. Use `jq` to pretty-print:

```bash
# All log records
cat claude-capture.jsonl | jq 'select(._signal == "logs") | .resourceLogs[].scopeLogs[].logRecords[]'

# All metric data points
cat claude-capture.jsonl | jq 'select(._signal == "metrics") | .resourceMetrics[].scopeMetrics[].metrics[]'
```

### Testing interactive sessions

For richer telemetry (tool calls, multiple turns, errors), use interactive mode
instead of one-shot prompts. The `api_request`, `tool_result`, and `api_error`
events are more likely to appear.

### Custom port

If port 4318 conflicts with something else:

```bash
bun run otel:collect -o capture.jsonl -p 4319
```

Then update both configs to use `http://localhost:4319`.

### What to look for

When comparing, the key things to verify are:

1. **No extra resource attributes** — `telemetry.sdk.*` should be absent in claude-code profile
2. **Same event names** — `user_prompt`, `api_request` (no `plugin.started` or `session.created`)
3. **Same attribute types** — numeric values like `prompt_length` should be `stringValue`, not `intValue`
4. **Same aggregation temporality** — both should show `aggregationTemporality: 1` (DELTA)
5. **Same metric names and units** — `claude_code.session.count` (no unit), `claude_code.token.usage` (tokens), etc.
6. **`event.sequence` starts at 0** — first event should have `event.sequence: 0`

### Expected differences

These will always differ and are not bugs:

- `service.version` — Claude Code shows its version (e.g. `2.1.49`), opencode-otel shows the plugin version (e.g. `0.2.0`)
- `session.id` format — Claude Code uses UUID v4, OpenCode uses its own ID format (`ses_...`)
- Exact token/cost values — different models and caching behavior produce different numbers
- Scope `version` field — same root cause as `service.version`
