import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The ways the real OpenSpec CLI can be unhelpful, reproduced on demand.
 *
 * Every mode here is a behaviour observed in `@fission-ai/openspec` 0.19.0
 * rather than an invented one, because a guard is only worth having if its
 * failure paths have actually been executed:
 *
 * - `faithful`      answers correctly from the tree it is run in.
 * - `zero-items`    validates nothing and reports success — `validate --all`
 *                   really does exit 0 over an empty set.
 * - `phantom-item`  reports an item the tree does not contain.
 * - `wrong-version` is a different CLI wearing the same name.
 * - `malformed`     prints something that is not JSON on the success path.
 * - `nonzero`       fails outright.
 * - `prompt-hang`   blocks on stdin, the way the interactive prompt does when a
 *                   change name is missing. With stdin closed it reaches EOF
 *                   and exits, which is the property the guard needs: a CI lane
 *                   must never be able to wait forever on an answer nobody is
 *                   there to give.
 *
 * And two answers about the change directory, the first of them observed live:
 *
 * - `bridge-change-dir` answers with the path as the CONTAINER sees it. The
 *                       wrapper runs on the host and bridges only the CLI call,
 *                       so a repository bind-mounted at /workspace really does
 *                       come back as `/workspace/openspec/changes/<name>`. This
 *                       is a correct answer from a different mount point and
 *                       must be accepted.
 * - `foreign-change-dir` answers about a different change entirely. It shares
 *                       the mount-point shape of the case above and nothing
 *                       else, which is what keeps the acceptance above from
 *                       being an acceptance of everything.
 *
 * And three ways `archive` lies, each of them observed:
 *
 * - `archive-noop`         prints "Aborted. No files were changed." and RETURNS
 *                          0 without moving anything.
 * - `archive-drops-specs`  moves the change but never applies its delta specs,
 *                          which is what a mis-passed `--skip-specs` does.
 * - `archive-strays`       archives correctly and also writes outside the
 *                          OpenSpec root.
 */
export type FakeOpenspecMode =
	| "faithful"
	| "zero-items"
	| "phantom-item"
	| "wrong-version"
	| "malformed"
	| "nonzero"
	| "prompt-hang"
	| "bridge-change-dir"
	| "foreign-change-dir"
	| "archive-noop"
	| "archive-drops-specs"
	| "archive-strays";

// `@@{` stands in for a shell parameter expansion: this is a template literal,
// so the sequence has to be written once and substituted rather than escaped on
// every line of the script below.
const SCRIPT = String.raw`#!/usr/bin/env bash
set -u

MODE="__MODE__"
VERSION="__VERSION__"

emit_items() {
	local first=1
	printf '{\n  "items": [\n'
	for name in "$@"; do
		if [ "$first" -eq 0 ]; then printf ',\n'; fi
		first=0
		printf '    {"id": "%s", "type": "change", "valid": true, "issues": []}' "$name"
	done
	printf '\n  ],\n  "summary": {"totals": {"items": %s, "passed": %s, "failed": 0}},\n  "version": "1.0"\n}\n' "$#" "$#"
}

collect() {
	CHANGES=()
	if [ -d openspec/changes ]; then
		for entry in openspec/changes/*/; do
			[ -d "$entry" ] || continue
			name="$(basename "$entry")"
			[ "$name" = "archive" ] && continue
			CHANGES+=("$name")
		done
	fi
	SPECS=()
	if [ -d openspec/specs ]; then
		for entry in openspec/specs/*/; do
			[ -d "$entry" ] || continue
			SPECS+=("$(basename "$entry")")
		done
	fi
}

if [ "@@{1:-}" = "--version" ] || [ "@@{1:-}" = "-V" ]; then
	printf '%s\n' "$VERSION"
	exit 0
fi

if [ "$MODE" = "prompt-hang" ]; then
	# The interactive prompt: read until an answer arrives. Closed stdin makes
	# this an immediate EOF, which is exactly what the guard relies on.
	read -r _answer
	printf 'aborted: no change selected\n' >&2
	exit 1
fi

if [ "$MODE" = "nonzero" ]; then
	printf 'boom\n' >&2
	exit 1
fi

if [ "$MODE" = "malformed" ]; then
	printf 'No specs found.\n'
	exit 0
fi

collect

case "@@{1:-}" in
	instructions)
		# 'instructions apply --change <name> --json': the CLI's own answer about
		# how much of a change is left, plus the context paths it resolved.
		change=""
		while [ "$#" -gt 0 ]; do
			if [ "$1" = "--change" ]; then change="@@{2:-}"; fi
			shift
		done
		dir="openspec/changes/$change"
		if [ ! -d "$dir" ]; then
			printf 'no such change: %s\n' "$change" >&2
			exit 1
		fi
		total=0
		done_count=0
		if [ -f "$dir/tasks.md" ]; then
			done_count="$(grep -c -E '^[[:space:]]*-[[:space:]]*\[[xX]\][[:space:]]' "$dir/tasks.md" || true)"
			open_count="$(grep -c -E '^[[:space:]]*-[[:space:]]*\[[[:space:]]\][[:space:]]' "$dir/tasks.md" || true)"
			total=$((done_count + open_count))
		fi
		reported="$(cd "$dir" && pwd -P)"
		case "$MODE" in
			# The container's own view of the same directory, which is what the
			# bridge produces and what a host-path comparison used to refuse.
			bridge-change-dir) reported="/workspace/$dir" ;;
			# The same shape, a different change.
			foreign-change-dir) reported="/workspace/openspec/changes/$change-elsewhere" ;;
		esac
		printf '{\n  "changeName": "%s",\n  "changeDir": "%s",\n  "progress": {"total": %s, "complete": %s, "remaining": %s}\n}\n' \
			"$change" "$reported" "$total" "$done_count" "$((total - done_count))"
		;;
	archive)
		shift
		name=""
		for argument in "$@"; do
			case "$argument" in
				--*) ;;
				*) [ -z "$name" ] && name="$argument" ;;
			esac
		done
		if [ "$MODE" = "archive-noop" ]; then
			# The exact lie: a refusal reported as a success.
			printf 'Aborted. No files were changed.\n'
			exit 0
		fi
		if [ "$MODE" != "archive-drops-specs" ] && [ -d "openspec/changes/$name/specs" ]; then
			for capability in openspec/changes/"$name"/specs/*/; do
				[ -f "$capability/spec.md" ] || continue
				id="$(basename "$capability")"
				mkdir -p "openspec/specs/$id"
				sed 's/^## ADDED Requirements$/## Requirements/' "$capability/spec.md" \
					> "openspec/specs/$id/spec.md"
			done
		fi
		destination="openspec/changes/archive/$(date -u +%Y-%m-%d)-$name"
		if [ -e "$destination" ]; then
			# Specs first, destination check second, exit 0 regardless.
			printf 'Error: Archive already exists.\n' >&2
			exit 0
		fi
		mkdir -p openspec/changes/archive
		mv "openspec/changes/$name" "$destination"
		if [ "$MODE" = "archive-strays" ]; then
			printf 'stray\n' > stray-from-archive.txt
		fi
		printf "Change '%s' archived.\n" "$name"
		;;
	list)
		printf '{\n  "changes": [\n'
		first=1
		for name in @@{CHANGES[@]+"@@{CHANGES[@]}"}; do
			if [ "$first" -eq 0 ]; then printf ',\n'; fi
			first=0
			printf '    {"name": "%s", "completedTasks": 1, "totalTasks": 1, "status": "complete"}' "$name"
		done
		printf '\n  ]\n}\n'
		;;
	validate)
		case "$MODE" in
			zero-items) emit_items ;;
			phantom-item) emit_items @@{CHANGES[@]+"@@{CHANGES[@]}"} @@{SPECS[@]+"@@{SPECS[@]}"} "a-change-nobody-wrote" ;;
			*) emit_items @@{CHANGES[@]+"@@{CHANGES[@]}"} @@{SPECS[@]+"@@{SPECS[@]}"} ;;
		esac
		;;
	*)
		printf 'unsupported command: %s\n' "@@{1:-}" >&2
		exit 2
		;;
esac
`.replaceAll("@@{", () => "${");

/**
 * Install a fake CLI at `<root>/node_modules/.bin/openspec` and return its path.
 *
 * The location matters: the guard refuses a binary outside this repository's
 * `node_modules`, so a fixture that put it anywhere else would exercise the
 * refusal rather than the behaviour under test.
 */
export async function fakeOpenspecCli(
	root: string,
	mode: FakeOpenspecMode,
	version = "0.19.0",
): Promise<string> {
	const directory = resolve(root, "node_modules/.bin");
	await mkdir(directory, { recursive: true });
	const path = resolve(directory, "openspec");
	await Bun.write(
		path,
		SCRIPT.replaceAll("__MODE__", mode).replaceAll(
			"__VERSION__",
			mode === "wrong-version" ? "0.18.0" : version,
		),
	);
	await chmod(path, 0o755);
	return path;
}
