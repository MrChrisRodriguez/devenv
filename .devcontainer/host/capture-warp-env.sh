#!/usr/bin/env bash
# Runs on the HOST (not in the container) via devcontainer.json "initializeCommand",
# on every `devpod up` including rebuilds. Captures Warp's per-terminal signal vars
# so Claude Code can detect Warp and use ACP structured output inside the container.
#
# Why this exists: Warp injects TERM_PROGRAM / WARP_* only into the terminal sessions
# it spawns — they are NOT persistent global host vars. Forwarding them via remoteEnv
# `${localEnv:...}` failed because that is re-resolved (and blanks out) on every rebuild,
# and DevPod is often launched from a GUI that never had the vars. This script instead
# PERSISTS the values to ~/.config/devcontainer/warp-env, overwriting a key only when a
# fresh non-empty value is available. So one `devpod up .` from a Warp terminal seeds the
# file, later rebuilds refresh it when run from Warp, and GUI-launched rebuilds keep the
# last good value instead of clobbering it. on-create.sh loads this file into
# /etc/environment so every container process inherits it.
set -eu

CONFIG_DIR="${HOME}/.config/devcontainer"
ENV_FILE="${CONFIG_DIR}/warp-env"
KEYS="TERM_PROGRAM WARP_CLIENT_VERSION WARP_CLI_AGENT_PROTOCOL_VERSION"

mkdir -p "$CONFIG_DIR"

# Read the previously-saved value for a key from the existing file (empty if absent).
prev_value() {
    [ -f "$ENV_FILE" ] || return 0
    grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-
}

tmp="${ENV_FILE}.tmp.$$"
: > "$tmp"
captured=0
for key in $KEYS; do
    # Current host env value (may be unset under `set -u`, hence the default).
    eval "cur=\${$key:-}"
    prev="$(prev_value "$key")"
    # Prefer a fresh non-empty value; otherwise keep what we had.
    val="${cur:-$prev}"
    if [ -n "$val" ]; then
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        captured=$((captured + 1))
    fi
done

if [ "$captured" -gt 0 ]; then
    mv "$tmp" "$ENV_FILE"
    echo "⚡ Captured Warp env ($captured var(s)) → $ENV_FILE"
else
    rm -f "$tmp"
    echo "ℹ️  No Warp env vars found on host (not launched from Warp?); leaving $ENV_FILE untouched"
fi
