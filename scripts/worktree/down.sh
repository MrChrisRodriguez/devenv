#!/usr/bin/env bash
# Stop this checkout's declared services and take its route out of service.
#
# Down is deliberately not cleanup. It stops the services and marks the route
# inactive, and it KEEPS the host registry entry, the generated environment, the
# persistence directory, and the container itself - so bringing the same
# worktree back up hands out the identical ports and URLs. Releasing any of that
# is scripts/worktree/cleanup.sh's job.
#
# Stopping never starts anything: if no reconciled container is already ready the
# in-container shutdown is skipped with a warning rather than reconciled into
# existence just to be told to stop.
#
# Usage:
#   bash scripts/worktree/down.sh

set -euo pipefail

WORKTREE_LABEL="Worktree down"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/down.sh
  Stop this checkout's services and mark its route inactive. The registry entry,
  the generated environment, and the persistence directory all survive.
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		*)
			usage
			exit 2
			;;
	esac
done

CONTAINER_WORKSPACE="$(wt_contract_value container_workspace)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
RUN_DIRECTORY="$(wt_contract_value run_directory)"
SERVICES="$(wt_contract_list services)"

ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_ENVIRONMENT"
SERVICES_DIR="$REPO_ROOT/$RUN_DIRECTORY/services"

# The cloud marker branch is capability-fenced; a fixture rendered without it
# must still leave a valid function behind.
in_container() {
	if [ "${DEVCONTAINER:-}" = "true" ]; then
		return 0
	fi
	# capability:start codex_cloud
	if [ "${CODEX_CLOUD:-}" = "true" ]; then
		return 0
	fi
	# capability:end codex_cloud
	return 1
}

stop_services() {
	local container_id=""
	if [ -z "$SERVICES" ]; then
		wt_log "no services are declared"
		return 0
	fi
	if in_container; then
		bash "$WORKTREE_RUNTIME_DIR/services.sh" stop
		return 0
	fi
	# --check-ready is the read-only question. A missing container means the
	# services are already gone with it.
	if ! container_id="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh" --check-ready 2>/dev/null)" ||
		[ -z "$container_id" ]; then
		wt_warn "no ready container for this checkout; its services are already stopped"
		return 0
	fi
	if ! bash "$WORKTREE_RUNTIME_DIR/exec.sh" \
		bash "$CONTAINER_WORKSPACE/scripts/worktree/services.sh" stop; then
		wt_warn "the in-container service shutdown reported an error"
	fi
}

main() {
	stop_services
	rm -rf "$SERVICES_DIR"

	if in_container; then
		wt_log "services are stopped; the route stays owned by the host"
		return 0
	fi
	if [ -r "$ENVIRONMENT_FILE" ]; then
		bash "$WORKTREE_RUNTIME_DIR/manifest.sh" inactive
	else
		wt_warn "no generated worktree environment; there is no route to deactivate"
	fi
	wt_log "this worktree keeps its registered ports; run cleanup.sh to release them"
}

main
