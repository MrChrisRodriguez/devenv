#!/usr/bin/env bash
set -e

echo "🐙 Verifying the image-owned Claude Octopus payload..."

# Source common setup functions
source /workspace/.devcontainer/on-create/setup-common.sh

# Setup Proto environment to access jq and the image-owned agent CLIs.
setup_proto_env

OCTOPUS_DIR="$HOME/.payloads/octopus"
for required in \
	"$OCTOPUS_DIR/.devenv-source" \
	"$OCTOPUS_DIR/.claude-plugin/marketplace.json" \
	"$OCTOPUS_DIR/.claude-plugin/plugin.json" \
	"$OCTOPUS_DIR/.codex-plugin/plugin.json"; do
	if [ ! -r "$required" ]; then
		echo "ERROR: Claude Octopus is missing from the image-owned payload; rebuild/recreate the devcontainer" >&2
		return 1
	fi
done
if ! jq -e '.name == "octo" and (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' \
	"$OCTOPUS_DIR/.claude-plugin/plugin.json" >/dev/null; then
	echo "ERROR: the image-owned Claude Octopus manifest is invalid" >&2
	return 1
fi

# Register and install from the verified local payload. These bounded commands
# never fetch GitHub and cannot turn a mutable marketplace head into authority.
if ! command -v claude &> /dev/null; then
	echo "ERROR: Claude CLI is required by the enabled Octopus capability" >&2
	return 1
else
	if ! marketplaces="$(timeout 30s claude plugin marketplace list --json)"; then
		echo "ERROR: Claude Octopus could not inspect persisted marketplaces" >&2
		return 1
	fi
	if ! jq -e --arg path "$OCTOPUS_DIR" \
		'.[] | select(.name == "nyldn-plugins" and .source == "directory" and .path == $path)' \
		<<<"$marketplaces" >/dev/null; then
		if jq -e '.[] | select(.name == "nyldn-plugins")' <<<"$marketplaces" >/dev/null; then
			if ! timeout 30s claude plugin marketplace remove nyldn-plugins; then
				echo "ERROR: Claude Octopus could not replace its stale marketplace" >&2
				return 1
			fi
		fi
		if ! timeout 30s claude plugin marketplace add --scope user "$OCTOPUS_DIR"; then
			echo "ERROR: Claude Octopus could not register its local marketplace" >&2
			return 1
		fi
	fi
	if ! plugins="$(timeout 30s claude plugin list --json)"; then
		echo "ERROR: Claude Octopus could not inspect installed plugins" >&2
		return 1
	fi
	install_path="$(jq -r '.[] | select(.id == "octo@nyldn-plugins") | .installPath' <<<"$plugins")"
	if [ -z "$install_path" ] || ! cmp -s "$OCTOPUS_DIR/.devenv-source" "$install_path/.devenv-source"; then
		if [ -n "$install_path" ]; then
			if ! timeout 30s claude plugin uninstall --scope user octo@nyldn-plugins; then
				echo "ERROR: Claude Octopus could not remove its stale installed plugin" >&2
				return 1
			fi
		fi
		if ! timeout 30s claude plugin install --scope user octo@nyldn-plugins; then
			echo "ERROR: Claude Octopus could not install from its local marketplace" >&2
			return 1
		fi
	fi
fi

# Codex discovers one symlink per skill from its own effective root. Refuse a
# pre-existing name instead of silently creating a duplicate or shadowed skill.
CODEX_SKILLS="$HOME/.codex/skills"
if ! mkdir -p "$CODEX_SKILLS"; then
	echo "ERROR: Claude Octopus could not create the Codex skill root" >&2
	return 1
fi
skill_count=0
for skill_file in "$OCTOPUS_DIR"/skills/*/SKILL.md; do
	[ -f "$skill_file" ] || continue
	source_dir="$(dirname "$skill_file")"
	skill_name="$(basename "$source_dir")"
	target="$CODEX_SKILLS/$skill_name"
	for competing_root in /workspace/.codex/skills /workspace/.agents/skills; do
		if [ -e "$competing_root/$skill_name" ] || [ -L "$competing_root/$skill_name" ]; then
			echo "ERROR: Codex skill name collision at $competing_root/$skill_name" >&2
			return 1
		fi
	done
	if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$source_dir" ]; then
		:
	elif [ -e "$target" ] || [ -L "$target" ]; then
		echo "ERROR: Codex skill name collision at $target" >&2
		return 1
	else
		if ! ln -s "$source_dir" "$target"; then
			echo "ERROR: Claude Octopus could not link Codex skill $skill_name" >&2
			return 1
		fi
	fi
	skill_count=$((skill_count + 1))
done
if [ "$skill_count" -eq 0 ]; then
	echo "ERROR: the image-owned Claude Octopus payload exposes no Codex skills" >&2
	return 1
fi

# Remove only the exact legacy shared-root link created by older templates.
legacy_skills="$HOME/.agents/skills/claude-octopus"
if [ -L "$legacy_skills" ]; then
	case "$(readlink -f "$legacy_skills")" in
		"$OCTOPUS_DIR/skills"|"$HOME/.local/share/claude-octopus/skills")
			if ! rm "$legacy_skills"; then
				echo "ERROR: Claude Octopus could not remove its legacy shared skill link" >&2
				return 1
			fi
			;;
	esac
fi

echo "✅ Image-owned Claude Octopus payload verified and registered"
