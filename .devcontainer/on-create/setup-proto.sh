#!/usr/bin/env bash
set -e
# Install Proto and Proto-managed apps
# https://moonrepo.dev/proto

# Function to setup Proto environment
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

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