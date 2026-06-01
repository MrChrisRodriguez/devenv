#!/usr/bin/env bash
set -e

echo "🐙 Setting up Claude Octopus (multi-LLM orchestration)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun and the Claude Code binary
setup_proto_env

# Canonical clone location — shared by Codex via symlinks so we
# only fetch the repo once per devcontainer rebuild. ~/.codex is
# NOT volume-mounted, so we re-clone on every rebuild regardless.
OCTOPUS_REPO="https://github.com/nyldn/claude-octopus.git"
OCTOPUS_DIR="$HOME/.local/share/claude-octopus"

# ─── Shared clone ────────────────────────────────────────────────────────────
if [ -d "$OCTOPUS_DIR/.git" ]; then
    echo "ℹ️  claude-octopus already cloned at $OCTOPUS_DIR, skipping"
else
    echo "📥 Cloning claude-octopus to $OCTOPUS_DIR..."
    mkdir -p "$(dirname "$OCTOPUS_DIR")"
    git clone --depth 1 "$OCTOPUS_REPO" "$OCTOPUS_DIR"
fi

# ─── Claude Code (plugin marketplace) ────────────────────────────────────────
# ~/.claude is volume-mounted, so the plugin persists across rebuilds.
if ! command -v claude &> /dev/null; then
    echo "⚠️   claude CLI not found on PATH; skipping Claude Code plugin install"
elif [ -d "$HOME/.claude/plugins/cache/nyldn-plugins/octo" ]; then
    echo "ℹ️  octo plugin already installed for Claude Code, skipping"
else
    echo "🔌 Installing octo plugin for Claude Code..."
    claude plugin marketplace add https://github.com/nyldn/plugins.git \
        || echo "⚠️   Could not add nyldn-plugins marketplace (may already exist)"
    claude plugin install octo@nyldn-plugins \
        || echo "⚠️   Could not install octo plugin (run 'claude plugin install octo@nyldn-plugins' manually)"
fi

# ─── Codex CLI (skills only, via symlink) ────────────────────────────────────
if command -v codex &> /dev/null; then
    CODEX_LINK="$HOME/.codex/claude-octopus"
    if [ -L "$CODEX_LINK" ] || [ -e "$CODEX_LINK" ]; then
        echo "ℹ️  $CODEX_LINK already exists, skipping"
    else
        echo "🔗 Linking claude-octopus into ~/.codex..."
        mkdir -p "$HOME/.codex" || echo "⚠️   Could not create ~/.codex; skipping Codex integration"
        ln -s "$OCTOPUS_DIR" "$CODEX_LINK" \
            || echo "⚠️   Could not link claude-octopus into ~/.codex; skipping Codex integration"
    fi
else
    echo "ℹ️  codex CLI not found, skipping Codex integration"
fi

# ─── Shared skills discovery symlink (used by Codex) ─────────────────────────
SKILLS_LINK="$HOME/.agents/skills/claude-octopus"
if [ -L "$SKILLS_LINK" ] || [ -e "$SKILLS_LINK" ]; then
    echo "ℹ️  $SKILLS_LINK already exists, skipping"
else
    echo "🔗 Linking claude-octopus skills into ~/.agents/skills..."
    mkdir -p "$HOME/.agents/skills" || echo "⚠️   Could not create ~/.agents/skills; skipping skills symlink"
    ln -s "$OCTOPUS_DIR/skills" "$SKILLS_LINK" \
        || echo "⚠️   Could not link claude-octopus skills into ~/.agents/skills"
fi

echo "✅ Claude Octopus setup complete!"
