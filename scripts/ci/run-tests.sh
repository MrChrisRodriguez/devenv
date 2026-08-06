#!/usr/bin/env bash
# Run the project's test suite, treating "this project has no tests yet" as a
# reported fact rather than as a failure.
#
# Why this exists: `bun test` exits 1 when it matches zero test files. A freshly
# rendered project has none, so a bare `bun test` in CI is red on the first
# commit of every new repository. The workflow used to paper over that with
# `continue-on-error: true`, which is far worse than the problem: it also
# swallows every REAL failure the suite will ever report, for the entire life of
# the project, and nobody notices because the job is green.
#
# So the no-tests case is distinguished from the failure case here, once, in a
# committed script: zero matching files is announced as a notice and exits 0;
# anything else - failing tests, a crashing test file, a non-zero exit for any
# other reason - is passed straight through. Downstream projects keep this
# wrapper; it costs nothing after the first test file lands and it never hides a
# failure. Any argument given is forwarded to `bun test`.
#
# `set -e` is deliberately absent: the suite's exit code is captured into a
# variable so it can be classified before it is re-raised.
set -uo pipefail

output="$(bun test "$@" 2>&1)"
rc=$?

printf '%s\n' "$output"

if [ "$rc" -eq 0 ]; then
	exit 0
fi

# Bun reports `error: 0 test files matching <pattern> in --cwd=...` on stderr and
# exits 1. It is the only non-zero exit that is not a test result, so it is the
# only one this script is allowed to absorb. The match is deliberately narrow: a
# suite that ran and failed must never look like a suite that was not there.
if printf '%s' "$output" | grep -q "^error: 0 test files matching "; then
	echo "::notice::No test files matched yet; the suite reported nothing to run."
	exit 0
fi

exit "$rc"
