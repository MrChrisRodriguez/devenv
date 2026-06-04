#!/usr/bin/env bash
# git-credential-org-router — hand git the right GitHub token based on the repo's org.
#
# Wired up globally by .devcontainer/on-create/setup-git-credentials.sh:
#   git config --global credential.https://github.com.useHttpPath true   # so $path carries the org
#   git config --global credential.https://github.com.helper "!<this script>"
#
# Git calls this with the operation ("get"/"store"/"erase") as $1 and the request
# fields (protocol/host/path/...) as key=value lines on stdin. We answer only "get",
# read the org from the first path segment, and emit the matching token from the env.
# Tokens are never stored on disk — they're read fresh from the environment each call.
#
# Add an org by adding a case below + the matching token to your devcontainer secrets.

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

case "$org" in
	Blueprint-Talent) token="${BTG_GITHUB_TOKEN:-}" ;;
	confiador) token="${CONFIADOR_GITHUB_TOKEN:-}" ;;
	*) token="${GITHUB_TOKEN:-}" ;;
esac

[ -n "$token" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
