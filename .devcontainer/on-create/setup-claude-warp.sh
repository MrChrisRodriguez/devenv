#!/usr/bin/env bash
set -e

echo "⚡ Verifying the image-owned Claude Code Warp payload..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access jq and the Claude Code binary.
setup_proto_env

WARP_DIR="$HOME/.payloads/warp"
for required in \
	"$WARP_DIR/.devenv-source" \
	"$WARP_DIR/.claude-plugin/marketplace.json" \
	"$WARP_DIR/plugins/warp/.claude-plugin/plugin.json" \
	"$WARP_DIR/plugins/warp/.devenv-source"; do
	if [ ! -r "$required" ]; then
		echo "ERROR: Claude Code Warp is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
		return 1
	fi
done
if ! jq -e '.name == "warp" and (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' \
	"$WARP_DIR/plugins/warp/.claude-plugin/plugin.json" >/dev/null; then
	echo "ERROR: the image-owned Warp manifest is invalid" >&2
	return 1
fi

# Register only the local, checksum-verified marketplace. The timeout keeps
# unattended creation bounded even if a future Claude release regresses.
if ! command -v claude &> /dev/null; then
	echo "ERROR: Claude CLI is required by the enabled Warp capability" >&2
	return 1
else
	if ! marketplaces="$(timeout 30s claude plugin marketplace list --json)"; then
		echo "ERROR: Claude Code Warp could not inspect persisted marketplaces" >&2
		return 1
	fi
	if ! jq -e --arg path "$WARP_DIR" \
		'.[] | select(.name == "claude-code-warp" and .source == "directory" and .path == $path)' \
		<<<"$marketplaces" >/dev/null; then
		if jq -e '.[] | select(.name == "claude-code-warp")' <<<"$marketplaces" >/dev/null; then
			if ! timeout 30s claude plugin marketplace remove claude-code-warp; then
				echo "ERROR: Claude Code Warp could not replace its stale marketplace" >&2
				return 1
			fi
		fi
		if ! timeout 30s claude plugin marketplace add --scope user "$WARP_DIR"; then
			echo "ERROR: Claude Code Warp could not register its local marketplace" >&2
			return 1
		fi
	fi
	if ! plugins="$(timeout 30s claude plugin list --json)"; then
		echo "ERROR: Claude Code Warp could not inspect installed plugins" >&2
		return 1
	fi
	install_path="$(jq -r '.[] | select(.id == "warp@claude-code-warp") | .installPath' <<<"$plugins")"
	if [ -z "$install_path" ] || ! cmp -s "$WARP_DIR/.devenv-source" "$install_path/.devenv-source"; then
		if [ -n "$install_path" ]; then
			if ! timeout 30s claude plugin uninstall --scope user warp@claude-code-warp; then
				echo "ERROR: Claude Code Warp could not remove its stale installed plugin" >&2
				return 1
			fi
		fi
		if ! timeout 30s claude plugin install --scope user warp@claude-code-warp; then
			echo "ERROR: Claude Code Warp could not install from its local marketplace" >&2
			return 1
		fi
	fi
fi

echo "✅ Image-owned Claude Code Warp payload verified and registered"
