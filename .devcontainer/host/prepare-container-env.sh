#!/usr/bin/env bash
# Prepare the validated Docker --env-file used by every container process.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${DEVCONTAINER_CONFIG_DIR:-$HOME/.config/devcontainer}"
PROJECT="${DEVCONTAINER_PROJECT:-devenv}"
COMMON_FILE="${DEVCONTAINER_COMMON_SECRETS_FILE:-$CONFIG_DIR/secrets}"
PROJECT_FILE="${DEVCONTAINER_PROJECT_SECRETS_FILE:-$CONFIG_DIR/secrets.d/$PROJECT}"
OUTPUT_FILE="${DEVCONTAINER_ENV_OUTPUT_FILE:-$CONFIG_DIR/container-env/$PROJECT.env}"

# shellcheck source=../lib/env-file.sh
source "$SCRIPT_DIR/../lib/env-file.sh"

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
