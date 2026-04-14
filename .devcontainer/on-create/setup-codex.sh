#!/usr/bin/env bash
set -e

echo "🤖 Installing Codex CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install Codex CLI (skip if already installed)
if command -v codex &> /dev/null; then
    echo "ℹ️  Codex CLI already installed, skipping"
else
    bun install -g @openai/codex
fi

echo "✅ Codex CLI installed!"
