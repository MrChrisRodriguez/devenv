#!/usr/bin/env bash
set -e

echo "🤖 Setting up Claude Code environment..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Remove bun-installed claude-code if present (we use the native binary instead)
if bun pm ls -g 2>/dev/null | grep -q '@anthropic-ai/claude-code'; then
    echo "🧹 Removing bun-installed @anthropic-ai/claude-code (replaced by native binary)..."
    bun remove -g @anthropic-ai/claude-code
fi

# Install Claude Code native binary if not present
if [ ! -f "$HOME/.local/bin/claude" ]; then
    echo "📦 Installing Claude Code native binary..."
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
fi

# Ensure the Claude Code IDE directory exists with proper permissions
echo "🔧 Setting up Claude Code IDE directory..."
sudo mkdir -p /home/vscode/.claude/ide
sudo chown -R vscode:vscode /home/vscode/.claude
sudo chmod -R 755 /home/vscode/.claude

# Register Context7 MCP server at user scope (writes to CLAUDE_CONFIG_DIR volume)
echo "🔌 Registering Context7 MCP server..."
if claude mcp get context7 &> /dev/null; then
    echo "   context7 MCP server already registered, skipping"
else
    claude mcp add --scope user context7 -- bunx @upstash/context7-mcp
fi

echo "✅ Claude Code setup complete!"