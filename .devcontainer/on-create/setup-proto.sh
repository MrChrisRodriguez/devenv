#!/usr/bin/env bash
set -e
# Install Proto and Proto-managed apps
# https://moonrepo.dev/proto

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Proto is pre-installed in the Docker image — ensure it's available in the current session
setup_proto_env

# Install tools and plugins via Proto from .prototools
echo "📦 Installing development tools and plugins via Proto from .prototools..."
proto use

# Update PATH to include shims after proto use
setup_proto_env