# Changelog

This file documents changes made to this template repository. Each entry provides enough detail for downstream projects (repos based on this template) to adopt the same change manually.

---

## 2026-08-06 — Fix: anchor Stage 7 evidence checks on the sealed gate

**Goal:** Stop a sealed, green historical capture from being reported as fabrication the first time a later stage adds a CI job.

**How to implement:** `scripts/template/stage-seven-evidence.ts` re-resolved the gate's dependency list out of the *current* `.github/workflows/ci.yml` and then required the sealed record to match it exactly — and required each sealed live run to have reported exactly that many jobs. That holds only until the workflow grows. Stage 8A adds a `moon-graph` job, and the record instantly failed with `recorded gate identity is not the committed one` plus green, red and draft run drift, for a capture nothing had falsified. The only "repair" the old shape allowed was re-running three live workflows — including a deliberately red one and a draft one — to restate a fact that was still true.

The run-shape assertions are now anchored on the record's **own** `repository.gateNeeds`: the sealed runs claim "every job the gate depended on when this ran reported into it", which stays true forever, and a record whose runs disagree with its own dependency list is still rejected. The identity check became a **subset** test: every sealed need must still be declared by the committed gate, so a renamed or removed lane still fails, while an added one does not. Whether the gate is complete *today* is a live question that already has an owner — `scripts/template/ci-contract.ts` requires the aggregate gate to depend on every job in its file and fails the build when it does not — so nothing is lost by not asking it twice.

This is the same mistake the Stage 5A validator made against an absolute host path, fixed the same way: assert the property that made the capture meaningful rather than re-deriving an environment-specific value. Three tests pin the new shape — a record whose sealed runs disagree with its own `gateNeeds` fails, a sealed lane the committed gate no longer declares fails (with the unmutated workflow as the control), and a gate that grew a lane passes while the committed gate is asserted to be a strict superset of the sealed one.

**Why downstream cares:** Nothing in a rendered project changes; this is template evidence tooling. The transferable rule is the one the fix encodes: a sealed record must be validated against itself and against properties that survive legitimate evolution, never against a value the current tree happens to hold.

---

## 2026-08-06 — Add: Moon project graph and its drift oracle

**Goal:** Give this repository a project graph that is small, correct, and *checked*, so the affected-selection work that follows has something trustworthy to select against. Before this stage `.moon/workspace.yml` globbed `apps/*`, `libs/*` and `scripts/*`; `apps/` and `libs/` are empty skeletons, so the entire graph was the three tooling directories under `scripts/` — none of which is a package — plus a warning per loose file there ("Received a file path for a project root, must be a directory"). Meanwhile `vcs.defaultBranch` was unstated, which means moon's own default `master`: every "what changed" query would have silently diffed against a branch this repository does not have.

**How to implement:**

**The graph is anchored on a root project.** `.moon/workspace.yml` now declares `projects.globs: ['apps/*', 'libs/*']` and `projects.sources.root: '.'`, and a new root `moon.yml` gives that project `workspace.inheritedTasks.exclude: [lint, typecheck, test, build]`. The two halves are one decision. Dropping `scripts/*` removes projects that were never packages; adding the root keeps the graph from becoming *empty*, which matters more than it sounds: a query over an empty graph is trivially true, so a drift oracle over it would report "no drift" by having nothing to compare, in the template and in every freshly rendered project. The task exclusion is what makes a root project safe — those tasks are written for a package, and a project whose directory is the whole repository would run each of them over everything, so `moon run :lint` would lint the repo once for `root` and again for every real project inside it.

`scripts/*` also leaves `package.json#workspaces.packages` in the same change, for the same reason: those directories have no `package.json`, so they were never workspace members. `bun.lock` records only the root workspace, so this edit is verifiably zero-churn — `bun install --frozen-lockfile` after it leaves the lock byte-identical, which is the check to run rather than to assume.

`vcs.defaultBranch: 'main'` is stated explicitly. It is the same authority as `template-parameters.toml [project] default_branch`, and the graph contract asserts the two agree, so the value cannot drift away from the branch protection actually gates.

**Project configs are derived, not hand-maintained.** `scripts/template/graph-contract.ts` builds the project graph from first principles — the workspace declaration, the `package.json` manifests, and the source imports — and never runs moon. That independence is the whole point: a guard that asked moon what the graph is could only ever agree with moon. Manifest edges come from any dependency section carrying a `workspace:` value or a key that names another project's package; import edges come from scanning `**/*.{ts,tsx,js,jsx,mts,cts}` for `import`, `export … from`, dynamic `import()` and `require()`, resolved against project package names, their `<name>/*` subpaths, and the `@<slug>/*` → `libs/*/src` alias read out of `tsconfig.base.json` (read, not hardcoded — the renderer rewrites that slug for every downstream project).

Two details are load-bearing. Comments are stripped before anything reads an import, with a small state machine rather than a regex, because the two cases that matter — `//` inside `"https://…"` and `/*` inside a template literal — are exactly the ones a regex gets wrong; without it a commented-out import becomes a dependency the generator declares and the oracle then demands forever. And a file is attributed to the **deepest** project whose source contains it, because the root project's source is the whole repository: without deepest-wins, every nested project's imports would also become the root's.

`scripts/template/generate-graph.ts` (`bun run graph:generate`) writes the derived edges into each project's `moon.yml` as a sorted `dependsOn`, inside a `# graph:generated:start` / `# graph:generated:end` block. Everything outside those markers is hand-written and copied through untouched, so a project config can carry tasks, tags and a language declaration and still be regenerated safely. A project with no derived dependency gets a comment saying so rather than an empty `dependsOn`, so the file never states something it cannot justify. Only glob-discovered projects are generated: the root `moon.yml` is hand-written core configuration and the generator has no opinion about it.

**One registry says which projects CI runs over.** `ci-matrix-universes.json` at the repository root lists the universes a CI lane can be built from, and there is exactly one universe (`ci`) because there is exactly one required lane — a second universe would need a second lane to run it, and a universe nothing runs is a list of projects nobody checks. The rules are total rather than advisory: `schemaVersion` must be 1, ids must be unique kebab-case, no universe may be empty, every listed id must be a real project, and every real project must appear in **exactly one** universe. A project in none is a project no lane ever builds, which is the silent hole the file exists to close; a project in two is a lane that runs it twice and reports one result. Absence and a parse failure are hard errors, not a skipped check.

The registry is also required to be the *only* one: the guard asks Git for every tracked `*universes*.json` and rejects any second file. A well-meaning `ci-matrix-universes.backup.json` would be a second authority that disagrees silently.

The filename is not a preference — it is the path Stage 0 already recorded as this capability's signature, so this stage's artifact rule and the file had to land together: without the rule, a project that disables `moon_affected_selection` would render a copy of the registry and fail its own anti-residue scan by construction.

**The oracle has two legs, and both fail closed.** `scripts/template/validate-graph.ts` (`bun run graph:check`) is the guard. Leg 1 is **hermetic** and always runs: it rebuilds the graph from the manifests and sources, compares it with what every committed `moon.yml` declares, dry-runs the generator and rejects stale output ("generated moon.yml is stale — run bun run graph:generate"), and validates the universe registry. It needs no moon binary, which is what lets it run in the required lane, inside `template:validate`, and on a developer host that has neither moon nor proto. Its verdicts are deliberately distinct — missing edge, extra edge, undeclared import, unknown project, missing project — because they are different defects with different repairs.

Leg 2 is **live** and runs only under `--query`: it asks moon for the graph and reconciles the two answers. It is the only leg that can catch a disagreement between what this repository believes and what moon actually does. The invocation is pinned in one exported constant: `moon query projects`, with **no** `--json`. That is a verified fact about moon 2.3.5 rather than a style choice — `moon query projects --json` exits 2 with "unexpected argument '--json' found", because in moon 2.x the whole `query` family emits JSON by definition. A guard that kept the old flag would fail every run and get "fixed" by deleting the query, which is how a live oracle quietly becomes a no-op.

Every abnormal outcome of that query is a failure: a non-zero exit, empty output, output that is not JSON, output that is JSON in an unrecognised shape, a project moon reports that the committed graph does not declare, a project it fails to report, an edge it reports that nothing justifies, and a derived edge it omits. Each has told the guard *nothing* about the graph, and treating any of them as "no drift found" would turn the live leg into a step that always passes — worse than absent, because CI would then claim the graph was verified. All eight paths are executed by a committed stand-in binary injected through `MOON_BIN`, which also asserts the pinned argv end to end.

**The required lane gates on it.** The `ci` job runs the hermetic leg as a fenced `bun run graph:check` step — it needs only Bun, so it costs a second in the lane that already has it. The live leg gets its own fenced job, `moon-graph` (display name "Verify Moon project graph"), because it is the one check here that needs a real toolchain, and folding a moon install into the contract job would make every other guard wait on it. That job is a fenced entry in `ci-gate`'s `needs` in the same change, because the workflow guard requires the gate to depend on **every** job in the file — and because a graph that was never verified looks exactly like a graph that was, which is why its absence from `needs` now has its own dedicated verdict.

`.github/actions/setup-moon/action.yml` wraps `moonrepo/setup-toolchain` (pinned to a 40-hex commit) with `auto-install: true`, and then asserts `moon --version` against the `.prototools` pin. It declares **no inputs at all**, deliberately: `.prototools` is the one authority for the moon version — setup-toolchain reads it when `moon-version` is empty — so an input here would be a second authority sitting outside the toolchain guard, and a caller could ask for a moon this repository does not pin. That includes `bun-version`: the `moon-graph` job uses both committed actions side by side, with `install: "false"` on the Bun one because the guard imports nothing from `node_modules`.

The workflow guard learned four rules to keep all of that true: no workflow may `uses:` `moonrepo/setup-toolchain` directly, the `moon-graph` job must reach moon through the committed action, that action must declare no inputs and must assert its binary against `.prototools`, and the aggregate gate must depend on the graph oracle whenever the job exists.

**Capability fencing.** The whole surface is gated behind `moon_affected_selection`, which the template disables by default: a project without it receives no registry, no guard modules, no composite action, no `graph:*` scripts, no fenced step and no gating job. `.moon/workspace.yml` and the root `moon.yml` stay **core** — moon itself has been core since PR #21, and a project graph is not an optional feature of a monorepo.

**Evidence.** `evidence/stage-8a-moon-graph.json` seals ten commands with raw logs bound by SHA-256. The capture runs **inside the devcontainer**, and that is not a convenience: moon is image-owned and the host has neither moon nor proto, so a capture on the host would either fail on the missing binary or seal a version this repository never pins. The record binds the moon version to the `.prototools` pin *the same record captured*, the sealed graph to what moon printed, and the live run's shape to the record's own gate dependency list — never to whatever the current tree happens to hold. The green run is a real four-job gate on GitHub's runners at the reviewed boundary, with `Verify Moon project graph` reporting by display name.

Two things the capture found. Adding the gating job broke the **Stage 7** record, whose validator re-resolved the gate's dependency list out of the current workflow — fixed in its own commit, and described in the entry above. And a dependency-free generated `moon.yml` turned out to be a comment-only YAML document, which parses to `null`; the graph builder was reporting that as a parse failure, so the generator's own output failed the guard that checks it.

**Rollback** is one merge revert with **nothing outside the tree** to undo first. Branch protection is untouched, because the graph job reaches the required check through `needs` rather than becoming a second required context — so unlike Stage 7, a revert cannot strand a context no workflow produces. The committed proof binds a synthetic merge and its revert to a tree carrying none of the six paths this stage adds.

**Why downstream cares:** Adopt `.moon/workspace.yml` and the root `moon.yml` together, and drop `scripts/*` from `package.json#workspaces` at the same time; re-run `bun install --frozen-lockfile` and confirm your lock is unchanged. If your `scripts/` directories really are packages (they have their own `package.json`), keep them in both lists — the point is that the two lists agree with reality, not that `scripts/` is forbidden.

Then copy `scripts/template/{graph-contract,generate-graph,validate-graph}.ts` plus the `graph:check` / `graph:generate` scripts, add `ci-matrix-universes.json` listing every project exactly once, and run `bun run graph:generate` followed by `bun run graph:check`. If you want the live leg in CI, copy `.github/actions/setup-moon`, add the `moon-graph` job, and add it to your gate's `needs` **in the same commit** — a gate that does not depend on it reports green on a graph nothing verified. Full documentation is in `docs/devcontainer-upgrade/stage-8a/README.md`. This is a configuration and tooling change: no `.devcontainer/**` file moves, so it costs **no container rebuild**.

---

## 2026-08-06 — Add: CI bootstrap and workflow safety

**Goal:** Make the CI surface itself contract-driven. Before this stage the workflows were the one part of the repository that nothing guarded: the Bun version was a literal typed into three places, `bun install` was a bare command that had no bound on a hang, third-party actions floated on mutable tags, and both `.github/workflows/ci.yml` and `.github/workflows/codex-cloud-smoke.yml` were free to drift from each other and from `.prototools`.

**How to implement:** The whole stage is one idea applied repeatedly — *every CI behaviour that matters gets exactly one definition, and something rejects the second one.*

**One owner for the toolchain.** `.github/actions/setup-bun/action.yml` is now the only place a job learns how to get Bun and `node_modules`. Callers use `uses: ./.github/actions/setup-bun` and pass `bun-version: ${{ env.BUN_VERSION }}`; nothing else may spell a version. The chain is one-way and every hop is checkable: `.prototools` → a workflow's top-level `env.BUN_VERSION` → the action's `required` input → `oven-sh/setup-bun` → a runtime assertion in the action that re-reads `.prototools` and refuses a mismatch. That last hop is what makes the action self-verifying rather than merely obedient, and a missing `.prototools` is a hard failure there, not a skipped check.

Three details in that file are not stylistic. The `bun-version` input is `required: true` with **no default**, and the action's first step still checks the value is non-empty and exits 1 if it is not — because `required: true` is **not enforced by the runner for composite actions**, and an empty value makes `setup-bun` quietly install `latest`, which is the exact silent drift the action exists to prevent. No `${{ … }}` expression appears anywhere in the file, *including inside a `description:`* — the runner parses `action.yml` as a template and evaluates every expression it finds before a single step runs, and composite metadata has no `env`/`secrets`/`vars`/`needs`/`matrix` context, so one documentation sentence naming one of those fails the action to **load** and reddens every job that uses it. And no step carries `timeout-minutes`, because that key is unsupported on composite steps: written there it is ignored rather than rejected, so the only unbounded operation's bound lives in the install script instead.

The header of that file is a long, deliberate argument for why there is **no dependency cache**. `oven-sh/setup-bun` declares only `bun-version`, `bun-version-file`, `bun-download-url`, `registries`, `registry-url`, `scope`, `no-cache`, and `token` — there is no `cache` input, and Actions silently ignores unknown inputs, so a workflow passing `cache: true` looks cached and caches nothing forever. The obvious repair — `actions/cache` over `~/.bun/install/cache` — loses *by construction*, because Bun's global cache stores extracted packages rather than tarballs, so the restore leg performs the same two expensive operations that make a cold install cold and adds tar/zstd on top (measured upstream: cold install ~11.9 s, warm ~6.5 s, so the entire prize is ~5.4 s, against ~6.4 s to untar a 1.2 GB cache with zero network, at 337 MB of a repository's 10 GB quota per lockfile revision). The block is there so nobody "fixes" the missing cache without re-measuring first.

**One bounded install.** `scripts/ci/bun-install-retry.sh` replaces every bare `bun install`. A hang is not a failure — it silently eats the job's whole `timeout-minutes` budget and then gets the job cancelled, producing a red result that says nothing about the code under test. So each attempt is capped independently (`timeout`, default 180 s), the attempt count is capped (default 3), and the backoff between attempts is short and fixed, which makes the worst case deterministic and comfortably inside the job's outer budget. Two details are load-bearing: the exit code is captured into a variable rather than tested with `if bun install; then`, because that compound reports 0 when the condition fails with no `else` and would mask the very 124 that means "killed on a hang"; and the lock semantics the workflow used to spell out inline are preserved exactly — `bun.lock` present means `--frozen-lockfile` and the lock is never rewritten, `bun.lock` absent means a plain install that must leave a lock behind, which is how a freshly rendered project creates its first one. The script prefers coreutils `timeout` and falls back to an equivalent watchdog (same 124 contract) so it is runnable and testable on a developer host that has no `timeout`.

**Pinned actions.** Every third-party action is pinned to a 40-hex commit SHA with a trailing version comment — `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`, `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0`, `actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0`. A SHA pin with nothing maintaining it is just a stale pin, so `renovate.json` enables the `github-actions` manager in the same change, with `pinDigests` and a `chore(ci):` commit prefix. (The Renovate app itself remains uninstalled here; the configuration stays inert but correct.)

**One trigger policy, applied to every lane.** The `pull_request` `branches:` filter is gone from both workflows, and this is the single most load-bearing deletion in the stage: that filter matches the pull request's **base** branch, so `branches: [main]` runs **zero** jobs on a stacked PR. It is not a narrower run, it is no run at all, and the pull request then shows a page with no checks on it — which reads as "nothing to see here" rather than "nothing ran". `paths`/`paths-ignore` remain the only intended narrowing. `pull_request.types` now lists `ready_for_review`, so a PR opened as a draft revalidates the instant it is marked ready instead of waiting for a push that may never come, and `workflow_dispatch` is available on both files for manual verification.

Draft and ready runs are kept in **separate cancellation lanes** — `ci-${{ github.ref }}-…'draft' || 'ready'` with `cancel-in-progress: true`. With a single lane, the `ready_for_review` run cancels the draft run it supersedes, and those cancelled draft jobs stay attached to the exact head commit, so the head reads red after every ready-state job has passed. The gating jobs themselves carry `if: ${{ !github.event.pull_request.draft }}`, which is only safe because the aggregate gate added in this same stage refuses to go green on a draft: skipping work and *reporting* it as passed are different things, and the second one would let a draft merge the moment it was marked ready, before anything revalidated it.

Every job in both files now declares `timeout-minutes`. An unbounded job cannot fail — it can only hang until the platform cancels it, and a cancellation arrives at the gate as a failure with no diagnosis attached. There is deliberately no `schedule:` on `ci.yml`: with no paths filtering, every job already runs on every push and every pull request, so a nightly repeat adds no signal; the nightly lane that covers something genuinely different — real network, real registries — is `codex-cloud-smoke.yml`, which keeps its own schedule.

**One required check that always reports.** A new `ci-gate` job (display name `CI gate`) is the single status check branch protection should require; no other job is individually required, and every real job funnels into it through `needs`. It runs `if: ${{ always() }}` — because a gate that only reports when its dependencies ran leaves a required check *pending* whenever a lane is skipped, and a pending required check is a merge blocked with no way to clear it and no failure to read. Its `needs` list names every other job in the file, and the `browser` entry carries the same `playwright` fence as the job it names, so a project without that capability renders a workflow whose gate depends only on jobs that exist. Fencing a `needs` list into emptiness would be the same bug in the other direction: a gate with no dependencies reports success on a run in which nothing happened, so at least one dependency is always outside every fence. The only excluded surface is `codex-cloud-smoke.yml`, and the exclusion is written down with its reason — it is a separate workflow and a real-network lane, so a registry outage must never redden an unrelated PR, while the hermetic guard and selftest in the `ci` job carry the required signal. The informational-exclusion list is empty: a job allowed to fail without failing the gate has to earn that with a written reason.

The verdict itself lives in `scripts/ci/aggregate-gate.sh` rather than in an inline `run:` body, so it can be executed and mutated by a test instead of merely read. Its two inputs arrive through `env:` — `RESULTS` from `join(needs.*.result, ',')` and `DRAFT` from `github.event.pull_request.draft` — and never through interpolation, because pull-request metadata is attacker-influenced text and interpolating it into a `run:` body splices it into the script the runner executes. `success` and `skipped` pass; `failure` and `cancelled` fail; an **empty** `RESULTS` fails, since a green verdict over nothing is a gate that has quietly stopped gating. And a draft fails closed with an instruction to mark the PR ready — not redundant with the results check, because gating jobs carry `if: !draft` and would all report `skipped`, so a green gate there would let the PR merge the moment it was marked ready, before the `ready_for_review` run revalidated a single thing.

**No step is allowed to fail any more.** Both `continue-on-error: true` flags are gone from `ci.yml`. A step permitted to fail is a step nobody reads: it reports green while reporting nothing, and it does that for every real regression the project will ever have, not just for the case it was added for. Each flag existed for a genuine reason, and each reason was fixed properly instead.

The Typecheck step had no project to check — there was no root `tsconfig.json`, so `bun tsc --noEmit` had nothing to bind to. There is one now: `tsconfig.json` extends `tsconfig.base.json`, includes `apps/**`, `libs/**` and `scripts/**`, and **excludes `scripts/template`**, which is a separate project with its own `tsconfig.json` — one file belongs to one project, and checking that subtree twice under two different sets of options is the same duplication this stage removes everywhere else. Turning the compiler on surfaced exactly one real defect, now fixed: `scripts/browser-preflight.ts` read `process.env.PLAYWRIGHT_BROWSERS_PATH` with dot access, which `noPropertyAccessFromIndexSignature` rejects (TS4111); it now uses bracket access, and the browser contract's substring scan for that variable is unaffected.

The Test step ran a bare `bun test`, which **exits 1 when it matches zero test files** — the state of every freshly rendered project, which is why the flag was there at all. `scripts/ci/run-tests.sh` classifies that one case instead: zero matching files is announced as a `::notice::` and exits 0, and every other non-zero exit is passed straight through, so a suite that ran and failed can never be mistaken for a suite that was not there. `scripts/ci/run-typecheck.sh` does the identical job for `tsc`'s TS18003 ("No inputs were found in config file"), which is the same fresh-project condition on the compiler side. Both matches are deliberately narrow, and both live in committed scripts so they can be executed by a test rather than read.

Bun words the empty-suite case in **two** ways, and which one you get is a property of the build rather than of the project: macOS builds print `error: 0 test files matching <glob> in --cwd=<path>`, and the Linux runners CI actually uses print `No tests found!`. `run-tests.sh` anchors and absorbs both. Matching only the wording a maintainer sees locally is the specific way this wrapper can be green on a laptop and red on every runner, so the test that proves the classification drives both wordings through a stand-in `bun` instead of through whichever one the current machine happens to emit — and asserts that a real failure quoting the same words still fails.

Two smaller removals ride along. `bun run template:test` is gone from the template-only block: the Test step already runs the same suite through the wrapper, so listing it here ran the whole suite twice. And `~/.bun/install/cache` is dropped from the smoke lane's cache paths for the reason spelled out in the composite action's header — restoring an extracted dependency tree repeats the two expensive operations that make a cold install cold, and evicts the Proto/uv/browser-payload entries that genuinely do pay for themselves.

**The guards that make it stick.** `scripts/template/toolchain.ts` learned the indirection rather than the literal: under `.github/actions/**` a `bun-version:` assignment must be exactly `${{ inputs.bun-version }}` *and* the action must declare that input required with no default; under `.github/workflows/**` it must be exactly `${{ env.BUN_VERSION }}` *and* the file's top-level `env.BUN_VERSION` must equal the `.prototools` pin; every other form is rejected, including a correct-looking literal. `scripts/template/cloud-contract.ts`'s Bun check was retargeted at the same `env` pin — its old `bun-version: '<literal>'` pattern matches nothing after the cutover and would have gone quietly vacuous, which is the failure mode a version guard can least afford.

**One guard over the whole CI surface.** Everything above is a policy, and a policy nothing checks is a comment. `scripts/template/ci-contract.ts` (run by `bun run ci:check`, and from `template:validate`) reads `.github/workflows/**` and `.github/actions/**` with `Bun.YAML.parse` plus a handful of deliberately text-level scans, and enforces the whole stage in one place: the composite action is the only route to Bun and no workflow may `uses:` `oven-sh/setup-bun` directly; the action declares `bun-version` required with no default and asserts it non-empty; no unavailable context expression appears in composite metadata; every `with:` key is an input the target action actually declares (which is what makes a phantom `cache:` an error rather than a no-op); every third-party `uses:` is a 40-hex commit; no `pull_request` trigger filters base branches in any spelling; `ready_for_review` is in `types`; each workflow separates draft and ready cancellation lanes and cancels superseded runs; every job declares `timeout-minutes`; nothing is `continue-on-error`; no `run:` body sleeps, retries, invokes a foreign package runtime, or interpolates `${{ github.event.* }}`; no workflow caches an extracted dependency tree or configures remote build execution; `fetch-depth` appears only on jobs that appear in a declared history-ownership list with a written reason; and the aggregate gate is `always()`, depends on every other job in its file, derives its verdict from `join(needs.*.result)` through `env:`, runs the committed script, and never names the non-gating smoke workflow.

Two of its rules are worth calling out. `validateWorkflowGraph` is exported and runs each workflow **twice** — as committed, and again with every capability fence stripped — so a fenced `needs` entry that was not fenced along with the job it names is caught here rather than in a downstream project's first CI run; the same pass rejects a `needs` list that a fence emptied. And the compiler-coverage rule asserts that every **tracked** `.ts` file in this repository falls inside some committed `tsconfig.json` project and that CI really runs a typecheck for each project — which is the check that keeps the root `tsconfig.json` honest as `apps/` and `libs/` fill in. That rule is scoped to the template repository on purpose: a rendered project's `scripts/template` guards are proved by being **executed** — its `ci.yml` runs one dedicated `*:check` script per guard it received — not by being compiled standalone, and its root project excludes `scripts/template` exactly as this one does.

**Why downstream cares:** Copy `.github/actions/setup-bun/action.yml` and everything under `scripts/ci/`, add `env: BUN_VERSION: "<your .prototools bun>"` at the top of each workflow, and replace every `oven-sh/setup-bun` step plus its adjacent `bun install` with a single `uses: ./.github/actions/setup-bun` passing `bun-version: ${{ env.BUN_VERSION }}` (add `install: "false"` for a job that needs only the binary). Pin your actions to SHAs and enable Renovate's `github-actions` manager at the same time. Drop the `branches:` filter from every `pull_request:` trigger, add `ready_for_review` to its `types`, give each workflow the draft/ready concurrency group, and put a `timeout-minutes` on every job. Then add the `ci-gate` job, set **`CI gate`** as the sole required status check in branch protection, and delete every `continue-on-error` — `run-tests.sh` and `run-typecheck.sh` cover the two cases that used to need one. This is a CI-only change: no `.devcontainer/**` file moves, so adopting it costs **no container rebuild**.

**Changed files:**
- `.github/actions/setup-bun/action.yml` — new; the sole owner of Bun plus dependencies, with the empty-input guard, the `.prototools` re-assertion, and the no-cache rationale.
- `scripts/ci/bun-install-retry.sh` — new; per-attempt timeout, capped attempts, direct exit-code capture, preserved frozen/first-lock semantics.
- `scripts/ci/aggregate-gate.sh` — new; the required check's verdict, driven purely by `RESULTS` and `DRAFT` from the environment.
- `scripts/ci/run-tests.sh`, `scripts/ci/run-typecheck.sh` — new; each classifies the one "nothing to check yet" exit and passes every other failure through.
- `tsconfig.json` — new root project; `apps`/`libs`/`scripts` minus `scripts/template`, which owns its own project.
- `scripts/browser-preflight.ts` — bracket access for the environment lookup the compiler now checks (TS4111).
- `package.json` — the `typecheck` script.
- `.github/workflows/ci.yml`, `.github/workflows/codex-cloud-smoke.yml` — cut over to the action, `env.BUN_VERSION` added, every third-party action SHA-pinned, base-branch filters removed, `ready_for_review` added, draft/ready concurrency lanes, `permissions: contents: read`, and a `timeout-minutes` on every job.
- `scripts/template/toolchain.ts` — the indirection rules; a literal Bun version anywhere under `.github` is now an error.
- `scripts/template/cloud-contract.ts` — the Bun pin check retargeted at `env.BUN_VERSION` so it cannot go vacuous.
- `renovate.json` — the `github-actions` manager, pinning digests under a `chore(ci):` prefix.
- `scripts/sync-devcontainer.sh` — `scripts/ci/*` marked template-owned so downstream syncs receive the install wrapper.
- `scripts/template/ci-contract.ts`, `scripts/template/validate-ci.ts` — new; the workflow policy contract and its entry point, wired into `template:validate` and exposed as `bun run ci:check`.
- `package.json` — the `ci:check` script; `docs/devcontainer-upgrade/stage-0/template-ownership.json` — copy rules for both new guard modules ahead of the `scripts/template/**` omit catch-all, so a rendered project receives its own workflow guard.
- `scripts/template/__tests__/ci.test.ts` — new; one mutation battery that drives ~30 known-bad workflow edits through `validateCiContract` on a throwaway Git fixture (each asserting its exact error and restoring to clean), a rendered-fixture pass that YAML-parses and graph-checks every workflow the three profiles emit, and execution tests that run the action's committed shell bodies, the retry script, the gate script's verdict matrix, and both "nothing to check yet" wrappers against fake toolchains rather than reading them.
- `evidence/stage-7-ci.json`, `evidence/stage-7-ci.schema.json`, `evidence/stage-7-ci-run/` — new; the sealed acceptance record and its raw logs.
- `scripts/template/stage-seven-evidence.ts`, `scripts/template/collect-stage-seven-evidence.ts`, `scripts/template/__tests__/stage-seven-evidence.test.ts`, `scripts/template/validate.ts` — new validator, collector, mutation tests, and the wiring into `template:validate`.
- `docs/devcontainer-upgrade/stage-7/README.md`, `AGENTS.md` — the stage write-up and the `## Continuous Integration Ownership` rules.

**The evidence, and what a live run actually showed.** `evidence/stage-7-ci.json` seals nine commands with their raw stdout and stderr bound by SHA-256. Four are hermetic — the guard, the mutation suite, the gate's seven-row decision table executed against the committed script, and every fixture rendered so its gate is graph-checked against jobs that fixture really has. Four read something this repository cannot fabricate: a green dispatch on the implementation commit where every job succeeded and the gate was handed `success,success,success`; a red dispatch on a throwaway branch carrying one deliberately failing step, where that job failed, the image and browser jobs still passed, and the gate went red naming the result; a real **draft** pull request where all three gating jobs skipped, the gate never read a result at all, and it failed closed with the mark-ready instruction; and `main`'s branch protection read back showing `contexts: ["CI gate"]`, `strict: true`, `enforce_admins: false`, and no review or push restrictions. The record binds the draft verdict a developer saw on GitHub to the message the committed script emits, minus the `::error::` prefix the runner consumes — which is what makes the hermetic decision table evidence about the live gate rather than about a script that happens to sit beside it. The validator is environment agnostic: it compares sealed values to other sealed values and to files in the tree, and derives the required context and the gate's dependency count from `.github/workflows/ci.yml` itself.

**Branch protection, and how to undo this stage.** The required status check is **`CI gate`** — the job's display name, because branch protection matches display names and not job ids. Applying it is an operator step (`gh api -X PUT repos/<owner>/<repo>/branches/main/protection` with `{"required_status_checks":{"strict":true,"contexts":["CI gate"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}`), and so is undoing it. Rolling this stage back therefore has **two** steps in a fixed order: first `gh api -X DELETE repos/<owner>/<repo>/branches/main/protection`, then `git revert -m 1 <stage-7-pr-merge-commit>`. Branch protection is not in the tree, so the revert cannot reach it; if the revert lands while `CI gate` is still required, every later pull request blocks forever on a context no workflow produces any more.

## 2026-08-06 — Fix: stop `up.sh` publishing a route for a container that never started

**Goal:** `bash scripts/worktree/up.sh` reported success after a failed container build. When the `devcontainer` CLI could not start the container — a failed `onCreateCommand`, a transient registry error during the in-container dependency install, anything — `ensure.sh` printed its own diagnosis and exited non-zero, and `up.sh` carried straight on: it logged `Worktree up: container ` with an empty id, published the manifest as **active**, and printed both URLs and `<workspace> is up`. The developer's next command then ran against a container that did not exist, and every *other* worktree on the host saw an active claim on that port. Found by the Stage 6 live evidence capture, which hit a real transient tarball-extraction failure inside the container and got a "healthy" report back.

**How to implement:** One line in `scripts/worktree/up.sh`. The reconcile was interpolated into the log line:

```sh
wt_log "container $(bash "$WORKTREE_RUNTIME_DIR/ensure.sh")"
```

A command substitution that sits **inside another command's arguments discards its own exit status**, and `set -e` never sees it — that is the whole bug, and it is invisible at a glance because the script does fail closed everywhere else. Capture the id into a variable instead, so the assignment is a command in its own right and `set -e` applies to it:

```sh
container_id="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh")" || status=$?
[ "$status" -ne 0 ] || [ -n "$container_id" ] || status=1
if [ "$status" -ne 0 ]; then
	wt_die "the container could not be reconciled; no route was published" "$status"
fi
wt_log "container $container_id"
```

`ensure.sh`'s own exit code is propagated rather than flattened to 1, and an empty id is treated as a failure even when the exit code was zero, because the caller's next step is to run commands in whatever that named. `local container_id="$(...)"` would have reintroduced the same bug — `local` is a builtin whose status masks the substitution's — so the declaration and the assignment are separate statements. Nothing else in the runtime has this shape: `exec.sh`, `down.sh`, and `selftest.sh` all assign first and test the status.

**Why downstream cares:** Replace the `wt_log "container $(...)"` line in your `scripts/worktree/up.sh` with the capture above. Until you do, a failed build is reported as a successful start, and the published manifest makes it a failure other worktrees can see. This is a runtime script fix only: no contract key changes, no `.devcontainer` change, and therefore **no container rebuild**.

**Changed files:**
- `scripts/worktree/up.sh` — the captured reconcile, the propagated exit code, the empty-id guard, and the refusal that publishes no route.
- `scripts/template/__tests__/worktree.test.ts` — a regression test that fails the container start and asserts a non-zero exit, the reconcile failure and the refusal both on stderr, none of the three success claims (`container `, `is up`, `direct URL`), and neither a manifest nor a route snippet on disk afterwards.

## 2026-08-06 — Add: secure read-only worktree doctor

**Goal:** Give every checkout one command that explains the whole host-to-container path — host prerequisites, linked-worktree Git metadata, generated state, container ownership and mounts, required tools, host routing, the direct and friendly URLs, the port registry, and cross-worktree port collisions — and that provably changes none of it. Diagnosis has been the gap since the runtime landed: `up.sh` reconciles, `cleanup.sh` removes, and neither is safe to run when the question is "what is wrong?". `bash scripts/worktree/doctor.sh` answers that question and nothing else. It is host-only, read-only, and additive: no `.devcontainer/**` file changes, so adopting this stage costs **no container rebuild**.

**How to implement:** Add `scripts/worktree/doctor.sh` and three contract keys that make it contract driven rather than hardcoded. `doctor_schema_version` (already reserved in `template-parameters.toml`) versions the JSON report, `doctor_command` names the entry point so guards and documentation bind to one string, and `toolchain_manifest` republishes `[toolchain] proto_manifest` so the container-tool check derives which tools to require from the Proto authority instead of naming any of them. `runtime_scripts` gains `scripts/worktree/doctor.sh`, which means the existing per-script guards (mode `0755`, `bash -n`, `set -euo pipefail`, no unscoped prune) apply to the doctor from the first commit. That entry has to move in lockstep across four sites — the generated `contract.toml`, `WORKTREE_RUNTIME_SCRIPTS` in `scripts/template/render-fixture.ts`, `BASE_KEYS` in `scripts/template/worktree-contract.ts`, and `SCALAR_KEYS` in `scripts/worktree/selftest.sh` — so all four land together.

The doctor's shape is deliberate. The ordered sequence of `add_result` calls **is** the check registry: there is no second table to drift from, and `--list-checks` prints that same inventory while running no probe and touching nothing. Every check emits exactly one result — `PASS`, `WARN`, `FAIL`, or `SKIP` — so the emitted id list is stable whatever the host looks like and an unmet prerequisite yields a `SKIP` carrying its reason rather than a silent gap. Statuses map to exit codes: **0** healthy, **1** any `FAIL` (or any `WARN` under `--strict`, which is a pure exit modifier and never changes a check's behaviour), and **2** an invalid argument, refused before a single check runs. `--timeout` is the one knob and the one bound on every probe, validated to `[1, 30]` seconds with the contract's `default_probe_timeout_seconds` as the default. Running with `DEVCONTAINER=true` (or, where the capability ships, `CODEX_CLOUD=true`) records a single `host.context` `FAIL` and stops: inside a container every answer would be wrong rather than merely unavailable, so that is a refusal and not a degradation. The JSON report is emitted through a hand-rolled `json_escape` that walks bytes under `LC_ALL=C` and escapes control characters as `\u%04x` — not through `python3`, because `python3` being absent is one of the conditions the report has to survive.

The hardening model is the part worth copying, because everything the doctor reads is generated by something else and some of it will one day be wrong. **Generated files are never sourced**: they are read key by key through the library's sed reader against an explicit key allowlist, because one hostile line in a file this script wants two values out of would otherwise execute at read time. **No value builds a path, a hostname, or a URL until it has passed `state.values`**, and a path is then canonicalized with `os.path.realpath` and containment-checked with `os.path.commonpath` against its declared directory plus a required suffix — which is what makes a traversal, a sibling path, and a symlink planted *inside* the manifest directory all fail identically, with the file never opened and its contents never reaching the report. The manifest is parsed **field-scoped**: nine allowlisted scalars, no nested structure, no file body, and any value carrying a tab or a newline dropped. Container ids are **hexadecimal or nothing** before being interpolated into a single engine argument. Route URLs are **recomputed and string-compared** before a request is made, and the recomputed URL is also the only one any remediation string is allowed to name, because output derived from generated state is a disclosure channel too. Finally, a rejected value **costs the report no checks**: hostile state turns into `FAIL` plus a cascade of `SKIP`s carrying their reasons, the emitted id list is identical to a healthy run's, and the JSON still parses because `json_escape` escaped the control bytes on the way out.

The one real structural constraint: the doctor keeps `set -euo pipefail` like every other declared runtime script, so **every fallible probe in it is explicitly non-fatal**. Probes run inside an `if` condition or with an explicit `|| status=$?`; a bare fallible command would abort the report halfway through and turn a diagnosis into a crash.

The checks themselves fall into phases and every one of them is devenv's own semantics rather than a port. `git.worktree-integrity` is implemented inline and read-only: a linked worktree's `.git` pointer must name an administrative directory that exists **and** whose `gitdir` backpointer names this exact worktree, which is the only way to tell a healthy linked worktree from one whose admin directory was pruned or is now claimed by somebody else; a failure there sends `container.definition` and `container.fast-ready` to `SKIP` rather than letting a fingerprint be computed against untrusted metadata. `state.values` validates the workspace id **and the family** against `^[a-z0-9][a-z0-9-]{0,62}$` — the family reaches a DNS label through `friendly_domain_pattern` exactly as the id does — plus the offset against `preferred_offset_modulus` and the published host port against the same 1024–65535 floor the allocator uses. `container.ready-record` judges the record's shape (`<hex id> <64-hex fingerprint>`), `container.definition` judges only the fingerprint comparison and **warns** that a rebuild is pending rather than failing, and `container.port` requires exactly `<direct_host>:<hostPort>` for the declared container port — a `0.0.0.0` binding fails, because publishing every worktree's stack on the local network is a security change wearing a typo's clothes. `container.tools` derives the commands it requires from `toolchain_manifest` and probes them through a login shell inside the container, so it asks the same PATH the bridge will get and names no tool itself.

The routing and registry phases follow the same rule. `caddy.*` reuses the runtime's own resolution — the `<PREFIX>_HOST_CADDY_BIN` and `<PREFIX>_HOST_CADDYFILE` overrides and the same fixed candidate list, still excluding bare `/etc/Caddyfile` — and every finding there is a **warning**, because the friendly route is a convenience layered on a direct loopback URL that always works; `--strict` is how a caller says it wants those warnings to matter, and `host_caddy = "disabled"` sends the whole group to `SKIP`. `route.direct` and `route.friendly` never request whatever URL generated state happens to contain: each recomputes the expected URL from the validated components (`http://<direct_host>:<validated port>` and the friendly pattern filled with the *validated* family) and **refuses with a `FAIL` on a string mismatch, without invoking the probe client at all** — so a well-formed but externally pointed URL in generated state is caught before a request leaves the host. `registry.lock` is pure inspection of the `mkdir`-backend lock directory's owner record: a live pid warns that an allocation is in flight, a provably dead holder or an over-threshold age warns and names the directory, and the doctor never acquires, releases, or deletes anything — a process in the middle of a read-modify-write on the registry is exactly what a diagnostic must not disturb. `manifests.port-collision` is the independent cross-check the previous stage promised: the registry says who was *allocated* what, the manifest scan says who is actually *claiming* what, it is bounded by the contract's `collision_scan_limit`, and one unreadable manifest among many is a gap in the scan (`WARN`) rather than a verdict.

Two derivations move into `scripts/worktree/lib.sh` before the doctor can use them. `wt_devcontainer_identity` (the container CLI's own `${devcontainerId}` algorithm) and `wt_volume_prefixes` (the mount prefixes read out of `devcontainer.json`, never a hardcoded list) used to live in `cleanup.sh`. Removal has to know exactly what this checkout owns and diagnosis has to look for exactly the same set, so a second derivation would be a second answer — and the diagnostic copy is the one whose drift nobody notices. `lib.sh` also gains the non-fatal shape predicates `wt_is_identifier` and `wt_is_port`, and the existing `wt_require_identifier` / `wt_require_port` are rewritten on top of them with their messages and exit behaviour unchanged. The pair matters: a lifecycle script must refuse to proceed on a malformed workspace id or port, while a diagnostic must record the malformation and carry on to the next check.

A diagnostic that changes nothing is a claim, so `scripts/template/worktree-contract.ts` (`bun run worktree:check`) turns it into a fact. `doctor_command` has to name a **declared** runtime script — one that is in `runtime_scripts`, so the existing per-script guards apply to it, and one that actually publishes a check inventory, so pointing the key at a lifecycle script is caught rather than merely documented around. `toolchain_manifest` is bound to `[toolchain] proto_manifest` and to a file that exists. The check inventory is compared **twice**: the guard spawns `--list-checks` on the shipped script, and it also reads the ordered `add_result` calls back out of the source, because those two are independent copies inside the script and a rename that touches only one of them is exactly the drift a single comparison would miss. Then three posture scans run over the script's executable body: it may not invoke a state-changing verb of the contract's own container engine or CLI (scanned under both the variable the runtime calls them through and their literal names), call a lifecycle script, or reach for `mkdir`, `mktemp`, `rm`, `touch`, `wt_atomic_write`, a mutating Git subcommand, or a reverse-proxy reload — with `ensure.sh --check-ready` the one deliberate exception, because asking the reconciler its own read-only question is the only way to report the answer the bridge will really get; it may not source the lock library or call `portable_lock_acquire`; and it may not name the Proto manifest's path or two of its tools on one line, because the tool list has to be derived. Finally the agent rules and the onboarding README have to name `doctor_command`, so an agent facing a broken checkout has a diagnostic command to reach for instead of a reconciling one. One existing check tightened while this landed: `set -euo pipefail` is now looked for in each runtime script's **executable body** rather than the whole file, because a comment that quotes the shell options is documentation, not a setting.

Seal the acceptance run in `evidence/stage-6-doctor.json` with per-command raw logs and SHA-256 digests under `evidence/stage-6-doctor-run/`. Seventeen commands run the hermetic guards, then build a **real two-worktree host** under an isolated `HOME` — two throwaway linked worktrees whose parent directory fixes their families at `s6-alpha` and `s6-beta`, so they derive different identities, offsets, ports, and containers — and diagnose it: the healthy report in both renderings (35 pass, 1 warn, 0 fail, 0 skip, exit 0), `--strict` returning exit 1 with a checks array **identical** to the healthy run's, the second worktree answering on its own terms, a fabricated second active manifest making `manifests.port-collision` fail while `registry.port-collision` still passes (the independent cross-check), a stopped container degrading to one warning and three reasoned skips with ownership still answering, the two refusals (`DEVCONTAINER=true` → one `host.context` failure and exit 1; `--timeout 0` → exit 2 with **zero bytes** on stdout), every form of the doctor run in both worktrees with the isolated host state digested *and* listed identically on either side, and a cleanup that releases both worktrees completely and leaves the real checkout's registry, manifests, and routes byte identical to the digest taken before any of it started. Each worktree runs a bounded HTTP listener on the contract's `published_container_port`, because the template declares no services and `route.direct` would otherwise be diagnosing an empty container rather than a route; the record seals the listener and the HTTP code it returned. The duplicate-claim manifest is written into the **isolated** manifest directory only and deleted by the same command that wrote it, with that directory digested on both sides of the diagnosis.

**Why downstream cares:** Adopting this stage is additive and costs no rebuild. Copy `scripts/worktree/doctor.sh`, add the three keys and the `runtime_scripts` entry to your `contract.toml` (there is no generator downstream), and run `bash scripts/worktree/doctor.sh` on the host — never through the bridge, because the questions it asks are host questions. Use `--json` for tooling, `--strict` in CI where a warning should be fatal, and `--list-checks` to discover the inventory without probing anything. The doctor never repairs: it reports and points at the command that does.

**Changed files:**
- `scripts/worktree/doctor.sh` — the host-only, read-only diagnostic: argument parsing and the exit-2 refusal, `add_result`, `json_escape`, the human and JSON renderers, `--list-checks`, the host prerequisite phase (`host.context`, the five role-named `host.command.*` checks, `git.worktree-integrity`, and `host.engine-daemon`), the generated-state phase (`state.environment`, `state.manifest-state`, `state.values`, `state.paths`, `state.manifest`), the container phase (`container.record`, `.ready-record`, `.runtime`, `.ownership`, `.definition`, `.fast-ready`, `.workspace-mount`, `.git-mount`, `.port`, `.volumes`, `.tools`), the routing phase (`caddy.binary`, `.config`, `.import`, `.snippet`, `route.direct`, `route.friendly`, `registry.readable`, `.lock`, `.entry`, `.offset-match`, `.port-collision`, and `manifests.port-collision`), and the hardening pass that keeps every one of them from trusting what it reads.
- `scripts/worktree/contract.toml`, `scripts/template/render-fixture.ts`, `scripts/template/worktree-contract.ts`, `scripts/worktree/selftest.sh` — the three new keys and the `runtime_scripts` entry, in lockstep across all four sites, plus the selftest's unsupported-argument coverage and a bounded `--list-checks` check that asserts the sandbox's generated state is unchanged afterwards.
- `scripts/worktree/lib.sh`, `scripts/worktree/cleanup.sh` — `wt_devcontainer_identity`, `wt_volume_prefixes`, `wt_is_identifier`, and `wt_is_port` promoted into the shared library, with `cleanup.sh` rewired onto them and the `wt_require_*` pair rebuilt on the predicates.
- `scripts/template/__tests__/worktree.test.ts` — invalid-argument refusals, the probe-free inventory listing, the stable JSON document, the in-container refusal reduced to exactly one check, `--strict` changing the exit code with a deep-equal checks array, a purity/parity probe proving the shared identity derivation matches the container CLI and writes nothing, and the diagnosis matrix: a healthy worktree reported with byte-identical state and a read-only engine invocation record, a foreign container owner cascading into skips, a stopped container warning, a pending rebuild that starts nothing, a broken linked-worktree pointer failing closed, a corrupt manifest that leaves the JSON document parseable and the file untouched, a manifest claiming this identity for another repository, container tools derived from the toolchain authority (missing commands versus a probe that could not run), an absent declared volume, host routing warnings promoted by `--strict` with an identical checks array, a disabled host proxy skipping every routing check without a request leaving the host, independent route verdicts with the bound reaching the probe client as `--max-time`, the registry diagnosed and provably left byte-identical, a lock inspected in all three of its states without being taken or cleared, two worktrees claiming one host port named together, and the eleven hostile-state cases — a sibling path, a traversal, and a planted symlink each refused with their secrets never reaching stdout, a route path outside its directory, a malformed workspace id, family, and port each stopping every probe before curl is invoked, an externally pointed URL refused by string comparison and absent from every remediation, a control byte that leaves the JSON parseable, a non-hexadecimal container id that never reaches an engine argument and detonates no sentinel, and an omnibus fixture carrying every hostile value at once that still emits the full check inventory and leaves the host byte-identical.
- `scripts/template/__tests__/template.test.ts` — every rendered fixture carries the three keys, lists the doctor in `runtime_scripts`, and ships a doctor whose only cloud reference sits inside a capability fence, leaving a syntactically valid script when the capability is stripped.
- `scripts/template/stage-six-evidence.ts`, `collect-stage-six-evidence.ts`, `__tests__/stage-six-evidence.test.ts`, `scripts/template/validate.ts`, `evidence/stage-6-doctor.{json,schema.json}`, `evidence/stage-6-doctor-run/**` — the seventeen-command acceptance record, its strict schema, the environment-agnostic validator (every sealed value bound to another sealed value or to a Git object the record names, never to the layout of whatever checkout is running it), and the fabrication tests that reject a drifted command, a reordered inventory, a changed non-mutation digest, an executed refusal, two worktrees sharing a port, a strict run claiming a different checks array, a changed collision digest, and a rollback proof that does not match its bound log.
- `AGENTS.md`, `README.template.md`, `docs/devcontainer-upgrade/stage-6/README.md` — the doctor's usage, exit codes, and the rule that it reports rather than repairs; the stage document with the full 36-check inventory table, the exit contract, the hardening model, the capture, the scope boundaries, and the rollback.

## 2026-08-06 — Change: make the worktree bridge the documented entry point

**Goal:** End the soak the previous entry opened. The isolated worktree runtime stops being an additive second way to start a container and becomes *the* way: git hooks, host onboarding, the generated project README, and the agent rules all route through `bash scripts/worktree/exec.sh`, and the superseded `devpod up .` entrypoint is removed from every document and install path. `.devcontainer/devcontainer.json` stays fully spec compliant, so VS Code, the `devcontainer` CLI, and any other launcher can still open this checkout — but as an editor convenience with no stable port, no route, no per-worktree isolation, and no manifest, not as the documented entry point.

**How to implement:** Give the bridge a ready-only mode. `bash scripts/worktree/exec.sh --require-ready <command>` asks `ensure.sh --check-ready` and nothing else: when this checkout has no reconciled container it exits **7** with `Worktree bridge: this checkout's container is not ready; run bash scripts/worktree/up.sh` and the requested command provably never runs. The flag is parsed in the option loop *ahead* of the `-*` unsupported-argument arm, so a caller can never fall through to the reconciling path that would start a container — a git hook must not be a build trigger. Readiness is a host-side question, so inside the container and in a verified cloud task the flag is accepted and ignored. That fixes the bridge's exit-code space at 2 unsupported argument, 3 identity collision, 4 port exhaustion, 6 missing container engine or CLI, and 7 not ready.

Route the two git hooks through it. `.husky/commit-msg` becomes `bash scripts/worktree/exec.sh --require-ready bunx commitlint --edit "$1"` and `.husky/pre-commit` becomes the same shape around `bunx lint-staged`, so commitlint and the pinned Biome run against the container's toolchain instead of whatever the host happens to have. `"$1"` is forwarded byte for byte because that is the only value correct in both topologies: in the main checkout Git supplies `.git/COMMIT_EDITMSG` relative to the working tree the container bind mounts, and in a linked worktree it supplies an absolute `<common-dir>/worktrees/<name>/COMMIT_EDITMSG` that `ensure.sh` mounts inside the container at that same absolute path. Both hooks degrade by **file existence** (`if [ -x scripts/worktree/exec.sh ]`), not by a capability fence, because a project rendered without the devcontainer capability ships no `scripts/worktree` at all — there is nothing to fence. The hooks stay POSIX `sh`: Husky runs them with `sh -e`. Two things deliberately do not move. The `pre-commit` graphify staging guard stays first and stays on the host — it is pure `git diff` plus `grep`, so it still answers when the container is down, which is exactly when the bridge refuses. And `package.json` scripts and `.moon` tasks stay direct: routing them through the bridge would recurse the moment they ran inside the container. Expect roughly 0.3–1s of extra commit latency for the `docker exec` round trip, and `git commit --no-verify` remains the escape hatch.

Cut the onboarding path over. `init-host.sh` stops installing the superseded launcher and installs `brew install devcontainer` instead — the reference implementation of the Development Containers specification, whose ownership labels, per-invocation `--mount`, `--remove-existing-container`, and `${devcontainerId}` volume identity this runtime is written against — and verifies `python3`, which `scripts/worktree` needs for its atomic registry and manifest writes. Both READMEs replace the old build/connect walkthrough with `up.sh` / `exec.sh` / `down.sh` / `cleanup.sh`, install the CLI with `brew` or `npm` rather than `bun add --global` (a host `bun install` writes host-platform binaries into the bind-mounted `node_modules`), and state the one real limitation: **one clone of a project per host**, linked worktrees for parallelism, because a second independent clone derives the same workspace identity and would claim the same ports and the same manifest path. `AGENTS.md` gains an "Agent Command Environment" section that says where a command runs before it says what to type, and its worktree section replaces the soak paragraph with the cutover, the exit-code space, and the one-clone rule.

Guard all of it in `scripts/template/worktree-contract.ts` (`bun run worktree:check`) with five new checks: both hooks reach project tooling through the contract's `bridge_command`, in ready-only mode, with direct invocations only inside the documented fallback branch; the bridge parses `--require-ready` ahead of its unsupported-argument arm and refuses with exit 7; `init-host.sh` installs the contract's `container_cli` and never the superseded launcher, and the onboarding README names the bridge; the agent rules describe the cutover rather than the soak; and — the non-vacuous half — **no tracked file outside an explicit record allow-list still names the superseded launcher**. The allow-list is deliberately narrow: sealed evidence and its validators (which describe runs that really did use it), the cloud contract that forbids it by name, this guard itself (which carries the token in order to look for it), the changelog, the upgrade docs, the spec, and derived `graphify-out/` output.

One consequence to plan for: this stage edits several `.devcontainer/**` comments, and every file under `.devcontainer` is a definition-fingerprint input. All of those edits are batched into a single commit so the cost is **one** automatic container recreate, not one per commit. `scripts/worktree/ensure.sh` handles it on the next run with `--remove-existing-container`.

Seal the acceptance run in `evidence/stage-5b-cutover.json` with per-command raw logs and SHA-256 digests under `evidence/stage-5b-cutover-run/`. Where Stage 5A proved two worktrees coexisting, this record proves the thing a cutover is actually about: a **fresh-clone onboarding journey**, end to end, on a real host. Fifteen commands clone the repository at the implementation boundary, create the documented host directories under an isolated `HOME`, run one real cold `up.sh`, install the project's dependencies through the bridge, make a real host `git commit` whose hooks answer from a Linux kernel inside the container the engine confirms is this checkout's, watch commitlint reject a subject with no type, stop the container and watch the very same commit be refused with `husky - pre-commit script failed (code 7)` and provably not land, read the environment back through the existing read-only reports, and then `down` and `cleanup` and prove that the real checkout's registry, manifests, and routes are byte identical to the digest taken before any of it started. The isolated `HOME` is not decoration: a second clone of the same project derives the same workspace identity as the first, so without it the capture would have deleted the real checkout's manifest. Two preconditions are enforced by the collector *and* sealed in the record — the real checkout must have no ready container, and the journey's `HOME` is its own. The rollback proof goes one step past Stage 5A's tree identity: after `git revert -m 1`, `init-host.sh` and `README.md` are re-read out of the reverted tree and must document the predecessor entry point again.

**Why downstream cares:** Adopting this stage costs one container recreate (the `.devcontainer` comment edits change the definition fingerprint) and changes three habits. Install the container CLI with `brew install devcontainer` or `npm install -g @devcontainers/cli`, never with Bun, and never run `bun install` on the host — it belongs inside the container, where it is also what activates Husky. Start a checkout with `bash scripts/worktree/up.sh` before committing, because the hooks now refuse with exit 7 rather than building an image behind a `git commit`; `git commit --no-verify` remains the escape hatch and adds no new skip variable. And keep **one clone of a project per host**, using linked worktrees for parallel work: a second independent clone claims the same ports and the same manifest path, and duplicate-claim detection is Stage 6's job. Rolling back has one ordering rule and one manual step: run `bash scripts/worktree/cleanup.sh` in every live worktree **before** reverting, then `git revert -m 1 <merge>`, then `bash scripts/worktree/up.sh` once because the definition changed again — and note that the revert restores DevPod as the *documented* entry point without reinstalling it, so `brew install devpod` is a named manual step if you actually intend to use it again. The Stage 5A runtime survives a Stage 5B revert untouched, because 5A was additive.

**Changed files:**
- `scripts/worktree/exec.sh` — the `--require-ready` mode, its exit-7 refusal, the option loop, and the documented exit-code space.
- `.husky/commit-msg`, `.husky/pre-commit` — bridged commitlint and lint-staged, the run-time fallback, and the unchanged host-side graphify staging guard.
- `init-host.sh`, `init-new-project.sh` — the container CLI install, the `python3` verification, and next steps that name `up.sh` and `exec.sh`.
- `.devcontainer/devcontainer.json`, `.devcontainer/AUTH-PERSISTENCE.md`, `.devcontainer/configs/.shell_common`, `.devcontainer/on-create.sh`, `.devcontainer/on-create/setup-vscode-extensions.sh`, `.devcontainer/host/capture-warp-env.sh`, `.devcontainer/host/prepare-container-env.sh` — launcher-neutral comments and the note that the Warp capture now sees a real terminal on the normal path. Comments only; no host script changed behaviour.
- `README.md`, `README.template.md`, `AGENTS.md` — the host prerequisites, the `up.sh`/`exec.sh` walkthrough, the "other launchers" note, the one-clone rule, and the agent command-environment rules.
- `scripts/template/worktree-contract.ts` — the five cutover checks and the legacy-launcher scan with its record allow-list.
- `scripts/template/__tests__/worktree.test.ts` — refusal (exit 7, no `devcontainer up`, no `docker exec`, no command), ready-only execution through the recorded container, the in-container no-op with an exit status preserved, option-parsing coverage for the new flag, real-Git hook routing in both topologies including the graphify guard, the direct fallback, and a refused commit that does not land, plus eight known-bad cutover mutations against a Git-backed contract fixture.
- `scripts/template/__tests__/template.test.ts` — every rendered fixture carries bridged hooks, the run-time fallback, a README naming the bridge, and no legacy-launcher residue outside the three sealed files.
- `scripts/template/stage-five-b-evidence.ts`, `scripts/template/collect-stage-five-b-evidence.ts`, `scripts/template/validate.ts`, `evidence/stage-5b-cutover.json`, `evidence/stage-5b-cutover.schema.json`, `evidence/stage-5b-cutover-run/**` — the fifteen-command fresh-clone journey record, its collector (with the isolated-HOME journey, the legacy scan, and the predecessor-path rollback probe), and its wiring into `template:validate`.
- `scripts/template/__tests__/stage-five-b-evidence.test.ts` — the committed record validates, and eight fabrications are rejected: a drifted command, a hook that claims to have run on the host, a foreign hook container, a refusal recorded as an execution, a journey relocated away from its recorded temporary root, a mutated host-state digest, an emptied legacy allow-list, and a rollback proof that disagrees with its bound log.
- `docs/devcontainer-upgrade/stage-5b/README.md` — the host/container split, the exit-code space, the second one-time rebuild, the validation block, the capture's preconditions and honest `init-host.sh` boundary, the one-clone limitation, the diagnosis-versus-doctor scope boundary, and the rollback with its named manual step.

## 2026-08-06 — Add: additive isolated worktree runtime

**Goal:** Let every checkout — the main clone and each linked `git worktree` — own exactly one container, one host port set, one persisted data root, one URL, and one lifecycle, so two agents can work two branches at once without sharing a container, colliding on a port, or destroying each other's state. This stage is deliberately additive: the existing `devpod up .` entrypoint is untouched and keeps working, and Stage 5B is the cutover.

**How to implement:** Add `scripts/worktree/contract.toml` as the single machine-readable authority for identity, ports, paths, timeouts, routing, and commands — flat `key = value` TOML, because the runtime reads it with `sed` before Bun or `jq` exist on the host and because the renderer's capability fences are line based. The contract is **generated** from `template-parameters.toml` by `renderWorktreeContract()` in `scripts/template/render-fixture.ts` (downstream projects have no `template-parameters.toml` and own the rendered file directly), which needed two parameter additions: `[routing] published_container_port` and a required `directory` + `command` on each `$defs.service`. Add eleven bash scripts beside the contract. `lib.sh` is side-effect-free and holds the contract readers, a no-`eval` `~`/`${HOME}` expander, atomic write, a sed-only env-file reader that never sources, the quoting helper, `wt_require_container_tooling`, and `wt_definition_fingerprint` — an exact bash re-implementation of the image-owned `.devcontainer/devcontainer-fingerprint.sh` (same inputs, same `path\0type\0mode\0digest` framing, same final sha-256), because the host needs that answer before Bun exists. `lock.sh` is `flock(1)` when present and an `mkdir` lock with pid/epoch staleness reclaim otherwise. `env.sh` derives the family (main checkout → `main` at offset 0, never registered; a linked worktree → `<parent>-<dir>`, with a literal `worktrees` parent folding to its grandparent), computes a preferred offset from `cksum(family) % modulus + 1`, and has the host-global registry at `~/.config/devcontainer/ports-registry/ports.json` arbitrate it by **whole derived port-set disjointness** rather than offset uniqueness — declared base ports are usually contiguous, so two different offsets can still collide on a real port — then writes two environment files, a host view and a container view whose ports are deliberately *not* offset because each container owns its network namespace. `ensure.sh` owns container lifecycle: ownership is `devcontainer.local_folder` **and** `devcontainer.config_file` **and** Running **and** the Git common directory bind mounted at its host path, the fast path is one cached-id read plus a single inspect with no lock at all, and every caller that misses it converges on one `devcontainer up` under a lifecycle lock. `exec.sh` is the bridge, dispatching cloud → in-container → host in that fixed order because the order *is* the safety property. `manifest.sh` publishes `~/.config/devcontainer/worktrees/<id>.json` through a same-directory temp plus `os.replace`, writes and removes the optional Caddy snippet, and treats the host Caddy reload as best effort. `services.sh` topologically sorts `depends_on` with declaration order as the tie-break and gates on declared health expectations rather than sleeps. `up.sh`, `down.sh`, and `cleanup.sh` are the lifecycle: `down` keeps the registry entry, the ports, the manifest, the data, and the container so a later `up` hands back identical URLs, while `cleanup` removes this checkout's container, its `${devcontainerId}` volumes (prefixes derived from `devcontainer.json`, never hardcoded), its manifest, route, registry entry, generated state, and data — then re-inventories all of it and exits 1 listing survivors. `selftest.sh` is a bounded hermetic smoke. Guard the whole thing with `scripts/template/worktree-contract.ts` (`bun run worktree:check`): exact key-set equality against a frozen list, regeneration equality against `template-parameters.toml`, devcontainer coherence, fingerprint-input authority, per-script mode/`bash -n`/token checks, a persistence-literal scan, sync and ownership coverage, and CI wiring. Two `.devcontainer/devcontainer.json` entries make it work: a `--publish 127.0.0.1:${localEnv:DEVENV_PUBLISHED_HOST_PORT}:8080` run argument and `containerEnv.DEVCONTAINER_WORKTREE_ENV_FILE` pointed at the generated container-view file through `environment.sh`'s existing seam. Add `.dev/` to `.gitignore` and an explicit `scripts/worktree/*` include to `scripts/sync-devcontainer.sh`, whose `scripts/*` exclusion would otherwise make the "merge" sync policy a lie. Seal the acceptance run in `evidence/stage-5-worktree.json` with per-command raw logs and SHA-256 digests under `evidence/stage-5-worktree-run/`.

**Why downstream cares:** Two consequences are worth knowing before merging. First, **this costs every existing container exactly one rebuild.** `.devcontainer/**` is a definition-fingerprint input and `setup-proto.sh` hard-fails container start on a fingerprint mismatch, so the two added `devcontainer.json` entries invalidate every container that already exists; run `devpod up . --recreate` once after adopting. Second, the published host port is only *stable* when the runtime drives the start. With `DEVENV_PUBLISHED_HOST_PORT` unset — the DevPod and editor path — the CLI collapses `${localEnv:}` to the empty string and the argument becomes `-p 127.0.0.1::8080`, which Docker accepts and answers with an ephemeral loopback port; nothing that worked before breaks, it just gets a random port until `scripts/worktree/env.sh` and `ensure.sh` are in the loop. To adopt manually: copy `scripts/worktree/**`, edit `contract.toml` in place for your project (there is no generator downstream), add the two `devcontainer.json` entries, add `.dev/` to `.gitignore`, install the host prerequisites (a container engine, `@devcontainers/cli`, and `python3` — Bun is *not* a host prerequisite), and, for the friendly `.localhost` routes, add `import ~/.config/devcontainer/caddy/*.caddy` to your host Caddyfile once. Rolling back has one ordering rule: run `bash scripts/worktree/cleanup.sh` in every live worktree **before** reverting, because after the revert nothing knows which resources belonged to which checkout.

**Changed files:**
- `scripts/worktree/contract.toml`, `scripts/worktree/{lib,lock,env,ensure,exec,manifest,services,up,down,cleanup,selftest}.sh` — the generated contract and the eleven-script runtime.
- `scripts/template/worktree-contract.ts`, `scripts/template/validate-worktree.ts`, `package.json` — the drift guard and its `worktree:check` entry point.
- `scripts/template/stage-five-evidence.ts`, `scripts/template/collect-stage-five-evidence.ts`, `scripts/template/validate.ts`, `evidence/stage-5-worktree.json`, `evidence/stage-5-worktree.schema.json`, `evidence/stage-5-worktree-run/**` — the command-bound acceptance record, its collector, and its wiring into `template:validate`.
- `scripts/template/__tests__/worktree.test.ts`, `scripts/template/__tests__/stage-five-evidence.test.ts`, `scripts/template/__tests__/template.test.ts` — the behaviour matrix, contract mutations, evidence fabrication rejection, and the rendered-contract identity assertions.
- `template-parameters.toml`, `template-parameters.schema.json`, `scripts/template/parameters.ts`, `scripts/template/render-fixture.ts` — the `published_container_port` and per-service `directory`/`command` parameters and the contract emitter.
- `.devcontainer/devcontainer.json`, `.gitignore`, `scripts/sync-devcontainer.sh`, `docs/devcontainer-upgrade/stage-0/template-ownership.json`, `.github/workflows/ci.yml` — the publish run argument and worktree env-file seam, the generated-state ignore, the downstream sync include, the ownership and artifact rules, and the two hermetic CI steps.
- `AGENTS.md`, `README.template.md`, `docs/devcontainer-upgrade/stage-5a/README.md` — runtime ownership rules, host prerequisites and the parallel-worktree walkthrough, and the stage ownership/validation/capture/rollback reference.

## 2026-08-05 — Add: Codex Cloud parity contract, bootstrap, doctor, and smoke

**Goal:** Give Codex Cloud the same verified toolchain the local devcontainer gets from its image, without Docker and without a second set of pins. A cloud task should either run against an environment that provably matches the committed contract or refuse, and it should never be the place where Docker, worktree lifecycle, deployment, or production credentials appear.

**How to implement:** Add `.codex/cloud/contract.toml` as the single machine-readable cloud authority — flat `key = "value"` TOML, because the scripts read it with `sed` before Proto, Bun, or `jq` exist and because the renderer's capability fences are line based. Every value mirrors an authority that already exists: tool versions from `.prototools`, architecture digests from `.devcontainer/proto-checksums.txt`, the Graphify and browser pins from the Dockerfile `ARG`s, and the browser pin again from the `@playwright/test` catalog entry. Add four bash scripts beside it. `lib.sh` is side-effect-free and holds the contract readers, a no-`eval` `${HOME}`/`~` expander, and `cloud_contract_fingerprint`, which hashes the profile plus the **committed** content (`git show HEAD:<path>`, working-tree fallback) of every declared `fingerprint_inputs` path so an agent's own edit to `bun.lock` cannot make the pre-command doctor reject the rest of that same task. `bootstrap.sh` is both the setup and the maintenance command: it validates the profile, refuses non-Linux kernels, writes the persisted environment file named by `paths.cloud_persisted_environment` and appends its `~/.bashrc` source line exactly once (`grep -Fqx`), upserts allow-listed secrets into a sibling mode-`0600` file through `mktemp` + `mv -f` using `${name+x}` so a deliberately empty value still persists and a stripped one is not erased, reuses the one shared checksum-pinned `.devcontainer/install-proto.sh`, installs the contract's tools under a bounded `retry_command` (attempt count, `timeout`, fixed backoff), runs the frozen dependency install, provisions the browser payload only for the `browser` profile, writes the fingerprint marker, and finally self-verifies by running the doctor. `doctor.sh` is fail-closed and read-only — it installs, downloads, and repairs nothing, and every refusal names `bash .codex/cloud/bootstrap.sh <profile>`. `exec.sh` is the command boundary: it sources the persisted environment, exits 3 when `CODEX_CLOUD=true` is absent, and otherwise runs `doctor.sh --quiet` on its own line so `set -e` aborts an unhealthy environment before the requested command can execute. `selftest.sh` proves all of that hermetically by stubbing every tool — including `uname` — in a disposable `PATH` under `mktemp -d`, so it runs with no network on a macOS host too. Guard the whole thing with `scripts/template/cloud-contract.ts` (`bun run cloud:check`), which checks exact key-set equality against a frozen list, cross-checks every pin against its real authority, re-checks the frozen Stage 3 browser handoff, `bash -n`s and mode-checks every script, scans the doctor for installer tokens and every script for the contract's `forbidden_cloud_commands`, asserts `exec.sh`'s token ordering, and — in a render where the capability is disabled — asserts no cloud residue is left behind at all. Wire two hermetic steps into `ci.yml` and add a separate `codex-cloud-smoke.yml` that runs the real bootstrap for both profiles on a path filter, a schedule, and manual dispatch, with no base-branch filter and no aggregate-gate membership. Seal the acceptance run in `evidence/stage-4-cloud.json` with per-command raw logs and SHA-256 digests under `evidence/stage-4-cloud-run/`.

**Why downstream cares:** A generated project gets a working Codex Cloud setup with no per-project scripting: point the hosted environment's setup and maintenance command at `bash .codex/cloud/bootstrap.sh`, set `CODEX_CLOUD=true`, and run project commands through `bash .codex/cloud/exec.sh`. The persisted environment, secrets, and fingerprint marker paths are rendered from the project slug, so `~/.config/<slug>/codex-cloud.env` and `~/.cache/<slug>/codex-cloud` are per project by construction. Two caveats are worth knowing before the first run. Cloud secrets are exposed to the setup and maintenance phases only and stripped before the agent phase, so only the contract's eight generic allow-listed names plus anything named in `CODEX_CLOUD_PERSIST_EXTRA_ENV` are bridged forward; deployment and production credentials are deliberately excluded and stay in GitHub Actions. And `bun run cloud:check` against a freshly rendered project reports `cloud: fingerprint input bun.lock is missing` until the first install writes a lockfile — that is by design, since a dependency change must invalidate a prepared cloud environment.

**Changed files:**
- `.codex/cloud/contract.toml`, `.codex/cloud/lib.sh`, `.codex/cloud/bootstrap.sh`, `.codex/cloud/doctor.sh`, `.codex/cloud/exec.sh`, `.codex/cloud/selftest.sh` — the cloud contract, shared helpers, bounded bootstrap, read-only doctor, execution boundary, and hermetic selftest.
- `scripts/template/cloud-contract.ts`, `scripts/template/validate-cloud.ts`, `package.json` — the drift guard and its `cloud:check` entry point.
- `scripts/template/stage-four-evidence.ts`, `scripts/template/collect-stage-four-evidence.ts`, `scripts/template/validate.ts`, `evidence/stage-4-cloud.json`, `evidence/stage-4-cloud.schema.json`, `evidence/stage-4-cloud-run/**` — the command-bound acceptance record, its collector, and its wiring into `template:validate`.
- `scripts/template/__tests__/cloud.test.ts`, `scripts/template/__tests__/stage-four-evidence.test.ts`, `scripts/template/__tests__/template.test.ts` — contract mutation coverage, hermetic behavior coverage, evidence fabrication rejection, and the `codex_cloud` residue test.
- `scripts/template/render-fixture.ts`, `docs/devcontainer-upgrade/stage-0/template-ownership.json` — README fence filtering, the contract's project-slug rewrite, and the cloud ownership, artifact, package, and capability-signature entries.
- `.github/workflows/ci.yml`, `.github/workflows/codex-cloud-smoke.yml` — the two required hermetic steps and the separate networked core/browser smoke.
- `AGENTS.md`, `README.template.md`, `.devcontainer/secrets.example`, `docs/devcontainer-upgrade/stage-4/README.md` — cloud ownership rules, hosted setup instructions, the secret allow-list note, and the stage ownership/validation/capture/rollback reference.

## 2026-08-05 — Remove: unused toolchain pins, Cursor support, and stale generator artifacts

**Goal:** Make the template less opinionated by deleting everything a three-agent audit proved was owned by nothing — five proto pins with zero call sites, two orphaned tsconfig bases, the entire Cursor surface, stale hand-copied openspec artifacts, and an on-create step that has been failing since its CLI pin — and resolve the moon capability contradiction in the keep direction.

**How to implement:** Drop `fly`, `dagger`, `yq`, `infisical`, and `direnv` from `.prototools` and `.devcontainer/prototools.auxiliary` (the union guard enforces the paired edit); rebind the stage-1 `mutable-proto-plugin` mutation from direnv's plugin URL to jq's. Delete `tsconfig.next.base.json` (no Next.js capability exists) and `tsconfig.stagehand.base.json` (Stagehand is not a capability; its include paths never existed). Remove Cursor entirely: `.cursor/` (mcp.json, the CLAUDE.md rules symlink, and opsx copies), its guard/render/ownership entries, the CLAUDE.md `.mdc` frontmatter that existed only for the symlink, and README/AGENTS mentions. Promote moon from a paper capability to core: the pin was already hard-required regardless of the flag and the `moon=false` render path was never exercised, so the flag is gone and `.moon/**` ships unconditionally. Replace `setup-openspec.sh`'s `openspec init --tools claude,codex,cursor --force` — broken at the 0.19.0 pin (`--force` is not a valid option) and, when it did run, the writer of a second differently-named artifact family that contradicted the committed set — with a fail-closed verification of the pinned binary and the committed `openspec/config.yaml`. Regenerate the `.claude` opsx set against pinned 0.19.0 via `artifact-experimental-setup` (full 7-command/7-skill set; the pre-rename `propose` pair is deleted) and remove the hand-copied `.codex/skills/openspec-*` duplicates — 0.19.0 has no codex artifact target; codex reads `AGENTS.md` and calls the CLI. Resync the codex graphify skill to the canonical claude/gemini text. Extend `init-host.sh` and README §7 to pre-create/document `container-env/` and `codex-auth/` alongside `secrets.d/`. Refresh `graphify-out/` with CLI 0.9.16 (the committed graph predated the entire Stage 0–3 program). Fix the dead moon YAML schema mappings in `.vscode/settings.json`, drop the tera/infisical extension recommendations and biome's `*.tera` exclusion, and empty `sync-devcontainer.sh`'s opencode prune list.

**Why downstream cares:** Downstream repos scaffolded before this change carry the same residue (trading-games removed its copy in Confiador/trading-games#895) — the same greps apply: a pin nothing invokes, a tsconfig nothing extends, an editor dir no tool reads. Projects that relied on `openspec init` running at container create should note it no longer does: the committed `.claude` opsx artifacts plus `openspec/config.yaml` are the source of truth, and the CLI works without init. Secrets/host setup gains two documented directories (`container-env/`, `codex-auth/`) that `init-host.sh` now pre-creates.

**Changed files:**
- `.prototools`, `.devcontainer/prototools.auxiliary`, `.devcontainer/configs/.p10k.zsh` — five pins removed; direnv prompt segment dropped.
- `tsconfig.next.base.json`, `tsconfig.stagehand.base.json` (removed), `AGENTS.md`, `scripts/template/__tests__/toolchain.test.ts`, `scripts/template/render-fixture.ts` — orphaned bases and their references.
- `.cursor/**` (removed), `scripts/template/agent-payload-contract.ts`, `scripts/template/__tests__/{template,image}.test.ts`, `docs/devcontainer-upgrade/stage-0/template-ownership.json`, `CLAUDE.md`, `README.md` — Cursor removal.
- `template-parameters.toml` + schema, `fixtures/template/*.toml`, `scripts/template/parameters.ts` — moon promoted to core.
- `.devcontainer/on-create/setup-openspec.sh`, `.claude/commands/opsx/**`, `.claude/skills/openspec-*/**`, `.codex/skills/openspec-*` (removed), `.codex/skills/graphify/SKILL.md` — openspec artifact story.
- `init-host.sh`, `README.md`, `.vscode/settings.json`, `.vscode/extensions.json`, `.devcontainer/devcontainer.json`, `biome.jsonc`, `scripts/sync-devcontainer.sh`, `.gitignore`, `graphify-out/**` — host setup, editor hygiene, prune list, graph refresh.

## 2026-08-05 — Add: env-file secret delivery, canonical container environment, and agent auth persistence

**Goal:** Give every process in the container one authority for secrets instead of a per-surface patchwork, move exported-environment assembly out of the interactive shell files into a single sourceable script, keep the Codex login alive across rebuilds and parallel worktrees, and stop Claude Octopus's harness-incompatible hook layer from denying every Bash call. This supersedes the `/etc/environment` mirror and `setup-secrets.sh` introduced in the 2026-06-10 entry "Change: export devcontainer secrets to children + re-sync /etc/environment on start" below; that script is deleted.

**How to implement:** Parse the two-tier host secrets files (`~/.config/devcontainer/secrets`, then `~/.config/devcontainer/secrets.d/<DEVCONTAINER_PROJECT>`, project wins) with the new strict `KEY=value` reader `.devcontainer/lib/env-file.sh`, which never evaluates a secrets file as shell and reports a bad line by file/line or key, never by value. On the host, `.devcontainer/host/prepare-container-env.sh` runs that parser and atomically writes a mode-`0600` Docker environment file at `~/.config/devcontainer/container-env/<slug>.env`; `devcontainer.json` names it in `runArgs` as `--env-file`, so Docker applies it to PID 1 and everything descended from it — lifecycle hooks, shells, the editor extension host, MCP subprocesses, and `docker exec`. `initializeCommand` is declared in **object form** with two independently gateable named entries — `prepare-container-env` (unconditional, and also the place that pre-creates the host-owned Codex snapshot directory with `|| true` so a `mkdir` failure can never block `devcontainer up`) and `capture-warp-env` (dropped by a `claude_warp`-disabled render). The preparer must never ride inside the gated entry: `runArgs` names the file it writes, so a render that omitted it would emit a devcontainer whose `docker run` fails at create. In the container, the new `.devcontainer/environment.sh` is the canonical exported environment: it re-reads the same mounted sources under `/run/devcontainer-config`, loads `.env.worktree` and an optional project hook, normalizes `NODE_OPTIONS`, and assembles PATH from ordered `path_prepend` calls (dedupe-then-prepend, so repeated sourcing is byte-identical). `.bashrc`/`.zshrc` source it before any interactive configuration and `.shell_common` keeps only aliases, completions, and the Warp signals; `on-create.sh` sources it too and then activates Proto, so create-time installers inherit API keys with no `/etc/environment` write and no secret value in any log. `on-create.sh` also re-derives git identity from `GIT_USER_NAME`/`GIT_USER_EMAIL` because `~/.gitconfig` lives on the ephemeral layer. Persist the Codex login by bind-mounting `~/.config/devcontainer/codex-auth/<slug>` and having `on-create/codex-auth-snapshot.sh` seed `~/.codex/auth.json` on create and capture the rotated token back on every Claude `SessionStart`; the `~/.codex` volume itself stays per-worktree so live SQLite state is never shared. Empty octo's hooks manifest with `on-create/sanitize-octo-hooks.sh` (both shipped layouts, idempotent, no-op when octo is absent) from `setup-claude-octopus.sh` and from `SessionStart`, which leaves octo's skills, commands, and agents untouched. Retarget the PATH guards at the new authority: `toolchain.ts` and `agent-payload-contract.ts` now judge `environment.sh`'s ordered prepends rather than a literal string in `.shell_common`, and the fixture renderer drops hook commands that call a capability-omitted script.

**Why downstream cares:** To adopt manually — copy `.devcontainer/lib/env-file.sh`, `.devcontainer/environment.sh`, and `.devcontainer/host/prepare-container-env.sh`; call the preparer from an unconditional named entry of your `initializeCommand` object; add `runArgs: ["--env-file", "${localEnv:HOME}/.config/devcontainer/container-env/<slug>.env"]`; source `environment.sh` from `.bashrc`, `.zshrc`, and `on-create.sh`; then delete `setup-secrets.sh`, its `postStartCommand` invocation, and the `/etc/environment` block it managed. Refresh semantics change and improve: a key added on the host reaches **new shells immediately** (`environment.sh` re-reads the mounted sources every bootstrap), while the PID-1 snapshot that non-shell surfaces inherit refreshes on the next `devpod up` plus container restart. Secrets files must now be literal `KEY=value` — interpolation and command substitution that a `source`-based loader tolerated are rejected before container creation.

**Changed files:**
- `.devcontainer/lib/env-file.sh`, `.devcontainer/host/prepare-container-env.sh` — new strict parser and host-side `--env-file` writer.
- `.devcontainer/environment.sh`, `.devcontainer/configs/.bashrc`, `.devcontainer/configs/.zshrc`, `.devcontainer/configs/.shell_common`, `.devcontainer/on-create/setup-shell.sh` — canonical exported environment and interactive-only shell files.
- `.devcontainer/devcontainer.json`, `.devcontainer/host/capture-warp-env.sh`, `.devcontainer/on-create.sh`, `.devcontainer/on-create/setup-secrets.sh` (removed) — `--env-file` wiring, the two-entry `initializeCommand` object, environment prologue (including the explicit `setup-common.sh` source that `install_workspace_dependencies` needs), git identity, and the deleted `/etc/environment` mirror.
- `.devcontainer/on-create/codex-auth-snapshot.sh`, `.devcontainer/on-create/setup-codex.sh`, `.devcontainer/on-create/sanitize-octo-hooks.sh`, `.devcontainer/on-create/setup-claude-octopus.sh`, `.claude/settings.json` — Codex auth seed/capture and the octo hook sanitizer, both also on `SessionStart`.
- `.devcontainer/AUTH-PERSISTENCE.md`, `.devcontainer/secrets.example` — mechanism-by-credential reference, refresh semantics, and the documented secrets format.
- `scripts/template/toolchain.ts`, `scripts/template/agent-payload-contract.ts`, `scripts/template/render-fixture.ts`, `scripts/template/__tests__/*`, `docs/devcontainer-upgrade/stage-0/template-ownership.json` — PATH guards retargeted to `environment.sh`, capability ownership for the new scripts, and the corrected runtime-mutation inventory.

## 2026-07-15 — Docs: clarify portable upgrade stage status and outcomes

**Goal:** Make the active portable devcontainer upgrade plan readable at a glance and accurately report the implementation already merged.

**How to implement:** Add a plain-language outcome directly below every stage heading in the OpenSpec task plan, record that 20 of 82 tasks across Stages 0–3 are complete and merged, and identify Stage 4 as the next stage. Normalize the four completed Stage 3 checklist items so OpenSpec counts them instead of treating their extra indentation as nested content.

**Changed files:**
- `openspec/changes/portable-devcontainer-upgrade/tasks.md` — current status, stage outcomes, and normalized Stage 3 checklist formatting.
- `CHANGES.md` — downstream-facing documentation of the task-plan correction.

## 2026-07-15 — Add: reproducible Stage 3 acceptance evidence

**Goal:** Bind the Stage 3 browser, agent payload, watchdog, shell, plugin-repair, performance, storage, and rollback acceptance results to exact commands and raw logs from the reviewed image.

**How to implement:** Capture the warm browser image build, then inspect and bind the post-build manifest-list identity before running the repository-pinned browser launch, enabled launcher paths, local plugin source repair, Bash/Zsh login and non-login PATHs, existing known-bad fixture suites, second-worktree storage, and a synthetic mainline-revert proof through one Bun collector. Record exact argv, timestamps, image/source identities, log paths, and log SHA-256 values in a strict machine-readable schema. Revalidate the evidence against the current Docker/package authorities, runtime source markers, bound logs, committed Stage 2 comparison values, and an implementation boundary that remains ancestral to the PR head. Keep the cloud browser profile as an explicit Stage 4 handoff and roll back the complete Stage 3 merge atomically.

The committed run `stage3-20260715t150405z-af2ac5b2` passed all 14 commands against post-build ARM64 image `sha256:9010dd4ed9ca43be94025199d47c02fff5755f5f9c522321a77963dffe33c5ff`. Its warm build was 2,345 ms, browser preflight was 1,756 ms, second-worktree growth was 4,775,936 bytes versus the 96,111,608-byte Stage 0 baseline, and the synthetic mainline revert restored the exact Stage 2 predecessor tree.

## 2026-07-15 — Fix: integrate Stage 3 runtimes with the verified lifecycle

**Goal:** Preserve Stage 2 lifecycle verification while making browser and agent payload behavior capability-complete and reliable in generated environments.

**How to implement:** Append browser preflight to the final `-c` lifecycle body with `&&`, retaining the complete startup-scrub and image-verifier prefix. Mark the baked Playwright payload with its exact package version and require preflight to match that marker before launching the single headless shell, with no package-default fallback. Treat non-TTY Gemini stdin as headless, keep the shipped real-binary path fixed, and patch only temporary wrapper copies in hermetic tests. Omit Graphify stages, setup, and all three agent-specific skill copies when disabled; do not model an unowned Cursor Graphify root. Remove only Octopus's exact legacy shared link before rejecting project and user shared-root skill collisions. Prove each integration rule with a known-bad mutation, the Graphify-disabled minimal fixture, focused runtime tests, and the combined browser image smoke.

## 2026-07-14 — Fix: close Stage 2 adversarial evidence gaps

**Goal:** Prevent a workspace binary from forging the image-definition check and make the recorded architecture, storage, cache, and rollback evidence reject cached or fabricated observations.

**How to implement:** Resolve Proto and the versioned native Bun executable through fixed, absolute image-owned paths only after validating the mounted root manifest against its baked checksum; never compute the fingerprint through Proto's environment-sensitive shim. Fix the verified checkout and image-contract marker roots to `/workspace` and `/usr/local/share/devenv-image` so container environment variables cannot redirect either trust input. Install the verifier and fingerprint helper into that image-owned directory, then enter every Bash lifecycle through absolute `env` startup scrubbing and run the image verifier before any mounted checkout script. Compute the fingerprint and tool health checks in a separately allowlisted clean environment, pass native Bun explicitly to the fingerprint helper, and reject any tool path that escapes the baked Proto root. Invoke verification utilities through absolute system paths so workspace-local commands cannot intercept the contract. Prove the real on-create boundary with a changed definition, workspace command sentinels, modified mounted lifecycle/helper/fingerprint scripts, and poisoned shell/runtime startup options. Run each supported-architecture evidence build with cache disabled and require the architecture-sensitive base, Proto, Claude, and final stages to execute. Deep-bind JSON probe records to their hashed raw logs, recompute cache counts and storage arithmetic, compare the Stage 0 storage baseline, use deterministic synthetic-merge metadata, and derive rollback trees and parent order from the real Git boundary.

The immutable remediated implementation boundary is `69a97d84e2591242265887a7c062bbb0853b5ca9`; evidence-only commits follow it without changing image inputs.

The replacement run `stage2-20260715t142339z-b2e18c63` executed both supported architectures without cache, refused the stale mounted-checkout definition before its setup scripts ran, measured 4,472,832 bytes of second-worktree growth against the 96,111,608-byte Stage 0 baseline, and restored the actual predecessor tree through the deterministic mainline-revert proof.

**Changed files:**
- `.devcontainer/Dockerfile`, `.devcontainer/devcontainer.json`, `.devcontainer/devcontainer-fingerprint.sh`, `.devcontainer/on-create/setup-proto.sh` — image-owned verification before mounted checkout setup, absolute fingerprint execution, and realpath enforcement.
- `scripts/template/image-evidence.ts`, `scripts/template/collect-stage-two-evidence.ts`, evidence schema/tests — uncached architecture proof and non-vacuous log/Git/metric validation.
- `docs/devcontainer-upgrade/stage-2/README.md`, `scripts/template/image-contract.ts`, image tests — operator contract and regression guards.
## 2026-07-15 — Add: bounded Gemini headless watchdog

**Goal:** Prevent unattended Gemini prompts from hanging indefinitely without changing interactive behavior, caller-selected output formats, or the exact-pinned Gemini payload. Idle or signalled runs must terminate every process in the child group, report stable exit codes, and never treat malformed output as progress.

**How to implement:** Keep the real CLI at `/home/vscode/.payloads/gemini/bin/gemini` and copy the Proto-Bun watchdog from `.devcontainer/configs/gemini-watchdog` to `/home/vscode/.local/bin/gemini`, where the existing PATH contract shadows the payload. Pass interactive, help/version, prompt-interactive, explicit-format, and `GEMINI_WATCHDOG_BYPASS=1` calls through unchanged. Add `stream-json` only to `-p`/`--prompt` runs; decode JSONL with a bounded partial line, sanitize assistant text, and reset the configurable idle deadline only for valid assistant or tool activity. Run the real CLI in a dedicated process group; on timeout, forwarded signal, or a leader that leaves descendants, signal the group, wait the bounded grace period, escalate to KILL, and reap it. Preserve timeout `124`, missing-binary `127`, configuration `2`, normal child, and `128 + signal` exits. Capability-own the wrapper source, verify both wrapper and payload during on-create, guard the Docker destination and process semantics, and cover pass-through, output, activity, malformed/oversized streams, TERM resistance, signals, and orphan cleanup with a hermetic fake Gemini. Roll back the eventual Stage 3 merge atomically; a temporary operational bypass may set `GEMINI_WATCHDOG_BYPASS=1` while retaining the exact image payload.

**Changed files:**
- `.devcontainer/configs/gemini-watchdog`, `.devcontainer/Dockerfile`, `.devcontainer/on-create/setup-gemini.sh` — bounded stream watchdog, image shadow path, and fail-closed verification.
- `scripts/template/agent-payload-contract.ts`, image/watchdog tests and fake Gemini fixture, ownership inventory — structural, capability, mutation, process-group, and exit-code proof.
- `docs/devcontainer-upgrade/stage-3/agent-payloads.md`, `AGENTS.md` — operator variables, runtime boundary, maintenance rule, and rollback.

## 2026-07-15 — Add: exact agent and local plugin payload contract

**Goal:** Finish the agent-runtime portion of the Stage 3 image without mutable first-run downloads, duplicate skill discovery, or shell-dependent launcher selection. Codex, Gemini, Claude, Graphify, ccstatusline, Context7, Claude Octopus, and Warp must each have one exact image authority and remain capability-complete when rendered.

**How to implement:** Keep the reviewed Codex `0.144.4`, Gemini `0.50.0`, Claude `2.1.210`, Graphify `0.9.16`, ccstatusline `2.2.23`, and node-gyp `13.0.1` payloads isolated. Add Context7 MCP `3.2.3` as its own Bun payload and replace floating `bunx` MCP commands with the image launcher. Download Claude Octopus commit `f42f34a8f9a7ee5b9324e8b2d23159878c132b02` and Warp commit `58c823da195346a7e6645fd2d9484d0e38db6bc2` only through immutable archive URLs, verify the reviewed SHA-256 digests, and rewrite Octopus's local marketplace entry so bounded on-create registration never reaches GitHub. Require persisted Claude marketplaces to point at the image directories and compare installed plugin source markers with their image authorities, reinstalling locally when an older cache differs. Move the Codex Graphify skill from the shared `.agents` root to `.codex/skills/graphify`, retain Claude/Gemini-specific copies, model every effective discovery root, refuse duplicate names, and link Octopus skills collision-safely into Codex's own user root. Disable nonessential updater/telemetry behavior for unattended setup and normalize Bash/Zsh login, non-login, editor, and on-create PATH authority to workspace binaries, Proto shims, Proto binaries, then image launchers. Render Context7, Octopus, and Warp stages/setup/config only when selected; prove omission with the minimal fixture and inclusion with the full fixture. Guard exact versions/commits/checksums, Renovate matching, local-only registration, launcher ownership, MCP commands, PATH ordering, and duplicate skills with positive and known-bad tests. Roll back this agent payload bundle atomically with `git revert -m 1 <stage-3-pr-merge-commit>`; do not restore the floating setup scripts independently.

**Changed files:**
- `.devcontainer/Dockerfile`, `renovate.json` — exact Context7 package payload plus checksum-verified Octopus/Warp source stages and isolated update authorities.
- `.devcontainer/on-create/**`, `.devcontainer/devcontainer.json`, shell config, MCP settings — bounded local registration, unattended environment, direct Context7 launcher, and consistent PATH ownership.
- `.codex/skills/graphify`, `.claude/skills/graphify`, `.gemini/skills/graphify` — agent-specific Graphify discovery without the duplicate shared root.
- `scripts/template/agent-payload-contract.ts`, image contract/tests, fixture/ownership renderer — structural, mutation, skill-discovery, PATH, and capability omission proof.
- `docs/devcontainer-upgrade/stage-3/agent-payloads.md`, `AGENTS.md`, `README.md` — maintenance, verification, and rollback contract.
## 2026-07-15 — Add: capability-owned Playwright browser runtime

**Goal:** Make the optional browser profile reproducible and executable instead of treating an installed package or downloaded browser directory as proof of health. The Playwright package family, Docker payload, system libraries, generated profile, and runtime launch now form one capability-owned contract while browser-disabled projects contain no related residue.

**How to implement:** Keep `@playwright/test`, `playwright`, and `playwright-core` at one exact catalog/lock version and require the Docker `PLAYWRIGHT_VERSION` to match it. Build only Chromium's headless shell plus Playwright's matching FFmpeg in the isolated browser payload, assert both executables exist, and assemble them with the complete Debian runtime/font library set only in `development_browser`. Use the repository-local `browser:preflight` command to locate the single image-owned headless shell under `PLAYWRIGHT_BROWSERS_PATH` and pass that exact path to Playwright; `chromium.executablePath()` names the absent full-Chromium binary when only the shell is installed. Launch headlessly, load and verify a network-free data page, and close the page and browser. Render the guard, dependencies, scripts, Docker stages, generated post-create invocation, and CI browser-build/launch job only when Playwright is selected. The template source keeps its non-browser default but CI renders the full fixture and launches its baked payload. Run `browser:check`, the known-bad mutation tests, and a real `development_browser` container preflight. Roll back the package/lock/Docker/runtime/rendering bundle together; never install a system browser or unpinned fallback. The implementation was adapted from the reviewed Trading Games browser contract at commit `772996964cea7b2ac812e99ec3f8f9d490124630`.

**Changed files:**
- `.devcontainer/Dockerfile` — isolated exact browser/FFmpeg payload verification and complete runtime libraries.
- `scripts/browser-preflight.ts`, `scripts/template/browser-contract.ts`, `scripts/template/validate-browser.ts` — real launch check and dedicated coherence guard.
- `package.json`, `.github/workflows/ci.yml`, renderer/ownership/tests — capability-complete scripts, post-create/CI wiring, omission, and mutation proof.
- `AGENTS.md` — ongoing atomic Playwright ownership and validation rules.

## 2026-07-14 — Add: reproducible payload-oriented devcontainer image

**Goal:** Move the complete development toolchain out of per-container mutation and into independently cached, capability-rendered image payloads. Every image download, Proto partition, retained feature, marker, and runtime verification path now has one exact owner, while stale definitions fail closed instead of silently repairing themselves.

**How to implement:** Build from digest-pinned Docker syntax and base images, install stable system tools once, split the root Proto tool/plugin set into exact foundation and auxiliary cache partitions, and assemble isolated Graphify, Playwright, Codex, Gemini, ccstatusline, Claude/node-gyp, and pinned Zinit payload stages. Copy each complete payload before creating its relative launcher symlink in the final image so Docker never dereferences a global-package link and drops runtime dependencies. Keep `.prototools` user-facing, prove both partition unions equal it, and keep `~/.proto` image-owned by removing its active volume. Restrict the build context to `.dockerignore`, `.prototools`, and `.devcontainer`; hash those complete inputs including modes and symlink targets into read-only image markers; make on-create verify the markers and payload paths without installation or ownership repair. Pin every direct artifact by Docker ARG and architecture checksum, reject unsupported architectures and mutable URLs, isolate Renovate updates, retain only digest-locked GitHub CLI, and provide exact-ID unattached legacy Proto-volume cleanup. Normalize Bash and Zsh login profiles so repository-local binaries and Proto shims precede global launchers in every shell mode. Keep prior-stage evidence sealed to its recorded implementation and merge snapshots so later, unrelated source changes cannot invalidate an already reviewed historical run. Bind the Stage 2 run to immutable base and implementation commits, derive all clean/warm/architecture/invalidation/shell/storage/rollback commands from one validator authority, safely replace only the collector-owned raw-log directory on retries, bypass cache only for the mutated Codex owner and final assembly so repeated invalidation proofs remain non-vacuous, retain raw log digests, parse probe diagnostics from their JSON values so multiline output binds exactly, and publish evidence only after schema, semantic, and command-binding validation succeeds. Make that sealed evidence part of the required template validation gate. Render browser and agent stages only for selected capabilities, run `image:check` in generated CI, and require a real selected-target Docker build. Roll back the image, devcontainer definition, partitions, runtime verification, and feature lock together; never restore the Proto volume without reverting the entire ownership model.

**Changed files:**
- `.devcontainer/Dockerfile`, `.devcontainer/prototools.*`, `.dockerignore`, `renovate.json` — staged image payloads, exact download ownership, cache partitions, and restricted context.
- `.devcontainer/devcontainer.json`, `.devcontainer/devcontainer-lock.json`, `.devcontainer/devcontainer-fingerprint.sh` — retained feature, image-owned Proto, and complete definition markers.
- `.devcontainer/on-create*`, `.devcontainer/configs/.zshrc`, `.devcontainer/host/cleanup-legacy-proto-volume.sh` — fail-closed verification, immutable shell setup, and scoped legacy cleanup.
- `scripts/template/image-contract.ts`, renderer/tests, `.github/workflows/ci.yml`, `AGENTS.md` — rendered guard, negative mutation proof, real image build gate, and ongoing ownership rules.
- `scripts/template/image-evidence.ts`, `scripts/template/collect-stage-two-evidence.ts`, `evidence/stage-2-image*.json`, `docs/devcontainer-upgrade/stage-2/README.md` — command-bound capture, strict evidence validation, storage comparison, and atomic rollback proof.

## 2026-07-14 — Add: exact repository toolchain and dependency contract

**Goal:** Make the template's repository toolchain reproducible before changing the image architecture. Every selected Proto tool, project CLI, shared dependency, devcontainer feature, supported Proto archive, and TypeScript alias now has one exact visible authority, with fail-closed guards and machine-readable evidence.

**How to implement:** Exact-pin `.prototools` and replace community plugin branches with immutable commits; make Proto own selected Node and remove the competing feature; verify the exact Proto archive against per-architecture SHA-256 metadata before extraction. Invoke the installer on every create so partial persistent-volume installs self-repair, and require both Proto executables before the fast path. Move project packages into the root catalog, convert non-peer consumers to `catalog:` while permitting compatible catalog-owned peer ranges, regenerate `bun.lock`, and keep workspace-local binaries first. Commit the devcontainer feature digest lock, render config-relative `${configDir}` TypeScript aliases without `baseUrl`, and omit optional package authorities and their guard branches from disabled fixtures. Ship the live guard into rendered projects and recursively scan every non-generated manifest, TypeScript config, package lock, workflow, and local composite action outside ignored build/cache trees; validate every setup-bun action independently with case-insensitive action-repository matching and keep Cloudflare runtime packages lock-owned. Biome-format transformed output before computing its manifest, and make fresh generated CI prove its first project-owned lock, live guard, and retained lint step before freezing later installs. Run the repository/evidence validator, executed known-bad mutation suite, frozen install, generated-project guard, fixture generation, strict template typecheck, and Biome. Bind run IDs, timestamps, raw stdout/stderr artifacts, their recomputed digests, and observed diagnostics into the reviewed implementation boundary. Combine the isolated DevPod stop/remove/volume-delete/recreate exercise with a deterministic synthetic merge revert whose parents and tree are recomputed from the reviewed commits, whose reverted tree exactly matches the actual predecessor tree, and a predecessor image check proving Node resolves from the restored feature with no Proto Node shim. Upgrade Cloudflare, Better Auth, RHF/Zod, or Playwright only as an atomic family. Roll back the merge bundle by stopping the workspace, removing the exact stopped container to release its volume references, reverting with `git revert -m 1 <stage-1-pr-merge-commit>`, removing only the captured project Proto volume, and recreating; never revert a pin, catalog, lock, checksum, or coupled-family member alone.

**Changed files:**
- `.prototools`, `.devcontainer/install-proto.sh`, `.devcontainer/proto-checksums.txt` — exact Proto selection, immutable plugins, and fail-closed architecture checksum bootstrap.
- `package.json`, `bun.lock`, `.devcontainer/devcontainer-lock.json` — exact catalog consumers, singleton package families, and digest-pinned features.
- `.devcontainer/**`, `.github/workflows/ci.yml` — one frozen root install, local-bin PATH precedence, local CLI use, and the Stage 1 CI contract gate.
- `tsconfig*.json`, `scripts/template/**`, `template-parameters*`, `fixtures/template/**` — config-relative aliases, capability-aware package ownership, live guards, and non-vacuous mutation tests.
- `evidence/stage-1-toolchain*.json`, `docs/devcontainer-upgrade/stage-1/README.md`, `AGENTS.md` — strict evidence, operator contract, rollback, and ongoing change rules.

## 2026-07-14 — Add: Stage 0 portable devcontainer baseline

**Goal:** Establish a reproducible, reviewable pre-migration baseline without changing the active devcontainer runtime. The baseline must make template inputs and ownership visible, prove disabled-capability omission, and preserve failed measurements honestly so later stages can compare performance, storage, and reliability against observed behavior.

**How to implement:** Validate `template-parameters.toml` and its schema, keep application services empty until a generated project owns a real service graph, and render the explicit minimal/cloud/full fixtures through `scripts/template/`. Use the ownership inventory to omit project-owned, generated, and template-only evidence paths; strip template-only CI blocks, remove capability-owned package entries, require fixture filename/identity agreement, canonicalize output aliases, protect worktree/common Git metadata, and derive generator-inventory coverage from the lifecycle entrypoint. Run the Bun validation, test, typecheck, and fixture commands; capture image builds and two isolated legacy worktrees using uniquely labeled Docker resources; publish the schema-validated evidence with command/log digests and an observational rollback that rejects active runtime-path changes through the immutable Stage 0 boundary. Merge the stage with a merge commit so that boundary remains reachable, and roll it back with `git revert -m 1 <merge-commit>`. Do not prune Docker or stage Graphify output.

**Changed files:**
- `template-parameters.toml`, `template-parameters.schema.json` — project, path, port, toolchain authority, capability, CI, worktree, and generation contracts.
- `fixtures/template/*.toml`, `scripts/template/**` — deterministic atomic fixture rendering, validation, and known-bad mutation tests.
- `docs/devcontainer-upgrade/stage-0/**` — ownership inventory, synchronization risks, measurement method, and rollback.
- `evidence/stage-0-baseline*.json`, `scripts/template/evidence.ts` — machine-readable measured evidence, strict schema, anti-vacuity checks, commit-lineage proof, and observational runtime-diff validation pinned to an immutable Stage 0 boundary.
- `package.json` — Bun entry points for the Stage 0 gates.
- `.github/workflows/ci.yml` — required Stage 0 schema, mutation, typecheck, fixture, and full-history commit-lineage gate.

## 2026-07-14 — Plan: portable devcontainer upgrade contract

**Goal:** Convert the approved `devcontainer-updates` migration kit into repository-native, testable OpenSpec contracts before changing template runtime behavior. The review found mutable Proto plugin URLs and package versions, runtime/global installers, a per-container Proto volume, fixed ports, Docker-in-Docker, permissive CI, and no verified worktree or Codex Cloud execution boundary.

**How to implement:** Apply the active `portable-devcontainer-upgrade` change in the ordered PR groups in `openspec/changes/portable-devcontainer-upgrade/tasks.md`. Begin with inventory/parameters and a measured baseline, then land the toolchain, image, agent/browser, cloud, additive worktree, cutover, doctor, CI, Moon, OpenSpec, conditional stack, and final-release stages from the latest green `main`. Each PR must include its implementation, required guard, known-bad mutation, documentation/agent rules, rollback, and exact-head evidence; disabled capabilities must generate no residue. Keep this OpenSpec change active through shipping and archive it only after the final implementation PR merges from a clean current default branch.

**Changed files:**
- `openspec/changes/portable-devcontainer-upgrade/proposal.md` — motivation, capability list, breaking cutovers, and impact.
- `openspec/changes/portable-devcontainer-upgrade/design.md` — version ownership, image/runtime architecture, execution boundaries, worktree safety, CI rollout, risks, and migration order.
- `openspec/changes/portable-devcontainer-upgrade/specs/*/spec.md` — seven capability contracts with positive and negative scenarios.
- `openspec/changes/portable-devcontainer-upgrade/tasks.md` — 82 verifiable tasks grouped into independently reviewable implementation stages.

## 2026-06-10 — Change: export devcontainer secrets to children + re-sync /etc/environment on start

**Problem:** Secrets had two load paths and a late-added key (one appended to the host secrets file *after* the container was created) fell through both. (1) `/etc/environment`, written by `on-create.sh`, is captured once at create and goes stale — new keys never land there until a rebuild. (2) `configs/.shell_common` re-sourced the file every interactive shell (so it *saw* late keys) but used a plain `source`, so the values stayed local to that one zsh and child processes (Claude Code, `wrangler`, `!`-bash, tool subshells) didn't inherit them. Net: the persistent exported copy was missing the key and the per-shell copy that had it never exported it.

**What changed:**
1. **`configs/.shell_common`** now wraps the two secrets `source` lines in `set -a` / `set +a` — identical to the warp-env block just below it (whose comment already documented this exact pitfall). Any new shell now exports all secrets, including ones added after create, to its children. Takes effect in new shells, no rebuild.
2. **New `.devcontainer/on-create/setup-secrets.sh`** owns secrets loading: it exports the host-mounted common + per-project secrets into the current process **and** mirrors them into `/etc/environment` idempotently — it replaces a marker-delimited block (`# >>> devcontainer-secrets >>>` … `<<<`) instead of appending, so re-runs never accumulate duplicates. `on-create.sh` now **sources** it (so create-time tool installers still inherit API keys like `GEMINI_API_KEY`), and it also runs from **`postStartCommand`**, so keys added after create re-sync to `/etc/environment` on the next container start (no rebuild). It stays in onCreate *and* postStart — not "instead of" — because the installers need secrets present during setup.

**Why downstream cares:** To adopt manually — wrap your `.shell_common` secrets `source` lines in `set -a`/`set +a`; copy `setup-secrets.sh`; replace the inline secrets block in `on-create.sh` with `source .../setup-secrets.sh`; and prepend `bash /workspace/.devcontainer/on-create/setup-secrets.sh;` to your `postStartCommand`. After adding a key to the host secrets file: open a **new shell** for terminal processes, and **restart** the container (or run `bash .devcontainer/on-create/setup-secrets.sh`) to refresh `/etc/environment` for the extension host.

**Changed files:**
- `.devcontainer/configs/.shell_common` — `set -a`/`set +a` around the secrets source lines.
- `.devcontainer/on-create/setup-secrets.sh` — new; idempotent export + `/etc/environment` block sync.
- `.devcontainer/on-create.sh` — inline secrets block replaced by `source`-ing the new script.
- `.devcontainer/devcontainer.json` — `postStartCommand` re-syncs secrets before `bun install`.

## 2026-06-10 — Change: drop the template graph when scaffolding a new project

**What changed:** `init-new-project.sh` now `rm -rf graphify-out` in its template-only cleanup block (alongside `bun.lock`, `CHANGES.md`, `init-host.sh`). The committed graph describes the template's own scaffolding — `apps/` and `libs/` ship empty (`.gitkeep`), so every node is plumbing (`init-*.sh`, tsconfigs, `.husky/`, devcontainer scripts), none of it the code a child will write. Inherited into a child it's misleading (`graphify query` returns scaffolding nodes and omits the child's real code until a rebuild) and bloats the initial commit by ~1.3 MB. A graph-less child degrades cleanly — the agent rule files gate on "when `graphify-out/graph.json` exists" — and the first `/graphify` run builds a graph of the child's own code.

**Why downstream cares:** Existing repos are unaffected (this only touches project *creation*). The `.gitattributes`/`.gitignore`/pre-commit guardrails added in the entry below stay inert until the child builds its first graph, then apply to *its* graph as intended.

**Changed files:**
- `init-new-project.sh` — `rm -rf graphify-out` in the template-only removal block.

## 2026-06-10 — Change: keep the committed graphify graph out of review diffs

**What changed:** Three guardrails so `graphify-out/` ships to every clone (its original benefit) but can never bloat a diff or get committed by accident:

1. **New root `.gitattributes`** marks every committed graphify artifact `-diff linguist-generated` — Git renders them as "Binary files differ" instead of expanding 500k-line diffs, and GitHub collapses them in PRs and excludes them from language stats. Beyond the four rules from the upstream source (graph.json, manifest.json, GRAPH_REPORT.md, .graphify_*.json), this repo also commits `graph.html` (~674 KB), `cache/**`, and dated snapshot dirs, so rules for those were added too. Inert until `graphify-out/` exists — safe to ship unconditionally.
2. **`graphify-out/GRAPH_REPORT.md.tmp`** added to the root `.gitignore` graphify block (the transient temp written during report regeneration). The block's existing decision — `graph.json`/`graph.html`/`GRAPH_REPORT.md`/`cache/` stay **committed** — is unchanged; we did not adopt the upstream's "ignore cache/" stance.
3. **A `pre-commit` guard** (in `.husky/pre-commit`, ahead of `lint-staged`) rejects a commit that stages `graphify-out/graph.json` alongside any non-graphify file. A pure `chore(graphify)` graph-refresh commit passes. A matching one-line rule was added to the graphify section of `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.

**Why downstream cares:** Projects created from this template are *born* with `graphify-out/` tracked (init-new-project copies it; sync-devcontainer excludes it). To adopt manually: copy the root `.gitattributes`, append the two `graphify-out/` lines to your `.gitignore` and the pre-commit guard block to `.husky/pre-commit`, and add the "never `git add graphify-out/` in a feature commit" bullet to your agent rule files. The guard runs under `sh`; it uses plain `grep` (no `-q`/`-v` combo) so it's portable across grep implementations.

**Changed files:**
- `.gitattributes` — new; `-diff linguist-generated` for graph.json, graph.html, manifest.json, GRAPH_REPORT.md, .graphify_*.json, cache/**, and snapshot dirs.
- `.gitignore` — added `graphify-out/GRAPH_REPORT.md.tmp`.
- `.husky/pre-commit` — guard rejecting mixed graph+feature commits, before `lint-staged`.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — one-line graphify-commit-hygiene rule.

## 2026-06-10 — Change: update default ccstatusline layout

**What changed:** Reworked the seeded ccstatusline layout in `.devcontainer/ccstatusline-settings.json` to **model · thinking-effort · git-branch · context-percentage · (flex) · claude-session-id** (`flexMode: full-until-compact`, `colorLevel: 3`), replacing the previous model · context-length · git-branch · git-changes layout. This is the config new containers seed on a fresh `~/.config` volume. The committed seed intentionally omits ccstatusline's `installation` metadata block (`{method:"pinned", installedVersion:…}`) — it's per-install state ccstatusline writes itself, and pinning a version in the shared seed would fight the `bun add -g ccstatusline` (latest) install.

**Why downstream cares:** Existing repos already have a seeded `~/.config/ccstatusline/settings.json` and won't be overwritten (the setup script never clobbers an existing config). To adopt the new layout in an existing container, copy `.devcontainer/ccstatusline-settings.json` over `~/.config/ccstatusline/settings.json`, or edit it via `ccstatusline` (the TUI configurator).

**Changed files:**
- `.devcontainer/ccstatusline-settings.json` — new default layout.

## 2026-06-10 — Fix: new repos get the ccstatusline status line automatically

**What changed:** A freshly-created repo built its container with the `ccstatusline` binary installed but Claude Code still showed its default status line. Two gaps caused this: (1) **nothing wrote the `statusLine` block into the container's `~/.claude/settings.json`** — `setup-ccstatusline.sh` only installed the binary, and `~/.claude` is a fresh per-project Docker volume on a new repo, so the key was simply absent; (2) the layout seed was copied from `/workspace/.ccstatusline-settings.bak`, which is **`.gitignore`d and not committed**, so it never travelled with the template (it was a transient relay file, not a real seed). `setup-ccstatusline.sh` now (a) seeds the layout from a committed `.devcontainer/ccstatusline-settings.json`, and (b) merges the `statusLine` block into `~/.claude/settings.json` via `jq` — creating the file if absent, preserving any existing keys, and never clobbering a `statusLine` the user set by hand.

**Why downstream cares:** Any repo already created from the template won't retroactively get the status line. To adopt manually: copy the two changed files below, then either rebuild the container or run `bash .devcontainer/on-create/setup-ccstatusline.sh`. Or just add this to `~/.claude/settings.json` inside the container: `"statusLine": {"type":"command","command":"ccstatusline","padding":0,"refreshInterval":10}` (and `bun add -g ccstatusline` if the binary is missing).

**Changed files:**
- `.devcontainer/on-create/setup-ccstatusline.sh` — seed layout from the committed config; merge `statusLine` into `~/.claude/settings.json` with `jq` (idempotent, non-clobbering).
- `.devcontainer/ccstatusline-settings.json` — new committed layout seed (model · context · git branch · git changes), replacing the gitignored `.bak`.
- `.devcontainer/on-create.sh` — corrected the comment above the ccstatusline step (it now actually writes the statusLine block).

## 2026-06-10 — Change: restructure `README.md` into setup-stage sections

**What changed:** Removed the incomplete "Quick Start (Mac)" block (it was confusing because it duplicated and diverged from the fuller instructions below it). Reorganized the README into four clearly-labeled stages — **Host Machine Setup** (macOS automated via `init-host.sh` vs. Windows/Linux manual steps), **Repository Configuration** (clone + `init-new-project.sh`, with the arg behaviors in a table), **Secrets** (two-tier table + `secrets.example` copy flow + `GITHUB_TOKEN` rate-limit tip), and **Starting the Dev Container**. Documented that the **first build must use `devpod up . --recreate`** to provision cleanly, that you then `devpod ssh .` to connect, and that the first build should be run from a Warp terminal so the Warp env capture works. Replaced the raw trailing tool/toolchain lists with a linked "What's Included" section.

**Changed files:**
- `README.md` — full rewrite of structure (content preserved/expanded; no behavior change to scripts).

## 2026-06-02 — Add: package.json infra-key warning in `sync-devcontainer.sh`

**What changed:** Because `package.json` is project-owned (the sync keeps your version), template-managed config embedded in it — `lint-staged`, `commitlint`, and the husky `scripts.prepare` — can silently go missing downstream, which makes the husky `pre-commit`/`commit-msg` hooks fail (`lint-staged could not find any valid configuration`). The sync now checks your `package.json` against the template's for those keys after the file pass and prints a paste-ready warning for any that are missing, plus the `bun add -D …` line for the matching dev deps.

**Changed files:**
- `scripts/sync-devcontainer.sh` — new `check_pkg_infra()` (runs via `bun`/`node`, with a grep-only fallback) called at the end of the file-sync step; warns with the template's actual values for missing `lint-staged`/`commitlint`/`scripts.prepare`.

## 2026-06-02 — Add: `README.template.md` (new repos get a project README, not the template's)

**What changed:** New projects no longer inherit the template's own README. `init-new-project.sh` now renders `README.template.md` into the new repo's `README.md` (substituting `{{PROJECT_NAME}}`) and removes the template file. The sync excludes README files so a project's README is never overwritten.

**Added files:**
- `README.template.md` — minimal starter README with a `{{PROJECT_NAME}}` placeholder.

**Changed files:**
- `init-new-project.sh` — before self-deleting, if `README.template.md` exists: derive the project name (from the repo arg, else the directory name), `sed` the placeholder, write `README.md`, and `rm` the template file.
- `scripts/sync-devcontainer.sh` — `is_excluded()` now skips `README.md` (project-owned) and `README.template.md` (template-only), so README content never flows downstream.

**Downstream note:** repos created before this change still carry the old template README; replace it by hand (sync intentionally won't touch it).

## 2026-06-02 — Add: `scripts/sync-devcontainer.sh` (catch a downstream repo up to this template)

**What changed:** New helper to sync this template's infra layer into another repo that has drifted behind, using **content-aware, per-file classification** plus **true 3-way merges** — not a hardcoded path list. Run it from inside the target (apps) repo. It adds this template as a git remote, fetches, and decides each file's fate by comparing content. Project code (`apps/`/`libs/`/`scripts/`) is excluded, so app wiring (glob-discovered) is untouched. Nothing is committed automatically.

**Added files:**
- `scripts/sync-devcontainer.sh` — usage: `scripts/sync-devcontainer.sh [<template-url-or-path>] [--branch main] [--no-merge] [--dry-run] [--yes]`. The URL is optional once `.template-ref` records one.

**Changed files:**
- `init-new-project.sh` — now captures the template commit SHA + URL **before** wiping git history and writes them to `.template-ref` in the new project, so downstream syncs have a baseline for 3-way merges.

**How classification works (per template-managed file):**
- **identical** (your file == template's current) → nothing to do.
- **new** (template added a file you lack) → add it.
- **pristine/stale** (your file matches *some past* template version, i.e. never hand-edited) → replace wholesale, automatically.
- **modified** (matches *no* template version, i.e. you customized it) → if a baseline is known, run `git merge-file` for a real 3-way merge (clean merges are staged; conflicts get standard markers for manual resolution); with no baseline, fall back to a diff + `keep/take/skip` prompt. Nothing is overwritten without confirmation.
- **Deletions** the template made are auto-detected: a tracked file that was template-managed but is gone from the template, and still matches a historical template version, is pruned (pristine); if you'd modified it, you're asked. `PRUNE_PATHS` is an explicit safety list (prefilled with the OpenCode artifacts).
- After a successful run, `.template-ref` is restamped to the new template commit so the next sync merges against the right baseline.

**Never synced:** `openspec/changes/` + `openspec/specs/` (your project's spec content), `apps/`/`libs/`/`scripts/*` project code (except the sync script), `graphify-out/`, `bun.lock`, `CHANGES.md`, `init-new-project.sh`, `init-host.sh`, `.template-ref`. `openspec/config.yaml` *is* synced but, being customized, goes through the merge/review path rather than wholesale replace.

## 2026-06-01 — Remove: OpenCode and oh-my-opencode (installation + all references)

**What changed:** OpenCode is no longer a provider this template ships. Its installers, committed config, devcontainer wiring, dependency, and docs are all removed. Historical CHANGES.md entries mentioning OpenCode are intentionally left intact — they remain accurate history.

**Removed files:**
- `.devcontainer/on-create/setup-opencode.sh` and `.devcontainer/on-create/setup-oh-my-opencode.sh` (installer scripts).
- `.opencode/` (committed config dir: `command/`, `commands/`, `plugins/graphify.js`, `skills/`, `opencode.json`, `oh-my-opencode.jsonc`, plus its `package.json`/`bun.lock`/`node_modules`).
- `opencode.jsonc` (repo-root OpenCode config).

**Edited:**
- `.devcontainer/on-create.sh` — drop the two `optional …setup-opencode.sh`/`setup-oh-my-opencode.sh` calls; remove "opencode" from the install-ordering comments and the sourced-script `set -e` warning comment.
- `.devcontainer/devcontainer.json` — remove the `${localEnv:HOME}/.local/share/opencode → /mnt/opencode-mount` bind mount; change `OCTO_ALLOWED_PROVIDERS` from `"claude codex gemini opencode"` to `"claude codex gemini"`.
- `.devcontainer/on-create/setup-claude-octopus.sh` — delete the "OpenCode (skills only, via symlink)" block; reword the canonical-clone and shared-skills-symlink comments to drop OpenCode.
- `.devcontainer/on-create/setup-graphify.sh` — drop the `.opencode/plugins/graphify.js` example from the committed-files comment.
- `.devcontainer/on-create/setup-openspec.sh` — `openspec init --tools` now `claude,codex,cursor` (was `…,opencode`).
- `.devcontainer/secrets.example` — `OPENAI_API_KEY` comment now references the Codex CLI instead of the "Opencode Codex auth plugin".
- `.devcontainer/AUTH-PERSISTENCE.md` — "this repo allows" line now lists three CLIs (`claude codex gemini`). The separate list of provider names Octopus *recognizes* is left unchanged (it documents Octopus's capabilities, not our install).
- `init-host.sh` — remove `mkdir -p "$HOME/.local/share/opencode"`.
- `.gitignore` — remove `**/opencode/auth.json`.
- `package.json` — remove `opencode-ai` from both the workspace `catalog` and `devDependencies`; `bun install` refreshes `bun.lock` (1 package removed).
- `README.md` — remove the `mkdir -p ~/.local/share/opencode` step, the "Authenticate Opencode" auth step (remaining auth steps renumbered), the Opencode + oh-my-opencode entries in the AI Tools list, and the OpenCode mention in the Context7 MCP line.
- `AGENTS.md` — drop "Opencode" from the AI-coding-tools list.

**How to adopt downstream:** delete the files listed above, apply the edits, run `bun install` to drop `opencode-ai` from the lockfile, and rebuild the container — `on-create` no longer attempts the OpenCode install.

**Verification:**
```bash
grep -rni opencode . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=graphify-out \
  --exclude=bun.lock --exclude=build-log.log --exclude=CHANGES.md
# only .devcontainer/AUTH-PERSISTENCE.md (Octopus-recognized provider list) should match
bun -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'   # package.json still valid
```

---

## 2026-05-28 — Fix: make Warp ACP detection persist across rebuilds (host-captured env, not `${localEnv:...}` forwarding)

**What broke:** The Warp ↔ Claude Code integration added on 2026-05-27 forwarded three host signals (`TERM_PROGRAM`, `WARP_CLIENT_VERSION`, `WARP_CLI_AGENT_PROTOCOL_VERSION`) into the container via `remoteEnv` using `${localEnv:...}`. After any rebuild, all three came back **empty** inside the container, so Claude Code fell back to plain ANSI instead of ACP structured output.

**Root cause:** `${localEnv:VAR}` is resolved by whatever process brings the container up — here **DevPod** — against *its own* environment, fresh on every rebuild with no memory. But Warp injects those vars **only into the interactive terminals it spawns**; they are not persistent global host vars. DevPod is frequently launched from a GUI (Dock/Spotlight), whose env never had them (the same pitfall the README documents for secrets). So `localEnv` resolved to empty and nothing was ever persisted inside the container — `remoteEnv` simply recomputed the same empty result each rebuild.

**Fix — capture on the host, source into interactive shells:**

1. **`.devcontainer/host/capture-warp-env.sh`** (new, runs on the **host**): writes whatever `TERM_PROGRAM`/`WARP_*` vars are present to `~/.config/devcontainer/warp-env`, overwriting a key **only when a fresh non-empty value exists**. A value seeded from one Warp-terminal launch therefore survives later GUI-launched rebuilds instead of being clobbered.
2. **`devcontainer.json`** — add `initializeCommand` to run that script before each `devpod up`; **remove** the three dead `${localEnv:WARP_*}` lines from `remoteEnv`; add a `_comment_warp` explaining why forwarding was dropped.
3. **`configs/.shell_common`** (sourced by both `.bashrc` and `.zshrc`) — source `/run/devcontainer-config/warp-env` (the host file via the read-only bind mount) inside `set -a … set +a` so the vars are **exported** and Claude Code, a child of the shell, inherits them. Scoped to interactive shells on purpose — that's the only place Warp detection matters, it needs no rebuild (a new shell picks up refreshed values immediately), and it leaves non-interactive contexts untouched.

**How to adopt downstream:** copy `host/capture-warp-env.sh`, add the `initializeCommand` line, drop any `${localEnv:WARP_*}`/`TERM_PROGRAM` entries from `remoteEnv`, and add the `set -a; source /run/devcontainer-config/warp-env; set +a` guard to `.shell_common` (or your shell rc). **Seed it once by running `devpod up .` from a Warp terminal** — there's no way to obtain Warp's per-terminal vars otherwise.

**Verification:**
```bash
cat ~/.config/devcontainer/warp-env       # on host: three KEY=value lines
# open a NEW interactive shell in the container, then:
env | grep -E 'WARP|TERM_PROGRAM'          # all three non-empty (exported to children)
```

**Caveat:** values refresh only when you next `devpod up` from Warp (which re-runs the host capture); between ups the file holds the last captured versions. Acceptable for a template whose premise is connecting via Warp.

---

## 2026-05-28 — Fix: wrap non-critical on-create installers in optional() so one failure can't abort the chain

**Goal:** Close the last instance of the "sourced script aborts the whole chain" failure class (see the entry below for the volume-permission instance). All `on-create/*.sh` helpers are **sourced** into `on-create.sh`'s `set -e` shell, so any unguarded `return N` or failing command aborts every script after it. The clearest live hazard: `setup-oh-my-opencode.sh` does `return 1` (lines 24/31/36) when opencode is missing or below its min version — and it runs at step 6 of 14, so that `return 1` would skip everything downstream **including `setup-shell.sh`**, which installs the proto-activating `~/.zshrc`. That's the same root failure (no shell setup → `bun`/`proto` missing from PATH → husky `bunx: not found`) reached by a different trigger.

**Change:** An `optional()` helper in `on-create.sh` wraps each non-critical installer:
```bash
optional() {
    source "$1" || echo "⚠️   $(basename "$1") failed; continuing setup without it"
}
```
- **Hard `source` (unchanged):** `setup-proto.sh` (bun/PATH for everything depends on it — must abort on failure) and `setup-shell.sh` (the final step, with nothing downstream to strand; its failure should surface, not be hidden).
- **`optional` (all the rest):** biome, claude, ccstatusline, opencode, oh-my-opencode, openspec, gemini, codex, octopus, warp, graphify, vscode-extensions.

**Bash semantics (verified under bash 5.2, not assumed):** Unguarded `source X` under `set -e` aborts the chain on both a `return 1` and a mid-script failure. `source X || echo` lets the chain continue and fires on an explicit `return N`. A subshell on the left of `||` is **not** the right form — `( source X )` discards X's side effects (PATH/env exports) and suppresses `set -e` inside exactly the same as the plain form, so it buys nothing. Note `source X || …` also disables `set -e` *within* X for that call, so `optional()` reacts to X's final/return status, not a mid-script failure — acceptable for standalone installers; where a specific step must be caught we still guard that command directly (e.g. the octopus `mkdir`/`ln`). Simulated both the `return 1` and unguarded cases to confirm; `bash -n` passes. (Credit: the `optional()` approach came from a sibling template repo that hit the same gap.)

---

## 2026-05-28 — Fix: claim root-owned volumes upfront so on-create can't abort mid-chain

**Symptom:** A build log showed `on-create.sh` exiting status 1 at the Claude Octopus step, so every later script — `setup-claude-warp.sh`, `setup-graphify.sh`, the extension sync, and crucially `setup-shell.sh` — never ran. Since `setup-shell.sh` installs the proto-activating `~/.zshrc` template, the downstream symptom was `bun`/`bunx`/`proto` missing from the interactive shell PATH (a stock Oh My Zsh `~/.zshrc` left in place) and husky `pre-commit` hooks failing with `bunx: not found`.

**Root cause:** Docker named volumes mount **empty as `root:root`** unless the image pre-populated the path (copy-on-first-use seeds the volume with the image dir's ownership). `~/.proto` is pre-created in the Dockerfile and the `base:trixie` image happens to ship `/home/vscode/.config`, but `~/.codex` / `~/.gemini` are neither — so they mount `root:root` and the `vscode` user can't write to them. Two writes then failed: OpenSpec's Codex refresh (`EACCES … mkdir '/home/vscode/.codex/prompts'`, swallowed/non-fatal) and `setup-claude-octopus.sh`'s `ln -s … ~/.codex/claude-octopus` (`Permission denied`). Because `on-create.sh` runs `set -e` and **sources** each helper, that unguarded `ln` failure aborted the whole remaining chain.

**Fix 1 — claim every volume-mounted home dir once, upfront.** A single loop in `on-create.sh`, right after the secrets block and before any tool script runs (order-independent — important because `setup-openspec.sh` writes `~/.codex/prompts` *before* `setup-codex.sh` would run, so a per-script chown there is too late):
```bash
for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config" "$HOME/.proto"; do
    if [ -d "$d" ] && [ "$(stat -c '%U' "$d")" != "$(whoami)" ]; then
        sudo chown -R "$(whoami):$(whoami)" "$d"
    fi
done
```
This also closes a latent `~/.config` gap: nothing claimed it — it worked only by relying on the base image shipping it as `vscode`, which breaks the moment the mount is scoped to an image-unpopulated subdir (e.g. `~/.config/ccstatusline`). `setup-claude.sh` and `setup-proto.sh` keep their own existing claims as harmless belt-and-suspenders.

**Fix 2 — fault tolerance (defense in depth).** The three `mkdir`/`ln -s` calls in `setup-claude-octopus.sh` (`~/.codex`, `~/.opencode`, `~/.agents/skills`) are now `|| echo "⚠️  …"` guarded, so an optional integration step degrades to a warning instead of killing the whole setup under `set -e`. (Same spirit as the existing "sourced scripts use `return`, not `exit`" convention — here it was an external command tripping `set -e`.)

Verified: the claim loop is a no-op on a container where the dirs are already `vscode`-owned; all touched scripts pass `bash -n`.

---

## 2026-05-28 — Feat: ccstatusline auto-installs on rebuild (Claude Code status line)

**Goal:** Keep the Claude Code status line working across container rebuilds. `~/.claude/settings.json` points `statusLine.command` at the bare `ccstatusline` binary, but that binary installs to `~/.bun/bin`, which is **not** volume-mounted — so every rebuild wipes it and Claude Code warns that the status line command failed.

**New `setup-ccstatusline.sh` on-create script:**
- Installs the binary on every rebuild with `bun add -g ccstatusline` (guarded by a `command -v ccstatusline` check so re-runs are idempotent). `~/.bun/bin` is already on PATH via `setup_proto_env`, same as graphify's `~/.local/bin`.
- Seeds `~/.config/ccstatusline/settings.json` from the committed `.ccstatusline-settings.bak` **only when the config is missing**, so a fresh `~/.config` volume gets the intended status line (model · context · git branch · git changes) without manual reconfiguration. An existing config is never clobbered. (`~/.config` *is* volume-mounted, so the config normally persists on its own — this is just the fresh-volume fallback.)

**Wired into `on-create.sh`** immediately after `setup-claude.sh` (it backs the `statusLine` command in `~/.claude/settings.json`). Verified: first run installs `ccstatusline@2.2.19` and seeds the config identical to the backup; second run no-ops on both the binary and the config.

---

## 2026-05-28 — Fix: Graphify install survives Python 3.14 (clang→gcc) + stop tracking per-container pointers

**Goal:** Keep the on-rebuild Graphify auto-install working on the proto-managed Python 3.14 toolchain, and stop committing per-container pointer files.

**1. Compiler fallback in `setup-graphify.sh` (clang → gcc/g++):**
`graphifyy` (0.8.22) depends on `tree-sitter-dm` (0.25.1), which ships no prebuilt wheel for proto's Python 3.14 on this arch, so `uv tool install` compiles it from source. Python 3.14's `sysconfig` hardcodes **clang/clang++** for `CC`, `CXX`, `LDSHARED`, and `LDCXXSHARED`, but the devcontainer image ships only **gcc/g++** — so the build fails with `error: command 'clang' failed: No such file or directory`. Before installing, when `clang` is absent and `gcc` is present, export the overrides:
```bash
export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"
export LDSHARED="${LDSHARED:-gcc -shared}"
export LDCXXSHARED="${LDCXXSHARED:-g++ -shared}"
```
Overriding `CC`/`CXX` alone is insufficient — the *link* step (`LDSHARED`/`LDCXXSHARED`) independently hardcodes clang and must be redirected too. Verified by reproducing the failure and confirming the fix yields a working `graphify 0.8.22`.

**2. Stop tracking per-container pointer/lock files (`.gitignore`):**
```
graphify-out/.graphify_root
graphify-out/.graphify_python
graphify-out/.rebuild.lock
```
`.graphify_root` (repo root) and `.graphify_python` (absolute path to the uv-tools Python) are regenerated per container and are meaningless — or wrong — in another container, so they shouldn't be committed. If already tracked, untrack once with `git rm --cached graphify-out/.graphify_root graphify-out/.graphify_python`.

---

## 2026-05-28 — Feature: AUTH-PERSISTENCE.md guide + Octopus provider allowlist

**Goal:** Document how auth/secrets persist (a living reference for adding credentialed tools), and add an explicit, repo-scoped allowlist for which providers Claude Octopus may use.

**1. `.devcontainer/AUTH-PERSISTENCE.md`:**
A reference doc covering the two persistence mechanisms — API keys via the two-tier host secrets files vs. device/OAuth logins on `${devcontainerId}`-keyed named volumes — the "pick one per tool per project" rule (an API-key env var shadows a device login), a table of what each volume persists today, per-tool login steps, and how to replicate the setup in another repo. Read it before wiring up a new credentialed CLI.

**2. Provider allowlist (`.devcontainer/devcontainer.json` → `containerEnv`):**
```jsonc
"OCTO_ALLOWED_PROVIDERS": "claude codex gemini opencode"
```
Claude Octopus (octo plugin) reads `OCTO_ALLOWED_PROVIDERS` at runtime via its `provider-allowlist.sh` lib: a space/comma-separated list where **unset = all detected providers allowed**, and any provider omitted from a non-empty list is treated as unavailable **even if installed**. Set it to the four CLIs this template installs. `claude` must stay in the list (it's the orchestrator). No setup-script change is needed — the env var alone gates `check-providers.sh` and fleet construction. It's non-secret and repo-specific, so it lives in version control, not the host secrets file. Recognized names: `codex gemini opencode copilot qwen ollama openrouter perplexity` + `claude` (aliases: `claude`/`anthropic`/`sonnet`, `codex`/`openai`, `gemini`/`google`, `local`→`ollama`).

---

## 2026-05-28 — Feature: Persist ~/.config tool configs across rebuilds, isolated per repo

**Goal:** Keep CLI/tool configuration under `~/.config` (e.g. `ccstatusline/settings.json`) alive across devcontainer rebuilds, scoped per-project, without committing it to the repo.

**1. Named volume over `~/.config` (`.devcontainer/devcontainer.json` → `mounts`):**
```jsonc
"source=config-home-${devcontainerId},target=/home/vscode/.config,type=volume",
```
`${devcontainerId}` scopes the volume per devcontainer, so each project gets its own isolated config store that survives rebuilds (a rebuild keeps the same id). A **named volume** (not a host bind mount) is the right tool here because of Docker's copy-on-first-use: when an empty named volume is first mounted onto a path the image already populated, Docker copies that image content into the volume; a bind mount would instead *shadow* the path and hide it. Targeting all of `~/.config` (rather than one subdir) means every tool writing under `~/.config/*` persists automatically — broad by design. To scope tighter, target a single subdir instead, e.g. `target=/home/vscode/.config/ccstatusline`.

**2. Seed once before the first rebuild (critical):**
Copy-on-first-use copies from the **image**, not from files written at runtime. A config you created interactively lives in the container's writable layer, so the new empty volume shadows it and it's lost on the rebuild that introduces the mount. Relay it through the bind-mounted workspace:
```bash
# Before rebuild (current container):
cp ~/.config/ccstatusline/settings.json /workspace/.ccstatusline-settings.bak
# After rebuild (volume now active):
mkdir -p ~/.config/ccstatusline
cp /workspace/.ccstatusline-settings.bak ~/.config/ccstatusline/settings.json
rm /workspace/.ccstatusline-settings.bak
```
Only needed for configs **not** regenerated by an on-create script. In this template, `~/.config/{proto,rtk,opencode,openspec,moon}` are rewritten on every rebuild, so they need no seeding — `ccstatusline` is the one that does. After this one-time seed the volume persists across all future rebuilds.

**3. Keep the relay file out of git (`.gitignore`):**
```
.ccstatusline-settings.bak
```

**Gotchas:**
- **Rebuild vs. recreate:** the volume survives rebuilds but is keyed to `${devcontainerId}`; a full delete-and-recreate generates a new id and drops the volume (same as any `*-${devcontainerId}` volume).
- **No host-side editing:** the config lives inside the Docker volume, not on the host — edit it from inside the container.
- **No overlapping mounts:** confirm no other mount targets a path under `~/.config`. The existing tool-home volumes sit at `~/.claude`, `~/.codex`, `~/.gemini`, `~/.proto` (not under `~/.config`), so there's no conflict.

**Alternative (host-durable + editable):** a bind mount survives even a full recreate and is editable from the host, but does *not* copy-on-first-use (it shadows) and the host dir must exist first: `"source=${localEnv:HOME}/.config/ccstatusline,target=/home/vscode/.config/ccstatusline,type=bind,consistency=cached"`.

---

## 2026-05-28 — Feature: Persist AI CLI logins across rebuilds, isolated per repo

**Goal:** Make Claude Code, Codex, and Gemini CLI logins survive container rebuilds, while keeping multiple project repos isolated — each repo gets its own accounts/keys with no cross-repo collisions.

**1. Named-volume mounts keyed by `${devcontainerId}` (`.devcontainer/devcontainer.json` → `mounts`):**
Each AI CLI's home dir is backed by a Docker named volume whose name embeds `${devcontainerId}` (automatically unique per repo, so logins never collide):
```jsonc
"source=claude-code-config-${devcontainerId},target=/home/vscode/.claude,type=volume",  // pre-existing
"source=codex-home-${devcontainerId},target=/home/vscode/.codex,type=volume",           // added
"source=gemini-home-${devcontainerId},target=/home/vscode/.gemini,type=volume",          // added
```
`~/.claude` was already volume-backed; only `~/.codex` and `~/.gemini` needed adding. Verify each CLI's actual home dir before mounting — Codex defaults to `~/.codex` (`CODEX_HOME`, holds `config.toml` + `auth.json`), Gemini to `~/.gemini` (holds `oauth_creds.json`), Claude to `~/.claude` (`CLAUDE_CONFIG_DIR`). Do **not** bind-mount to a literal host path (e.g. `~/.codex`): that shares one login across every repo, defeating isolation. The `${devcontainerId}` form gives each repo its own volume.

**2. Unique `DEVCONTAINER_PROJECT` slug (`.devcontainer/devcontainer.json` → `containerEnv`):**
Set `DEVCONTAINER_PROJECT` to a distinct lowercase slug per repo (here: `devenv`, was the placeholder `my-project`). This is the namespace handle for per-project secrets (`~/.config/devcontainer/secrets.d/<slug>` on the host). Two repos sharing a slug would share per-project keys.

**3. API key vs device login — pick one per tool per project:**
The two-tier secrets loader writes any keys from the host secret files into `/etc/environment`, so a present `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` **shadows** the corresponding CLI's device login. Choose one method per tool per project. Note Graphify's semantic extraction also reads those same Gemini/OpenAI keys, so a key set for Graphify will shadow a Gemini CLI device login.

**One-time logins (after rebuild):**
```bash
claude         # /login (or use an API key)
codex login    # device/OAuth — omit OPENAI_API_KEY to let this win
gemini         # /auth → Google login — omit GEMINI_API_KEY/GOOGLE_API_KEY to let this win
```
These now persist on the per-repo volumes; subsequent rebuilds skip re-login.

---

## 2026-05-27 — Feature: Warp integration (ACP detection signals + Claude Code Warp plugin) + trust workspace for Gemini CLI

**Goal:** Integrate the Warp terminal with the devcontainer on two fronts — let Claude Code detect Warp and open its structured-output channel (ACP), and auto-install Warp's official Claude Code plugin — and separately silence Gemini CLI's workspace-trust prompt inside the container.

**1. Forward Warp ACP detection signals (`.devcontainer/devcontainer.json` → `remoteEnv`):**
Forward three host vars from Warp into the container, each as `${localEnv:NAME}`:
- `WARP_CLI_AGENT_PROTOCOL_VERSION` — Warp's Agent Client Protocol version
- `WARP_CLIENT_VERSION` — Warp app version
- `TERM_PROGRAM` — `WarpTerminal` when launched from Warp

When all three are present, Claude Code detects it's running under Warp and opens a structured-output channel (ACP) instead of plain ANSI. The host sets these automatically when a terminal is spawned from Warp; without `remoteEnv` forwarding they're lost at the container boundary and Claude Code falls back to plain text.

**2. Auto-install the Claude Code Warp plugin:**
Add `.devcontainer/on-create/setup-claude-warp.sh`, which installs [claude-code-warp](https://github.com/warpdotdev/claude-code-warp) (Warp's official plugin) so its commands/skills are available without manual `/plugin marketplace add` + `/plugin install`. The script:
- Runs `claude plugin marketplace add warpdotdev/claude-code-warp` then `claude plugin install warp@claude-code-warp`.
- Skips if `~/.claude/plugins/cache/claude-code-warp/warp` already exists (the `~/.claude` volume persists this across rebuilds, so the install runs once per fresh volume).
- Gracefully no-ops if the `claude` CLI is not on PATH.

Source it in `.devcontainer/on-create.sh` **after** `setup-claude.sh` so the `claude` CLI is available.

**3. Trust the workspace for Gemini CLI (`.devcontainer/devcontainer.json` → `containerEnv`):**
Add `GEMINI_CLI_TRUST_WORKSPACE=true`. Suppresses the interactive "Do you trust the workspace?" prompt Gemini CLI shows on first run inside the mounted `/workspace`. Safe in a devcontainer because the workspace is the user's own bind-mounted code.

**Verification (after rebuild):**
```bash
echo "$TERM_PROGRAM $WARP_CLIENT_VERSION $WARP_CLI_AGENT_PROTOCOL_VERSION"
# → e.g. "WarpTerminal 0.2025.xx.xx.xx 0.1.0" when launched from Warp
echo "$GEMINI_CLI_TRUST_WORKSPACE"                 # → true
ls ~/.claude/plugins/cache/claude-code-warp/warp   # plugin payload present
```
If `TERM_PROGRAM` is empty inside the container, the terminal wasn't launched from Warp (or the host lacks the var) — Claude Code just uses plain ANSI, which is harmless.

---

## 2026-05-27 — Feature: auto-install Graphify (project-scoped) + commit the initial knowledge graph

**Goal:** Install [graphify](https://github.com/safishamsi/graphify) — a knowledge-graph builder for code/docs that AI assistants query instead of grepping raw files — register it at **project scope** with Claude Code, Codex CLI, OpenCode, and Gemini CLI, and commit an initial graph so fresh clones and `git worktree`s inherit a working setup without rebuilding (a rebuild costs Gemini API credits on every fresh checkout).

**Why project-scope (not user-scope like the octopus/warp installs):** Graphify ships a `--project` flag that writes skill files and PreToolUse hooks into the project directory. Committing those files means (1) git worktrees inherit them via the tracked tree — user-scoped installs run from `on-create.sh`, which doesn't fire on worktree creation; and (2) container rebuilds don't regenerate them, so the working tree stays clean.

**How to implement:**

1. **Add `uv` to `.prototools`** (graphify's recommended install method; the [Phault/proto-toml-plugins](https://github.com/Phault/proto-toml-plugins) repo already used for `fly`/`infisical`/`dagger` ships a maintained `uv` plugin):
   ```toml
   uv = "0.11.16"
   # ...
   [plugins]
   uv = "https://raw.githubusercontent.com/Phault/proto-toml-plugins/main/uv/plugin.toml"
   ```

2. **Add `.devcontainer/on-create/setup-graphify.sh`** that installs the CLI **with the `[gemini]` extra**, idempotently (skip if `graphify` is already on PATH):
   ```bash
   uv tool install 'graphifyy[gemini]'
   ```
   The `[gemini]` extra is **required**, not optional: graphify prefers Gemini for semantic extraction whenever `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set (this devcontainer provides them via the host-mounted secrets file), but talks to Gemini through the **OpenAI SDK**. The base `graphifyy` package omits `openai`, so plain `uv tool install graphifyy` fails at the extraction step with `… requires the openai package`. The extra adds ~3MB (openai SDK + httpx). If your secrets profile sets `OPENAI_API_KEY` instead, the same `[gemini]` extra covers that code path too. The script does **not** run `graphify install --project` — those files are committed (step 4).

3. **Source it in `.devcontainer/on-create.sh`** after `setup-proto.sh`, so `uv` is on PATH first.

4. **One-time, in a fresh clone of the template:** run the project-scoped installer for each platform, then commit the generated files:
   ```bash
   graphify install --project
   graphify install --project --platform codex
   graphify install --project --platform opencode
   graphify install --project --platform gemini
   ```
   This produces:
   - `.claude/skills/graphify/`, `.claude/CLAUDE.md` (graphify section), `.claude/settings.json` (PreToolUse hook)
   - `.agents/skills/graphify/` (Codex skill), `.codex/hooks.json` (PreToolUse hook — references the absolute path `/home/vscode/.local/bin/graphify`, fine in this devcontainer where the user is always `vscode`)
   - `.opencode/skills/graphify/`, `.opencode/plugins/graphify.js`, `.opencode/opencode.json`
   - `.gemini/skills/graphify/`, `.gemini/settings.json` (BeforeTool hook)
   - `## graphify` sections appended to the top-level `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`

5. **Exclude graphify's generated output from Biome.** The lint-staged pre-commit hook runs `biome check --write` on staged files; graphify's `graph.html` trips lint rules (unused functions, value-returning `forEach` callbacks) and `cache/*.json` gets reformatted on `--write`, mutating graphify's own output. Add a single exclude to the existing `files.includes` array in **`biome.jsonc`**:
   ```jsonc
   "includes": ["**", "!graphify-out/**"]
   ```
   **Two gotchas, both learned the hard way here:**
   - **Do not create a separate `biome.json` for this.** Biome's config discovery prefers `.json` over `.jsonc` in the same directory, so a stray `biome.json` silently shadows `biome.jsonc` — all its linter overrides, VCS integration, and other excludes are ignored with no warning or error. Audit which file is active with `bunx biome rage | grep Path:`.
   - **Use a single `!` to exclude.** `!!pattern` is Biome v2's *re-include* operator, so `!!graphify-out/**` on top of `**` is a no-op.

6. **`.gitignore` the per-user output files** (per the [graphify README](https://github.com/safishamsi/graphify#what-files-it-handles)) — everything else in `graphify-out/` is intentionally committable so the graph is shared across the team:
   ```
   graphify-out/manifest.json   # per-machine file hashes (diff on every machine)
   graphify-out/cost.json       # local API spend tracker
   ```

7. **Build and commit the initial graph:** run `/graphify .` (or `graphify build .`), then commit the shareable artifacts:
   - `graph.json` (~196 KB) — the structured graph used by `graphify query`
   - `graph.html` (~224 KB) — interactive visualization (open in a browser)
   - `GRAPH_REPORT.md` (~8 KB) — human-readable architecture summary
   - `cache/` — semantic-extraction cache, reused on incremental updates
   - `.graphify_labels.json` (community labels), `.graphify_root`, `.graphify_python` (pointer files)

   **Caveat:** `.graphify_root` (`/workspace`) and `.graphify_python` (`…/uv/tools/graphifyy/bin/python`) are absolute paths matching this devcontainer's layout. A downstream repo with a different path or a non-`uv` install should **not** copy ours — delete `graphify-out/` and regenerate with `/graphify .`.

**Verification (after rebuild):**
```bash
graphify --version                                  # 0.8.21+
ls .claude/skills/graphify .agents/skills/graphify  # skill files present
grep -A1 PreToolUse .claude/settings.json           # hook registered
bunx biome rage | grep Path:                        # → biome.jsonc (NOT biome.json)
bunx biome check graphify-out/graph.html            # → "These paths were provided but ignored"
graphify query "where is bun configured" | head -30 # returns a scoped subgraph
```
Then type `/graphify .` in any assistant to build the graph and `graphify query "<question>"` to consult it. The PreToolUse hooks nudge the assistant toward the graph automatically once `graphify-out/graph.json` exists.

**Trade-offs / notes for downstream:**
- The Codex hook bakes in the absolute path `/home/vscode/.local/bin/graphify`. If you change the devcontainer user, regenerate `.codex/hooks.json` with `graphify install --project --platform codex`.
- No other graphify extras (`pdf`, `office`, `video`) are installed by default — add per-project with `uv tool install --with "graphifyy[pdf]" graphifyy`.
- Building the graph is user-initiated and per-worktree: worktrees inherit the configuration but each builds its own graph.

---

## 2026-05-27 — Feature: auto-install Claude Octopus during devcontainer setup

**Goal:** Install [claude-octopus](https://github.com/nyldn/claude-octopus) — a multi-LLM orchestration layer with `/octo:*` commands and 50+ skills — automatically when the devcontainer is created, so it's available across Claude Code, Codex CLI, and OpenCode without manual setup steps.

**How to implement:**
1. Add `.devcontainer/on-create/setup-claude-octopus.sh`. The script:
   - Clones `nyldn/claude-octopus` once to `~/.local/share/claude-octopus` (canonical location, shared by all CLIs via symlinks — avoids cloning the repo three times per rebuild).
   - For **Claude Code**: runs `claude plugin marketplace add https://github.com/nyldn/plugins.git` then `claude plugin install octo@nyldn-plugins`. Skipped if `~/.claude/plugins/cache/nyldn-plugins/octo` already exists (the `~/.claude` volume persists this across rebuilds).
   - For **Codex CLI**: symlinks `~/.codex/claude-octopus` → canonical clone (only if `codex` is on PATH).
   - For **OpenCode**: symlinks `~/.opencode/claude-octopus` → canonical clone (only if `opencode` is on PATH).
   - Creates the shared skill-discovery symlink `~/.agents/skills/claude-octopus` → `<canonical>/skills` (this is the path both Codex and OpenCode read for skill files; the README shows them creating it independently, but they can share one symlink safely).
   - All steps are idempotent — re-running the script does nothing if everything is already in place.
2. In `.devcontainer/on-create.sh`, source the new script **after** `setup-claude.sh`, `setup-opencode.sh`, and `setup-codex.sh` — the script needs those CLIs on PATH to detect them and install the Claude Code plugin.

**Verification (after rebuild):**
```bash
ls -l ~/.codex/claude-octopus ~/.opencode/claude-octopus ~/.agents/skills/claude-octopus   # all symlinks resolved
ls ~/.local/share/claude-octopus/skills | head                                              # shows skill dirs
ls ~/.claude/plugins/cache/nyldn-plugins/octo                                               # contains version dir
```

Inside Claude Code, run `/octo:setup` to walk through provider configuration (one-time, interactive).

---

## 2026-05-13 — Fix: devcontainer on-create reliability (RTK, claude-mem, oh-my-opencode, sourced-script `exit`)

**Goal:** Several independent on-create failures were silently degrading the devcontainer: the RTK token-compression hook was never patched into `~/.claude/settings.json`; the `claude-mem` plugin's first-run SessionStart hook failed; the oh-my-opencode plugin was never registered in `opencode.json`; and sourced helper scripts used `exit` (which killed the parent `on-create.sh`, preventing later scripts like `setup-shell.sh` from running).

**Root causes:**
1. **RTK:** `rtk init -g` detects non-interactive shell mode (on-create runs without a TTY) and defaults to "N" at the "Patch existing settings.json?" prompt, then exits without writing the hook config. RTK ships an `--auto-patch` flag for exactly this scenario.
2. **claude-mem:** The plugin's SessionStart hook runs `bun install` on a manifest of `tree-sitter-*` packages whose post-install scripts shell out to `node-gyp`. The devcontainer's node feature is configured with `nodeGypDependencies: false`, and npm's bundled node-gyp isn't symlinked onto `$PATH` — so the spawn fails with ENOENT and the hook exits non-zero. (The packages themselves work at runtime via shipped prebuilds; only the install-script step fails.)
3. **oh-my-opencode:** Upstream installer's version comparison is lexicographic — `"1.14.48"` compares as less than `"1.4.0"` because `'1' < '4'` at the second segment. The installer prints `Detected OpenCode 1.x.x, but 1.4.0+ is required` and aborts before writing `opencode.json`, even on currently-released opencode versions.
4. **Sourced-script `exit`:** Helper scripts sourced by `on-create.sh` used `exit N` for early termination, which kills the parent shell instead of returning from the helper — silently preventing later scripts (notably `setup-shell.sh`) from running.

**How to implement:**
1. In `.devcontainer/on-create/setup-claude.sh`, after `setup_proto_env`, install `node-gyp` globally if missing:
   ```bash
   if command -v npm &> /dev/null && ! command -v node-gyp &> /dev/null; then
       npm install -g node-gyp >/dev/null 2>&1 || \
           echo "⚠️   Could not install node-gyp; some Claude Code plugins may fail their first install"
   fi
   ```
   npm is already on `$PATH` from the devcontainer node feature and ships `node-gyp` as a bundled dep, so `npm i -g node-gyp` just creates the bin symlink.
2. In `.devcontainer/on-create/setup-claude.sh`, change `rtk init -g` to `rtk init -g --auto-patch` so the hook config is patched into `~/.claude/settings.json` non-interactively (also creates `~/.claude/settings.json.bak`).
3. In `.devcontainer/on-create/setup-oh-my-opencode.sh`, replace the `bunx oh-my-opencode install …` block (and its 3-retry verification loop) with: (a) `bun install -g oh-my-opencode` if not already globally installed, (b) write `~/.config/opencode/opencode.json` directly with `{"$schema":"https://opencode.ai/config.json","plugin":["oh-my-openagent"]}`. This bypasses the broken upstream version check. The plugin is dual-published as `oh-my-opencode` (legacy npm name) and `oh-my-openagent` (new name accepted by opencode without a warning).
4. Replace every `exit N` with `return N` in the sourced helpers — `setup-vscode-extensions.sh` (3 occurrences) and `setup-oh-my-opencode.sh` (3 occurrences) — and add a convention comment at the top of `on-create.sh` documenting that sourced helpers must use `return`, not `exit`. Audit with `grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh` (should return empty).
5. **One-off cleanup (per devcontainer):** if a previous run left `/workspace/.codex` as a 0-byte regular file instead of a directory (visible as `ENOTDIR` from `openspec init`), run once: `chmod u+w /workspace/.codex && rm /workspace/.codex`. Not applicable if `.codex/` is already a directory (which it is in this repo). No script changes needed — this is a workspace-data issue, not a setup-script bug.

**Verification (after rebuild):**
```bash
command -v node-gyp                                          # /usr/local/share/nvm/.../bin/node-gyp
grep -A 5 PreToolUse ~/.claude/settings.json                 # shows rtk hook claude
cat ~/.config/opencode/opencode.json                         # has plugin: ["oh-my-openagent"]
test -d /workspace/.codex && echo ok || echo "still bad"     # ok
grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh   # empty
```

---

## 2026-04-14 — Add Gemini CLI and Codex CLI to devcontainer

**Goal:** Include Gemini CLI and OpenAI Codex CLI as additional AI coding tools in the devcontainer.

**How to implement:**
1. Create `.devcontainer/on-create/setup-gemini.sh` — installs `@google/gemini-cli` globally via bun with an idempotency check.
2. Create `.devcontainer/on-create/setup-codex.sh` — installs `@openai/codex` globally via bun with an idempotency check.
3. In `.devcontainer/on-create.sh`, source both scripts (they're already wired in from the setup-shell.sh reordering).
4. In `README.md`, add authentication instructions for both tools (Gemini: Google account or `GEMINI_API_KEY`; Codex: `OPENAI_API_KEY`) and list them in the AI Tools section.

---

## 2026-04-14 — Pre-commit hook to enforce changelog updates

**Goal:** Automatically block significant commits that don't include a CHANGES.md update, so the changelog never falls behind.

**How to implement:**
1. In `.claude/settings.json`, add a `PreToolUse` hook with matcher `Bash(git commit*)`:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash(git commit*)",
           "hooks": [
             {
               "type": "command",
               "command": "bash -c '...check CHANGES.md is staged...'"
             }
           ]
         }
       ]
     }
   }
   ```
2. The hook extracts the conventional commit type (`feat:`, `fix:`, etc.) from `$TOOL_INPUT` and skips the check for minor types (`docs`, `chore`, `style`, `ci`, `test`).
3. For significant types (`feat`, `fix`, `refactor`, `perf`, `build`), it verifies `CHANGES.md` is in the staged files via `git diff --cached --name-only`. If missing, it exits with code 2 (block + message).

---

## 2026-04-14 — Run setup-shell.sh last in on-create.sh

**Goal:** Prevent tool installers from overwriting custom shell config during container setup.

**How to implement:**
1. In `.devcontainer/on-create.sh`, move the `source /workspace/.devcontainer/on-create/setup-shell.sh` line from early in the script (after `setup-proto.sh`) to the very end, after all other installer scripts and `setup-vscode-extensions.sh`.
2. Add a comment explaining why it must run last: tool installers (e.g. bun via proto) overwrite `~/.zshrc`, so our shell config must be written after all of them finish.

**Why:** Bun's installer (and potentially others) overwrites `~/.zshrc` during setup. When `setup-shell.sh` ran early, later installers would clobber the custom shell config, breaking devpod SSH auto-cd, aliases, PATH, and completions.

---

## 2026-04-08 — Add a shared commit policy in AGENTS.md (all agents)

**Goal:** Every AI agent (Claude Code, Cursor, Opencode) should always commit and push after each significant change without waiting for user confirmation — and follow the *same* policy, not a Claude-only copy.

**How to implement:**
1. Add a "Commit Policy" section to `AGENTS.md` (the shared-conventions file all agents consume):
   ```markdown
   ## Commit Policy
   ALWAYS commit and push after completing each significant change. Do NOT wait for the user to ask. Before committing, update `/workspace/CHANGES.md` with a dated entry (Goal + How to implement).
   ```
2. In `CLAUDE.md`, reference `@AGENTS.md` for shared conventions rather than duplicating the policy. (The policy was first added directly to `CLAUDE.md`, then moved into `AGENTS.md` the same day so all agents inherit one copy.)

---

## 2026-03-23 — Add OpenSpec skills/commands and improve Claude Code setup

**Goal:** Provide OpenSpec workflow skills (explore, propose, apply, archive) as slash commands for Claude Code and Codex. Also fix a stale-binary issue in the Claude Code setup script.

**How to implement:**
1. Create OpenSpec skill definitions under `.claude/skills/` and `.codex/skills/` for four workflows: `openspec-apply-change`, `openspec-archive-change`, `openspec-explore`, and `openspec-propose`.
2. Create corresponding slash commands under `.claude/commands/opsx/` (`apply.md`, `archive.md`, `explore.md`, `propose.md`).
3. In `.devcontainer/on-create/setup-claude.sh`, add a step to remove any stale bun-installed `claude-code` binary before installing the native binary, and use an explicit path check (`[ -f ~/.local/bin/claude ]`) instead of `command -v`.

---

## 2026-03-21 — Allow CI test step to pass with no tests

**Goal:** The template ships with no test files, so `bun test` fails and breaks CI. Let CI stay green until downstream projects add their own tests.

**How to implement:**
1. In `.github/workflows/ci.yml`, add `continue-on-error: true` to the test step:
   ```yaml
   - run: bun test
     continue-on-error: true
   ```

---

## 2026-04-08 — Devcontainer upgrades: Trixie, RTK, zsh default shell, SSH workspace dir, disable Moby

**Goal:** Modernize the devcontainer base image, add token compression tooling, fix SSH shell defaults, and switch from Moby to Docker CE.

**How to implement:**
1. **Upgrade base image to Debian 13 (Trixie):** In `.devcontainer/Dockerfile`, change base image tag from `bookworm` to `trixie`. Brings GLIBC 2.41, OpenSSL 3.4+, GCC 14.
2. **Add RTK (token compression):** In `Dockerfile`, add a new `RUN` step after git-delta:
   ```dockerfile
   RUN ARCH=$(uname -m) \
       && wget -q "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${ARCH}-unknown-linux-gnu.tar.gz" -O /tmp/rtk.tar.gz \
       && tar xzf /tmp/rtk.tar.gz -C /usr/local/bin/ \
       && chmod +x /usr/local/bin/rtk \
       && rm /tmp/rtk.tar.gz
   ```
   In `.devcontainer/on-create/setup-claude.sh`, add RTK hook initialization:
   ```bash
   if command -v rtk &> /dev/null; then
       rtk init -g
   fi
   ```
   RTK requires GLIBC 2.39+, which is why the Trixie upgrade is a prerequisite. Saves 60-90% tokens on Claude Code bash output.
3. **Set zsh as default login shell for SSH:** In `Dockerfile`, add before `USER vscode`:
   ```dockerfile
   RUN chsh -s /usr/bin/zsh vscode
   ```
   In `devcontainer.json`, flip: `"configureZshAsDefaultShell": true`. SSH reads `/etc/passwd` (ignoring env vars), which `chsh` fixes.
4. **SSH starts in /workspace:** In `.devcontainer/configs/.shell_common`, add before PATH exports:
   ```bash
   [[ "$PWD" == "$HOME" ]] && cd /workspace
   ```
   Only fires when the shell opens in `$HOME` (the SSH default).
5. **Disable Moby:** In `devcontainer.json`, update docker-in-docker feature:
   ```json
   "ghcr.io/devcontainers/features/docker-in-docker:2": { "moby": false }
   ```

---

## 2026-03-21 — macOS onboarding: host setup script + README Quick Start & prerequisites

**Goal:** Let a non-technical user go from a bare Mac to a running devcontainer with minimal manual steps — a one-command host bootstrap plus copy-paste README instructions.

**How to implement:**
1. **Host setup script — `init-host.sh`** (repo root). Installs, via Homebrew: Xcode CLT, Docker Desktop, Git, DevPod, the Warp terminal (`brew install --cask warp`, between DevPod and IDE installation), an IDE (Cursor or VS Code, user's choice), GitHub CLI, and SSH keys. Also creates the host directories used for container mounts.
2. **README — "Prerequisites (Host Machine Setup)"** section before "Getting Started", covering: Docker Desktop, Git, DevPod, an IDE, SSH keys, GitHub CLI, and host directory creation. Point Mac users to `init-host.sh` as the one-command path. Remove the now-redundant `mkdir` from the secrets step (covered here).
3. **README — "Quick Start (Mac)"** section at the top: the `curl | bash` one-liner, clone, init, and `devpod up`. Note the repo must be **public** for the `curl` one-liner to work without authentication.
4. **Template cleanup:** add `rm -f init-host.sh` to the template-only file cleanup in `init-new-project.sh` so the host script doesn't carry into downstream projects (see the project-init cleanup entry).

---

## 2026-03-20 — Clean up template-only files during project init

**Goal:** `init-new-project.sh` bootstraps a new project from the template; template-history files and the bootstrap script itself should not survive into the downstream project's tree.

**How to implement (all in `init-new-project.sh`):**
1. In the template-only file cleanup section, remove files that only make sense in the template repo — add `rm -f CHANGES.md` alongside the existing `rm -f bun.lock`. (The macOS onboarding entry also adds `rm -f init-host.sh` here.)
2. Add `rm -f "$0"` just before the `git add .` / initial-commit step so the bootstrap script deletes itself before being committed to the new repo.

---

## 2026-03-20 — Add Claude and Codex to Openspec init

**Goal:** Ensure Openspec generates configuration for all coding agents used in the template, not just Cursor and OpenCode.

**How to implement:**
1. In `.devcontainer/on-create/setup-openspec.sh`, update the `openspec init` command to include `claude` and `codex`:
   ```bash
   openspec init --tools claude,codex,cursor,opencode --force
   ```

---

## 2026-03-20 — Switch Claude Code to native binary installer

**Goal:** Use the official `claude install` native binary instead of the npm package (`bun install -g @anthropic-ai/claude-code`). The native binary is the recommended installation method and doesn't depend on Node/Bun for the CLI itself.

**How to implement:**
1. In `.devcontainer/on-create/setup-claude.sh`, replace `bun install -g @anthropic-ai/claude-code` with:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   The native binary installs to `~/.local/bin/claude`.
2. Add `$HOME/.local/bin` to PATH in `.devcontainer/on-create/setup-common.sh` (inside `setup_proto_env()`).
3. Add `$HOME/.local/bin` to the front of the PATH export in `.devcontainer/configs/.shell_common` so interactive shells find the binary.
4. Remove the `mkdir -p ~/.config/claude-code` line from `setup-claude.sh` — the native binary uses `~/.claude` (already managed by the volume mount).

---

## 2026-03-20 — Add CHANGES.md for template change tracking

**Goal:** Establish a changelog so that projects forked from this template can track and adopt upstream improvements.

**How to implement:**
1. Create a `CHANGES.md` file at the repo root with this structure: a top-level heading, a brief description of purpose, and entries formatted as `## YYYY-MM-DD — Title`.
2. Each entry should include a **Goal** and **How to implement** section with step-by-step instructions for adopting the change in a downstream repo.
3. Update this file before committing and pushing any significant change to the template.

---

## 2026-03-17 — Preserve empty directories with `.gitkeep`

**Goal:** Keep `apps/`, `libs/`, and `scripts/` in version control even when empty, so the monorepo structure is present from the first clone.

**How to implement:**
1. For each empty directory you want to track, add an empty placeholder file:
   ```bash
   touch apps/.gitkeep libs/.gitkeep scripts/.gitkeep
   git add apps/.gitkeep libs/.gitkeep scripts/.gitkeep
   ```
2. Git does not track directories — only files. The `.gitkeep` filename is a convention; the file has no content and no special meaning to git.

---

## 2026-03-16 — On-create idempotency: skip already-installed tools on recreate

**Goal:** Make container rebuilds fast by skipping setup steps that have already run. Without this, opencode (~70s) and oh-my-opencode reinstall on every `devpod up`, and the banner hardcodes a project name.

**How to implement:**
1. In `.devcontainer/on-create/setup-opencode.sh`, wrap the install in a presence check:
   ```bash
   if ! command -v opencode &>/dev/null; then
     # install opencode
   fi
   ```
2. In `.devcontainer/on-create/setup-oh-my-opencode.sh`, check whether the plugin is already configured before running `bunx`:
   ```bash
   if ! opencode config show 2>/dev/null | grep -q "oh-my-opencode"; then
     # install plugin
   fi
   ```
3. In `.devcontainer/devcontainer.json`, ensure `postCreateCommand` and `postStartCommand` include `~/.proto/shims` in `PATH` — this is where proto places tool binaries, not `~/.proto/bin`:
   ```json
   "postCreateCommand": "export PATH=$HOME/.proto/shims:$PATH && bun install"
   ```
4. Replace any hardcoded project name in on-create banners with `$DEVCONTAINER_PROJECT`.

---

## 2026-03-16 — Node.js LTS devcontainer feature (required for Claude Code)

**Goal:** Claude Code (`@anthropic-ai/claude-code`) is a Node.js package. Even when installed via Bun, it requires `node` to be present on `PATH`. Without it, `claude mcp add` fails with `/usr/bin/env: 'node': No such file or directory`.

**How to implement:**
1. In `.devcontainer/devcontainer.json`, add the Node.js LTS feature:
   ```json
   "features": {
     "ghcr.io/devcontainers/features/node:1": {
       "version": "lts"
     }
   }
   ```
2. Rebuild the container. Node will be available at the system level for all processes.

---

## 2026-03-16 — Proto tool caching via persistent Docker volume

**Goal:** Proto re-downloads all tools (bun, node, moon, etc.) on every container recreation, taking ~9 minutes. Mounting `~/.proto` as a named Docker volume makes downloaded binaries persist across rebuilds — first build is normal, subsequent rebuilds are seconds.

**How to implement:**
1. In `.devcontainer/devcontainer.json`, add a named volume mount for `~/.proto` scoped by `devcontainerId` to prevent cross-project collisions:
   ```json
   "mounts": [
     "source=devcontainer-${devcontainerId}-proto,target=/home/vscode/.proto,type=volume"
   ]
   ```
2. Because the Docker volume hides any files baked into the image at that path, you cannot pre-install proto in the Dockerfile and have it persist. Instead, bootstrap proto in `setup-proto.sh`:
   ```bash
   if ! command -v proto &>/dev/null; then
     curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --no-profile
   fi
   proto use  # installs all tools listed in .prototools
   ```
3. Add a `chown` guard in case the volume is first mounted as root:
   ```bash
   if [ "$(stat -c '%U' ~/.proto)" != "vscode" ]; then
     sudo chown -R vscode:vscode ~/.proto
   fi
   ```
4. In the Dockerfile, pre-create `~/.proto` as the `vscode` user so Docker volume inherits correct ownership on first mount:
   ```dockerfile
   USER vscode
   RUN mkdir -p /home/vscode/.proto
   ```
5. **Cross-device link fix:** Do not mount only subdirectories (`~/.proto/tools`, `~/.proto/plugins`) as separate volumes. Proto downloads to `~/.proto/temp/` then renames into `tools/` and `plugins/`. If these are on different filesystems, you get `Invalid cross-device link (os error 18)`. Mounting the entire `~/.proto` as one volume avoids this.

---

## 2026-03-16 — devcontainer hardening: extra CLI tools and scoped volume names

**Goal:** Add missing but commonly needed CLI tools (`fd`, `nano`, `vim`, `procps`/`ps`, `sudo`), set environment variables that improve terminal and IDE behavior, and scope Docker volume names so multiple projects on the same host don't share volumes.

**How to implement:**
1. In the Dockerfile, install additional tools and create symlinks:
   ```dockerfile
   RUN apt-get install -y fd-find nano vim procps sudo \
     && ln -s /usr/bin/fdfind /usr/local/bin/fd \
     && ln -s /usr/bin/batcat /usr/local/bin/bat
   ```
2. In `.devcontainer/devcontainer.json`, add these container environment variables:
   ```json
   "containerEnv": {
     "DEVCONTAINER": "true",
     "POWERLEVEL9K_DISABLE_GITSTATUS": "true"
   }
   ```
   `DEVCONTAINER=true` is a standard signal to tools that they're running inside a container. `POWERLEVEL9K_DISABLE_GITSTATUS` prevents Powerlevel10k from running git status on every prompt (a significant slowdown in large repos).
3. Scope all named Docker volume names with `${devcontainerId}` so multiple checkouts of this template on the same host each get their own volumes (see the Proto tool caching entry for the `~/.proto` volume mount and the cross-device-link rationale).

---

## 2026-03-16 — Host-mounted two-tier secrets system (incl. GitHub token forwarding)

**Goal:** `${localEnv:VAR}` in `devcontainer.json` only works when the IDE process itself has the env var set — GUI apps launched from Dock, Spotlight, or DevPod don't inherit shell exports, making this approach unreliable. Replace it with a bind-mounted secrets file that all container processes can read directly, regardless of how the IDE was launched. This is also how rate-limit tokens get forwarded: proto resolves tool versions via the GitHub API, and unauthenticated requests are capped at 60/hr per IP — putting `GITHUB_TOKEN` in the secrets file raises this to 5,000/hr.

**How to implement:**
1. On the host, create the secrets directory and files:
   ```bash
   mkdir -p ~/.config/devcontainer/secrets.d
   chmod 700 ~/.config/devcontainer/secrets.d
   # Common secrets (all projects):
   touch ~/.config/devcontainer/secrets
   chmod 600 ~/.config/devcontainer/secrets
   # Per-project secrets (named after DEVCONTAINER_PROJECT):
   touch ~/.config/devcontainer/secrets.d/my-project
   chmod 600 ~/.config/devcontainer/secrets.d/my-project
   ```
   File format — one `KEY=value` per line, `#` for comments. Put API and rate-limit tokens here:
   ```
   GITHUB_TOKEN=ghp_...          # raises GitHub API limit 60/hr → 5,000/hr (used by proto)
   CONTEXT7_API_KEY=your-key-here
   ```
2. In `.devcontainer/devcontainer.json`, bind-mount the config directory and set `DEVCONTAINER_PROJECT`:
   ```json
   "containerEnv": {
     "DEVCONTAINER_PROJECT": "my-project"
   },
   "mounts": [
     "source=${localEnv:HOME}/.config/devcontainer,target=/run/devcontainer-config,type=bind,readonly"
   ]
   ```
3. In `.devcontainer/on-create.sh`, load secrets early so all subsequent scripts and MCP subprocesses inherit them:
   ```bash
   load_secrets_file() {
     local file="$1"
     [ -f "$file" ] || return 0
     while IFS= read -r line || [ -n "$line" ]; do
       [[ "$line" =~ ^#|^$ ]] && continue
       echo "$line" | sudo tee -a /etc/environment > /dev/null
     done < "$file"
   }
   load_secrets_file /run/devcontainer-config/secrets
   load_secrets_file /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT}
   ```
   Writing to `/etc/environment` ensures ALL container processes (extension hosts, MCP servers, terminals) inherit the vars — not just the calling shell.
4. In `.devcontainer/configs/.shell_common`, add the same two-tier load for interactive terminal sessions (belt-and-suspenders):
   ```bash
   [ -f /run/devcontainer-config/secrets ] && set -a && source /run/devcontainer-config/secrets && set +a
   [ -f /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT} ] && set -a && source /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT} && set +a
   ```
5. When cloning this template for a new project, update `DEVCONTAINER_PROJECT` in `devcontainer.json` to match the per-project secrets filename.

**`remoteEnv` fallback for `GITHUB_TOKEN`:** `remoteEnv: { "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}" }` also forwards the token, but only when the IDE was launched from a shell that already has it set — prefer the secrets file, which works in GUI-launched IDEs too. If both are configured, the secrets file wins (it's loaded last).

---

## 2026-03-16 — Context7 MCP server integration

**Goal:** Register the Context7 MCP server into Claude Code during container creation so Claude always has access to up-to-date library documentation. Add an idempotency check so it isn't re-registered on every container rebuild.

**How to implement:**
1. Ensure `CONTEXT7_API_KEY` is available in the container (via the secrets system above).
2. In an on-create script, register the MCP server with an idempotency guard:
   ```bash
   if ! claude mcp list 2>/dev/null | grep -q "context7"; then
     claude mcp add --scope user context7 -- bunx @upstash/context7-mcp
   fi
   ```
3. Node.js must be installed (see the Node.js LTS entry above) — the `claude` CLI requires `node` on `PATH` to run `mcp add`.
4. Add `CONTEXT7_API_KEY` to your `~/.config/devcontainer/secrets` file on the host.

---

## 2026-03-16 — AGENTS.md: shared AI conventions across all tools

**Goal:** Claude Code (CLAUDE.md), Opencode, and Cursor each have their own instruction files. Duplicating conventions across all of them creates drift. `AGENTS.md` becomes the single source of truth for shared rules; each tool-specific file references it.

**How to implement:**
1. Create `AGENTS.md` at the repo root with shared conventions: runtime preferences (Bun-first APIs), monorepo structure, code quality rules, and secrets handling.
2. In `CLAUDE.md`, reference it at the top:
   ```markdown
   Shared conventions (Bun-first, monorepo structure, code quality, secrets) are in @AGENTS.md.
   ```
3. Configure Opencode and Cursor to also load `AGENTS.md` as context.
4. Keep tool-specific instructions (e.g., Bun's `Bun.serve()` frontend patterns for Claude) in their respective files; only truly shared rules go in `AGENTS.md`.

---

## 2026-03-15 — Dockerfile: migrate system installs to image layer

**Goal:** `on-create.sh` was installing apt packages, git-delta, Proto, and Zinit from scratch on every container rebuild. Moving these into a Dockerfile bakes them into the image layer — they only reinstall when the image itself is rebuilt, not on every `devpod up`.

**How to implement:**
1. Create `.devcontainer/Dockerfile`:
   ```dockerfile
   FROM mcr.microsoft.com/devcontainers/base:ubuntu
   USER root
   # System packages
   RUN apt-get update && apt-get install -y \
     git curl unzip xz-utils tree ripgrep fzf \
     && rm -rf /var/lib/apt/lists/*
   # git-delta
   RUN curl -fsSL https://github.com/dandavison/delta/releases/download/.../git-delta_..._arm64.deb -o /tmp/delta.deb \
     && dpkg -i /tmp/delta.deb && rm /tmp/delta.deb
   # Zinit (shallow clone to avoid slow-network hangs)
   RUN git clone --depth 1 https://github.com/zdharma-continuum/zinit.git /usr/local/share/zinit
   # Pre-create ~/.proto so volume mounts inherit correct ownership
   USER vscode
   RUN mkdir -p /home/vscode/.proto
   ```
2. Reference the Dockerfile in `.devcontainer/devcontainer.json`:
   ```json
   "build": {
     "dockerfile": "Dockerfile"
   }
   ```
3. Remove the corresponding install steps from `on-create.sh` — leave only user/project-specific configuration (shell config copies, Biome, Claude Code, Opencode, etc.).
4. **Zinit note:** Always use `--depth 1` when cloning Zinit. A full history clone hangs for 15+ minutes on slow networks.

---

## 2026-03-15 — Opencode and Openspec setup

**Goal:** Install and configure Opencode (an AI coding tool) and Openspec (a spec-driven development workflow), including slash commands usable from both Cursor and Opencode.

**How to implement:**
1. In `.devcontainer/on-create/setup-opencode.sh`, install Opencode and add it to PATH:
   ```bash
   if ! command -v opencode &>/dev/null; then
     bun install -g opencode
   fi
   ```
2. Create `.opencode/command/` with markdown files for each slash command (e.g., `openspec-apply.md`, `openspec-proposal.md`). Mirror the same files to `.cursor/commands/` for Cursor users.
3. In `.devcontainer/on-create/setup-openspec.sh`, install Openspec globally:
   ```bash
   bun install -g @fission-ai/openspec
   openspec init --yes
   ```
4. Add Openspec to `package.json` devDependencies and document usage conventions in `AGENTS.md`.
5. Mount Opencode auth if needed — see `devcontainer.json` `mounts` for the auth socket pattern.

---

## 2026-01-11 — Husky + commitlint for enforced commit conventions

**Goal:** Enforce conventional commit format (`feat:`, `fix:`, `chore:`, etc.) automatically on every commit via git hooks, preventing malformed commit messages from ever entering the history.

**How to implement:**
1. Install dependencies:
   ```bash
   bun add -D husky @commitlint/cli @commitlint/config-conventional
   ```
2. Initialize Husky and add hooks:
   ```bash
   bunx husky init
   echo "bunx commitlint --edit \$1" > .husky/commit-msg
   echo "bunx lint-staged" > .husky/pre-commit
   ```
3. Create `commitlint.config.ts` (or `.commitlintrc`):
   ```ts
   export default { extends: ["@commitlint/config-conventional"] };
   ```
4. In `package.json`, add the prepare script and lint-staged config:
   ```json
   {
     "scripts": {
       "prepare": "husky"
     },
     "lint-staged": {
       "*.{ts,tsx,js,jsx,json}": ["biome check --write"]
     }
   }
   ```
5. In `.devcontainer/devcontainer.json`, set `postCreateCommand` to include `bun install` so Husky hooks are registered automatically when the container is created.

---

## 2026-01-09 — Project initialization script (`init-new-project.sh`)

**Goal:** Cloning a template repo brings along its entire git history. The initialization script resets git, sets up a fresh remote, and optionally auto-creates the GitHub repository — reducing a multi-step manual process to a single command.

**How to implement:**
1. Create `init-new-project.sh` at the repo root. The script should:
   - Accept a repo name, `org/name`, or full URL as an argument
   - Run `rm -rf .git && git init && git add -A && git commit -m "Initial commit."` to reset history
   - Derive the remote URL from the argument (assume GitHub if no host given)
   - If `gh` CLI is available and authenticated, create the repo automatically: `gh repo create <name> --private --source=. --remote=origin`
   - Add the remote and optionally push: `git remote add origin <url>`
   - Auto-update `DEVCONTAINER_PROJECT` in `.devcontainer/devcontainer.json` to the new project slug
   - Remove `bun.lock` so the new project starts with a clean lockfile: `rm -f bun.lock`
2. Make it executable: `chmod +x init-new-project.sh`
3. Document usage in `README.md` covering all input forms: bare name, `org/name`, full URL, and no argument.

---

## 2026-01-11 — Moon 2.x, workspace config, and GitHub Actions CI

**Goal:** Upgrade Moon from 1.x to 2.x and configure the monorepo task system with inherited lint, typecheck, test, and build tasks wired to Bun and Biome. Add a CI workflow that runs these tasks on every push and PR to main.

**How to implement:**
1. In `.prototools`, update tool versions:
   ```toml
   moon = "2.1.0"
   proto = "0.55.4"
   bun = "1.x"
   ```
2. Create `.moon/workspace.yml`:
   ```yaml
   projects:
     apps: "apps/*"
     libs: "libs/*"
     scripts: "scripts/*"
   ```
3. Create `.moon/toolchain.yml` pointing to Bun:
   ```yaml
   bun:
     version: "1.x"
   ```
4. Create `.moon/tasks.yml` with inherited tasks:
   ```yaml
   tasks:
     lint:
       command: biome check .
     typecheck:
       command: bun tsc --noEmit
     test:
       command: bun test
     build:
       command: bun run build
   ```
5. Create `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   jobs:
     ci:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v2
         - run: bun install
         - run: bun run lint
         - run: bun run typecheck
         - run: bun test
   ```
6. In `package.json`, fix `engines` to `"bun": ">=1.3.4"` (not Node) and add scripts that delegate to Moon or Bun directly.

---

## 2026-01-11 — Housekeeping: Biome upgrade, port trimming, Openspec skills migration

**Goal:** Routine maintenance items bundled together.

- **Biome 2.4.7 → 2.4.8**: Update `@biomejs/biome` in `package.json` and migrate `biome.jsonc` schema URL to the current version.
- **Trim forwarded ports**: Reduced `devcontainer.json` `forwardPorts` from 15 entries to 4 (the ports actually used), reducing noise in the IDE ports panel.
- **Openspec skills migration**: Moved Openspec slash-command definitions to the canonical location under `.opencode/command/` and `.cursor/commands/` and removed the outdated `openspec/project.md`.
