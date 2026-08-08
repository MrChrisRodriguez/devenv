#!/usr/bin/env bash
# Fail-closed, read-only verification of a prepared Codex Cloud environment.
#
# This file installs, downloads, and repairs nothing. It only reports whether
# the environment in front of it still matches the committed contract, so the
# gate that is supposed to detect drift can never paper over it. Every refusal
# names the maintenance command that fixes it.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$CLOUD_DIR/lib.sh"

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "${1:-}" != "--quiet" ]; }; then
	echo "Usage: bash .codex/cloud/doctor.sh [--quiet]" >&2
	exit 2
fi
quiet=false
if [ "${1:-}" = "--quiet" ]; then
	quiet=true
fi

cloud_source_persisted_environment
if ! cloud_is_verified; then
	echo "Codex cloud doctor: CODEX_CLOUD=true is missing; run bash .codex/cloud/bootstrap.sh" >&2
	exit 1
fi

profile="${CODEX_CLOUD_PROFILE:-}"
if [ -z "$profile" ]; then
	profile="$(cloud_contract_value default_profile)"
fi
case "$profile" in
	core) ;;
	# capability:start playwright
	browser) ;;
	# capability:end playwright
	*)
		echo "Codex cloud doctor: unsupported CODEX_CLOUD_PROFILE '${profile}'" >&2
		exit 1
		;;
esac

refuse() {
	echo "Codex cloud doctor: $*" >&2
	echo "Run: bash .codex/cloud/bootstrap.sh ${profile}" >&2
	exit 1
}

marker_file="$(cloud_marker_file "$profile")"
expected_fingerprint="$(cloud_contract_fingerprint "$profile")"
actual_fingerprint="$(cat "$marker_file" 2>/dev/null || true)"
if [ "$actual_fingerprint" != "$expected_fingerprint" ]; then
	refuse "environment fingerprint is missing or stale"
fi

for tool in $(cloud_contract_list required_tools); do
	expected_version="$(cloud_tool_version "$tool")"
	actual_version="$(cloud_actual_tool_version "$tool")"
	if [ "$actual_version" != "$expected_version" ]; then
		refuse "${tool} version mismatch (expected ${expected_version}, got ${actual_version:-missing})"
	fi
done

# capability:start graphify
graphify_binary="$(cloud_contract_value graphify_binary)"
graphify_expected="$(cloud_contract_value graphify_version)"
graphify_actual="$(cloud_actual_tool_version "$graphify_binary")"
if [ "$graphify_actual" != "$graphify_expected" ]; then
	refuse "${graphify_binary} version mismatch (expected ${graphify_expected}, got ${graphify_actual:-missing})"
fi
# capability:end graphify

if [ ! -d "$REPO_ROOT/node_modules/.bin" ]; then
	refuse "frozen dependencies are missing"
fi

# capability:start playwright
if [ "$profile" = "$(cloud_contract_value browser_profile)" ]; then
	browser_variable="$(cloud_contract_value browser_environment_variable)"
	eval "browser_root=\"\${${browser_variable}:-}\""
	if [ -z "$browser_root" ]; then
		refuse "${browser_variable} is not set for the browser profile"
	fi
	browser_expected="$(cloud_contract_value browser_playwright_version)"
	browser_marker="${browser_root}/$(cloud_contract_value browser_marker_basename)"
	if [ "$(cat "$browser_marker" 2>/dev/null || true)" != "$browser_expected" ]; then
		refuse "browser payload marker is missing or differs from ${browser_expected}"
	fi
	# The unchanged repository preflight is the Stage 3 acceptance command.
	# Executing the contract value's output is the point: the contract stores a
	# command line, and word-splitting it into a command is how it runs.
	# shellcheck disable=SC2046,SC2091
	if ! (cd "$REPO_ROOT" && $(cloud_contract_value browser_required_command)); then
		refuse "repository-pinned Chromium cannot launch for the browser profile"
	fi
fi
# capability:end playwright

if [ "$quiet" != "true" ]; then
	echo "Codex cloud doctor: healthy (${profile}, fingerprint ${expected_fingerprint:0:12})"
	for tool in $(cloud_contract_list required_tools); do
		echo "  ${tool}: $(cloud_actual_tool_version "$tool")"
	done
	# capability:start graphify
	echo "  ${graphify_binary}: ${graphify_actual}"
	# capability:end graphify
fi
