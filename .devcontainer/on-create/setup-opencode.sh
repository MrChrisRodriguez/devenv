#!/usr/bin/env bash
set -e

echo "🤖 Installing Bun globals..."

# Function to setup Proto environment (same as in setup-proto.sh)
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

# Setup Proto environment to access bun
setup_proto_env

# bun add -g biome
bun add -g opencode-ai@latest

echo "✅ Bun globals installed!" 