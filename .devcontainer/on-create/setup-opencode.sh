#!/usr/bin/env bash
set -e

echo "🤖 Installing Opencode..."

# Function to setup Proto environment (same as in setup-proto.sh)
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

# Setup Proto environment to access bun
setup_proto_env

# Copy mounted auth file to the correct location during installation
# The auth file is mounted from the host at /tmp/opencode-auth.json
MOUNTED_FILE="/tmp/opencode-auth.json"
TARGET_DIR="${HOME}/.local/share/opencode"
TARGET_FILE="${TARGET_DIR}/auth.json"

if [ -f "$MOUNTED_FILE" ]; then
    # Check if target file is missing or older than mounted file
    if [ ! -f "$TARGET_FILE" ] || [ "$MOUNTED_FILE" -nt "$TARGET_FILE" ]; then
        echo "📋 Copying Opencode auth file..."
        mkdir -p "$TARGET_DIR"
        cp "$MOUNTED_FILE" "$TARGET_FILE"
        chmod 600 "$TARGET_FILE"
        echo "✅ Auth file copied to ${TARGET_FILE}"
    else
        echo "ℹ️  Auth file already up to date"
    fi
else
    echo "⚠️  Mounted auth file not found at ${MOUNTED_FILE} (this is okay if you'll configure auth later)"
fi

# Install Opencode
bun add -g opencode-ai@latest

echo "✅ Bun globals installed!" 