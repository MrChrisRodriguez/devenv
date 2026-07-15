#!/usr/bin/env bash
set -e

echo "📚 Verifying the image-owned Context7 MCP payload..."

source /workspace/.devcontainer/on-create/setup-common.sh
setup_proto_env

context7_binary="$HOME/.local/bin/context7-mcp"
context7_payload="$HOME/.payloads/context7/"
if [ ! -x "$context7_binary" ]; then
	echo "ERROR: Context7 MCP is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
	return 1
fi
case "$(readlink -f "$context7_binary")" in
	"$context7_payload"*) ;;
	*)
		echo "ERROR: Context7 MCP does not resolve inside $context7_payload" >&2
		return 1
		;;
esac
if ! "$context7_binary" --help >/dev/null 2>&1; then
	echo "ERROR: the image-owned Context7 MCP payload is not executable" >&2
	return 1
fi

echo "✅ Image-owned Context7 MCP payload verified"
