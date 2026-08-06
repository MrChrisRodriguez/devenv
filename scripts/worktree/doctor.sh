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
DIRECT_HOST="$(wt_contract_value direct_host)"
ENSURE_COMMAND="$(wt_contract_value ensure_command)"
MANIFEST_DIRECTORY="$(wt_expand_home "$(wt_contract_value manifest_directory)")"
CADDY_SNIPPET_DIRECTORY="$(wt_expand_home "$(wt_contract_value caddy_snippet_directory)")"

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
FRIENDLY_HOST=""
MANIFEST_PATH=""
CADDY_SNIPPET_PATH=""

HAVE_GIT="false"
HAVE_ENGINE="false"
HAVE_CLI="false"
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
		HAVE_CLI="true"
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
		FRIENDLY_HOST="$(read_state_value "$ENVIRONMENT_FILE" "${prefix}_FRIENDLY_HOST")"
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
	value="$(read_state_value "$MANIFEST_STATE_FILE" "${prefix}_FRIENDLY_HOST")"
	[ -z "$value" ] || FRIENDLY_HOST="$value"
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

	finish
}

main
