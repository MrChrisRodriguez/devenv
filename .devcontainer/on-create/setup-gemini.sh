#!/usr/bin/env bash
set -e

echo "🤖 Installing Gemini CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# ~/.gemini is a Docker named volume; empty volumes mount as root:root, so the
# vscode user can't write to it. Claim it (mirrors what setup-claude.sh does for
# ~/.claude) before anything tries to write here.
if [ "$(stat -c '%U' "$HOME/.gemini" 2>/dev/null)" != "vscode" ]; then
    echo "🔧 Claiming ~/.gemini for vscode (volume mounts as root)..."
    sudo chown -R vscode:vscode "$HOME/.gemini"
fi

# Install Gemini CLI (skip if already installed)
if command -v gemini &> /dev/null; then
    echo "ℹ️  Gemini CLI already installed, skipping"
else
    bun install -g @google/gemini-cli
fi

echo "✅ Gemini CLI installed!"
