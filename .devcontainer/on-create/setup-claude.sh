#!/usr/bin/env bash
set -e

echo "🤖 Setting up Claude Code environment..."

# Function to setup Proto environment (same as in setup-proto.sh)
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

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

echo "✅ Claude Code setup complete!" 