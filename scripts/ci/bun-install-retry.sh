#!/usr/bin/env bash
# Install workspace dependencies with a hard PER-ATTEMPT bound and a fixed
# attempt cap.
#
# Why this exists: `bun install` intermittently HANGS on a CI runner. A hang is
# not a failure - it silently consumes the whole job's timeout-minutes budget and
# then gets the job cancelled, which fails the aggregate gate with a result that
# says nothing about the code under test. A step-level timeout-minutes does not
# solve it either: that kills the job on a hang without ever retrying.
#
# So each attempt is capped independently, a hung attempt is killed quickly, and
# a fresh install process is started. The bound is deterministic on two axes -
# per-attempt seconds AND attempt count - so the worst case (default 3 x 180s +
# 2 x 10s backoff, ~9.5 min) always stays under the calling job's outer budget.
# This is NOT a generic "retry any command" wrapper: it wraps exactly one
# operation, and the surrounding job keeps failing closed on everything else.
#
# Lock semantics are preserved exactly as the workflow used to spell them out:
#   bun.lock present -> `bun install --frozen-lockfile`, never mutating the lock
#   bun.lock absent  -> `bun install`, then the lock must exist afterwards
# The second branch is how a freshly rendered project creates its first lock; a
# frozen install there fails by design, and an install that leaves no lock behind
# is a failure this script refuses to report as success.
#
# Tunables (env): BUN_INSTALL_ATTEMPTS (default 3), BUN_INSTALL_TIMEOUT_SEC
# (per-attempt seconds, default 180), BUN_INSTALL_RETRY_SLEEP_SEC (default 10).
#
# Invoke as `bash scripts/ci/bun-install-retry.sh` from any step that would
# otherwise run a bare `bun install` (checkout and the Bun toolchain first).
#
# `set -e` is deliberately absent: the install's exit code is captured directly
# into a variable, because `if bun install; then` reports 0 for the whole
# compound when the condition fails with no else branch, which would mask the
# very 124 (killed-on-hang) code this script exists to report.
set -uo pipefail

attempts="${BUN_INSTALL_ATTEMPTS:-3}"
per_attempt="${BUN_INSTALL_TIMEOUT_SEC:-180}"
retry_sleep="${BUN_INSTALL_RETRY_SLEEP_SEC:-10}"

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

if [ -f bun.lock ]; then
	install_args=(install --frozen-lockfile)
	first_lock=false
else
	install_args=(install)
	first_lock=true
fi

rc=0
for attempt in $(seq 1 "$attempts"); do
	echo "::group::bun ${install_args[*]} (attempt ${attempt}/${attempts}, per-attempt bound ${per_attempt}s)"
	run_bounded bun "${install_args[@]}"
	rc=$?
	echo "::endgroup::"
	if [ "$rc" -eq 0 ]; then
		if [ "$first_lock" = true ] && [ ! -f bun.lock ]; then
			echo "::error::bun install reported success without writing bun.lock" >&2
			exit 1
		fi
		echo "bun install succeeded on attempt ${attempt}/${attempts}"
		exit 0
	fi
	if [ "$rc" -eq 124 ]; then
		echo "::warning::bun install attempt ${attempt} was killed after ${per_attempt}s (exit 124, hang) - retrying"
	else
		echo "::warning::bun install attempt ${attempt} failed (exit ${rc}) - retrying"
	fi
	if [ "$attempt" -lt "$attempts" ]; then
		sleep "$retry_sleep"
	fi
done

echo "::error::bun install failed after ${attempts} attempts (last exit ${rc}); see the warnings above" >&2
exit "$rc"
