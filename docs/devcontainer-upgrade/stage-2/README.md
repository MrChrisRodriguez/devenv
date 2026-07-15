# Stage 2 reproducible devcontainer image

Stage 2 moves the selected toolchain and reusable runtime payloads into a
capability-aware, digest-pinned image. Container creation verifies that the
checkout still matches that image; it never installs, repairs, or reconciles
Proto at runtime.

## Ownership contract

- Root `.prototools` is the sole Proto tool and plugin authority.
- `.devcontainer/prototools.foundation` and
  `.devcontainer/prototools.auxiliary` are derived partitions. Their exact
  tool/plugin union must equal the root manifest with no duplicates, extras,
  omissions, version drift, or duplicated root settings.
- The image owns `/home/vscode/.proto`. The active devcontainer has no Proto
  volume or runtime bootstrap path.
- `.dockerignore`, `.prototools`, and every file under `.devcontainer/` form
  the complete definition fingerprint. The image records that fingerprint and
  the root-manifest digest under `/usr/local/share/devenv-image/`.
- Direct binary downloads use exact owner ARGs and reviewed architecture
  checksums. The base image and Dockerfile frontend use immutable digests.
- Optional Graphify, Codex, Gemini, Claude, ccstatusline, and Playwright
  payload stages and their final `COPY` operations are selected by rendered
  capabilities. Disabled profiles contain no corresponding Docker residue.

`.devcontainer/on-create/setup-proto.sh` compares both markers with the mounted
checkout and verifies image-owned Proto and Bun by absolute path and resolved
location. It passes the image-owned Proto Bun explicitly to the fingerprint
helper and invokes lifecycle/verification shells and utilities by absolute
system path, so workspace-local contract binaries cannot forge the definition
marker. Any mismatch fails with a rebuild/recreate diagnostic. The scoped host cleanup
helper removes only an exact, unattached legacy
`proto-home-<devcontainer-id>` volume.

## Validation

The fast deterministic checks are:

```sh
bun scripts/template/validate-image.ts
bun test scripts/template/__tests__/image.test.ts
bun test scripts/template/__tests__/image-evidence.test.ts
bunx tsc -p scripts/template/tsconfig.json
bunx biome check --no-errors-on-unmatched \
  scripts/template/image-evidence.ts \
  scripts/template/collect-stage-two-evidence.ts \
  scripts/template/__tests__/image-evidence.test.ts \
  evidence/stage-2-image.schema.json
```

The image contract includes negative mutations for partition drift, malformed
architecture hashes, mutable download URLs, PATH inversion, runtime Proto
mutation, reintroduced Proto mounts, and disabled capability residue.

## Live evidence capture

The live collector requires Docker Buildx, working amd64/arm64 emulation or
builders, Bun, Git, a clean implementation HEAD, and the Stage 0 baseline. The
alternate Codex version must be a real exact version different from the
Dockerfile pin.

The reviewed pre-evidence implementation boundary is
`47ed0f3f8b6a978dfdb803856c3d5a01fa6e83e0`, based on
`4367bad6e2cb49e4c969a61b892634347ed0bf24`. Evidence-only commits may follow
that boundary, but the collector proves that `.dockerignore`, `.prototools`,
and `.devcontainer/**` have not changed since it.

Run from a clean descendant containing the evidence collector:

```sh
bun scripts/template/collect-stage-two-evidence.ts capture \
  --base 4367bad6e2cb49e4c969a61b892634347ed0bf24 \
  --implementation 47ed0f3f8b6a978dfdb803856c3d5a01fa6e83e0 \
  --alternate-codex-version <exact-available-version>
```

The collector derives, rather than duplicates, the command authority in
`expectedStageTwoCommands`. It executes all 16 commands verbatim and aborts on
the first nonzero exit:

1. Clean and warm native image builds.
2. Definition fingerprint, image identity, and baked marker inspection.
3. A one-owner Codex-pin cache invalidation build.
4. Complete cache-disabled amd64 and arm64 builds that execute the
   architecture-sensitive base, Proto, Claude, and final stages.
5. A real stale-definition refusal in a disposable worktree/container while
   malicious workspace-local Bun, Bash, and checksum utilities attempt to
   print the baked marker and poisoned environment overrides point at a
   pristine decoy checkout plus attacker-controlled markers. The probe invokes
   the real startup-scrubbed on-create lifecycle and rejects pre-verification
   tool, `BASH_ENV`, and exported-function sentinels.
6. A real missing-foundation-uv partition mutation.
7. Bash and Zsh login/non-login PATH probes.
8. Two real containers over two worktrees, with image identity, writable-layer,
   checkout, volume, Proto-mount, and image-Proto measurements.
9. A real synthetic merge followed by `git revert -m 1`, proving the reverted
   tree equals the predecessor tree.

Raw stdout and stderr are written to `evidence/stage-2-image-run/`. Every log
has its SHA-256 recorded in `evidence/stage-2-image.json`. The JSON is written
only after schema, semantic, command-binding, and raw-log validation all pass;
failed probes leave logs for diagnosis but no passing evidence record. Build
durations, cache hits, stage invalidation, image/container identities, storage
bytes, refusal exit codes, diagnostics, and rollback trees are parsed from
actual command output—zeroes or estimates are not substituted for unavailable
observations. JSON probes are deep-compared with their raw logs; cache counts
and storage totals are recomputed; rollback trees, deterministic merge
metadata, and parent order are rederived from Git.

The storage comparison uses Stage 0's captured `96,111,608` byte
second-worktree baseline. Probe cleanup removes only the exact disposable
containers and worktrees it created. It never invokes a global Docker prune.

## Rollback

Stage 2 is one atomic bundle: Docker stages, root and derived manifests,
markers, fingerprint inputs, Proto-volume removal, runtime refusal, capability
rendering, and guards must be reverted together.

```sh
git revert -m 1 <stage-2-pr-merge-commit>
docker ps -aq --filter label=com.devenv.evidence.run=<captured-run-id>
docker rm -f <only-run-labeled-container-ids>
docker volume ls -q --filter label=com.devenv.evidence.run=<captured-run-id>
docker volume rm <only-run-labeled-volume-names>
docker image rm <captured-stage-2-image-tag>
devpod up . --recreate
```

Resolve the label queries first and pass only their exact results to removal
commands. Do not use `docker system prune`, remove unrelated volumes, or revert
only the Proto volume change. The committed rollback proof binds the exact base
and implementation SHAs, synthetic merge parent order, and predecessor/reverted
tree identities.
