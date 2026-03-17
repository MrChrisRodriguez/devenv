#!/usr/bin/env bash
set -e
# Install Proto and Proto-managed apps
# https://moonrepo.dev/proto

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Ensure ~/.proto is owned by the current user (Docker volumes are root-owned by default)
if [ "$(stat -c '%U' "${HOME}/.proto" 2>/dev/null)" != "$(whoami)" ]; then
    sudo chown -R "$(whoami):$(whoami)" "${HOME}/.proto"
fi

# Bootstrap proto into the ~/.proto volume if this is a fresh container
setup_proto_env
if ! command -v proto &> /dev/null; then
    echo "⬇️  Bootstrapping proto..."
    curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --yes
    setup_proto_env
fi

# Install tools and plugins via Proto from .prototools
echo "📦 Installing development tools and plugins via Proto from .prototools..."
proto use

# Update PATH to include shims after proto use
setup_proto_env