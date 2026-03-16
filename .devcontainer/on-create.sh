#!/usr/bin/env bash
set -e

echo "🚀 Setting up Confiador development environment with Proto..."

# ── Secrets ──────────────────────────────────────────────────────────────────
# Reads ~/.config/devcontainer/secrets from the host (bind-mounted read-only).
# Writes each key=value into /etc/environment so ALL container processes inherit
# them: VS Code/Cursor extension hosts, MCP server subprocesses, and terminals.
# Format: one KEY=value per line; lines starting with # are ignored.
SECRETS_FILE="/run/devcontainer-config/secrets"
if [ -f "$SECRETS_FILE" ]; then
    echo "🔐 Loading devcontainer secrets into /etc/environment..."
    set -a
    # shellcheck source=/dev/null
    source "$SECRETS_FILE"
    set +a
    grep -v '^[[:space:]]*#' "$SECRETS_FILE" \
        | grep -v '^[[:space:]]*$' \
        | sed 's/^[[:space:]]*export[[:space:]]*//' \
        | sudo tee -a /etc/environment > /dev/null
    echo "✅ Secrets loaded"
else
    echo "⚠️  No secrets file found. Create ~/.config/devcontainer/secrets on your host."
    echo "   Format: KEY=value (one per line). See devcontainer.json _comment_secrets."
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
