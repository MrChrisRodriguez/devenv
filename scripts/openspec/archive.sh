#!/usr/bin/env bash
# Archive one completed OpenSpec change, or refuse before anything is touched.
#
# This is a HOST script. Git work — branch, status, fetch, commit, push — is
# host work by definition, and everything that needs this repository's pinned
# tooling goes through the worktree bridge instead. The single injection point
# is OPENSPEC_BRIDGE: unset it is the git hooks' own `--require-ready` bridge,
# and set to the empty string it runs in place, which is what the tests and a
# throwaway clone use.
#
# The order below is the safety property, not a style choice:
#
#   1. usage
#   2. environment refusals (a cloud task and a container are both wrong here)
#   3. readiness preflight — the bridged git hooks would otherwise strand an
#      uncommitted archive in a checkout whose container is down
#   4. every git precondition, all of them before a single bridged call
#   5. selection, which must be explicit the moment it is ambiguous
#   6. completion, delta assessment and the duplicate-destination pre-check
#
# `openspec archive` cannot be trusted to do 6 itself: it applies the delta
# specs to openspec/specs/** BEFORE it checks whether the destination exists,
# and it RETURNS 0 when it does — leaving the main specs rewritten, the change
# still active, and an exit status that says everything went fine.
#
# Usage:
#   bash scripts/openspec/archive.sh [--change <name>] [--root <dir>] [--dry-run]
#
# Exit status:
#   0 archived (or, with --dry-run, reported)
#   2 unsupported argument
#   3 wrong environment: a Codex Cloud task or inside the development container
#   4 this checkout's container is not ready
#   5 a git precondition refused the run
#   6 the change selection is ambiguous or unknown
#   7 the change still has remaining tasks
#   8 the archive destination is already occupied
#   9 the archive did not verify and was rolled back
#  10 the push was refused
#  11 the push did not verify against the remote

set -euo pipefail

LABEL="OpenSpec archive"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# The one injection point, spelled once. `${VAR-default}` rather than
# `${VAR:-default}` on purpose: an explicitly empty OPENSPEC_BRIDGE means "run
# in place" and must not fall back to the bridge.
BRIDGE="${OPENSPEC_BRIDGE-bash scripts/worktree/exec.sh --require-ready}"
OPENSPEC_RELATIVE_BIN="node_modules/.bin/openspec"

CHANGE=""
ROOT_ARGUMENT=""
DRY_RUN="false"

usage() {
	sed -n '/^# Usage:/,/^#  11 /p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

die() {
	printf '%s: %s\n' "$LABEL" "$1" >&2
	exit "${2:-1}"
}

note() {
	printf '%s: %s\n' "$LABEL" "$1" >&2
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--change)
			[ "$#" -ge 2 ] || die "--change needs a change name" 2
			CHANGE="$2"
			shift 2
			;;
		--root)
			[ "$#" -ge 2 ] || die "--root needs a directory" 2
			ROOT_ARGUMENT="$2"
			shift 2
			;;
		--dry-run)
			DRY_RUN="true"
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			usage
			exit 2
			;;
	esac
done

# ── 2. Environment ──────────────────────────────────────────────────────────
# Both refusals are about who owns the git remote. A hosted cloud task must
# never push, and a container has no business running the host half of a
# release step: the checkout is bind mounted, so the host sees the same bytes
# and owns the credentials.
# The cloud arm is fenced because the marker variable is a declared capability
# signature and the anti-residue scan is a plain substring search: one unfenced
# mention here would fail every render that has no cloud. The stripped remainder
# is still valid bash, which is the other requirement of a line-based fence.
# capability:start codex_cloud
if [ "${CODEX_CLOUD:-}" = "true" ]; then
	die "a Codex Cloud task must not archive; run this on the host that owns the remote" 3
fi
# capability:end codex_cloud
if [ "${DEVCONTAINER:-}" = "true" ]; then
	die "run this on the host, not inside the development container" 3
fi

# ── 3. Readiness ────────────────────────────────────────────────────────────
# Preflighted here rather than discovered at the first bridged call. The git
# hooks route through `exec.sh --require-ready` too, so a checkout whose
# container is down would archive the tree, then fail at `git commit` and leave
# the change moved and uncommitted — the one state this script exists to avoid.
if [ -n "$BRIDGE" ]; then
	if ! $BRIDGE true >/dev/null 2>&1; then
		die "this checkout's container is not ready; run bash scripts/worktree/up.sh" 4
	fi
fi

openspec_cli() {
	if [ -n "$BRIDGE" ]; then
		# Word splitting is the point: OPENSPEC_BRIDGE records a command line.
		# `env` runs INSIDE the bridge, because the bridge hands the container an
		# explicit allow-list and a host-side export would never arrive.
		# shellcheck disable=SC2086
		$BRIDGE env OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 CI=true \
			"./$OPENSPEC_RELATIVE_BIN" "$@"
	else
		env OPENSPEC_TELEMETRY=0 DO_NOT_TRACK=1 CI=true \
			"./$OPENSPEC_RELATIVE_BIN" "$@"
	fi
}

# ── 4. Git preconditions ────────────────────────────────────────────────────
# `.moon/workspace.yml` is the committed authority for the default branch and
# the graph contract already ties it to `template-parameters.toml`. Reading it
# with sed keeps the wrapper free of a project identity and of any tooling that
# only exists inside the container.
default_branch() {
	local value
	value="$(sed -n '/^vcs:/,$ s/^[[:space:]]*defaultBranch:[[:space:]]*['"'"'"]\{0,1\}\([^'"'"'"]*\)['"'"'"]\{0,1\}[[:space:]]*$/\1/p' .moon/workspace.yml 2>/dev/null | head -1)"
	printf '%s' "${value:-main}"
}

DEFAULT_BRANCH="$(default_branch)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "$DEFAULT_BRANCH" ]; then
	die "archive runs on $DEFAULT_BRANCH only; this checkout is on $BRANCH" 5
fi

# Untracked files count, and so does graphify-out/. A dirty graph directory is
# the ordinary state after a hook run, and staging it alongside an archive is
# exactly what the pre-commit guard rejects — so the refusal names both ways
# out rather than leaving the operator to guess.
if [ -n "$(git status --porcelain)" ]; then
	die "the working tree is not clean; run \`git restore graphify-out\` or \`git stash\` and try again" 5
fi

if ! git rev-parse --verify --quiet "refs/remotes/origin/$DEFAULT_BRANCH" >/dev/null; then
	die "origin/$DEFAULT_BRANCH does not exist in this clone" 5
fi

git fetch --prune --quiet origin

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "refs/remotes/origin/$DEFAULT_BRANCH")"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
	if git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
		die "HEAD is behind origin/$DEFAULT_BRANCH; run \`git pull --ff-only\` and try again" 5
	fi
	if git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
		die "HEAD is ahead of origin/$DEFAULT_BRANCH; push or reset before archiving" 5
	fi
	die "HEAD and origin/$DEFAULT_BRANCH have diverged; reconcile them before archiving" 5
fi

# ── 5. Selection ────────────────────────────────────────────────────────────
# The walk mirrors scripts/template/openspec-contract.ts. tmp/ is pruned because
# `template:fixtures` renders there and a rendered fixture carries its own
# config.yaml — walking into it would invent a root no commit owns.
openspec_roots() {
	find . \
		\( -name .git -o -name node_modules -o -name tmp -o -name graphify-out -o -name dist \) -prune \
		-o -type f -name config.yaml -print 2>/dev/null |
		sed -n 's|^\./\(.*\)/config\.yaml$|\1|p' |
		grep -E '(^|/)openspec$' |
		sort
}

active_changes() {
	local root="$1" entry name
	[ -d "$root/changes" ] || return 0
	for entry in "$root"/changes/*/; do
		[ -d "$entry" ] || continue
		name="$(basename "$entry")"
		[ "$name" = "archive" ] && continue
		printf '%s\n' "$name"
	done
}

# No `mapfile`: it does not exist in the bash 3.2 that ships with macOS, and
# every other runtime script here stays inside that dialect.
ROOTS=()
while IFS= read -r line; do
	[ -n "$line" ] && ROOTS+=("$line")
done < <(openspec_roots)
if [ "${#ROOTS[@]}" -eq 0 ]; then
	die "no openspec/config.yaml exists in this checkout" 6
fi

if [ -n "$ROOT_ARGUMENT" ]; then
	ROOT_ARGUMENT="${ROOT_ARGUMENT%/}"
	found="false"
	for root in ${ROOTS[@]+"${ROOTS[@]}"}; do
		[ "$root" = "$ROOT_ARGUMENT" ] && found="true"
	done
	[ "$found" = "true" ] || die "--root $ROOT_ARGUMENT is not an OpenSpec root in this checkout" 6
	ROOTS=("$ROOT_ARGUMENT")
fi

CANDIDATES=()
for root in ${ROOTS[@]+"${ROOTS[@]}"}; do
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		CANDIDATES+=("$root|$name")
	done < <(active_changes "$root")
done

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
	die "there is no active change to archive" 6
fi

SELECTED=()
if [ -n "$CHANGE" ]; then
	for candidate in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
		[ "${candidate#*|}" = "$CHANGE" ] && SELECTED+=("$candidate")
	done
	if [ "${#SELECTED[@]}" -eq 0 ]; then
		note "active changes:"
		for candidate in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
			note "  ${candidate%%|*} -> ${candidate#*|}"
		done
		die "no active change named $CHANGE" 6
	fi
	if [ "${#SELECTED[@]}" -gt 1 ]; then
		note "the change $CHANGE exists in more than one root:"
		for candidate in ${SELECTED[@]+"${SELECTED[@]}"}; do
			note "  ${candidate%%|*}"
		done
		die "pass --root <dir> to say which one" 6
	fi
else
	if [ "${#CANDIDATES[@]}" -gt 1 ]; then
		note "this checkout has more than one active change:"
		for candidate in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
			note "  ${candidate%%|*} -> ${candidate#*|}"
		done
		die "pass --change <name> to say which one" 6
	fi
	SELECTED=("${CANDIDATES[0]}")
fi

ROOT="${SELECTED[0]%%|*}"
CHANGE="${SELECTED[0]#*|}"
CHANGE_DIR="$ROOT/changes/$CHANGE"
WORKING_DIRECTORY="$(dirname "$ROOT")"

# ── 6a. Completion ──────────────────────────────────────────────────────────
# The CLI is the authority on what "complete" means for a schema, so the count
# comes from `instructions apply --json` rather than from this script counting
# checkboxes. Its `changeDir` is checked too: an answer about a different
# directory is not an answer about this change.
instructions="$(cd "$WORKING_DIRECTORY" && openspec_cli instructions apply --change "$CHANGE" --json 2>/dev/null || true)"
remaining="$(printf '%s\n' "$instructions" | tr -d ' \t' | sed -n 's/.*"remaining":\([0-9][0-9]*\).*/\1/p' | head -1)"
reported_dir="$(printf '%s\n' "$instructions" | tr -d ' \t' | sed -n 's/.*"changeDir":"\([^"]*\)".*/\1/p' | head -1)"
if [ -z "$remaining" ]; then
	die "\`openspec instructions apply --change $CHANGE --json\` reported no task progress" 7
fi
if [ -n "$reported_dir" ] && [ "$(cd "$CHANGE_DIR" && pwd -P)" != "$(cd "$reported_dir" 2>/dev/null && pwd -P || printf '%s' "$reported_dir")" ]; then
	die "the CLI reported the change directory $reported_dir, not $CHANGE_DIR" 7
fi
if [ "$remaining" != "0" ]; then
	die "$CHANGE still has $remaining remaining task(s); finish them before archiving" 7
fi

# ── 6b. Delta assessment ────────────────────────────────────────────────────
# `--skip-specs` is correct for exactly one case: a change with no delta specs
# at all. Passed with deltas present it archives the proposal and silently
# drops the requirements the proposal promised.
DELTA_CAPABILITIES=()
if [ -d "$CHANGE_DIR/specs" ]; then
	for entry in "$CHANGE_DIR"/specs/*/; do
		[ -f "$entry/spec.md" ] || continue
		DELTA_CAPABILITIES+=("$(basename "$entry")")
	done
fi
ARCHIVE_ARGUMENTS=("$CHANGE" "--yes")
if [ "${#DELTA_CAPABILITIES[@]}" -eq 0 ]; then
	ARCHIVE_ARGUMENTS+=("--skip-specs")
fi

# ── 6c. Duplicate destination ───────────────────────────────────────────────
# UTC, because the CLI stamps `new Date().toISOString()`. A local date is wrong
# for several hours a day, and being wrong here means pre-checking a
# destination the CLI will not use.
ARCHIVE_DATE="$(date -u +%Y-%m-%d)"
ARCHIVE_DESTINATION="$ROOT/changes/archive/$ARCHIVE_DATE-$CHANGE"
archive_destination_exists() {
	[ -e "$ARCHIVE_DESTINATION" ]
}
if archive_destination_exists; then
	die "$ARCHIVE_DESTINATION already exists; the CLI would rewrite the main specs and archive nothing" 8
fi

# ── 6d. Commit subject ──────────────────────────────────────────────────────
# Checked here rather than after the archive, even though the plan's order puts
# it later: the subject is computable from the change name alone, and refusing
# after a mutation is a worse refusal than refusing before one. Commitlint caps
# the header at 72 characters, and a commit that cannot be written is a commit
# whose archive would have to be rolled back.
COMMIT_SUBJECT="chore(openspec): archive $CHANGE"
if [ "${#COMMIT_SUBJECT}" -gt 72 ]; then
	die "the commit subject \"$COMMIT_SUBJECT\" is ${#COMMIT_SUBJECT} characters; commitlint caps the header at 72" 6
fi

printf '%s\n' "$LABEL: $CHANGE in $ROOT"
printf '%s\n' "  tasks remaining: $remaining"
if [ "${#DELTA_CAPABILITIES[@]}" -eq 0 ]; then
	printf '%s\n' "  delta specs: none (--skip-specs)"
else
	printf '%s\n' "  delta specs: ${DELTA_CAPABILITIES[*]}"
fi
printf '%s\n' "  destination: $ARCHIVE_DESTINATION"

if [ "$DRY_RUN" = "true" ]; then
	printf '%s\n' "$LABEL: --dry-run, nothing was changed"
	exit 0
fi

# ── 7. Archive ──────────────────────────────────────────────────────────────
# Scoped to this root and to HEAD. Nothing outside the OpenSpec root is ever
# touched, so a restore can never take an unrelated edit with it — which is
# also why the clean-tree refusal above is unconditional: with a dirty tree
# this rollback would not be safe to run.
restore_openspec_root() {
	note "restoring $ROOT to HEAD and removing anything the CLI left behind"
	git restore --source=HEAD --staged --worktree -- "$ROOT" || true
	git clean -qfd -- "$ROOT" || true
}

# The CLI's exit code says nothing. It RETURNS 0 after "Aborted. No files were
# changed." and it RETURNS 0 after writing the main specs and then finding the
# destination occupied. The post-state below is the only evidence that counts.
if ! (cd "$WORKING_DIRECTORY" && openspec_cli archive "${ARCHIVE_ARGUMENTS[@]}"); then
	restore_openspec_root
	die "\`openspec archive $CHANGE\` failed; $ROOT was restored" 9
fi

verification_failed() {
	restore_openspec_root
	die "$1" 9
}

if [ -e "$CHANGE_DIR" ]; then
	verification_failed "the CLI exited 0 but $CHANGE_DIR is still there; nothing was archived"
fi
if [ ! -d "$ARCHIVE_DESTINATION" ]; then
	verification_failed "the CLI exited 0 but $ARCHIVE_DESTINATION does not exist"
fi
if [ -z "$(ls -A "$ARCHIVE_DESTINATION" 2>/dev/null)" ]; then
	verification_failed "$ARCHIVE_DESTINATION is empty"
fi
while IFS= read -r line; do
	[ -n "$line" ] || continue
	path="${line:3}"
	case "$path" in
		"$ROOT"/*) ;;
		*) verification_failed "the archive touched $path, which is outside $ROOT" ;;
	esac
done < <(git status --porcelain --untracked-files=all)

# ── 8. Validate, then commit ────────────────────────────────────────────────
# Across EVERY root, not just the one that changed: applying delta specs
# rewrites openspec/specs/**, and the guard's archive-hygiene rules are the
# only thing that looks at what the CLI just wrote.
if [ -n "$BRIDGE" ]; then
	# shellcheck disable=SC2086
	validation_ok="$($BRIDGE bun run openspec:check >/dev/null 2>&1 && printf 'true' || printf 'false')"
else
	validation_ok="$(bun run openspec:check >/dev/null 2>&1 && printf 'true' || printf 'false')"
fi
if [ "$validation_ok" != "true" ]; then
	restore_openspec_root
	die "openspec:check failed on the archived tree; $ROOT was restored and nothing was committed" 9
fi

git add -A -- "$ROOT"
while IFS= read -r path; do
	[ -n "$path" ] || continue
	case "$path" in
		"$ROOT"/*) ;;
		*) verification_failed "$path was staged, but only $ROOT may be" ;;
	esac
done < <(git diff --cached --name-only)

# No --no-verify, ever. The hooks are how this repository formats and checks a
# commit, and the archive commit is the one commit nobody reviews.
git commit --quiet -m "$COMMIT_SUBJECT"
ARCHIVE_COMMIT="$(git rev-parse HEAD)"

# ── 9. Push ─────────────────────────────────────────────────────────────────
# Re-fetched, because the checks above took time and the remote is shared. The
# new commit's parent must still be exactly what origin has, or this push would
# be a force in disguise.
git fetch --prune --quiet origin
REMOTE_HEAD="$(git rev-parse "refs/remotes/origin/$DEFAULT_BRANCH")"
if [ "$(git rev-parse "$ARCHIVE_COMMIT^")" != "$REMOTE_HEAD" ]; then
	note "origin/$DEFAULT_BRANCH moved while this archive was being validated."
	note "The archive commit $ARCHIVE_COMMIT is kept. Rebase it and push, or reset with:"
	note "  git reset --hard origin/$DEFAULT_BRANCH"
	die "refusing to push a commit whose parent is no longer origin/$DEFAULT_BRANCH" 10
fi

if ! git push --quiet origin "HEAD:refs/heads/$DEFAULT_BRANCH"; then
	# Branch protection can reject this, and that is a supported outcome rather
	# than a bug: the commit stays, and the next run refuses on HEAD != origin
	# until the operator picks one of these. Self-healing by construction.
	note "the push was rejected. The archive commit $ARCHIVE_COMMIT is kept locally."
	note "Choose one:"
	note "  - push it as an administrator"
	note "  - open a pull request:  git switch -c chore/archive-$CHANGE && git push -u origin HEAD"
	note "  - discard it:           git reset --hard origin/$DEFAULT_BRANCH"
	die "push rejected" 10
fi

# ── 10. Read the remote back ────────────────────────────────────────────────
# A push that returned 0 is a claim about a local process, not about the
# remote. Credential presence and a zero exit status are both necessary and
# neither is sufficient: the only thing that establishes the final state is
# asking the remote what it now holds and comparing it, exactly, with what this
# run intended to put there. A hook that rewrote the ref, a mirror that
# answered for a stale replica and a proxy that accepted and dropped the pack
# all return 0 to the pusher.
#
# The query is read-only and separate from the write on purpose — a verifier
# folded into the writer can only confirm what the writer already believed —
# and it is assigned ONCE, because a superseded assignment would compare a
# value the remote never produced. `|| true` keeps `pipefail` from turning an
# unreachable remote into an undiagnosed abort: an empty readback is a
# mismatch, and it is reported as one.
REMOTE_AFTER="$(git ls-remote --exit-code origin "refs/heads/$DEFAULT_BRANCH" 2>/dev/null | awk '{ print $1 }' || true)"
if [ "$REMOTE_AFTER" != "$ARCHIVE_COMMIT" ]; then
	note "the push returned 0 but origin/$DEFAULT_BRANCH reads back as ${REMOTE_AFTER:-<unreadable>}, not $ARCHIVE_COMMIT."
	note "The archive commit $ARCHIVE_COMMIT is kept locally. Choose one:"
	note "  - re-run this command once the remote is reachable and settled"
	note "  - open a pull request:  git switch -c chore/archive-$CHANGE && git push -u origin HEAD"
	note "  - discard it:           git reset --hard origin/$DEFAULT_BRANCH"
	die "the archive push did not verify against the remote" 11
fi

printf '%s\n' "$LABEL: archived $CHANGE to $ARCHIVE_DESTINATION and pushed $ARCHIVE_COMMIT"
