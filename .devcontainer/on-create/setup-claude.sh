#!/usr/bin/env bash
set -e

echo "🤖 Setting up Claude Code environment..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install Claude Code CLI if not present
if ! command -v claude &> /dev/null; then
    echo "📦 Installing Claude Code CLI..."
    bun install -g @anthropic-ai/claude-code
fi

# Setup Claude Code configuration directory
mkdir -p ~/.config/claude-code

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