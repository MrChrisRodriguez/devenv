#!/usr/bin/env bash
set -e

echo "🕸️  Setting up Graphify (knowledge graph for AI assistants)..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup the image tool environment before executing the baked CLI.
setup_proto_env

graphify_binary="$HOME/.local/bin/graphify"
graphify_payload="$HOME/.payloads/graphify/"

if [ ! -x "$graphify_binary" ]; then
	echo "ERROR: Graphify is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
	return 1
fi
case "$(readlink -f "$graphify_binary")" in
	"$graphify_payload"*) ;;
	*)
		echo "ERROR: Graphify does not resolve inside $graphify_payload; rebuild/recreate the devcontainer" >&2
		return 1
		;;
esac
if ! "$graphify_binary" --version >/dev/null 2>&1; then
	echo "ERROR: the image-owned Graphify payload is not executable; rebuild/recreate the devcontainer" >&2
	return 1
fi

# Project-scoped skills, hooks, and settings are committed; runtime setup never
# invokes `graphify install --project` or mutates the baked Python environment.
echo "✅ Image-owned Graphify payload verified"
