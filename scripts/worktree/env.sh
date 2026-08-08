#!/usr/bin/env bash
# Generate the local, per-worktree development environment.
#
# Generated files (paths come from the contract, never from a literal here):
#   <generated_state>/worktree.env            host view: host ports and URLs
#   <generated_state>/worktree.container.env  container view: unoffset ports
#
# Port offsets are allocated from a host-global, lock-guarded registry. The
# allocation validates a candidate offset's FULL DERIVED PORT SET for
# disjointness against every registered environment and against the implicit
# offset-0 set of the main checkout. Offset uniqueness alone is insufficient:
# declared base ports are usually contiguous, so two different offsets can still
# collide on a real port. Offset 0 belongs to the main checkout and is never
# registered.
#
# Allocation runs HOST-SIDE ONLY. Inside a container the container's ~/.config
# is a writable isolated volume, so a registry write there would silently
# diverge from host truth. That is environment detection, not failed-write
# detection: the write would succeed and be wrong. In-container runs read the
# host-generated file and never allocate.
#
# Usage:
#   bash scripts/worktree/env.sh [--force]   Generate (allocate an offset if needed)
#   bash scripts/worktree/env.sh --json      Report the generated environment
#   bash scripts/worktree/env.sh --release   Release this worktree's registry entry

set -euo pipefail

WORKTREE_LABEL="Worktree environment"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"
# shellcheck source=scripts/worktree/lock.sh
. "$WORKTREE_RUNTIME_DIR/lock.sh"

MODE="generate"
FORCE=""

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/env.sh [--force|--json|--release]
  (no arguments)  Generate the worktree environment, allocating an offset if needed
  --force         Reallocate the offset even when one is already recorded
  --json          Report the generated environment without mutating anything
  --release       Release this worktree's host registry entry (cleanup only)
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--force)
			FORCE="1"
			shift
			;;
		--json)
			MODE="json"
			shift
			;;
		--release)
			MODE="release"
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
DOCKER_RESOURCE_PREFIX="$(wt_contract_value docker_resource_prefix)"
LOCAL_DOMAIN_STEM="$(wt_contract_value local_domain_stem)"
CONTAINER_WORKSPACE="$(wt_contract_value container_workspace)"
GENERATED_STATE="$(wt_contract_value generated_state)"
MUTABLE_PERSISTENCE="$(wt_contract_value mutable_persistence)"
SHARED_CACHE="$(wt_contract_value shared_cache)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
GENERATED_CONTAINER_ENVIRONMENT="$(wt_contract_value generated_container_environment)"
PUBLISHED_CONTAINER_PORT="$(wt_contract_value published_container_port)"
PUBLISHED_HOST_PORT_VARIABLE="$(wt_contract_value published_host_port_variable)"
PREFERRED_OFFSET_MODULUS="$(wt_contract_value preferred_offset_modulus)"
COLLISION_SCAN_LIMIT="$(wt_contract_value collision_scan_limit)"
REGISTRY_SCHEMA_VERSION="$(wt_contract_value registry_schema_version)"
FRIENDLY_DOMAIN_PATTERN="$(wt_contract_value friendly_domain_pattern)"
DIRECT_HOST="$(wt_contract_value direct_host)"
HOST_CADDY="$(wt_contract_value host_caddy)"
REGISTRY_DIRECTORY="$(wt_expand_home "$(wt_contract_value registry_directory)")"
SERVICES="$(wt_contract_list services)"

REGISTRY_FILE="$REGISTRY_DIRECTORY/ports.json"
REGISTRY_LOCK="$REGISTRY_DIRECTORY/ports.lock"
ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_ENVIRONMENT"
CONTAINER_ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_CONTAINER_ENVIRONMENT"
ENVIRONMENT_LOCK="$REPO_ROOT/$GENERATED_STATE/env.lock"

GIT_LAYOUT=""
GIT_COMMON_DIR=""
WORKTREE_FAMILY=""
WORKSPACE_ID=""
PREFERRED_OFFSET="0"
OFFSET="0"
OFFSET_SOURCE="main"
PUBLISHED_HOST_PORT=""

# A container's ~/.config is an isolated writable volume, so this is detected
# from the environment rather than inferred from a failed write. Each marker sits
# in its own branch: the cloud marker is capability-fenced, and a fixture that
# renders without it must still leave a valid function behind.
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

detect_git_layout() {
	local git_dir
	if ! git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null)"; then
		wt_die "$REPO_ROOT is not a Git checkout"
	fi
	GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)"
	if [ "$git_dir" = "$GIT_COMMON_DIR" ]; then
		GIT_LAYOUT="main"
	else
		GIT_LAYOUT="worktree"
	fi
}

# One convention, no $HOME special cases: the main checkout is the `main` family,
# and a linked worktree is named for its parent directory and its own directory.
# A parent literally called `worktrees` is a container, not an identity, so it
# folds to its grandparent (~/.claude/worktrees/topic -> claude-topic).
derive_family() {
	local repo_name parent_name

	if [ "$GIT_LAYOUT" = "main" ]; then
		printf 'main\n'
		return 0
	fi
	repo_name="$(basename "$REPO_ROOT")"
	parent_name="$(basename "$(dirname "$REPO_ROOT")")"
	if [ "$parent_name" = "worktrees" ]; then
		parent_name="$(basename "$(dirname "$(dirname "$REPO_ROOT")")")"
		parent_name="${parent_name#.}"
	fi
	case "$parent_name" in
		'' | '.' | '/' | "$repo_name") printf '%s\n' "$repo_name" ;;
		*) printf '%s-%s\n' "$parent_name" "$repo_name" ;;
	esac
}

compute_preferred_offset() {
	local family="$1" checksum
	if [ "$GIT_LAYOUT" = "main" ]; then
		printf '0\n'
		return 0
	fi
	checksum="$(printf '%s' "$family" | cksum | awk '{ print $1 }')"
	printf '%s\n' "$(((checksum % PREFERRED_OFFSET_MODULUS) + 1))"
}

# The offset-0 set: the published container port plus every declared service
# base port. Every candidate offset shifts this whole set, and the registry
# arbitrates on set disjointness rather than offset equality.
base_port_set() {
	local service base
	printf '%s' "$PUBLISHED_CONTAINER_PORT"
	for service in $SERVICES; do
		base="$(wt_service_value "$service" base_port)"
		printf ' %s' "$base"
	done
	printf '\n'
}

derived_port_set() {
	local offset="$1" base first=1
	for base in $(base_port_set); do
		if [ "$first" = "1" ]; then
			first=0
		else
			printf ' '
		fi
		printf '%s' "$((base + offset))"
	done
	printf '\n'
}

service_variable_name() {
	printf '%s' "$1" | tr 'a-z-' 'A-Z_'
}

friendly_host() {
	local value="$FRIENDLY_DOMAIN_PATTERN"
	value="${value//\{workspace\}/$WORKTREE_FAMILY}"
	value="${value//\{project\}/$LOCAL_DOMAIN_STEM}"
	printf '%s\n' "$value"
}

registry_python() {
	local python
	python="$(wt_python)"
	REGISTRY_FILE="$REGISTRY_FILE" \
		WORKSPACE_ID="$WORKSPACE_ID" \
		REPO_ROOT="$REPO_ROOT" \
		GIT_COMMON_DIR="$GIT_COMMON_DIR" \
		WORKTREE_FAMILY="$WORKTREE_FAMILY" \
		BASE_PORTS="$(base_port_set)" \
		PREFERRED_OFFSET="$PREFERRED_OFFSET" \
		OFFSET_MODULUS="$PREFERRED_OFFSET_MODULUS" \
		COLLISION_SCAN_LIMIT="$COLLISION_SCAN_LIMIT" \
		RECORDED_OFFSET="${1:-}" \
		REGISTRY_ACTION="$2" \
		REGISTRY_FORCE="$FORCE" \
		REGISTRY_SCHEMA_VERSION="$REGISTRY_SCHEMA_VERSION" \
		"$python" - <<'PYTHON'
import json
import os
import socket
import sys
from datetime import datetime, timezone

registry_file = os.environ["REGISTRY_FILE"]
workspace_id = os.environ["WORKSPACE_ID"]
repo_root = os.environ["REPO_ROOT"]
action = os.environ["REGISTRY_ACTION"]
schema_version = int(os.environ["REGISTRY_SCHEMA_VERSION"])
base_ports = [int(value) for value in os.environ["BASE_PORTS"].split()]
modulus = int(os.environ["OFFSET_MODULUS"])
scan_limit = int(os.environ["COLLISION_SCAN_LIMIT"])
preferred = int(os.environ["PREFERRED_OFFSET"])
force = os.environ.get("REGISTRY_FORCE", "") == "1"
recorded = os.environ.get("RECORDED_OFFSET", "").strip()


def fail(message, status):
    sys.stderr.write("Worktree environment: %s\n" % message)
    raise SystemExit(status)


def load():
    if not os.path.exists(registry_file):
        return {"schemaVersion": schema_version, "entries": {}}
    try:
        with open(registry_file, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (ValueError, OSError) as error:
        fail(
            "the port registry at %s is unreadable (%s); move it aside and retry"
            % (registry_file, error),
            5,
        )
    if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
        fail(
            "the port registry at %s has no entries object; move it aside and retry"
            % registry_file,
            5,
        )
    data.setdefault("schemaVersion", schema_version)
    return data


def save(data):
    os.makedirs(os.path.dirname(registry_file), exist_ok=True)
    temporary = "%s.tmp.%d" % (registry_file, os.getpid())
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, registry_file)


def comparable(entry):
    return dict((key, value) for key, value in entry.items() if key != "updatedAt")


def ports_for(offset):
    return [port + offset for port in base_ports]


def bindable(ports):
    for port in ports:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
        finally:
            probe.close()
    return True


registry = load()
entries = registry["entries"]

if action == "release":
    if entries.pop(workspace_id, None) is not None:
        save(registry)
    raise SystemExit(0)

own = entries.get(workspace_id)
# Two different worktrees whose names sanitize to one workspace id would share a
# registry entry, a container label, and a route. A stale recorded path (the
# worktree was deleted) is reclaimed silently; a live one is a hard failure.
if own is not None and own.get("path") != repo_root and os.path.isdir(str(own.get("path", ""))):
    fail(
        "workspace id '%s' is already registered to %s; rename this worktree directory"
        % (workspace_id, own.get("path")),
        3,
    )

# Offset 0 is the main checkout: it never registers, but its ports are occupied.
occupied = set(base_ports)
for key, entry in entries.items():
    if key == workspace_id:
        continue
    for port in entry.get("ports", []):
        try:
            occupied.add(int(port))
        except (TypeError, ValueError):
            continue


def usable(offset):
    if offset < 1 or offset > modulus:
        return False
    candidate = ports_for(offset)
    if max(candidate) > 65535:
        return False
    return occupied.isdisjoint(candidate)


offset = None
# An already-recorded offset wins over a fresh probe so regeneration is
# byte-identical, and the generated file's own value is preferred over the
# registry's so a hand-repaired checkout converges rather than oscillates.
if not force:
    for value in (recorded, own.get("offset") if own else None):
        if value in (None, ""):
            continue
        try:
            candidate = int(value)
        except (TypeError, ValueError):
            continue
        if usable(candidate):
            offset = candidate
            break

if offset is None:
    fallback = None
    for step in range(min(scan_limit, modulus)):
        candidate = ((preferred - 1 + step) % modulus) + 1
        if not usable(candidate):
            continue
        if fallback is None:
            fallback = candidate
        # First pass also insists the ports are free on the host right now, to
        # dodge an unrelated squatter. This is best effort and racy by nature, so
        # a squatted-but-registry-free candidate is still accepted below.
        if bindable(ports_for(candidate)):
            offset = candidate
            break
    if offset is None and fallback is not None:
        sys.stderr.write(
            "Worktree environment: warning: every free offset has a squatted port; "
            "using offset %d anyway\n" % fallback
        )
        offset = fallback
    if offset is None:
        sys.stderr.write(
            "Worktree environment: no free port offset in 1-%d. Registered environments:\n"
            % modulus
        )
        for key in sorted(entries):
            entry = entries[key]
            sys.stderr.write(
                "  %s offset=%s path=%s\n"
                % (key, entry.get("offset"), entry.get("path"))
            )
        raise SystemExit(4)

# The recorded source describes the outcome, not the lookup path that found it:
# either this environment holds its hash-preferred slot or it was bumped off it.
# That keeps regeneration byte-identical instead of flipping a label on every run.
source = "preferred" if offset == preferred else "alternate"
ports = ports_for(offset)
now = datetime.now(timezone.utc).isoformat()
updated = {
    "path": repo_root,
    "gitCommonDir": os.environ.get("GIT_COMMON_DIR", ""),
    "family": os.environ.get("WORKTREE_FAMILY", ""),
    "host": os.uname().nodename,
    "offset": offset,
    "publishedHostPort": ports[0],
    "ports": ports,
    "allocatedAt": (own or {}).get("allocatedAt", now),
    "updatedAt": now,
}
# A regeneration that changes nothing must not rewrite the registry: an
# unnecessary write is one more chance to lose it.
if own is None or comparable(own) != comparable(updated):
    entries[workspace_id] = updated
    registry["schemaVersion"] = schema_version
    save(registry)

sys.stdout.write("offset=%d\n" % offset)
sys.stdout.write("offset_source=%s\n" % source)
sys.stdout.write("published_host_port=%d\n" % ports[0])
PYTHON
}

allocate_offset() {
	local recorded="" output status=0

	if in_container; then
		wt_die "port allocation is a host-side operation; the container reads the generated environment instead"
	fi
	if [ -r "$ENVIRONMENT_FILE" ]; then
		recorded="$(wt_env_file_value "$ENVIRONMENT_FILE" "${ENVIRONMENT_PREFIX}_WORKTREE_OFFSET" || true)"
	fi
	mkdir -p "$REGISTRY_DIRECTORY"
	portable_lock_acquire "$REGISTRY_LOCK" 30 || wt_die "could not acquire the host port registry lock"
	output="$(registry_python "$recorded" allocate)" || status=$?
	portable_lock_release
	[ "$status" -eq 0 ] || exit "$status"

	OFFSET="$(printf '%s\n' "$output" | sed -nE 's/^offset=([0-9]+)$/\1/p')"
	OFFSET_SOURCE="$(printf '%s\n' "$output" | sed -nE 's/^offset_source=(.+)$/\1/p')"
	PUBLISHED_HOST_PORT="$(printf '%s\n' "$output" | sed -nE 's/^published_host_port=([0-9]+)$/\1/p')"
	PUBLISHED_HOST_PORT="$(wt_require_port "$PUBLISHED_HOST_PORT" "published host port")"
}

release_offset() {
	local status=0
	if in_container; then
		wt_warn "releasing a registry entry is a host-side operation; nothing to do here"
		return 0
	fi
	if [ "$GIT_LAYOUT" = "main" ]; then
		wt_warn "the main checkout owns offset 0 and is never registered; nothing to release"
		return 0
	fi
	mkdir -p "$REGISTRY_DIRECTORY"
	portable_lock_acquire "$REGISTRY_LOCK" 30 || wt_die "could not acquire the host port registry lock"
	registry_python "" release || status=$?
	portable_lock_release
	[ "$status" -eq 0 ] || exit "$status"
	wt_log "released the registry entry for $WORKSPACE_ID"
}

emit_common_identity() {
	local prefix="$ENVIRONMENT_PREFIX"
	printf '%s_WORKTREE_ENV=1\n' "$prefix"
	printf '%s_WORKTREE_LAYOUT=%s\n' "$prefix" "$GIT_LAYOUT"
	printf '%s_WORKTREE_FAMILY=%s\n' "$prefix" "$(wt_quote_if_needed "$WORKTREE_FAMILY")"
	printf '%s_WORKSPACE_ID=%s\n' "$prefix" "$WORKSPACE_ID"
	printf '%s_WORKTREE_PREFERRED_OFFSET=%s\n' "$prefix" "$PREFERRED_OFFSET"
	printf '%s_WORKTREE_OFFSET=%s\n' "$prefix" "$OFFSET"
	printf '%s_WORKTREE_OFFSET_SOURCE=%s\n' "$prefix" "$OFFSET_SOURCE"
}

emit_common_routing() {
	local prefix="$ENVIRONMENT_PREFIX" host direct friendly origin
	host="$(friendly_host)"
	direct="http://$DIRECT_HOST:$PUBLISHED_HOST_PORT"
	friendly="http://$host"
	if [ "$HOST_CADDY" = "disabled" ]; then
		origin="$direct"
	else
		origin="$friendly"
	fi
	printf '%s=%s\n' "$PUBLISHED_HOST_PORT_VARIABLE" "$PUBLISHED_HOST_PORT"
	printf '%s_PUBLISHED_CONTAINER_PORT=%s\n' "$prefix" "$PUBLISHED_CONTAINER_PORT"
	printf '%s_FRIENDLY_HOST=%s\n' "$prefix" "$(wt_quote_if_needed "$host")"
	printf '%s_FRIENDLY_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$friendly")"
	printf '%s_DIRECT_URL=%s\n' "$prefix" "$(wt_quote_if_needed "$direct")"
	printf '%s_PUBLIC_ORIGIN=%s\n' "$prefix" "$(wt_quote_if_needed "$origin")"
	printf '%s_HOST_WORKTREE_ROOT=%s\n' "$prefix" "$(wt_quote_if_needed "$REPO_ROOT")"
}

host_environment_body() {
	local prefix="$ENVIRONMENT_PREFIX" service name port
	cat <<'HEADER'
# Generated by scripts/worktree/env.sh - DO NOT EDIT manually.
# Regenerate with: bash scripts/worktree/env.sh --force
HEADER
	printf '\n'
	emit_common_identity
	printf '\n'
	emit_common_routing
	printf '%s_PERSISTENCE_ROOT=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$REPO_ROOT/$MUTABLE_PERSISTENCE")"
	printf '%s_SHARED_CACHE_ROOT=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$REPO_ROOT/$SHARED_CACHE")"
	# Host view: every declared service port carries the worktree offset, because
	# on the host these are real, contended, per-worktree ports.
	for service in $SERVICES; do
		name="$(service_variable_name "$service")"
		port="$(($(wt_service_value "$service" base_port) + OFFSET))"
		printf '%s_%s_PORT=%s\n' "$prefix" "$name" "$port"
		printf '%s_%s_URL=http://%s:%s\n' "$prefix" "$name" "$DIRECT_HOST" "$port"
	done
}

container_environment_body() {
	local prefix="$ENVIRONMENT_PREFIX" service name port
	cat <<'HEADER'
# Generated by scripts/worktree/env.sh - DO NOT EDIT manually.
# Read inside the container through devcontainer.json's
# DEVCONTAINER_WORKTREE_ENV_FILE seam. Regenerate on the host.
HEADER
	printf '\n'
	emit_common_identity
	printf '\n'
	emit_common_routing
	printf '%s_PERSISTENCE_ROOT=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$CONTAINER_WORKSPACE/$MUTABLE_PERSISTENCE")"
	printf '%s_SHARED_CACHE_ROOT=%s\n' "$prefix" \
		"$(wt_quote_if_needed "$CONTAINER_WORKSPACE/$SHARED_CACHE")"
	# Container view: ports are NOT offset. Each container owns its own network
	# namespace, so the offset only ever disambiguates host ports.
	for service in $SERVICES; do
		name="$(service_variable_name "$service")"
		port="$(wt_service_value "$service" base_port)"
		printf '%s_%s_PORT=%s\n' "$prefix" "$name" "$port"
		printf '%s_%s_URL=http://localhost:%s\n' "$prefix" "$name" "$port"
	done
}

write_environment_files() {
	local host_body container_body
	host_body="$(host_environment_body)"
	container_body="$(container_environment_body)"
	mkdir -p "$REPO_ROOT/$GENERATED_STATE"
	portable_lock_acquire "$ENVIRONMENT_LOCK" 60 ||
		wt_die "could not acquire the generated environment lock"
	wt_atomic_write "$ENVIRONMENT_FILE" "$host_body
"
	wt_atomic_write "$CONTAINER_ENVIRONMENT_FILE" "$container_body
"
	portable_lock_release
}

report_json() {
	local python
	python="$(wt_python)"
	# Every prefix assignment forwards the current shell's variable of the same
	# name, so the expansions inside later values (DIRECT_URL) read exactly the
	# value the forked interpreter receives.
	# shellcheck disable=SC2097,SC2098
	ENVIRONMENT_PREFIX="$ENVIRONMENT_PREFIX" \
		WORKSPACE_ID="$WORKSPACE_ID" \
		WORKTREE_FAMILY="$WORKTREE_FAMILY" \
		GIT_LAYOUT="$GIT_LAYOUT" \
		OFFSET="$OFFSET" \
		OFFSET_SOURCE="$OFFSET_SOURCE" \
		PREFERRED_OFFSET="$PREFERRED_OFFSET" \
		PUBLISHED_HOST_PORT="$PUBLISHED_HOST_PORT" \
		PUBLISHED_CONTAINER_PORT="$PUBLISHED_CONTAINER_PORT" \
		FRIENDLY_HOST="$(friendly_host)" \
		DERIVED_PORTS="$(derived_port_set "$OFFSET")" \
		DIRECT_URL="http://$DIRECT_HOST:$PUBLISHED_HOST_PORT" \
		REPO_ROOT="$REPO_ROOT" \
		ENVIRONMENT_FILE="$ENVIRONMENT_FILE" \
		CONTAINER_ENVIRONMENT_FILE="$CONTAINER_ENVIRONMENT_FILE" \
		"$python" - <<'PYTHON'
import json
import os

print(
    json.dumps(
        {
            "schemaVersion": 1,
            "environmentPrefix": os.environ["ENVIRONMENT_PREFIX"],
            "workspaceId": os.environ["WORKSPACE_ID"],
            "family": os.environ["WORKTREE_FAMILY"],
            "layout": os.environ["GIT_LAYOUT"],
            "preferredOffset": int(os.environ["PREFERRED_OFFSET"]),
            "offset": int(os.environ["OFFSET"]),
            "offsetSource": os.environ["OFFSET_SOURCE"],
            "publishedHostPort": int(os.environ["PUBLISHED_HOST_PORT"]),
            "publishedContainerPort": int(os.environ["PUBLISHED_CONTAINER_PORT"]),
            "portSet": [int(value) for value in os.environ["DERIVED_PORTS"].split()],
            "friendlyHost": os.environ["FRIENDLY_HOST"],
            "directUrl": os.environ["DIRECT_URL"],
            "repoPath": os.environ["REPO_ROOT"],
            "environmentFile": os.environ["ENVIRONMENT_FILE"],
            "containerEnvironmentFile": os.environ["CONTAINER_ENVIRONMENT_FILE"],
        },
        indent=2,
        sort_keys=True,
    )
)
PYTHON
}

# Inside a container the generated files are host truth: read the recorded
# identity back rather than deriving (and certainly rather than allocating) it.
adopt_recorded_environment() {
	local file="$CONTAINER_ENVIRONMENT_FILE"
	[ -r "$file" ] || file="$ENVIRONMENT_FILE"
	if [ ! -r "$file" ]; then
		wt_die "no generated worktree environment is present; generate it on the host first"
	fi
	WORKSPACE_ID="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKSPACE_ID")"
	WORKTREE_FAMILY="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_FAMILY")"
	GIT_LAYOUT="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_LAYOUT")"
	OFFSET="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_OFFSET")"
	OFFSET_SOURCE="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_OFFSET_SOURCE")"
	PREFERRED_OFFSET="$(wt_env_file_value "$file" "${ENVIRONMENT_PREFIX}_WORKTREE_PREFERRED_OFFSET")"
	PUBLISHED_HOST_PORT="$(wt_env_file_value "$file" "$PUBLISHED_HOST_PORT_VARIABLE")"
}

main() {
	trap 'portable_lock_release' EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM

	if in_container; then
		if [ -n "$FORCE" ]; then
			wt_die "--force is a host-side operation; run it on the host"
		fi
		if [ "$MODE" = "release" ]; then
			release_offset
			return 0
		fi
		adopt_recorded_environment
		if [ "$MODE" = "json" ]; then
			report_json
			return 0
		fi
		wt_log "adopted the host-generated environment for $WORKSPACE_ID (offset $OFFSET)"
		return 0
	fi

	detect_git_layout
	WORKTREE_FAMILY="$(wt_sanitize_name "$(derive_family)")"
	WORKSPACE_ID="$(wt_require_identifier \
		"$(wt_sanitize_name "${DOCKER_RESOURCE_PREFIX}-${WORKTREE_FAMILY}")" \
		'^[a-z0-9][a-z0-9-]{0,62}$' 'workspace id')"
	PREFERRED_OFFSET="$(compute_preferred_offset "$WORKTREE_FAMILY")"

	if [ "$MODE" = "release" ]; then
		release_offset
		return 0
	fi

	# Reporting never allocates: --json describes the generated environment that
	# already exists, so it stays safe to run from any hook or diagnostic.
	if [ "$MODE" = "json" ]; then
		adopt_recorded_environment
		report_json
		return 0
	fi

	if [ "$GIT_LAYOUT" = "main" ]; then
		OFFSET="0"
		OFFSET_SOURCE="main"
		PUBLISHED_HOST_PORT="$PUBLISHED_CONTAINER_PORT"
	else
		allocate_offset
	fi

	write_environment_files
	wt_log "$WORKSPACE_ID uses offset $OFFSET ($OFFSET_SOURCE); published host port $PUBLISHED_HOST_PORT"
}

main
