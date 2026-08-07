#!/usr/bin/env bash
# Emit the CI matrices the heavy lane is built from — the ONE file allowed to
# write matrix keys to $GITHUB_OUTPUT.
#
# SELECTION ONLY. The matrix jobs still run lint, the compiler and the suite
# themselves; this decides which entries those jobs have. The selection itself
# is computed by the committed selector (scripts/template/select-affected.ts),
# which derives it from the project graph and reconciles it with moon. Nothing
# here re-implements that decision, because two implementations of "what must
# run" would disagree exactly once, quietly, on the sole required gate.
#
# SAFETY, in the two directions that are not symmetric:
#
#   FAIL-OPEN. Any fault — a selector crash, a missing toolchain, a parse
#   failure, an unexpected exit — emits the FULL matrix and exits 0. Running
#   everything is always a safe answer, so uncertainty resolves toward more.
#
#   FAIL-CLOSED, exactly once. A missing, unreadable or malformed universe
#   registry is the one thing we cannot fail open out of: without it this script
#   does not KNOW the full set, so "emit full" would emit EMPTY — every project
#   skipped on the required gate, reported green. It exits 1 with NO output, so
#   the job fails and the gate blocks. Fail-closed-SAFE, never
#   fail-closed-SILENT. That check runs BEFORE the ERR trap is installed, or the
#   trap would convert the one deliberate hard failure into a silent full-green.
#
# Every input arrives through the environment and never through workflow
# interpolation: MOON_AFFECTED_MODE, EVENT_NAME, BASE_SHA, HEAD_SHA. Pull
# request metadata is attacker-influenced text, and interpolated into a run:
# body it would be spliced into the script the runner executes.
#
# GITHUB_OUTPUT defaults to /dev/stdout so this file can be executed directly.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
REGISTRY="${ROOT}/ci-matrix-universes.json"
SELECTOR="scripts/template/select-affected.ts"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
PREFLIGHT_EXIT_CODE=2

die_closed() {
	echo "affected-matrices: ${1} Failing CLOSED (exit 1, no output) so the gate blocks rather than silently skipping every project." >&2
	exit 1
}

# ── PREFLIGHT (fail-closed, before the ERR trap) ─────────────────────────────
[ -r "$REGISTRY" ] || die_closed "'${REGISTRY}' is missing or unreadable."
UNIVERSE_IDS="$(jq -r '.universes[].id' "$REGISTRY" 2>/dev/null | tr '\n' ' ' || true)"
[ -n "${UNIVERSE_IDS// /}" ] ||
	die_closed "'${REGISTRY}' declares no universe."
for _id in $UNIVERSE_IDS; do
	_projects="$(jq -r --arg k "$_id" '.universes[] | select(.id == $k) | .projects[]' "$REGISTRY" 2>/dev/null | tr '\n' ' ' || true)"
	[ -n "${_projects// /}" ] ||
		die_closed "universe '${_id}' in '${REGISTRY}' lists no project."
done

# ── Emission ─────────────────────────────────────────────────────────────────
say() {
	echo "affected-matrices: $*" >&2
	printf '%s\n' "affected-matrices: $*" >>"$SUMMARY"
}

emit_full() {
	{
		echo "mode=full"
		echo "reason=${1}"
		for _id in $UNIVERSE_IDS; do
			printf '%s=%s\n' "$_id" "$(jq -c --arg k "$_id" '[.universes[] | select(.id == $k) | .projects[]] | sort' "$REGISTRY")"
		done
	} >>"$OUT"
}

# FAIL-OPEN backstop. The trap is cleared inside the handler first, so a fault
# in emit_full cannot re-enter it forever.
# shellcheck disable=SC2154
trap 'rc=$?; trap - ERR; echo "affected-matrices: ERROR (rc=${rc}) — failing open to FULL" >&2; emit_full trap-fail-open; exit 0' ERR

selection="$(mktemp)"
narration="$(mktemp)"
cleanup() { rm -f "$selection" "$narration"; }
trap cleanup EXIT

# The selector's own exit status is captured rather than trapped, because two of
# its outcomes need opposite answers: the preflight code is the deliberate hard
# stop, everything else is a fault to fail open on.
rc=0
(cd "$ROOT" && bun "$SELECTOR" --json) >"$selection" 2>"$narration" || rc=$?
cat "$narration" >&2
{
	echo '```'
	cat "$narration"
	echo '```'
} >>"$SUMMARY"

if [ "$rc" -eq "$PREFLIGHT_EXIT_CODE" ]; then
	trap - ERR
	die_closed "the selector refused the universe registry."
fi
if [ "$rc" -ne 0 ]; then
	say "selector exited ${rc} → FULL"
	emit_full selector-failed
	exit 0
fi
if ! jq -e 'has("mode") and has("reason") and has("universes")' "$selection" >/dev/null 2>&1; then
	say "selector produced no usable selection → FULL"
	emit_full selector-unreadable
	exit 0
fi

{
	printf 'mode=%s\n' "$(jq -r '.mode' "$selection")"
	printf 'reason=%s\n' "$(jq -r '.reason' "$selection")"
	for _id in $UNIVERSE_IDS; do
		printf '%s=%s\n' "$_id" "$(jq -c --arg k "$_id" '.universes[$k] // []' "$selection")"
	done
} >>"$OUT"
