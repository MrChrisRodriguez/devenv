#!/usr/bin/env bash
set -e

echo "🤖 Installing Gemini CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install Gemini CLI (skip if already installed)
if command -v gemini &> /dev/null; then
    echo "ℹ️  Gemini CLI already installed, skipping"
else
    bun install -g @google/gemini-cli
fi

echo "✅ Gemini CLI installed!"
