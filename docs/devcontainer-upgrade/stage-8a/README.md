# Stage 8A Moon graph and full-mode gate

Stage 7 made the CI *surface* contract-driven. Stage 8A does the same for the
thing CI runs over: the project graph. It introduces moon's graph, a validated CI
universe, and an oracle that rejects drift in either — while execution stays in
**full-matrix** mode, so the dependency metadata is proved before anything is
allowed to select on it.

```sh
bun run graph:check            # hermetic: no moon binary needed
bun run graph:check --query    # + reconcile with moon itself
bun run graph:generate         # rewrite the derived dependsOn blocks
```

Nothing under `.devcontainer/**` changed in this stage, so adopting it costs
**no container rebuild**.

## The graph is anchored on a root project

Before this stage `.moon/workspace.yml` globbed `apps/*`, `libs/*` and
`scripts/*`. `apps/` and `libs/` are empty skeletons, so the entire project graph
was the three tooling directories under `scripts/` — none of which is a package —
plus a warning per loose file there:

```
[ WARN ] moon_workspace::projects_locator  Received a file path for a project
         root, must be a directory  source="/workspace/scripts/browser-preflight.ts"
```

The new declaration is two globs and one source:

```yaml
projects:
  globs:
    - 'apps/*'
    - 'libs/*'
  sources:
    root: '.'
vcs:
  defaultBranch: 'main'
```

Dropping `scripts/*` removes projects that were never packages. Adding the root
keeps the graph from becoming **empty**, which matters more than it sounds: a
query over an empty graph is trivially true, so an oracle over it would report
"no drift" by having nothing to compare — in this repository and in every freshly
rendered project. `scripts/*` leaves `package.json#workspaces` in the same change
for the same reason, and `bun.lock` records only the root workspace, so that edit
is verifiably zero-churn.

The root project's own `moon.yml` excludes the inherited tasks, and that
exclusion is load-bearing rather than tidy: `lint`, `typecheck`, `test` and
`build` in `.moon/tasks.yml` are written for a package, so a project whose
directory is the whole repository would run each of them over everything — `moon
run :lint` would lint the repository once for `root` and then again for every
real project inside it.

`vcs.defaultBranch` is stated explicitly because moon's own default is `master`.
Left unstated it is not "no opinion", it is a silently wrong diff base for every
affected query Stage 8B will add. The graph contract asserts it equals
`template-parameters.toml [project] default_branch`.

## The graph is derived, not declared

`scripts/template/graph-contract.ts` builds the graph from first principles — the
workspace declaration, the `package.json` manifests, and the source imports — and
**never runs moon**. That independence is the whole point: a guard that asked
moon what the graph is could only ever agree with moon.

| Edge source | Rule |
|---|---|
| Manifest | Any dependency section (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`) carrying a `workspace:` value, or a key that names another project's package |
| Import | `import`, `export … from`, dynamic `import()`, `require()` in `**/*.{ts,tsx,js,jsx,mts,cts}`, resolved against project package names, their `<name>/*` subpaths, and the `@<slug>/*` → `libs/*/src` alias |

Three details are load-bearing:

- **Comments are stripped first**, with a small state machine rather than a
  regex, because the two cases that matter — `//` inside `"https://…"` and `/*`
  inside a template literal — are exactly the ones a regex gets wrong. Without
  it a commented-out import becomes a dependency the generator declares and the
  oracle then demands forever.
- **A file belongs to the deepest project that contains it.** The root project's
  source is the whole repository, so without deepest-wins every nested project's
  imports would also become the root's.
- **The path alias is read, not hardcoded.** The renderer rewrites `@confiador/*`
  to `@<slug>/*` for every downstream project, so a literal here would make the
  guard answer questions about the template while running inside someone else's
  repository.

`scripts/template/generate-graph.ts` writes the derived edges into each project's
`moon.yml` as a sorted `dependsOn` inside a marked block:

```yaml
# graph:generated:start
# dependsOn below is DERIVED from this project's package.json manifest and
# its source imports by scripts/template/generate-graph.ts. Do not edit it by
# hand: run `bun run graph:generate`. Every line outside these two markers is
# hand-written and is preserved across regeneration.
dependsOn:
  - 'ui'
# graph:generated:end
```

Everything outside the markers is copied through untouched, so a project config
can carry tasks, tags and a language declaration and still be regenerated safely.
A project with no derived dependency gets a comment saying so rather than an
empty `dependsOn` — the file never states something it cannot justify. Only
glob-discovered projects are generated: the root `moon.yml` is hand-written core
configuration and the generator has no opinion about it.

## One registry says which projects CI runs over

`ci-matrix-universes.json` lists the universes a CI lane can be built from, and
there is exactly one:

```json
{
	"schemaVersion": 1,
	"universes": [{ "id": "ci", "projects": ["root"] }]
}
```

There is one universe because there is one required lane. A second universe would
need a second lane to run it, and a universe nothing runs is a list of projects
nobody checks. The rules are total rather than advisory: `schemaVersion` must be
1, ids must be unique kebab-case, no universe may be empty, every listed id must
be a real project, and **every real project must appear in exactly one
universe**. A project in none is a project no lane ever builds — the silent hole
the file exists to close; a project in two is a lane that runs it twice and
reports one result. Absence and a parse failure are hard errors, not skipped
checks, and the guard asks Git for every tracked `*universes*.json` and rejects
any second file: a well-meaning `ci-matrix-universes.backup.json` would be a
second authority that disagrees silently.

The filename is not a preference. It is the path Stage 0 recorded as this
capability's residue signature, so the artifact rule and the file had to land in
the same commit: without the rule, a project that disables
`moon_affected_selection` renders a copy of the registry and fails its own
anti-residue scan by construction.

## The oracle has two legs, and both fail closed

`bun run graph:check` is the guard.

**Leg 1 is hermetic and always runs.** It rebuilds the graph, compares it with
what every committed `moon.yml` declares, dry-runs the generator and rejects
stale output, and validates the registry. It needs no moon binary, which is what
lets it run in the required lane, inside `template:validate`, and on a developer
host that has neither moon nor proto. Its verdicts are deliberately distinct —
**missing edge**, **extra edge**, **undeclared import**, **unknown project**,
**missing project** — because they are different defects with different repairs.

**Leg 2 is live and runs only under `--query`.** It asks moon for the graph and
reconciles the two answers, which is the only way to catch a disagreement between
what this repository believes and what moon actually does. The invocation is
pinned in one exported constant:

```ts
export const MOON_QUERY_ARGV = ["query", "projects"] as const;
```

There is **no `--json`**, and that is a verified fact about moon 2.3.5 rather
than a style choice:

```
$ moon query projects --json
error: unexpected argument '--json' found
```

In moon 2.x the whole `query` family emits JSON by definition — `moon query
--help` says so in its first line — and the flag that used to request it is gone.
A guard that kept it would fail every run and get "fixed" by deleting the query,
which is how a live oracle quietly becomes a no-op. The shape was verified in the
devcontainer before a line of the contract was written: `projects[]` carries `id`,
`source`, `config`, and a `dependencies` array of `{id, scope, source}` that is
**absent rather than empty** when a project has no edges, so the per-project
fallback (`moon project <id> --json`) was not needed.

Every abnormal outcome of that query is a failure: a non-zero exit, empty output,
output that is not JSON, output that is JSON in an unrecognised shape, a project
moon reports that the committed graph does not declare, a project it fails to
report, an edge it reports that nothing justifies, and a derived edge it omits.
Each of those has told the guard **nothing** about the graph, and treating any of
them as "no drift found" would turn the live leg into a step that always passes —
worse than absent, because CI would then claim the graph was verified. All eight
paths are executed by a committed stand-in binary injected through `MOON_BIN`,
which also asserts the pinned argv end to end.

## The required lane gates on it

The `ci` job runs the hermetic leg as a fenced step — it needs only Bun, so it
costs a second in the lane that already has it. The live leg gets its own fenced
job:

```yaml
  moon-graph:
    name: Verify Moon project graph
    runs-on: ubuntu-latest
    timeout-minutes: 10
    if: ${{ !github.event.pull_request.draft }}
```

It is separate because it is the one check here that needs a real toolchain, and
folding a moon install into the contract job would make every other guard wait on
it. It is a fenced entry in `ci-gate`'s `needs` in the **same change**, because
the workflow guard requires the gate to depend on every job in the file — and
because a graph that was never verified looks exactly like a graph that was,
which is why its absence from `needs` now has its own dedicated verdict.

`.github/actions/setup-moon/action.yml` wraps `moonrepo/setup-toolchain` (pinned
to a 40-hex commit) with `auto-install: true`, then asserts `moon --version`
against the `.prototools` pin. It declares **no inputs at all**: `.prototools` is
the one authority for the moon version — setup-toolchain reads it when
`moon-version` is empty — so an input here would be a second authority sitting
outside the toolchain guard, and a caller could ask for a moon this repository
does not pin. That includes `bun-version`: the job uses both committed actions
side by side, with `install: "false"` on the Bun one because the guard imports
nothing from `node_modules`.

Four new rules in `scripts/template/ci-contract.ts` keep all of that true: no
workflow may `uses:` `moonrepo/setup-toolchain` directly; the `moon-graph` job
must reach moon through the committed action; that action must declare no inputs
and must assert its binary against `.prototools`; and the aggregate gate must
depend on the graph oracle whenever the job exists.

## Capability fencing

The whole surface is gated behind `moon_affected_selection`, which the template
disables by default. A project without it receives **none** of it — no registry,
no guard modules, no composite action, no `graph:*` package scripts, no fenced
step, and no gating job — and the sealed evidence records that per fixture:

| Fixture | Capability | Registry | Guards | `graph:*` scripts | Jobs |
|---|---|---|---|---|---|
| `minimal` | off | — | — | — | `ci`, `ci-gate`, `image` |
| `cloud` | off | — | — | — | `ci`, `ci-gate`, `image` |
| `full` | on | ✓ | 4 | `graph:check`, `graph:generate` | + `browser`, `moon-graph` |

`.moon/workspace.yml` and the root `moon.yml` stay **core**: moon itself has been
core since PR #21, and a project graph is not an optional feature of a monorepo.

## Validation

```sh
bun run graph:check          # hermetic legs on the real tree
bun run ci:check             # workflow policy, including the four moon rules
bun run template:validate    # + the sealed Stage 8A record
bun test scripts/template/__tests__
```

The graph fixtures are synthetic moon workspaces on disk — the builder answers
questions about a directory tree, so the only honest fixture is a directory tree.
They cover a leaf edge, a fan-out, a deepest transitive chain that must **not**
grow a shortcut, a path-alias import, deepest-owner attribution, an unknown
project in both directions, a default branch that disagrees with the template
parameter, generator drift in both directions, an unbalanced generated block, the
ten-case universe corruption matrix, and the global/docs/project classification
scopes. Each mutation is followed by a restore that must return to silence, and
each has a lookalike that must be **accepted** — a commented-out import creates
no edge, and a hand-written key outside the generated block survives
regeneration.

## Live evidence capture

`evidence/stage-8a-moon-graph.json` is the command-bound acceptance record, with
raw per-command logs and SHA-256 digests under
`evidence/stage-8a-moon-graph-run/`.

The capture runs **inside the devcontainer**, and that is not a convenience: moon
is image-owned and the host has neither moon nor proto, so a capture attempted on
the host would either fail on the missing binary or, worse, find some other moon
and seal a version this repository never pins. The collector refuses to run
outside it.

```sh
# 1. Push the branch and dispatch CI on it, then wait for a green run.
gh workflow run ci.yml --ref feat/stage-8a-moon-graph
gh run list --workflow ci.yml --branch feat/stage-8a-moon-graph --limit 1

# 2. Capture, inside the container.
bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-a-evidence.ts \
  capture --implementation "$(git rev-parse HEAD)" --gate-run <run id>
```

The ten commands, in execution order:

| # | Command id | What it proves |
|---|---|---|
| 1 | `graph-guard` | The hermetic legs pass on the real tree. |
| 2 | `graph-mutations` | Every graph, generator and registry mutation is rejected and every lookalike accepted. |
| 3 | `ci-guard` | The workflow policy contract, including the four moon rules, passes. |
| 4 | `workflow-policy-mutations` | The workflow mutation suite, including the unpinned moon action, the missing version assertion, an input on the moon action, a direct third-party install, and a gate that dropped the oracle. |
| 5 | `moon-toolchain` | The moon the live legs ran against, read from the binary and from `.prototools` in the same breath. |
| 6 | `moon-query` | The pinned invocation against the real moon, and the graph it printed. |
| 7 | `live-graph-oracle` | `graph:check --query` reconciling that graph with the independently derived one. |
| 8 | `rendered-graph` | All three fixtures rendered and inspected for the registry, the guards, the scripts and the gating job — and the hermetic oracle run over the rendered `full` project on its own terms. |
| 9 | `live-gate` | A real green run on GitHub's runners at the reviewed boundary. |
| 10 | `rollback-proof` | A synthetic merge followed by `git revert -m 1` produces a tree identical to the predecessor — a tree carrying none of the six paths this stage adds. |

The captured run is `stage8a-20260807t012640z-636eae6b`: moon **2.3.5** matching
the `.prototools` pin, a graph of exactly `{root}` at source `.` with no edges,
the `ci` universe claiming exactly that project, and
[run 31137567030](https://github.com/MrChrisRodriguez/devenv/actions/runs/31137567030)
— `workflow_dispatch` on the implementation commit, all four gating jobs
`success`, the gate handed `success,success,success,success` and concluding
`success`, with `Verify Moon project graph` reporting by display name.

The validator is environment agnostic: it binds sealed values to other sealed
values and to Git objects the record names, never to the absolute layout of
whatever checkout is running it. The moon version is bound to the pin **the same
record captured**, not to whatever `.prototools` says years from now; the sealed
graph is bound to what moon printed, not to what the current tree would derive;
and the live run's shape is bound to the record's own `gateNeeds`. Hand-editing
the record or a log breaks `bun run template:validate`; the fix is to re-run the
collector.

### What the capture found

Adding the `moon-graph` job broke the **Stage 7** record. Its validator
re-resolved the gate's dependency list out of the *current* `ci.yml` and required
both the sealed record and each sealed live run to match it exactly, so a fourth
job turned a green historical capture into a reported fabrication — with the only
repair being to re-run three live workflows, one deliberately red and one a
draft, to restate a fact nothing had falsified.

That is fixed in `636eae6`, and it is the same class of defect the Stage 5A
validator had against an absolute host path. The run-shape assertions now anchor
on the record's own `gateNeeds` — so a record whose runs disagree with its own
dependency list is still rejected — and the identity check became a subset test:
a renamed or removed lane fails, an added one does not. Whether the gate is
complete *today* already has an owner, and it is `ci-contract.ts`, which requires
the gate to depend on every job in its file. Three tests pin the new shape. The
Stage 8A validator was written with the same rule from the start.

The second finding came from the rendered-fixture command: a dependency-free
generated `moon.yml` is a **comment-only YAML document**, which parses to `null`,
and the graph builder was reporting that as a parse failure — the generator's own
output failing the guard that checks it. Fixed in `41aed38` with the fixture that
found it.

## Scope

- **No affected selection.** `classifyPath` answers "whose change is this" and
  nothing in this stage turns that answer into a selection. CI stays full-matrix:
  no matrix, no `affected` condition, no `MOON_AFFECTED_MODE` anywhere. Building
  selection on an unproven classifier is how a CI matrix silently stops running
  the job that mattered.
- **No seed projects.** `apps/` and `libs/` stay empty. The root project is what
  makes the graph non-empty, and inventing a placeholder package to fill the
  skeleton would put a fake dependency in the one file that is supposed to be
  derived.
- **No second registry, ever.** The sole-registry rule is enforced against the
  Git index rather than the working tree, so an untracked scratch copy is fine
  and a committed one is not.
- **No branch-protection change.** The required context is still the aggregate
  gate's display name; the graph job reaches it through `needs` instead of
  becoming a second required check.

## Rollback

Stage 8A is one atomic, additive bundle:

```sh
git revert -m 1 <stage-8a-pr-merge-commit>
```

There is **nothing outside the tree** to undo first — which is the one way this
stage's rollback is simpler than Stage 7's. Branch protection is untouched, so a
revert cannot strand a required context that no workflow produces.

A revert takes back the workspace and root project configuration, the
`package.json` workspaces edit, the matrix universe registry, the three graph
guard modules and their package scripts, the `setup-moon` composite action, the
fenced `ci` step, the `moon-graph` job and its gate dependency, the workflow
contract rules, the ownership wiring, this documentation, and the record itself.
The committed rollback proof binds the base and implementation SHAs, the
synthetic merge parent order, the predecessor and reverted tree identities, and
the fact that the reverted tree carries none of these six paths:

```
moon.yml
ci-matrix-universes.json
.github/actions/setup-moon/action.yml
scripts/template/graph-contract.ts
scripts/template/generate-graph.ts
scripts/template/validate-graph.ts
```

No `.devcontainer/**` file changed and the definition fingerprint is untouched,
so there is **no rebuild in either direction**.

## Decisions and deviations

Recorded because the next stage inherits them.

1. **The Stage 7 validator was repaired rather than the evidence re-captured.**
   Re-running a deliberately red and a draft workflow to restate an unfalsified
   fact would have been ceremony; the coupling that demanded it was the defect.
   See *What the capture found*.
2. **The `moon-graph` job also uses `setup-bun`.** The plan's step list named
   only checkout and `setup-moon`, but a runner has no Bun and `bun run
   graph:check` needs one. `install: "false"` keeps it to the binary.
3. **`setup-moon` is required to declare *no* inputs**, which is stronger than
   "no `bun-version`" and is what the accepted decision actually says. A job
   needing both toolchains composes the two committed actions.
4. **`moon-graph` appears in the shipped `ci-contract.ts` text of every render,
   including projects without the capability.** That is the substring
   false-positive the ownership signature deliberately excluded: the guard is
   core, its rule is inert when the job is absent, and fencing TypeScript
   statements across four regions risks a rendered guard that fails to load —
   the exact failure that file's own header warns about. No rendered *workflow*
   names it.
5. **`moon_affected_selection` was removed from `capabilityInventory.absent`**
   rather than moved to another list, following the Stage 4 precedent (`5c13ca2`
   removed `codex_cloud` when that stage implemented it).
6. **`classifyPath` takes the project list as a second argument.** It cannot
   answer "which project" without knowing the projects; the accepted decision's
   one-argument shorthand was not implementable.
7. **The `vcs.defaultBranch` assertion lives in the graph builder**, which is one
   commit later than the workspace edit that introduced the key, because the
   commit that introduced it had no validator to host it.
8. **The three new `scripts/template/*.ts` files declare `syncPolicy: "merge"`**,
   matching their `ci-contract.ts` siblings. Note the pre-existing boundary risk
   this inherits: `sync-devcontainer.sh` excludes all of `scripts/*` except three
   explicit includes, so `scripts/template/**` sync is already aspirational —
   already recorded under `knownBoundaryRisks`, and not changed here.
9. **The `--json` flag is gone from moon's query family in 2.x.** Recorded here
   because it is the single most likely thing to be "restored" by someone
   porting an older snippet.
