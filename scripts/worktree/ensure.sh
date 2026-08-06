#!/usr/bin/env bash
# Ensure this checkout's own development container is running and reconciled.
#
# Ownership is exact and is never inferred from a name: a container belongs to
# this worktree only when the container engine reports it Running AND both
# devcontainer ownership labels (devcontainer.local_folder and
# devcontainer.config_file) name this checkout AND the shared Git common
# directory is bind mounted at the same absolute path it has on the host. Two
# worktrees of one repository therefore never share a container even when both
# are visible to the same engine.
#
# The fast path is one cached-id read plus a single container inspect and takes
# no lock at all. Every caller that misses it converges on ONE reconciliation:
# the lifecycle lock is taken, readiness is re-checked underneath it, and only
# the first caller runs `devcontainer up`.
#
# Host-side only. Container lifecycle from inside a container is never attempted.
#
# Usage:
#   bash scripts/worktree/ensure.sh                          Reconcile, print the container id
#   bash scripts/worktree/ensure.sh --check-ready            Print the id only if already ready
#   bash scripts/worktree/ensure.sh --definition-fingerprint Print the definition fingerprint

set -euo pipefail

WORKTREE_LABEL="Worktree ensure"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"
# shellcheck source=scripts/worktree/lock.sh
. "$WORKTREE_RUNTIME_DIR/lock.sh"

MODE="ensure"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/ensure.sh [--check-ready|--definition-fingerprint]
  (no arguments)            Reconcile this worktree's container and print its id
  --check-ready             Print the id only when the recorded container is ready
  --definition-fingerprint  Print the container definition fingerprint
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--check-ready)
			MODE="check-ready"
			shift
			;;
		--definition-fingerprint)
			MODE="definition-fingerprint"
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
CONTAINER_ENGINE="$(wt_contract_value container_engine)"
CONTAINER_CLI="$(wt_contract_value container_cli)"
DEVCONTAINER_CONFIG="$(wt_contract_value devcontainer_config)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
RUN_DIRECTORY="$(wt_contract_value run_directory)"
PUBLISHED_HOST_PORT_VARIABLE="$(wt_contract_value published_host_port_variable)"

RUN_DIR="$REPO_ROOT/$RUN_DIRECTORY"
CONTAINER_ID_FILE="$RUN_DIR/container.id"
READY_FILE="$RUN_DIR/container.ready"
LIFECYCLE_LOCK="$RUN_DIR/ensure.lock"
CONFIG_PATH="$REPO_ROOT/$DEVCONTAINER_CONFIG"
LOCAL_FOLDER_LABEL="devcontainer.local_folder"
CONFIG_FILE_LABEL="devcontainer.config_file"

LOCK_TIMEOUT="${WORKTREE_ENSURE_LOCK_TIMEOUT_SECONDS:-900}"

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

git_common_directory() {
	git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir
}

# One inspect call answers every ownership question at once: liveness, both
# ownership labels, and the Git metadata mount. Anything unreadable is "not
# ready", which sends the caller to the locked reconciliation path.
inspect_container() {
	"$CONTAINER_ENGINE" container inspect --format \
		'{{.State.Running}}	{{index .Config.Labels "devcontainer.local_folder"}}	{{index .Config.Labels "devcontainer.config_file"}}	{{range .Mounts}}{{.Source}}>{{.Destination}};{{end}}' \
		"$1" 2>/dev/null
}

container_has_mount() {
	local id="$1" path="$2" details
	details="$(inspect_container "$id")" || return 1
	case "$details" in
		*"	"*"$path>$path;"*) return 0 ;;
	esac
	return 1
}

# B11 in full: recorded id and ready record agree, the recorded definition
# fingerprint still describes the tree, the container is Running, both ownership
# labels name this checkout, and the Git common directory is mounted.
check_ready_container() {
	local container_id ready_id ready_fingerprint fingerprint details
	local running local_folder config_file mounts common_dir

	[ -r "$CONTAINER_ID_FILE" ] && [ -r "$READY_FILE" ] || return 1
	container_id="$(cat "$CONTAINER_ID_FILE")"
	read -r ready_id ready_fingerprint <"$READY_FILE" || return 1
	case "$container_id" in
		'' | *[!0-9a-fA-F]*) return 1 ;;
	esac
	[ "$container_id" = "$ready_id" ] || return 1

	fingerprint="$(wt_definition_fingerprint)"
	[ "$ready_fingerprint" = "$fingerprint" ] || return 1

	details="$(inspect_container "$container_id")" || return 1
	IFS='	' read -r running local_folder config_file mounts <<EOF
$details
EOF
	[ "$running" = "true" ] || return 1
	[ "$local_folder" = "$REPO_ROOT" ] || return 1
	[ "$config_file" = "$CONFIG_PATH" ] || return 1
	common_dir="$(git_common_directory)"
	case ";$mounts" in
		*";$common_dir>$common_dir;"*) return 0 ;;
	esac
	return 1
}

# Discovery is filtered by BOTH ownership labels. A container that carries only
# one of them belongs to some other checkout or some other configuration.
find_owned_container() {
	"$CONTAINER_ENGINE" ps --all --no-trunc --quiet \
		--filter "label=${LOCAL_FOLDER_LABEL}=${REPO_ROOT}" \
		--filter "label=${CONFIG_FILE_LABEL}=${CONFIG_PATH}" 2>/dev/null |
		head -n 1
}

recorded_fingerprint() {
	local ready_id ready_fingerprint
	[ -r "$READY_FILE" ] || return 1
	read -r ready_id ready_fingerprint <"$READY_FILE" || return 1
	printf '%s\n' "$ready_fingerprint"
}

# Readers require both files to agree. Each replacement is atomic; a reader in
# the tiny two-rename window sees a mismatch and safely falls back to the locked
# ensure path rather than accepting partial state.
record_ready_state() {
	local container_id="$1" fingerprint="$2"
	wt_atomic_write "$READY_FILE" "$container_id $fingerprint
"
	wt_atomic_write "$CONTAINER_ID_FILE" "$container_id
"
}

# runArgs reads the published host port out of this process's environment, so
# every value the container definition substitutes has to be exported before the
# CLI runs. The generated file is read key by key, never sourced.
export_generated_environment() {
	local file="$REPO_ROOT/$GENERATED_ENVIRONMENT" key value
	if [ ! -r "$file" ]; then
		wt_die "no generated worktree environment at $file; run scripts/worktree/env.sh first"
	fi
	value="$(wt_env_file_value "$file" "$PUBLISHED_HOST_PORT_VARIABLE")"
	value="$(wt_require_port "$value" "published host port")"
	export "$PUBLISHED_HOST_PORT_VARIABLE=$value"
	for key in WORKSPACE_ID PUBLIC_ORIGIN DIRECT_URL FRIENDLY_HOST; do
		value="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_${key}")"
		export "${ENVIRONMENT_PREFIX}_${key}=$value"
	done
	export "${ENVIRONMENT_PREFIX}_HOST_WORKTREE_ROOT=$REPO_ROOT"
}

# The shared Git administrative directory of a linked worktree lives outside the
# bind-mounted checkout, so it is mounted at the SAME absolute path it has on the
# host: that is the only way a Git command inside the container resolves the
# pointer that `.git` records.
start_devcontainer() {
	local common_dir="$1" existing="$2" definition_changed="$3" output status=0
	local -a arguments

	arguments=(
		up
		--workspace-folder "$REPO_ROOT"
		--mount "type=bind,source=${common_dir},target=${common_dir}"
	)
	if [ -n "$existing" ] && [ "$definition_changed" = "true" ]; then
		wt_log "recreating the container because its definition changed"
		arguments+=(--remove-existing-container)
	elif [ -n "$existing" ] && ! container_has_mount "$existing" "$common_dir"; then
		wt_log "recreating the container to add linked-worktree Git metadata"
		arguments+=(--remove-existing-container)
	else
		wt_log "starting the container for $REPO_ROOT"
	fi

	output="$(mktemp)"
	if ! "$CONTAINER_CLI" "${arguments[@]}" >"$output" 2>&1; then
		status=1
		cat "$output" >&2
	fi
	rm -f "$output"
	[ "$status" -eq 0 ] || wt_die "the ${CONTAINER_CLI} CLI failed to start the container"
}

reconcile() {
	local common_dir existing fingerprint previous definition_changed="true" id

	wt_require_container_tooling
	bash "$WORKTREE_RUNTIME_DIR/env.sh"
	export_generated_environment

	mkdir -p "$RUN_DIR"
	portable_lock_acquire "$LIFECYCLE_LOCK" "$LOCK_TIMEOUT" ||
		wt_die "could not acquire the container lifecycle lock at $LIFECYCLE_LOCK"

	# Every caller that missed the optimistic check waits here and re-checks
	# under the lock. The first performs reconciliation; the rest converge on its
	# recorded healthy container without a second `devcontainer up`.
	if check_ready_container; then
		cat "$CONTAINER_ID_FILE"
		portable_lock_release
		return 0
	fi

	common_dir="$(git_common_directory)"
	fingerprint="$(wt_definition_fingerprint)"
	existing="$(find_owned_container)"
	if previous="$(recorded_fingerprint)" && [ "$previous" = "$fingerprint" ]; then
		definition_changed="false"
	fi
	start_devcontainer "$common_dir" "$existing" "$definition_changed"

	id="$(find_owned_container)"
	if [ -z "$id" ]; then
		wt_die "the ${CONTAINER_CLI} CLI reported success but no container carries this checkout's ownership labels"
	fi
	record_ready_state "$id" "$fingerprint"
	portable_lock_release
	printf '%s\n' "$id"
}

main() {
	trap 'portable_lock_release' EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM

	if [ "$MODE" = "definition-fingerprint" ]; then
		wt_definition_fingerprint
		return 0
	fi
	if in_container; then
		wt_die "container lifecycle is a host-side operation; run it on the host"
	fi
	if [ "$MODE" = "check-ready" ]; then
		# Deliberately silent and lock-free: a miss is an answer, not an error.
		command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || return 1
		check_ready_container || return 1
		cat "$CONTAINER_ID_FILE"
		return 0
	fi
	reconcile
}

main
