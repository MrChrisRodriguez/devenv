# Stage 7 CI bootstrap and workflow safety

Every earlier stage guarded something the repository *builds*: the toolchain, the
image, the runtimes, the cloud lane, the worktree runtime, the doctor. The
workflows that run those guards were the one part of the repository that nothing
guarded. The Bun version was a literal typed into three places, `bun install` was
a bare command with no bound on a hang, third-party actions floated on mutable
tags, two steps carried `continue-on-error: true`, and both workflow files were
free to drift from each other and from `.prototools`.

Stage 7 is one idea applied repeatedly: **every CI behaviour that matters gets
exactly one definition, and something rejects the second one.**

Nothing under `.devcontainer/**` changed, so adopting this stage costs **no
container rebuild**.

## One owner for the toolchain

`.github/actions/setup-bun/action.yml` is the only place a job learns how to get
Bun and `node_modules`. The version chain is one-way and every hop is checkable:

```
.prototools  bun = "1.3.13"
  -> workflow  env.BUN_VERSION
    -> caller   bun-version: ${{ env.BUN_VERSION }}
      -> action  inputs.bun-version   (required, no default)
        -> oven-sh/setup-bun@<40-hex sha>
          -> runtime assertion: `bun --version` == .prototools
```

The last hop is what makes the action self-verifying rather than merely
obedient, and a missing `.prototools` is a hard failure there, not a skipped
check. The composite input is `required: true` with **no default** *and* the
first run step hard-fails on an empty value, because `required` on a composite
input is not runner-enforced — an empty value would otherwise reach
`oven-sh/setup-bun`, which installs *latest*.

The action deliberately carries **no dependency cache** and **no `${{ }}` in any
metadata prose**: a composite action has no `env`, `secrets`, `vars`, `needs`, or
`matrix` context, and one such expression anywhere in the file — including a
description — makes the action fail to *load*.

`scripts/ci/bun-install-retry.sh` is the one install implementation, called by
the composite action and by the browser job's fixture install. Each attempt is
wrapped in `timeout`, the attempt count is capped (`BUN_INSTALL_ATTEMPTS`,
default 3), the exit code is captured into a variable rather than tested with
`if cmd; then` — which would mask `124` — and the lock semantics are preserved:
`bun.lock` present means `--frozen-lockfile`, absent means a plain install that
must produce one.

Composite steps get no `timeout-minutes`; the key is unsupported there, which is
exactly why the per-attempt bound lives in the script.

## Triggers, lanes, and bounds

```yaml
on:
  push: { branches: [main] }
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
```

There is deliberately **no `branches:` filter under `pull_request`**. That filter
matches the pull request's *base* branch, so `branches: [main]` on a stacked pull
request runs **zero** gating jobs — not a narrower run, no run at all — and the
pull request then shows a green page with no checks on it. `paths`/`paths-ignore`
remain the only intended narrowing.

`ready_for_review` is listed so a pull request opened as a draft revalidates the
moment it is marked ready, instead of waiting for a push that may never come.

```yaml
concurrency:
  group: ci-${{ github.ref }}-${{ github.event_name == 'pull_request' && github.event.pull_request.draft && 'draft' || 'ready' }}
  cancel-in-progress: true
```

The draft/ready suffix is load bearing. Without it the `ready_for_review` run
cancels the draft run it supersedes, and those cancelled draft jobs stay attached
to the exact head commit — so the head stays red after every ready-state job has
passed.

Every job carries `timeout-minutes` (ci 20, image 30, browser 30, gate 5, smoke
35), every workflow declares `permissions: contents: read`, and no step anywhere
carries `continue-on-error`. There is no `schedule:` on `ci.yml`: the file has no
paths filtering, so a nightly run would repeat work that already ran on every
push; the nightly lane that covers something genuinely different — real network,
real registries — is `codex-cloud-smoke.yml`.

`fetch-depth: 0` appears on exactly one job, `ci`, as a **declared** history
owner with a written reason: `template:validate` re-checks sealed ancestry with
`git merge-base --is-ancestor`, which a shallow clone cannot answer. Any other
job that sets the key is rejected.

## The aggregate gate

`ci-gate` (display name **`CI gate`**) is THE one required status check.

```yaml
  ci-gate:
    name: CI gate
    if: ${{ always() }}
    needs: [ci, image, browser]          # every other job in the file
    steps:
      - name: Verify no required job failed
        env:
          RESULTS: ${{ join(needs.*.result, ',') }}
          DRAFT: ${{ github.event.pull_request.draft }}
        run: bash scripts/ci/aggregate-gate.sh
```

Four properties, each of which is separately enforced:

- **`always()`**, so the gate ALWAYS reports. A run whose jobs were skipped — a
  draft pull request, or a lane this project's capabilities removed — must never
  strand a required check in a pending state that no further push can clear.
  Because it always reports, "no checks ran" is not reachable.
- **`needs` names every other job in the file.** Exclusions are explicit: the
  informational-exclusion list is empty and is required to stay empty unless an
  entry carries a written reason, and `codex-cloud-smoke.yml` is excluded because
  it is a separate workflow on a real-network lane — an upstream registry outage
  must never redden an unrelated pull request. The hermetic `cloud:check` and
  bootstrap selftest inside `ci` carry that signal instead, which is what
  `[ci] network_smoke_is_required = false` records.
- **The verdict is derived from `join(needs.*.result)`, not a hand-maintained
  list**, so a new job cannot be forgotten here — only in `needs`, which the
  guard checks separately.
- **Both values arrive through `env:`.** Pull-request metadata is
  attacker-influenced text; interpolated into a `run:` body it would be spliced
  into the script the runner executes.

The decision itself lives in a committed script so it can be *executed* by a
test rather than read:

| `RESULTS` | `DRAFT` | exit |
|---|---|---|
| `success,success,success` | *(empty — a push)* | 0 |
| `success,skipped` | `false` | 0 |
| `failure,success,success` | `false` | 1 |
| `success,cancelled` | `false` | 1 |
| `success,,success` | `false` | 1 |
| *(empty)* | `false` | 1 |
| `skipped,skipped,skipped` | `true` | 1 |

The draft check is **not** redundant with the results check. Gating jobs carry
`if: ${{ !github.event.pull_request.draft }}`, so on a draft they all report
`skipped` and the results check alone would pass — and a green required check
would let the pull request merge the instant it is marked ready, *before* the
`ready_for_review` run revalidates anything. Drafts show a red required check
until they are marked ready. That is intended.

## The workflow policy guard

`bun run ci:check` (`scripts/template/ci-contract.ts` +
`scripts/template/validate-ci.ts`) parses both workflows and the composite action
with `Bun.YAML.parse` and scans their text. It imports only `node:*`, because it
renders downstream. The rule groups:

| Group | What it rejects |
|---|---|
| setup | more than one bootstrap owner; a direct `oven-sh/setup-bun` step; a caller not passing `env.BUN_VERSION`; an action input that is not `required` or carries a default; a missing non-empty assertion |
| context | any `${{ env. / secrets. / vars. / needs. / matrix. }}` inside `action.yml`, prose included |
| unsupported inputs | any `with:` key `oven-sh/setup-bun` does not declare — the allowlist is the whole list, because Actions silently ignores an undeclared input, so a `cache:` would look like caching and cache nothing forever |
| mutable refs | a non-local `uses:` that is not pinned to a 40-hex SHA |
| triggers | any form of a `pull_request` base filter; a missing `ready_for_review`; a concurrency group without `github.ref`, the draft/ready ternary, or `cancel-in-progress` |
| bounds | a job without `timeout-minutes` |
| tolerance | `continue-on-error` outside the (empty) reasoned allowlist |
| sleeps / retries | a bare `sleep` in a `run:` body, or a retry loop written into a workflow instead of the committed script |
| caching | `~/.bun/install/cache`, a `bun.lock`-keyed dependency cache, or a `cache*` input on `setup-bun` |
| gate | a gate id that is not the declared `aggregate_gate_name`; a missing `always()`; a `needs` list that is not every other job minus a reasoned exclusion; a gate with no dependency outside every capability fence; a gate that does not consume `join(needs.*.result)` through `env:` and run the committed script |
| injection | `${{ github.event.* }}` anywhere in a `run:` body |
| runtime ownership | `setup-node`, `npm`, `npx`, `pnpm`, `yarn`, `corepack`; `fetch-depth` on an undeclared job |
| compiler coverage | a tracked `.ts` file outside every committed `tsconfig` include; a project whose typecheck CI does not run |
| network isolation | any `MOON_REMOTE_*` under `.github/**`; a gate that depends on the network smoke |
| render graph | a `needs` entry naming a job the file does not declare — checked against the tree as committed **and** against the tree a project with no capabilities would render |

## Validation

```sh
bun run ci:check
bun run toolchain:check && bun run image:check && bun run browser:check
bun run cloud:check && bun run worktree:check
bun run typecheck && bun run template:typecheck
bun test scripts/template/__tests__/ci.test.ts
bun test scripts/template/__tests__/stage-seven-evidence.test.ts
bun run template:validate
bunx biome check --no-errors-on-unmatched .
```

Plus the checks specific to this stage:

```sh
# The gate's decision table, executed rather than described.
RESULTS='success,skipped'          DRAFT=false bash scripts/ci/aggregate-gate.sh; echo "$?"  # 0
RESULTS='failure,success,success'  DRAFT=false bash scripts/ci/aggregate-gate.sh; echo "$?"  # 1
RESULTS='success,cancelled'        DRAFT=false bash scripts/ci/aggregate-gate.sh; echo "$?"  # 1
RESULTS=''                         DRAFT=false bash scripts/ci/aggregate-gate.sh; echo "$?"  # 1
RESULTS='skipped,skipped,skipped'  DRAFT=true  bash scripts/ci/aggregate-gate.sh; echo "$?"  # 1

# The install bound, against a command that hangs on purpose.
BUN_INSTALL_TIMEOUT_SEC=2 BUN_INSTALL_ATTEMPTS=2 bash scripts/ci/bun-install-retry.sh

# The required context is the gate job's DISPLAY name, never its id.
bun -e 'import {aggregateGateContext} from "./scripts/template/ci-contract";
  console.log(aggregateGateContext(await Bun.file(".github/workflows/ci.yml").text()))'
```

## Live evidence capture

`evidence/stage-7-ci.json` is the command-bound acceptance record for this stage,
with raw per-command logs and SHA-256 digests under `evidence/stage-7-ci-run/`.
Nine commands: four hermetic, four that read something this repository cannot
fabricate, and the rollback proof.

Prerequisites: `gh` authenticated against the repository, `git`, `python3`, and
`shasum`; a clean feature tree at the reviewed implementation boundary — the
collector refuses otherwise, and only the Stage 7 evidence files themselves may
be uncommitted.

The live half is captured by hand first, then sealed by the collector:

```sh
git push -u origin feat/stage-7-ci-bootstrap
gh workflow run CI --ref feat/stage-7-ci-bootstrap            # the green run

git switch -c evidence/stage-7-gate-negative                  # the red run
# insert exactly one failing step at the top of the `ci` job:
#     - name: Deliberate gate negative control
#       run: exit 1
git commit -am 'test(ci): inject a deliberate failure for gate evidence'
git push origin evidence/stage-7-gate-negative
gh workflow run CI --ref evidence/stage-7-gate-negative

gh pr create --draft --base main --head evidence/stage-7-gate-negative ...   # the draft run

gh pr close <draft-pr>
git push origin --delete evidence/stage-7-gate-negative

gh api -X PUT repos/<owner>/<repo>/branches/main/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["CI gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null }
JSON

bun scripts/template/collect-stage-seven-evidence.ts capture \
  --implementation <sha> --green-run <id> --red-run <id> --red-sha <sha> \
  --red-branch evidence/stage-7-gate-negative --draft-run <id> --draft-pr <n>
```

The nine commands, in execution order:

| # | Command id | What it proves |
|---|---|---|
| 1 | `ci-guard` | `bun run ci:check` passes on the committed tree |
| 2 | `workflow-policy-mutations` | the whole mutation suite for `ci.test.ts` passes, 0 failures |
| 3 | `gate-semantics` | the seven-row decision table, executed against the committed gate script |
| 4 | `rendered-workflow-graph` | every fixture renders a gate whose `needs` name jobs that fixture has |
| 5 | `live-gate-green` | a real run in which every job succeeded and the gate went green |
| 6 | `live-gate-red` | a real run in which one job failed and the gate went red naming it |
| 7 | `live-gate-draft` | a real draft pull request in which every gating job skipped and the gate stayed red |
| 8 | `branch-protection` | `main` requires exactly the context the committed workflow produces |
| 9 | `rollback-proof` | reverting restores the predecessor tree and removes every added path |

### What the capture found

- **Green** — run [`31132434357`](https://github.com/MrChrisRodriguez/devenv/actions/runs/31132434357),
  `workflow_dispatch` on the implementation commit. `Lint, Typecheck & Test`,
  `Build devcontainer image` and `Launch baked browser payload` all `success`;
  the gate was handed `upstream results: success,success,success` and concluded
  `success`.
- **Red** — run [`31132456715`](https://github.com/MrChrisRodriguez/devenv/actions/runs/31132456715)
  on a throwaway branch carrying `3 0 .github/workflows/ci.yml` — the two-line
  step above and a blank line. `Lint, Typecheck & Test` failed; the image and
  browser jobs still passed; the gate was handed `failure,success,success` and
  concluded `failure` with `A required job did not pass (result=failure).` The
  branch is deleted, so the record carries the injected diff.
- **Draft** — run [`31132439991`](https://github.com/MrChrisRodriguez/devenv/actions/runs/31132439991),
  `pull_request` on a draft. All three gating jobs `skipped`; the gate never even
  read a result (`upstreamResults` is empty) and concluded `failure` with the
  mark-ready instruction. The pull request is closed.
- **Branch protection** — `contexts: ["CI gate"]`, `strict: true`,
  `enforce_admins: false`, and no `required_pull_request_reviews` or
  `restrictions` keys at all.
- **Rendered graph** — `minimal` and `cloud` render `[ci, ci-gate, image]` with
  the gate needing `[ci, image]`; `full` adds `browser` to both. No fixture
  renders a gate with an empty dependency list, and `minimal` carries no
  `browser` job and no `browser` need.

The validator that re-checks all of this is deliberately **environment
agnostic**: it compares sealed values to other sealed values and to files in the
tree, never to the machine it happens to run on. It shells out to `git` only for
object and ancestry questions, and it reads `.github/workflows/ci.yml` to derive
the required context and the gate's dependency count — which is what binds the
live runs to the file this repository actually ships.

## Branch protection is an operator step

The required status check is **`CI gate`** — the job's *display name*, because
branch protection matches display names and not job ids. Setting it is a one-time
action per repository, and it lives on the forge rather than in the tree:

```sh
gh api -X PUT repos/<owner>/<repo>/branches/<default>/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["CI gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null }
JSON
```

`strict: true` means a pull request must be up to date with the base branch
before it merges. No other job in `ci.yml` should be listed: they all funnel into
the gate, and listing one individually would make a capability-fenced job a
required context in projects that do not have it.

## Scope

- **No caching in the composite action.** Restoring an extracted dependency tree
  repeats the two expensive operations that make a cold install cold, and evicts
  the Proto, uv and browser-payload entries that genuinely do pay for themselves.
  The rationale is carried in the action's header so a future contributor reads
  the reason before adding one back.
- **The network smoke is not a required check**, by design, and the guard rejects
  a gate that depends on it.
- **Renovate's `github-actions` manager is enabled config-only.** The SHA pins
  and the manager land together — pinning without a manager is silent rot — but
  the Renovate app itself remains uninstalled, so the configuration is inert and
  correct rather than active.
- **The compiler-coverage rule is scoped to the template repository.** It asks
  that every *tracked* `.ts` file fall inside some committed `tsconfig` include,
  which is a question about this repository's own index. Rendered guard modules
  are not proven by standalone compilation: they are proven by **execution** —
  `toolchain:check`, `image:check`, `worktree:check` and `ci:check` all run
  inside rendered CI, and a rendered module that failed to compile could not run
  at all. This exemption is recorded deliberately rather than papered over with a
  rule that would have to walk trees it does not own.

## Rollback

Stage 7 is one atomic bundle: the composite action, the three CI helper scripts,
the root `tsconfig.json`, the workflow guard and its entrypoint, both workflow
rewrites, the toolchain and cloud contract retargets, the ownership and Renovate
wiring, the documentation, and the evidence revert together.

```sh
# 1. Remove the required status check FIRST — it is not in the tree.
gh api -X DELETE repos/<owner>/<repo>/branches/main/protection

# 2. Then revert the bundle.
git revert -m 1 <stage-7-pr-merge-commit>
```

**Order matters.** Branch protection lives on the forge, so `git revert` cannot
undo it. If the revert lands while `CI gate` is still required, every later pull
request blocks forever on a context that no workflow produces any more. Removing
protection first costs a window in which `main` is unprotected; the alternative
costs a repository nobody can merge into.

There is **no** rebuild in either direction: no `.devcontainer/**` file changed
and the definition fingerprint is untouched. What a revert costs you is the
bootstrap ownership, the bounded install, the draft/ready lanes, the aggregate
gate, and the workflow guard — the CI surface returns to exactly the Stage 6
shape, `continue-on-error` and all. The committed rollback proof binds the base
and implementation SHAs, the synthetic merge parent order, the predecessor and
reverted tree identities, and the fact that the reverted tree carries none of the
nine paths this stage adds.
