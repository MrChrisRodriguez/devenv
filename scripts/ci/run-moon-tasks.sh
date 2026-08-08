#!/usr/bin/env bash
# Run the declared moon tasks, treating "this graph has no tasks yet" as a
# reported fact rather than as a failure.
#
# Why this exists: `moon ci` words an empty pipeline two ways, and which one
# you get is a property of the checkout rather than of the project. On a pull
# request it has a base revision, reports "No tasks affected by changed files",
# and exits 0. On a default-branch push the clone is shallow, moon falls back
# to treating everything as affected, reports "No tasks found. Unable to
# execute action pipeline." for the requested targets - and exits 1, turning
# the empty graph every fresh render ships into a red push run.
#
# So the no-tasks case is distinguished from the failure case here, once, in a
# committed script: an empty pipeline is announced as a notice and exits 0;
# anything else - a failing task, a broken workspace, a non-zero exit for any
# other reason - is passed straight through. The moment a real project lands
# under apps/* or libs/*, its tasks resolve, and this wrapper never hides
# their failures. Any argument given is forwarded to `moon ci` as a target.
#
# `set -e` is deliberately absent: the pipeline's exit code is captured into a
# variable so it can be classified before it is re-raised.
set -uo pipefail

output="$(moon ci "$@" 2>&1)"
rc=$?

printf '%s\n' "$output"

if [ "$rc" -eq 0 ]; then
	exit 0
fi

# Both wordings are anchored on moon's own CAUTION banner and mean the same
# thing: zero tasks resolved, nothing was executed. Neither can be produced by
# a pipeline that ran a task and failed.
if printf '%s\n' "$output" |
	grep -qE 'No tasks (found\. Unable to execute action pipeline\.|affected by changed files)'; then
	echo "::notice::No moon tasks resolved yet; the pipeline reported nothing to run."
	exit 0
fi

exit "$rc"
