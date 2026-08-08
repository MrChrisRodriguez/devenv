#!/usr/bin/env bash
# Diagnose this checkout's isolated worktree runtime without changing it.
#
# The doctor is host-only and read-only. It inspects the host prerequisites, the
# generated state, the container this checkout owns, the published route, and the
# host port registry, and it reports what it found. It reconciles nothing,
# allocates nothing, and repairs nothing, so it stays safe to run at any moment,
# including while a sibling worktree is mid-lifecycle.
#
# The ordered sequence of add_result calls IS the check registry: there is no
# second table to drift from. Every check emits exactly one result - PASS, WARN,
# FAIL, or SKIP - so the emitted id list is stable whatever the host looks like,
# and an unmet prerequisite produces a SKIP carrying its reason rather than a
# silent gap. `--list-checks` prints that same inventory without probing.
#
# This script fails closed like the rest of the runtime, which is the one real
# structural constraint here: under `set -euo pipefail` every fallible probe has
# to be explicitly non-fatal. Probes therefore run inside an `if` condition or
# with an explicit `|| status=$?`; a bare fallible command would abort the report
# halfway through and turn a diagnosis into a crash.
#
# Usage:
#   bash scripts/worktree/doctor.sh [--json] [--strict] [--timeout <seconds>]
#   bash scripts/worktree/doctor.sh --list-checks

set -euo pipefail

WORKTREE_LABEL="Worktree doctor"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/doctor.sh [--json] [--strict] [--timeout <seconds>]
  --json               Emit one machine-readable JSON document
  --strict             Exit 1 when warnings are present as well as failures
  --timeout <seconds>  Local HTTP probe timeout from 1 to 30 seconds
  --list-checks        Print the ordered check inventory and exit
  -h, --help           Show this help

The doctor is host-only and read-only. It does not create containers, generate
state, reload host routing, install tools, or repair files.
USAGE
}

JSON_OUTPUT="false"
STRICT="false"
LIST_ONLY="false"
PROBE_TIMEOUT=""

while [ "$#" -gt 0 ]; do
	case "$1" in
		--json)
			JSON_OUTPUT="true"
			shift
			;;
		--strict)
			STRICT="true"
			shift
			;;
		--list-checks)
			LIST_ONLY="true"
			shift
			;;
		--timeout)
			if [ "$#" -lt 2 ]; then
				printf '%s: --timeout requires a value\n' "$WORKTREE_LABEL" >&2
				usage
				exit 2
			fi
			PROBE_TIMEOUT="$2"
			shift 2
			;;
		--timeout=*)
			PROBE_TIMEOUT="${1#*=}"
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

# The ordered inventory. This is the doctor's published contract: the ids below
# appear in the report in exactly this order, and the guard compares them against
# the add_result calls further down.
check_inventory() {
	cat <<'CHECKS'
host.context
host.command.git
host.command.engine
host.command.cli
host.command.python3
host.command.curl
git.worktree-integrity
host.engine-daemon
state.environment
state.manifest-state
state.values
state.paths
state.manifest
container.record
container.ready-record
container.runtime
container.ownership
container.definition
container.fast-ready
container.workspace-mount
container.git-mount
container.port
container.volumes
container.tools
caddy.binary
caddy.config
caddy.import
caddy.snippet
route.direct
route.friendly
registry.readable
registry.lock
registry.entry
registry.offset-match
registry.port-collision
manifests.port-collision
CHECKS
}

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
CONTAINER_ENGINE="$(wt_contract_value container_engine)"
CONTAINER_CLI="$(wt_contract_value container_cli)"
CONTAINER_CLI_PACKAGE="$(wt_contract_value container_cli_package)"
DOCTOR_SCHEMA_VERSION="$(wt_contract_value doctor_schema_version)"
DEFAULT_PROBE_TIMEOUT="$(wt_contract_value default_probe_timeout_seconds)"
DEVELOPMENT_USER="$(wt_contract_value development_user)"
CONTAINER_WORKSPACE="$(wt_contract_value container_workspace)"
DEVCONTAINER_CONFIG="$(wt_contract_value devcontainer_config)"
GENERATED_ENVIRONMENT="$(wt_contract_value generated_environment)"
RUN_DIRECTORY="$(wt_contract_value run_directory)"
TOOLCHAIN_MANIFEST="$(wt_contract_value toolchain_manifest)"
PUBLISHED_CONTAINER_PORT="$(wt_contract_value published_container_port)"
PUBLISHED_HOST_PORT_VARIABLE="$(wt_contract_value published_host_port_variable)"
PREFERRED_OFFSET_MODULUS="$(wt_contract_value preferred_offset_modulus)"
COLLISION_SCAN_LIMIT="$(wt_contract_value collision_scan_limit)"
DIRECT_HOST="$(wt_contract_value direct_host)"
HOST_CADDY="$(wt_contract_value host_caddy)"
LOCAL_DOMAIN_STEM="$(wt_contract_value local_domain_stem)"
FRIENDLY_DOMAIN_PATTERN="$(wt_contract_value friendly_domain_pattern)"
ENSURE_COMMAND="$(wt_contract_value ensure_command)"
MANIFEST_DIRECTORY="$(wt_expand_home "$(wt_contract_value manifest_directory)")"
CADDY_SNIPPET_DIRECTORY="$(wt_expand_home "$(wt_contract_value caddy_snippet_directory)")"
REGISTRY_DIRECTORY="$(wt_expand_home "$(wt_contract_value registry_directory)")"

REGISTRY_FILE="$REGISTRY_DIRECTORY/ports.json"
REGISTRY_LOCK_DIRECTORY="$REGISTRY_DIRECTORY/ports.lock.d"

# The lock backend that leaves a directory behind records its holder inside it.
# The staleness threshold is read the same way the lock itself reads it, because
# the doctor only ever describes the lock and never takes one.
LOCK_STALE_SECONDS="${PORTABLE_LOCK_STALE_SECONDS:-${WORKTREE_LOCK_STALE_SECONDS:-7200}}"

CONFIG_PATH="$REPO_ROOT/$DEVCONTAINER_CONFIG"
ENVIRONMENT_FILE="$REPO_ROOT/$GENERATED_ENVIRONMENT"
RUN_DIR="$REPO_ROOT/$RUN_DIRECTORY"
MANIFEST_STATE_FILE="$RUN_DIR/manifest.env"
CONTAINER_ID_FILE="$RUN_DIR/container.id"
READY_FILE="$RUN_DIR/container.ready"
LOCAL_FOLDER_LABEL="devcontainer.local_folder"
CONFIG_FILE_LABEL="devcontainer.config_file"

# One shape rule for every identity this runtime derives, shared with the
# lifecycle scripts through lib.sh. The workspace id and the family both reach a
# hostname label, which is why 63 characters and a leading alphanumeric are not
# style preferences.
IDENTIFIER_PATTERN='^[a-z0-9][a-z0-9-]{0,62}$'

# The single bound on every probe this script performs, and the only knob a
# caller may turn. Validation happens before any check runs so an invalid
# argument is answered with exit 2 and an empty report rather than a partial one.
[ -n "$PROBE_TIMEOUT" ] || PROBE_TIMEOUT="$DEFAULT_PROBE_TIMEOUT"
case "$PROBE_TIMEOUT" in
	'' | *[!0-9]*)
		printf '%s: timeout must be an integer from 1 to 30 seconds\n' \
			"$WORKTREE_LABEL" >&2
		exit 2
		;;
esac
if [ "$PROBE_TIMEOUT" -lt 1 ] || [ "$PROBE_TIMEOUT" -gt 30 ]; then
	printf '%s: timeout must be between 1 and 30 seconds\n' "$WORKTREE_LABEL" >&2
	exit 2
fi

if [ "$LIST_ONLY" = "true" ]; then
	check_inventory
	exit 0
fi

WORKSPACE_ID=""
FAMILY=""
OFFSET=""
LAYOUT=""
HOST_PORT=""
DIRECT_URL=""
FRIENDLY_URL=""
MANIFEST_PATH=""
CADDY_SNIPPET_PATH=""

HAVE_GIT="false"
HAVE_ENGINE="false"
HAVE_PYTHON="false"
HAVE_CURL="false"
ENGINE_READY="false"
PYTHON_BIN=""

GIT_INTEGRITY_OK="false"
GIT_COMMON_DIR=""
STATE_ENVIRONMENT_PRESENT="false"
STATE_VALUES_VALID="false"
STATE_PATHS_VALID="false"
MANIFEST_STATUS=""
EXPECTED_DIRECT_URL=""
EXPECTED_FRIENDLY_HOST=""
CADDY_BINARY=""
CADDY_CONFIG=""
REGISTRY_READABLE="false"
REGISTRY_ENTRY_PATH=""
REGISTRY_ENTRY_OFFSET=""
REGISTRY_LINES=""
CONTAINER_ID=""
READY_FINGERPRINT=""
READY_RECORD_VALID="false"
CONTAINER_INSPECTED="false"
CONTAINER_RUNNING="false"
CONTAINER_OWNED="false"
CONTAINER_MOUNTS=""
CONTAINER_LOCAL_FOLDER=""
CONTAINER_CONFIG_FILE=""

RESULT_IDS=()
RESULT_STATUSES=()
RESULT_SUMMARIES=()
RESULT_DETAILS=()
RESULT_REMEDIATIONS=()
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# add_result <PASS|WARN|FAIL|SKIP> <id> <summary> [detail] [remediation]
add_result() {
	local status="$1" id="$2" summary="$3" detail="${4:-}" remediation="${5:-}"
	RESULT_STATUSES+=("$status")
	RESULT_IDS+=("$id")
	RESULT_SUMMARIES+=("$summary")
	RESULT_DETAILS+=("$detail")
	RESULT_REMEDIATIONS+=("$remediation")
	case "$status" in
		PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
		WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
		FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
		SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
	esac
}

# Hand rolled on purpose. The JSON report has to stay parseable exactly when the
# host state is corrupt, including when python3 is the thing that is missing, so
# the escaper is a byte walk in bash and depends on nothing.
json_escape() {
	local value="$1" result="" index=0 length character code escaped
	local LC_ALL=C

	case "$value" in
		*[\\\"]* | *[[:cntrl:]]*) ;;
		*)
			printf '%s' "$value"
			return 0
			;;
	esac
	length="${#value}"
	while [ "$index" -lt "$length" ]; do
		character="${value:index:1}"
		case "$character" in
			'\') result="$result\\\\" ;;
			'"') result="$result\\\"" ;;
			[[:cntrl:]])
				code="$(printf '%d' "'$character")"
				printf -v escaped '\\u%04x' "$code"
				result="$result$escaped"
				;;
			*) result="$result$character" ;;
		esac
		index=$((index + 1))
	done
	printf '%s' "$result"
}

print_human() {
	local index count status detail remediation

	printf 'Worktree doctor\n'
	printf '  workspace: %s\n' "$WORKSPACE_ID"
	printf '  family:    %s\n' "$FAMILY"
	printf '  offset:    %s\n' "$OFFSET"
	printf '  repo:      %s\n\n' "$REPO_ROOT"

	count="${#RESULT_IDS[@]}"
	for ((index = 0; index < count; index++)); do
		status="${RESULT_STATUSES[$index]}"
		detail="${RESULT_DETAILS[$index]}"
		remediation="${RESULT_REMEDIATIONS[$index]}"
		printf '[%-4s] %-28s %s\n' \
			"$status" "${RESULT_IDS[$index]}" "${RESULT_SUMMARIES[$index]}"
		[ -z "$detail" ] || printf '       detail: %s\n' "$detail"
		if [ "$status" != "PASS" ] && [ -n "$remediation" ]; then
			printf '       next:   %s\n' "$remediation"
		fi
	done

	printf '\nSummary: %d pass, %d warn, %d fail, %d skip\n' \
		"$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
}

# Every field is always present and detail/remediation are empty strings rather
# than null or omitted, so a consumer parses one shape no matter which checks
# fired. The offset is a string because a corrupted generated environment can put
# anything there and the document still has to parse.
print_json() {
	local exit_code="$1" index count

	printf '{\n'
	printf '  "schemaVersion": %s,\n' "$DOCTOR_SCHEMA_VERSION"
	printf '  "workspace": {\n'
	printf '    "id": "%s",\n' "$(json_escape "$WORKSPACE_ID")"
	printf '    "family": "%s",\n' "$(json_escape "$FAMILY")"
	printf '    "offset": "%s",\n' "$(json_escape "$OFFSET")"
	printf '    "repoRoot": "%s"\n' "$(json_escape "$REPO_ROOT")"
	printf '  },\n'
	printf '  "checks": [\n'
	count="${#RESULT_IDS[@]}"
	for ((index = 0; index < count; index++)); do
		printf '    {\n'
		printf '      "id": "%s",\n' "$(json_escape "${RESULT_IDS[$index]}")"
		printf '      "status": "%s",\n' "$(json_escape "${RESULT_STATUSES[$index]}")"
		printf '      "summary": "%s",\n' "$(json_escape "${RESULT_SUMMARIES[$index]}")"
		printf '      "detail": "%s",\n' "$(json_escape "${RESULT_DETAILS[$index]}")"
		printf '      "remediation": "%s"\n' \
			"$(json_escape "${RESULT_REMEDIATIONS[$index]}")"
		if [ "$((index + 1))" -lt "$count" ]; then
			printf '    },\n'
		else
			printf '    }\n'
		fi
	done
	printf '  ],\n'
	printf '  "summary": {"pass": %d, "warn": %d, "fail": %d, "skip": %d},\n' \
		"$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
	printf '  "exitCode": %d\n' "$exit_code"
	printf '}\n'
}

# --strict is a pure exit-code modifier: it never changes which checks run or
# what any of them concluded, only whether a warning is fatal to the caller.
computed_exit_code() {
	if [ "$FAIL_COUNT" -gt 0 ]; then
		printf '1\n'
	elif [ "$STRICT" = "true" ] && [ "$WARN_COUNT" -gt 0 ]; then
		printf '1\n'
	else
		printf '0\n'
	fi
}

finish() {
	local exit_code
	exit_code="$(computed_exit_code)"
	if [ "$JSON_OUTPUT" = "true" ]; then
		print_json "$exit_code"
	else
		print_human
	fi
	exit "$exit_code"
}

# Everything below this line answers host-side questions about host-side
# resources. Inside a container the answers would all be wrong rather than
# merely unavailable, so this is a refusal and not a degradation. Each marker
# sits in its own branch: the cloud marker is capability-fenced, and a fixture
# rendered without it must still leave a valid function behind.
check_host_context() {
	if [ "${DEVCONTAINER:-}" = "true" ]; then
		add_result FAIL host.context "The doctor diagnoses a host, not a container" \
			"DEVCONTAINER=true" "Run the doctor from the host checkout."
		finish
	fi
	# capability:start codex_cloud
	if [ "${CODEX_CLOUD:-}" = "true" ]; then
		add_result FAIL host.context "The doctor diagnoses a host, not a container" \
			"CODEX_CLOUD=true" "Run the doctor from the host checkout."
		finish
	fi
	# capability:end codex_cloud
	add_result PASS host.context "Running on the host"
}

# Role named rather than binary named: which binary fills a role comes from the
# contract, so the id stays stable when a project swaps engines and the detail
# carries the actual command that was looked for.
check_host_commands() {
	if command -v git >/dev/null 2>&1; then
		HAVE_GIT="true"
		add_result PASS host.command.git "The version control CLI is installed" "git"
	else
		add_result FAIL host.command.git "The version control CLI is missing" "git" \
			"Install Git and retry."
	fi

	if command -v "$CONTAINER_ENGINE" >/dev/null 2>&1; then
		HAVE_ENGINE="true"
		add_result PASS host.command.engine "The container engine is installed" \
			"$CONTAINER_ENGINE"
	else
		add_result FAIL host.command.engine "The container engine is missing" \
			"$CONTAINER_ENGINE" \
			"Install Docker Desktop (or a compatible engine) and launch its daemon."
	fi

	if command -v "$CONTAINER_CLI" >/dev/null 2>&1; then
		add_result PASS host.command.cli "The container CLI is installed" "$CONTAINER_CLI"
	else
		add_result FAIL host.command.cli "The container CLI is missing" "$CONTAINER_CLI" \
			"Install it with 'bun add --global $CONTAINER_CLI_PACKAGE'."
	fi

	if PYTHON_BIN="$(command -v python3 2>/dev/null)" && [ -n "$PYTHON_BIN" ]; then
		HAVE_PYTHON="true"
		add_result PASS host.command.python3 "The Python interpreter is installed" \
			"python3"
	else
		PYTHON_BIN=""
		add_result FAIL host.command.python3 "The Python interpreter is missing" \
			"python3" \
			"Install python3; the registry and manifest readers require it (macOS: xcode-select --install)."
	fi

	# curl only bounds the two optional route probes, so its absence costs the
	# report two checks rather than its diagnosis.
	if command -v curl >/dev/null 2>&1; then
		HAVE_CURL="true"
		add_result PASS host.command.curl "The HTTP probe client is installed" "curl"
	else
		add_result WARN host.command.curl "The HTTP probe client is missing" "curl" \
			"Install curl so the doctor can probe this worktree's routes."
	fi
}

# A linked worktree's `.git` is a pointer file, and the administrative directory
# it names lives outside the checkout. Reading both ends of that pair is the only
# way to tell a healthy linked worktree from one whose admin directory was pruned
# or is now claimed by a different worktree, and every answer downstream that
# depends on Git metadata - the definition fingerprint, the metadata mount - is
# untrustworthy until it holds.
check_git_integrity() {
	local pointer admin recorded recorded_root actual_root

	if [ "$HAVE_GIT" != "true" ]; then
		add_result SKIP git.worktree-integrity "No version control CLI to ask" \
			"git is not installed"
		return 0
	fi
	pointer="$REPO_ROOT/.git"
	if [ -d "$pointer" ]; then
		GIT_INTEGRITY_OK="true"
		GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute \
			--git-common-dir 2>/dev/null)" || GIT_COMMON_DIR=""
		add_result PASS git.worktree-integrity "This is the main checkout" \
			"$pointer is a Git directory"
		return 0
	fi
	if [ ! -f "$pointer" ]; then
		add_result FAIL git.worktree-integrity "This checkout has no Git metadata" \
			"$pointer is neither a directory nor a pointer file" \
			"Recreate this checkout from its repository."
		return 0
	fi

	admin="$(sed -nE 's/^gitdir: (.*)$/\1/p' "$pointer" 2>/dev/null | head -n 1)" ||
		admin=""
	if [ -z "$admin" ]; then
		add_result FAIL git.worktree-integrity \
			"The Git pointer names no administrative directory" "$pointer" \
			"Recreate this linked worktree from the main checkout."
		return 0
	fi
	case "$admin" in
		/*) ;;
		*) admin="$REPO_ROOT/$admin" ;;
	esac
	if [ ! -d "$admin" ]; then
		add_result FAIL git.worktree-integrity \
			"The Git administrative directory is missing" "$admin" \
			"Recreate this linked worktree from the main checkout."
		return 0
	fi

	# The backpointer is the half that catches an administrative entry reused by
	# some other worktree: the pointer can be perfectly readable and still name a
	# directory that belongs to somebody else.
	recorded="$(head -n 1 <"$admin/gitdir" 2>/dev/null)" || recorded=""
	recorded_root="$(cd "$(dirname "$recorded")" 2>/dev/null && pwd -P)" ||
		recorded_root=""
	actual_root="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P)" || actual_root=""
	if [ -z "$recorded_root" ] || [ "$recorded_root" != "$actual_root" ]; then
		add_result FAIL git.worktree-integrity \
			"The Git administrative directory belongs to another worktree" \
			"$admin/gitdir names $recorded" \
			"Recreate this linked worktree from the main checkout."
		return 0
	fi

	GIT_INTEGRITY_OK="true"
	GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute \
		--git-common-dir 2>/dev/null)" || GIT_COMMON_DIR=""
	add_result PASS git.worktree-integrity \
		"The linked worktree owns its Git administrative directory" "$admin"
}

check_engine_daemon() {
	if [ "$HAVE_ENGINE" != "true" ]; then
		add_result SKIP host.engine-daemon "No container engine to ask" \
			"$CONTAINER_ENGINE is not installed"
		return 0
	fi
	if "$CONTAINER_ENGINE" info >/dev/null 2>&1; then
		ENGINE_READY="true"
		add_result PASS host.engine-daemon "The container engine daemon is responding"
	else
		add_result FAIL host.engine-daemon \
			"The container engine daemon is not responding" \
			"$CONTAINER_ENGINE info failed" \
			"Launch the container engine and retry."
	fi
}

# The generated files are shell-shaped and generated by something else, so they
# are read key by key through the library's sed reader and never sourced: one
# hostile line in a file this script only wants two values out of would otherwise
# execute at read time.
read_state_value() {
	local file="$1" key="$2" value
	value="$(wt_env_file_value "$file" "$key" 2>/dev/null)" || value=""
	printf '%s\n' "$value"
}

check_state_environment() {
	if [ -r "$ENVIRONMENT_FILE" ]; then
		STATE_ENVIRONMENT_PRESENT="true"
		add_result PASS state.environment \
			"The generated worktree environment is readable" "$ENVIRONMENT_FILE"
	else
		add_result WARN state.environment "No generated worktree environment" \
			"$ENVIRONMENT_FILE is missing" \
			"Reconcile this checkout with $ENSURE_COMMAND."
	fi
}

check_state_manifest_state() {
	if [ -r "$MANIFEST_STATE_FILE" ]; then
		add_result PASS state.manifest-state \
			"The published route state is readable" "$MANIFEST_STATE_FILE"
	else
		add_result WARN state.manifest-state "No published route state" \
			"$MANIFEST_STATE_FILE is missing" \
			"Reconcile this checkout with $ENSURE_COMMAND."
	fi
}

# An explicit key allowlist, in one place. The route state file is written after
# the environment and describes the route as actually published, so where the two
# overlap it wins.
load_state_values() {
	local prefix="$ENVIRONMENT_PREFIX"

	if [ -r "$ENVIRONMENT_FILE" ]; then
		WORKSPACE_ID="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_WORKSPACE_ID")"
		FAMILY="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_WORKTREE_FAMILY")"
		OFFSET="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_WORKTREE_OFFSET")"
		LAYOUT="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_WORKTREE_LAYOUT")"
		HOST_PORT="$(read_state_value "$ENVIRONMENT_FILE" "$PUBLISHED_HOST_PORT_VARIABLE")"
		DIRECT_URL="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_DIRECT_URL")"
		FRIENDLY_URL="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_FRIENDLY_URL")"
	fi
	if [ -r "$MANIFEST_STATE_FILE" ]; then
		MANIFEST_PATH="$(read_state_value "$MANIFEST_STATE_FILE" "${prefix}_MANIFEST_PATH")"
		CADDY_SNIPPET_PATH="$(read_state_value "$MANIFEST_STATE_FILE" \
			"${prefix}_CADDY_SNIPPET_PATH")"
		apply_route_state_overrides
	fi
}

# Split out only so the allowlist above reads as one list rather than two.
apply_route_state_overrides() {
	local prefix="$ENVIRONMENT_PREFIX" value

	value="$(read_state_value "$MANIFEST_STATE_FILE" "${prefix}_WORKSPACE_ID")"
	[ -z "$value" ] || WORKSPACE_ID="$value"
	value="$(read_state_value "$MANIFEST_STATE_FILE" "$PUBLISHED_HOST_PORT_VARIABLE")"
	[ -z "$value" ] || HOST_PORT="$value"
	value="$(read_state_value "$MANIFEST_STATE_FILE" "${prefix}_DIRECT_URL")"
	[ -z "$value" ] || DIRECT_URL="$value"
	value="$(read_state_value "$MANIFEST_STATE_FILE" "${prefix}_FRIENDLY_URL")"
	[ -z "$value" ] || FRIENDLY_URL="$value"
}

# Nothing derived from generated state may build a path, a hostname, or a URL
# until it has passed this. The family reaches a DNS label through the friendly
# domain pattern exactly as the workspace id does, so both are held to the same
# rule, and the port floor matches the runtime's own allocator.
check_state_values() {
	local reasons=""

	if [ "$STATE_ENVIRONMENT_PRESENT" != "true" ]; then
		add_result SKIP state.values "No generated values to validate" \
			"$ENVIRONMENT_FILE is missing"
		return 0
	fi
	if ! wt_is_identifier "$WORKSPACE_ID" "$IDENTIFIER_PATTERN"; then
		reasons="$reasons workspace id '$WORKSPACE_ID';"
	fi
	if ! wt_is_identifier "$FAMILY" "$IDENTIFIER_PATTERN"; then
		reasons="$reasons family '$FAMILY';"
	fi
	# Length is checked before magnitude on both numbers: shell arithmetic on a
	# thirty-digit string is an error message, not a comparison.
	case "$OFFSET" in
		'' | *[!0-9]*) reasons="$reasons offset '$OFFSET';" ;;
		*)
			if [ "${#OFFSET}" -gt 6 ] ||
				[ "$OFFSET" -gt "$PREFERRED_OFFSET_MODULUS" ]; then
				reasons="$reasons offset '$OFFSET';"
			fi
			;;
	esac
	if [ "${#HOST_PORT}" -gt 5 ] || ! wt_is_port "$HOST_PORT"; then
		reasons="$reasons published host port '$HOST_PORT';"
	fi

	if [ -n "$reasons" ]; then
		add_result FAIL state.values \
			"The generated worktree values are not usable" \
			"rejected:${reasons%;}" \
			"Regenerate this checkout's environment on the host."
		return 0
	fi
	STATE_VALUES_VALID="true"
	# Derived from the validated components and the contract, never adopted from
	# generated state. These two are what the route checks compare against, what
	# they ask for if the comparison holds, and the only URLs any remediation
	# string is allowed to name.
	EXPECTED_DIRECT_URL="http://$DIRECT_HOST:$HOST_PORT"
	EXPECTED_FRIENDLY_HOST="${FRIENDLY_DOMAIN_PATTERN//\{workspace\}/$FAMILY}"
	EXPECTED_FRIENDLY_HOST="${EXPECTED_FRIENDLY_HOST//\{project\}/$LOCAL_DOMAIN_STEM}"
	add_result PASS state.values "The generated worktree values are well formed" \
		"$WORKSPACE_ID offset $OFFSET port $HOST_PORT"
}

# realpath resolves both `..` segments and symlinks before the containment test,
# so a traversal and a planted symlink both fail here rather than in whatever
# opens the file next. The suffix is the belt to that pair of braces.
path_within_directory() {
	local candidate="$1" directory="$2" suffix="$3"

	[ -n "$PYTHON_BIN" ] || return 1
	CANDIDATE_PATH="$candidate" \
		CONTAINING_DIRECTORY="$directory" \
		REQUIRED_SUFFIX="$suffix" \
		"$PYTHON_BIN" - <<'PYTHON'
import os

candidate = os.path.realpath(os.environ["CANDIDATE_PATH"])
directory = os.path.realpath(os.environ["CONTAINING_DIRECTORY"])
required_suffix = os.environ["REQUIRED_SUFFIX"]

try:
    inside = os.path.commonpath([candidate, directory]) == directory
except ValueError:
    inside = False

if not inside or candidate == directory or not candidate.endswith(required_suffix):
    raise SystemExit(1)
PYTHON
}

check_state_paths() {
	local reasons=""

	if [ "$HAVE_PYTHON" != "true" ]; then
		add_result SKIP state.paths "No Python interpreter to canonicalize paths" \
			"python3 is not installed"
		return 0
	fi
	if [ "$STATE_VALUES_VALID" != "true" ]; then
		add_result SKIP state.paths "The generated values were rejected" \
			"state.values did not pass"
		return 0
	fi
	# Only a validated identity may build a path, which is why this derivation
	# happens after the gate above rather than while the values were being read.
	[ -n "$MANIFEST_PATH" ] || MANIFEST_PATH="$MANIFEST_DIRECTORY/$WORKSPACE_ID.json"
	[ -n "$CADDY_SNIPPET_PATH" ] ||
		CADDY_SNIPPET_PATH="$CADDY_SNIPPET_DIRECTORY/$WORKSPACE_ID.caddy"

	if ! path_within_directory "$MANIFEST_PATH" "$MANIFEST_DIRECTORY" ".json"; then
		reasons="$reasons manifest path '$MANIFEST_PATH';"
	fi
	if ! path_within_directory "$CADDY_SNIPPET_PATH" "$CADDY_SNIPPET_DIRECTORY" \
		".caddy"; then
		reasons="$reasons route path '$CADDY_SNIPPET_PATH';"
	fi

	if [ -n "$reasons" ]; then
		add_result FAIL state.paths \
			"A recorded path escapes the host configuration root" \
			"refused:${reasons%;}" \
			"Regenerate this checkout's environment on the host."
		return 0
	fi
	STATE_PATHS_VALID="true"
	add_result PASS state.paths "Every recorded path stays under its directory" \
		"$MANIFEST_PATH"
}

# Field scoped on purpose: nine allowlisted scalars, no nested structure, and no
# file body ever reaches the report. A manifest is generated state, and a
# diagnostic that echoed it back would be a disclosure channel.
read_manifest_fields() {
	local path="$1"
	MANIFEST_FILE="$path" "$PYTHON_BIN" - <<'PYTHON'
import json
import os
import sys

allowed = (
    "schemaVersion",
    "workspaceId",
    "repoPath",
    "family",
    "offset",
    "hostPort",
    "friendlyHost",
    "caddySnippet",
    "status",
)
try:
    with open(os.environ["MANIFEST_FILE"], "r", encoding="utf-8") as handle:
        document = json.load(handle)
except (ValueError, OSError):
    raise SystemExit(1)
if not isinstance(document, dict):
    raise SystemExit(1)
for key in allowed:
    value = document.get(key)
    if value is None or isinstance(value, (dict, list, bool)):
        continue
    text = str(value)
    if any(character in text for character in "\t\r\n"):
        continue
    sys.stdout.write("%s\t%s\n" % (key, text))
PYTHON
}

check_state_manifest() {
	local fields status=0 key value reasons=""
	local recorded_workspace="" recorded_repo="" recorded_port=""

	if [ "$HAVE_PYTHON" != "true" ]; then
		add_result SKIP state.manifest "No Python interpreter to read the manifest" \
			"python3 is not installed"
		return 0
	fi
	if [ "$STATE_PATHS_VALID" != "true" ]; then
		add_result SKIP state.manifest "The recorded manifest path was refused" \
			"state.paths did not pass"
		return 0
	fi
	if [ ! -e "$MANIFEST_PATH" ]; then
		add_result WARN state.manifest "This worktree publishes no manifest" \
			"$MANIFEST_PATH is missing" \
			"Publish this checkout's route from the host."
		return 0
	fi
	fields="$(read_manifest_fields "$MANIFEST_PATH" 2>/dev/null)" || status=$?
	if [ "$status" -ne 0 ]; then
		add_result FAIL state.manifest "The published manifest is unreadable" \
			"$MANIFEST_PATH is not a JSON object" \
			"Republish this checkout's route from the host."
		return 0
	fi

	while IFS=$'\t' read -r key value; do
		case "$key" in
			workspaceId) recorded_workspace="$value" ;;
			repoPath) recorded_repo="$value" ;;
			hostPort) recorded_port="$value" ;;
			status) MANIFEST_STATUS="$value" ;;
		esac
	done <<EOF
$fields
EOF

	[ "$recorded_workspace" = "$WORKSPACE_ID" ] ||
		reasons="$reasons workspace '$recorded_workspace';"
	# A second independent clone of one project derives this same identity, so a
	# manifest naming a different checkout is that collision and not a typo.
	[ "$recorded_repo" = "$REPO_ROOT" ] || reasons="$reasons repository '$recorded_repo';"
	[ "$recorded_port" = "$HOST_PORT" ] || reasons="$reasons host port '$recorded_port';"

	if [ -n "$reasons" ]; then
		add_result FAIL state.manifest \
			"The published manifest describes a different checkout" \
			"contradicts:${reasons%;}" \
			"Only one clone of a project may live on a host; use linked worktrees."
		return 0
	fi
	add_result PASS state.manifest "The published manifest matches this checkout" \
		"status $MANIFEST_STATUS at $MANIFEST_PATH"
}

# Hexadecimal or nothing, before the value can be interpolated into a single
# engine argument. A corrupted id file is a command-argument injection attempt
# whether or not anybody meant it as one.
check_container_record() {
	local recorded=""

	if [ ! -r "$CONTAINER_ID_FILE" ]; then
		add_result WARN container.record "This checkout records no container" \
			"$CONTAINER_ID_FILE is missing" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	recorded="$(head -n 1 <"$CONTAINER_ID_FILE" 2>/dev/null)" || recorded=""
	case "$recorded" in
		'' | *[!0-9a-fA-F]*)
			add_result FAIL container.record "The recorded container id is corrupt" \
				"'$recorded' is not hexadecimal" \
				"Reconcile this checkout with $ENSURE_COMMAND."
			return 0
			;;
	esac
	CONTAINER_ID="$recorded"
	add_result PASS container.record "This checkout records a container id" \
		"$CONTAINER_ID_FILE"
}

check_container_ready_record() {
	local ready_id="" ready_fingerprint=""

	if [ ! -r "$READY_FILE" ]; then
		add_result WARN container.ready-record "This checkout records no readiness" \
			"$READY_FILE is missing" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	read -r ready_id ready_fingerprint <"$READY_FILE" || true
	case "$ready_id" in
		'' | *[!0-9a-fA-F]*)
			add_result FAIL container.ready-record "The readiness record is malformed" \
				"the recorded id is not hexadecimal" \
				"Reconcile this checkout with $ENSURE_COMMAND."
			return 0
			;;
	esac
	case "$ready_fingerprint" in
		[0-9a-f]*)
			if [ "${#ready_fingerprint}" -ne 64 ]; then
				add_result FAIL container.ready-record \
					"The readiness record is malformed" \
					"the recorded fingerprint is ${#ready_fingerprint} characters, not 64" \
					"Reconcile this checkout with $ENSURE_COMMAND."
				return 0
			fi
			;;
		*)
			add_result FAIL container.ready-record "The readiness record is malformed" \
				"the recorded fingerprint is not a lowercase digest" \
				"Reconcile this checkout with $ENSURE_COMMAND."
			return 0
			;;
	esac
	READY_FINGERPRINT="$ready_fingerprint"
	READY_RECORD_VALID="true"
	add_result PASS container.ready-record "The readiness record is well formed" \
		"$READY_FILE"
}

# One inspect answers liveness, both ownership labels, and every mount at once,
# in exactly the format the reconciler uses, so the doctor and the runtime cannot
# disagree about what they are looking at.
inspect_container() {
	"$CONTAINER_ENGINE" container inspect --format \
		'{{.State.Running}}	{{index .Config.Labels "devcontainer.local_folder"}}	{{index .Config.Labels "devcontainer.config_file"}}	{{range .Mounts}}{{.Source}}>{{.Destination}};{{end}}' \
		"$1" 2>/dev/null
}

check_container_runtime() {
	local details running

	if [ -z "$CONTAINER_ID" ]; then
		add_result SKIP container.runtime "No usable container id to inspect" \
			"container.record did not pass"
		return 0
	fi
	if [ "$ENGINE_READY" != "true" ]; then
		add_result SKIP container.runtime "No container engine daemon to ask" \
			"host.engine-daemon did not pass"
		return 0
	fi
	details="$(inspect_container "$CONTAINER_ID")" || details=""
	if [ -z "$details" ]; then
		add_result WARN container.runtime "The recorded container no longer exists" \
			"$CONTAINER_ID is unknown to $CONTAINER_ENGINE" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	CONTAINER_INSPECTED="true"
	IFS=$'\t' read -r running CONTAINER_LOCAL_FOLDER CONTAINER_CONFIG_FILE \
		CONTAINER_MOUNTS <<EOF
$details
EOF
	if [ "$running" = "true" ]; then
		CONTAINER_RUNNING="true"
		add_result PASS container.runtime "The recorded container is running" \
			"$CONTAINER_ID"
		return 0
	fi
	# Recoverable rather than broken: the next bridged command reconciles it.
	add_result WARN container.runtime "The recorded container is stopped" \
		"$CONTAINER_ID" "Reconcile this checkout with $ENSURE_COMMAND."
}

check_container_ownership() {
	if [ "$CONTAINER_INSPECTED" != "true" ]; then
		add_result SKIP container.ownership "No inspected container to attribute" \
			"container.runtime did not inspect a container"
		return 0
	fi
	if [ "$CONTAINER_LOCAL_FOLDER" = "$REPO_ROOT" ] &&
		[ "$CONTAINER_CONFIG_FILE" = "$CONFIG_PATH" ]; then
		CONTAINER_OWNED="true"
		add_result PASS container.ownership "The container belongs to this checkout" \
			"$LOCAL_FOLDER_LABEL and $CONFIG_FILE_LABEL both name this checkout"
		return 0
	fi
	add_result FAIL container.ownership "The container belongs to another checkout" \
		"$LOCAL_FOLDER_LABEL=$CONTAINER_LOCAL_FOLDER $CONFIG_FILE_LABEL=$CONTAINER_CONFIG_FILE" \
		"Do not execute commands in this container; remove this checkout's runtime resources and reconcile again."
}

check_container_definition() {
	local fingerprint

	if [ "$GIT_INTEGRITY_OK" != "true" ]; then
		add_result SKIP container.definition "Git metadata is not trustworthy" \
			"git.worktree-integrity did not pass"
		return 0
	fi
	if [ "$READY_RECORD_VALID" != "true" ]; then
		add_result SKIP container.definition "No readiness record to compare" \
			"container.ready-record did not pass"
		return 0
	fi
	fingerprint="$(wt_definition_fingerprint 2>/dev/null)" || fingerprint=""
	if [ -z "$fingerprint" ]; then
		add_result FAIL container.definition \
			"The container definition fingerprint could not be computed" \
			"one declared fingerprint input is unreadable" \
			"Restore the container definition inputs and retry."
		return 0
	fi
	if [ "$fingerprint" != "$READY_FINGERPRINT" ]; then
		add_result WARN container.definition \
			"The container definition changed; a rebuild is pending" \
			"recorded $READY_FINGERPRINT current $fingerprint" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	add_result PASS container.definition \
		"The running container matches the current definition" "$fingerprint"
}

# The runtime's own fast readiness path, in its read-only mode. Asking the
# reconciler is the only way to report the answer the bridge will actually get.
check_container_fast_ready() {
	if [ "$CONTAINER_RUNNING" != "true" ] || [ "$CONTAINER_OWNED" != "true" ] ||
		[ "$GIT_INTEGRITY_OK" != "true" ]; then
		add_result SKIP container.fast-ready "Nothing to ask the fast path about" \
			"the container is not a running, owned, Git-safe container"
		return 0
	fi
	if bash "$WORKTREE_RUNTIME_DIR/ensure.sh" --check-ready >/dev/null 2>&1; then
		add_result PASS container.fast-ready "The fast readiness check passes"
		return 0
	fi
	add_result FAIL container.fast-ready "The fast readiness check refuses" \
		"$ENSURE_COMMAND --check-ready reported not ready" \
		"Reconcile this checkout with $ENSURE_COMMAND."
}

container_has_mount() {
	case ";$CONTAINER_MOUNTS" in
		*";$1>$2;"*) return 0 ;;
	esac
	return 1
}

check_container_workspace_mount() {
	if [ "$CONTAINER_INSPECTED" != "true" ]; then
		add_result SKIP container.workspace-mount "No inspected container to read" \
			"container.runtime did not inspect a container"
		return 0
	fi
	if container_has_mount "$REPO_ROOT" "$CONTAINER_WORKSPACE"; then
		add_result PASS container.workspace-mount \
			"This checkout is mounted at the declared workspace" \
			"$REPO_ROOT at $CONTAINER_WORKSPACE"
		return 0
	fi
	add_result FAIL container.workspace-mount \
		"This checkout is not mounted at the declared workspace" \
		"no mount pairs $REPO_ROOT with $CONTAINER_WORKSPACE" \
		"Reconcile this checkout with $ENSURE_COMMAND."
}

# The shared administrative directory lives outside the bind-mounted checkout, so
# it has to appear at the SAME absolute path inside the container: that is the
# only way a Git command in there resolves the pointer `.git` records.
check_container_git_mount() {
	if [ "$CONTAINER_INSPECTED" != "true" ]; then
		add_result SKIP container.git-mount "No inspected container to read" \
			"container.runtime did not inspect a container"
		return 0
	fi
	if [ -z "$GIT_COMMON_DIR" ]; then
		add_result SKIP container.git-mount "No Git common directory to look for" \
			"git.worktree-integrity did not resolve one"
		return 0
	fi
	if container_has_mount "$GIT_COMMON_DIR" "$GIT_COMMON_DIR"; then
		add_result PASS container.git-mount \
			"Git metadata is mounted at its host path" "$GIT_COMMON_DIR"
		return 0
	fi
	add_result FAIL container.git-mount \
		"Git metadata is not mounted at its host path" \
		"no mount pairs $GIT_COMMON_DIR with itself" \
		"Reconcile this checkout with $ENSURE_COMMAND."
}

# Loopback only, and exactly this worktree's port. A binding on 0.0.0.0 puts the
# whole stack on the local network, which is a security change wearing a typo's
# clothes, so it fails rather than warns.
check_container_port() {
	local observed expected

	if [ "$CONTAINER_RUNNING" != "true" ]; then
		add_result SKIP container.port "No running container to ask" \
			"container.runtime did not report a running container"
		return 0
	fi
	if [ "$CONTAINER_OWNED" != "true" ]; then
		add_result SKIP container.port "The container is not this checkout's" \
			"container.ownership did not pass"
		return 0
	fi
	if [ "$STATE_VALUES_VALID" != "true" ]; then
		add_result SKIP container.port "No validated host port to compare" \
			"state.values did not pass"
		return 0
	fi
	expected="$DIRECT_HOST:$HOST_PORT"
	observed="$("$CONTAINER_ENGINE" port "$CONTAINER_ID" \
		"$PUBLISHED_CONTAINER_PORT/tcp" 2>/dev/null | head -n 1)" || observed=""
	if [ "$observed" = "$expected" ]; then
		add_result PASS container.port "The declared port is published on loopback" \
			"$expected"
		return 0
	fi
	add_result FAIL container.port \
		"The declared port is not published where this worktree expects it" \
		"expected $expected, found '$observed'" \
		"Reconcile this checkout with $ENSURE_COMMAND."
}

check_container_volumes() {
	local identity prefixes prefix existing missing="" name

	if [ "$HAVE_PYTHON" != "true" ]; then
		add_result SKIP container.volumes "No Python interpreter to derive volumes" \
			"python3 is not installed"
		return 0
	fi
	if [ "$ENGINE_READY" != "true" ]; then
		add_result SKIP container.volumes "No container engine daemon to ask" \
			"host.engine-daemon did not pass"
		return 0
	fi
	prefixes="$(wt_volume_prefixes "$CONFIG_PATH" 2>/dev/null)" || prefixes=""
	if [ -z "$prefixes" ]; then
		add_result PASS container.volumes \
			"The container definition declares no per-worktree volumes" "$CONFIG_PATH"
		return 0
	fi
	identity="$(wt_devcontainer_identity "$REPO_ROOT" "$CONFIG_PATH" 2>/dev/null)" ||
		identity=""
	if [ -z "$identity" ]; then
		add_result FAIL container.volumes "This checkout's volume identity is unknown" \
			"the container identity could not be derived" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	existing="$("$CONTAINER_ENGINE" volume ls --quiet 2>/dev/null)" || existing=""
	while IFS= read -r prefix; do
		[ -n "$prefix" ] || continue
		name="$prefix-$identity"
		case "
$existing
" in
			*"
$name
"*) ;;
			*) missing="$missing $name" ;;
		esac
	done <<EOF
$prefixes
EOF

	if [ -n "$missing" ]; then
		add_result WARN container.volumes \
			"This checkout's declared volumes are not all present" \
			"absent:$missing" "Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	add_result PASS container.volumes \
		"Every declared per-worktree volume exists" "$identity"
}

# Which tools are required is DERIVED from the toolchain authority the contract
# names, never listed here: a hardcoded list is wrong the moment the authority
# gains a tool, and wrong quietly.
required_tools() {
	local file="$REPO_ROOT/$TOOLCHAIN_MANIFEST"
	[ -r "$file" ] || return 1
	sed -nE '/^\[/q; s/^([A-Za-z0-9_.-]+)[[:space:]]*=[[:space:]]*".*"[[:space:]]*$/\1/p' \
		"$file"
}

check_container_tools() {
	local tools tool script="" probe status=0 listed

	if [ "$CONTAINER_RUNNING" != "true" ] || [ "$CONTAINER_OWNED" != "true" ]; then
		add_result SKIP container.tools "No running, owned container to probe" \
			"the container is not this checkout's running container"
		return 0
	fi
	tools="$(required_tools)" || tools=""
	if [ -z "$tools" ]; then
		add_result SKIP container.tools "The toolchain authority declares no tools" \
			"$TOOLCHAIN_MANIFEST is missing or empty"
		return 0
	fi
	for tool in $tools; do
		case "$tool" in
			*[!A-Za-z0-9_.-]*) continue ;;
		esac
		script="${script}command -v $tool >/dev/null 2>&1 || printf '%s\n' $tool
"
	done

	# A login shell, because the canonical PATH this project's tools live on is
	# assembled by the container's own profile and asking any other way answers a
	# different question than the bridge will get.
	probe="$("$CONTAINER_ENGINE" exec --user "$DEVELOPMENT_USER" \
		--workdir "$CONTAINER_WORKSPACE" "$CONTAINER_ID" \
		/usr/bin/bash -lc "$script" 2>/dev/null)" || status=$?
	if [ "$status" -ne 0 ]; then
		add_result FAIL container.tools "The container tool probe could not run" \
			"the probe exited $status inside $CONTAINER_ID" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	if [ -n "$probe" ]; then
		listed="$(printf '%s' "$probe" | tr '\n' ' ')"
		add_result FAIL container.tools \
			"The container is missing declared toolchain commands" \
			"absent: ${listed% }" \
			"Reconcile this checkout with $ENSURE_COMMAND."
		return 0
	fi
	add_result PASS container.tools \
		"Every command the toolchain authority declares resolves in the container" \
		"$TOOLCHAIN_MANIFEST"
}

# Remediation text is output, and output derived from generated state is a
# disclosure channel. Only the URL this script recomputed for itself may be
# named; before validation there is no such URL and the advice stays generic.
direct_url_hint() {
	if [ -n "$EXPECTED_DIRECT_URL" ]; then
		printf '%s\n' "$EXPECTED_DIRECT_URL"
		return 0
	fi
	printf 'the direct loopback URL\n'
}

# The friendly route is optional by contract: it is a convenience layered on a
# direct loopback URL that always works. Every finding in this group is therefore
# a warning, and --strict is how a caller says it wants them to matter.
check_caddy_binary() {
	local override_name override

	if [ "$HOST_CADDY" = "disabled" ]; then
		add_result SKIP caddy.binary "This project publishes no friendly route" \
			"host_caddy is disabled"
		return 0
	fi
	override_name="${ENVIRONMENT_PREFIX}_HOST_CADDY_BIN"
	override="${!override_name:-}"
	if [ -n "$override" ]; then
		if [ -x "$override" ]; then
			CADDY_BINARY="$override"
			add_result PASS caddy.binary "A host routing binary is available" "$override"
			return 0
		fi
		add_result WARN caddy.binary "The declared host routing binary is unusable" \
			"$override is not executable" \
			"Point $override_name at an executable or unset it."
		return 0
	fi
	if CADDY_BINARY="$(command -v caddy 2>/dev/null)" && [ -n "$CADDY_BINARY" ]; then
		add_result PASS caddy.binary "A host routing binary is available" \
			"$CADDY_BINARY"
		return 0
	fi
	CADDY_BINARY=""
	add_result WARN caddy.binary "No host routing binary is installed" \
		"caddy was not found" \
		"Install the host reverse proxy, or use $(direct_url_hint), which always works."
}

# A fixed candidate list, and deliberately not bare /etc/Caddyfile: validating a
# machine-wide configuration this runtime does not own is not a convenience.
resolve_host_config() {
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

check_caddy_config() {
	if [ "$HOST_CADDY" = "disabled" ]; then
		add_result SKIP caddy.config "This project publishes no friendly route" \
			"host_caddy is disabled"
		return 0
	fi
	if [ -z "$CADDY_BINARY" ]; then
		add_result SKIP caddy.config "No host routing binary to validate with" \
			"caddy.binary did not pass"
		return 0
	fi
	if ! CADDY_CONFIG="$(resolve_host_config)" || [ ! -r "$CADDY_CONFIG" ]; then
		CADDY_CONFIG=""
		add_result WARN caddy.config "No host routing configuration was found" \
			"none of the candidate paths is readable" \
			"Create a host reverse proxy configuration, or use $(direct_url_hint)."
		return 0
	fi
	if "$CADDY_BINARY" validate --config "$CADDY_CONFIG" --adapter caddyfile \
		>/dev/null 2>&1; then
		add_result PASS caddy.config "The host routing configuration validates" \
			"$CADDY_CONFIG"
		return 0
	fi
	add_result WARN caddy.config "The host routing configuration does not validate" \
		"$CADDY_CONFIG was rejected" \
		"Repair the host reverse proxy configuration, or use $(direct_url_hint)."
}

check_caddy_import() {
	local needle="$CADDY_SNIPPET_DIRECTORY/*.caddy"

	if [ "$HOST_CADDY" = "disabled" ]; then
		add_result SKIP caddy.import "This project publishes no friendly route" \
			"host_caddy is disabled"
		return 0
	fi
	if [ -z "$CADDY_CONFIG" ]; then
		add_result SKIP caddy.import "No host routing configuration to read" \
			"caddy.config did not resolve one"
		return 0
	fi
	if grep -Fq "$needle" "$CADDY_CONFIG" 2>/dev/null; then
		add_result PASS caddy.import "The host configuration imports worktree routes" \
			"$needle"
		return 0
	fi
	add_result WARN caddy.import \
		"The host configuration does not import worktree routes" \
		"$CADDY_CONFIG has no import of $needle" \
		"Add 'import $needle' to $CADDY_CONFIG once."
}

check_caddy_snippet() {
	local proxy="reverse_proxy $DIRECT_HOST:$HOST_PORT"

	if [ "$HOST_CADDY" = "disabled" ]; then
		add_result SKIP caddy.snippet "This project publishes no friendly route" \
			"host_caddy is disabled"
		return 0
	fi
	if [ "$STATE_PATHS_VALID" != "true" ]; then
		add_result SKIP caddy.snippet "The recorded route path was refused" \
			"state.paths did not pass"
		return 0
	fi
	if [ "$MANIFEST_STATUS" != "active" ]; then
		# A snippet left behind by a stopped worktree is untidy, not broken: the
		# manifest survives deactivation on purpose and the route does not.
		if [ -e "$CADDY_SNIPPET_PATH" ]; then
			add_result WARN caddy.snippet "A route survives an inactive worktree" \
				"$CADDY_SNIPPET_PATH" \
				"Publish or remove this checkout's route from the host."
			return 0
		fi
		add_result PASS caddy.snippet "This inactive worktree publishes no route" \
			"$CADDY_SNIPPET_PATH is absent"
		return 0
	fi
	if [ ! -r "$CADDY_SNIPPET_PATH" ]; then
		add_result FAIL caddy.snippet "This active worktree publishes no route" \
			"$CADDY_SNIPPET_PATH is missing" \
			"Republish this checkout's route from the host."
		return 0
	fi
	if grep -Fq "http://$EXPECTED_FRIENDLY_HOST" "$CADDY_SNIPPET_PATH" 2>/dev/null &&
		grep -Fq "$proxy" "$CADDY_SNIPPET_PATH" 2>/dev/null; then
		add_result PASS caddy.snippet "The published route names this worktree" \
			"$EXPECTED_FRIENDLY_HOST to $DIRECT_HOST:$HOST_PORT"
		return 0
	fi
	add_result FAIL caddy.snippet "The published route describes something else" \
		"$CADDY_SNIPPET_PATH does not pair $EXPECTED_FRIENDLY_HOST with $proxy" \
		"Republish this checkout's route from the host."
}

# Single attempt, bounded by --timeout, and never a host this script did not
# itself derive.
probe_http_code() {
	curl --silent --max-time "$PROBE_TIMEOUT" --output /dev/null \
		--write-out '%{http_code}' "$1" 2>/dev/null
}

http_code_is_healthy() {
	case "$1" in
		2[0-9][0-9] | 3[0-9][0-9]) return 0 ;;
	esac
	return 1
}

# The URL is recomputed from the validated components and compared as a string
# before anything is requested. A well-formed but externally pointed URL in
# generated state is caught here, and the probe client is never invoked at all.
check_route_direct() {
	local expected code

	if [ "$STATE_VALUES_VALID" != "true" ]; then
		add_result SKIP route.direct "No validated route to probe" \
			"state.values did not pass"
		return 0
	fi
	expected="$EXPECTED_DIRECT_URL"
	if [ "$DIRECT_URL" != "$expected" ]; then
		add_result FAIL route.direct "Refused an unexpected direct URL" \
			"generated state names '$DIRECT_URL'" \
			"Regenerate this checkout's environment; the direct URL must be $expected."
		return 0
	fi
	if [ "$HAVE_CURL" != "true" ]; then
		add_result SKIP route.direct "No HTTP probe client to ask" \
			"curl is not installed"
		return 0
	fi
	code="$(probe_http_code "$expected")" || code="000"
	if http_code_is_healthy "$code"; then
		add_result PASS route.direct "The direct URL answers" "$expected returned $code"
		return 0
	fi
	add_result FAIL route.direct "The direct URL does not answer" \
		"$expected returned $code" \
		"Reconcile this checkout with $ENSURE_COMMAND, then retry."
}

check_route_friendly() {
	local expected code

	if [ "$HOST_CADDY" = "disabled" ]; then
		add_result SKIP route.friendly "This project publishes no friendly route" \
			"host_caddy is disabled"
		return 0
	fi
	if [ "$STATE_VALUES_VALID" != "true" ]; then
		add_result SKIP route.friendly "No validated route to probe" \
			"state.values did not pass"
		return 0
	fi
	expected="http://$EXPECTED_FRIENDLY_HOST"
	if [ "$FRIENDLY_URL" != "$expected" ]; then
		add_result FAIL route.friendly "Refused an unexpected friendly URL" \
			"generated state names '$FRIENDLY_URL'" \
			"Regenerate this checkout's environment; the friendly URL must be $expected."
		return 0
	fi
	if [ "$HAVE_CURL" != "true" ]; then
		add_result SKIP route.friendly "No HTTP probe client to ask" \
			"curl is not installed"
		return 0
	fi
	code="$(probe_http_code "$expected")" || code="000"
	if http_code_is_healthy "$code"; then
		add_result PASS route.friendly "The friendly URL answers" \
			"$expected returned $code"
		return 0
	fi
	# The friendly route is the optional half, so the remediation names the half
	# that is not.
	add_result FAIL route.friendly "The friendly URL does not answer" \
		"$expected returned $code" \
		"Use $EXPECTED_DIRECT_URL, then check that the host reverse proxy is up and imports the worktree routes."
}

read_registry() {
	REGISTRY_FILE="$REGISTRY_FILE" WORKSPACE_ID="$WORKSPACE_ID" "$PYTHON_BIN" - <<'PYTHON'
import json
import os
import sys

try:
    with open(os.environ["REGISTRY_FILE"], "r", encoding="utf-8") as handle:
        data = json.load(handle)
except (ValueError, OSError):
    raise SystemExit(2)
if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
    raise SystemExit(2)

entries = data["entries"]
own = entries.get(os.environ["WORKSPACE_ID"])
if isinstance(own, dict):
    sys.stdout.write("entry\t%s\t%s\n" % (own.get("path", ""), own.get("offset", "")))


def ports_of(name):
    entry = entries.get(name)
    found = set()
    if not isinstance(entry, dict):
        return found
    for port in entry.get("ports", []) or []:
        try:
            found.add(int(port))
        except (TypeError, ValueError):
            continue
    return found


names = sorted(entries)
reported = 0
for index, left in enumerate(names):
    for right in names[index + 1 :]:
        shared = sorted(ports_of(left) & ports_of(right))
        if not shared:
            continue
        sys.stdout.write(
            "collision\t%s\t%s\t%s\n"
            % (left, right, ", ".join(str(port) for port in shared[:4]))
        )
        reported += 1
        if reported >= 4:
            raise SystemExit(0)
PYTHON
}

check_registry_readable() {
	local status=0

	if [ "$HAVE_PYTHON" != "true" ]; then
		add_result SKIP registry.readable "No Python interpreter to read the registry" \
			"python3 is not installed"
		return 0
	fi
	if [ ! -e "$REGISTRY_FILE" ]; then
		add_result WARN registry.readable "This host has no port registry yet" \
			"$REGISTRY_FILE is missing" \
			"Generate any worktree's environment on this host to create it."
		return 0
	fi
	REGISTRY_LINES="$(read_registry)" || status=$?
	if [ "$status" -ne 0 ]; then
		REGISTRY_LINES=""
		add_result FAIL registry.readable "The port registry is unreadable" \
			"$REGISTRY_FILE is not a JSON document with an entries object" \
			"Move $REGISTRY_FILE aside and regenerate every worktree's environment."
		return 0
	fi
	REGISTRY_READABLE="true"
	add_result PASS registry.readable "The port registry is readable" "$REGISTRY_FILE"
}

directory_epoch() {
	local path="$1" value
	if value="$(stat -c '%Y' "$path" 2>/dev/null)" && [ -n "$value" ]; then
		printf '%s\n' "$value"
		return 0
	fi
	if value="$(stat -f '%m' "$path" 2>/dev/null)" && [ -n "$value" ]; then
		printf '%s\n' "$value"
		return 0
	fi
	return 1
}

# Inspection only. The doctor never acquires this lock, never releases one it did
# not take, and never removes a lock directory: a live holder in the middle of a
# read-modify-write is exactly the process a diagnostic must not disturb.
check_registry_lock() {
	local owner="$REGISTRY_LOCK_DIRECTORY/owner" pid="" started="" now age

	if [ ! -d "$REGISTRY_LOCK_DIRECTORY" ]; then
		add_result PASS registry.lock "No registry allocation is holding a lock" \
			"$REGISTRY_LOCK_DIRECTORY is absent"
		return 0
	fi
	if [ -r "$owner" ]; then
		read -r pid started <"$owner" || true
	fi
	case "$pid" in
		'' | *[!0-9]*) pid="" ;;
	esac
	case "$started" in
		'' | *[!0-9]*) started="" ;;
	esac
	if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
		add_result WARN registry.lock "A registry allocation is in flight" \
			"process $pid holds $REGISTRY_LOCK_DIRECTORY" \
			"Wait for the other worktree's allocation to finish, then retry."
		return 0
	fi
	if [ -z "$started" ]; then
		started="$(directory_epoch "$REGISTRY_LOCK_DIRECTORY")" || started=""
	fi
	age="unknown"
	if [ -n "$started" ]; then
		now="$(date +%s)"
		age="$((now - started))s"
	fi
	add_result WARN registry.lock "The registry lock looks abandoned" \
		"$REGISTRY_LOCK_DIRECTORY has no live holder (age $age, threshold ${LOCK_STALE_SECONDS}s)" \
		"Delete the stale lock directory $REGISTRY_LOCK_DIRECTORY."
}

check_registry_entry() {
	local line

	if [ "$STATE_VALUES_VALID" != "true" ]; then
		add_result SKIP registry.entry "No validated identity to look up" \
			"state.values did not pass"
		return 0
	fi
	if [ "$LAYOUT" != "worktree" ]; then
		add_result SKIP registry.entry "The main checkout is never registered" \
			"it owns offset 0 by convention"
		return 0
	fi
	if [ "$REGISTRY_READABLE" != "true" ]; then
		add_result SKIP registry.entry "No readable registry to look in" \
			"registry.readable did not pass"
		return 0
	fi
	line="$(printf '%s\n' "$REGISTRY_LINES" | grep '^entry	' | head -n 1)" || line=""
	if [ -z "$line" ]; then
		add_result WARN registry.entry "This worktree holds no registry entry" \
			"$WORKSPACE_ID is not registered" \
			"Regenerate this checkout's environment on the host."
		return 0
	fi
	IFS=$'\t' read -r _ REGISTRY_ENTRY_PATH REGISTRY_ENTRY_OFFSET <<EOF
$line
EOF
	if [ "$REGISTRY_ENTRY_PATH" != "$REPO_ROOT" ]; then
		add_result WARN registry.entry "The registry entry names another directory" \
			"registry=$REGISTRY_ENTRY_PATH checkout=$REPO_ROOT" \
			"Regenerate this checkout's environment, or rename the worktree directory."
		return 0
	fi
	add_result PASS registry.entry "This worktree holds its registry entry" \
		"$WORKSPACE_ID at offset $REGISTRY_ENTRY_OFFSET"
}

check_registry_offset_match() {
	if [ "$LAYOUT" != "worktree" ]; then
		add_result SKIP registry.offset-match "The main checkout is never registered" \
			"it owns offset 0 by convention"
		return 0
	fi
	if [ -z "$REGISTRY_ENTRY_OFFSET" ]; then
		add_result SKIP registry.offset-match "No registry offset to compare" \
			"registry.entry found none"
		return 0
	fi
	if [ "$REGISTRY_ENTRY_OFFSET" = "$OFFSET" ]; then
		add_result PASS registry.offset-match \
			"The registry and the generated environment agree on the offset" \
			"offset $OFFSET"
		return 0
	fi
	add_result FAIL registry.offset-match \
		"The registry and the generated environment disagree on the offset" \
		"registry=$REGISTRY_ENTRY_OFFSET env=$OFFSET" \
		"Regenerate this checkout's environment on the host."
}

check_registry_port_collision() {
	local collisions detail

	if [ "$REGISTRY_READABLE" != "true" ]; then
		add_result SKIP registry.port-collision "No readable registry to scan" \
			"registry.readable did not pass"
		return 0
	fi
	collisions="$(printf '%s\n' "$REGISTRY_LINES" | grep '^collision	')" ||
		collisions=""
	if [ -z "$collisions" ]; then
		add_result PASS registry.port-collision \
			"Every registered environment holds a disjoint port set"
		return 0
	fi
	detail="$(printf '%s\n' "$collisions" |
		sed -e 's/^collision	//' -e 's/	/ and /' -e 's/	/ share ports /' |
		tr '\n' ';')"
	add_result FAIL registry.port-collision \
		"Two registered environments claim the same ports" \
		"${detail%;}" \
		"Regenerate the affected worktrees' environments to reallocate them."
}

scan_manifest_claims() {
	MANIFEST_DIRECTORY="$MANIFEST_DIRECTORY" SCAN_LIMIT="$COLLISION_SCAN_LIMIT" \
		"$PYTHON_BIN" - <<'PYTHON'
import json
import os
import sys

directory = os.environ["MANIFEST_DIRECTORY"]
limit = int(os.environ["SCAN_LIMIT"])
try:
    names = sorted(
        name for name in os.listdir(directory) if name.endswith(".json")
    )
except OSError:
    names = []
truncated = len(names) > limit
claims = {}
malformed = 0
for name in names[:limit]:
    try:
        with open(os.path.join(directory, name), "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (ValueError, OSError):
        malformed += 1
        continue
    if not isinstance(document, dict):
        malformed += 1
        continue
    if document.get("status") != "active":
        continue
    identifier = document.get("workspaceId")
    port = document.get("hostPort")
    if not isinstance(identifier, str) or isinstance(port, bool):
        malformed += 1
        continue
    if not isinstance(port, int):
        malformed += 1
        continue
    claims.setdefault(port, set()).add(identifier)
for port in sorted(claims):
    holders = sorted(claims[port])
    if len(holders) > 1:
        sys.stdout.write("collision\t%d\t%s\n" % (port, " and ".join(holders)))
sys.stdout.write(
    "scanned\t%d\t%d\t%s\n"
    % (len(names[:limit]), malformed, "truncated" if truncated else "complete")
)
PYTHON
}

# The independent cross-check on the registry-first diagnosis above: the registry
# says who was allocated what, and this says who is actually claiming what.
check_manifests_port_collision() {
	local output status=0 collisions line scanned malformed bound detail

	if [ "$HAVE_PYTHON" != "true" ]; then
		add_result SKIP manifests.port-collision \
			"No Python interpreter to read the manifests" "python3 is not installed"
		return 0
	fi
	output="$(scan_manifest_claims)" || status=$?
	if [ "$status" -ne 0 ]; then
		add_result SKIP manifests.port-collision "The manifest directory is unreadable" \
			"$MANIFEST_DIRECTORY could not be listed"
		return 0
	fi
	line="$(printf '%s\n' "$output" | grep '^scanned	' | head -n 1)" || line=""
	IFS=$'\t' read -r _ scanned malformed bound <<EOF
$line
EOF
	collisions="$(printf '%s\n' "$output" | grep '^collision	')" || collisions=""
	if [ -n "$collisions" ]; then
		detail="$(printf '%s\n' "$collisions" |
			sed -e 's/^collision	/port /' -e 's/	/ is claimed by /' | tr '\n' ';')"
		add_result FAIL manifests.port-collision \
			"Two active worktrees claim the same host port" "${detail%;}" \
			"Regenerate the affected worktrees' environments to reallocate them."
		return 0
	fi
	if [ "${malformed:-0}" -gt 0 ]; then
		add_result WARN manifests.port-collision \
			"Some published manifests could not be checked" \
			"$malformed of $scanned manifests are malformed" \
			"Republish or remove the unreadable manifests."
		return 0
	fi
	detail="$scanned published manifests scanned"
	if [ "${bound:-complete}" = "truncated" ]; then
		detail="$detail (bounded at the declared scan limit of $COLLISION_SCAN_LIMIT)"
	fi
	add_result PASS manifests.port-collision \
		"No two active worktrees claim the same host port" "$detail"
}

main() {
	check_host_context
	check_host_commands
	check_git_integrity
	check_engine_daemon

	check_state_environment
	check_state_manifest_state
	load_state_values
	check_state_values
	check_state_paths
	check_state_manifest

	check_container_record
	check_container_ready_record
	check_container_runtime
	check_container_ownership
	check_container_definition
	check_container_fast_ready
	check_container_workspace_mount
	check_container_git_mount
	check_container_port
	check_container_volumes
	check_container_tools

	check_caddy_binary
	check_caddy_config
	check_caddy_import
	check_caddy_snippet
	check_route_direct
	check_route_friendly

	check_registry_readable
	check_registry_lock
	check_registry_entry
	check_registry_offset_match
	check_registry_port_collision
	check_manifests_port_collision

	finish
}

main
