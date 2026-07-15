#!/usr/bin/env bash
set -e

echo "🤖 Configuring repository-local OpenSpec..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

if [ ! -x /workspace/node_modules/.bin/openspec ]; then
    echo "Repository-local OpenSpec is missing after dependency installation" >&2
    return 1
fi
/workspace/node_modules/.bin/openspec init --tools claude,codex,cursor --force || return 1

echo "✅ Repository-local OpenSpec configured!"
