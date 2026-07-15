#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
manifest="$repo_root/.prototools"
checksums="$script_dir/proto-checksums.txt"

verify_archive() {
	local archive="$1"
	local expected="$2"
	printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status -
}

installation_ready() {
	local home="$1"
	local expected_version="$2"
	[ -x "$home/bin/proto" ] &&
		[ -x "$home/bin/proto-shim" ] &&
		[ "$("$home/bin/proto" --version 2>/dev/null | awk '{ print $NF }')" = "$expected_version" ]
}

if [ "${1:-}" = "--verify-only" ]; then
	if [ "$#" -ne 3 ]; then
		echo "usage: install-proto.sh --verify-only <archive> <sha256>" >&2
		exit 2
	fi
	verify_archive "$2" "$3"
	exit 0
fi

if [ "${1:-}" = "--health-check" ]; then
	if [ "$#" -ne 3 ]; then
		echo "usage: install-proto.sh --health-check <proto-home> <version>" >&2
		exit 2
	fi
	installation_ready "$2" "$3"
	exit $?
fi

if [ "$(uname -s)" != "Linux" ]; then
	echo "Proto bootstrap supports Linux only" >&2
	exit 1
fi

for command_name in curl install sha256sum tar; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "Proto bootstrap requires ${command_name}" >&2
		exit 1
	fi
done

if [ ! -f "$manifest" ] || [ ! -f "$checksums" ]; then
	echo "Proto bootstrap requires .prototools and proto-checksums.txt" >&2
	exit 1
fi

version="$(sed -nE 's/^proto[[:space:]]*=[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"$/\1/p' "$manifest")"
if [ -z "$version" ] || [ "$(printf '%s\n' "$version" | wc -l | tr -d ' ')" -ne 1 ]; then
	echo "Proto bootstrap requires one exact proto version in .prototools" >&2
	exit 1
fi

case "$(uname -m)" in
	x86_64|amd64)
		target="x86_64-unknown-linux-gnu"
		;;
	aarch64|arm64)
		target="aarch64-unknown-linux-gnu"
		;;
	*)
		echo "Proto bootstrap does not support architecture $(uname -m)" >&2
		exit 1
		;;
esac

archive_name="proto_cli-${target}.tar.xz"
expected="$(awk -v name="$archive_name" '$2 == name { print $1 }' "$checksums")"
if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
	echo "Proto bootstrap has no valid checksum for ${archive_name}" >&2
	exit 1
fi

export PROTO_HOME="${PROTO_HOME:-$HOME/.proto}"
export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH"
if installation_ready "$PROTO_HOME" "$version"; then
	exit 0
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"; [ -z "${proto_temporary:-}" ] || rm -f "$proto_temporary"; [ -z "${shim_temporary:-}" ] || rm -f "$shim_temporary"' EXIT
archive="$temporary_directory/$archive_name"
url="https://github.com/moonrepo/proto/releases/download/v${version}/${archive_name}"

curl --fail --location --silent --show-error \
	--retry 3 --retry-all-errors --retry-max-time 180 \
	--connect-timeout 10 --max-time 120 \
	--output "$archive" "$url"
verify_archive "$archive" "$expected"
tar -xJf "$archive" -C "$temporary_directory"
release_dir="$temporary_directory/proto_cli-${target}"
mkdir -p "$PROTO_HOME/bin"
proto_temporary="$PROTO_HOME/bin/.proto.$$"
shim_temporary="$PROTO_HOME/bin/.proto-shim.$$"
install -m 0755 "$release_dir/proto" "$proto_temporary"
install -m 0755 "$release_dir/proto-shim" "$shim_temporary"
mv -f "$shim_temporary" "$PROTO_HOME/bin/proto-shim"
mv -f "$proto_temporary" "$PROTO_HOME/bin/proto"
hash -r

if ! installation_ready "$PROTO_HOME" "$version"; then
	actual="$("$PROTO_HOME/bin/proto" --version 2>/dev/null | awk '{ print $NF }')"
	echo "Proto bootstrap expected ${version}, got ${actual:-missing}" >&2
	exit 1
fi
