#!/usr/bin/env bash
set -e

echo "🤖 Installing Oh-My-Opencode..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access bun
setup_proto_env

# Check if opencode is installed and version is >= 1.0.150, else fail.
OPENCODE_MIN_VERSION="1.0.150"

version_ge() {
    # returns 0 if $1 >= $2
    [ "$1" = "$2" ] && return 0
    [ "$(printf "%s\n%s" "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

if ! command -v opencode &> /dev/null; then
    echo "OpenCode is not installed. Please install it first."
    echo "Ref: https://opencode.ai/docs"
    return 1
fi

OPENCODE_VERSION=$(opencode --version 2>/dev/null || echo "none")

if [ "$OPENCODE_VERSION" = "none" ]; then
    echo "❌ opencode is not installed."
    return 1
elif version_ge "$OPENCODE_VERSION" "$OPENCODE_MIN_VERSION"; then
    echo "✅ opencode version $OPENCODE_VERSION is >= $OPENCODE_MIN_VERSION"
else
    echo "❌ opencode version $OPENCODE_VERSION is < $OPENCODE_MIN_VERSION"
    return 1
fi

# Bypass the upstream `bunx oh-my-opencode install` flow — its version compare
# is lexicographic, so opencode 1.14.x is mis-detected as < 1.4.0 and the
# installer aborts without writing opencode.json. Install the plugin package
# and write the config directly instead.
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

is_plugin_configured() {
    [ -f "$CONFIG_FILE" ] && \
        grep -q -e '"oh-my-opencode"' -e '"oh-my-openagent"' "$CONFIG_FILE"
}

if is_plugin_configured; then
    echo "ℹ️   oh-my-opencode already configured in $CONFIG_FILE, skipping"
else
    # Install the plugin package globally so opencode can resolve it at runtime
    if ! bun pm ls -g 2>/dev/null | grep -q 'oh-my-opencode'; then
        echo "📦 Installing oh-my-opencode globally..."
        bun install -g oh-my-opencode
    fi

    # Write a minimal opencode.json that registers the plugin under its new name
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oh-my-openagent"]
}
JSON
    echo "✅ Wrote $CONFIG_FILE with oh-my-openagent plugin entry"
fi

echo "✅ Oh-My-Opencode setup complete!" 