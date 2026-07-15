#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
	launchers)
		for tool in codex gemini graphify claude ccstatusline context7-mcp; do
			path="$(command -v "$tool")"
			case "$path" in
				/home/vscode/.local/bin/*) ;;
				*) echo "ERROR: $tool resolved outside the image launcher root: $path" >&2; exit 1 ;;
			esac
			printf '%s=%s\n' "$tool" "$path"
		done
		printf 'playwright=%s\n' "$(cat /home/vscode/.payloads/browser/.devenv-playwright-version)"
		browser_executable="$(find /home/vscode/.payloads/browser -type f -path '*/chrome-linux/headless_shell' -perm /111 -print)"
		if [ "$(printf '%s\n' "$browser_executable" | grep -c .)" -ne 1 ]; then
			echo "ERROR: expected exactly one baked headless shell" >&2
			exit 1
		fi
		printf 'browserExecutable=%s\n' "$browser_executable"
		printf 'octopusCommit=%s\n' "$(head -n 1 /home/vscode/.payloads/octopus/.devenv-source)"
		printf 'octopusSha256=%s\n' "$(tail -n 1 /home/vscode/.payloads/octopus/.devenv-source)"
		printf 'warpCommit=%s\n' "$(head -n 1 /home/vscode/.payloads/warp/.devenv-source)"
		printf 'warpSha256=%s\n' "$(tail -n 1 /home/vscode/.payloads/warp/.devenv-source)"
		;;
	plugins)
		source /workspace/.devcontainer/on-create/setup-claude-octopus.sh
		source /workspace/.devcontainer/on-create/setup-claude-warp.sh
		plugins="$(timeout 30s claude plugin list --json)"
		octopus_path="$(jq -r '.[] | select(.id == "octo@nyldn-plugins") | .installPath' <<<"$plugins")"
		warp_path="$(jq -r '.[] | select(.id == "warp@claude-code-warp") | .installPath' <<<"$plugins")"
		test -n "$octopus_path"
		test -n "$warp_path"
		cmp -s /home/vscode/.payloads/octopus/.devenv-source "$octopus_path/.devenv-source"
		cmp -s /home/vscode/.payloads/warp/.devenv-source "$warp_path/.devenv-source"
		printf 'stale\n' >"$octopus_path/.devenv-source"
		printf 'stale\n' >"$warp_path/.devenv-source"
		source /workspace/.devcontainer/on-create/setup-claude-octopus.sh
		source /workspace/.devcontainer/on-create/setup-claude-warp.sh
		plugins="$(timeout 30s claude plugin list --json)"
		octopus_path="$(jq -r '.[] | select(.id == "octo@nyldn-plugins") | .installPath' <<<"$plugins")"
		warp_path="$(jq -r '.[] | select(.id == "warp@claude-code-warp") | .installPath' <<<"$plugins")"
		cmp -s /home/vscode/.payloads/octopus/.devenv-source "$octopus_path/.devenv-source"
		cmp -s /home/vscode/.payloads/warp/.devenv-source "$warp_path/.devenv-source"
		test ! -e /home/vscode/.agents/skills/claude-octopus
		test ! -e /workspace/.agents/skills/graphify
		printf 'octopusInstallPath=%s\n' "$octopus_path"
		printf 'warpInstallPath=%s\n' "$warp_path"
		printf 'persistedSourceRepair=pass\n'
		printf 'sharedGraphifyResidue=absent\n'
		;;
	*)
		echo "usage: $0 launchers|plugins" >&2
		exit 2
		;;
esac
