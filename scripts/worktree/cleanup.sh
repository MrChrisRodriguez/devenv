#!/usr/bin/env bash
# Remove everything this one checkout owns, and nothing else.
#
# Cleanup is exact-target only. It removes containers that carry BOTH of this
# checkout's ownership labels, the named volumes derived from this checkout's own
# ${devcontainerId}, this checkout's manifest, route, registry entry, generated
# state, and persistence directory. It never sweeps: no unscoped prune of
# containers, volumes, images, or Git worktree registrations ever runs here,
# because every one of those would reach into a sibling worktree that is
# perfectly alive.
#
# Generated state is never trusted for a destructive path. The persistence root
# is re-derived whenever the recorded value does not live under this checkout -
# an in-container run rewrites it to the container's own workspace path - and
# every host configuration path is proven to live under the canonicalized host
# configuration root before anything is deleted.
#
# Cleanup asserts its own completeness: after every removal it re-inventories the
# same resources and exits non-zero listing whatever survived, rather than
# reporting success because its removal steps returned zero.
#
# Usage:
#   bash scripts/worktree/cleanup.sh

set -euo pipefail

WORKTREE_LABEL="Worktree cleanup"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/cleanup.sh
  Remove this checkout's container, volumes, route, registry entry, generated
  state, and persistence directory. Other worktrees are never touched.
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

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
CONTAINER_ENGINE="$(wt_contract_value container_engine)"
DEVCONTAINER_CONFIG="$(wt_contract_value devcontainer_config)"
GENERATED_STATE="$(wt_contract_value generated_state)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
MUTABLE_PERSISTENCE="$(wt_contract_value mutable_persistence)"
HOST_CONFIG_ROOT="$(wt_expand_home "$(wt_contract_value host_config_root)")"
MANIFEST_DIRECTORY="$(wt_expand_home "$(wt_contract_value manifest_directory)")"
CADDY_SNIPPET_DIRECTORY="$(wt_expand_home "$(wt_contract_value caddy_snippet_directory)")"
REGISTRY_DIRECTORY="$(wt_expand_home "$(wt_contract_value registry_directory)")"

CONFIG_PATH="$REPO_ROOT/$DEVCONTAINER_CONFIG"
ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_ENVIRONMENT"
GENERATED_STATE_DIR="$REPO_ROOT/$GENERATED_STATE"
REGISTRY_FILE="$REGISTRY_DIRECTORY/ports.json"
LOCAL_FOLDER_LABEL="devcontainer.local_folder"
CONFIG_FILE_LABEL="devcontainer.config_file"

WORKSPACE_ID=""
DEVCONTAINER_IDENTITY=""
MANIFEST_PATH=""
CADDY_SNIPPET_PATH=""
PERSISTENCE_ROOT=""

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

resolve_path() {
	local path="$1" suffix="" parent
	while [ ! -d "$path" ]; do
		suffix="/$(basename "$path")$suffix"
		parent="$(dirname "$path")"
		if [ "$parent" = "$path" ]; then
			printf '%s%s\n' "$path" "$suffix"
			return 0
		fi
		path="$parent"
	done
	printf '%s%s\n' "$(cd "$path" && pwd -P)" "$suffix"
}

require_under_host_config_root() {
	local candidate="$1" label="$2" root
	root="$(resolve_path "$HOST_CONFIG_ROOT")"
	case "$candidate" in
		"$root"/*) return 0 ;;
	esac
	wt_die "$label $candidate is outside the host configuration root $root"
}

# The identity has to be known before anything is deleted, and the generated
# environment is where it lives. A checkout that never generated one gets it
# generated now: deriving it a second time here would be a second answer.
resolve_identity() {
	local recorded=""

	if [ ! -r "$ENVIRONMENT_FILE" ]; then
		wt_log "generating the worktree environment so cleanup knows what it owns"
		bash "$WORKTREE_RUNTIME_DIR/env.sh" >/dev/null
	fi
	WORKSPACE_ID="$(wt_require_identifier \
		"$(wt_env_file_value "$ENVIRONMENT_FILE" "${ENVIRONMENT_PREFIX}_WORKSPACE_ID")" \
		'^[a-z0-9][a-z0-9-]{0,62}$' 'workspace id')"
	MANIFEST_PATH="$(resolve_path "$MANIFEST_DIRECTORY")/$WORKSPACE_ID.json"
	CADDY_SNIPPET_PATH="$(resolve_path "$CADDY_SNIPPET_DIRECTORY")/$WORKSPACE_ID.caddy"
	require_under_host_config_root "$MANIFEST_PATH" "the manifest path"
	require_under_host_config_root "$CADDY_SNIPPET_PATH" "the Caddy snippet path"

	# An in-container run rewrites this to the container's own workspace path, so
	# trusting it here would delete nothing and leave the real directory behind.
	recorded="$(wt_env_file_value "$ENVIRONMENT_FILE" "${ENVIRONMENT_PREFIX}_PERSISTENCE_ROOT" || true)"
	case "$recorded" in
		"$REPO_ROOT"/*) PERSISTENCE_ROOT="$recorded" ;;
		*) PERSISTENCE_ROOT="$REPO_ROOT/$MUTABLE_PERSISTENCE" ;;
	esac
}

# Identity and the volume prefixes both come from lib.sh, which is the single
# authority for them: removal has to know exactly what this checkout owns, and
# diagnosis has to look for exactly the same set. A second derivation here would
# be a second answer, and the two would diverge silently.
scoped_volume_names() {
	local prefix
	[ -n "$DEVCONTAINER_IDENTITY" ] || return 0
	while IFS= read -r prefix; do
		[ -n "$prefix" ] || continue
		printf '%s-%s\n' "$prefix" "$DEVCONTAINER_IDENTITY"
	done <<EOF
$(wt_volume_prefixes "$CONFIG_PATH")
EOF
}

owned_containers() {
	"$CONTAINER_ENGINE" ps --all --no-trunc --quiet \
		--filter "label=${LOCAL_FOLDER_LABEL}=${REPO_ROOT}" \
		--filter "label=${CONFIG_FILE_LABEL}=${CONFIG_PATH}" 2>/dev/null || true
}

existing_volumes() {
	local wanted existing
	existing="$("$CONTAINER_ENGINE" volume ls --quiet 2>/dev/null || true)"
	while IFS= read -r wanted; do
		[ -n "$wanted" ] || continue
		case "
$existing
" in
			*"
$wanted
"*) printf '%s\n' "$wanted" ;;
		esac
	done <<EOF
$(scoped_volume_names)
EOF
}

remove_owned_containers() {
	local id
	while IFS= read -r id; do
		[ -n "$id" ] || continue
		wt_log "removing container $id"
		"$CONTAINER_ENGINE" rm --force "$id" >/dev/null 2>&1 ||
			wt_warn "the engine refused to remove container $id"
	done <<EOF
$(owned_containers)
EOF
}

remove_scoped_volumes() {
	local name
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		wt_log "removing volume $name"
		"$CONTAINER_ENGINE" volume rm --force "$name" >/dev/null 2>&1 ||
			wt_warn "the engine refused to remove volume $name"
	done <<EOF
$(existing_volumes)
EOF
}

legacy_cleanup_commands() {
	local python
	python="$(wt_python)"
	WORKTREE_CONTRACT_FILE="$WORKTREE_CONTRACT" "$python" - <<'PYTHON'
import os
import re

line = ""
with open(os.environ["WORKTREE_CONTRACT_FILE"], "r", encoding="utf-8") as handle:
    for candidate in handle:
        if candidate.startswith("legacy_cleanup_commands"):
            line = candidate
            break
inside = re.search(r"\[(.*)\]", line)
if inside:
    for value in re.findall(r'"((?:[^"\\]|\\.)*)"', inside.group(1)):
        print(value.replace('\\"', '"').replace("\\\\", "\\"))
PYTHON
}

# Projects migrating from an older layout declare what else to remove. A failure
# here warns: a legacy command that no longer applies must not block the removal
# of everything this runtime does own.
run_legacy_cleanup_commands() {
	local command
	while IFS= read -r command; do
		[ -n "$command" ] || continue
		wt_log "running the declared legacy cleanup command: $command"
		(
			cd "$REPO_ROOT" || exit 1
			/bin/sh -c "$command"
		) || wt_warn "the legacy cleanup command failed: $command"
	done <<EOF
$(legacy_cleanup_commands)
EOF
}

registry_holds_entry() {
	local python
	[ -r "$REGISTRY_FILE" ] || return 1
	python="$(wt_python)"
	REGISTRY_FILE="$REGISTRY_FILE" WORKSPACE_ID="$WORKSPACE_ID" "$python" - <<'PYTHON'
import json
import os

try:
    with open(os.environ["REGISTRY_FILE"], "r", encoding="utf-8") as handle:
        entries = json.load(handle).get("entries", {})
except (ValueError, OSError):
    raise SystemExit(1)
raise SystemExit(0 if os.environ["WORKSPACE_ID"] in entries else 1)
PYTHON
}

# Completeness is asserted, not assumed: this re-reads the world after the
# removals instead of trusting that each removal returned zero.
report_remaining() {
	local remaining="" id name

	while IFS= read -r id; do
		[ -n "$id" ] || continue
		remaining="$remaining
  container $id"
	done <<EOF
$(owned_containers)
EOF
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		remaining="$remaining
  volume $name"
	done <<EOF
$(existing_volumes)
EOF
	[ ! -e "$MANIFEST_PATH" ] || remaining="$remaining
  manifest $MANIFEST_PATH"
	[ ! -e "$CADDY_SNIPPET_PATH" ] || remaining="$remaining
  route $CADDY_SNIPPET_PATH"
	[ ! -e "$GENERATED_STATE_DIR" ] || remaining="$remaining
  generated state $GENERATED_STATE_DIR"
	[ ! -e "$PERSISTENCE_ROOT" ] || remaining="$remaining
  persistence $PERSISTENCE_ROOT"
	if registry_holds_entry; then
		remaining="$remaining
  registry entry $WORKSPACE_ID"
	fi

	if [ -n "$remaining" ]; then
		printf '%s: these resources survived cleanup:%s\n' "$WORKTREE_LABEL" "$remaining" >&2
		return 1
	fi
	return 0
}

main() {
	if in_container; then
		wt_die "cleanup owns host resources; run it on the host"
	fi
	wt_require_container_tooling
	resolve_identity
	DEVCONTAINER_IDENTITY="$(wt_devcontainer_identity "$REPO_ROOT" "$CONFIG_PATH")"

	bash "$WORKTREE_RUNTIME_DIR/down.sh" || wt_warn "the shutdown step reported an error"
	bash "$WORKTREE_RUNTIME_DIR/manifest.sh" remove ||
		wt_warn "the manifest removal step reported an error"

	remove_owned_containers
	remove_scoped_volumes
	run_legacy_cleanup_commands

	bash "$WORKTREE_RUNTIME_DIR/env.sh" --release ||
		wt_warn "releasing the registry entry reported an error"

	rm -rf "$GENERATED_STATE_DIR"
	rm -rf "$PERSISTENCE_ROOT"

	if ! report_remaining; then
		wt_die "cleanup is incomplete for $WORKSPACE_ID" 1
	fi
	wt_log "removed every resource owned by $WORKSPACE_ID"
}

main
