#!/bin/bash
#
# E2E Test Wrapper for onlyForProvider feature
#
# This script runs OpenCode with the E2E test config using OPENCODE_OTEL_CONFIG_PATH
# environment variable, so your personal otel.json is never modified.
#
# Usage:
#   ./scripts/e2e-run.sh [opencode-args]
#
# Examples:
#   ./scripts/e2e-run.sh --model claude-sonnet-4-vertex
#   ./scripts/e2e-run.sh run -p "Hello" --model kimi-k2.5
#   ./scripts/e2e-run.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_PATH="$PROJECT_ROOT/scripts/e2e-test-config.json"

# Verify config exists
if [ ! -f "$CONFIG_PATH" ]; then
    echo "❌ Error: Test config not found at $CONFIG_PATH"
    exit 1
fi

echo "🧪 Running OpenCode with E2E test config"
echo "   Config: $CONFIG_PATH"
echo "   Command: opencode $@"
echo ""

# Run opencode with the test config
OPENCODE_OTEL_CONFIG_PATH="$CONFIG_PATH" opencode "$@"
