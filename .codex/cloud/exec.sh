#!/usr/bin/env bash
# Codex Cloud direct-execution boundary.
#
# A cloud task already runs inside an isolated hosted Linux container, so a
# verified cloud environment runs the requested command in place - but only
# after the read-only doctor has passed. Ordering is the whole point: the
# doctor stands on its own line so an unhealthy environment aborts under
# "set -e" and the requested command never executes. Anything that is not a
# verified cloud environment refuses with exit 3 and points at the host
# entrypoint instead of starting host orchestration from here.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$CLOUD_DIR/lib.sh"

if [ "$#" -eq 0 ]; then
	echo "Usage: bash .codex/cloud/exec.sh <command> [arguments...]" >&2
	exit 2
fi

cloud_source_persisted_environment
if cloud_is_verified; then
	bash "$CLOUD_DIR/doctor.sh" --quiet
	exec "$@"
fi

echo "Codex cloud exec: not a verified Codex Cloud environment; use the host entrypoint" >&2
exit 3
