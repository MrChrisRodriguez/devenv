# Stage 9 OpenSpec and agent lifecycle

Two things this repository had been trusting without checking: that the OpenSpec
CLI's exit code means the specs are fine, and that four agent rule files saying
roughly the same thing still say the same thing. Neither was true. Stage 9 makes
both claims falsifiable, adds a host wrapper that refuses every unsafe archive
before it touches the tree, and regenerates the vendor's Claude artifacts from
the pinned CLI so the one procedure they shipped — a hand-rolled directory move —
is gone from the repository entirely.

```sh
bun run openspec:check   # enumerate every root, then drive the pinned CLI at each
bun run rules:check      # canonical AGENTS.md vs every generated mirror + the 14 artifacts
bun run rules:sync       # the ONLY way a mirror or an artifact is allowed to change

bash scripts/openspec/archive.sh --change <name> [--root <dir>] [--dry-run]
```

Nothing under `.devcontainer/**` changed in this stage, so adopting it costs
**no container rebuild**, and unlike Stage 8B nothing about it lives outside the
tree: no repository variable, no branch-protection change, no operator step.

## The CLI's success path is compatible with having checked nothing

Every design decision below follows from behaviours of `@fission-ai/openspec`
0.19.0 that were reproduced rather than read about:

- `validate --all --strict` exits **0** over an empty set. A repository whose
  changes were all deleted validates clean.
- It never inspects an archive at all.
- `list --specs --json` prints `No specs found.` — prose, not JSON — when there
  are no specs, so a parser that trusted the flag would throw on the empty case.
- Every command resolves against `'.'`. The CLI has no notion of project roots,
  so "multi-root" is not a question it can answer.
- `archive` returns **0** after `Aborted. No files were changed.`
- `archive` applies the delta specs to `openspec/specs/**` **before** it checks
  whether `archive/<date>-<name>` exists, and returns **0** when it does. The
  observed post-state: main specs rewritten, change still active, exit 0.
- Archive dates come from `new Date().toISOString()` — UTC. The probe that found
  this ran at 22:39 local on the 6th and produced `2026-08-07`.
- Telemetry is opt-**out**: unset, it posts to PostHog from every invocation.

## Enumerate first, ask second

`scripts/template/openspec-contract.ts` walks the tree for
`**/openspec/config.yaml` — pruning `.git`, `node_modules`, `dist`,
`graphify-out` and `tmp` — and cross-checks every root against `git ls-files`.
`tmp/` is pruned because `template:fixtures` renders there and a rendered fixture
carries its own `config.yaml`; walking into it would invent a root no commit
owns.

That enumeration is the authority. `scripts/template/validate-openspec.ts` then
drives the CLI once per root, with that root's own directory as `cwd`, and the
two answers must agree **exactly in both directions**: an item the CLI reports
that the tree does not contain is a failure, and so is an item the tree contains
that the CLI does not report. The reported `summary.totals.items` is compared
against *our* count rather than against the item array the same command printed —
otherwise the CLI would only be agreeing with itself.

**Anti-vacuity is the point.** A root that declares no change and no spec fails
rather than passing. Every abnormal outcome is a failure: non-zero exit, empty
output, non-JSON output, an unexpected shape, or a `--version` that is not the
`@fission-ai/openspec` catalog entry. The binary must live inside *this*
repository's `node_modules` — a globally installed CLI of another version
validates a different schema and prints the same green summary while doing it.
`OPENSPEC_BIN` injects a fake for the tests, exactly as `MOON_BIN` does for the
graph oracle, so every refusal listed here is a path the suite has executed.

Archive hygiene is checked from the tree, because the CLI never looks: entry
names must be `<YYYY-MM-DD>-<change>`, the date must be a real calendar day and
must not be in the future **in UTC**, no name may be both active and archived,
`archive/archive` is rejected, an empty entry is rejected, and an archived
change's `ADDED` requirements must actually have reached `openspec/specs/`.

**A finished change is a notice, not a failure.** Zero remaining tasks is the
correct state between the last implementation commit and the archive commit.
Failing on it would make the guard red for the one window in which everything is
right, so it prints a notice naming the wrapper and exits 0.

### Where the step lives is a constraint, not a preference

`openspec/**` classifies as **documentation** in the affected-selection oracle
Stage 8B shipped. A lifecycle guard in a lane a selection can narrow would be
skipped by exactly the pull requests that change a change. The fenced
`bun run openspec:check` step is therefore in the `ci` job, unconditional, and
the contract asserts both facts — the guard rejects the step being moved or
given an `if:`.

## The wrapper refuses first, and the order is the safety property

`scripts/openspec/archive.sh` is a **host** script and deliberately has no
package script: it does Git work, which is host work by definition, and a
package script would be an invitation to run it through the bridge from inside
the container it refuses to run in. The contract rejects a package script that
names it.

```
1. usage
2. environment      — a Codex Cloud task and the development container are both
                      the wrong side of the remote
3. readiness        — `exec.sh --require-ready true`
4. git              — branch, cleanliness, origin ref, fetch, HEAD == origin
5. selection        — explicit the moment it is ambiguous
6. completion, delta assessment, UTC duplicate pre-check, subject length
7. archive          — then verify the POST-STATE, never the exit code
8. re-validate every root, stage the OpenSpec root only, commit with hooks
9. re-fetch, verify the parent, push
```

**The readiness preflight is not decoration.** The git hooks route through
`scripts/worktree/exec.sh --require-ready`, which exits 7 rather than starting a
container. Without the preflight, a checkout whose container is down would
archive the tree and then fail at `git commit` — leaving the change moved, the
specs rewritten, and nothing committed. That is the one state this script exists
to prevent, so it is checked before the first mutation rather than discovered
after it.

"Clean" includes untracked files **and** `graphify-out/`, and the refusal names
both ways out (`git restore graphify-out`, `git stash`) because a dirty graph
directory is the ordinary state after a hook run and the `pre-commit` guard would
reject it staged alongside anything else. `HEAD` must equal `origin/<default>`
exactly after a fresh `git fetch --prune`; behind, ahead and diverged are three
refusals with three different instructions.

`OPENSPEC_BRIDGE` is the one injection point, spelled
`${OPENSPEC_BRIDGE-bash scripts/worktree/exec.sh --require-ready}` and asserted
verbatim. It uses `-` and not `:-`: an explicitly empty value means "run in
place", which is what the tests and a throwaway clone use, and `:-` would
silently send them back through a bridge they do not have.

### The exit codes are a matrix, closed in both directions

| Code | Meaning |
|---|---|
| 0 | archived (or, with `--dry-run`, reported) |
| 2 | unsupported argument |
| 3 | wrong environment: a Codex Cloud task or inside the container |
| 4 | this checkout's container is not ready |
| 5 | a git precondition refused the run |
| 6 | the change selection is ambiguous or unknown |
| 7 | the change still has remaining tasks |
| 8 | the archive destination is already occupied |
| 9 | the archive did not verify and was rolled back |
| 10 | the push was refused |
| 11 | the push did not verify against the remote |

A committed test asserts that every code the usage block documents is a code the
suite triggers, **and** that every code the suite triggers is documented. A
refusal with a code nobody has seen happen is a refusal nobody has checked.

### Publication happens only after verification

The exit code is not evidence, so the post-state is: the active directory is
gone, the archive directory exists and is not empty, and nothing outside the
OpenSpec root was touched. Any failure rolls the root back with
`git restore --source=HEAD --staged --worktree -- <root>` plus a scoped
`git clean`, says out loud what it just did, and exits non-zero. The clean-tree
refusal earlier is what makes that rollback safe to run at all.

Then `openspec:check` runs again across **every** root — applying delta specs
rewrites `openspec/specs/**`, and the archive-hygiene rules are the only thing
that inspects what the CLI just wrote. The commit stages the OpenSpec root and
nothing else, its subject is length-checked against commitlint's 72-character cap
*before* the CLI is allowed to move anything, and it runs the hooks like any
other commit: `--no-verify` is banned by the contract, because the archive commit
is the one commit nobody reviews.

**A rejected push is a designed outcome.** Branch protection can refuse the
direct push. The commit is kept, three ways out are printed, and the wrapper
exits 10. The next run then refuses on `HEAD` being ahead of `origin/<default>`,
so the failure heals itself instead of quietly re-running.

## One canonical rule file, and mirrors that are generated

`AGENTS.md` is the source. `CLAUDE.md`, `GEMINI.md` and `.claude/CLAUDE.md` carry
generated regions of the blocks it marks, produced by `bun run rules:sync` and
checked by `bun run rules:check`.

This was not a hypothetical problem. The graphify rules existed in four places
and had **already drifted**: one copy was missing the "dirty graphify-out is
expected" bullet, and nothing noticed, because nothing compared them.

The guard checks three things, and the third is what keeps the arrangement
honest:

1. every declared mirror region matches its canonical block,
2. no mirror carries a region the canonical file does not declare for it,
3. **canonical text may not be restated outside a generated region** — otherwise
   consolidation is just addition, and the duplicate stays where `rules:sync`
   will never touch it.

The blocks sit inside capability fences, so a project that disables a capability
loses the canonical block and its mirrors *together* and the guard compares an
empty set against an empty set. That is why `rules:check` is an **ungated** CI
step: it is true in every render by construction.

### Codex's surface is a negative requirement, written down as a check

Codex reads the root `AGENTS.md` and receives no OpenSpec commands or skills.
That was a standing decision living in somebody's memory — the kind that gets
re-litigated the first time a generator offers to write
`.codex/skills/openspec-*`. It is now a table entry plus a scan: any `.codex/**`
file naming `opsx` or `openspec-` fails the guard.

## The fourteen Claude artifacts are generated, and the generator is the CLI

`.claude/commands/opsx/*.md` and `.claude/skills/openspec-*/SKILL.md` are
regenerated by **spawning** `openspec artifact-experimental-setup` into a scratch
directory. Spawned rather than imported: the package publishes `"."` only in its
exports map, so a deep import of its generator fails under Bun. Regeneration is
byte-deterministic and all fourteen are compared against a fresh run.

The overlay is deliberately the smallest thing that can be checked, because
anything larger stops "regenerated from the pinned CLI" from being true: a
two-line header after each file's frontmatter (after, never before — a comment
above the opening `---` makes the frontmatter invisible to everything that reads
it), plus a **body replacement** on the two archive surfaces. The vendor bodies
told the agent to `mkdir` an archive directory and move the change into it with
a dated name — the exact procedure this stage forbids — so both now carry
`scripts/template/agent-rules/archive-delegation.md`, which points at the wrapper
and explains why the CLI's exit code is not evidence.

The guard then asserts the vendor's move command appears **nowhere in the tree**.
Replacing it in the two files that shipped it is not the same as no agent ever
reading it. The needle is assembled at runtime so the guard is not a match for
its own scan — the same reason `ci-contract.ts` assembles `GITHUB_OUTPUT`.

## Validation

```sh
bun run openspec:check                        # both legs, against the pinned CLI
bun run openspec:check --no-cli               # the hermetic leg only
bun run rules:check                           # mirrors + the fourteen artifacts
bun run rules:sync                            # must be a no-op on a clean tree
bun test scripts/template/__tests__/openspec.test.ts     # 58 cases
bun test scripts/template/__tests__/agent-rules.test.ts  # 21 cases
bun run template:validate                     # aggregates both hermetic contracts
bash scripts/openspec/archive.sh --dry-run    # reports the real state, changes nothing
```

## Live evidence capture

```sh
# 1. Push the branch and open the pull request. ci.yml triggers on `push` only for
#    the default branch, so a feature branch produces no run until a PR exists.
# 2. Wait for the required gate to go green at the implementation head.
# 3. Capture, inside the container — the pinned CLI, node and gh all live there.
bash scripts/worktree/exec.sh bun scripts/template/collect-stage-nine-evidence.ts \
  capture --implementation <boundary-sha> --gate-run <run-id>
```

Eight exact commands with sha256-bound raw logs under
`evidence/stage-9-openspec-run/`. The collector validates the record against its
own schema and semantic rules **before** it writes, and a committed suite
re-validates it and fabricates each claim in turn.

`template:validate` is deliberately **not** one of the captured commands. It
aggregates every hermetic contract *including this record*, so it cannot appear
in the record it validates: run before the record exists it fails, and run after
it can never seal its own log. The required CI lane runs it instead.

### What the capture found

- The lifecycle probe's first version read its post-archive facts *after* the
  duplicate-destination section had re-created the change, so it reported
  `activeDirectoryRemoved: false` and the wrong commit subject for a run that had
  been completely correct. Both are now read immediately after the first run.
  A probe that asks its questions in the wrong order answers a different one.
- A change with **no delta specs at all** fails the real CLI's `--strict`
  validation (`Change must have at least one delta`). The fixtures' second,
  still-active change therefore carries its own delta spec under a separate
  capability. Found by running it, not by reading.
- Archiving a root's **last** change when that change has no delta specs leaves
  the root with zero items, which `openspec:check` then fails on anti-vacuity.
  That is the declared policy behaving correctly, and it is left as-is.
- The wrapper's `CODEX_CLOUD` arm had to be capability-fenced. The marker is a
  declared residue signature and the anti-residue scan is a plain substring
  search, so one unfenced mention failed every render without cloud. Caught by
  the suite, not by review.

The sealed live cycle is the green required gate at the implementation boundary:
seven jobs, six sealed gate dependencies, every one `success`, with the heavy
lane running because affected selection is live in `moon` mode and the only
project here is the root — a code change cannot be narrowed away.

## Scope

- **No evidence for a second OpenSpec root.** The enumeration is exercised over
  synthetic multi-root fixtures in the suite; this repository has one root and
  inventing a second in-tree would be a project nobody owns.
- **No archive of the real change.** `portable-devcontainer-upgrade` stays
  ACTIVE through Stage 11. Every proof runs in a throwaway clone with its own
  bare origin, and a committed test plus a sealed record field assert the real
  change is still active.
- **No `openspec init` anywhere.** It writes a second, non-experimental command
  family under different names and injects a managed block into `AGENTS.md` and
  `CLAUDE.md`. `openspec/config.yaml` is the initialization marker and it is
  committed.
- **`setup-openspec.sh` stays fail-closed at container create.** It verifies the
  committed marker and the repository-local binary; it generates nothing.
- **No branch-protection change.** Both new steps are inside the existing `ci`
  job, so the required context is unchanged.

## Rollback

```sh
git revert -m 1 <stage-9-pr-merge-commit>
```

Nothing precedes it and nothing follows it. There is no repository variable, no
branch-protection step and no container payload, so `rollback.outsideTheTree` in
the sealed record is **empty** — Stage 8B's was not.

A revert takes back the OpenSpec lifecycle contract and its entrypoint, the host
archive wrapper, the cross-agent rules contract with its guard and generator, the
committed delegation body, the three package scripts, the two steps in the
required lane, the canonical blocks and every generated mirror region, the
fourteen regenerated Claude artifacts, the ownership wiring, this documentation,
and the record itself. The committed rollback proof binds the base and
implementation SHAs, the synthetic merge parent order, the predecessor and
reverted tree identities, and the fact that the reverted tree carries none of
these seven paths:

```
scripts/openspec/archive.sh
scripts/template/agent-rules-contract.ts
scripts/template/agent-rules/archive-delegation.md
scripts/template/openspec-contract.ts
scripts/template/sync-agent-rules.ts
scripts/template/validate-agent-rules.ts
scripts/template/validate-openspec.ts
```

The active change is unaffected either way: no capture, proof or guard in this
stage archives it.

## Decisions and deviations

Recorded because the next stage inherits them.

1. **Commit 5's planned subject was one character too long.**
   `feat(agents): regenerate openspec commands and skills from the pinned cli` is
   73 characters and commitlint caps the header at 72. Committed as
   `…from the cli`; "pinned" moved into the body, with the reason in the commit
   message. The wrapper's own subject-length check exists for the same reason.
2. **The UTC duplicate-destination pre-check landed with the refusals (commit 2),
   not with publication (commit 3).** `--dry-run` has to report the destination,
   and the contract rule that orders the pre-check *before* the CLI call needs
   both endpoints in one tree.
3. **The commit-subject length check runs ahead of the CLI call**, not after
   post-archive validation as planned. It is computable from the change name
   alone, and refusing after a mutation is a worse refusal than refusing before
   one.
4. **Wrapper policy is split across commits 2 and 3.** Commit 2 asserts the
   bridge literal, no `--no-verify`, `date -u`, telemetry and the absent package
   script; commit 3 adds the ordering, rollback-literal, re-validation,
   subject-prefix and no-force-push rules. A rule about a line that does not
   exist yet is a rule nothing can fail.
5. **The `--no-verify` and force-push rules read the non-comment half of the
   script.** Otherwise the comment explaining why `--no-verify` is banned is
   itself a violation, and the ban becomes unexplainable.
6. **The agent-rules contract is wired into `template:validate`** (hermetic leg,
   `vendor: false`). The plan named `validate.ts` only for commit 1; extending it
   keeps that script the single aggregate of every hermetic contract.
7. **The disposable-lifecycle proof uses `OPENSPEC_BRIDGE=""`** rather than a
   copied `exec.sh` in direct mode. Empty is the declared "run in place" value
   and the documented injection point; copying the bridge would be a second way
   to say the same thing.
8. **`filterAgentRuleLines` is exported from `render-fixture.ts`** so the
   landmine-10 guard — "no canonical block depends on a line the renderer drops"
   — uses the real filter instead of a second copy of its token list. Test-only
   import; `agent-rules-contract.ts` never imports the renderer.
9. **`agent-rules-contract.ts` resolves the OpenSpec CLI itself** instead of
   importing `openspec-contract.ts`. It is core — copied into every render — and
   may not import a capability-gated module. The package name is assembled at
   runtime, because it is a declared residue token and spelling it literally
   would fail the cloud fixture with no way to fence it.
10. **The `scripts/openspec/*.sh` line in `AGENTS.md` landed in commit 2**, not
    with the rules consolidation. The file it describes appears there, and it
    needed a `capability:start openspec` fence to stay out of cloud renders.
11. **The wrapper's `CODEX_CLOUD` arm is capability-fenced.** `CODEX_CLOUD` is a
    declared signature token and the residue scan is a plain substring search;
    unfenced it failed every render without cloud.
12. **The A10 graphify test is scoped to the mirror blocks.** A minimal render
    carries no graphify *mirror* prose in any agent rule file, but `AGENTS.md`
    still mentions `Graphify` in two image-ownership bullets (payload ownership,
    skill-name uniqueness). **That remainder is the full `graphify`
    capabilitySignature deferred to Stage 11 §18.1**, which is outside the
    stage-4–9 scope: adding `graphify` to `capabilitySignatures` would also pull
    in the `.husky`, `.gitignore` and `.claude/settings.json` surfaces, and that
    is a stage of its own.
13. **A change with no delta specs fails the real CLI's `--strict` validation.**
    The lifecycle fixtures' second change carries its own delta spec under a
    separate capability as a result.
14. **Anti-vacuity has a consequence, and it is left in place.** Archiving a
    root's last change when it has no delta specs leaves that root with zero
    items and `openspec:check` fails. That is the A1 policy behaving correctly,
    surfaced in a test rather than worked around.
15. **`template:validate` is not a captured evidence command.** It validates the
    record it would appear in. Recorded in the module beside the command list so
    the omission is a decision rather than a gap.
16. **`live-gate` was added to the plan's command-id list** so the green
    required-gate capture the coordinator asked for has somewhere to live; the
    plan's eight ids became eight with `live-gate` replacing `template-validate`.
17. **The pull request was opened before the live capture.** `ci.yml` triggers on
    `push` only for the default branch, so a feature-branch push produces no run
    at all — the `pull_request` capture the record needs cannot exist until the
    pull request does. The capture is still at the implementation boundary, which
    is what the record asserts.
