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

# Persist the Codex login across the project's worktrees: seed ~/.codex/auth.json
# from the shared host snapshot when this container has none, and capture a newer
# local login back to it. ~/.codex's live SQLite/state (logs_*, state_*, memories_*)
# stays isolated per worktree. The logic lives in codex-auth-snapshot.sh so the
# SessionStart hook (wired in .claude/settings.json) can reuse it — a fresh
# `codex login` then propagates without waiting for a full recreate. See
# AUTH-PERSISTENCE.md. (~/.codex ownership is already claimed for vscode by
# on-create.sh's volume-claim loop before this script runs.)
bash /workspace/.devcontainer/on-create/codex-auth-snapshot.sh \
	|| echo "⚠️  codex auth snapshot step did not complete cleanly"

echo "✅ Image-owned Codex CLI verified"
