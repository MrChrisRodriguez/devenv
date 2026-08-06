#!/usr/bin/env bash
# Run a command in the environment this checkout actually owns.
#
# One entry point, several destinations, decided in a fixed order because the
# order is the safety property:
#
# capability:start codex_cloud
#   - A verified cloud task already runs inside an isolated hosted container, so
#     it executes in place. The read-only doctor stands on its own line first:
#     an unhealthy environment aborts under `set -e` and the requested command
#     never runs. Testing the host branch before this one would try to start
#     Docker inside a hosted container.
# capability:end codex_cloud
#   - Already inside this repository's development container: source the
#     canonical container environment, activate Proto, and execute in place.
#     There is no boundary left to cross, and testing the host branch before
#     this one would recurse forever.
#   - On the host: reconcile this worktree's own container, map the current
#     directory to its container-relative path, and re-invoke this same script
#     inside that container with an explicit, minimal environment.
#
# --require-ready is the mode git hooks use. A hook is not a build trigger: it
# runs only against a container this checkout has ALREADY reconciled, and it
# refuses with exit 7 rather than turning a commit into a container start. The
# flag is host-side by definition, so inside the container and in a verified
# cloud it is accepted and ignored.
#
# Exit status: 2 unsupported argument, 3 identity collision, 4 port exhaustion,
# 6 missing container engine or CLI, 7 --require-ready with no ready container.
#
# Usage:
#   bash scripts/worktree/exec.sh                    Open a login shell
#   bash scripts/worktree/exec.sh <command> [args…]  Run one command
#   bash scripts/worktree/exec.sh --require-ready <command> [args…]
#                                                    Run one command, or exit 7

set -euo pipefail

WORKTREE_LABEL="Worktree bridge"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/exec.sh [--require-ready] [--] [command [arguments...]]
  (no command)     Open a login shell in this checkout's environment
  --require-ready  Use the container this checkout already has, or exit 7
  --               End option parsing; everything after it is the command
USAGE
}

REQUIRE_READY="false"

# The host branch re-invokes this script inside the container as
# `exec.sh -- "$@"`, so a leading `--` is a separator and never a command.
# --require-ready is answered here, ahead of the unsupported-argument arm, so a
# hook can never fall through to the reconciling path that starts a container.
while [ "$#" -gt 0 ]; do
	case "$1" in
		--)
			shift
			break
			;;
		--require-ready)
			REQUIRE_READY="true"
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		-*)
			usage
			exit 2
			;;
		*)
			break
			;;
	esac
done

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
CONTAINER_ENGINE="$(wt_contract_value container_engine)"
CONTAINER_WORKSPACE="$(wt_contract_value container_workspace)"
DEVELOPMENT_USER="$(wt_contract_value development_user)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
GENERATED_CONTAINER_ENVIRONMENT="$(wt_contract_value generated_container_environment)"

# Exact argv, no re-quoting and no extra shell: whatever the caller passed is
# what runs, and its exit status is this script's exit status.
run_here() {
	if [ "$#" -eq 0 ]; then
		exec "${SHELL:-/usr/bin/zsh}" -l
	fi
	exec "$@"
}

# The container's exported environment has exactly one owner. This script never
# reassembles PATH, secrets, or Proto activation itself; it sources the canonical
# file and lets it win.
run_inside() {
	local environment_file="${DEVCONTAINER_ENVIRONMENT_FILE:-$CONTAINER_WORKSPACE/.devcontainer/environment.sh}"

	if [ ! -r "$environment_file" ]; then
		wt_die "the canonical container environment is missing: $environment_file"
	fi
	# shellcheck source=/dev/null
	. "$environment_file"
	devcontainer_environment_activate_proto
	run_here "$@"
}

# capability:start codex_cloud
cloud_library="$REPO_ROOT/.codex/cloud/lib.sh"
if [ -r "$cloud_library" ]; then
	# Cloud setup persists its marker in the hosted home directory, and a
	# non-interactive shell never loads it. Read it here so a cloud task still
	# takes the cloud path instead of trying to start Docker inside its host.
	# shellcheck source=/dev/null
	. "$cloud_library"
	cloud_source_persisted_environment || true
fi
if [ "${CODEX_CLOUD:-}" = "true" ]; then
	cloud_doctor="$(wt_contract_value cloud_doctor_command)"
	(
		cd "$REPO_ROOT" || exit 1
		# Word splitting is the point: the contract records a command line.
		# shellcheck disable=SC2086
		exec $cloud_doctor
	)
	run_here "$@"
fi
# capability:end codex_cloud

if [ "${DEVCONTAINER:-}" = "true" ]; then
	run_inside "$@"
fi

# ---------------------------------------------------------------------------
# Host orchestration. Everything below this line requires a container engine.
# ---------------------------------------------------------------------------

container_id=""
if ! container_id="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh" --check-ready 2>/dev/null)"; then
	container_id=""
fi
if [ -z "$container_id" ]; then
	# Ready-only callers stop here, before any lifecycle work: the refusal is the
	# whole point, and the requested command provably never runs.
	if [ "$REQUIRE_READY" = "true" ]; then
		wt_die "this checkout's container is not ready; run bash scripts/worktree/up.sh" 7
	fi
	container_id="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh")"
fi

# Only a directory genuinely below this checkout maps to a container-relative
# path; anything else lands at the workspace root rather than guessing.
repository_root="$(cd "$REPO_ROOT" && pwd -P)"
host_directory="$(pwd -P)"
case "$host_directory/" in
	"$repository_root/") container_directory="$CONTAINER_WORKSPACE" ;;
	"$repository_root/"*)
		container_directory="$CONTAINER_WORKSPACE/${host_directory#"$repository_root/"}"
		;;
	*) container_directory="$CONTAINER_WORKSPACE" ;;
esac

environment_file="$REPO_ROOT/$GENERATED_ENVIRONMENT"
bridged_value() {
	if [ -r "$environment_file" ]; then
		wt_env_file_value "$environment_file" "$1" || true
	fi
}

# An explicit allow-list, not the host's whole environment: the container owns
# its own configuration and must not inherit host PATH, secrets, or tooling.
exec_arguments=(
	exec
	-i
	--user "$DEVELOPMENT_USER"
	--workdir "$container_directory"
	--env "HOME=/home/$DEVELOPMENT_USER"
	--env "DEVCONTAINER_WORKTREE_ENV_FILE=$CONTAINER_WORKSPACE/$GENERATED_CONTAINER_ENVIRONMENT"
	--env "${ENVIRONMENT_PREFIX}_WORKSPACE_ID=$(bridged_value "${ENVIRONMENT_PREFIX}_WORKSPACE_ID")"
	--env "${ENVIRONMENT_PREFIX}_PUBLIC_ORIGIN=$(bridged_value "${ENVIRONMENT_PREFIX}_PUBLIC_ORIGIN")"
	--env "${ENVIRONMENT_PREFIX}_DIRECT_URL=$(bridged_value "${ENVIRONMENT_PREFIX}_DIRECT_URL")"
	--env "${ENVIRONMENT_PREFIX}_HOST_WORKTREE_ROOT=$repository_root"
)
if [ -t 0 ] && [ -t 1 ]; then
	exec_arguments+=(--tty)
fi

exec "$CONTAINER_ENGINE" "${exec_arguments[@]}" "$container_id" \
	/usr/bin/bash "$CONTAINER_WORKSPACE/scripts/worktree/exec.sh" -- "$@"
