#!/usr/bin/env bash
# Decide the one required status check from the results of every job that fed it.
#
# The gate job runs with `if: always()` so it ALWAYS reports: a docs-only push
# whose heavy jobs were skipped, or a draft pull request whose gating jobs never
# ran, must never strand a required check in a perpetually pending state. That
# makes the decision here the whole contract, so it lives in a committed script
# that can be executed and mutated in a test rather than in an inline `run:`
# body that can only be read.
#
# Input is env only, never interpolation:
#   RESULTS  comma-separated `join(needs.*.result, ',')` from the workflow
#   DRAFT    `github.event.pull_request.draft`, empty on a push
# Pull-request metadata is attacker-influenced text. Interpolating it into a
# shell body would splice that text into the script the runner executes; passed
# through `env:` it is only ever a value.
#
# Verdicts:
#   every result in {success, skipped}, not a draft -> 0
#   any failure or cancelled                        -> 1
#   RESULTS empty                                   -> 1  (nothing fed the gate:
#                                                          a green here would be
#                                                          a gate over nothing)
#   DRAFT true                                      -> 1  (see below)
#
# The draft check is not redundant with the results check. Gating jobs carry
# `if: !draft`, so on a draft they all report `skipped` and the results check
# alone would pass - and a green required check would let the pull request merge
# the instant it is marked ready, BEFORE the ready_for_review run revalidates
# anything. Drafts cannot merge anyway; this makes the required check
# unambiguously not-green until the PR is ready and has actually been checked.
set -euo pipefail

results="${RESULTS:-}"
draft="${DRAFT:-}"

if [ "$draft" = "true" ]; then
	echo "::error::This pull request is a draft, so the gating jobs were skipped. Mark it ready for review to validate it; the required check stays red until then." >&2
	exit 1
fi

if [ -z "$results" ]; then
	echo "::error::The gate received no upstream results. Every job in this workflow must appear in the gate's needs list." >&2
	exit 1
fi

echo "upstream results: ${results}"

failed=0
IFS=',' read -ra observed <<<"$results"
for result in "${observed[@]}"; do
	case "$result" in
	success | skipped) ;;
	"")
		echo "::error::The gate received an empty upstream result." >&2
		failed=1
		;;
	*)
		echo "::error::A required job did not pass (result=${result})." >&2
		failed=1
		;;
	esac
done

if [ "$failed" -ne 0 ]; then
	exit 1
fi

echo "Every required job passed or was skipped."
