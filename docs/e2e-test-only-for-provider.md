# E2E Test: onlyForProvider Feature

This guide walks you through testing the `onlyForProvider` config option with actual OpenCode runs.

## Prerequisites

1. OpenCode installed and configured
2. This plugin built and installed locally
3. Access to at least two providers:
   - **Vertex AI** (for the "matching" test case)
   - **OpenCode Zen** (Kimi K2.5) or **Anthropic** (for the "non-matching" test case)

## Test Setup

### Step 1: Build and Install Plugin

```bash
cd /Users/gcornut/git/opencode-otel
bun run build
bun run plugin-install:local
```

### Step 2: Start Local OTLP Collector

Open a terminal and start the collector that will capture telemetry:

```bash
cd /Users/gcornut/git/opencode-otel
bun run otel:collect -o e2e-test-results.jsonl
```

This starts a server on `http://localhost:4318` that receives OTLP HTTP/JSON.

### Step 3: Configure OpenCode for Test

Copy the test config to your OpenCode config directory:

```bash
cp scripts/e2e-test-config.json ~/.config/opencode/otel.json
```

**Note**: This config has `onlyForProvider: "vertex"`, so it will only emit telemetry for Vertex AI provider.

## Test Case 1: Non-Matching Provider (Should NOT Emit Telemetry)

**Provider**: OpenCode Zen (Kimi K2.5)  
**Expected**: No telemetry should be captured

1. In a new terminal, run OpenCode with Kimi:

```bash
opencode run -p "Say hello" --model kimi-k2.5
```

Or start interactive mode:

```bash
opencode --model kimi-k2.5
```

2. Send any simple prompt like "Say hello"

3. Wait for the response to complete

4. **Verification**: Check the collector terminal - no new lines should appear in `e2e-test-results.jsonl`

## Test Case 2: Matching Provider (SHOULD Emit Telemetry)

**Provider**: Vertex AI (Claude Sonnet 4.6)  
**Expected**: Telemetry SHOULD be captured

1. Run OpenCode with Vertex:

```bash
opencode run -p "Say hello from vertex" --model claude-sonnet-4-vertex
```

Or start interactive mode:

```bash
opencode --model claude-sonnet-4-vertex
```

2. Send a simple prompt like "Say hello from vertex"

3. Wait for the response to complete

4. **Verification**: Check the collector terminal - you should see new JSON lines added to `e2e-test-results.jsonl`

## Verification Steps

### Check Telemetry File

```bash
# See how many batches were captured
wc -l e2e-test-results.jsonl

# View the captured telemetry
head -1 e2e-test-results.jsonl | jq .
```

### What to Look For

**Test Case 1 (Kimi - should have NO telemetry)**:
- File should be empty or unchanged from before
- Collector terminal should show no new requests

**Test Case 2 (Vertex - should have telemetry)**:
- File should contain JSON lines
- Each line represents one batch of metrics/logs
- Look for events with `event.name` like `user_prompt`, `api_request`, etc.
- Check that `model.provider` attribute is set to `vertex`

### Pretty-Print Verification

```bash
# Check first batch - should have metrics
head -1 e2e-test-results.jsonl | jq '.resourceMetrics | length'

# Should output: 1 (or more if multiple metric batches)

# Check for user_prompt events
head -1 e2e-test-results.jsonl | jq '.scopeLogs[0].logRecords[] | select(.body == "opencode.user_prompt")'
```

## Cleanup

### Stop Collector

Press `Ctrl+C` in the collector terminal to stop it.

### Restore Original Config

If you had a previous config:

```bash
# Restore your original config
mv ~/.config/opencode/otel.json.backup ~/.config/opencode/otel.json
```

Or remove the test config:

```bash
rm ~/.config/opencode/otel.json
```

### Cleanup Test File

```bash
rm e2e-test-results.jsonl
```

## Expected Results Summary

| Test | Provider | Expected Telemetry | File Lines |
|------|----------|-------------------|------------|
| 1 | Kimi K2.5 (Zen) | NO | 0 (or unchanged) |
| 2 | Claude Sonnet (Vertex) | YES | 1+ |

## Troubleshooting

### "No connection to localhost:4318"

Make sure the collector is running:

```bash
lsof -i :4318
```

If nothing shows up, restart the collector.

### "Plugin not loading"

Check plugin installation:

```bash
ls -la ~/.config/opencode/plugins/
```

You should see `opencode-otel` directory or symlink.

### "Config not being read"

Check config file exists and is valid JSON:

```bash
cat ~/.config/opencode/otel.json | jq .
```

### Debug Mode

Run OpenCode with debug logging to see plugin activity:

```bash
DEBUG=opencode:* opencode --model claude-sonnet-4-vertex
```

## Alternative: Automated Verification Script

If you want to automate the verification, you can use:

```bash
# After running Test Case 1, save state
wc -l e2e-test-results.jsonl > /tmp/before_count.txt

# After running Test Case 2, compare
wc -l e2e-test-results.jsonl > /tmp/after_count.txt

# Check if Test Case 2 added lines
[ "$(cat /tmp/after_count.txt)" -gt "$(cat /tmp/before_count.txt)" ] && echo "✅ Telemetry captured" || echo "❌ No telemetry"
```
