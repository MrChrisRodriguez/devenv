#!/usr/bin/env bash
# Shared, side-effect-free helpers for the Codex Cloud scripts.
#
# This file only defines functions and three path anchors. It never installs,
# writes, or mutates anything, so bootstrap, doctor, exec, and the hermetic
# selftest can all source it without ordering constraints. Keep it compatible
# with bash 3.2: cloud hosts and developer machines both run these scripts.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CLOUD_DIR/../.." && pwd)"
CLOUD_CONTRACT="$CLOUD_DIR/contract.toml"

# Read one flat scalar from the contract. Quoted strings and bare integers are
# both accepted so the contract stays a single sed-readable file that Bun's TOML
# parser still validates.
cloud_contract_value() {
	local key="$1"
	local value
	value="$(sed -nE "s/^${key}[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*\$/\\1/p; s/^${key}[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*\$/\\1/p" "$CLOUD_CONTRACT" | head -n 1)"
	if [ -z "$value" ]; then
		echo "Codex cloud: contract key '${key}' is missing" >&2
		return 1
	fi
	printf '%s\n' "$value"
}

# Read one flat array from the contract as space-separated words.
cloud_contract_list() {
	local key="$1"
	local line
	line="$(sed -nE "s/^${key}[[:space:]]*=[[:space:]]*\\[(.*)\\][[:space:]]*\$/\\1/p" "$CLOUD_CONTRACT" | head -n 1)"
	if [ -z "$line" ]; then
		echo "Codex cloud: contract key '${key}' is missing" >&2
		return 1
	fi
	printf '%s\n' "$line" | tr -d '"' | tr ',' ' ' | tr -s ' '
}

cloud_tool_version() {
	cloud_contract_value "tool_$1"
}

# Expand "${HOME}" and a leading "~/" without eval, so a contract value can
# never execute a substitution.
cloud_expand_home() {
	local value="$1"
	value="${value//\$\{HOME\}/$HOME}"
	# The quoted tilde arm is deliberate: it MATCHES a literal leading "~/" in
	# contract text precisely so this function can expand it.
	# shellcheck disable=SC2088
	case "$value" in
		"~/"*) value="$HOME/${value#\~/}" ;;
	esac
	printf '%s\n' "$value"
}

cloud_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | awk '{ print $1 }'
	else
		echo "Codex cloud: no sha-256 utility is available" >&2
		return 1
	fi
}

# Cloud setup is prepared from a checked-out commit. Fingerprint the committed
# content when it is available so legitimate agent edits to bun.lock or
# package.json do not make the pre-command doctor reject the rest of that same
# task.
cloud_contract_file_content() {
	local relative_path="$1"
	if git -C "$REPO_ROOT" cat-file -e "HEAD:${relative_path}" 2>/dev/null; then
		git -C "$REPO_ROOT" show "HEAD:${relative_path}"
		return 0
	fi
	cat "$REPO_ROOT/$relative_path"
}

cloud_contract_file_exists() {
	local relative_path="$1"
	git -C "$REPO_ROOT" cat-file -e "HEAD:${relative_path}" 2>/dev/null ||
		[ -f "$REPO_ROOT/$relative_path" ]
}

# One hash over the profile plus every declared fingerprint input, in the order
# the contract declares them. Bootstrap writes it, doctor re-derives it.
cloud_contract_fingerprint() {
	local profile="${1:-}"
	if [ -z "$profile" ]; then
		profile="$(cloud_contract_value default_profile)"
	fi
	local relative_path
	# Fail closed before hashing: a pipeline can hide a missing input, and a
	# fingerprint over a partial stream would silently look healthy.
	for relative_path in $(cloud_contract_list fingerprint_inputs); do
		if ! cloud_contract_file_exists "$relative_path"; then
			echo "Codex cloud: fingerprint input '${relative_path}' is missing" >&2
			return 1
		fi
	done
	{
		printf 'profile\0%s\0' "$profile"
		for relative_path in $(cloud_contract_list fingerprint_inputs); do
			printf 'file\0%s\0' "$relative_path"
			cloud_contract_file_content "$relative_path"
			printf '\0'
		done
	} | cloud_sha256
}

cloud_marker_file() {
	local profile="${1:-}"
	if [ -z "$profile" ]; then
		profile="$(cloud_contract_value default_profile)"
	fi
	local directory
	directory="$(cloud_expand_home "$(cloud_contract_value fingerprint_marker_directory)")"
	printf '%s/%s.fingerprint\n' "$directory" "$profile"
}

cloud_actual_tool_version() {
	local tool="$1"
	command -v "$tool" >/dev/null 2>&1 || return 0
	"$tool" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true
}

cloud_persisted_environment_file() {
	cloud_expand_home "$(cloud_contract_value persisted_environment)"
}

cloud_persisted_secrets_file() {
	cloud_expand_home "$(cloud_contract_value persisted_secrets_environment)"
}

# Non-interactive shells never load ~/.bashrc, so every entry point sources the
# persisted marker itself before deciding whether this is a cloud task.
cloud_source_persisted_environment() {
	local file=""
	file="$(cloud_persisted_environment_file)" || return 0
	if [ -r "$file" ]; then
		# The persisted environment file is generated at run time, so there is
		# no constant path for shellcheck to follow.
		# shellcheck disable=SC1090
		. "$file"
	fi
	return 0
}

cloud_is_verified() {
	[ "${CODEX_CLOUD:-}" = "true" ]
}
