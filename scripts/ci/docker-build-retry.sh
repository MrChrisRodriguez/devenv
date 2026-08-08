#!/usr/bin/env bash
# Build a Docker image with a hard PER-ATTEMPT bound and a fixed attempt cap.
#
# Why this exists: the two required lanes that build images pull real registries
# — the devcontainer base image, Proto payloads, apt archives — and a registry
# blip fails or stalls a required job with a result that says nothing about the
# code under review. A stalled pull is the worse half: it silently consumes the
# job's whole timeout-minutes budget and then reports a cancellation. So each
# attempt is bounded independently, a hung attempt is killed quickly, and a
# fresh build is started; layer cache makes a retried attempt cheap.
#
# The bound is deterministic on two axes - per-attempt seconds AND attempt
# count - so the worst case (default 3 x 480s + 2 x 10s backoff, ~24.5 min)
# always stays under the calling job's outer budget. This is NOT a generic
# "retry any command" wrapper: it wraps exactly one operation, `docker build`,
# and the surrounding job keeps failing closed on everything else.
#
# Tunables (env): DOCKER_BUILD_ATTEMPTS (default 3), DOCKER_BUILD_TIMEOUT_SEC
# (per-attempt seconds, default 480), DOCKER_BUILD_RETRY_SLEEP_SEC (default 10).
#
# Invoke as `bash scripts/ci/docker-build-retry.sh <docker build arguments>`
# from any step that would otherwise run a bare `docker build`.
#
# `set -e` is deliberately absent: the build's exit code is captured directly
# into a variable, because `if docker build; then` reports 0 for the whole
# compound when the condition fails with no else branch, which would mask the
# very 124 (killed-on-hang) code this script exists to report.
set -uo pipefail

attempts="${DOCKER_BUILD_ATTEMPTS:-3}"
per_attempt="${DOCKER_BUILD_TIMEOUT_SEC:-480}"
retry_sleep="${DOCKER_BUILD_RETRY_SLEEP_SEC:-10}"

# coreutils `timeout` is present on every Linux CI image and absent from a stock
# macOS host, where this script still has to be runnable and testable. Prefer the
# real thing; fall back to a watchdog with the same contract, including the 124
# exit code that means "killed because it hung".
timeout_bin="$(command -v timeout || command -v gtimeout || true)"

run_bounded() {
	if [ -n "$timeout_bin" ]; then
		"$timeout_bin" "$per_attempt" "$@"
		return $?
	fi
	"$@" &
	watched=$!
	waited=0
	while kill -0 "$watched" 2>/dev/null; do
		if [ "$waited" -ge "$per_attempt" ]; then
			kill -TERM "$watched" 2>/dev/null || true
			sleep 1
			kill -KILL "$watched" 2>/dev/null || true
			wait "$watched" 2>/dev/null || true
			return 124
		fi
		sleep 1
		waited=$((waited + 1))
	done
	wait "$watched"
	return $?
}

rc=0
for attempt in $(seq 1 "$attempts"); do
	echo "::group::docker build (attempt ${attempt}/${attempts}, per-attempt bound ${per_attempt}s)"
	run_bounded docker build "$@"
	rc=$?
	echo "::endgroup::"
	if [ "$rc" -eq 0 ]; then
		echo "docker build succeeded on attempt ${attempt}/${attempts}"
		exit 0
	fi
	if [ "$rc" -eq 124 ]; then
		echo "::warning::docker build attempt ${attempt} was killed after ${per_attempt}s (exit 124, hang) - retrying"
	else
		echo "::warning::docker build attempt ${attempt} failed (exit ${rc}) - retrying"
	fi
	if [ "$attempt" -lt "$attempts" ]; then
		sleep "$retry_sleep"
	fi
done

echo "::error::docker build failed after ${attempts} attempts (last exit ${rc}); see the warnings above" >&2
exit "$rc"
