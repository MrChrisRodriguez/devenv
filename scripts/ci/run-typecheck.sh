#!/usr/bin/env bash
# Typecheck the project, treating "this project has no source files yet" as a
# reported fact rather than as a failure.
#
# Same shape, and the same reason, as scripts/ci/run-tests.sh. `tsc -p` exits
# non-zero with TS18003 ("No inputs were found in config file") when every
# `include` pattern matches nothing, which is exactly the state of a freshly
# rendered project: `apps/`, `libs/` and `scripts/` carry no TypeScript until
# somebody writes some. A workflow that ran `tsc` bare would be red on the first
# commit of every new repository, and the old repair for that — a step-level
# `continue-on-error` — buys the empty case by also swallowing every real type
# error the project will ever have.
#
# So the empty-project case is classified here, once, in a committed script, and
# nothing else is: any other non-zero exit is passed straight through. The check
# is narrow on purpose. TS18003 is the only tsc failure that means "there was
# nothing to check"; every other diagnostic means "the check found something".
#
# The project the compiler checks is tsconfig.json at the repository root, which
# deliberately excludes `scripts/template` — that subtree is a separate project
# with its own tsconfig, and one file belongs to one project.
#
# `set -e` is deliberately absent: the compiler's exit code is captured into a
# variable so it can be classified before it is re-raised.
set -uo pipefail

output="$(bunx tsc -p tsconfig.json "$@" 2>&1)"
rc=$?

printf '%s\n' "$output"

if [ "$rc" -eq 0 ]; then
	exit 0
fi

if printf '%s' "$output" | grep -q "error TS18003:"; then
	echo "::notice::No TypeScript sources matched yet; the compiler had nothing to check."
	exit 0
fi

exit "$rc"
