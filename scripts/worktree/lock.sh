#!/usr/bin/env bash
# Portable advisory lock for the isolated worktree runtime.
#
# macOS ships no flock(1), so this provides one primitive with two backends and
# identical semantics: flock(1) when it exists, otherwise a mkdir lock whose
# directory records the holder's pid and acquisition epoch. Acquisition is
# always bounded, a lock held by a live process is never stolen, and a lock
# abandoned by a dead process (or older than the staleness threshold) is
# reclaimed instead of deadlocking every later caller.
#
# Sourced, never executed. One lock is held at a time per shell; callers pair
# every acquire with a release on every exit path.
#
# Usage:
#   portable_lock_acquire <path> [timeout_seconds]
#   portable_lock_release

# Every consumer already fails closed; declaring it here too keeps the whole
# runtime uniform and lets the guard hold one rule for every declared script.
set -euo pipefail

PORTABLE_LOCK_PATH=""
PORTABLE_LOCK_MODE=""
PORTABLE_LOCK_STALE_SECONDS="${PORTABLE_LOCK_STALE_SECONDS:-${WORKTREE_LOCK_STALE_SECONDS:-7200}}"

portable_lock_epoch() {
	date +%s
}

portable_lock_process_alive() {
	local pid="$1"
	case "$pid" in
		'' | *[!0-9]*) return 1 ;;
	esac
	kill -0 "$pid" 2>/dev/null
}

# Modification time in epoch seconds: GNU stat first, then BSD stat. Kept local
# rather than borrowed from lib.sh so this file stays sourceable on its own.
portable_lock_directory_epoch() {
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

# A lock directory is reclaimable only when its recorded holder is provably gone,
# or when the lock is older than the staleness threshold. Anything unreadable or
# malformed is stale-by-AGE, never free: the holder creates the directory first
# and records itself an instant later, so treating that window as free would let
# a second caller steal a lock that is very much alive - and two holders of the
# registry lock is exactly one lost read-modify-write. When the owner record is
# missing the directory's own modification time stands in for it.
portable_lock_reclaim_if_stale() {
	local directory="$1" owner="$1/owner" pid="" started="" now age

	if [ -r "$owner" ]; then
		read -r pid started <"$owner" || true
	fi
	case "$pid" in
		'' | *[!0-9]*) pid="" ;;
	esac
	case "$started" in
		'' | *[!0-9]*) started="" ;;
	esac
	# A complete record naming a process that no longer exists is the one case
	# that reclaims immediately: that is what recording the pid is for.
	if [ -n "$pid" ] && [ -n "$started" ] && ! portable_lock_process_alive "$pid"; then
		rm -rf "$directory" 2>/dev/null || return 1
		return 0
	fi
	if [ -z "$started" ]; then
		started="$(portable_lock_directory_epoch "$directory")" || return 1
	fi
	now="$(portable_lock_epoch)"
	age=$((now - started))
	[ "$age" -ge "$PORTABLE_LOCK_STALE_SECONDS" ] || return 1
	rm -rf "$directory" 2>/dev/null || return 1
	return 0
}

portable_lock_acquire() {
	local path="$1" timeout="${2:-60}" directory waited=0

	case "$timeout" in
		'' | *[!0-9]*)
			printf 'Worktree lock: timeout %s is not a whole number of seconds\n' \
				"$timeout" >&2
			return 1
			;;
	esac
	if [ -n "$PORTABLE_LOCK_PATH" ]; then
		printf 'Worktree lock: %s is already held by this shell\n' \
			"$PORTABLE_LOCK_PATH" >&2
		return 1
	fi
	mkdir -p "$(dirname "$path")"

	if command -v flock >/dev/null 2>&1; then
		# Fixed descriptor 9 rather than the bash 4 {fd} form: macOS still ships
		# bash 3.2 and these scripts run there.
		exec 9>"$path"
		if ! flock -w "$timeout" 9; then
			exec 9>&-
			printf 'Worktree lock: timed out after %ss waiting for %s\n' \
				"$timeout" "$path" >&2
			return 1
		fi
		PORTABLE_LOCK_PATH="$path"
		PORTABLE_LOCK_MODE="flock"
		return 0
	fi

	# A distinct suffix so a checkout shared between a flock-less macOS host and a
	# flock-capable Linux container never collides a lock file with a lock dir.
	directory="$path.d"
	while :; do
		if mkdir "$directory" 2>/dev/null; then
			printf '%s %s\n' "$$" "$(portable_lock_epoch)" >"$directory/owner"
			PORTABLE_LOCK_PATH="$directory"
			PORTABLE_LOCK_MODE="mkdir"
			return 0
		fi
		portable_lock_reclaim_if_stale "$directory" && continue
		if [ "$waited" -ge "$timeout" ]; then
			printf 'Worktree lock: timed out after %ss waiting for %s\n' \
				"$timeout" "$directory" >&2
			return 1
		fi
		sleep 1
		waited=$((waited + 1))
	done
}

portable_lock_release() {
	[ -n "$PORTABLE_LOCK_PATH" ] || return 0
	if [ "$PORTABLE_LOCK_MODE" = "flock" ]; then
		flock -u 9 2>/dev/null || true
		exec 9>&-
	else
		rm -rf "$PORTABLE_LOCK_PATH" 2>/dev/null || true
	fi
	PORTABLE_LOCK_PATH=""
	PORTABLE_LOCK_MODE=""
	return 0
}
