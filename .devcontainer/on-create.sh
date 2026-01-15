#!/usr/bin/env bash
set -e

echo "🚀 Setting up Confiador development environment with Proto..."

# Install required system packages
echo "📦 Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y \
bat \
build-essential \
ca-certificates \
curl \
dnsutils \
fzf \
git \
gh \
gzip \
less \
ripgrep \
tree \
unzip \
xz-utils 

sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*

# Install git-delta
echo "📦 Installing git-delta..."
ARCH=$(dpkg --print-architecture) && \
  wget -q --show-progress "https://github.com/dandavison/delta/releases/download/0.18.2/git-delta_0.18.2_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_0.18.2_${ARCH}.deb" && \
  rm "git-delta_0.18.2_${ARCH}.deb"

# Install Proto and Proto-managed apps in .prototools
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