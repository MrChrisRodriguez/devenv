# Stage 8B Moon affected selection

Stage 8A proved the project graph. Stage 8B is the first stage allowed to
*select* on it: the heavy CI lane is derived from that graph, moon is consulted
as a second opinion that may only widen the answer, and the whole thing sits
behind one repository variable that fails safe to the old all-or-nothing
behaviour when it is unset.

```sh
bun run affected:check     # static: wiring, registry, ownership, the recorded mode
bun run affected:select    # the selection this tree would emit right now
bash scripts/ci/affected-matrices.sh   # the CI entrypoint, directly runnable
```

Nothing under `.devcontainer/**` changed in this stage, so adopting it costs
**no container rebuild**. Unlike every stage before it, this one *does* have
something outside the tree — see [Rollback](#rollback).

## Our selector is authoritative; moon may only widen it

`scripts/template/affected-contract.ts` exports `selectAffected`, which answers
"which projects does this pull request reach" from the **committed** graph —
`classifyPath` for ownership, then a reverse-reachability closure over the
derived edges — and never from moon. That order is the whole design. Stage 8A
exists because a guard that asked moon what the graph is could only ever agree
with moon; a selector that adopted moon's number would inherit exactly that
circularity on the one decision that can skip the required suite.

Read the order below as a series of reasons to give up on narrowing, each of
which resolves to **FULL**:

1. the **universe registry** is unusable — the one fail-CLOSED step, see below;
2. the mode is not `moon` (the rollback switch, and the default);
3. the event carries no base describing the change under review — `pull_request`
   and `merge_group` are the whole table, so a push to the default branch, a
   schedule, a deployment, a dispatch and every event nobody has written yet are
   all FULL;
4. the base or head is not a 40-hex object this clone actually has;
5. `git merge-base` or `git diff` failed;
6. a changed path is a **global input**;
7. the diff found nothing — which is not evidence that nothing changed, it is
   also what a wrong base looks like.

Two details in the diff are load-bearing. It runs from the **merge base**, not
the base branch's tip, so a stacked pull request is never charged with the
commits its base branch gained since the branch point. And it passes
`--no-renames`, so a file moved between projects yields the old path *and* the
new one — without it git reports a single rename entry and the project the file
**left** is never rebuilt.

### A repository-wide project ends the selection

Every workspace here declares one (`sources.root: '.'` is what keeps the graph
non-empty), it contains every other project, and it is what an unrecognised
top-level file falls to. Seeding it would say "a brand-new root config affects
the root project only" — the exact silent skip a catch-all exists to prevent.

It is also what makes moon's answer comparable at all: a project rooted at `.`
is affected by literally every changed file, so a comparison that did not
exclude it would disagree on every pull request and the narrow answer could
never stand.

**Consequence for this repository specifically:** the only project here *is* the
root, so affected selection has exactly two outcomes — FULL for any code change,
and empty for a documentation-only one. That is honest rather than broken, and
it is what the sealed live evidence shows.

## One failure is fail-CLOSED

An unusable matrix universe registry — missing, unparseable, or one the graph
contract rejects — exits non-zero with **no output at all**. Every other path
fails open to FULL because running everything is always a safe answer; this one
cannot, because without the registry the selector does not *know* the full set,
so "emit FULL" would emit **empty**: every project silently skipped on the sole
required gate, reported green. Fail-closed-SAFE, never fail-closed-SILENT.

Two properties make that real rather than intended. The preflight runs **before**
the `ERR` trap is installed, or the trap would convert the one deliberate hard
exit into a silent full-green run. And the selector's exit status is *captured*
rather than trapped, because two of its outcomes need opposite answers: exit `2`
is the hard stop, everything else is a fault to fail open on.

## Moon is a second opinion, and it may only widen

`reconcileWithMoon` runs the pinned argv with the changed files on stdin:

```
moon query projects --affected --downstream deep --quiet
```

**Every** abnormal outcome widens to FULL: a binary that is not there, a non-zero
exit, silence, output that is not JSON, JSON in an unrecognised shape, a set
narrower than ours, and a set wider than ours. A narrower answer is a widening
too — moon's number is never adopted; we only refuse to be narrower than a
disagreement allows. Each abnormal outcome told the selector *nothing*, and "we
learned nothing" must not read as "the narrow answer is confirmed".

Three details make the comparison meaningful rather than merely strict:

- moon is fed the **seed** files, not the whole diff. It has no notion of
  documentation, so a changed `.md` would resolve to whichever project contains
  it and disagree on every documentation-only pull request.
- an empty seed list means moon is **not called at all**. With empty stdin the
  real binary does not answer "nothing affected" — it falls back to **working
  tree** detection. Sealed in both directions in the evidence: an empty pipe over
  a clean tree reported nothing, and the same pipe with one uncommitted edit
  reported the project owning that edit. On a clean CI checkout that is a
  confident, silent "run nothing" with exit `0`.
- projects rooted at the repository are excluded from moon's answer, for the
  reason above.

`MOON_BASE`/`MOON_HEAD` carry the resolved merge base and head. They have the
highest precedence in moon's own base resolution, which matters because moon
honours `GITHUB_BASE_REF` over the workspace's pinned `vcs.defaultBranch` — so
without them a stacked pull request could be diffed against a branch this
selection never looked at.

### `setup-moon` creates the base refs before moon exists

Under CI, moon eagerly resolves `git merge-base <vcs.defaultBranch> HEAD`.
GitHub checks out **single-branch**, and a non-shallow single-branch clone does
not disable affected detection — so the probe hits a `main` that is not there and
hard-fails:

```
× Process git failed: exit code 128
  fatal: ambiguous argument 'main': unknown revision or path not in the working tree.
```

Reproduced against moon 2.3.5. It never reproduces on a developer host, because
a dev checkout has a real `main` — which is exactly why it is closed in the
composite action rather than rediscovered once per new moon job. The new first
step points local `main`, and on a pull request `$GITHUB_BASE_REF`, at their
matching remote refs when present and at `HEAD` otherwise. The default branch is
read out of `.moon/workspace.yml` rather than assumed, an undeclared one is a
hard failure, and a base ref that is not a valid branch name is refused instead
of being handed to `git branch`.

## One entrypoint, and something enforces that it is one

`scripts/ci/affected-matrices.sh` is the only file permitted to write matrix keys
to the runner's job outputs, and `ci-contract.ts` rejects a second committed
writer by name. Two files writing a job's outputs are two authorities on "what
must be checked", and they disagree exactly once, quietly, in the direction of
running less. The rule is "at most one" — a project that selects nothing has no
writer at all — and the guard assembles the variable name at runtime so it is not
a match for its own scan, because a rule that needs a path exemption has a hole
somebody eventually widens.

## The shadow phase is the switch, not a second implementation

`scripts/template/select-affected.ts` always computes the emitted selection
*and*, while the mode variable is unset, the selection it would have made with
the variable set — printed to the step log and the job summary in both modes:

```
selection: full (mode-not-selecting)
  ci = [root]
would have selected with MOON_AFFECTED_MODE=moon:
selection: full (global-input)
  ci = [root]
```

Building a separate shadow selector in order to delete it in the same change
would have left a deletion commit as its only artefact. This way the comparison
is available from the first run, there is nothing to remove afterwards, and the
sole-writer rule is what keeps it that way.

## The matrix gates something real

`Lint`, `Typecheck` and `Test` — the three steps whose cost scales with the
project graph — moved out of the `ci` job into a matrixed `project` job that runs
once per selected project. The `ci` job keeps every contract guard, both hermetic
selftests and the whole template-only baseline block, stays unconditional, and is
renamed **Contracts & Baseline** to say so.

The alternative was a job running `moon run <project>:<task>`, which would
execute **zero** tasks here: the root `moon.yml` excludes the inherited
`lint`/`typecheck`/`test`/`build`, and `apps/` and `libs/` are empty skeletons. A
lane nobody checks is the failure this program exists to prevent.

### The two new jobs are core; only their contents are fenced

This is the stage's largest deliberate departure from its own plan. Fencing the
`affected` and `project` **jobs** would leave a project without the capability
with no lint, no compiler and no suite at all — the renderer has no inverse
fence, so there is no "else" branch to put them back in, and nothing in the suite
would have caught it. Instead:

- the jobs always render;
- the mode variable and the selector step inside `affected` are fenced;
- the matrix reads `fromJSON(needs.affected.outputs.ci || '["repository"]')`.

A project with no selector emits no output, the fallback produces a single entry,
and the heavy lane behaves exactly as it did before the capability existed. Job
ids are not capability signature tokens, so nothing leaks into a disabled render.
This is *stricter* than the fenced design, not looser: `needs` is always
declared, so the workflow rules below hold in both fence variants rather than
only in the committed one.

### Four new workflow rules

All capability-agnostic, all in `ci-contract.ts`, none naming the capability or
the mode variable — that file is copied into every project.

- A job that reads another job's outputs must declare it in `needs`. GitHub
  populates that context from declared dependencies only, so the undeclared case
  reads **empty** rather than failing: the lane starts with a matrix built from
  nothing and looks exactly like a lane with nothing to do.
- `fromJSON(` may appear only in a `strategy.matrix` value.
- A job whose id matches `deploy|release|publish|promote`, or that declares an
  `environment:`, may not read the selector's outputs. A selection decides what
  is *checked*, never what is *shipped*; "this pull request did not touch that
  project" is a statement about a diff, not about a release. No such job exists
  here, so the rule is a **negative requirement** proved by adding one.
- The aggregate gate must depend on the selector. A selector that failed makes
  the lanes below it **skip**, and a skipped lane reads as a pass to the verdict
  script — so a selection nothing gates on goes green precisely when the
  selection was wrong.

## The switch

One fenced workflow-level entry:

```yaml
MOON_AFFECTED_MODE: ${{ vars.MOON_AFFECTED_MODE || 'full' }}
```

The value lives in a **repository variable**, which is what makes a rollback a
variable change with no deploy. What this tree can guard is the in-tree default
it falls back to, and `affected:check` asserts that literal equals
`[ci] affected_mode_initial` in `template-parameters.toml`. An override that
"fails safe to `full`" is only safe if `full` is what this repository actually
recorded.

`[ci] affected_mode_initial` stays `"full"` and cannot be flipped: `parameters.ts`
requires `moon_affected_selection` for a `moon` value, the capability is off by
default, and two of three fixtures disable it.

## Validation

```sh
bun run affected:check
bun run ci:check
bun run graph:check
bun run template:validate
bun test scripts/template/__tests__
bun run typecheck && bun run template:typecheck
bunx biome check --no-errors-on-unmatched .
bash scripts/worktree/selftest.sh

# The entrypoint, against the real tree, in both modes.
GITHUB_OUTPUT=$(mktemp) EVENT_NAME=pull_request \
  BASE_SHA=$(git rev-parse origin/main) HEAD_SHA=$(git rev-parse HEAD) \
  bash scripts/ci/affected-matrices.sh
```

## Live evidence capture

Three live cycles, in this order, because the middle step is a repository
variable and the two runs that bracket it must be the same tree:

```sh
# 1. A green full-mode PR run at the boundary. Its selector log carries the
#    "would have selected" narration — a workflow_dispatch would NOT, because an
#    event outside the table short-circuits before the shadow is computed.
# 2. gh variable set MOON_AFFECTED_MODE --body moon --repo <owner>/<repo>
# 3. Re-trigger the same PR at the same head (close + reopen) for the moon-mode
#    code cycle.
# 4. A STACKED docs-only PR whose base is the boundary, for the empty matrix.
# 5. Capture, inside the container.
bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-b-evidence.ts capture \
  --implementation <sha> --full-run <id> --moon-run <id> --docs-run <id> \
  --docs-base <sha> --docs-head <sha>
```

The capture runs **inside the devcontainer** because moon is image-owned: on the
host it would either fail on the missing binary or seal a version this repository
never pins. The synthetic four-project workspace it builds is not a convenience
either — this repository's graph is the root alone, so `--downstream deep` is
unobservable here and a capture over it would prove nothing about the flag it
pins.

### What the capture found

Two defects, both invisible everywhere except where they were found.

**The heavy lane had no history.** Moving `Lint`, `Typecheck` and `Test` into the
new `project` job silently dropped `fetch-depth: 0`. The `ci` job carries it
because `template:validate` re-checks sealed ancestry; nobody had written down
that the **suite** does the same — the Stage 1, 4 and 7 evidence tests re-check
ancestry and the rollback fixtures build synthetic merges. A developer checkout
always has full history and the render checks only assert the workflow's shape,
so the **first real run** was the first thing that could see it: four evidence
tests red for a tree that was entirely correct. `project` is now a declared
history owner with that reason beside it.

**The entrypoint test was toolchain-environment-dependent.** It ran the committed
script with `HOME` redirected into its fixture, copied from the `git()` helper
that needs that isolation. Inside this repository's devcontainer `jq` and `bun`
are proto **shims** that resolve through `$HOME/.proto`, so the redirect made them
resolve nothing, the universe preflight read an empty registry, and the
entrypoint failed closed for a reason that had nothing to do with the code. It
passed on a laptop and on the runners; only the in-container capture ever saw it.

## Scope

- **No `merge_group:` trigger.** This repository runs no merge queue, and adding
  a trigger nothing exercises ships an unproven required lane. The selector's
  event table *handles* `merge_group` (base = `github.event.merge_group.base_sha`)
  and is fixture-tested, so an un-triggered merge-queue event is unreachable
  rather than wrong. Handle the event; do not invite it.
- **No second universe.** There is exactly one required lane, so there is exactly
  one universe. A universe nothing runs is a list of projects nobody checks.
- **No seed projects.** `apps/` and `libs/` stay empty. The synthetic workspaces
  live in tests and in the evidence probes, where they belong.
- **No branch-protection change.** The required context is still the aggregate
  gate's display name; both new jobs reach it through `needs` instead of becoming
  second required checks.

## Rollback

**Order matters, and this is the first stage where it does.**

```sh
# 1. FIRST: neutralise the switch.
gh variable delete MOON_AFFECTED_MODE --repo <owner>/<repo>
#    (or: gh variable set MOON_AFFECTED_MODE --body full)

# 2. THEN: revert the tree.
git revert -m 1 <stage-8b-pr-merge-commit>
```

Reverting first and forgetting the variable is *harmless today* — the surface is
gone and nothing reads it — but it becomes live again the moment the stage is
re-applied, which is a selection nobody decided to turn on. The sealed record
carries the variable in its `rollback.outsideTheTree` list for exactly this
reason; every earlier stage's list was empty.

A revert takes back the affected-selection contract, its entrypoint and selector,
the committed matrix script, the two package scripts, the fenced mode variable,
the `affected` and `project` jobs and their gate dependencies, the workflow
contract rules, the `setup-moon` base-ref step, the ownership wiring, this
documentation, and the record itself. The committed rollback proof binds the base
and implementation SHAs, the synthetic merge parent order, the predecessor and
reverted tree identities, and the fact that the reverted tree carries none of
these four paths:

```
scripts/ci/affected-matrices.sh
scripts/template/affected-contract.ts
scripts/template/select-affected.ts
scripts/template/validate-affected.ts
```

Branch protection is untouched, and no `.devcontainer/**` file changed, so there
is **no rebuild in either direction**.

## Decisions and deviations

Recorded because the next stage inherits them. The first is the largest.

1. **The `affected` and `project` jobs are CORE; only their contents are fenced.**
   The plan fenced both jobs. Reality contradicted it: the renderer has no
   inverse fence, so a fenced heavy lane leaves a capability-less project with no
   lint, no compiler and no suite at all, and nothing in the suite would have
   caught it. The chosen shape is also *stricter* — `needs` is always declared, so
   the four new workflow rules hold in both fence variants rather than only in
   the committed one. Verified by running `validateCiContract` and
   `validateWorkflowGraph` over all three rendered fixtures.
2. **The `project` job's `if` drops the `!= ''` clause** the plan specified. It
   would skip the job in a capability-less render, where the output is
   legitimately empty. Safety is unaffected: if `affected` fails, GitHub skips
   `project` on the failed dependency and the gate goes red on `affected` itself.
3. **`BASE_SHA` is `github.event.pull_request.base.sha || github.event.merge_group.base_sha`.**
   Still through `env:`, never interpolated into a body. It makes the
   `merge_group` table entry non-vacuous if a trigger is ever added.
4. **A path owned by the repository-wide project forces FULL** rather than
   seeding it. Restores the reference implementation's catch-all and is what
   makes moon's answer comparable at all. Consequence: this repository has
   exactly two outcomes, FULL and empty.
5. **Moon is fed the seed files, not the whole diff, and the repository-wide
   project is excluded from its answer.** Without both, every pull request would
   disagree structurally and the narrow answer could never stand.
6. **No temp file for the diff.** The plan's hazard is bash-specific (`$(...)`
   strips NULs and hides exit status). `Bun.spawnSync` returns raw bytes and the
   exit code separately, so the distinction is preserved directly.
7. **`HEAD_SHA` is validated as 40-hex and `cat-file`-checked too**, not only
   `BASE_SHA`. Each has its own reason code.
8. **`AffectedSelection` carries `seedFiles`, `selected`, `mergeBase` and
   `repositoryWide`** beyond the plan's four fields. The moon leg needs all four.
9. **`graph-contract.ts` gained `readUniverseRegistry`** as a fourth change.
   Avoids a second spelling of the registry path, which would be a second
   authority over the file the whole capability fails closed on.
10. **The sole-writer scan is scoped to executable file types** and assembles the
    variable name at runtime. Prose cannot write a job output, so a changelog
    entry describing the rule is not a second selector — which is what keeps the
    rule free of per-path exemptions.
11. **The mode-aware workflow rules landed with the workflow surgery**, not with
    the contract module: they assert a fenced `env:` entry that did not exist
    until then.
12. **`setup-moon` reads `$GITHUB_BASE_REF` from the ambient environment** rather
    than through a `github.base_ref` expression. That file's own standing rule is
    that no `${{ … }}` may appear in it at all, prose included.
13. **`affected:check` is wired into the `ci` job and `template:validate` from
    the commit that created it**, so the guard is never a module nothing runs.
14. **The `project` job is a second history owner.** Found by the first live run,
    not by design. See *What the capture found*.
15. **The full-mode cycle was captured from a pull-request event, not a
    `workflow_dispatch`.** Stage 8A used a dispatch, but an event outside the
    selector's table short-circuits before the shadow is computed, so a dispatch
    run carries no "would have selected" narration and could not evidence the
    shadow phase at all.
16. **The documentation-only cycle is a stacked pull request** whose base is the
    implementation boundary. A docs-only diff needs a commit the boundary does
    not contain, so it cannot sit at the boundary itself; basing it on `main`
    would have run a workflow that has no selection lane. The record asserts its
    base *is* the boundary and its head is not.
17. **`[ci] affected_mode_initial` stays `"full"`.** `parameters.ts` requires the
    capability for a `moon` value, and two of three fixtures disable it, so
    flipping the parameter would fail `template:validate` on the repository and
    on those fixtures. The switch is the repository variable; the parameter is
    what the in-tree default is checked against.
18. **PR #21's removed `[capability_dependencies]` entry was NOT restored.** It
    named the `moon` capability, which PR #21 deleted when moon was promoted to
    core, so the dependency was unresolvable rather than merely vacuous. The
    surviving coupling is the `parameters.ts` check above, and 8B keeps it.
19. **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`**, which
    has not been a capability since PR #21. Nothing validates that block — it is
    stage-0 bookkeeping prose — so it is noted here rather than changed.
