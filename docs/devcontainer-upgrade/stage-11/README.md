# Stage 11 — Final Template Release

Tasks 18.1–18.5. The stage that closes an eleven-stage program, and the first
one whose deliverable is deliberately absent from every render.

**Base:** `28f69975f133fb04b203e61709fa543614ede89d` (Stage 10E merge, PR #37)
**Branch:** `feat/stage-11-release` · **PR:** #38
**Evidence:** `evidence/stage-11-release.json`, run `stage11-20260807t193030z-decc5016`

---

## The decision this stage turns on

This surface is **TEMPLATE-ONLY** — neither core nor capability-gated, a third
category the program had not used before.

The reason is measured rather than preferred. The gate reads
`fixtures/template/*.toml`, `fixtures/golden/*.json` and `release.json`, and all
three are omitted from every render. A generated project would receive a command
whose inputs do not exist, which is the "dead command"
`specs/template-capability-model/spec.md` forbids. Making it **core** would ship
a script that exits non-zero on `release.json is missing` in every project that
never asked for it; making it **gated** would let a project switch on a gate
whose inputs it still would not have.

So the render probe is the **inverse** of every predecessor's: ten stages proved
a guard was present in the renders that enabled it; this one proves a guard is
present in **none** of them.

**The mechanism is the `template:` prefix.** `renderPackage` deletes every
`template:`-prefixed script from a rendered manifest, and it is the only thing in
this repository that removes a script from a render without a capability behind
it. `release:check` would have survived into every generated project as a command
whose module the render omitted. So the scripts are `template:release-check` and
`template:release-sync` — the manifest-side analogue of the `template-only` block
the workflow step lives in — and the guard asserts the prefix, so the omission
cannot quietly stop being real.

---

## Requirements this stage discharges

`template-release-validation` is the only capability delta no other stage owns:
five requirements, seven scenarios.

| Requirement | Where it is discharged |
|---|---|
| Every guard proves good and bad behavior | Commits 4 and 5. Anti-vacuity anchors on every leg: three fixtures, six scan families, ten acceptance items, four budget families, and a non-zero scanned-file count per surface. Zero on any of them is a hard failure with its own sentence. Also closes the hole inside `scanDisabledResidue`, which refuses zero *files* and never refused zero *disabled capabilities* |
| Stage evidence is machine-readable and reversible | Commit 7. `evidence/stage-11-release.json`, nineteen captures bound by sha256 to their log pairs, a synthetic-merge rollback proof compared as tree object ids, and the budget table the requirement asks for in the per-stage clause |
| Generated fixture release gate | Commits 1 and 2. Three golden manifests and **six** scan families — the spec's list, not `tasks.md`'s four |
| Generated fixture release gate / Full fixture is exercised | Commit 3 and the live captures. Ten acceptance items, split live/inherited by a path diff |
| No regression against baseline budgets | Commit 3. Four families, two of which have no Stage 0 baseline at all |
| Release only from exact green head | Commit 3 and the runbook below. Two declared signals, checked against local Git objects and never queried |
| Mechanically testable rule changes | Commit 6. A declared guard-to-section mapping, asserted per render |
| Capability-complete generation | The whole of the template-only decision, asserted from both sides |

---

## Commits

| SHA | Subject |
|---|---|
| `b761f1f` | `feat(release): declare the release gate registry and goldens` |
| `bf6c15c` | `feat(release): scan every render for identifiers and pins` |
| `9ecc5ca` | `feat(release): reconcile inherited acceptance and budgets` |
| `2ddf5fa` | `test(release): prove every refusal and toleration` |
| `548980f` | `test(release): prove the goldens catch renderer drift` |
| `decc501` | `docs(release): finalize onboarding and troubleshooting` |
| `0ed8066` | `test(release): seal stage 11 final release evidence` |
| *(this)* | `docs(release): record the release and close the change` |

`.devcontainer/**`, `bun.lock`, `scripts/template/render-fixture.ts`, `.husky/**`,
`.claude/settings.json`, `.gitignore`, `.gitattributes`, `biome.jsonc`,
`tsconfig.json`, `.moon/**`, `scripts/worktree/**`, `scripts/openspec/**`,
`apps/` and `libs/` are **empty diffs on every one of the eight commits**.
`package.json` moves only in commit 1 and only its `scripts` block.

---

## The post-merge runbook

Three things 18.5 requires cannot be commits in this pull request. This is the
sequence, and the reason for each position.

1. **Merge the pull request.** Produces merge commit **M** on `main`.
2. **Wait for the push-to-main run on M to go green.** This is a **full**-mode
   run, because `MOON_AFFECTED_MODE` selects `full` for default-branch pushes and
   `affected` for pull requests — so the PR run *is* the affected-mode proof and
   this one *is* the full-mode proof. **Nobody does anything until this is
   green.**
3. **Tag M**, not `HEAD`:
   ```bash
   git tag -a v1.0.0 <M> -m "devenv template v1.0.0 — portable devcontainer upgrade"
   git push origin v1.0.0
   ```
   The tag goes on the merge commit because the requirement refuses a release
   whose green run "belongs to a different commit". A `gh release create v1.0.0`
   is optional; the guard cannot verify it without querying GitHub, so it is in
   the runbook rather than in the gate.
4. **Archive the change**, on `main`, on the host, with a clean tree:
   ```bash
   bash scripts/openspec/archive.sh --change portable-devcontainer-upgrade
   ```
   It produces its own commit, pushes it, and reads the remote back to confirm.
5. **Optionally flip `release.json#decision` to `released`** in a follow-up
   commit on `main`. The guard refuses `released` while the tag does not exist,
   so this step is only legal after step 3.

**Tag before archive, and it is a real decision.** The archive commit adds no
template behaviour — `openspec/changes/**` and `openspec/specs/**` are both
`renderPolicy: omit`, so not one byte of it reaches any render. Tagging M means
the release artefact is the validated tree and never a half-archived one.

**Two things this sequence makes safe:**

- **`openspec:check` does not go red when all 82 tasks are checked.** It pushes a
  *notice* naming the archive wrapper, and the validator exits on errors only.
  Stage 9 built that handoff deliberately. Do not "fix" it.
- **The anti-vacuity collision the ledger flagged does not fire.** Archiving a
  root's last change leaves zero items only when the change has **no delta
  specs**; this one has **seven**, so `archive.sh` does not pass `--skip-specs`
  and the root declares `0 changes + 7 specs = 7 items` afterwards.

---

## Measurements taken at this head

| Measurement | Value | Against |
|---|---|---|
| Clean image build | **118.6 s** | Stage 0 baseline 312.33 s → improved |
| Warm image build | **6.4 s** | Stage 0 baseline 17.08 s → improved |
| Fresh startup to ready | **124.1 s** | **No Stage 0 baseline** — this is the first one |
| Two-worktree isolation | both ready, ports `8080` / `8511`, distinct manifests | Stage 5A |
| Second-worktree growth (different image) | 524,251,136 B | **not comparable** — see below |
| Browser preflight | passed in 171 ms inside `development_browser` | Stage 3 |
| Doctor | 36 checks per slot, 2 non-PASS | both are route probes — see L10 |

**The fresh-startup number is a first, not an improvement.** Stage 0 recorded
`freshStartupSlotOne`, `freshStartupSlotTwo`, `readiness`, `readyRestart` and
`warmCommandLatency` as `"unavailable"` — *"Neither isolated worktree completed
the lifecycle, so there is no successful readiness time."* A lifecycle completing
in 124.1 s is therefore the **first baseline** this family has ever had, which is
exactly the `no-baseline` verdict's purpose: record it as a first rather than
compare it against a number that does not exist.

**The second-worktree growth number is not comparable to Stage 0's, and the
budget deliberately does not use it.** Stage 0 and Stage 2 both measured the
*same-image* case: two containers sharing one image ID, neither having run a
lifecycle. This capture measured a second worktree that **built its own image**
(`imageShared=false`, because `.devcontainer/**` has moved since the primary
container was created) and then ran a full `onCreate` inside its writable layer —
507 MB of installs. Those are different quantities with the same name. So
`release.json#budgets.secondWorktreeGrowth` keeps Stage 2's same-image
measurement (4,472,832 B against Stage 0's 96,111,608 B → improved) and the live
figure is recorded here as a separate observation with its explanation, rather
than either number being quietly preferred.

---

## Decisions and deviations

1. **The package scripts are `template:release-check` / `template:release-sync`,
   not `release:check` / `release:sync`.** The plan named the latter. A1 forbids
   a `packageRules` entry and the validation rules forbid touching
   `render-fixture.ts`, so the *only* mechanism that removes a script from a
   render is the `template:` prefix. With `release:check` the script would
   survive into every generated project, and the guard-to-section assertion would
   then demand an `AGENTS.md` section that markdown's lack of template-only
   blocks forbids. The prefix is the manifest-side analogue of the `template-only`
   block, and it is asserted.
2. **The source-identifier allow-list ships three entries, not one.** Measured:
   `tsconfig.base.json` (`@confiador/`), `package.json`
   (`"name": "devenv-template"`) and `scripts/template/graph-contract.ts` — the
   last carrying the identifier inside the comment that explains why it is not
   hardcoded. Each entry names the mechanism that makes it safe, and the guard
   fails if any cited line is gone.
3. **The plan's "zero fixed-port hits today" was false.** `.devcontainer/devcontainer.json`,
   `scripts/worktree/contract.toml`, `proxy-routes.json` and the three vendored
   `graphify/SKILL.md` files (`--budget 3000`) all match. Four exemptions with
   reasons, per the bias-toward-false-positives doctrine.
4. **L9 is closed as a ratchet rather than as an equality.** All 35
   `scripts/template` guard modules declare `syncPolicy: merge` and are excluded
   by `sync-devcontainer.sh`'s `scripts/*` case arm — which
   `knownBoundaryRisks[0]` has said in writing since Stage 0. The count is
   declared and asserted, so a thirty-sixth file joining the silent set is a
   refusal naming it; rewriting the exclusion table belongs to a stage that owns
   that script.
5. **`capabilityInventory` was missing six capabilities, not the five the plan
   counted** — `codex_cloud` as well. `absent` is unchanged, so the three suites
   that pin it verbatim did **not** churn, which the plan had predicted they
   would.
6. **The full 33-file suite could not be completed in one run at several points.**
   The host degraded mid-stage: a suite that took 272 s early on later blocked
   with ~0.5 s of CPU over ten minutes, and `stage-seven-evidence.test.ts` began
   timing out at bun's default 5 s while passing with `--timeout 30000`. Proved
   environmental by stashing to the unmodified predecessor trees, where
   `worktree.test.ts` blocks identically. Substituted: file-group runs covering
   every file, plus `worktree:check` and `scripts/worktree/selftest.sh`. **CI ran
   the whole suite green on a clean runner**, which is the authoritative answer.
7. **The onboarding entry point was already correct.** Both READMEs already
   described `bash scripts/worktree/up.sh` and the `--require-ready` exit 7, so
   commit 6 added only the two missing sections and the troubleshooting link.
8. **`docs/troubleshooting.md` needed an ownership rule and a capability fence.**
   It matched no rule (`*` does not cross `/`), so it gained an explicit `copy`
   entry; and its `cloud:check` mention leaked into the `minimal` render until it
   was wrapped in `<!-- capability:start codex_cloud -->`. The anti-residue scan
   caught that before a human did.
9. **Schema shape refinements.** `goldens` is an object so the count cross-check
   has a home; `agentRuleSections` is a block the plan did not list, needed
   because the guard-to-section mapping is not derivable from the names;
   `signals` carry `status: pending|captured`; acceptance items carry
   `liveCommand` and `knownNonDefects`. `template:release-sync` regenerates the
   declared counts beside the goldens, because a count that disagrees with the
   manifest it describes is what the cross-check exists to catch on a *hand* edit.
10. **`IMMUTABLE_PLUGIN`, `IMMUTABLE_REFERENCE` and `LEGACY_LAUNCHER` gained an
    `export`** so "imported, not retyped" is literal. `GLOBAL_FORBIDDEN_TOKENS`
    is parsed out of `render-fixture.ts` at run time instead, since that file may
    not be touched — which also means a needle list that silently emptied is a
    refusal rather than a clean sweep.
11. **`template-ownership.json` was briefly mass-reformatted** by a `json.dumps`
    round-trip and a repo-wide `biome check --write`, exactly the ~1000-line diff
    the plan warned about. Reverted and reapplied surgically; the final diff is
    25 insertions and 8 deletions.
12. **The command-id list was reconciled with what is separately runnable.** The
    plan named six per-scan ids; the suite proves the six families in one
    runnable target, so sealing six identical logs would have been decoration.
    The record seals `scanFamilies: 6` and the guard's own per-family notices
    instead, and adds `fresh-startup` and `browser-image-build`, which the plan
    did not anticipate.
13. **Both CI signals ship `pending`, and the exact-head run id lives in the
    evidence record rather than in `release.json`.** A commit cannot seal the run
    that validates it — Stage 0 recorded the same constraint in its own words.
    The `live` block names run `31213516546` at `decc501`; the default-branch
    signal cannot exist until a merge commit does.
14. **Two captures had to be re-run after a host failure.** `browser-image-build`
    exited 1 with `rpc error: Unavailable ... EOF` and `render-fixtures` with
    `ENOSPC` when the host disk filled and the container engine died mid-unpack.
    Both were re-captured on a healthy host rather than sealed with an
    explanation, because a record whose captures failed for host reasons is a
    record a reader has to interpret.
15. **`treeClean` means "nothing unstaged" rather than "nothing to commit".** The
    record describes the commit that carries it, so the files it is about are
    necessarily present at collection time. What would be dishonest is a working
    tree holding changes the commit will not include.

---

## Findings recorded, not acted on

- **L1 — the `graphify` capability signature.** Not added, and now asserted
  rather than narrated. Two of its three surfaces are strict JSON and a fence
  here is a line comment, so they cannot be fenced at all; and a signature added
  today would sit **inert**, because the residue scan selects default-*false*
  capabilities with a signature and `graphify` defaults to true.
  `release.json#deferrals` records both facts and the conditions that would
  unblock it, and the guard refuses the moment either stops being true.
- **L4 — the knip / dead-code gap.** No dead-code guard exists. Its natural
  neighbour is the duplicate-rule scan, which ships and is a different thing. A
  dead-code oracle over an empty `apps/`/`libs/` is the vacuous pass this program
  refuses.
- **L7 — `graphify-out/graph.json` still names a deleted experiment** until the
  next `graphify update .`. Making it a rule would contradict `.husky/pre-commit`
  and `AGENTS.md`. A finding, not a rule.
- **L8 — `.husky/pre-commit` matches `graphify-out/graph.json` and nothing else.**
  `graph.html` (674 KB) and `GRAPH_REPORT.md` stage silently beside a feature
  change. Recorded, not widened: both hooks belong to the worktree contract, and
  widening the regex from here is a cross-fence edit.
- **L10 — `http_code_is_healthy` rejects `101`,** so a pure-WebSocket listener
  would fail `route.direct`. This stage **measured** the subject for the first
  time: both worktrees' doctors reported 36 checks with exactly two non-PASS,
  `route.direct` and `route.friendly`, because `services = []` ships no listener
  at all. The defect stays latent and unexercisable, and now there is a capture
  showing why.
- **L11 — `body_matches` has no `websocket-101` expectation.** Three-file change
  with no subject.
- **L12 — `proxy-routes.json` is still `mode: "skeleton"` and no stage owns
  flipping it.** 10C assigned it to 10D; 10D explicitly refused it. Recorded here
  as **orphaned, by name**. The release does not flip it: a route registry with no
  application is the vacuity 10D refused.
- **L18 — `fetch(…, {method:"POST"})` is not a detected write shape;** the scan is
  scoped to shell command position.
- **L19 — no route-tree staleness guard, and hydration is not proved and cannot
  be here** (it needs `playwright`). Both are for whoever enables the capability.
- **The second-worktree growth comparability problem** (above). Recorded because
  the honest reading is that two different quantities have been sharing one name
  since Stage 0, and nobody has needed to notice until a capture produced the
  other one.

---

## The complete ledger, with dispositions

| # | Item | Disposition |
|---|---|---|
| L1 | The `graphify` capabilitySignature | **RECORD** with a mechanical inertness assertion |
| L2 | `cloudflare_workers` reserves `wrangler.toml`; applications write `wrangler.jsonc` | **CLOSED** — path added |
| L3 | `tsconfig.base.json` carries `@confiador/*` | **CLOSED** as a declared exception with a paired mechanism |
| L4 | The knip / dead-code gap | **RECORD** |
| L5 | The top-level directory blind spot | **CLOSED** with 10E's own narrow version |
| L6 | `capabilityInventory` still lists `"moon"` | **CLOSED** after six stages, with set equality asserted |
| L7 | `graphify-out/graph.json` names a deleted experiment | **RECORD** |
| L8 | `.husky/pre-commit` matches one graphify artefact | **RECORD** |
| L9 | `knownBoundaryRisks` — five unclosed entries | **PARTIAL** — the sync-boundary half is now a ratchet |
| L10 | `http_code_is_healthy` rejects `101` | **RECORD**, now with a measurement |
| L11 | `body_matches` has no `websocket-101` expectation | **RECORD** |
| L12 | `proxy-routes.json` is orphaned between two stages | **RECORD as orphaned, by name** |
| L13 | `versionAuthorities[].currentRisk` describes the pre-migration tree | **CLOSED** — six entries refreshed |
| L14 | `fixture-manifest.json` names disabled capabilities | **DECLARED** exemption with its reason |
| L15 | A rendered `cloud:check` reports `bun.lock is missing` | **DECLARED** as a known non-defect on the cloud acceptance item |
| L16 | `moon-graph` as a substring in every render's `ci-contract.ts` | **DECLARED** exemption with 8A's reason |
| L17 | One clone per project per host | **RECORDED** in `docs/troubleshooting.md` |
| L18 | `fetch(…, {method:"POST"})` is not a detected write shape | **RECORD** |
| L19 | No route-tree staleness guard; hydration unprovable here | **RECORD** |
| L20 | `openspec.test.ts` asserts the change is ACTIVE | **CLOSED** — archive-tolerant in commit 4 |

**L20 was the only item that breaks `main` if ignored.** The assertion now counts
the change exactly once across active ∪ archived: green before the archive, green
after it, and strictly stronger than either fixed form, because it also catches
the both-active-and-archived state the guard already refuses.

---

## Scope

**New:** `release.json`; `release.schema.json`; `fixtures/golden/{minimal,cloud,full}.json`;
`scripts/template/release-contract.ts`; `scripts/template/validate-release.ts`;
`scripts/template/sync-release-goldens.ts`; `scripts/template/capture-stage-eleven.sh`;
`scripts/template/stage-eleven-evidence.ts`;
`scripts/template/collect-stage-eleven-evidence.ts`;
`scripts/template/__tests__/release.test.ts`;
`scripts/template/__tests__/fixtures/release-workspaces.ts`;
`scripts/template/__tests__/stage-eleven-evidence.test.ts`;
`evidence/stage-11-release.json`; `evidence/stage-11-release.schema.json`;
`evidence/stage-11-release-run/`; `docs/troubleshooting.md`; this document.

**Modified:** `scripts/template/validate.ts`; `scripts/template/__tests__/openspec.test.ts`;
`scripts/template/__tests__/template.test.ts`; `.github/workflows/ci.yml` (one step
inside a new `template-only` block); `package.json` (two `template:` scripts);
`docs/devcontainer-upgrade/stage-0/template-ownership.json`;
`scripts/template/{ci-contract,toolchain,worktree-contract}.ts` (one `export`
each); `README.md`; `README.template.md`; `CHANGES.md`; `tasks.md`.

**Unchanged, deliberately:** `template-parameters.toml` and its schema; all three
`fixtures/template/*.toml`; `scripts/template/render-fixture.ts`; `bun.lock`;
`package.json#workspaces` and `#devDependencies`; `.devcontainer/**`; `.husky/**`;
`.claude/settings.json`; `.gitignore`; `.gitattributes`; `biome.jsonc`;
`tsconfig*.json`; `.moon/**`; `moon.yml`; `ci-matrix-universes.json`;
`experiments.json`; `proxy-routes.json`; `scripts/worktree/**`;
`scripts/openspec/**`; `scripts/ci/**`; `apps/`; `libs/`; every spec delta.

**The unchanged list matters more here than in any previous stage.** This stage
is a *validator* of everything the program built. A diff touching
`render-fixture.ts` would mean the release gate was implemented by changing the
thing it is supposed to measure — and the goldens would then pin the changed
behaviour as if it had always been correct.
