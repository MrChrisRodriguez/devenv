# Stage 10E Experiment hygiene

Tasks 17.1–17.3. Capability gate: **none — this stage is core**. Domain word:
`experiment`. Predecessor: the Stage 10D merge
`40f597aa83e44333c6b119b05ebe217fc9ea0b21`.

Everything before this stage shipped a *capability*: a fence, a
`capabilitySignatures` entry, a residue token, a `packageRules` entry, a fenced
`ci.yml` step. This stage ships none of them, and that single decision shapes
every other one in this document.

## Why this one is core, and the evidence is arithmetic

`apps/**` and `libs/**` are `project-owned` with `renderPolicy: copy` in the
first pages of the ownership file. They exist in every render of every profile,
with a `.gitkeep`. `package.json#workspaces.packages` is `["apps/*","libs/*"]`,
`.moon/workspace.yml#projects.globs` is the same pair, and `tsconfig.json`
includes `apps/**/*.ts` and `libs/**/*.ts`. A `minimal` project can grow an
experiment on its first day.

Three measurements settled it:

1. **Stage 0 reserved nothing.** `experiment`, `prototype` and `hygiene` all
   return **zero hits** in `docs/devcontainer-upgrade/stage-0/template-ownership.json`,
   and `experiment` returns zero in `template-parameters.toml`. Stage 0 reserved
   a path set, a token set and a package rule for all fourteen capabilities it
   anticipated. It anticipated none here — the only surface in this program of
   which that is true.
2. **The word cannot be a token.** `git grep -Fil "experiment"` returns **35
   files**, almost all of them OpenSpec command and skill artefacts carrying
   `Generated from @fission-ai/openspec by \`openspec artifact-experimental-setup\``,
   plus `.devcontainer/on-create/setup-openspec.sh`. Those ship behind a fence
   that is `true` by default, so a capability whose token was `experiment` would
   fail every render of every profile.
3. **The precedent exists and is large.** `ci:check`, `toolchain:check`,
   `image:check`, `rules:check` and `worktree:check` are all unfenced steps in
   the `ci` job over core contracts.

The consequence, accepted explicitly: the registry, its schema and both script
files ship in `minimal`, `cloud` and `full`. The anti-residue scan must find
**nothing** about them, which is automatic because there is no signature — and
the render probe asserts it anyway, so that a future stage which *does* gate
this surface has a failing probe to notice rather than a silent change.

The rejection case, stated fairly: a capability named `experiments`, default
`false`, would let a downstream project opt out of the whole surface, and that
is a real thing some projects want. It fails on point 2 alone — and even with a
safe token, the *guard* would then be absent from the default render while
`apps/` and `libs/` are present in it. A hygiene rule that is off by default in
the only tree that has the directories it governs is not a rule.

## The problem this stage actually solves

`apps/` and `libs/` hold a `.gitkeep` and nothing else, here and in every
rendered project. A guard that enumerates experiments finds zero, reports green,
and is precisely the vacuous pass `specs/template-release-validation/spec.md:3-9`
exists to refuse — *"WHEN a dependency scan unexpectedly discovers no inputs
THEN the guard fails distinctly instead of passing vacuously."*

So the guard is pointed somewhere else.

**An experiment cannot weaken a guard by existing. It weakens one by adding an
exception** — and every exception surface in this repository is a short,
committed, enumerable list:

| Surface | Path | What weakens it |
|---|---|---|
| manifest | `package.json` `workspaces.packages` | narrowing a glob so a directory stops being a workspace member |
| Moon | `.moon/workspace.yml` `projects.globs`, `sources.root` | narrowing a glob; a non-root `workspace.inheritedTasks.exclude` |
| typecheck | `tsconfig.json` `include` / `exclude` | adding a workspace path to `exclude`, or removing one from `include` |
| dead code / formatter | `biome.jsonc` `files.includes` negations, `overrides[].includes` | a `!apps/…` negation, or an override that turns a tool off |
| dead code / tracking | `.gitignore` | ignoring an experiment's directory, which hides it from every guard at once |
| CI | the tolerance surface under `.github/workflows` | a toleration or a step condition that names an experiment |
| universe | `ci-matrix-universes.json` | a project in no universe |

The registry declares each list's expected contents; the guard refuses drift it
does not declare. **With zero experiments the guard inspects seven surfaces and
reports `scanned: 7`. Zero scanned is a hard failure, not a pass.** That is the
anti-vacuity anchor, it is meaningful on an empty tree, and it is the only
formulation that is.

And the lock is a **declaration** lock rather than a freeze. Changing a surface
*and* its declaration in the same commit is green. That is the whole point: the
drift becomes a decision somebody makes in a commit rather than a side effect of
a directory appearing.

## The evidence that unlocked exception lists rot is one line long

The repository this template mirrors carries this in its `.gitignore`, under a
`# Project-specific` heading:

```
**/experiments/agent/.output/
```

`git log --oneline -S "experiments/agent" -- .gitignore` returns the **initial
commit**. No `experiments/` directory has ever existed in that repository. The
ignore entry was written for something that either never landed or was deleted
before anyone looked, and it has outlived it by the entire life of the
repository, because nothing ever compared the exception list to anything. The
same block ignores `**/hasura/config.yaml`; there is no Hasura either.

The corroborating evidence is a policy that repository **reversed in writing**.
`scripts/openspec-validate-all.sh:11-17`:

> it used to be an explicit rule here NOT to pin a count. That was wrong, and
> the Start decommission proved it: the `find` below is a glob, so deleting an
> app that owns capabilities takes its whole `openspec/` out of the sweep and
> this script still prints "all strict-valid" — over fewer directories.
> `OPENSPEC_EXPECTED_DIRS` below is the deliberate reversal: the count is pinned
> so the shrink is a decision someone makes in a commit, not a side effect of a
> deletion.

A deletion made a guard shrink and report success. This stage's registry is that
pin — **derived rather than typed**, which is strictly better, because the
reference's other hand-typed integer (`KNIP_EXPECTED_APPS=13`) is currently
wrong by fifteen.

## The registry and the tree must agree in BOTH directions

Derived mode is `active` the moment a tracked path under `apps/*` or `libs/*`
names a directory that is not a capability's reserved name and is not a
`.gitkeep`. Today: zero, so `skeleton`, and the two committed placeholders are
the reason the predicate has to name them.

Two different defects, and only implementing the first is the mistake that
matters:

- **A directory with no registry entry** is an undeclared experiment. Easy half.
- **A registry entry whose directory holds no tracked file** is a removal that
  never finished, and it must move to `retired[]` rather than be deleted. This
  is the half a deletion actually produces, and the half that catches it.

Mode reconciliation runs **first** and short-circuits: every leg below it reads
the registry as if it described the tree, so running them over a registry that
demonstrably does not would print a page of consequences for one cause.

## Removal is proved by what is no longer there

"Removal SHALL remove dependencies/registration" is a statement about something
that is *gone*, and a guard cannot enumerate what is not there. Deleting the
registry entry along with the directory leaves nothing to check, and the guard
goes green because the evidence of the failure was deleted too.

So a `retired[]` entry is **permanent**. It records the id, the directory, the
retirement date, a findings artefact and an `aliases[]` union, and it asserts
three things: the directory is gone, the findings artefact exists, and **no
tracked file outside a narrow allow-list names any declared alias**.

The shape is not an invention. `worktree-contract.ts:28-49` does exactly this
for the launcher Stage 5B superseded, and its header is the argument:

> documentation can claim anything, but a tracked file still naming the old
> entry point is a fact.

Its allow-list is the one this stage needs, for the same reasons: `CHANGES.md`,
`evidence/`, `docs/devcontainer-upgrade/`, `openspec/`, derived graph output,
the guard itself — plus `experiments.json`, which carries the tokens in order to
look for them, and the entry's own findings file.

**The scan is a union of DECLARED aliases and never a widened regex over the
id.** That rule is the reference's own, from the guard it built for the largest
deletion in its history (`scripts/ci/check-legacy-spa-removal-inventory.ts:58-70`):
*"The scan is the union of every declared alias, NOT a widened regex: each
spelling is declared, justified, and individually falsifiable."* A
three-character id turned into a pattern matches half the tree, the guard cries
wolf, and the rule is switched off inside a week.

The committed probe proves the matcher **finds** things rather than passing
because it is broken: it runs a synthetic retired record over this repository
with a token that genuinely appears in it, asserts the hit by file and by alias,
and asserts that the allow-listed mentions are correctly tolerated. That probe
token is assembled from parts at run time — a literal would fail the guard that
*owns* that token, and a refusal pointing at the wrong file is worse than no
refusal.

## Containment is the opposite of what "hygiene" suggests

A quarantine directory — `spikes/`, `scratch/`, a root folder — is the answer a
reader expects, and it is refused **precisely because it works**. Outside the
workspace globs the code is invisible to Moon, to `package.json#workspaces` and
to `tsconfig.json`'s include list at the same time, which is dead code by
construction rather than by neglect. Inside them a directory automatically
inherits `lint`, `typecheck`, `test` and `build` from `.moon/tasks.yml` and
automatically becomes subject to the universe rule — which is exactly the
strictness 17.1 asks to preserve.

`.moon/workspace.yml` records why the globs are a pure allowlist, in its own
words: `scripts/*` used to be listed there and is deliberately gone, because
those directories are tooling rather than packages and every one of them became
a moon project inheriting four tasks it had no way to run.

The `inheritedTasks.exclude` rule follows: exactly one project may carry one,
and it is the root, whose own `moon.yml` says why — *"Inherited by a project
whose directory is the whole repository, each of them would run over
everything."* An experiment's `moon.yml` carrying one is the cleanest possible
way to weaken Moon strictness while looking tidy, and it is refused by name.

## The universe registry is read as DATA and never imported

`ci-matrix-universes.json` is `requiresAll: ["moon_affected_selection"]` and is a
signature path of that capability, which defaults to **`false`** — so in the
default render the file is not there. The module that owns it is gated on the
same capability. A core guard that imported it would be a **module-load crash**
in every default project, which is not a diagnostic: the guard would not report a
problem, it would fail to start.

So the file is read with `Bun.file`, and the three answers are kept distinct:

- **Absent** → a named notice per declared experiment. "Could not compare" is not
  "found nothing wrong".
- **Present, project in no universe** → a **notice** naming the module that
  already prints that sentence. Two refusals for one defect send the reader to
  two files.
- **Present, declared `universeId` not in the registry** → an **error**, because
  nobody else owns that sentence.

The same discipline governs the CI leg: `ci:check` already refuses a tolerated
failing step, with an allow-list whose comment says it is consulted rather than
assumed empty *so that adding an entry is a deliberate, reviewable act*. This
guard emits a notice naming it and adds only the two halves nobody covers — a
declared toleration matching nothing in the tree, and a toleration or step
condition that names a declared experiment.

## "Dead-code strictness" has no incumbent to preserve

17.1 says "preserve … dead-code … strictness". Measured:
`grep -rniE "knip" --exclude-dir={node_modules,.git} .` returns **zero hits**.
There is no dead-code guard of any kind in this repository, and you cannot
preserve what does not exist.

Three reasons not to add one:

1. It is a package, in a repository whose `apps/` and `libs/` are empty, so it
   would report nothing until a downstream project writes code — and it would be
   the first `bun.lock` change in five stages.
2. It would need its own configuration file, which is a **new exception
   surface** — the very thing this stage exists to lock.
3. The reference *has* it, and its state is the strongest argument against
   importing it: 28 per-package `knip.json` files (13 under `apps/*`, 15 under
   `libs/*`), a moon task, a CI job and a gate `needs` entry — and
   `scripts/knip-all.sh` and `knip-staged.sh` both glob `apps/*/knip.json`
   **only**, so the fifteen `libs/*` configurations are never executed by either
   sweep, with `KNIP_EXPECTED_APPS=13` locking that scope in. A dead-code oracle
   is exactly as trustworthy as its scope guard; that scope guard is a hand-typed
   integer and it is currently wrong by fifteen. devenv would be adopting the
   guard *and* its failure mode, over an `apps/`/`libs/` that hold a `.gitkeep`.

What is discharged instead is the honest reading: in this repository "dead code"
is code no guard looks at, and there are exactly two ways to produce it — put the
directory outside the workspace and project globs, or exclude it from the
compiler and the linter. Both are locked surfaces, and a promoted experiment
additionally has to carry a test **inside its own directory** so `bun test` has
something to find.

## Why the test requirement is not a style rule

`scripts/ci/run-tests.sh:36-46` absorbs "no test files matched" as a notice and
exits 0, by design, so a freshly rendered project is not red on its first commit.
`run-typecheck.sh:36-38` absorbs TS18003 the same way. Both absorptions are
correct and stay.

Together they mean a promoted experiment with no tests and no TypeScript is
**green forever** in a project that has no other tests. Nothing else in the
repository can see that. The per-experiment assertion — at least one file inside
the experiment's own directory matching its declared `testGlob` — is what closes
it, and it is the reason "add tests" looks like a style rule until you know why
the CI wrapper cannot catch it.

## The findings artefact is the only thing a removal may leave behind

`specs/agent-spec-safety/spec.md:47` — *"while reusable findings may remain in a
decision/backlog artifact"* — is the only clause of the scenario describing
something that **survives**, so it is the only thing a removal guard can hold
onto.

The rule that makes it non-trivial is the location: the artefact must exist, be
under a declared findings root (`CHANGES.md`, `docs/`,
`openspec/changes/archive/` — all three documentation paths in the affected
oracle, so a findings file rebuilds nothing), and **not be inside the directory
that was deleted**. A `FINDINGS.md` in the spike's own folder dies with the
spike, which is exactly what happens, which is why this stage exists.

This is not an invention either — it is the reference's actual, repeated
practice. Its own rollout document says a gating spike produces *"a findings
doc, no code → no review/test gate"*, and there is a worked instance run on a
throwaway branch against a throwaway provider app-id whose only committed residue
is the findings document. Its `.gitignore` states the thesis in one line: the
mutation sandbox and reports are pure scratch, *"scores are committed only in
`scripts/ci/mutation-baselines.json`"* — the artifact is disposable, the
distilled result is committed.

The alternative is a `findingsWaiver` carrying a reason. "This spike taught us
nothing" is a real and legitimate outcome and forcing a lie is worse than
recording a claim — but it must be a **waiver with a reason**, honoured and
reported, never an optional field that defaults to absent. The reference's own
audit discipline is the model: waivers *"are honored but reported as WARNINGS;
never silently ignored"*. A waiver standing beside the findings it would lift is
refused in turn, because a stale exemption widens itself.

## The graphify boundary — what this stage takes, and what stays deferred

Stage 9 deviation #12 parked the full `graphify` capability signature at Stage 11
§18.1. **This stage does not close it**, and three facts say it should not — the
third being new information Stage 9 did not have:

1. **Stage 9 named a destination and it is not this stage.** Stage 11 §18.1 owns
   the disabled-residue / source-identifier / mutable-pin / duplicate-rule
   sweep. 10D deviation #16 refused the same class of move: *do not widen
   another capability's signature from a stage that does not own it.*
2. **Two of the three surfaces are structurally unfenceable.** A capability fence
   in this repository is a **line comment**. `tsconfig.json`'s `exclude` array
   carries `"graphify-out"` in **strict JSON** — there is no comment syntax and no
   way to fence one element of an array. `.claude/settings.json` embeds
   `graphify-out/graph.json` inside a shell one-liner inside strict JSON, and
   `render-fixture.ts`'s hook filter prunes hooks *only* by matching a script
   filename against its owner table — the graphify nudge hook invokes no script,
   so a `graphify=false` render emits it today and would keep emitting it.
   `biome.jsonc` is JSONC and *could* carry a comment, but its own header says
   why it must not name a capability: the globs are deliberately generic because
   the file is copied into every rendered project and the anti-residue scan is a
   plain substring search.
3. **A signature added today would sit inert.** `render-fixture.ts` selects the
   scanned set as *default-false capabilities that have a signature*, and
   `template-parameters.toml` has `graphify = true`. Whoever does the work has to
   change the **default** or change the **scan**, and neither belongs in a stage
   about experiments. **Anyone who reads Stage 9's note and reaches for the
   obvious one-line fix will produce a green diff that changes nothing.**

What this stage *did* take from graphify: the precedent shape for a retirement
scan (`worktree-contract.ts:28-49`, allow-list and all), `graphify-out/` in
every walk-prune list and in the retirement allow-list, and one finding recorded
below.

## Findings recorded, not acted on

- **The top-level blind spot, with a live instance.** This guard sees `apps/*`
  and `libs/*` only. A tracked directory anywhere else is invisible to it — and
  the reference is standing in exactly that hole: `devenv-changes/` is 7 tracked
  files describing itself as *"a self-contained OpenSpec root"*, it is not a
  Moon project, it is not swept by `openspec-validate-all.sh`, it has no
  `knip.json` and no `tsconfig`, and `grep -rn "devenv-changes"` across the
  repository returns **zero references**. Checked by nothing, pointed at by
  nothing, permanent — the exact state the requirement forbids, in the tree this
  template mirrors. The containment rule would not catch it, because nobody
  would ever declare it. **Not closed**, because the only closure is a
  `knownTopLevelDirectories` allow-list of nineteen entries, most belonging to
  other capabilities and several gated, which would make the first `docs-site/`
  or `terraform/` a downstream project creates fail a guard about experiments.
  That is a top-level layout rule wearing an experiment rule's clothes, and it
  belongs to Stage 11 §18.1. The cheapest honest narrower version, if it is ever
  wanted: refuse a tracked top-level directory containing a `package.json` that
  is not `apps/`, `libs/` or a declared exception — three lines, and it would
  have caught nothing in the reference, which is a fair argument that it would
  catch nothing here.
- **The knip gap.** No dead-code guard exists here at all. Its natural neighbour
  is Stage 11 §18.1's **duplicate-rule scan**, and the honest precondition is
  that a dead-code oracle belongs *after* the first generated application exists
  — over an empty `apps/`/`libs/` it is the definition of a vacuous pass.
- **The reference's own knip sweep misses 15 of its 28 configurations**, and its
  scope guard is a hand-typed integer that has been wrong the whole time. Recorded
  because it is the argument, not an aside.
- **The graphify signature would sit inert** (point 3 above). Stage 11 §18.1
  needs this, and Stage 9 did not have it.
- **Two graphify surfaces cannot be fenced at all** (point 2 above). Stage 11
  §18.1 needs this too: adding the signature is not the hard part.
- **`.husky/pre-commit`'s guard matches `graphify-out/graph.json` and nothing
  else.** `graphify-out/graph.html` (674 KB) and `GRAPH_REPORT.md` are also
  committed artefacts and stage silently beside a feature change. The reference
  has the identical narrowness, plus a comment claiming to mirror a
  `.gitattributes` that does not exist there. **Recorded; not widened from this
  stage** — both hooks belong to the worktree contract.
- **`graphify-out/graph.json` still names a deleted experiment** until the next
  `graphify update .`, so it is literally "a registration that remains" after a
  removal. Requiring the removal commit to refresh it would directly contradict
  the pre-commit hook, which rejects that file staged alongside any non-graphify
  file, and `AGENTS.md`, which says refresh happens only in a dedicated
  `chore(graphify)` commit on the default branch. It is in the retirement
  allow-list for the reason `worktree-contract.ts` already gives: *derived output
  regenerated from whatever the tree currently says.* **A finding, not a rule.**
- **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`,** which has
  not been a capability since PR #21 and which nothing validates. Left again, for
  the sixth stage running; this stage has no reason to open that block at all.

## Scope

**New:** `experiments.json`; `experiments.schema.json`;
`scripts/template/experiment-contract.ts`;
`scripts/template/validate-experiment.ts`;
`scripts/template/__tests__/experiment.test.ts`;
`scripts/template/__tests__/fixtures/experiment-workspaces.ts`;
`scripts/template/stage-ten-e-evidence.ts`;
`scripts/template/collect-stage-ten-e-evidence.ts`;
`scripts/template/__tests__/stage-ten-e-evidence.test.ts`;
`evidence/stage-10e-experiments.json`;
`evidence/stage-10e-experiments.schema.json`;
`evidence/stage-10e-experiments-run/`; this document.

**Modified:** `scripts/template/validate.ts` (one call, four report fields);
`scripts/template/__tests__/template.test.ts` (the all-three-renders assertion);
`.github/workflows/ci.yml` (one **unfenced** step in the `ci` job);
`package.json` (`experiments:check`);
`docs/devcontainer-upgrade/stage-0/template-ownership.json` (four
`ownershipRules` `copy` entries); `AGENTS.md` (an **unfenced** section);
`CHANGES.md`; `openspec/changes/portable-devcontainer-upgrade/tasks.md`.

**Unchanged, deliberately, and the list is unusually long because seven of them
are the surfaces this stage *locks*:** `template-parameters.toml` and its
schema; all three `fixtures/template/*.toml`; `scripts/template/parameters.ts`;
`bun.lock`; `package.json#workspaces` and `#devDependencies`; `.devcontainer/**`;
`.husky/**`; `.claude/settings.json`; `.gitignore`; `.gitattributes`;
`biome.jsonc`; `tsconfig*.json`; `.moon/**`; `moon.yml`;
`ci-matrix-universes.json`; `scripts/worktree/**`; `scripts/ci/**`;
`graph-contract.ts`, `generate-graph.ts`, `ci-contract.ts`,
`worktree-contract.ts`, `toolchain.ts` (every one cross-referenced, none
edited); `apps/`; `libs/`. **A diff touching any of the seven means the guard was
implemented as an edit rather than as an assertion.**

No `artifactRules` entry, no `packageRules` entry, no `capabilitySignatures`
entry, no `capabilityInventory` change, and no new CI job.

## Requirements this stage discharges

| Requirement | Path | Discharged by |
|---|---|---|
| **Experiment hygiene** — "Experiments SHALL be marked disposable or promoted and MUST NOT weaken Moon, dead-code, manifest, typecheck, or CI guards; removal SHALL remove dependencies/registration, while promotion SHALL add normal ownership, graph, universe, tests, and documentation" | `specs/agent-spec-safety/spec.md:42-43` | the whole stage; the four clauses are the four feature commits in order |
| **Disposable app is removed** — "WHEN a spike is deleted THEN no dependency, workspace registration, universe entry, or guard exception remains, while reusable findings may remain in a decision/backlog artifact" | `specs/agent-spec-safety/spec.md:45-47` | the retirement residue scan and the executed removal lifecycle |
| **Every guard proves good and bad behavior** — "WHEN a … dependency scan unexpectedly discovers no inputs THEN the guard fails distinctly instead of passing vacuously" | `specs/template-release-validation/spec.md:3-9` | `scanned: 7`, and zero as a hard failure. The sharpest possible relevance: an experiment scan finds nothing *by design* here |
| **Mechanically testable rule changes** | `specs/agent-spec-safety/spec.md:6-8` | the unfenced `AGENTS.md` section plus `rules:sync`, and the rule that the workflow step and the `validate.ts` call land in the same commit as the module |
| **Capability-complete generation** | `specs/template-capability-model/spec.md:15-21` | the *inverse* obligation: this surface is core, so its files appear in **all three** renders and its script is never a capability token |

The spec deltas are not amended: the change is approved and under
implementation, and this mapping belongs here rather than there.

## Validation

Run on every commit: `experiments:check` plus the fourteen other `*:check`
scripts; `template:validate`; `template:typecheck`; `typecheck`; `biome check`;
`bun test scripts/template/__tests__` **redirected to a file with the exit code
read from `$?`** and never through `tail`; `bash scripts/worktree/selftest.sh`;
`bash .codex/cloud/selftest.sh`; all three fixtures rendered with the residue
scan green and `experiments:check` run **inside each rendered tree**; the double
render byte-identical; `git status --porcelain` clean with `graphify-out/` never
staged.

Five diffs asserted empty on **every** commit: `.devcontainer/`, `.husky/`,
`bun.lock`, the seven locked surfaces, and `apps/`/`libs/`. `package.json` is
non-empty only on the first commit and only in its `scripts` block.

Final tree: **562 tests across 32 files, 0 fail.**

## Live evidence capture

`evidence/stage-10e-experiments.json` seals **seventeen** exact commands with
sha256-bound raw logs in `evidence/stage-10e-experiments-run/`: two guards, the
whole refusal matrix, eleven legs run one at a time under their own test-name
filters, both executed lifecycles, the render probe and the rollback proof. The
one thing this repository cannot fabricate is the live gate — CI run
**31197689568**, `pull_request`, `conclusion: success`, at the reviewed boundary
`70bef16124ce00024481a93f23903205a982eb8a`.

Three things about this record are new:

- **`repository.capability` is `null`,** pinned `null` in the schema. Every
  record since 10A named a capability there.
- **`source.policy` seals the seven exception surfaces** rather than a list of
  experiments, because with `experiments: []` a sealed count would be zero. The
  validator reconciles it against the committed registry **and** runs the
  guard's own inspection over the tree, because sealing a declaration only proves
  somebody typed it.
- **The render probe is inverted.** Every predecessor proved a disabled render
  carries no trace of a capability. This one proves all three renders carry the
  four files, the package script, an unfenced step and a real verdict with seven
  surfaces inspected — plus one negative that must stay empty.

`template:validate` is deliberately not a captured command: run before the record
exists it fails, run after it can never seal its own log. Capture ran on the
**host**, for the fifth stage running — this stage owns no container-only binary.

## Rollback

`git revert -m 1 <stage-10e-pr-merge-commit>`. `outsideTheTree: []` and
`containerRebuildRequired: false`, both sealed, and the second is a **measured**
claim rather than a promise: `devcontainerFilesChanged: 0` and
`huskyFilesChanged: 0` are counted between the predecessor and the boundary and
sealed beside the flag.

The revert is **simpler** than its four predecessors rather than harder, and for
the same reason the stage is core: there is no capability to un-declare, no
signature to withdraw, no `packageRules` entry to remove and no residue token to
retire, so the reverted tree differs from the predecessor in nothing at all. The
synthetic-merge proof shows exactly that, and additionally that the reverted tree
carries none of the four added paths while the implementation tree carries all
four. The merge parents are checked **in order**, because `-m 1` reverts the
first parent and reverting the other one produces a tree that looks plausible and
is not the predecessor's.

Nothing lives outside the tree: no repository variable, no branch-protection
change, no operator step. The revert is order-independent.

## Decisions and deviations

Seven deviations were recorded during implementation and two more during the
evidence capture. All nine are here.

1. **`policy.reservedDirectories[].capability` became `ownershipPattern`.**
   Planned as `capability`. **Forced by measurement:** `rhf_zod` contains `zod`,
   which is that capability's own residue token, and `experiments.json` ships to
   every render. The first draft failed **all three** fixture renders in the
   renderer with `{capability: "rhf_zod", path: "experiments.json", signature:
   "zod"}`. The field now cites the ownership pattern that reserves the directory
   (`libs/forms/**`) — a *path* signature, matched by a file's location and never
   by its contents — and the guard cross-checks that the pattern really exists in
   `artifactRules` or `capabilitySignatures`. The capability is still named,
   once, where it already was.
2. **A new core rule, not in the plan: a core file may not contain any declared
   capability signature token.** Added to the ownership leg after deviation 1
   bit. Without it, the next occurrence is a page of renderer output pointing at
   the wrong file; with it, it is one sentence naming the file, the token and the
   capability. It also caught `graph:check` in a schema description, which was
   rewritten. This is the program-level improvement of the stage.
3. **`policy.toleratedIgnorePatterns` added.** The plan's field list omits it,
   but the `.gitignore` rule requires the build-output family to be *declared* as
   tolerated rather than special-cased, so the list of things the rule does not
   catch is as legible as the list it does. Populated with exactly the five
   patterns the plan names.
4. **Generated-block staleness is a notice, not a refusal.** The plan asked the
   promotion leg to assert the `moon.yml` block matches what the generator would
   emit. `generate-graph.ts` imports the project-graph contract and both are
   gated on `moon_affected_selection`, so importing either from a **core** module
   is a module-load crash in most rendered projects. The guard asserts the marker
   pair (hardcoded literals, not an import) and emits a notice naming the module
   that owns the comparison — the same discipline the universe leg uses.
5. **`Bun.spawnSync` for `git ls-files`,** against a standing instruction to
   prefer async spawning. All four sibling contracts use `spawnSync` for the same
   instantaneous call, and `deriveTreeState` and the residue scan are synchronous
   exports the tests drive directly. The commit-6 fixtures' `git init` and
   `commit` **do** use async `Bun.spawn`.
6. **The ownership file cannot be a retirement-scan test target.**
   `docs/devcontainer-upgrade/` is in the plan-mandated allow-list, so the
   "leftover ownership rule" case was replaced with a leftover **workflow step**
   naming the directory. The residue cases proved end to end are a workspace
   dependency, a universe entry and a cross-project `moon.yml` dependency.
7. **The real-repository probe token is assembled at run time.** A literal made
   `worktree:check` fail — Stage 5B's superseded-launcher scan refuses any tracked
   file outside *its* allow-list naming that token, and the experiment suite is
   not on that list. Caught by the full sweep rather than by the experiment
   suite, and the test's own comment records why.
8. **The rollback proof's field names differed from the first schema.** The
   shared prober emits `syntheticMergeTree` and `syntheticMergeParents`, not the
   `implementationTree` / `revertSha` the schema first declared. The collector's
   self-validation **rejected the capture before writing anything** — the third
   stage running in which that check has earned its keep. The schema and the
   validator were corrected, and the correction was used to *strengthen* the
   proof: the merge parents are now asserted in order, because `-m 1` reverts the
   first one.
9. **Three sealed diagnostics had no committed assertion, so tests were added
   rather than fragments dropped.** `declares skeleton mode but declares N
   experiments`, `declares active mode but declares no experiment` and `a rule
   with no input has answered nothing` were cited by the record and asserted
   nowhere. A record may claim a surface is guarded only while a committed test
   still exercises it, so the coverage was added in the evidence commit. Two
   further fragments were narrowed to their literal, non-interpolated substrings
   — the trap the last two stages both hit.

## What this stage did not do

- **No experiment in `apps/` or `libs/`.** A single `apps/spike-example/` would
  make every leg fire against real files, and it is refused: it would be the
  first non-empty `apps/` entry in the program, it would need an entry in a file
  gated on a *different* capability, and in the legal combination
  `moon_affected_selection = false` the project would exist with no universe to
  belong to. The Git-backed lifecycle fixtures prove the same things.
- **No `.husky/` edit.** The graphify staging guard makes `pre-commit` look like
  the natural home for "an experiment artefact was staged". Both hooks are the
  worktree contract's territory; an experiment is source code that is *supposed*
  to be committed, so it has no analogue to a 4.5 MB generated artefact that is
  also committed; and CI does not enforce the graphify guard at all, so a
  hook-only rule is bypassable by a documented flag.
- **No knip and no package.** Fifth consecutive empty `bun.lock` diff.
- **No new CI job.** One unfenced step in the existing `ci` job.
- **No top-level directory allow-list.** Recorded as a finding above.
- **No change to the graphify signature.** Deferred to Stage 11 §18.1 with two
  new facts it needs.
