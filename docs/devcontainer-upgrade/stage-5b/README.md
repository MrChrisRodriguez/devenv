# Stage 5B Entrypoint cutover

Stage 5A added the isolated worktree runtime beside the existing `devpod up .`
entrypoint and called it a soak. Stage 5B ends the soak. The runtime is now *the*
entry point: `bash scripts/worktree/up.sh` starts a checkout,
`bash scripts/worktree/exec.sh` runs commands in it, the two git hooks run
project tooling inside the container the checkout owns, and the superseded
launcher is gone from onboarding, from both READMEs, from the agent rules, and
from every `.devcontainer/**` comment.

`.devcontainer/devcontainer.json` stays fully spec compliant on purpose. VS Code,
the `devcontainer` CLI, and any other launcher can still open this folder — but
a container started that way is an **editor convenience**: an ephemeral published
port, no route, no per-worktree isolation, and no manifest. Only the runtime
gives a checkout a stable port, a stable URL, and a lifecycle.

## What the cutover moved

| Concern | Runs where | How |
|---|---|---|
| Project tooling (`bun`, `bunx`, `moon`, `tsc`, tests, `package.json` scripts) | Container | `bash scripts/worktree/exec.sh <command>` |
| `commit-msg` (commitlint) and `pre-commit` (lint-staged) | Container | the hooks call the bridge in ready-only mode |
| The `pre-commit` graphify staging guard | Host | pure `git diff` plus `grep`; it must still answer when the container is down |
| Dependency install | Container | `bash scripts/worktree/exec.sh bun install --frozen-lockfile`; a host install writes host-platform binaries into the bind-mounted `node_modules` |
| `docker`, the `devcontainer` CLI, Git worktree management, remote pushes | Host | directly; starting a container from inside one is never correct |
| `scripts/worktree/*.sh` lifecycle and `.devcontainer/host/*.sh` | Host | directly |
| Read-only Git and file editing | Host | the checkout is bind mounted, so both sides see the same bytes |
| `package.json` scripts and `.moon` tasks | Direct, either side | wrapping them in the bridge would recurse the moment they ran inside the container |

The boundary is the human/agent entry layer. It deliberately stops before the
project's own task graph.

### The bridge's ready-only mode

`bash scripts/worktree/exec.sh --require-ready <command>` asks
`ensure.sh --check-ready` and nothing else. With no reconciled container it exits
**7** with:

```
Worktree bridge: this checkout's container is not ready; run bash scripts/worktree/up.sh
```

and the requested command provably never runs. The flag is parsed *ahead* of the
unsupported-argument arm, so a hook can never fall through to the reconciling
path — **a commit is not a build trigger.** Readiness is a host-side question, so
inside the container and in a verified cloud task the flag is accepted and
ignored. That fixes the bridge's exit-code space:

| Exit | Meaning |
|---|---|
| 2 | unsupported argument |
| 3 | identity collision |
| 4 | port exhaustion |
| 6 | missing container engine or CLI |
| 7 | `--require-ready` with no ready container |

`git commit --no-verify` is the documented escape hatch; there is no new skip
variable. Expect roughly 0.3–1s of extra commit latency for the `docker exec`
round trip. On a Linux host the container user's uid mapping is the usual
devcontainer concern — nothing in this stage changes it.

Both hooks degrade by **file existence** (`if [ -x scripts/worktree/exec.sh ]`),
not by a capability fence: a project rendered without the devcontainer capability
ships no `scripts/worktree` at all, so there is nothing to fence and the decision
has to be made at run time. The hooks stay POSIX `sh`, because Husky runs them
with `sh -e`.

### The second one-time rebuild

Every file under `.devcontainer/` is a definition-fingerprint input, and this
stage edits several of their comments. **All** of those edits are batched into
the single commit `3cc007b` so the cost is **one** automatic container recreate
for the whole stage rather than one per commit. `scripts/worktree/ensure.sh`
handles it on the next run with `--remove-existing-container`; nothing else is
required. Stage 5A's adoption rebuild was the first; this is the second and last
of the pair.

## Validation

The fast deterministic checks are:

```sh
bun run worktree:check
bash scripts/worktree/selftest.sh
bun test scripts/template/__tests__/worktree.test.ts
bun test scripts/template/__tests__/stage-five-b-evidence.test.ts
bun run template:validate
bunx tsc -p scripts/template/tsconfig.json
```

Plus the two structural checks that outlive any one stage:

```sh
# Hook files are POSIX sh, because Husky runs them with `sh -e`.
sh -n .husky/commit-msg && sh -n .husky/pre-commit

# No tracked file outside the record allow-list still names the old launcher.
bun scripts/template/collect-stage-five-b-evidence.ts scan-legacy
```

`bun run worktree:check` gained five cutover checks, all hermetic: both hooks
reach project tooling through the contract's `bridge_command` in ready-only mode;
the bridge parses `--require-ready` ahead of its unsupported-argument arm and
refuses with exit 7; `init-host.sh` installs the contract's `container_cli` and
the onboarding README names the bridge; the agent rules describe the cutover
rather than the soak; and — the non-vacuous half — **no tracked file outside an
explicit record allow-list still names the superseded launcher.** The allow-list
is deliberately narrow: sealed evidence and its validators (which describe runs
that really did use it), the cloud contract that forbids it by name, the guard
itself (which carries the literal token in order to look for it), the changelog,
these upgrade docs, the spec, and derived `graphify-out/` output.

There is deliberately **no** Docker or networked CI job for this stage. The live
proof is the capture below, run once on a real host, and sealed as evidence.

## Live evidence capture

`evidence/stage-5b-cutover.json` is the command-bound acceptance record for this
stage, with raw per-command logs and SHA-256 digests under
`evidence/stage-5b-cutover-run/`. What it proves is a **fresh-clone onboarding
journey**: clone, prerequisites, up, install, commit, refusal, diagnosis, down,
cleanup, and rollback, on a real host, with nothing installed on the host beyond
the documented prerequisites.

Prerequisites:

- A running container engine and the `devcontainer` CLI on `PATH`, plus
  `python3`, `git`, and `shasum`.
- A clean feature tree at the reviewed implementation boundary. The collector
  refuses otherwise; only the Stage 5B evidence files themselves may be
  uncommitted.
- Roughly 5–10 minutes when the image layers are already warm; the first real
  build on a cold host is much longer.

Two preconditions are enforced by the collector *and* sealed in the record:

- **The real checkout must have no ready container.** A second independent clone
  of this project is also family `main`, workspace id `devenv-main`, offset 0 —
  the same identity, the same port, and the same manifest path. The collector
  refuses to start unless `ensure.sh --check-ready` in the real checkout exits
  non-zero, and `precondition.checkReadyExitCode` records that answer.
- **The journey runs under an isolated HOME** at `<temporary root>/home`, so
  every registry, manifest, route, and credential path it touches is its own.
  The container engine's CLI configuration is deliberately *not* isolated
  (`DOCKER_CONFIG` still points at the host's), because it selects the engine
  endpoint, which is host tooling shared by every checkout on the machine.

The fifteen commands, in execution order:

| # | Command id | What it proves |
|---|---|---|
| 1 | `cutover-guard` | The hermetic contract, hook-routing, bridge-mode, onboarding, agent-rule, and legacy-scan guard passes on the real tree. |
| 2 | `hermetic-selftest` | The bounded downstream smoke passes with no engine and no network. |
| 3 | `cutover-known-bad-fixtures` | The full worktree behaviour and contract-mutation suite passes, including the eight cutover mutations. |
| 4 | `template-known-bad-fixtures` | Disabled-capability renders leave no runtime residue. |
| 5 | `legacy-orchestration-scan` | Every tracked file that still names the superseded launcher is on the record allow-list; nothing else does. |
| 6 | `journey-fresh-clone` | A real `git clone` at the implementation boundary: clean tree, no `.dev/`, no `node_modules`, no `core.hooksPath`, and both hooks already routing through the bridge. |
| 7 | `journey-prerequisites` | The documented host-directory loop under the isolated HOME, the engine/CLI/`python3` probes, `bash -n init-host.sh`, and the no-live-container precondition. |
| 8 | `journey-up` | One real cold `up.sh`: the container carries this clone's two ownership labels, the engine reports `127.0.0.1:8080` published, the manifest is written under the isolated HOME, no services are declared — and the clone now has `node_modules` and an active `core.hooksPath` that only the container could have written. |
| 9 | `journey-bridge-install` | `exec.sh bun install --frozen-lockfile` runs on a Linux kernel with the container's own Bun, and the pinned commitlint and lint-staged answer from there. |
| 10 | `journey-hook-routing` | A real host `git commit` with the hooks active: the exact invocation form the hooks use answers from a container the engine confirms is this checkout's, the conforming commit lands, and a subject with no type is rejected by commitlint with `husky - commit-msg script failed (code 1)` and does not land. |
| 11 | `journey-hook-refusal` | With the container stopped, the same commit is refused: `husky - pre-commit script failed (code 7)`, the bridge's own message, `HEAD` unchanged, the commit absent. Exits 7 by design. |
| 12 | `journey-inspect` | Read-only diagnosis: `env.sh --json`, `manifest.sh env`, the published manifest, and `services.sh status` all agree with the live environment. |
| 13 | `journey-down` | `down.sh` marks the route inactive while the manifest, the ports, the generated state, and the container all survive. |
| 14 | `journey-cleanup` | `cleanup.sh` removes this clone's container, its five `${devcontainerId}` volumes, and its manifest, reports nothing surviving, leaves the checkout itself in place — and the real checkout's registry, manifests, and routes are byte identical to the digest taken before the journey started. |
| 15 | `rollback-proof` | A synthetic merge followed by `git revert -m 1` produces a tree identical to the predecessor, in which `init-host.sh` and `README.md` again document the predecessor entry point. |

Command 11 is the only one expected to fail. It is recorded with status
`refused` and exit code 7, and the validator rejects a record in which it passed
— a refusal can never be smuggled in as a pass, and a pass can never be smuggled
in as a refusal.

**`init-host.sh` is not executed by the capture, and the record does not pretend
otherwise.** It runs `brew`, which would mutate the capture host. What the
journey does run is the part a fresh clone actually needs — the documented
host-directory loop, under the isolated HOME — plus `bash -n` on the script and
the assertions that it installs the container CLI and verifies `python3`. The
rest of that script is covered by the static guard and by `bash -n`, and that is
the honest boundary of this evidence.

The Stage 5B base boundary is `9b7e0576c4e360c25291ad84190cd3bec3e3d9b2`, the
merge-base of this branch with `origin/main` and the Stage 5A merge. It is the
`BASE_SHA` constant in `scripts/template/collect-stage-five-b-evidence.ts` and
`source.baseSha` in the record; the reviewed implementation boundary is
`source.implementationSha`. Evidence-only commits may follow that boundary, but
it must remain an ancestor of `HEAD`, so the branch is never rebased or amended
after a capture.

Run from the repository root:

```sh
bun scripts/template/collect-stage-five-b-evidence.ts capture \
  --implementation "$(git rev-parse HEAD)"
```

The collector creates the journey under `${TMPDIR}/devenv-stage5b-<run id>/` and
**always** releases it from an exit trap, whatever happened: `cleanup.sh` in the
journey clone, then any container or `${devcontainerId}` volume that still
carries the clone's ownership labels by exact name, then the isolated HOME and
both temporary roots. Nothing is ever swept. A failed capture leaves logs for
diagnosis and no passing record.

Every command's raw stdout and stderr is written to
`evidence/stage-5b-cutover-run/<id>.{stdout,stderr}` and digested. The record is
written only after schema, command-binding, journey-identity, log-binding, and
Git-identity validation all pass. The validator is environment agnostic: it binds
sealed values to other sealed values and to Git objects the record names, never
to the absolute layout of whatever checkout is running it. Hand-editing the
record or a log breaks `bun run template:validate`; the fix is to re-run the
collector.

After a capture, confirm the host is clean:

```sh
docker ps -a --filter "label=devcontainer.local_folder=$TMPDIR/devenv-stage5b-<run id>/clone" -q   # empty
docker volume ls --format '{{.Name}}' | grep -c "$(<journey devcontainerId>)"                      # 0
ls "$TMPDIR" | grep devenv-stage5b                                                                 # empty
```

and that `~/.config/devcontainer/{ports-registry,worktrees,caddy}` is byte
identical to what it was before — which the record already asserts through
`cleanup.mainCheckoutStateDigest`.

## Scope boundary: diagnosis, not a doctor

"Diagnosis" in this stage means the read-only outputs that already exist —
`scripts/worktree/env.sh --json`, `scripts/worktree/manifest.sh env`, and
`scripts/worktree/services.sh status`. A doctor with stable check IDs, bounded
probes, strict exit semantics, and untrusted-state parsing is **Stage 6** and is
deliberately not started here.

## Known limitation: one clone per project per host

A second independent clone of the same repository derives the same family
(`main`), the same workspace id, the same offset, and therefore the same ports
and the same manifest path as the first. The two would fight over the published
port, and a `cleanup.sh` in one would delete the other's manifest. **Keep one
clone of a project per host and use linked worktrees for parallel work** — that
is what the runtime's identity model is built for. Detecting a duplicate active
port claim is Stage 6 task 8.2; until then this is a documented rule, not an
enforced one. The capture's isolated HOME is the same rule, applied to a journey
that has to clone the project a second time in order to prove anything.

## Rollback

Stage 5B is one atomic bundle: the ready-only bridge mode, both hooks, the
onboarding scripts, both READMEs, the agent rules, the `.devcontainer` comments,
the guard, and the evidence revert together. Reverting only the hooks or only the
guard leaves documentation that describes a repository which no longer exists.

**Run cleanup first, while the runtime still exists.** The ordering rule is
Stage 5A's and it has not changed: after a revert past 5A there is no script left
that knows which containers, volumes, ports, manifests, and routes belonged to
which checkout.

```sh
# 1. In EVERY live worktree, while scripts/worktree/ is still present:
bash scripts/worktree/cleanup.sh

# 2. Then revert the merge:
git revert -m 1 <stage-5b-pr-merge-commit>

# 3. Then rebuild once, because .devcontainer changed again:
bash scripts/worktree/up.sh
```

Step 3 is not optional for the same reason the adoption rebuild was not:
`.devcontainer/**` is a definition-fingerprint input, so restoring the comments
changes the fingerprint back and `setup-proto.sh` refuses to start an existing
container against a definition it does not match.

One thing the revert does **not** do, and it is the only manual step: reverting
restores `devpod` as the documented entry point in `init-host.sh` and `README.md`
— the rollback proof asserts exactly that, by re-reading both files out of the
reverted tree — but it does not put the binary back on the host. If you rolled
back in order to use it again, run:

```sh
brew install devpod   # the named manual step; the revert restores the docs, not the install
```

The revert leaves the Stage 5A runtime in place and working, because 5A was
additive; the deeper rollback is still the Stage 5A merge, documented in
`docs/devcontainer-upgrade/stage-5a/README.md`. The committed rollback proof
binds the base and implementation SHAs, the synthetic merge parent order, the
predecessor and reverted tree identities, and the two restored onboarding paths.
