#!/usr/bin/env bash
# Canonical exported environment for repository-supported container commands.
# This file is intentionally quiet, idempotent, and safe to source from bash or
# zsh. Interactive aliases, prompts, plugins, completions, and history do not
# belong here.

_devcontainer_workspace_root="${DEVCONTAINER_WORKSPACE_ROOT:-/workspace}"
_devcontainer_config_root="${DEVCONTAINER_CONFIG_ROOT:-/run/devcontainer-config}"
_devcontainer_env_lib="${DEVCONTAINER_ENV_LIB:-${_devcontainer_workspace_root}/.devcontainer/lib/env-file.sh}"

if [ ! -r "$_devcontainer_env_lib" ]; then
	printf 'ERROR: devcontainer environment parser is missing: %s\n' \
		"$_devcontainer_env_lib" >&2
	return 1 2>/dev/null || exit 1
fi
# shellcheck disable=SC1090
source "$_devcontainer_env_lib"

devcontainer_environment_export_pair() {
	export "$1=$2"
}

devcontainer_environment_load_secrets() {
	local project="${DEVCONTAINER_PROJECT:-}"
	local common_file="${DEVCONTAINER_COMMON_SECRETS_FILE:-${_devcontainer_config_root}/secrets}"
	local project_file=""

	devcontainer_env_for_each "$common_file" \
		devcontainer_environment_export_pair "common secrets" || return
	if [ -n "$project" ]; then
		project_file="${DEVCONTAINER_PROJECT_SECRETS_FILE:-${_devcontainer_config_root}/secrets.d/${project}}"
		devcontainer_env_for_each "$project_file" \
			devcontainer_environment_export_pair "project secrets (${project})" || return
	fi
}

devcontainer_environment_load_worktree() {
	local env_file="${DEVCONTAINER_WORKTREE_ENV_FILE:-${_devcontainer_workspace_root}/.env.worktree}"
	local allexport_was_on="" source_status=0

	[ -f "$env_file" ] || return 0
	case "$-" in *a*) allexport_was_on=1 ;; esac
	set -a
	# This is a repository-generated shell environment, not a credential file.
	# shellcheck disable=SC1090
	source "$env_file" || source_status=$?
	[ -n "$allexport_was_on" ] || set +a
	return "$source_status"
}

devcontainer_environment_load_project_hook() {
	# Project-specific normalization hook. The template ships none: a project
	# generated from this template drops its own
	# `.devcontainer/environment.project.sh` here to derive project variables
	# (service addresses, public origins, per-worktree state directories, …)
	# from the secrets and worktree values loaded above. Keep it quiet,
	# idempotent, and safe to source from both bash and zsh — it runs in every
	# interactive shell and in on-create.
	local hook="${DEVCONTAINER_PROJECT_ENV_HOOK:-${_devcontainer_workspace_root}/.devcontainer/environment.project.sh}"

	[ -f "$hook" ] || return 0
	# shellcheck disable=SC1090
	source "$hook"
}

devcontainer_environment_path_prepend() {
	local entry="$1" remaining="${PATH:-}" part rebuilt=""

	# Peel colon-delimited entries with parameter expansion instead of relying on
	# unquoted word-splitting: zsh disables SH_WORD_SPLIT by default, so the old
	# `for part in $PATH` kept the whole value as a single element there, defeating
	# the dedupe and letting `entry` accumulate on repeated sourcing.
	while [ -n "$remaining" ]; do
		part="${remaining%%:*}"
		case "$remaining" in
			*:*) remaining="${remaining#*:}" ;;
			*) remaining="" ;;
		esac
		[ -n "$part" ] || continue
		[ "$part" = "$entry" ] && continue
		rebuilt="${rebuilt}${rebuilt:+:}${part}"
	done

	PATH="${entry}${rebuilt:+:${rebuilt}}"
	export PATH
}

devcontainer_environment_base_paths() {
	export PROTO_HOME="${PROTO_HOME:-${HOME}/.proto}"

	# The image already bakes this exact ordering as ENV (Dockerfile:
	# `ENV PATH="/workspace/node_modules/.bin:${PROTO_HOME}/shims:${PROTO_HOME}/bin:/home/vscode/.local/bin:${PATH}"`)
	# and devcontainer.json repeats it in remoteEnv. Re-asserting it here is not
	# a fight with the image: path_prepend removes an existing occurrence before
	# prepending, so sourcing this file any number of times leaves the baked PATH
	# byte-identical while still repairing shells that started from a stripped
	# environment (`env -i`, SSH, `su`).
	#
	# Prepend in reverse priority order. Workspace binaries win; Proto requires
	# shims before bin; the image launcher symlinks in ~/.local/bin come last so
	# a Proto-managed tool always shadows its baked counterpart.
	devcontainer_environment_path_prepend "${HOME}/.local/bin"
	devcontainer_environment_path_prepend "${PROTO_HOME}/bin"
	devcontainer_environment_path_prepend "${PROTO_HOME}/shims"
	devcontainer_environment_path_prepend "${_devcontainer_workspace_root}/node_modules/.bin"
}

devcontainer_environment_activate_proto() {
	local activation

	if ! command -v proto >/dev/null 2>&1; then
		printf 'ERROR: Proto is unavailable after devcontainer base environment setup\n' >&2
		return 1
	fi
	activation="$(proto activate bash --export)" || {
		printf 'ERROR: Proto activation failed for %s\n' "$PWD" >&2
		return 1
	}
	eval "$activation"
}

devcontainer_environment_normalize_node_options() {
	# Node refuses assorted V8/loader flags when they appear in NODE_OPTIONS
	# (e.g. Claude Code's --harmony-import-attributes / --js-source-phase-imports).
	# Such flags leak in from the host shell that launched `devcontainer up`,
	# override containerEnv's clean value, and -- if preserved verbatim -- make
	# every node invocation (husky `prepare`, bunx, codex) abort with exit 9,
	# which fails the postCreate install. Keep only the heap sizing this
	# container owns, drop everything else, and default the size when none survives.
	local incoming="${NODE_OPTIONS:-}" token heap=""

	# Peel space-delimited tokens with parameter expansion instead of relying on
	# the shell's unquoted word-splitting -- zsh disables SH_WORD_SPLIT by default,
	# so `for token in $incoming` would keep the whole string as one token there.
	while [ -n "$incoming" ]; do
		token="${incoming%% *}"
		case "$incoming" in
			*" "*) incoming="${incoming#* }" ;;
			*) incoming="" ;;
		esac
		[ -n "$token" ] || continue
		case "$token" in
			--max-old-space-size=*) heap="$token" ;;
			*) ;;
		esac
	done

	export NODE_OPTIONS="${heap:---max-old-space-size=4096}"
}

devcontainer_environment_bootstrap() {
	local xtrace_was_on="" bootstrap_status=0

	# Secret exports must remain value-free even when a caller (on-create) uses
	# xtrace for the rest of its diagnostics.
	case "$-" in *x*) xtrace_was_on=1; set +x ;; esac
	devcontainer_environment_load_secrets || bootstrap_status=$?
	if [ "$bootstrap_status" -eq 0 ]; then
		devcontainer_environment_load_worktree || bootstrap_status=$?
	fi
	if [ "$bootstrap_status" -eq 0 ]; then
		devcontainer_environment_load_project_hook || bootstrap_status=$?
		devcontainer_environment_normalize_node_options
		export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
		devcontainer_environment_base_paths || bootstrap_status=$?
	fi
	[ -z "$xtrace_was_on" ] || set -x
	return "$bootstrap_status"
}

if [ "${DEVCONTAINER_ENVIRONMENT_NO_AUTO_BOOTSTRAP:-}" != "1" ]; then
	devcontainer_environment_bootstrap || {
		return 1 2>/dev/null || exit 1
	}
fi

unset _devcontainer_env_lib
