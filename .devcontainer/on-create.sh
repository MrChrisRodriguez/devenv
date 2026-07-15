#!/usr/bin/env bash
set -e

# All scripts in on-create/ are SOURCED from this file, not executed.
# Use `return N` for early termination, not `exit N` — `exit` from a sourced
# script kills the parent shell and silently halts the rest of the setup chain.

# Verify the image-owned Proto manifest and complete devcontainer fingerprint
# before any lifecycle action can execute a workspace-first PATH command.
# HARD source (not optional): every later step depends on this exact image.
source /workspace/.devcontainer/on-create/setup-proto.sh

echo "🚀 Configuring ${DEVCONTAINER_PROJECT:-development} from image-owned payloads..."

# ── Secrets ──────────────────────────────────────────────────────────────────
# Two-tier secrets from the host bind-mount at /run/devcontainer-config (common +
# per-project, KEY=value, # lines ignored). setup-secrets.sh exports them into
# THIS shell (so the tool installers below inherit API keys like GEMINI_API_KEY)
# and idempotently mirrors them into /etc/environment for non-shell readers (VS
# Code/Cursor extension hosts, MCP subprocesses). It is SOURCED here — not run via
# optional() — so the exports land in this process; the same script re-runs on
# postStartCommand to re-sync keys added after create. Per-project overrides common.
source /workspace/.devcontainer/on-create/setup-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────

# ── Claim mutable volume-mounted home dirs ───────────────────────────────────
# Docker named volumes mount empty as root:root unless the image pre-populated
# the path. Claim only mutable authentication/configuration volumes here.
# ~/.proto is part of the image and must never be chowned, installed, or repaired
# during container creation.
for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config"; do
    if [ -d "$d" ] && [ "$(stat -c '%U' "$d")" != "$(whoami)" ]; then
        echo "🔧 Claiming $d for $(whoami) (volume mounts as root)..."
        sudo chown -R "$(whoami):$(whoami)" "$d"
    fi
done
# ─────────────────────────────────────────────────────────────────────────────

# Project CLIs are repository-owned. Install them once before optional setup
# scripts and keep node_modules/.bin ahead of every global command location.
install_workspace_dependencies

# ── Optional payload verification and user configuration ─────────────────────
# Every script below is SOURCED into this `set -e` shell, so an unguarded
# `return N` or failing command would abort the ENTIRE remaining chain — it
# would skip everything after it, including setup-shell.sh (the script that
# installs the shell templates). optional() degrades convenience configuration
# failures to warnings; none of these scripts may install or repair image tools.
#
# Caveat: `source X || …` disables `set -e` *inside* X for that call, so X runs
# to completion and optional() reacts only to X's final/return status — not to a
# mid-script failure. That's fine for these standalone installers; where a
# specific step must be caught, guard that command directly (as the octopus
# mkdir/ln calls do with `|| echo`).
optional() {
    source "$1" || echo "⚠️   $(basename "$1") failed; continuing setup without it"
}

# Configure GitHub credential routing (org → token), so `git push` just works per repo
optional /workspace/.devcontainer/on-create/setup-git-credentials.sh

# Verify/configure the repository-local Biome CLI
optional /workspace/.devcontainer/on-create/setup-biome.sh

# Verify Claude Code and configure its user-scoped integrations
optional /workspace/.devcontainer/on-create/setup-claude.sh

# Verify ccstatusline and write its user-scoped statusLine configuration
optional /workspace/.devcontainer/on-create/setup-ccstatusline.sh

# Configure the repository-local OpenSpec CLI
optional /workspace/.devcontainer/on-create/setup-openspec.sh

# Verify the image-owned Gemini CLI
optional /workspace/.devcontainer/on-create/setup-gemini.sh

# Verify the image-owned Codex CLI
optional /workspace/.devcontainer/on-create/setup-codex.sh

# Install Claude Octopus (must run AFTER claude/codex so their CLIs are on PATH)
optional /workspace/.devcontainer/on-create/setup-claude-octopus.sh

# Install Claude Code Warp plugin (must run AFTER setup-claude.sh so claude CLI is on PATH)
optional /workspace/.devcontainer/on-create/setup-claude-warp.sh

# Verify the image-owned Graphify payload
optional /workspace/.devcontainer/on-create/setup-graphify.sh

# Sync extensions.json from devcontainer.json (ensures it's always in sync)
if [ -f "/workspace/.devcontainer/scripts/sync-extensions-json.sh" ]; then
	echo "🔄 Syncing .vscode/extensions.json from devcontainer.json..."
	/bin/bash /workspace/.devcontainer/scripts/sync-extensions-json.sh || echo "⚠️  Could not sync extensions.json (this is okay)"
fi

# Configure bash, zsh, persistent history, and completions. HARD source because
# it verifies the pinned image-owned Zinit payload before installing shell files.
source /workspace/.devcontainer/on-create/setup-shell.sh

echo "✨ Development environment setup complete!"
echo "💡 Tips:"
echo "  - Use 'proto list' to see installed tools"
echo "  - Run 'p10k configure' to customize your prompt"
