#!/usr/bin/env bash
set -e

echo "🤖 Verifying image-owned Codex CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup the image tool environment before executing the baked CLI.
setup_proto_env

codex_binary="$HOME/.local/bin/codex"
codex_payload="$HOME/.payloads/codex/"

if [ ! -x "$codex_binary" ]; then
	echo "ERROR: Codex is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
	return 1
fi
case "$(readlink -f "$codex_binary")" in
	"$codex_payload"*) ;;
	*)
		echo "ERROR: Codex does not resolve inside $codex_payload; rebuild/recreate the devcontainer" >&2
		return 1
		;;
esac
if ! "$codex_binary" --version >/dev/null 2>&1; then
	echo "ERROR: the image-owned Codex payload is not executable; rebuild/recreate the devcontainer" >&2
	return 1
fi

mkdir -p "$HOME/.codex"
echo "✅ Image-owned Codex CLI verified"
