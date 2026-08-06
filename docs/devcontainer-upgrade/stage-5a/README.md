# Stage 5A Additive isolated worktree runtime

Stage 5A gives every checkout — the main clone and each linked `git worktree` —
its own container, its own host ports, its own persisted data, its own URL, and
its own lifecycle, without touching the existing `devpod up .` entrypoint. The
whole runtime is committed under `scripts/worktree/`: a generated contract, a
side-effect-free shell library, a portable lock, and nine bash entry points that
read the contract and nothing else.

It is deliberately *additive*. Stage 5B is the cutover; until then the legacy
entrypoint keeps working exactly as before, and the two can coexist on one host.

## Ownership contract

- `scripts/worktree/contract.toml` is the single machine-readable authority for
  identity, ports, paths, timeouts, routing, and commands. It is flat
  `key = value` TOML because the runtime reads it with `sed` before Bun or `jq`
  exist on the host, and because the renderer's capability fences are line
  based. It is **generated** from `template-parameters.toml` by
  `renderWorktreeContract()`; `scripts/template/worktree-contract.ts` fails the
  build when the committed file drifts from a regeneration. Downstream projects
  have no `template-parameters.toml` and own the rendered contract directly.
- **Identity.** The main checkout is the `main` family and always holds offset 0;
  it is never registered. A linked worktree is named for its parent directory and
  its own directory (`~/agent/worktrees/topic` folds the literal `worktrees`
  container to its grandparent and becomes `agent-topic`). The workspace id is
  `<docker_resource_prefix>-<family>`, validated against
  `^[a-z0-9][a-z0-9-]{0,62}$`.
- **Ports.** `scripts/worktree/env.sh` derives a preferred offset from
  `cksum(family) % preferred_offset_modulus + 1` and then has the host-global
  registry at `~/.config/devcontainer/ports-registry/ports.json` arbitrate it.
  Arbitration compares **whole derived port sets**, not offsets: declared base
  ports are usually contiguous, so two distinct offsets can still collide on a
  real port. The implicit offset-0 set of the main checkout is always treated as
  occupied. Exhaustion exits 4 and names every registered environment.
- **Host-only versus container-only.** Allocation, container lifecycle, manifest
  publication, and cleanup are host operations and refuse to run inside a
  container — that is environment *detection* (`DEVCONTAINER=true`,
  `CODEX_CLOUD=true`), not failed-write detection, because a container's
  `~/.config` is an isolated writable volume where the write would succeed and be
  wrong. Inside a container the runtime reads the host-generated environment and
  never allocates. Service orchestration is the mirror image: it runs inside.
- **Ports are offset on the host only.** Each container owns its network
  namespace, so every service listens on its declared base port inside the
  container; the offset exists to disambiguate contended host ports. That is why
  two environment files are generated — `.dev/state/worktree.env` (host view) and
  `.dev/state/worktree.container.env` (container view).
- **Container ownership.** A container belongs to a checkout only when the engine
  reports it Running **and** its `devcontainer.local_folder` label equals the
  checkout root **and** its `devcontainer.config_file` label equals that
  checkout's `.devcontainer/devcontainer.json` **and** the shared Git common
  directory is bind mounted at the same absolute path it has on the host. All
  four, every time. Discovery filters on *both* labels, so a container carrying
  only one belongs to something else.
- **Volume ownership.** Named volumes are `<prefix>-${devcontainerId}`, and the
  prefixes are derived from `devcontainer.json`'s `mounts` rather than listed in
  a script — a hardcoded list drifts silently the moment a mount is added, and a
  missed volume looks exactly like a clean host. `${devcontainerId}` is computed
  host-side in `python3`, mirroring the CLI's algorithm (sha-256 of the compact
  sorted JSON of `{devcontainer.config_file, devcontainer.local_folder}`, base-32
  over `0-9a-v`, left padded to 52). The live capture verifies that computation
  against the volume names Docker actually created.
- **Routing.** The direct URL `http://127.0.0.1:<published host port>` is always
  published and always authoritative. The friendly
  `<worktree>.<project>.localhost` route is a convenience served by an optional
  host Caddy that imports `~/.config/devcontainer/caddy/*.caddy`. Caddy
  resolution is `<PREFIX>_HOST_CADDY_BIN` then `command -v caddy`; the Caddyfile
  is `<PREFIX>_HOST_CADDYFILE` then a fixed candidate list
  (`${HOMEBREW_PREFIX}/etc/Caddyfile`, `/opt/homebrew/etc/Caddyfile`,
  `/usr/local/etc/Caddyfile`, `/etc/caddy/Caddyfile`). Bare `/etc/Caddyfile` is
  excluded by design: reloading a machine-wide configuration this runtime does
  not own is not a convenience. Every failure warns and the caller continues.
- **`down` is not `cleanup`.** `down.sh` stops the declared services and marks
  the manifest inactive, removing only the Caddy snippet. The registry entry, the
  reserved ports, the manifest itself, the generated environment, the persisted
  data, and the container all survive, so a later `up.sh` hands back the
  identical URLs. `cleanup.sh` is the destructive one, and it asserts its own
  completeness: after removing this checkout's container, `${devcontainerId}`
  volumes, manifest, route, registry entry, generated state, and persisted data,
  it re-inventories all of them and exits 1 printing
  `these resources survived cleanup:` when anything is left. Success prints
  `removed every resource owned by <workspace-id>`.
- **Nothing is ever swept.** No `git worktree prune`, no `docker system prune`,
  no `docker volume prune`, no unscoped `rm -rf`. Each of those would reach into
  a sibling worktree that is perfectly alive, so the guard forbids the tokens
  outright.
- **Soak coexistence.** The runtime uses the reference `@devcontainers/cli` plus
  `docker`, because the ownership labels, per-invocation `--mount`,
  `--remove-existing-container`, and `${devcontainerId}` are reference-CLI
  semantics. DevPod remains the untouched legacy entrypoint. During the soak the
  main checkout may therefore carry **two** containers at once — one from
  `devpod up .`, one from `scripts/worktree/ensure.sh`. They share no volumes
  (different `${devcontainerId}`) and no ports, and neither carries the other's
  ownership labels, so neither can adopt or destroy the other.

### The one-time rebuild

`.devcontainer/devcontainer.json` gains exactly two entries:

```jsonc
"runArgs": [..., "--publish", "127.0.0.1:${localEnv:DEVENV_PUBLISHED_HOST_PORT}:8080"],
"containerEnv": { ..., "DEVCONTAINER_WORKTREE_ENV_FILE": "/workspace/.dev/state/worktree.container.env" }
```

Both live under `.devcontainer/`, which is a definition-fingerprint input, and
`setup-proto.sh` hard-fails container start on a fingerprint mismatch.
**Adopting Stage 5A therefore costs every existing container exactly one
rebuild.** There is no way to avoid it and no reason to hide it: run
`devpod up . --recreate` (or let `ensure.sh` recreate with
`--remove-existing-container`) once after merging.

The publish entry was gated empirically before anything was built on it. With
`DEVENV_PUBLISHED_HOST_PORT` unset — the DevPod and editor path — the CLI
substitutes `${localEnv:}` to the empty string, so the argument collapses to
`-p 127.0.0.1::8080`, which Docker accepts and answers with an **ephemeral**
loopback port:

```
$ docker run --rm -d -p 127.0.0.1::8080 alpine:3.20 sleep 60
$ docker port <id>
8080/tcp -> 127.0.0.1:32799
```

So nothing that worked before needs the runtime to keep working — but the port is
random until `scripts/worktree/env.sh` and `ensure.sh` are in the loop. A
*stable* host port, the stable direct URL, and the friendly `.localhost` route
exist only when the runtime drives the start. The same parse also confirmed that
`initializeCommand` still carries both named entries; `prepare-container-env` is
never gated, renamed, or folded, because `runArgs` names the file it writes.

## Validation

The fast deterministic checks are:

```sh
bun run worktree:check
bash scripts/worktree/selftest.sh
bun test scripts/template/__tests__/worktree.test.ts
bun test scripts/template/__tests__/stage-five-evidence.test.ts
bun run template:validate
bunx tsc -p scripts/template/tsconfig.json
bunx biome check --no-errors-on-unmatched .
```

Two structural checks are worth running by hand after touching the runtime:

```sh
# Executable bits are part of the contract.
git ls-files -s scripts/worktree | grep '\.sh$' | grep -v 100755   # prints nothing

# The host fingerprint must equal the image-owned Bun implementation.
diff <(bash .devcontainer/devcontainer-fingerprint.sh .) \
     <(bash scripts/worktree/ensure.sh --definition-fingerprint)
```

`bun run worktree:check` and `bash scripts/worktree/selftest.sh` are hermetic —
no Docker, no network, no allocated ports, no prepared worktree — so both run as
required CI steps. The selftest is a bounded downstream smoke; the real behaviour
matrix (real `git worktree` trees, stubbed engine and CLI, concurrency,
ownership attacks, cleanup isolation) lives in
`scripts/template/__tests__/worktree.test.ts`.

There is deliberately **no** Docker or networked CI job for this stage. The live
proof is the capture below, run once on a real host, and sealed as evidence.

## Live evidence capture

`evidence/stage-5-worktree.json` is the command-bound acceptance record for this
stage, with raw per-command logs and SHA-256 digests under
`evidence/stage-5-worktree-run/`. It is captured on a real development host —
macOS or Linux, with a running container engine — because the thing being proven
is that two containers, two port sets, two volume families, and two persisted
data roots genuinely coexist. `evidence/stage-5-worktree.schema.json` allows
`host.os` of `darwin` or `linux`.

Prerequisites:

- A running container engine and the `devcontainer` CLI on `PATH`, plus
  `python3`, `git`, and `curl`.
- A clean feature tree at the reviewed implementation boundary. The collector
  refuses to run otherwise; only the Stage 5A evidence files themselves may be
  uncommitted.
- Roughly 30–60 minutes, most of it the first real image build. The second
  worktree builds from the same layers and is much faster.
- Enough free loopback ports for two more environments, and write access to
  `~/.config/devcontainer/`.

The Stage 5A base boundary is `fe667186bc9939c582c35b67f0dac2d0d5d73220`, the
merge-base of this branch with `origin/main`. It is the `BASE_SHA` constant in
`scripts/template/collect-stage-five-evidence.ts` and `source.baseSha` in the
record; the reviewed implementation boundary is `source.implementationSha`.
Evidence-only commits may follow that boundary, but it must remain an ancestor of
`HEAD`, so the branch is never rebased or amended after a capture.

Run from the repository root:

```sh
bun scripts/template/collect-stage-five-evidence.ts capture \
  --implementation "$(git rev-parse HEAD)"
```

The collector creates two throwaway linked worktrees under
`${TMPDIR}/devenv-stage5a-<run id>/`, drives the real runtime against both, and
**always** runs `scripts/worktree/cleanup.sh` for each of them from an exit trap,
whatever happened — then removes the Git worktree registrations, the decoy
container, and the temporary root. A failed capture leaves logs for diagnosis and
no passing record.

The nineteen commands, in execution order:

| # | Command id | What it proves |
|---|---|---|
| 1 | `contract-guard` | The hermetic contract, devcontainer-coherence, script, persistence, ownership, and wiring guard passes on the real tree. |
| 2 | `hermetic-selftest` | The bounded downstream smoke passes with no engine and no network. |
| 3 | `contract-known-bad-fixtures` | The full worktree behaviour and contract-mutation suite passes. |
| 4 | `template-known-bad-fixtures` | Disabled-capability renders leave no runtime residue. |
| 5 | `worktree-a-environment` | Worktree A allocates an offset, writes both environment files, and reports its identity as JSON. |
| 6 | `worktree-b-environment` | Worktree B does the same and lands on a **disjoint** port set. |
| 7 | `worktree-a-ensure-cold` | A real `devcontainer up` builds and starts A's own container; the definition fingerprint is recorded. |
| 8 | `worktree-b-ensure-cold` | The same for B, against the same image layers, producing a second, different container. |
| 9 | `worktree-a-ensure-warm` | The lock-free fast path returns the identical container id in a fraction of the cold time. |
| 10 | `recreate-fast-path` | Changing a `.devcontainer` file changes the fingerprint, forces `--remove-existing-container`, produces a new container id; restoring it recreates again and the fast path then answers without another `up`. |
| 11 | `git-operations` | Git works inside the container for a **linked** worktree, because the shared Git common directory is mounted at its host path. |
| 12 | `ownership-attack-refusal` | A running container that carries this checkout's `local_folder` label but a foreign `config_file` label is refused, and the requested command provably never ran inside it. Exits non-zero by design. |
| 13 | `route-probe` | `up.sh` publishes the route and a real HTTP request reaches the container through the published loopback port, and through the friendly `.localhost` route when a host Caddy is present. |
| 14 | `persistence-probe` | Each checkout's persisted data root is its own: data written from A's container appears in A's checkout on the host and is absent from B's. |
| 15 | `authentication-round-trip` | The host-shared credential bind mount round-trips a token written from A's container to B's, while the per-worktree agent home volume stays isolated. |
| 16 | `volume-identity` | The `${devcontainerId}` this runtime computes is the one Docker actually used: every declared volume prefix appears as `<prefix>-<id>` on the real containers, and the two worktrees' ids differ. |
| 17 | `bridge-dispatch` | The bridge maps a nested directory, runs as the development user, preserves exact argv and the child exit status, and lands in *this* checkout's container. |
| 18 | `cleanup-isolation` | `cleanup.sh` in B removes B's container, volumes, manifest, route, registry entry, and state, reports nothing surviving — and A's container, route, and registry entry are untouched. |
| 19 | `rollback-proof` | A synthetic merge followed by `git revert -m 1` produces a tree identical to the predecessor. |

Command 12 is the only one expected to fail; it is recorded with status
`refused` and a non-zero exit code, and the validator rejects a record in which
it passed — a refusal can never be smuggled in as a pass, and a pass can never be
smuggled in as a refusal.

`authentication-round-trip` is defined against what this template actually
persists. `devcontainer.json` bind mounts
`~/.config/devcontainer/codex-auth/<slug>` into the container, shared by every
checkout of the project, while `/home/vscode/.codex` is a per-checkout
`${devcontainerId}` volume. The probe writes a token through A's container, reads
it back through B's, and proves the sibling agent-home marker is *not* visible —
so a login survives a rebuild and crosses worktrees, while live session state
does not leak between them. The probe file is removed from the host afterwards.

Every command's raw stdout and stderr is written to
`evidence/stage-5-worktree-run/<id>.{stdout,stderr}` and digested. The record is
written only after schema, command-binding, isolation, log-binding, and
Git-identity validation all pass. Hand-editing the record or a log breaks
`bun run template:validate`; the fix is to re-run the collector.

After a capture, confirm the host is clean:

```sh
docker ps -a  --filter 'label=devenv.stage5a.run' --format '{{.Names}}'   # empty
docker volume ls --format '{{.Name}}' | grep -c devenv-stage5a            # 0
git worktree list | grep devenv-stage5a                                   # empty
```

## Rollback

Stage 5A is one atomic bundle: the contract, the eleven runtime scripts, the
guard, the parameter surface, the two `devcontainer.json` entries, the sync and
ownership entries, the CI wiring, the documentation, and the evidence revert
together. Reverting only the contract, only `devcontainer.json`, or only one
script leaves a runtime that reads an authority that no longer describes it.

**Run cleanup first, while the runtime still exists.** After the revert there is
no script left that knows which containers, volumes, ports, manifests, and routes
belonged to which checkout, and a swept guess would take out sibling worktrees.

```sh
# 1. In EVERY live worktree, while scripts/worktree/ is still present:
bash scripts/worktree/cleanup.sh

# 2. Then revert the merge:
git revert -m 1 <stage-5a-pr-merge-commit>

# 3. Then remove whatever host state remains:
rm -rf ~/.config/devcontainer/ports-registry \
       ~/.config/devcontainer/worktrees \
       ~/.config/devcontainer/caddy

# 4. Then rebuild once, because .devcontainer changed again:
devpod up . --recreate
```

Step 4 is not optional for the same reason the adoption rebuild was not:
`.devcontainer/**` is a definition-fingerprint input, so removing the two added
entries changes the fingerprint back and `setup-proto.sh` will refuse to start an
existing container against the reverted definition.

The legacy entrypoint is untouched by this stage, so step 4 restores exactly the
pre-Stage-5A behaviour. The committed rollback proof binds the base and
implementation SHAs, the synthetic merge parent order, and the
predecessor/reverted tree identities.
