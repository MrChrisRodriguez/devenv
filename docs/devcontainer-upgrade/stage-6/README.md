# Stage 6 Secure read-only worktree doctor

Every stage so far added something that *does* work: `env.sh` allocates,
`ensure.sh` reconciles, `up.sh` starts, `cleanup.sh` removes. None of them is
safe to run when the question is "what is wrong?", because every one of them
changes the thing you are asking about. Stage 6 adds the one command that only
answers.

```sh
bash scripts/worktree/doctor.sh
```

It is **host-only** and **read-only**. It inspects the host prerequisites, the
linked worktree's Git metadata, the generated state, the container this checkout
owns, its mounts and tools, the host routing, both URLs, the port registry, and
cross-worktree port collisions — and it changes none of them. It does not start
containers, generate state, reload host routing, install tools, or repair files.
It takes no lock, because a process in the middle of a read-modify-write on the
registry is exactly what a diagnostic must not disturb. When something is wrong
it names the command that fixes it and stops there.

Nothing under `.devcontainer/**` changed in this stage, so adopting it costs
**no container rebuild**.

## The check inventory

The ordered sequence of `add_result` calls **is** the registry: there is no
second table to drift from. Every check emits exactly one result — `PASS`,
`WARN`, `FAIL`, or `SKIP` — so the emitted id list is identical on a healthy host
and a broken one, and an unmet prerequisite produces a `SKIP` carrying its reason
rather than a silent gap. `bash scripts/worktree/doctor.sh --list-checks` prints
the same inventory while running no probe and touching nothing.

| # | Check id | Phase | Statuses | Remediation names |
|---|---|---|---|---|
| 1 | `host.context` | Host | PASS / FAIL | run the doctor from the host checkout |
| 2 | `host.command.git` | Host | PASS / FAIL | install Git |
| 3 | `host.command.engine` | Host | PASS / FAIL | install the contract's `container_engine` |
| 4 | `host.command.cli` | Host | PASS / FAIL | install the contract's `container_cli_package` |
| 5 | `host.command.python3` | Host | PASS / FAIL | install `python3` |
| 6 | `host.command.curl` | Host | PASS / WARN | install `curl` (costs the two route probes only) |
| 7 | `git.worktree-integrity` | Host | PASS / FAIL / SKIP | recreate this linked worktree from the main checkout |
| 8 | `host.engine-daemon` | Host | PASS / FAIL / SKIP | launch the container engine |
| 9 | `state.environment` | State | PASS / WARN | `ensure_command` |
| 10 | `state.manifest-state` | State | PASS / WARN | `ensure_command` |
| 11 | `state.values` | State | PASS / FAIL / SKIP | regenerate this checkout's environment |
| 12 | `state.paths` | State | PASS / FAIL / SKIP | regenerate this checkout's environment |
| 13 | `state.manifest` | State | PASS / WARN / FAIL / SKIP | one clone per project per host; use linked worktrees |
| 14 | `container.record` | Container | PASS / WARN / FAIL | `ensure_command` |
| 15 | `container.ready-record` | Container | PASS / WARN / FAIL | `ensure_command` |
| 16 | `container.runtime` | Container | PASS / WARN / SKIP | `ensure_command` |
| 17 | `container.ownership` | Container | PASS / FAIL / SKIP | do not execute in this container; release and reconcile |
| 18 | `container.definition` | Container | PASS / WARN / FAIL / SKIP | `ensure_command` (a rebuild is pending) |
| 19 | `container.fast-ready` | Container | PASS / FAIL / SKIP | `ensure_command` |
| 20 | `container.workspace-mount` | Container | PASS / FAIL / SKIP | `ensure_command` |
| 21 | `container.git-mount` | Container | PASS / FAIL / SKIP | `ensure_command` |
| 22 | `container.port` | Container | PASS / FAIL / SKIP | `ensure_command` |
| 23 | `container.volumes` | Container | PASS / WARN / FAIL / SKIP | `ensure_command` |
| 24 | `container.tools` | Container | PASS / FAIL / SKIP | `ensure_command` |
| 25 | `caddy.binary` | Routing | PASS / WARN / SKIP | install the host reverse proxy, or use the direct URL |
| 26 | `caddy.config` | Routing | PASS / WARN / SKIP | repair the host proxy configuration, or use the direct URL |
| 27 | `caddy.import` | Routing | PASS / WARN / SKIP | add one `import` line to the host Caddyfile |
| 28 | `caddy.snippet` | Routing | PASS / WARN / FAIL / SKIP | republish this checkout's route |
| 29 | `route.direct` | Routing | PASS / FAIL / SKIP | `ensure_command`, then retry |
| 30 | `route.friendly` | Routing | PASS / FAIL / SKIP | use the direct URL; check the host proxy |
| 31 | `registry.readable` | Registry | PASS / WARN / FAIL / SKIP | move the registry aside and regenerate |
| 32 | `registry.lock` | Registry | PASS / WARN | wait for the other allocation, or delete the stale lock directory |
| 33 | `registry.entry` | Registry | PASS / WARN / SKIP | regenerate this checkout's environment |
| 34 | `registry.offset-match` | Registry | PASS / FAIL / SKIP | regenerate this checkout's environment |
| 35 | `registry.port-collision` | Registry | PASS / FAIL / SKIP | regenerate the affected worktrees' environments |
| 36 | `manifests.port-collision` | Registry | PASS / WARN / FAIL / SKIP | regenerate the affected worktrees' environments |

Every remediation that names a lifecycle command names the contract's
`ensure_command`, never a hardcoded script path, and every remediation that names
a URL names the URL the doctor recomputed for itself — output derived from
generated state is a disclosure channel too.

`manifests.port-collision` is the promise Stage 5B made and this stage keeps: the
registry says who was *allocated* what, the manifest scan says who is actually
*claiming* what, and the two are independent. It is bounded by the contract's
`collision_scan_limit`, and one unreadable manifest among many is a gap in the
scan (`WARN`) rather than a verdict.

## Exit contract

| Exit | Meaning |
|---|---|
| 0 | No `FAIL`; without `--strict`, warnings do not matter |
| 1 | Any `FAIL`, or any `WARN` under `--strict` |
| 2 | Unsupported argument, refused before a single check runs |

`--strict` is a **pure exit-code modifier**: the checks array it produces is byte
for byte the one the same run produces without it. `--timeout <1-30>` is the only
knob and the only bound on every probe, defaulting to the contract's
`default_probe_timeout_seconds`. `--json` emits one document with a stable shape —
`schemaVersion`, `workspace`, `checks[]` (every entry carrying all five keys, with
`detail` and `remediation` always present as strings), `summary`, and `exitCode`
equal to the process's own. `--list-checks` prints the inventory and exits.

Running with `DEVCONTAINER=true` — or, where the capability ships,
`CODEX_CLOUD=true` — records a single `host.context` `FAIL` and stops. Inside a
container every host answer would be *wrong* rather than merely unavailable, so
that is a refusal, not a degradation.

## Hardening model

Everything the doctor reads is generated by something else, and some of it will
one day be wrong. The rules, in the order they apply:

- **Generated files are never sourced.** They are read key by key through the
  library's `sed` reader against an explicit key allowlist. One hostile line in a
  file this script wants two values out of would otherwise execute at read time.
- **No value builds a path, a hostname, or a URL until `state.values` passed.**
  The workspace id *and the family* are both held to
  `^[a-z0-9][a-z0-9-]{0,62}$`, because the family reaches a DNS label through
  `friendly_domain_pattern` exactly as the id does; the offset is bounded by
  `preferred_offset_modulus` and the port by the allocator's own 1024–65535 floor.
- **Paths are canonicalized and contained.** `os.path.realpath` then
  `os.path.commonpath` against the declared directory, plus a required suffix —
  which is what makes a traversal, a sibling path, and a symlink planted *inside*
  the manifest directory all fail identically, with the file never opened.
- **The manifest is parsed field-scoped**: nine allowlisted scalars, no nested
  structure, no file body in the report, and any value carrying a tab or newline
  dropped.
- **Container ids are hexadecimal or nothing** before being interpolated into a
  single engine argument.
- **Route URLs are recomputed and string-compared before anything is requested.**
  A well-formed but externally pointed URL in generated state is refused with a
  `FAIL` and the probe client is never invoked at all.
- **A rejected value costs the report no checks.** Hostile state becomes a `FAIL`
  plus a cascade of `SKIP`s carrying their reasons; the emitted id list is
  identical to a healthy run's, and the JSON still parses because the escaper is
  a hand-rolled byte walk under `LC_ALL=C` rather than `python3` — `python3` being
  absent is one of the conditions the report has to survive.

The doctor keeps `set -euo pipefail` like every other declared runtime script,
which means **every fallible probe in it is explicitly non-fatal**. A bare
fallible command would abort the report halfway through and turn a diagnosis into
a crash.

## Validation

```sh
bun run worktree:check
bash scripts/worktree/selftest.sh
bun test scripts/template/__tests__/worktree.test.ts
bun test scripts/template/__tests__/stage-six-evidence.test.ts
bun run template:validate
bunx tsc -p scripts/template/tsconfig.json
```

Plus the checks that are specific to this stage:

```sh
bash scripts/worktree/doctor.sh --help                     # 0
bash scripts/worktree/doctor.sh --timeout 0; echo "$?"     # 2
bash scripts/worktree/doctor.sh --json | python3 -m json.tool >/dev/null

# The published inventory and the guard's declared one are the same list.
diff <(bash scripts/worktree/doctor.sh --list-checks) \
     <(bun -e 'import {DOCTOR_CHECK_IDS} from "./scripts/template/worktree-contract"; console.log(DOCTOR_CHECK_IDS.join("\n"))')

# The read-only claim, measured on the real host.
BEFORE=$(find ~/.config/devcontainer .dev/state -type f -exec shasum -a 256 {} \; 2>/dev/null | sort | shasum -a 256)
bash scripts/worktree/doctor.sh >/dev/null 2>&1 || true
AFTER=$(find ~/.config/devcontainer .dev/state -type f -exec shasum -a 256 {} \; 2>/dev/null | sort | shasum -a 256)
[ "$BEFORE" = "$AFTER" ] && echo "doctor: non-mutating"
```

`bun run worktree:check` gained the guard for all of it, and every part of it is
hermetic:

- `doctor_command` names a **declared** runtime script — one that is in
  `runtime_scripts`, so the existing per-script guards (mode `0755`, `bash -n`,
  `set -euo pipefail`, no unscoped prune) apply to it, and one that actually
  publishes a check inventory, so pointing the key at a lifecycle script is
  caught rather than merely documented around.
- `toolchain_manifest` equals `[toolchain] proto_manifest` and names a file that
  exists.
- The inventory is compared **twice**: the guard spawns `--list-checks` on the
  shipped script, *and* reads the ordered `add_result` calls back out of the
  source. Those are two independent copies inside the script, and a rename that
  touches only one of them is exactly the drift a single comparison would miss.
- Three posture scans over the script's executable body: it may not invoke a
  state-changing verb of the contract's own container engine or CLI (scanned
  under both the variable the runtime calls them through and their literal
  names), call a lifecycle script, or reach for `mkdir`, `mktemp`, `rm`, `touch`,
  `wt_atomic_write`, a mutating Git subcommand, or a proxy reload; it may not
  source the lock library or call `portable_lock_acquire`; and it may not name
  the Proto manifest's path or two of its tools on one line, because the tool
  list has to be *derived*. `ensure.sh --check-ready` is the one deliberate
  exception on the first list: asking the reconciler its own read-only question
  is the only way to report the answer the bridge will really get.
- The agent rules and the onboarding README have to name `doctor_command`.

There is deliberately **no** new CI job and no Docker- or network-dependent test.
The live proof is the capture below, run once on a real host, and sealed.

## Live evidence capture

`evidence/stage-6-doctor.json` is the command-bound acceptance record for this
stage, with raw per-command logs and SHA-256 digests under
`evidence/stage-6-doctor-run/`.

Prerequisites:

- A running container engine and the `devcontainer` CLI on `PATH`, plus
  `python3`, `curl`, `git`, and `shasum`.
- A clean feature tree at the reviewed implementation boundary. The collector
  refuses otherwise; only the Stage 6 evidence files themselves may be
  uncommitted.
- Roughly 5 minutes with warm image layers, of which about half is command 3.
  A cold host, or one whose egress is degraded, is much longer: the in-container
  dependency install is the slow step, and it is the one that fails first when
  the registry is unreachable.

The capture builds a real two-worktree host and then diagnoses it:

- **An isolated `HOME`** at `<temporary root>/home`, so every registry, manifest,
  and route it touches is its own. `DOCKER_CONFIG` still points at the host's,
  because that selects the engine endpoint, which is host tooling shared by every
  checkout on the machine.
- **Two throwaway linked worktrees** at `<temporary root>/s6/alpha` and
  `<temporary root>/s6/beta`, checked out at the implementation boundary. Their
  parent directory fixes the two families at `s6-alpha` and `s6-beta`, so they
  derive different identities, different offsets, and different ports — which is
  the case the whole runtime exists for.
- **A bounded HTTP listener inside each container**, on the contract's
  `published_container_port`. The template declares no services, so without one
  the published port answers nothing and `route.direct` would be diagnosing an
  empty container rather than a route. The listener is the container's own
  Proto-managed interpreter and it dies with the container. The record says so:
  `journey-worktree-*-up` seals both the listener command and the HTTP code the
  direct URL returned.
- **A fabricated duplicate claim**, written into the *isolated* manifest
  directory only, deleted by the same command that wrote it, with the manifest
  directory digested on both sides of the diagnosis.

The seventeen commands, in execution order:

| # | Command id | What it proves |
|---|---|---|
| 1 | `doctor-guard` | The hermetic contract, inventory, read-only, lock, derivation, and documentation guard passes on the real tree. |
| 2 | `hermetic-selftest` | The bounded downstream smoke passes with no engine and no network. |
| 3 | `doctor-known-bad-fixtures` | The full worktree behaviour suite plus every contract mutation, including the eleven doctor mutations. |
| 4 | `doctor-check-inventory` | `--list-checks` on the real checkout prints exactly the declared 36 ids, running no probe. |
| 5 | `journey-worktree-a-up` | A real linked worktree at the implementation boundary, its Git directory outside the checkout, one real `up.sh`, an owned container with its port published on loopback, and a direct URL that answers 200. |
| 6 | `journey-worktree-b-up` | The same for a second worktree, with a different identity, offset, port, and container. |
| 7 | `live-healthy-human` | The human report: all 36 checks, no `FAIL`, no `SKIP`, and a summary line the record is bound to. |
| 8 | `live-healthy-json` | The same diagnosis as JSON: `exitCode` 0, ids equal to the declared inventory, and the summary the record seals. |
| 9 | `live-strict` | `--strict` returns exit 1 on the same host with a checks array **identical** to command 8's — a pure exit modifier. |
| 10 | `live-second-worktree` | Worktree B diagnosed on its own terms: exit 0, and the report names B's workspace, not A's. |
| 11 | `live-duplicate-port-claim` | A second active manifest claiming A's port makes `manifests.port-collision` `FAIL` naming both holders and the port — while `registry.port-collision` still passes, because the registry never knew about it. The manifest directory is byte identical across the diagnosis. |
| 12 | `live-stopped-container` | A stopped container: `container.runtime` `WARN`, `container.fast-ready` / `.port` / `.tools` `SKIP` with their reasons, `container.ownership` still `PASS`, the full inventory still emitted, and the container still there afterwards. |
| 13 | `live-inside-container` | Run inside the container with `DEVCONTAINER=true`, the doctor records exactly one check — `host.context` `FAIL` — and exits **1**. Expected non-zero. |
| 14 | `live-invalid-argument` | `--timeout 0` exits **2** with the bound named on stderr and **zero bytes** on stdout: refused before a single check ran. Expected non-zero. |
| 15 | `non-mutation-snapshot` | Every form of the doctor, in both worktrees, with the isolated host configuration root and both generated state trees digested *and* listed on either side — identical. |
| 16 | `journey-cleanup` | `cleanup.sh` in both worktrees removes both containers, all their `${devcontainerId}` volumes, and both manifests, leaves the checkouts themselves in place, and the real checkout's registry, manifests, and routes are byte identical to the digest taken before any of it started. |
| 17 | `rollback-proof` | A synthetic merge followed by `git revert -m 1` produces a tree identical to the predecessor — a tree that carries no `scripts/worktree/doctor.sh` at all. |

Commands 13 and 14 are the only two expected to fail. Each is recorded with
status `refused` and its exact exit code, and the validator rejects a record in
which either passed — a refusal can never be smuggled in as a pass, and a pass
can never be smuggled in as a refusal.

The captured run reports 35 `PASS`, 1 `WARN`, 0 `FAIL`, 0 `SKIP` on a healthy
worktree. The single warning is `caddy.import`: the host reverse proxy imports
the *real* `~/.config/devcontainer/caddy/*.caddy`, not the journey's isolated
one. That is not a blemish on the record — it is what makes command 9 a real
proof, because `--strict` has an actual warning to promote.

### What the capture found

An earlier attempt hit a transient registry failure during the container's own
dependency install, and `up.sh` reported success anyway: it logged an empty
container id, published the manifest as **active**, and printed both URLs. The
cause was one line — the reconcile was interpolated into a log message, and a
command substitution inside another command's arguments discards its exit
status, so `set -euo pipefail` never saw it. That is fixed in `4a8894c` with a
regression test, and it is exactly the class of bug a live capture exists to
find: no hermetic fixture had ever made the container start fail *and* then
asked what `up.sh` claimed.

The Stage 6 base boundary is `9961f7e6c6797738012665c16222ff1afc1441cd`, the
merge-base of this branch with `origin/main` and the Stage 5B merge. It is the
`BASE_SHA` constant in `scripts/template/collect-stage-six-evidence.ts` and
`source.baseSha` in the record; the reviewed implementation boundary is
`source.implementationSha`. Evidence-only commits may follow that boundary, but
it must remain an ancestor of `HEAD`, so the branch is never rebased or amended
after a capture.

Run from the repository root:

```sh
bun scripts/template/collect-stage-six-evidence.ts capture \
  --implementation "$(git rev-parse HEAD)"
```

The collector creates the journey under `${TMPDIR}/devenv-stage6-<run id>/` and
**always** releases it from an exit trap, whatever happened: `cleanup.sh` in each
worktree, then any container or `${devcontainerId}` volume that still carries a
worktree's ownership labels by exact name, then `git worktree remove --force` for
each linked worktree and the rollback workspace, then the temporary root. Nothing
is ever swept. A failed capture leaves logs for diagnosis and no passing record.

The validator is environment agnostic: it binds sealed values to other sealed
values and to Git objects the record names, never to the absolute layout of
whatever checkout is running it. Hand-editing the record or a log breaks
`bun run template:validate`; the fix is to re-run the collector.

After a capture, confirm the host is clean:

```sh
docker ps -a --filter "label=devcontainer.local_folder=$TMPDIR/devenv-stage6-<run id>/s6/alpha" -q   # empty
git worktree list | grep devenv-stage6                                                              # empty
ls "$TMPDIR" | grep devenv-stage6                                                                   # empty
```

and that `~/.config/devcontainer/{ports-registry,worktrees,caddy}` is byte
identical to what it was before — which the record already asserts through
`cleanup.realCheckoutStateDigest`.

## Scope

- **No repair mode.** There is no `--fix`, and there never will be one in this
  script. A command that both diagnoses and repairs cannot be trusted to
  diagnose.
- **No browser check.** Launching a browser is unbounded and mutating; the
  browser preflight and the cloud doctor own that question.
- **No new environment variables, no new CI job, and no new contract parameters.**
  `doctor_schema_version` was already reserved in `template-parameters.toml`.
- **The friendly route is optional by contract.** Every finding in the routing
  group is a warning, because it is a convenience layered on a direct loopback
  URL that always works; `--strict` is how a caller says it wants those warnings
  to matter, and `host_caddy = "disabled"` sends the whole group to `SKIP`.

## Rollback

Stage 6 is one atomic, additive bundle: the doctor, the three contract keys and
the `runtime_scripts` entry, the shared identity derivation in `lib.sh`, the
guard, the documentation, and the evidence revert together.

```sh
git revert -m 1 <stage-6-pr-merge-commit>
```

That is the whole procedure. There is **no** pre-revert cleanup step, unlike
Stage 5A and 5B: this stage allocates no runtime resource, so there is nothing to
release first. And there is **no** rebuild in either direction, because no
`.devcontainer/**` file changed and the definition fingerprint is untouched.

What a revert costs you is the diagnosis and nothing else. Downstream projects
that scripted `bash scripts/worktree/doctor.sh` lose that command; the runtime
itself — `up.sh`, `exec.sh`, `down.sh`, `cleanup.sh`, the registry, the manifests,
the routes — is exactly as it was. The committed rollback proof binds the base
and implementation SHAs, the synthetic merge parent order, the predecessor and
reverted tree identities, and the fact that the reverted tree carries no
`scripts/worktree/doctor.sh`.
