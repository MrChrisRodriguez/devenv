#!/usr/bin/env bash
# Shared, side-effect-free helpers for the isolated worktree runtime.
#
# This file defines functions and three path anchors and nothing else. It never
# installs, writes, allocates, or starts anything, so env, ensure, exec,
# manifest, the lifecycle scripts, and the hermetic selftest can all source it
# without ordering constraints. Keep it compatible with bash 3.2: macOS hosts
# still ship that version and the host half of this runtime runs there.
#
# Every value the runtime needs comes from contract.toml, which is generated
# from one authority. Nothing here hardcodes a port, a volume prefix, a
# persistence path, or a project identity.

set -euo pipefail

WORKTREE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$WORKTREE_DIR/../.." && pwd)"
WORKTREE_CONTRACT="$WORKTREE_DIR/contract.toml"

# Each entry point sets its own verb ("Worktree environment", "Worktree ensure",
# ...) so a diagnostic names the stage that produced it.
WORKTREE_LABEL="${WORKTREE_LABEL:-Worktree}"

wt_log() {
	printf '%s: %s\n' "$WORKTREE_LABEL" "$*" >&2
}

wt_warn() {
	printf '%s: warning: %s\n' "$WORKTREE_LABEL" "$*" >&2
}

# wt_die <message> [exit_status]
wt_die() {
	printf '%s: %s\n' "$WORKTREE_LABEL" "$1" >&2
	exit "${2:-1}"
}

# Read one flat scalar from the contract. Quoted strings, bare integers, and
# bare booleans are all accepted so the contract stays a single sed-readable
# file that Bun's TOML parser still validates.
wt_contract_value() {
	local key="$1" value
	value="$(sed -nE \
		"s/^${key}[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*\$/\\1/p; \
		 s/^${key}[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*\$/\\1/p; \
		 s/^${key}[[:space:]]*=[[:space:]]*(true|false)[[:space:]]*\$/\\1/p" \
		"$WORKTREE_CONTRACT" | head -n 1)"
	if [ -z "$value" ]; then
		wt_die "contract key '${key}' is missing"
	fi
	printf '%s\n' "$value"
}

# Read one flat array from the contract as space-separated words. An array that
# is present and empty is a legitimate answer (no services, no legacy cleanup
# commands), so presence is checked separately from emptiness.
wt_contract_list() {
	local key="$1" line
	if ! grep -qE "^${key}[[:space:]]*=[[:space:]]*\\[" "$WORKTREE_CONTRACT"; then
		wt_die "contract key '${key}' is missing"
	fi
	line="$(sed -nE "s/^${key}[[:space:]]*=[[:space:]]*\\[(.*)\\][[:space:]]*\$/\\1/p" \
		"$WORKTREE_CONTRACT" | head -n 1)"
	printf '%s\n' "$line" | tr -d '"' | tr ',' ' ' | tr -s ' ' |
		sed -e 's/^ *//' -e 's/ *$//'
}

# wt_service_value <service> <key>
wt_service_value() {
	wt_contract_value "service_$1_$2"
}

# Expand "${HOME}" and a leading "~/" without eval, so a contract or registry
# value can never execute a substitution.
wt_expand_home() {
	local value="$1"
	value="${value//\$\{HOME\}/$HOME}"
	case "$value" in
		"~/"*) value="$HOME/${value#\~/}" ;;
		"~") value="$HOME" ;;
	esac
	printf '%s\n' "$value"
}

wt_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | awk '{ print $1 }'
	else
		wt_die "no sha-256 utility is available"
	fi
}

# Permission bits in octal, GNU stat first then BSD stat. Matches
# `(lstat.mode & 0o7777).toString(8)` in the image-owned fingerprint, and does
# not follow symlinks on either platform.
wt_file_mode() {
	local path="$1" mode
	if mode="$(stat -c '%a' "$path" 2>/dev/null)" && [ -n "$mode" ]; then
		printf '%s\n' "$mode"
		return 0
	fi
	if mode="$(stat -f '%Lp' "$path" 2>/dev/null)" && [ -n "$mode" ]; then
		printf '%s\n' "$mode"
		return 0
	fi
	wt_die "cannot read the file mode of $path"
}

# wt_atomic_write <destination> <content>
# Same-directory temp plus rename, so a concurrent reader observes either the
# previous file or the complete new one and never a partial write.
wt_atomic_write() {
	local destination="$1" content="$2" temporary
	mkdir -p "$(dirname "$destination")"
	temporary="$(mktemp "${destination}.tmp.XXXXXX")"
	if ! printf '%s' "$content" >"$temporary"; then
		rm -f "$temporary"
		return 1
	fi
	mv "$temporary" "$destination"
}

# Read one key out of a generated environment file with sed. The runtime never
# sources these files to read a single value: a malformed or hostile line would
# otherwise execute at read time.
wt_env_file_value() {
	local file="$1" key="$2" value escaped="'\\''"
	[ -r "$file" ] || return 1
	value="$(sed -nE "s/^${key}=(.*)\$/\\1/p" "$file" | tail -n 1)"
	case "$value" in
		"'"*"'")
			value="${value#\'}"
			value="${value%\'}"
			value="${value//"$escaped"/\'}"
			;;
	esac
	printf '%s\n' "$value"
}

# The generated environment files are sourced by the container bootstrap, so an
# unquoted value containing spaces or a command substitution would word-split or
# execute at shell start. Anything outside the safe set is single quoted.
wt_quote_if_needed() {
	local value="$1" escaped="'\\''"
	case "$value" in
		'' | *[!A-Za-z0-9_./:-]*)
			printf "'%s'\n" "${value//\'/$escaped}"
			;;
		*)
			printf '%s\n' "$value"
			;;
	esac
}

# Lowercase, collapse every unsafe character to a single hyphen, and guarantee
# the result starts with an alphanumeric so it is a legal Docker resource and
# DNS label component.
wt_sanitize_name() {
	local value
	value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' |
		sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-*//' -e 's/-*$//')"
	case "$value" in
		[a-z0-9]*) ;;
		*) value="x${value}" ;;
	esac
	printf '%s\n' "$value"
}

# The shape rules, stated once as predicates. A caller that must not proceed on a
# malformed value wraps them in the wt_require_* pair below and dies; a caller
# whose whole job is to report malformed values asks the predicate directly and
# keeps going. Two implementations of "is this a legal workspace id" would be two
# answers, and the diagnostic one would be the one nobody notices drifting.
#
# wt_is_identifier <value> <extended_regex>
wt_is_identifier() {
	printf '%s\n' "$1" | grep -qE "$2"
}

# wt_is_port <value>
wt_is_port() {
	case "$1" in
		'' | *[!0-9]*) return 1 ;;
	esac
	[ "$1" -ge 1024 ] && [ "$1" -le 65535 ]
}

# wt_require_identifier <value> <extended_regex> <label>
wt_require_identifier() {
	local value="$1" pattern="$2" label="$3"
	if ! wt_is_identifier "$value" "$pattern"; then
		wt_die "$label '$value' does not match $pattern"
	fi
	printf '%s\n' "$value"
}

# wt_require_port <value> [label]
wt_require_port() {
	local value="$1" label="${2:-port}"
	case "$value" in
		'' | *[!0-9]*) wt_die "$label '$value' is not a port number" ;;
	esac
	if ! wt_is_port "$value"; then
		wt_die "$label $value is outside 1024-65535"
	fi
	printf '%s\n' "$value"
}

# The registry and the host manifests are read-modify-write JSON documents that
# several worktrees mutate concurrently. python3 (standard library only) gives
# an atomic os.replace and a real JSON parser without adding a runtime that the
# host may not have.
wt_python() {
	if command -v python3 >/dev/null 2>&1; then
		printf 'python3\n'
		return 0
	fi
	wt_die "python3 is required for atomic registry and manifest writes; install it (macOS: xcode-select --install)" 6
}

# The runtime targets the reference container tooling: the docker engine plus
# the devcontainer CLI, whose ownership labels, per-invocation mounts, and
# ${devcontainerId} volume identity this runtime depends on. Degrade with an
# instruction rather than a stack trace when either is absent.
wt_require_container_tooling() {
	local engine cli package
	engine="$(wt_contract_value container_engine)"
	cli="$(wt_contract_value container_cli)"
	package="$(wt_contract_value container_cli_package)"
	if ! command -v "$engine" >/dev/null 2>&1; then
		wt_die "the ${engine} container engine is unavailable on this host; install Docker Desktop (or a compatible engine) and start its daemon" 6
	fi
	if ! "$engine" info >/dev/null 2>&1; then
		wt_die "the ${engine} daemon is not responding; start it and retry" 6
	fi
	if ! command -v "$cli" >/dev/null 2>&1; then
		wt_die "the ${cli} CLI is unavailable on this host; install it with 'bun add --global ${package}' or 'npm install --global ${package}'" 6
	fi
}

# The same algorithm the container CLI uses for the ${devcontainerId} template
# variable, so this runtime can name a checkout's own volumes without asking the
# engine or the editor extension which ones they are. Removal needs it to know
# what it owns and diagnosis needs it to know what to look for, so it lives here
# rather than in either of them.
#
# wt_devcontainer_identity <repo_root> <devcontainer_config_path>
wt_devcontainer_identity() {
	local root="$1" config="$2" python
	python="$(wt_python)"
	DEVCONTAINER_LOCAL_FOLDER="$root" \
		DEVCONTAINER_CONFIG_FILE="$config" \
		"$python" - <<'PYTHON'
import hashlib
import json
import os

alphabet = "0123456789abcdefghijklmnopqrstuv"
payload = json.dumps(
    {
        "devcontainer.config_file": os.environ["DEVCONTAINER_CONFIG_FILE"],
        "devcontainer.local_folder": os.environ["DEVCONTAINER_LOCAL_FOLDER"],
    },
    separators=(",", ":"),
    sort_keys=True,
)
value = int.from_bytes(hashlib.sha256(payload.encode("utf-8")).digest(), "big")
digits = ""
while value:
    value, remainder = divmod(value, 32)
    digits = alphabet[remainder] + digits
print(digits.rjust(52, "0"))
PYTHON
}

# Volume prefixes are DERIVED from the container definition, never listed here: a
# hardcoded list drifts the moment devcontainer.json gains a mount, and the drift
# is silent because a missed volume looks exactly like a clean host.
#
# wt_volume_prefixes <devcontainer_config_path>
wt_volume_prefixes() {
	local config="$1" python
	python="$(wt_python)"
	DEVCONTAINER_CONFIG_FILE="$config" "$python" - <<'PYTHON'
import os
import re

path = os.environ["DEVCONTAINER_CONFIG_FILE"]
try:
    with open(path, "r", encoding="utf-8") as handle:
        source = handle.read()
except OSError:
    raise SystemExit(0)
seen = []
pattern = r"source=([A-Za-z0-9][A-Za-z0-9_.-]*)-\$\{devcontainerId\}"
for match in re.finditer(pattern, source):
    if match.group(1) not in seen:
        seen.append(match.group(1))
for name in seen:
    print(name)
PYTHON
}

# Exact bash re-implementation of .devcontainer/devcontainer-fingerprint.sh,
# which is the image authority and is deliberately not modified here. Same
# inputs (.dockerignore, .prototools, and every file and symlink under
# .devcontainer), same per-entry framing `path\0type\0mode\0digest\0`, same
# byte-ordered sort, same final sha-256. The host needs this before Bun exists,
# and a guard test asserts the two implementations agree on the real tree.
wt_definition_fingerprint() {
	local root="${1:-$REPO_ROOT}" input relative path type mode digest

	{
		for input in $(wt_contract_list definition_fingerprint_inputs); do
			if [ -d "$root/$input" ]; then
				find "$root/$input" \( -type f -o -type l \) -print |
					sed -e "s#^${root}/##"
			else
				printf '%s\n' "$input"
			fi
		done
	} | LC_ALL=C sort | {
		while IFS= read -r relative; do
			[ -n "$relative" ] || continue
			path="$root/$relative"
			mode="$(wt_file_mode "$path")"
			if [ -L "$path" ]; then
				type="symlink"
				digest="$(printf '%s' "$(readlink "$path")" | wt_sha256)"
			elif [ -f "$path" ]; then
				type="file"
				digest="$(wt_sha256 <"$path")"
			else
				wt_die "unsupported fingerprint input type: $relative"
			fi
			printf '%s\0%s\0%s\0%s\0' "$relative" "$type" "$mode" "$digest"
		done
	} | wt_sha256
}
