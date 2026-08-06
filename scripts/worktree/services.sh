#!/usr/bin/env bash
# Start, stop, and report the development services this project declares.
#
# The service registry is the generated contract: names, base ports,
# dependencies, working directories, start commands, and health expectations all
# come from there, so adding a service is a parameter change and never a change
# to this script. A project that declares none is a supported, silent case.
#
# Container-internal ports are NEVER offset. Each container owns its own network
# namespace, so a worktree's offset disambiguates HOST ports only and every
# service inside the container listens on its declared base port.
#
# Start order is a topological sort of depends_on with declaration order as the
# tie-break, so the order is deterministic rather than merely correct. A cycle is
# a contract error and exits 2 naming the services still waiting on each other.
#
# Readiness is a contract, not a sleep: each service is polled at its declared
# health path until the response matches its declared expectation, and every
# already-started process is checked for liveness on every iteration, so a
# service that dies while a later one starts fails the run immediately instead of
# leaving a half-started stack behind.
#
# Usage:
#   bash scripts/worktree/services.sh order    Print the resolved start order
#   bash scripts/worktree/services.sh start    Start every declared service in order
#   bash scripts/worktree/services.sh stop     Stop every service this checkout started
#   bash scripts/worktree/services.sh status   Report each declared service's state
#
# Env (<PREFIX> is the contract's environment prefix):
#   <PREFIX>_STARTUP_MODE=staggered     Replace readiness gates with bounded delays
#   <PREFIX>_STAGGER_SECONDS=<seconds>  Delay per topological position (default 10)
#   <PREFIX>_SERVICE_START_TIMEOUT=<n>  Readiness timeout per service

set -euo pipefail

WORKTREE_LABEL="Worktree services"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/services.sh <order|start|stop|status>
  order   Print the resolved dependency order, one service per line
  start   Start every declared service in dependency order and wait for readiness
  stop    Stop every service this checkout started
  status  Report whether each declared service is running
USAGE
}

MODE=""
if [ "$#" -eq 0 ]; then
	usage
	exit 2
fi
case "$1" in
	order | start | stop | status)
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
RUN_DIRECTORY="$(wt_contract_value run_directory)"
DIRECT_HOST="$(wt_contract_value direct_host)"
PROBE_TIMEOUT="$(wt_contract_value default_probe_timeout_seconds)"
STARTUP_TIMEOUT="$(wt_contract_value startup_timeout_seconds)"
DIAGNOSTIC_STAGGERED_MODE="$(wt_contract_value diagnostic_staggered_mode)"
SERVICES="$(wt_contract_list services)"

SERVICES_DIR="$REPO_ROOT/$RUN_DIRECTORY/services"
STARTED=""

startup_mode_name="${ENVIRONMENT_PREFIX}_STARTUP_MODE"
stagger_seconds_name="${ENVIRONMENT_PREFIX}_STAGGER_SECONDS"
service_timeout_name="${ENVIRONMENT_PREFIX}_SERVICE_START_TIMEOUT"
STARTUP_MODE="${!startup_mode_name:-readiness}"
STAGGER_SECONDS="${!stagger_seconds_name:-10}"
SERVICE_TIMEOUT="${!service_timeout_name:-$STARTUP_TIMEOUT}"

if [ "$STARTUP_MODE" = "staggered" ] && [ "$DIAGNOSTIC_STAGGERED_MODE" != "true" ]; then
	wt_warn "staggered startup is disabled by the contract; using readiness gates"
	STARTUP_MODE="readiness"
fi

service_declared() {
	case " $SERVICES " in
		*" $1 "*) return 0 ;;
	esac
	return 1
}

service_port() {
	wt_service_value "$1" base_port
}

service_variable_name() {
	printf '%s' "$1" | tr 'a-z-' 'A-Z_'
}

# Kahn's algorithm written for bash 3.2, which macOS still ships and which has no
# associative arrays: repeatedly emit the first declared service whose
# dependencies are all emitted. Scanning in declaration order makes the tie-break
# deterministic, so the same contract always produces the same order.
service_order() {
	local remaining="$SERVICES" emitted="" progress name dependency ready item rest

	while [ -n "${remaining// /}" ]; do
		progress=""
		for name in $remaining; do
			ready="1"
			for dependency in $(wt_contract_list "service_${name}_depends_on"); do
				if ! service_declared "$dependency"; then
					wt_die "service '$name' depends on '$dependency', which is not declared" 2
				fi
				case " $emitted " in
					*" $dependency "*) ;;
					*) ready="" ;;
				esac
			done
			if [ -n "$ready" ]; then
				emitted="$emitted $name"
				rest=""
				for item in $remaining; do
					[ "$item" = "$name" ] || rest="$rest $item"
				done
				remaining="$rest"
				progress="1"
				break
			fi
		done
		if [ -z "$progress" ]; then
			wt_die "the service dependency graph has a cycle among:$remaining" 2
		fi
	done
	for name in $emitted; do
		printf '%s\n' "$name"
	done
}

# Every service sees every declared port, because a service that talks to another
# one must not have to guess. Nothing here is offset: this is the container view.
export_service_ports() {
	local service name port
	for service in $SERVICES; do
		name="$(service_variable_name "$service")"
		port="$(service_port "$service")"
		export "${ENVIRONMENT_PREFIX}_${name}_PORT=$port"
		export "${ENVIRONMENT_PREFIX}_${name}_URL=http://localhost:$port"
	done
}

recorded_pid() {
	local file="$SERVICES_DIR/$1.pid"
	[ -r "$file" ] || return 1
	cat "$file"
}

service_running() {
	local pid
	pid="$(recorded_pid "$1")" || return 1
	case "$pid" in
		'' | *[!0-9]*) return 1 ;;
	esac
	if kill -0 "$pid" 2>/dev/null; then
		return 0
	fi
	# The leader can exit while the listener it spawned keeps running, so a dead
	# leader is not proof the service is gone: ask the whole process group.
	kill -0 -- "-$pid" 2>/dev/null
}

# Signal the recorded process group, not one process. A declared start command is
# a process TREE far more often than it is a single binary - a package manager
# wrapping a server, or a /bin/sh that forks instead of exec'ing, which is what
# dash does and what bash does not. Signalling only the recorded pid kills the
# shell and orphans the listener, which then holds its port forever. The bare pid
# is the fallback for a group that no longer exists.
signal_service_tree() {
	local pid="$1" signal="$2"
	kill "-$signal" -- "-$pid" 2>/dev/null && return 0
	kill "-$signal" "$pid" 2>/dev/null || true
	return 0
}

report_log_tail() {
	local name="$1" log="$SERVICES_DIR/$1.log"
	[ -r "$log" ] || return 0
	printf '%s: last lines of %s:\n' "$WORKTREE_LABEL" "$log" >&2
	tail -n 40 "$log" >&2 || true
}

# A failure anywhere stops everything this run started. Leaving half a stack
# behind would leave ports bound and a later run diagnosing the wrong problem.
fail_service() {
	local name="$1" reason="$2"
	report_log_tail "$name"
	stop_services
	wt_die "service '$name' $reason"
}

assert_started_alive() {
	local current="$1" name
	for name in $STARTED; do
		[ "$name" != "$current" ] || continue
		if ! service_running "$name"; then
			report_log_tail "$name"
			stop_services
			wt_die "service '$name' exited while '$current' was starting"
		fi
	done
}

body_matches() {
	local expectation="$1" body="$2"
	case "$expectation" in
		http-2xx)
			return 0
			;;
		http-2xx-html)
			if printf '%s' "$body" | grep -qiE '<!doctype html|<html'; then
				return 0
			fi
			return 1
			;;
		json-status-ok)
			# A body match, not merely a 200: an unrelated healthy-looking response
			# from something else on that port must not count as this service.
			if printf '%s' "$body" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
				return 0
			fi
			return 1
			;;
		*)
			wt_die "service health expectation '$expectation' is not one of http-2xx, http-2xx-html, json-status-ok" 2
			;;
	esac
}

wait_for_service() {
	local name="$1" port="$2" path="$3" expectation="$4" timeout="$5" pid="$6"
	local deadline now body

	command -v curl >/dev/null 2>&1 ||
		wt_die "curl is required to verify service readiness"
	now="$(date +%s)"
	deadline=$((now + timeout))
	while :; do
		if ! kill -0 "$pid" 2>/dev/null; then
			fail_service "$name" "exited before it became ready"
		fi
		assert_started_alive "$name"
		if body="$(curl --silent --fail \
			--connect-timeout "$PROBE_TIMEOUT" --max-time "$PROBE_TIMEOUT" \
			"http://$DIRECT_HOST:$port$path" 2>/dev/null)"; then
			if body_matches "$expectation" "$body"; then
				wt_log "$name is ready on port $port"
				return 0
			fi
		fi
		now="$(date +%s)"
		if [ "$now" -ge "$deadline" ]; then
			fail_service "$name" \
				"did not satisfy $expectation at $path within ${timeout}s"
		fi
		sleep 0.25
	done
}

start_service() {
	local name="$1" directory command port working log
	directory="$(wt_service_value "$name" directory)"
	command="$(wt_service_value "$name" command)"
	port="$(service_port "$name")"
	working="$REPO_ROOT/$directory"
	log="$SERVICES_DIR/$name.log"

	if [ ! -d "$working" ]; then
		wt_die "service '$name' declares directory '$directory', which does not exist here"
	fi
	# Job control, deliberately: it makes this launch the leader of its OWN
	# process group, so the recorded pid names a whole service tree that can be
	# stopped as one. Without it the job joins this script's group, where the only
	# safe target is the single recorded pid - and that pid is whichever shell
	# happened to survive, not necessarily the process holding the port.
	set -m
	(
		cd "$working" || exit 1
		export PORT="$port"
		# The contract records a command line, so a shell has to interpret it.
		exec /bin/sh -c "$command"
	) >"$log" 2>&1 &
	printf '%s\n' "$!" >"$SERVICES_DIR/$name.pid"
	set +m
	wt_log "started $name (pid $(cat "$SERVICES_DIR/$name.pid")) on port $port"
}

start_services() {
	local order name position=0 pid delay

	order="$(service_order)"
	if [ -z "$order" ]; then
		wt_log "no services are declared"
		return 0
	fi
	mkdir -p "$SERVICES_DIR"
	export_service_ports

	for name in $order; do
		if service_running "$name"; then
			wt_log "$name is already running"
		else
			start_service "$name"
		fi
		STARTED="$STARTED $name"
		pid="$(recorded_pid "$name")"
		if [ "$STARTUP_MODE" = "staggered" ]; then
			# A diagnostic mode on purpose: fixed delays instead of readiness gates
			# isolate "the stack starts too fast for itself" from "a service is
			# unhealthy". It is never the default.
			delay=$((STAGGER_SECONDS * position))
			if [ "$delay" -gt 0 ]; then
				wt_log "staggered mode: waiting ${delay}s before verifying $name"
				sleep "$delay"
			fi
			if ! kill -0 "$pid" 2>/dev/null; then
				fail_service "$name" "exited during its staggered delay"
			fi
		else
			wait_for_service "$name" "$(service_port "$name")" \
				"$(wt_service_value "$name" health_path)" \
				"$(wt_service_value "$name" health_expectation)" \
				"$SERVICE_TIMEOUT" "$pid"
		fi
		position=$((position + 1))
	done
	wt_log "all $position declared services are running"
}

# Terminate politely, then insist. The pid file is removed either way so a later
# run never inherits a stale identity.
stop_services() {
	local name pid stopped=0
	[ -d "$SERVICES_DIR" ] || return 0
	for name in $SERVICES; do
		pid="$(recorded_pid "$name")" || continue
		case "$pid" in
			'' | *[!0-9]*) rm -f "$SERVICES_DIR/$name.pid" && continue ;;
		esac
		if service_running "$name"; then
			signal_service_tree "$pid" TERM
			sleep 1
			if service_running "$name"; then
				signal_service_tree "$pid" KILL
			fi
			stopped=$((stopped + 1))
		fi
		rm -f "$SERVICES_DIR/$name.pid"
	done
	[ "$stopped" -eq 0 ] || wt_log "stopped $stopped services"
	return 0
}

report_status() {
	local name
	if [ -z "$SERVICES" ]; then
		wt_log "no services are declared"
		return 0
	fi
	for name in $SERVICES; do
		if service_running "$name"; then
			printf '%s\trunning\t%s\n' "$name" "$(service_port "$name")"
		else
			printf '%s\tstopped\t%s\n' "$name" "$(service_port "$name")"
		fi
	done
}

main() {
	case "$MODE" in
		order) service_order ;;
		start) start_services ;;
		stop) stop_services ;;
		status) report_status ;;
	esac
}

main
