#!/usr/bin/env bash
set -e

echo "🤖 Installing Biome..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install Biome
# bun install -g biomejs/biome
bun add -D -E @biomejs/biome

# Note: there's an alias to biome in the .shell_common file
echo "✅ Biome installed!" 