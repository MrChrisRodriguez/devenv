#!/usr/bin/env bash
set -e

# All scripts in on-create/ are SOURCED from this file, not executed.
# Use `return N` for early termination, not `exit N` — `exit` from a sourced
# script kills the parent shell and silently halts the rest of the setup chain.

echo "🚀 Setting up ${DEVCONTAINER_PROJECT:-development} development environment with Proto..."

# ── Secrets ──────────────────────────────────────────────────────────────────
# Two-tier secrets loaded from the host bind-mount at /run/devcontainer-config.
# Each file uses KEY=value format (one per line; # lines are ignored).
# Both are written to /etc/environment so ALL container processes inherit them:
# VS Code/Cursor extension hosts, MCP server subprocesses, and terminals.
# Per-project values override common ones when the same key appears in both.

load_secrets_file() {
    local file="$1" label="$2"
    if [ -f "$file" ]; then
        echo "🔐 Loading $label secrets..."
        set -a
        # shellcheck source=/dev/null
        source "$file"
        set +a
        grep -v '^[[:space:]]*#' "$file" \
            | grep -v '^[[:space:]]*$' \
            | sed 's/^[[:space:]]*export[[:space:]]*//' \
            | sudo tee -a /etc/environment > /dev/null
        echo "✅ $label secrets loaded"
    else
        echo "ℹ️  No $label secrets file found ($file)"
    fi
}

# 1. Common secrets — shared across all projects
load_secrets_file "/run/devcontainer-config/secrets" "common"

# 2. Per-project secrets — overrides common values for this container only
if [ -n "${DEVCONTAINER_PROJECT:-}" ]; then
    load_secrets_file \
        "/run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT}" \
        "project (${DEVCONTAINER_PROJECT})"
fi

# 3. Warp ACP signals — captured on the host by initializeCommand
#    (.devcontainer/host/capture-warp-env.sh) so Claude Code detects Warp and uses
#    ACP structured output. Loaded the same way as secrets: into /etc/environment so
#    every container process (incl. the terminal Claude Code runs in) inherits it.
load_secrets_file "/run/devcontainer-config/warp-env" "Warp ACP"
# ─────────────────────────────────────────────────────────────────────────────

# ── Claim volume-mounted home dirs ───────────────────────────────────────────
# Docker named volumes mount empty as root:root unless the image pre-populated
# the path (copy-on-first-use seeds the volume with the image dir's ownership).
# Only ~/.proto is pre-created in the Dockerfile and ~/.config happens to be
# shipped by the base image; ~/.codex / ~/.gemini are not, so they mount as root
# and the vscode user can't write to them. Claim them all ONCE here, before any
# tool script runs, so correctness doesn't depend on per-script source order
# (e.g. setup-openspec.sh writes ~/.codex/prompts before setup-codex.sh runs).
for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config" "$HOME/.proto"; do
    if [ -d "$d" ] && [ "$(stat -c '%U' "$d")" != "$(whoami)" ]; then
        echo "🔧 Claiming $d for $(whoami) (volume mounts as root)..."
        sudo chown -R "$(whoami):$(whoami)" "$d"
    fi
done
# ─────────────────────────────────────────────────────────────────────────────

# Install Proto-managed apps in .prototools.
# HARD source (not optional): bun and the PATH for every later script depend on
# this, so a failure here should abort the whole setup rather than limp onward.
source /workspace/.devcontainer/on-create/setup-proto.sh

# ── Optional installers ──────────────────────────────────────────────────────
# Every script below is SOURCED into this `set -e` shell, so an unguarded
# `return N` or failing command would abort the ENTIRE remaining chain. That bit
# us before: a missing/old opencode makes setup-oh-my-opencode.sh `return 1`,
# which would skip everything after it — including setup-shell.sh (the script
# that installs the proto-activating ~/.zshrc). optional() degrades such a
# failure to a warning so the chain continues.
#
# Caveat: `source X || …` disables `set -e` *inside* X for that call, so X runs
# to completion and optional() reacts only to X's final/return status — not to a
# mid-script failure. That's fine for these standalone installers; where a
# specific step must be caught, guard that command directly (as the octopus
# mkdir/ln calls do with `|| echo`).
optional() {
    source "$1" || echo "⚠️   $(basename "$1") failed; continuing setup without it"
}

# Install Biome
optional /workspace/.devcontainer/on-create/setup-biome.sh

# Install Claude Code
optional /workspace/.devcontainer/on-create/setup-claude.sh

# Install ccstatusline (must run AFTER setup-claude.sh: it backs the statusLine
# command in ~/.claude/settings.json and installs to the non-persistent ~/.bun/bin)
optional /workspace/.devcontainer/on-create/setup-ccstatusline.sh

# Install Opencode
optional /workspace/.devcontainer/on-create/setup-opencode.sh

# Install Oh-My-Opencode
optional /workspace/.devcontainer/on-create/setup-oh-my-opencode.sh

# Install Openspec
optional /workspace/.devcontainer/on-create/setup-openspec.sh

# Install Gemini CLI
optional /workspace/.devcontainer/on-create/setup-gemini.sh

# Install Codex CLI
optional /workspace/.devcontainer/on-create/setup-codex.sh

# Install Claude Octopus (must run AFTER claude/codex/opencode so their CLIs are on PATH)
optional /workspace/.devcontainer/on-create/setup-claude-octopus.sh

# Install Claude Code Warp plugin (must run AFTER setup-claude.sh so claude CLI is on PATH)
optional /workspace/.devcontainer/on-create/setup-claude-warp.sh

# Install Graphify (must run AFTER setup-proto.sh for uv, and AFTER claude/codex/opencode/gemini so their CLIs are on PATH)
optional /workspace/.devcontainer/on-create/setup-graphify.sh

# Sync extensions.json from devcontainer.json (ensures it's always in sync)
if [ -f "/workspace/.devcontainer/scripts/sync-extensions-json.sh" ]; then
	echo "🔄 Syncing .vscode/extensions.json from devcontainer.json..."
	bash /workspace/.devcontainer/scripts/sync-extensions-json.sh || echo "⚠️  Could not sync extensions.json (this is okay)"
fi

# Install VS Code extensions (for DevPod compatibility)
optional /workspace/.devcontainer/on-create/setup-vscode-extensions.sh

# Install and configure bash and zsh and completions.
# NOTE: Must run LAST — tool installers (e.g. bun) overwrite ~/.zshrc, so our
# shell config must be written after all of them finish. HARD source (not
# optional): it's the final step (nothing downstream to strand) and it installs
# the proto-activating ~/.zshrc, so a failure here should surface, not be hidden.
source /workspace/.devcontainer/on-create/setup-shell.sh

echo "✨ Development environment setup complete!"
echo "💡 Tips:"
echo "  - Use 'proto list' to see installed tools"
echo "  - Run 'p10k configure' to customize your prompt"
