#!/usr/bin/env bash
set -e

echo "🚀 Setting up Confiador development environment with Proto..."

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
# ─────────────────────────────────────────────────────────────────────────────

# Install Proto-managed apps in .prototools
source /workspace/.devcontainer/on-create/setup-proto.sh

# Install and configure bash and zsh and completions
source /workspace/.devcontainer/on-create/setup-shell.sh

# Install Biome
source /workspace/.devcontainer/on-create/setup-biome.sh

# Install Claude Code
source /workspace/.devcontainer/on-create/setup-claude.sh

# Set up SSH server (host keys + authorized_keys)
source /workspace/.devcontainer/on-create/setup-ssh.sh

# Install Opencode
source /workspace/.devcontainer/on-create/setup-opencode.sh

# Install Oh-My-Opencode
source /workspace/.devcontainer/on-create/setup-oh-my-opencode.sh

# Install Openspec
source /workspace/.devcontainer/on-create/setup-openspec.sh

# Sync extensions.json from devcontainer.json (ensures it's always in sync)
if [ -f "/workspace/.devcontainer/scripts/sync-extensions-json.sh" ]; then
	echo "🔄 Syncing .vscode/extensions.json from devcontainer.json..."
	bash /workspace/.devcontainer/scripts/sync-extensions-json.sh || echo "⚠️  Could not sync extensions.json (this is okay)"
fi

# Install VS Code extensions (for DevPod compatibility)
source /workspace/.devcontainer/on-create/setup-vscode-extensions.sh

echo "✨ Development environment setup complete!"
echo "💡 Tips:"
echo "  - Use 'proto list' to see installed tools"
echo "  - Run 'p10k configure' to customize your prompt"
