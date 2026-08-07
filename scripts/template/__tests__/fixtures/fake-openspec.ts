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
 */
export type FakeOpenspecMode =
	| "faithful"
	| "zero-items"
	| "phantom-item"
	| "wrong-version"
	| "malformed"
	| "nonzero"
	| "prompt-hang";

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
