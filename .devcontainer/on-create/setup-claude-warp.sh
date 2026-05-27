#!/usr/bin/env bash
set -e

echo "⚡ Setting up Claude Code Warp plugin..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access the Claude Code binary
setup_proto_env

# ─── Claude Code (plugin marketplace) ────────────────────────────────────────
# ~/.claude is volume-mounted, so the plugin persists across rebuilds.
if ! command -v claude &> /dev/null; then
    echo "⚠️   claude CLI not found on PATH; skipping Claude Code Warp plugin install"
elif [ -d "$HOME/.claude/plugins/cache/claude-code-warp/warp" ]; then
    echo "ℹ️  warp plugin already installed for Claude Code, skipping"
else
    echo "🔌 Installing warp plugin for Claude Code..."
    claude plugin marketplace add warpdotdev/claude-code-warp \
        || echo "⚠️   Could not add claude-code-warp marketplace (may already exist)"
    claude plugin install warp@claude-code-warp \
        || echo "⚠️   Could not install warp plugin (run 'claude plugin install warp@claude-code-warp' manually)"
fi

echo "✅ Claude Code Warp setup complete!"
