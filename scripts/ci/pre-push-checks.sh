#!/usr/bin/env bash
# Run every contract guard this tree declares before a push leaves the machine.
#
# Why this exists: the pre-commit hook formats and the commit-msg hook checks
# the message, but every `*:check` guard used to run only in CI — a push was the
# first moment a broken contract was discovered, one round trip too late. This
# script is the local half of CI's fixed-cost contract lane: the same hermetic
# guards, run where the pinned toolchain lives, before the remote hears
# anything.
#
# The guard list is read from package.json rather than spelled here, because
# most guards are capability-gated: a rendered project carries only the checks
# its profile enabled, and a hardcoded list would name scripts that render did
# not receive. Whatever `*:check` scripts this tree declares is exactly what
# runs.
#
# `template:validate` is additionally run in the template repository itself —
# recognized the same way the guards recognize it, by the presence of
# template-parameters.toml — and never in a render, where the `template:` prefix
# has already removed the script and its inputs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ -f template-parameters.toml ]; then
	echo "pre-push: bun run template:validate"
	bun run template:validate
fi

while IFS= read -r script; do
	[ -n "$script" ] || continue
	echo "pre-push: bun run $script"
	bun run "$script"
done < <(bun -e 'const s = require("./package.json").scripts ?? {}; for (const k of Object.keys(s)) if (k.endsWith(":check")) console.log(k);')
