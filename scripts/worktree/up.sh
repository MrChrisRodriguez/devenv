#!/usr/bin/env bash
# Bring this checkout's isolated development environment up.
#
# Every step is owned by exactly one script and they run in the only order that
# is correct: env.sh decides identity and ports, ensure.sh reconciles the
# container, manifest.sh publishes the route, and services.sh starts the declared
# services in dependency order. Service startup crosses into the container
# through the bridge, so the services inherit the canonical container environment
# instead of whatever the host shell happened to carry.
#
# A project that declares no services stops after the route: that is a supported
# steady state, not a degraded one, and it is reported rather than hidden.
#
# Usage:
#   bash scripts/worktree/up.sh                  Bring the container, route, and services up
#   bash scripts/worktree/up.sh --skip-services  Container and route only

set -euo pipefail

WORKTREE_LABEL="Worktree up"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

SKIP_SERVICES=""

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/up.sh [--skip-services]
  (no arguments)   Reconcile the container, publish the route, start the services
  --skip-services  Reconcile the container and publish the route only
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--skip-services)
			SKIP_SERVICES="1"
			shift
			;;
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

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
CONTAINER_WORKSPACE="$(wt_contract_value container_workspace)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
SERVICES="$(wt_contract_list services)"

ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_ENVIRONMENT"

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

generated_value() {
	if [ -r "$ENVIRONMENT_FILE" ]; then
		wt_env_file_value "$ENVIRONMENT_FILE" "$1" || true
	fi
}

report_routes() {
	local workspace direct friendly
	workspace="$(generated_value "${ENVIRONMENT_PREFIX}_WORKSPACE_ID")"
	direct="$(generated_value "${ENVIRONMENT_PREFIX}_DIRECT_URL")"
	friendly="$(generated_value "${ENVIRONMENT_PREFIX}_FRIENDLY_URL")"
	wt_log "$workspace is up"
	wt_log "direct URL $direct"
	wt_log "friendly URL $friendly"
}

start_services() {
	if [ -n "$SKIP_SERVICES" ]; then
		wt_log "skipping services on request"
		return 0
	fi
	# Asking the contract first keeps a service-free project from paying for a
	# pointless crossing into the container.
	if [ -z "$SERVICES" ]; then
		wt_log "no services are declared"
		return 0
	fi
	if in_container; then
		bash "$WORKTREE_RUNTIME_DIR/services.sh" start
		return 0
	fi
	bash "$WORKTREE_RUNTIME_DIR/exec.sh" \
		bash "$CONTAINER_WORKSPACE/scripts/worktree/services.sh" start
}

main() {
	local container_id="" status=0

	if in_container; then
		# Inside the container there is no container to reconcile and no host
		# configuration to publish to: adopt the host-generated environment and
		# start the services in place.
		bash "$WORKTREE_RUNTIME_DIR/env.sh"
		start_services
		return 0
	fi

	bash "$WORKTREE_RUNTIME_DIR/env.sh"
	# The reconcile is captured into a variable rather than interpolated into the
	# log line. A command substitution that sits inside another command's
	# arguments discards its own exit status, so `wt_log "container $(ensure.sh)"`
	# would print an empty id after a failed build and this script would go on to
	# publish an active route for a container that does not exist. The assignment
	# is what makes the failure fatal; an empty id is treated as one too, because
	# the caller's next step is to run commands in whatever this named.
	container_id="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh")" || status=$?
	[ "$status" -ne 0 ] || [ -n "$container_id" ] || status=1
	if [ "$status" -ne 0 ]; then
		wt_die "the container could not be reconciled; no route was published" \
			"$status"
	fi
	wt_log "container $container_id"
	bash "$WORKTREE_RUNTIME_DIR/manifest.sh" active
	start_services
	report_routes
}

main
