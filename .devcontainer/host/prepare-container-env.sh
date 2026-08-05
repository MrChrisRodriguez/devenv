#!/usr/bin/env bash
# Prepare the validated Docker --env-file used by every container process.
#
# Runs on the HOST via the UNCONDITIONAL `prepare-container-env` entry of
# devcontainer.json's `initializeCommand` object, on every `devpod up` including
# rebuilds. It must stay unconditional: `runArgs` names the file it writes with
# `--env-file`, so `docker run` fails at create if nothing generated it. Anything
# the host must guarantee regardless of optional capabilities belongs here — not
# in the capability-gated sibling host/capture-warp-env.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${DEVCONTAINER_CONFIG_DIR:-$HOME/.config/devcontainer}"
PROJECT="${DEVCONTAINER_PROJECT:-devenv}"
COMMON_FILE="${DEVCONTAINER_COMMON_SECRETS_FILE:-$CONFIG_DIR/secrets}"
PROJECT_FILE="${DEVCONTAINER_PROJECT_SECRETS_FILE:-$CONFIG_DIR/secrets.d/$PROJECT}"
OUTPUT_FILE="${DEVCONTAINER_ENV_OUTPUT_FILE:-$CONFIG_DIR/container-env/$PROJECT.env}"

# shellcheck source=../lib/env-file.sh
source "$SCRIPT_DIR/../lib/env-file.sh"

# The host-side config root and every bind-mount source devcontainer.json names
# must exist before `docker run`, whatever the enabled capability set.
mkdir -p "$CONFIG_DIR"

# Ensure the Codex auth snapshot dir exists on the host so the read-write bind
# mount in devcontainer.json has a source owned by the host user. Without it
# Docker auto-creates the source root-owned and the container's vscode (uid 1000)
# cannot write the captured-back token. Non-fatal (`|| true`) under this script's
# `set -e`: a mkdir failure must never block `devcontainer up`. The leaf name is
# the project slug and must match the mount source in devcontainer.json.
mkdir -p "$CONFIG_DIR/codex-auth/$PROJECT" || true

mkdir -p "$(dirname "$OUTPUT_FILE")"
umask 077
temporary="$(mktemp "${OUTPUT_FILE}.tmp.XXXXXX")"
cleanup() {
	rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

write_pair() {
	printf '%s=%s\n' "$1" "$2" >> "$temporary"
}

# Duplicate keys are intentional: Docker applies the last occurrence, matching
# the bootstrap's common-first/project-last export order.
devcontainer_env_for_each "$COMMON_FILE" write_pair "common secrets"
devcontainer_env_for_each "$PROJECT_FILE" write_pair "project secrets ($PROJECT)"
chmod 0600 "$temporary"
mv "$temporary" "$OUTPUT_FILE"
trap - EXIT HUP INT TERM

printf 'Prepared devcontainer environment for %s (%s configured entries).\n' \
	"$PROJECT" "$(wc -l < "$OUTPUT_FILE" | tr -d ' ')"
