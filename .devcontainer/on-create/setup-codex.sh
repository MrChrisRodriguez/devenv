#!/usr/bin/env bash
set -e

echo "🤖 Installing Codex CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# (~/.codex ownership is claimed upfront in on-create.sh, before any tool script
# runs — so writes here, e.g. OpenSpec's earlier Codex refresh, don't hit EACCES.)

# Install Codex CLI (skip if already installed)
if command -v codex &> /dev/null; then
    echo "ℹ️  Codex CLI already installed, skipping"
else
    bun install -g @openai/codex
fi

echo "✅ Codex CLI installed!"
