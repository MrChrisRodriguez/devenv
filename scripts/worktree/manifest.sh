#!/usr/bin/env bash
# Publish this checkout's route as an atomic host manifest and Caddy snippet.
#
# The manifest is the discoverable, machine-readable record of where this
# worktree answers: <manifest_directory>/<workspace id>.json, written through a
# same-directory temporary file and an atomic replace, so a concurrent reader
# observes either the previous document or the complete new one and never a
# partial write.
#
# The friendly .localhost route is a convenience served by an optional host
# Caddy instance that imports every worktree's generated snippet. It is never
# load bearing: the direct loopback URL is always published and always works, so
# a missing or failing host Caddy warns and the caller keeps going.
#
# Everything that touches the host configuration root is host-side only - a
# container's ~/.config is an isolated writable volume, so a write there would
# succeed and be wrong - and every path this script writes or deletes is checked
# to live under the canonicalized host configuration root first.
#
# Usage:
#   bash scripts/worktree/manifest.sh env       Print shell exports for this route
#   bash scripts/worktree/manifest.sh active    Publish the route and reload Caddy
#   bash scripts/worktree/manifest.sh inactive  Mark stopped and drop the route
#   bash scripts/worktree/manifest.sh remove    Delete the manifest and the route
#   bash scripts/worktree/manifest.sh path      Print this worktree's manifest path

set -euo pipefail

WORKTREE_LABEL="Worktree manifest"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/manifest.sh <env|active|inactive|remove|path>
  env       Print shell exports describing this worktree's published route
  active    Write the manifest as active, publish the route, reload host Caddy
  inactive  Write the manifest as inactive and remove only the route
  remove    Delete the manifest, the route, and the local state
  path      Print the path of this worktree's manifest
USAGE
}

MODE=""
if [ "$#" -eq 0 ]; then
	usage
	exit 2
fi
case "$1" in
	env | active | inactive | remove | path)
		MODE="$1"
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
if [ "$#" -gt 0 ]; then
	usage
	exit 2
fi

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
RUN_DIRECTORY="$(wt_contract_value run_directory)"
MUTABLE_PERSISTENCE="$(wt_contract_value mutable_persistence)"
MANIFEST_SCHEMA_VERSION="$(wt_contract_value manifest_schema_version)"
PUBLISHED_CONTAINER_PORT="$(wt_contract_value published_container_port)"
PUBLISHED_HOST_PORT_VARIABLE="$(wt_contract_value published_host_port_variable)"
DIRECT_HOST="$(wt_contract_value direct_host)"
HOST_CADDY="$(wt_contract_value host_caddy)"
ALWAYS_PUBLISH_DIRECT_URL="$(wt_contract_value always_publish_direct_url)"
HOST_CONFIG_ROOT="$(wt_expand_home "$(wt_contract_value host_config_root)")"
MANIFEST_DIRECTORY="$(wt_expand_home "$(wt_contract_value manifest_directory)")"
CADDY_SNIPPET_DIRECTORY="$(wt_expand_home "$(wt_contract_value caddy_snippet_directory)")"

RUN_DIR="$REPO_ROOT/$RUN_DIRECTORY"
STATE_FILE="$RUN_DIR/manifest.env"

WORKSPACE_ID=""
FAMILY=""
OFFSET="0"
HOST_PORT=""
FRIENDLY_HOST=""
FRIENDLY_URL=""
DIRECT_URL=""
PUBLIC_ORIGIN=""
PERSISTENCE_ROOT=""
MANIFEST_PATH=""
CADDY_SNIPPET_PATH=""

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

# Canonicalize the deepest existing ancestor and re-attach the remainder, so a
# directory that does not exist yet still has the symlinks in its existing part
# resolved. Nothing is created here: a path is proven safe before it is made.
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

# This script creates and deletes files. A contract that names a directory
# outside the host configuration root, or an identity carrying a traversal, must
# stop here rather than reach `rm`.
require_under_host_config_root() {
	local candidate="$1" label="$2" root
	root="$(resolve_path "$HOST_CONFIG_ROOT")"
	case "$candidate" in
		"$root"/*) return 0 ;;
	esac
	wt_die "$label $candidate is outside the host configuration root $root"
}

# Identity is read from the generated environment rather than re-derived: the
# host allocation already decided it, and a second derivation is a second answer.
load_identity() {
	local file="$REPO_ROOT/$GENERATED_ENVIRONMENT"

	if [ ! -r "$file" ]; then
		wt_die "no generated worktree environment at $file; run scripts/worktree/env.sh first"
	fi
	WORKSPACE_ID="$(wt_require_identifier \
		"$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKSPACE_ID")" \
		'^[a-z0-9][a-z0-9-]{0,62}$' 'workspace id')"
	FAMILY="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_FAMILY")"
	OFFSET="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_OFFSET")"
	HOST_PORT="$(wt_require_port \
		"$(wt_env_file_value "$file" "$PUBLISHED_HOST_PORT_VARIABLE")" \
		"published host port")"
	FRIENDLY_HOST="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_FRIENDLY_HOST")"
	FRIENDLY_URL="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_FRIENDLY_URL")"
	DIRECT_URL="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_DIRECT_URL")"
	PUBLIC_ORIGIN="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_PUBLIC_ORIGIN")"
	PERSISTENCE_ROOT="$REPO_ROOT/$MUTABLE_PERSISTENCE"

	MANIFEST_PATH="$(resolve_path "$MANIFEST_DIRECTORY")/$WORKSPACE_ID.json"
	CADDY_SNIPPET_PATH="$(resolve_path "$CADDY_SNIPPET_DIRECTORY")/$WORKSPACE_ID.caddy"
	require_under_host_config_root "$MANIFEST_PATH" "the manifest path"
	require_under_host_config_root "$CADDY_SNIPPET_PATH" "the Caddy snippet path"
}

write_manifest() {
	local status="$1" python
	python="$(wt_python)"
	MANIFEST_PATH="$MANIFEST_PATH" \
		MANIFEST_SCHEMA_VERSION="$MANIFEST_SCHEMA_VERSION" \
		WORKSPACE_ID="$WORKSPACE_ID" \
		REPO_ROOT="$REPO_ROOT" \
		FAMILY="$FAMILY" \
		OFFSET="$OFFSET" \
		CONTAINER_PORT="$PUBLISHED_CONTAINER_PORT" \
		HOST_PORT="$HOST_PORT" \
		DIRECT_URL="$DIRECT_URL" \
		FRIENDLY_URL="$FRIENDLY_URL" \
		FRIENDLY_HOST="$FRIENDLY_HOST" \
		PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
		PERSISTENCE_ROOT="$PERSISTENCE_ROOT" \
		CADDY_SNIPPET_PATH="$CADDY_SNIPPET_PATH" \
		MANIFEST_STATUS="$status" \
		"$python" - <<'PYTHON'
import json
import os
from datetime import datetime, timezone

manifest_path = os.environ["MANIFEST_PATH"]
document = {
    "schemaVersion": int(os.environ["MANIFEST_SCHEMA_VERSION"]),
    "workspaceId": os.environ["WORKSPACE_ID"],
    "repoPath": os.environ["REPO_ROOT"],
    "family": os.environ["FAMILY"],
    "offset": int(os.environ["OFFSET"]),
    "containerPort": int(os.environ["CONTAINER_PORT"]),
    "hostPort": int(os.environ["HOST_PORT"]),
    "directUrl": os.environ["DIRECT_URL"],
    "friendlyUrl": os.environ["FRIENDLY_URL"],
    "friendlyHost": os.environ["FRIENDLY_HOST"],
    "publicOrigin": os.environ["PUBLIC_ORIGIN"],
    "persistenceRoot": os.environ["PERSISTENCE_ROOT"],
    "caddySnippet": os.environ["CADDY_SNIPPET_PATH"],
    "status": os.environ["MANIFEST_STATUS"],
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
# Same directory, then one rename: a reader either sees the previous document or
# this one, and no half-written file is ever visible under the real name.
temporary = "%s.tmp.%d" % (manifest_path, os.getpid())
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(document, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.replace(temporary, manifest_path)
PYTHON
}

write_caddy_snippet() {
	mkdir -p "$(dirname "$CADDY_SNIPPET_PATH")"
	wt_atomic_write "$CADDY_SNIPPET_PATH" "http://$FRIENDLY_HOST {
	reverse_proxy $DIRECT_HOST:$HOST_PORT
}
"
}

remove_caddy_snippet() {
	rm -f "$CADDY_SNIPPET_PATH"
}

host_caddy_binary() {
	local override_name="${ENVIRONMENT_PREFIX}_HOST_CADDY_BIN" override
	override="${!override_name:-}"
	if [ -n "$override" ]; then
		printf '%s\n' "$override"
		return 0
	fi
	command -v caddy 2>/dev/null
}

# A fixed candidate list, and deliberately not bare /etc/Caddyfile: reloading a
# machine-wide configuration this runtime does not own is not a convenience.
host_caddyfile() {
	local override_name="${ENVIRONMENT_PREFIX}_HOST_CADDYFILE" override candidate
	override="${!override_name:-}"
	if [ -n "$override" ]; then
		printf '%s\n' "$override"
		return 0
	fi
	for candidate in \
		"${HOMEBREW_PREFIX:-/opt/homebrew}/etc/Caddyfile" \
		/opt/homebrew/etc/Caddyfile \
		/usr/local/etc/Caddyfile \
		/etc/caddy/Caddyfile; do
		if [ -r "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

# Best effort by contract. The friendly route is an optional nicety layered on
# top of a direct loopback URL that always works, so every failure here is a
# warning and the caller's exit status is unaffected.
reload_host_caddy() {
	local announce="$1" binary config
	if in_container; then
		return 0
	fi
	if [ "$HOST_CADDY" = "disabled" ]; then
		return 0
	fi
	if ! binary="$(host_caddy_binary)" || [ -z "$binary" ]; then
		if [ "$announce" = "announce" ]; then
			wt_warn "no host Caddy is installed; the friendly route $FRIENDLY_URL is unavailable and $DIRECT_URL is authoritative"
		fi
		return 0
	fi
	if ! config="$(host_caddyfile)"; then
		if [ "$announce" = "announce" ]; then
			wt_warn "no host Caddyfile was found; the friendly route $FRIENDLY_URL is unavailable and $DIRECT_URL is authoritative"
		fi
		return 0
	fi
	if ! "$binary" reload --config "$config" --adapter caddyfile >/dev/null 2>&1; then
		wt_warn "the host Caddy reload failed; the friendly route $FRIENDLY_URL may be stale and $DIRECT_URL is authoritative"
		return 0
	fi
	return 0
}

# The local cache lets down and cleanup find the very paths activation used,
# even if the contract or the generated environment changed in between. Every
# value goes through the quoting helper because this file is sourced.
write_state_file() {
	local prefix="$ENVIRONMENT_PREFIX"
	if in_container; then
		return 0
	fi
	wt_atomic_write "$STATE_FILE" "$(
		printf '%s_WORKSPACE_ID=%s\n' "$prefix" "$(wt_quote_if_needed "$WORKSPACE_ID")"
		printf '%s=%s\n' "$PUBLISHED_HOST_PORT_VARIABLE" "$HOST_PORT"
		printf '%s_FRIENDLY_HOST=%s\n' "$prefix" "$(wt_quote_if_needed "$FRIENDLY_HOST")"
		printf '%s_FRIENDLY_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$FRIENDLY_URL")"
		printf '%s_DIRECT_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$DIRECT_URL")"
		printf '%s_PUBLIC_ORIGIN=%s\n' "$prefix" "$(wt_quote_if_needed "$PUBLIC_ORIGIN")"
		printf '%s_MANIFEST_PATH=%s\n' "$prefix" "$(wt_quote_if_needed "$MANIFEST_PATH")"
		printf '%s_CADDY_SNIPPET_PATH=%s\n' "$prefix" \
			"$(wt_quote_if_needed "$CADDY_SNIPPET_PATH")"
	)"
}

report_exports() {
	local prefix="$ENVIRONMENT_PREFIX"
	printf 'export %s_WORKSPACE_ID=%s\n' "$prefix" "$(wt_quote_if_needed "$WORKSPACE_ID")"
	printf 'export %s=%s\n' "$PUBLISHED_HOST_PORT_VARIABLE" "$HOST_PORT"
	printf 'export %s_PUBLISHED_CONTAINER_PORT=%s\n' "$prefix" "$PUBLISHED_CONTAINER_PORT"
	printf 'export %s_FRIENDLY_HOST=%s\n' "$prefix" "$(wt_quote_if_needed "$FRIENDLY_HOST")"
	printf 'export %s_FRIENDLY_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$FRIENDLY_URL")"
	printf 'export %s_DIRECT_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$DIRECT_URL")"
	printf 'export %s_PUBLIC_ORIGIN=%s\n' "$prefix" "$(wt_quote_if_needed "$PUBLIC_ORIGIN")"
	printf 'export %s_PERSISTENCE_ROOT=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$PERSISTENCE_ROOT")"
	printf 'export %s_MANIFEST_PATH=%s\n' "$prefix" "$(wt_quote_if_needed "$MANIFEST_PATH")"
	printf 'export %s_CADDY_SNIPPET_PATH=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$CADDY_SNIPPET_PATH")"
}

announce_routes() {
	if [ "$ALWAYS_PUBLISH_DIRECT_URL" = "true" ]; then
		wt_log "direct URL $DIRECT_URL"
	fi
	if [ "$HOST_CADDY" != "disabled" ]; then
		wt_log "friendly URL $FRIENDLY_URL"
	fi
}

main() {
	load_identity

	case "$MODE" in
		path)
			printf '%s\n' "$MANIFEST_PATH"
			;;
		env)
			write_state_file
			report_exports
			;;
		active)
			if in_container; then
				wt_die "publishing a manifest is a host-side operation; run it on the host"
			fi
			write_manifest active
			write_caddy_snippet
			write_state_file
			reload_host_caddy announce
			announce_routes
			;;
		inactive)
			if in_container; then
				wt_die "publishing a manifest is a host-side operation; run it on the host"
			fi
			# The manifest survives deactivation on purpose: the registry keeps this
			# worktree's ports, so a later `up` restores the same URLs.
			write_manifest inactive
			remove_caddy_snippet
			reload_host_caddy quiet
			wt_log "$WORKSPACE_ID is inactive; its ports stay reserved"
			;;
		remove)
			if in_container; then
				wt_die "removing a manifest is a host-side operation; run it on the host"
			fi
			rm -f "$MANIFEST_PATH"
			remove_caddy_snippet
			rm -f "$STATE_FILE"
			reload_host_caddy quiet
			wt_log "removed the manifest and route for $WORKSPACE_ID"
			;;
	esac
}

main
