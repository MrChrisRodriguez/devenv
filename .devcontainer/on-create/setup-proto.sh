#!/usr/bin/env bash
set -e
# Install Proto and Proto-managed apps
# https://moonrepo.dev/proto

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

if ! command -v proto &> /dev/null; then
    echo "🛠️ Installing Proto..."
    bash <(curl -fsSL https://moonrepo.dev/install/proto.sh) --yes
    setup_proto_env
else
    echo "✅ Proto already installed"
fi

# Ensure Proto is available in the current session
setup_proto_env

# Install tools and plugins via Proto from .prototools
echo "📦 Installing development tools and plugins via Proto from .prototools..."
proto use

# Update PATH to include shims after proto use
setup_proto_env