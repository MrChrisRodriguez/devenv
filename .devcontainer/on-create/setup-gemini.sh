#!/usr/bin/env bash
set -e

echo "🤖 Verifying image-owned Gemini CLI..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup the image tool environment before executing the baked CLI.
setup_proto_env

gemini_binary="$HOME/.local/bin/gemini"
gemini_payload="$HOME/.payloads/gemini/"

if [ ! -x "$gemini_binary" ]; then
	echo "ERROR: Gemini is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
	return 1
fi
case "$(readlink -f "$gemini_binary")" in
	"$gemini_payload"*) ;;
	*)
		echo "ERROR: Gemini does not resolve inside $gemini_payload; rebuild/recreate the devcontainer" >&2
		return 1
		;;
esac
if ! "$gemini_binary" --version >/dev/null 2>&1; then
	echo "ERROR: the image-owned Gemini payload is not executable; rebuild/recreate the devcontainer" >&2
	return 1
fi

mkdir -p "$HOME/.gemini"
echo "✅ Image-owned Gemini CLI verified"
