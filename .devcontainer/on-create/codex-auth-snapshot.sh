#!/usr/bin/env bash
# Codex auth persistence: seed-on-create + capture-back of ONLY ~/.codex/auth.json
# across the project's worktrees, via the read-write host snapshot bound at
# ~/.config/devcontainer/codex-auth (see .devcontainer/AUTH-PERSISTENCE.md —
# single-file seed-on-create variant of the host-bind mechanism). ~/.codex's live
# SQLite/state stays on its per-`${devcontainerId}` volume and is NEVER shared.
#
# Safe to run repeatedly and from any trigger; it is invoked from two places:
#   • container create   — .devcontainer/on-create/setup-codex.sh
#   • every session start — SessionStart hook in .claude/settings.json, so a fresh
#     `codex login` propagates to the snapshot without waiting for a full recreate.
#
# Always exits 0: a SessionStart hook must never fail a session, and a missing
# snapshot bind (bare `docker run`, or Claude Code running outside this
# devcontainer) is a deliberate silent no-op.
set -u

# Honor the always-exit-0 contract even with a stripped environment: without HOME
# there is no home dir to seed/capture, so no-op cleanly rather than tripping set -u.
[ -n "${HOME:-}" ] || exit 0

snap_dir="${HOME}/.config/devcontainer/codex-auth"
snap="${snap_dir}/auth.json"
local_auth="${HOME}/.codex/auth.json"

# The snapshot dir is the bind-mount target. Absent → nothing to seed/capture.
[ -d "$snap_dir" ] || exit 0

# A valid auth.json is non-empty JSON. Prefer jq, then python3; fall back to a
# structural check so a truncated/unrelated file is never treated as a credential
# and allowed to overwrite the shared snapshot.
is_valid_json() {
    [ -s "$1" ] || return 1
    if command -v jq >/dev/null 2>&1; then
        jq -e . "$1" >/dev/null 2>&1
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" >/dev/null 2>&1
    else
        # Last resort (neither jq nor python3 — effectively never in this image):
        # require a leading '{' AND a trailing '}'. Read via command substitution,
        # which strips trailing newlines, so a valid file ending in "\n" still
        # passes while a truncated write (no closing brace) is rejected.
        local content
        content="$(cat "$1" 2>/dev/null)"
        [ "${content:0:1}" = "{" ] && [ "${content: -1}" = "}" ]
    fi
}

mkdir -p "${HOME}/.codex" 2>/dev/null || true

if [ ! -e "$local_auth" ]; then
    # Seed: no local credential yet → copy the snapshot in iff it is valid JSON.
    # `cp -pn`: -p preserves the snapshot's mtime so the seeded file is NOT
    # spuriously "newer" than the snapshot (else the capture path would re-copy
    # identical content, bump the snapshot mtime, and strand a concurrent
    # worktree's newer credential); -n refuses to clobber should a `codex login`
    # race a file into place between the test above and the copy. Enforce 0600 on
    # BOTH the local copy and the snapshot itself (a snapshot created out-of-band
    # as 0644 would otherwise leave the refresh token host-readable).
    if [ -s "$snap" ] && is_valid_json "$snap"; then
        chmod 600 "$snap" 2>/dev/null || true
        if cp -pn "$snap" "$local_auth" && chmod 600 "$local_auth"; then
            echo "   🔑 Seeded ~/.codex/auth.json from project snapshot"
        else
            echo "⚠️  Could not seed ~/.codex/auth.json from snapshot"
        fi
    fi
elif [ -f "$local_auth" ]; then
    # Capture-back: propagate a NEWER, DIFFERENT, valid local credential to the
    # snapshot (single small file, last-writer-wins). The content check (`cmp -s`)
    # is essential: capturing content identical to the snapshot would bump its
    # mtime for nothing and strand a concurrent worktree's newer credential.
    # A snapshot-absent case bootstraps directly. Written via a same-dir temp +
    # atomic rename so a reader never sees a partial file. (Guarded by -f so a
    # non-regular path — FIFO/dir/socket — is skipped, never opened/blocked-on.)
    if is_valid_json "$local_auth" \
        && { [ ! -f "$snap" ] \
             || { [ "$local_auth" -nt "$snap" ] && ! cmp -s "$local_auth" "$snap"; }; }; then
        if tmp="$(mktemp "${snap}.XXXXXX" 2>/dev/null)"; then
            if cp "$local_auth" "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$snap"; then
                echo "   💾 Captured ~/.codex/auth.json → project snapshot"
            else
                rm -f "$tmp"
                echo "⚠️  Could not capture ~/.codex/auth.json to snapshot"
            fi
        else
            echo "⚠️  Could not write codex auth snapshot (dir not writable?); skipping capture"
        fi
    fi
fi

exit 0
