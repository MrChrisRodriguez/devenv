#!/usr/bin/env bash
# Load host-mounted devcontainer secrets into BOTH the current process env and
# /etc/environment. Runs two ways:
#   • SOURCED by on-create.sh      → the exported vars reach the create-time tool
#                                     installers (graphify, gemini, …) that need
#                                     API keys present during setup.
#   • EXECUTED by postStartCommand → re-syncs /etc/environment on every start, so
#                                     keys added to the host secrets file AFTER
#                                     the container was created still reach
#                                     non-shell readers (VS Code/Cursor extension
#                                     host, MCP subprocesses) without a rebuild.
#
# The /etc/environment write is idempotent: it replaces a marker-delimited block
# instead of appending, so repeated runs never accumulate duplicate lines.
#
# This is SOURCED into on-create.sh's `set -e` shell, so it uses conditionals and
# avoids top-level `exit`/`return` (which would respectively kill or error the
# parent). Per-project values override common ones (same key, appended later).

_sec_begin="# >>> devcontainer-secrets >>>"
_sec_end="# <<< devcontainer-secrets <<<"

_sec_common="/run/devcontainer-config/secrets"
_sec_project=""
if [ -n "${DEVCONTAINER_PROJECT:-}" ]; then
    _sec_project="/run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT}"
fi

# 1. Export into the current process. Lets a sourcing parent (on-create.sh) hand
#    the values to the installers it runs next; a harmless no-op standalone.
for _sec_file in "$_sec_common" "$_sec_project"; do
    if [ -n "$_sec_file" ] && [ -f "$_sec_file" ]; then
        echo "🔐 Loading secrets from $_sec_file..."
        set -a
        # shellcheck source=/dev/null
        source "$_sec_file"
        set +a
    fi
done

# 2. Rewrite the managed block in /etc/environment with bare KEY=value lines
#    (comments, blanks, and a leading `export ` stripped).
_sec_emit() {
    grep -v '^[[:space:]]*#' "$1" 2>/dev/null \
        | grep -v '^[[:space:]]*$' \
        | sed 's/^[[:space:]]*export[[:space:]]*//'
}

[ -f /etc/environment ] || sudo touch /etc/environment
_sec_tmp="$(mktemp)"
# Drop any previous managed block, keep everything else (no-op on first run).
sed "/^${_sec_begin}$/,/^${_sec_end}$/d" /etc/environment > "$_sec_tmp"
{
    echo "$_sec_begin"
    [ -f "$_sec_common" ] && _sec_emit "$_sec_common"
    [ -n "$_sec_project" ] && [ -f "$_sec_project" ] && _sec_emit "$_sec_project"
    echo "$_sec_end"
} >> "$_sec_tmp"
sudo cp "$_sec_tmp" /etc/environment
rm -f "$_sec_tmp"
echo "✅ Secrets synced to /etc/environment"
