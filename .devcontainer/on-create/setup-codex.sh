#!/usr/bin/env bash
set -e

echo "🤖 Installing Codex CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# ~/.codex is a Docker named volume; empty volumes mount as root:root, so the
# vscode user can't write to it. Claim it (mirrors what setup-claude.sh does for
# ~/.claude). Without this, later steps that write here fail with "Permission
# denied" — e.g. OpenSpec's Codex refresh and the Claude Octopus symlink, the
# latter of which previously aborted the whole on-create chain under `set -e`.
if [ "$(stat -c '%U' "$HOME/.codex" 2>/dev/null)" != "vscode" ]; then
    echo "🔧 Claiming ~/.codex for vscode (volume mounts as root)..."
    sudo chown -R vscode:vscode "$HOME/.codex"
fi

# Install Codex CLI (skip if already installed)
if command -v codex &> /dev/null; then
    echo "ℹ️  Codex CLI already installed, skipping"
else
    bun install -g @openai/codex
fi

echo "✅ Codex CLI installed!"
