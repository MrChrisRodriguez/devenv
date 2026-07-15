#!/usr/bin/env bash
set -e

# Verify the image-owned Proto toolchain. This script is sourced by on-create.sh
# and deliberately performs no installation, ownership repair, or reconciliation.

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

setup_proto_env

repo_root="${DEVCONTAINER_REPO_ROOT:-/workspace}"
image_contract_dir="${DEVCONTAINER_IMAGE_CONTRACT_DIR:-/usr/local/share/devenv-image}"
root_manifest="$repo_root/.prototools"
manifest_marker="$image_contract_dir/prototools.sha256"
definition_marker="$image_contract_dir/definition.sha256"
fingerprint_script="$repo_root/.devcontainer/devcontainer-fingerprint.sh"
image_proto_home="/home/vscode/.proto"
proto_root="$(/usr/bin/readlink -f "$image_proto_home")"
image_proto="$image_proto_home/bin/proto"

rebuild_required() {
	echo "ERROR: $1" >&2
	echo "Rebuild/recreate the devcontainer; image-owned tools are never repaired at runtime." >&2
	return 1
}

is_sha256() {
	[ "${#1}" -eq 64 ] || return 1
	case "$1" in
		*[!0-9a-f]*) return 1 ;;
	esac
}

for required_file in \
	"$root_manifest" \
	"$manifest_marker" \
	"$definition_marker" \
	"$fingerprint_script"; do
	if [ ! -r "$required_file" ]; then
		rebuild_required "required Proto image contract input is missing: $required_file"
		return 1
	fi
done

expected_manifest="$(/usr/bin/sha256sum "$root_manifest" | /usr/bin/awk '{print $1}')"
actual_manifest="$(/usr/bin/tr -d '[:space:]' < "$manifest_marker")"
if ! is_sha256 "$actual_manifest" || [ "$actual_manifest" != "$expected_manifest" ]; then
	rebuild_required ".prototools differs from the manifest baked into this image"
	return 1
fi

bun_version="$(/usr/bin/awk -F'"' '/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"[^\"]+"[[:space:]]*$/ { print $2 }' "$root_manifest")"
if [[ ! "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
	rebuild_required ".prototools does not contain one exact Bun version"
	return 1
fi
image_bun="$image_proto_home/tools/bun/$bun_version/bun"

for tool_path in "$image_bun" "$image_proto"; do
	resolved_tool="$(/usr/bin/readlink -f "$tool_path" 2>/dev/null || true)"
	case "$resolved_tool" in
		"$proto_root"/*) ;;
		*)
			rebuild_required "$tool_path does not resolve inside the image-owned Proto toolchain"
			return 1
			;;
	esac
	if [ ! -x "$tool_path" ]; then
		rebuild_required "$tool_path is absent from the image-owned Proto toolchain"
		return 1
	fi
done

if ! expected_definition="$(DEVCONTAINER_FINGERPRINT_BUN="$image_bun" /bin/bash "$fingerprint_script" "$repo_root")"; then
	rebuild_required "the devcontainer definition fingerprint could not be computed with image-owned Bun"
	return 1
fi
actual_definition="$(/usr/bin/tr -d '[:space:]' < "$definition_marker")"
if ! is_sha256 "$actual_definition" || [ "$actual_definition" != "$expected_definition" ]; then
	rebuild_required "the devcontainer definition differs from the image fingerprint"
	return 1
fi

for tool_path in "$image_proto" "$image_bun"; do
	if ! "$tool_path" --version >/dev/null 2>&1; then
		rebuild_required "$tool_path is not executable in the image-owned Proto toolchain"
		return 1
	fi
done

echo "✅ Image-owned Proto contract verified (${expected_manifest:0:12}; ${expected_definition:0:12})"
