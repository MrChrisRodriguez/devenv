#!/usr/bin/env bash
set -e

echo "🕸️  Setting up Graphify (knowledge graph for AI assistants)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access uv
setup_proto_env

# Install the graphifyy CLI. All project-scoped skill files and hooks
# (.claude/skills/graphify/, .codex/hooks.json, .gemini/settings.json,
# .opencode/plugins/graphify.js, etc.) are committed to the repo — no
# `graphify install --project` needed here.
#
# The CLI lives at ~/.local/bin/graphify (where .codex/hooks.json references it).
# ~/.local is NOT volume-mounted, so this re-runs cleanly on every rebuild.

if ! command -v uv &> /dev/null; then
    echo "⚠️   uv not found on PATH (expected via Proto); skipping graphify install"
    return 0
fi

if command -v graphify &> /dev/null; then
    echo "ℹ️  graphify already installed at $(command -v graphify), skipping"
else
    echo "📦 Installing graphifyy via uv..."
    uv tool install graphifyy
fi

echo "✅ Graphify setup complete!"
