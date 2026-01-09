#!/usr/bin/env bash
set -e

echo "🤖 Installing Oh-My-Opencode..."

# Function to setup Proto environment (same as in setup-proto.sh)
setup_proto_env() {
    export PATH="$HOME/.proto/shims:$HOME/.proto/bin:$PATH"
    export PROTO_HOME="$HOME/.proto"
}

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

bunx oh-my-opencode install --no-tui --claude=yes --chatgpt=yes --gemini=yes

# Check oh-my-opencode in plugin array
if [ -f "$HOME/.config/opencode/opencode.json" ]; then
    if grep -q '"oh-my-opencode"' "$HOME/.config/opencode/opencode.json"; then
        echo "✅ 'oh-my-opencode' found in opencode plugins"
    else
        echo "❌ 'oh-my-opencode' not found in opencode plugins"
        exit 1
    fi
else
    echo "❌ ~/.config/opencode/opencode.json does not exist"
    exit 1
fi

echo "✅ OpenCode installed!" 