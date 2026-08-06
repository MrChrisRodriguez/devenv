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
host.engine-daemon
CHECKS
}

ENVIRONMENT_PREFIX="$(wt_contract_value environment_prefix)"
CONTAINER_ENGINE="$(wt_contract_value container_engine)"
CONTAINER_CLI="$(wt_contract_value container_cli)"
CONTAINER_CLI_PACKAGE="$(wt_contract_value container_cli_package)"
DOCTOR_SCHEMA_VERSION="$(wt_contract_value doctor_schema_version)"
DEFAULT_PROBE_TIMEOUT="$(wt_contract_value default_probe_timeout_seconds)"

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

HAVE_GIT="false"
HAVE_ENGINE="false"
HAVE_CLI="false"
HAVE_PYTHON="false"
HAVE_CURL="false"
ENGINE_READY="false"
PYTHON_BIN=""

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

main() {
	check_host_context
	check_host_commands
	check_engine_daemon
	finish
}

main
