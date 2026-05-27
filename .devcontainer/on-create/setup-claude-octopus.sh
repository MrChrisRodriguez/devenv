#!/usr/bin/env bash
set -e

echo "🐙 Setting up Claude Octopus (multi-LLM orchestration)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun and the Claude Code binary
setup_proto_env

# Canonical clone location — shared by Codex and OpenCode via symlinks so we
# only fetch the repo once per devcontainer rebuild. ~/.codex and ~/.opencode
# are NOT volume-mounted, so we re-clone on every rebuild regardless.
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
        mkdir -p "$HOME/.codex"
        ln -s "$OCTOPUS_DIR" "$CODEX_LINK"
    fi
else
    echo "ℹ️  codex CLI not found, skipping Codex integration"
fi

# ─── OpenCode (skills only, via symlink) ─────────────────────────────────────
if command -v opencode &> /dev/null; then
    OPENCODE_LINK="$HOME/.opencode/claude-octopus"
    if [ -L "$OPENCODE_LINK" ] || [ -e "$OPENCODE_LINK" ]; then
        echo "ℹ️  $OPENCODE_LINK already exists, skipping"
    else
        echo "🔗 Linking claude-octopus into ~/.opencode..."
        mkdir -p "$HOME/.opencode"
        ln -s "$OCTOPUS_DIR" "$OPENCODE_LINK"
    fi
else
    echo "ℹ️  opencode CLI not found, skipping OpenCode integration"
fi

# ─── Shared skills discovery symlink (used by both Codex and OpenCode) ───────
SKILLS_LINK="$HOME/.agents/skills/claude-octopus"
if [ -L "$SKILLS_LINK" ] || [ -e "$SKILLS_LINK" ]; then
    echo "ℹ️  $SKILLS_LINK already exists, skipping"
else
    echo "🔗 Linking claude-octopus skills into ~/.agents/skills..."
    mkdir -p "$HOME/.agents/skills"
    ln -s "$OCTOPUS_DIR/skills" "$SKILLS_LINK"
fi

echo "✅ Claude Octopus setup complete!"
