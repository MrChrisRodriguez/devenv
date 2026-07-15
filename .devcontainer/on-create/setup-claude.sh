#!/usr/bin/env bash
set -e

echo "🤖 Setting up Claude Code environment..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup the image tool environment before executing the baked CLI.
setup_proto_env

claude_binary="$HOME/.local/bin/claude"
node_gyp_binary="$HOME/.local/bin/node-gyp"

if [ ! -x "$claude_binary" ] || ! "$claude_binary" --version >/dev/null 2>&1; then
	echo "ERROR: Claude is missing or invalid in the image-owned payload; rebuild/recreate the devcontainer" >&2
	return 1
fi
if [ ! -x "$node_gyp_binary" ]; then
	echo "ERROR: node-gyp is missing from the image-owned Claude tools; rebuild/recreate the devcontainer" >&2
	return 1
fi
case "$(readlink -f "$node_gyp_binary")" in
	"$HOME/.payloads/claude-tools/"*) ;;
	*)
		echo "ERROR: node-gyp does not resolve inside the image-owned Claude tools" >&2
		return 1
		;;
esac
if ! "$node_gyp_binary" --version >/dev/null 2>&1; then
	echo "ERROR: the image-owned node-gyp payload is not executable; rebuild/recreate the devcontainer" >&2
	return 1
fi

# Ensure the mutable Claude Code IDE directory exists. Ownership is claimed once
# by on-create.sh; do not recursively chmod authentication or settings files.
echo "🔧 Setting up Claude Code IDE directory..."
mkdir -p "$HOME/.claude/ide"

# Register Context7 MCP server at user scope (writes to CLAUDE_CONFIG_DIR volume)
echo "🔌 Registering Context7 MCP server..."
if claude mcp get context7 &> /dev/null; then
    echo "   context7 MCP server already registered, skipping"
else
    claude mcp add --scope user context7 -- bunx @upstash/context7-mcp
fi

# Configure RTK hook for Claude Code (token compression on bash output)
if command -v rtk &> /dev/null; then
    echo "🔧 Configuring RTK hook for Claude Code..."
    rtk init -g --auto-patch
fi

echo "✅ Claude Code setup complete!"
