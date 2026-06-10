#!/usr/bin/env bash
# git-credential-org-router — hand git the right GitHub token based on the repo's org.
#
# Wired up globally by .devcontainer/on-create/setup-git-credentials.sh:
#   git config --global credential.https://github.com.useHttpPath true   # so $path carries the org
#   git config --global credential.https://github.com.helper "!<this script>"
#
# Resolution order for an org — NO org names or client info live in this file / in git:
#   1. Map:        a `<org>=<ENV_VAR>` line in the host map file (for tokens whose env
#                  var name doesn't follow the convention). Host-managed, not in git.
#   2. Convention: <ORG>_GITHUB_TOKEN, where <ORG> is the org upper-cased with every
#                  non-alphanumeric char -> '_' (e.g. "my-org" -> MY_ORG_GITHUB_TOKEN).
#   3. Fallback:   GITHUB_TOKEN.
# The token VALUE is read from the environment at push time and never stored on disk.
#
# Map file (on the host mount, not in git): ~/.config/devcontainer/github-token-map
#   in-container: /run/devcontainer-config/github-token-map  (override with GITHUB_TOKEN_MAP)
#   format: one `org=ENV_VAR_NAME` per line; # comments and blank lines ignored.

MAP_FILE="${GITHUB_TOKEN_MAP:-/run/devcontainer-config/github-token-map}"

[ "${1:-}" = "get" ] || exit 0

host=""
path=""
while IFS='=' read -r key value; do
	case "$key" in
		host) host="$value" ;;
		path) path="$value" ;;
	esac
done

[ "$host" = "github.com" ] || exit 0
org="${path%%/*}"
[ -n "$org" ] || exit 0

varname=""
# 1. explicit map (host-managed, not in git)
if [ -f "$MAP_FILE" ]; then
	varname="$(sed -E 's/[[:space:]]*#.*$//' "$MAP_FILE" \
		| grep -E "^[[:space:]]*${org}[[:space:]]*=" \
		| head -1 \
		| sed -E "s/^[[:space:]]*${org}[[:space:]]*=[[:space:]]*//; s/[[:space:]]*\$//")"
fi
# 2. naming convention
if [ -z "$varname" ]; then
	conv="$(printf '%s' "$org" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
	conv="${conv%_}"
	varname="${conv}_GITHUB_TOKEN"
fi

token="${!varname:-}"
# 3. fallback
[ -n "$token" ] || token="${GITHUB_TOKEN:-}"

[ -n "$token" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
