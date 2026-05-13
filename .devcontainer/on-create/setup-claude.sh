#!/usr/bin/env bash
set -e

echo "🤖 Setting up Claude Code environment..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install node-gyp globally so Claude Code plugins with native deps can build
# (devcontainer node feature sets nodeGypDependencies:false; some plugins —
# e.g. claude-mem's tree-sitter post-installs — invoke node-gyp during their
# first bun/npm install and otherwise fail with ENOENT, silently breaking
# SessionStart hooks).
if command -v npm &> /dev/null && ! command -v node-gyp &> /dev/null; then
    echo "🔧 Installing node-gyp globally for plugin native deps..."
    npm install -g node-gyp >/dev/null 2>&1 || \
        echo "⚠️   Could not install node-gyp; some Claude Code plugins may fail their first install"
fi

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

# Configure RTK hook for Claude Code (token compression on bash output)
if command -v rtk &> /dev/null; then
    echo "🔧 Configuring RTK hook for Claude Code..."
    rtk init -g --auto-patch
fi

echo "✅ Claude Code setup complete!"