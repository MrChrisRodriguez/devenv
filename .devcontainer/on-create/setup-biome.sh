#!/usr/bin/env bash
set -e

echo "🤖 Verifying repository-local Biome..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

if [ ! -x /workspace/node_modules/.bin/biome ]; then
    echo "Repository-local Biome is missing after dependency installation" >&2
    return 1
fi

# Note: there's an alias to biome in the .shell_common file
echo "✅ Repository-local Biome is ready!"
