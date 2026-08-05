#!/usr/bin/env bash
# sanitize-octo-hooks.sh — disable Claude Octopus's harness-incompatible hook layer.
#
# WHY THIS EXISTS
# octo (v9.52.0, the pinned OCTOPUS_COMMIT payload) ships a hooks manifest whose
# hooks are incompatible with the Claude Code harness in TWO independent ways:
#
#   1. GATES THAT DENY. PreToolUse hooks on a `Bash` matcher of type "prompt"
#      (the "🐙 CLAUDE OCTOPUS ACTIVATED" / "Codex|Gemini CLI Executing" banners).
#      octo intends them as passive status messages, but per the hooks spec
#      (https://code.claude.com/docs/en/hooks.md) a PreToolUse type:prompt hook is a
#      MODEL-JUDGED PERMISSION GATE. The banner wording is judged a prompt-injection,
#      so the gate returns `deny` — blocking EVERY Bash call (catastrophic under
#      non-interactive / bypassPermissions sessions).
#
#   2. LEGACY OUTPUT SCHEMA. Most of octo's ~41 type:command hooks print the old
#      `{"decision":"allow"|"continue"}` shape. The harness validates hook stdout
#      against the current schema (`{"hookSpecificOutput":{"hookEventName":...,
#      "permissionDecision":"allow|deny|ask"}}`, or empty to allow) and rejects the
#      legacy shape as `Hook JSON output validation failed — (root): Invalid input`.
#      They fire on Bash (Pre+PostToolUse) AND on SessionStart, TaskCreated,
#      WorktreeCreate/Remove, SubagentStop, PreCompact, UserPromptSubmit, … —
#      spamming errors on nearly every event. The rejected output is discarded, so
#      the hooks are already no-ops here; they add error noise and nothing else.
#
# Because the incompatibility is pervasive and the legacy hooks are already
# non-functional, the robust remedy is to disable octo's hook layer wholesale by
# emptying its event map. octo's SKILLS, COMMANDS and AGENTS live outside the hooks
# manifest and are UNAFFECTED. What is lost is octo's hook-driven automation
# (auto-router, discipline injection, session/workflow-phase env, worktree/teammate
# orchestration) — non-functional on this harness anyway. Upstream fix to track:
# https://github.com/nyldn/claude-octopus (adopt the current hook I/O contract).
#
# WHAT IT DOES
# Locates octo's installed hooks manifest under the plugin cache (marketplace- and
# version-globbed) plus any plugin roots passed as arguments, and empties its event
# map. Handles BOTH manifest layouts octo has shipped:
#   - <root>/.claude-plugin/hooks.json — FLAT: event names ("PreToolUse", …) are the
#     top-level keys. This is the layout of the currently pinned v9.52.0.
#   - <root>/hooks/hooks.json — WRAPPED: events live under a top-level "hooks" object.
# Idempotent (no-op once emptied), a safe no-op when octo is absent, and refuses to
# touch a manifest it cannot parse or that is not a JSON object. Re-run whenever octo
# is (re)installed or auto-updated.
#
# USAGE
#   bash sanitize-octo-hooks.sh [PLUGIN_ROOT …]
# Invoked from .devcontainer/on-create/setup-claude-octopus.sh after the plugin
# install, with the resolved installPath passed as an argument. Run as a child
# process (not sourced) so its exit status can be degraded to a warning.
#
# NOTE: after this edits the plugin cache, a running session must reload plugins
# (/reload-plugins) or restart for the change to take effect — the harness reads the
# hooks manifest at session/reload time.
set -u

if ! command -v jq > /dev/null 2>&1; then
	echo "ERROR: sanitize-octo-hooks.sh requires jq" >&2
	exit 1
fi

# Read the event map for either layout: the "hooks" object when wrapped, otherwise
# every top-level array (the flat layout's event lists). Self-contained: no external
# variables, no jq --arg dependencies. `.hooks` on an object without that key yields
# null (type "null"), so the wrapped test is false for a flat manifest — never empty,
# which would make the whole `if` produce no output.
read_map='if (.hooks | type) == "object" then .hooks else with_entries(select((.value | type) == "array")) end'
# Empty it in place, preserving every non-event key of the manifest.
clear_map='if (.hooks | type) == "object" then .hooks = {} else with_entries(select((.value | type) != "array")) end'

sanitize_manifest() {
	manifest="$1"
	[ -f "$manifest" ] || return 0

	if ! jq -e 'type == "object"' "$manifest" > /dev/null 2>&1; then
		echo "   skip (unparseable or not a JSON object): $manifest"
		return 0
	fi

	events="$(jq "($read_map) | length" "$manifest" 2> /dev/null)"
	entries="$(jq "[($read_map) | .[] | select(type == \"array\") | length] | add // 0" "$manifest" 2> /dev/null)"
	case "$events" in
		'' | 0 | *[!0-9]*) return 0 ;; # empty, zero, or unreadable — idempotent no-op
	esac

	tmp="$manifest.sanitize.tmp"
	if ! jq "$clear_map" "$manifest" > "$tmp"; then
		rm -f "$tmp"
		echo "   skip (rewrite failed): $manifest"
		return 0
	fi
	if ! mv "$tmp" "$manifest"; then # same-dir rename, atomic
		rm -f "$tmp"
		echo "   skip (replace failed): $manifest"
		return 0
	fi
	echo "   disabled octo hooks in $manifest: cleared $events event group(s), ${entries:-0} entr(ies)"
	sanitized=$((sanitized + 1))
}

shopt -s nullglob
sanitized=0
found=0
seen=""

candidates=()
# Explicit plugin roots (e.g. the installPath resolved by the caller).
for root in "$@"; do
	[ -n "$root" ] || continue
	candidates+=("$root/.claude-plugin/hooks.json" "$root/hooks/hooks.json")
done
# Any marketplace, any version, both layouts, with and without a version directory.
candidates+=(
	"$HOME"/.claude/plugins/cache/*/octo/.claude-plugin/hooks.json
	"$HOME"/.claude/plugins/cache/*/octo/hooks/hooks.json
	"$HOME"/.claude/plugins/cache/*/octo/*/.claude-plugin/hooks.json
	"$HOME"/.claude/plugins/cache/*/octo/*/hooks/hooks.json
)

for manifest in "${candidates[@]}"; do
	[ -f "$manifest" ] || continue
	case ":$seen:" in
		*":$manifest:"*) continue ;;
	esac
	seen="$seen:$manifest"
	found=$((found + 1))
	sanitize_manifest "$manifest"
done

if [ "$found" -eq 0 ]; then
	echo "   octo hooks manifest not found; nothing to sanitize"
elif [ "$sanitized" -eq 0 ]; then
	echo "   octo hooks already disabled; nothing to sanitize"
fi
