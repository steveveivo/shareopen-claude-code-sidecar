#!/usr/bin/env bash
# ShareOpen x Claude Code sidecar — installer (local mode).
set -euo pipefail

SHAREOPEN_URL="${SHAREOPEN_URL:-http://localhost:3021}"
AGENT_ID="${CC_AGENT_ID:?Set CC_AGENT_ID (ShareOpen agent id)}"
SO_TOKEN="${SO_AGENT_TOKEN:?Set SO_AGENT_TOKEN (agent's so_live_... token; POST /api/agents/:id/regenerate-token)}"

echo ">> Check claude CLI is installed..."
command -v claude >/dev/null 2>&1 || { echo "ERROR: 'claude' not found in PATH. Install Claude Code first: npm i -g @anthropic-ai/claude-code"; exit 1; }
echo "claude: $(command -v claude)"

echo ""
echo ">> Start sidecar (foreground — use tmux/systemd for production):"
echo "   node $(cd "$(dirname "$0")" && pwd)/index.js serve \\"
echo "     --agent-id $AGENT_ID \\"
echo "     --token \$SO_TOKEN \\"
echo "     --shareopen $SHAREOPEN_URL"
echo ""
echo ">> Optional: wire Claude Code hooks for progress (settings.json):"
echo '  { "hooks": { "Stop": [{ "matcher": "*", "hooks": ['
echo '      { "type": "command", "command": "node <path>/index.js hook --agent-id <id> --token <so> --event Stop" }'
echo '  ]}] } }'
