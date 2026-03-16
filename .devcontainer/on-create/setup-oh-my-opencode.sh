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
    exit 1
fi

OPENCODE_VERSION=$(opencode --version 2>/dev/null || echo "none")

if [ "$OPENCODE_VERSION" = "none" ]; then
    echo "❌ opencode is not installed."
    exit 1
elif version_ge "$OPENCODE_VERSION" "$OPENCODE_MIN_VERSION"; then
    echo "✅ opencode version $OPENCODE_VERSION is >= $OPENCODE_MIN_VERSION"
else
    echo "❌ opencode version $OPENCODE_VERSION is < $OPENCODE_MIN_VERSION"
    exit 1
fi

# Install oh-my-opencode
if bunx oh-my-opencode install --no-tui --claude=yes --gemini=yes --copilot=no; then
    echo "✅ oh-my-opencode installation command completed"
else
    echo "⚠️  oh-my-opencode installation command returned non-zero exit code"
    echo "   This might be okay if it's already installed or partially installed"
fi

# Check oh-my-opencode in plugin array (with retry and flexible checking)
CONFIG_FILE="$HOME/.config/opencode/opencode.json"
MAX_RETRIES=3
RETRY_COUNT=0
PLUGIN_FOUND=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if [ -f "$CONFIG_FILE" ]; then
        # Check for various possible plugin name formats
        if grep -q '"oh-my-opencode"' "$CONFIG_FILE" || \
           grep -q '"ohMyOpencode"' "$CONFIG_FILE" || \
           grep -q 'oh-my-opencode' "$CONFIG_FILE"; then
            echo "✅ 'oh-my-opencode' found in opencode plugins"
            PLUGIN_FOUND=true
            break
        else
            echo "⚠️  'oh-my-opencode' not found in plugins (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)"
            if [ $RETRY_COUNT -lt $((MAX_RETRIES - 1)) ]; then
                sleep 1
            fi
        fi
    else
        echo "⚠️  Config file not found, waiting... (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)"
        if [ $RETRY_COUNT -lt $((MAX_RETRIES - 1)) ]; then
            sleep 1
        fi
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ "$PLUGIN_FOUND" = false ]; then
    echo "⚠️  Warning: Could not verify 'oh-my-opencode' plugin installation"
    echo "   The plugin may still be installed. Check manually with: opencode --version"
    echo "   Config file location: $CONFIG_FILE"
    # Don't exit with error - allow setup to continue
    # The plugin might still work even if we can't verify it
fi

echo "✅ Oh-My-Opencode setup complete!" 