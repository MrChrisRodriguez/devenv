#!/usr/bin/env bash
# Lint every tracked shell script with shellcheck at warning severity.
#
# Why this exists: Biome owns TypeScript and JSON, and nothing owned the shell.
# The tree carries dozens of tracked .sh files — the worktree runtime, the CI
# helpers, the devcontainer lifecycle scripts — and the only syntax check any of
# them received was the worktree selftest's `bash -n` over its own directory. A
# linter that runs everywhere else but not on the scripts that build the
# container and gate the merge is a coverage hole shaped exactly like the
# scripts most likely to hide a quoting bug.
#
# The severity is warning, not error: the tree is clean at that level, and every
# deliberate deviation carries an inline `# shellcheck disable=` directive with
# a reason, so a new warning is a regression rather than noise.
#
# CI runners ship shellcheck in the image. A host that lacks it falls back to
# the digest-pinned container image so a laptop and a runner disagree about
# versions, not about availability; a host with neither is told so explicitly.
#
# `set -e` is deliberately absent: the linter's exit code is captured so the
# refusal can name the tool that produced it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

severity="${SHELLCHECK_SEVERITY:-warning}"

if ! git ls-files -- '*.sh' | grep -q .; then
	echo "::notice::No tracked shell scripts to lint."
	exit 0
fi

if command -v shellcheck >/dev/null 2>&1; then
	git ls-files -z -- '*.sh' | xargs -0 shellcheck --severity="$severity" --
	rc=$?
elif command -v docker >/dev/null 2>&1; then
	git ls-files -z -- '*.sh' | xargs -0 docker run --rm \
		--volume "$PWD:/mnt:ro" --workdir /mnt \
		koalaman/shellcheck@sha256:bb596a0d169b85ddd81d8b6d3a2ff6d5baf5fca10b97f575ebc647c3dff62b3d \
		--severity="$severity" --
	rc=$?
else
	echo "::error::shellcheck is not installed and docker is unavailable to run its pinned image" >&2
	exit 1
fi

if [ "$rc" -ne 0 ]; then
	echo "::error::shellcheck reported findings at severity '$severity'; fix them or add a reasoned inline directive" >&2
fi
exit "$rc"
