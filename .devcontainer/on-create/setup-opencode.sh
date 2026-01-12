#!/usr/bin/env bash
set -e

echo "🤖 Installing Opencode..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Copy mounted auth file to the correct location during installation
# The auth file is mounted from the host directory at /mnt/opencode-mount/auth.json
MOUNTED_FILE="/mnt/opencode-mount/auth.json"
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
bun install -g opencode-ai


echo "✅ Opencode installed!" 