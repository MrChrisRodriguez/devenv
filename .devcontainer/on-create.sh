#!/usr/bin/env bash
set -e

echo "🚀 Setting up Confiador development environment with Proto..."

# Install Proto-managed apps in .prototools
source /workspace/.devcontainer/on-create/setup-proto.sh

# Install and configure bash and zsh and completions
source /workspace/.devcontainer/on-create/setup-shell.sh

# Install Biome
source /workspace/.devcontainer/on-create/setup-biome.sh

# Install Claude Code
source /workspace/.devcontainer/on-create/setup-claude.sh

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