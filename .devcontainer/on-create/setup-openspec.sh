#!/usr/bin/env bash
set -e

echo "🤖 Installing Openspec..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Install Openspec
bun add -D @fission-ai/openspec
openspec init --tools cursor,opencode
alias openspec='bunx @fission-ai/openspec'

echo "✅ Openspec installed!" 