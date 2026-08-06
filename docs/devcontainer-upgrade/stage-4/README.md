# Stage 4 Codex Cloud parity

Stage 4 gives Codex Cloud the same verified toolchain the local devcontainer
gets from its image, without Docker. Everything the hosted environment needs is
committed under `.codex/cloud/`: a machine-readable contract, one bounded and
idempotent bootstrap, a fail-closed read-only doctor, a direct-execution
boundary, and a hermetic selftest.

## Ownership contract

- `.codex/cloud/contract.toml` is the single machine-readable cloud authority.
  It is flat `key = "value"` TOML because the cloud scripts read it with `sed`
  before Proto, Bun, or `jq` exist, and because the renderer's capability fences
  are line based.
- The contract never invents a version. Every pinned value mirrors an existing
  repository authority: tool versions come from `.prototools`, architecture
  digests from `.devcontainer/proto-checksums.txt`, the Graphify pin and the
  browser pin from the Dockerfile build arguments, and the browser pin also from
  the `@playwright/test` catalog entry. `scripts/template/cloud-contract.ts`
  fails the build on any drift between them.
- Proto is installed by the one shared, checksum-pinned
  `.devcontainer/install-proto.sh`. There is no parallel cloud-only installer.
- `bash .codex/cloud/bootstrap.sh [profile]` is both the setup command and the
  maintenance command, so every step is safe to repeat. It installs only what is
  missing or mismatched, appends its shell hook exactly once, upserts persisted
  secrets rather than rewriting them, records an environment fingerprint, and
  then self-verifies by running the doctor.
- `bash .codex/cloud/doctor.sh` installs, downloads, and repairs nothing. It only
  reports whether the environment still matches the contract, and every refusal
  names the maintenance command that fixes it. The guard enforces that
  read-only-ness by scanning the file for installer tokens.
- The environment fingerprint hashes the profile plus the **committed** content
  of every declared `fingerprint_inputs` path (`git show HEAD:<path>`, with a
  working-tree fallback). Legitimate agent edits to `bun.lock` or `package.json`
  during a task therefore cannot make the pre-command doctor reject the rest of
  that same task.
- `bash .codex/cloud/exec.sh <command>` is the cloud command boundary. It sources
  the persisted environment, refuses with exit 3 when this is not a verified
  cloud environment, and otherwise runs `doctor.sh --quiet` on its own line so an
  unhealthy environment aborts under `set -e` before the requested command can
  execute.
- Cloud tasks never invoke `docker`, `devpod`, `devcontainer`, `wrangler deploy`,
  `git push`, or anything under `.devcontainer/host/`. The list lives in the
  contract's `forbidden_cloud_commands` and is enforced statically against every
  cloud script, restated in `AGENTS.md`, and structurally prevented by `exec.sh`.
- Only the contract's `secret_allow_list` plus any names in
  `CODEX_CLOUD_PERSIST_EXTRA_ENV` are bridged into the agent phase. They are
  written to a mode-`0600` file through `mktemp` and `mv -f`, and no value is
  ever echoed.
- The `browser` profile is an axis inside the `codex_cloud` capability, not a new
  fixture. It exists only when the `playwright` capability is selected, and it
  must satisfy the frozen Stage 3 handoff exactly: the same browser pin, the
  `PLAYWRIGHT_BROWSERS_PATH` environment variable, a `.devenv-playwright-version`
  marker under the payload root, and the repository's unchanged
  `bun run browser:preflight`. The `core` profile must not install a browser.

## Validation

The fast deterministic checks are:

```sh
bun run cloud:check
bash .codex/cloud/selftest.sh
bun test scripts/template/__tests__/cloud.test.ts
bun test scripts/template/__tests__/stage-four-evidence.test.ts
bun run template:validate
bunx tsc -p scripts/template/tsconfig.json
bunx biome check --no-errors-on-unmatched \
  scripts/template/cloud-contract.ts \
  scripts/template/validate-cloud.ts \
  scripts/template/stage-four-evidence.ts \
  scripts/template/collect-stage-four-evidence.ts \
  evidence/stage-4-cloud.schema.json
```

`bun run cloud:check` and `bash .codex/cloud/selftest.sh` are hermetic: they need
no network, no Docker, and no prepared cloud environment, so both run as required
CI steps. The selftest stubs every tool — including `uname` — inside a disposable
`PATH`, which is why it also passes on a macOS development host.

The networked `codex-cloud-smoke.yml` workflow runs the real bootstrap for both
profiles on a path filter, a schedule, and manual dispatch. It is deliberately
not part of any aggregate gate: `ci.network_smoke_is_required` is `false`, and a
registry outage must not fail unrelated pull requests.

### Rendered-fixture caveat

Running the guard against a **rendered** fixture reports exactly one error:

```
cloud: fingerprint input bun.lock is missing
```

This is expected by design. `bun.lock` has `renderPolicy: "omit"`, so a freshly
generated project has no lockfile until its first install; the CI workflow the
template ships installs dependencies before it runs `bun run cloud:check`. The
lockfile stays a fingerprint input because a dependency change must invalidate a
prepared cloud environment. Do not "fix" this by dropping `bun.lock` from
`fingerprint_inputs`.

## Live evidence capture

The collector must run on **Linux with network access** from a clean checkout of
the reviewed implementation boundary. A macOS development host cannot capture
this evidence: the bootstrap refuses any non-Linux kernel. Use a Linux CI runner
or a Linux container with the repository checked out inside it.

Prerequisites:

- Linux (`x86_64` or `aarch64`; both architectures are in the contract).
- Unrestricted network access for Proto, the tool installs, `uv`, the frozen
  dependency install, and the browser payload download.
- `git`, `curl`, `xz`, `unzip`, and CA certificates available before Proto is
  installed, plus passwordless privilege escalation if the browser profile has
  to install its own operating-system libraries.
- No uncommitted change to any cloud runtime input. The collector re-checks that
  `.codex/cloud/**`, `.prototools`, `.devcontainer/**`, `package.json`, and
  `bun.lock` are identical between the implementation boundary and `HEAD`.

The Stage 4 base boundary is `3a7f06415fe160e17c7c2592e04f7aa98c361d71`, the
merge-base of the Stage 4 branch with `origin/main`. It is recorded as the
`BASE_SHA` constant in `scripts/template/collect-stage-four-evidence.ts` and as
`source.baseSha` in the committed record; the reviewed implementation boundary is
`source.implementationSha`. Evidence-only commits may follow that boundary, but
it must stay an ancestor of `HEAD`, so the branch is never rebased or amended
after a capture.

Run from the prepared Linux environment:

```sh
bun scripts/template/collect-stage-four-evidence.ts capture \
  --implementation "$(git rev-parse HEAD)"
```

The collector derives, rather than duplicates, every command authority in
`expectedStageFourCommands`. It executes all 13 commands verbatim, in order, and
aborts on the first unexpected result:

1. The hermetic contract guard and the stubbed bootstrap/doctor/exec selftest.
2. The two known-bad fixture suites that own cloud contract mutations and
   disabled-capability residue.
3. A cold `core` bootstrap on an unprepared machine, an immediately repeated warm
   bootstrap, and a doctor run that proves the prepared environment is healthy.
4. A fresh-shell probe that runs the doctor with `CODEX_CLOUD` and
   `CODEX_CLOUD_PROFILE` unset, proving the persisted marker bridges a cold
   non-interactive shell, and that the `~/.bashrc` source line still appears
   exactly once after two bootstraps.
5. A cold `browser` bootstrap plus a browser doctor, which runs the repository's
   unchanged `bun run browser:preflight` against the payload marker.
6. A real stale-fingerprint refusal: the marker is corrupted, the doctor refuses,
   `exec.sh` refuses, the requested command provably does not execute, and the
   marker is restored.
7. A real unverified-environment refusal proving `exec.sh` exits 3 without
   executing anything.
8. A synthetic merge followed by `git revert -m 1`, proving the reverted tree
   equals the predecessor tree.

Raw stdout and stderr are written to `evidence/stage-4-cloud-run/`. Every log has
its SHA-256 recorded in `evidence/stage-4-cloud.json`. The JSON is written only
after schema, command-binding, authority, log-binding, and Git-identity
validation all pass, so a failed probe leaves logs for diagnosis but no passing
record. Tool pins, checksums, the browser pin, the fingerprint, the `~/.bashrc`
line count, the refusal exit codes, and the rollback trees are all parsed back
out of the actual command output — nothing is asserted that a log does not
support. Hand-editing the record or a log breaks `bun run template:validate`; the
fix is to re-run the collector.

The captured `browser.markerPath` is resolved against the capture host's `HOME`,
because the contract's payload root is `${HOME}/.payloads/browser`. The frozen
Stage 3 literal `/home/vscode/.payloads/browser/.devenv-playwright-version` is
carried separately as `browser.referenceMarkerPath` and checked against
`evidence/stage-3-runtimes.json`, so a cloud host with a different home directory
cannot quietly break the Stage 3 handoff.

## Rollback

Stage 4 is one atomic bundle: the contract, the four cloud scripts, the selftest,
the guard, the CI wiring, the ownership manifest entries, the documentation, and
the evidence must be reverted together. Reverting only a single pin or only the
contract leaves a prepared cloud environment whose fingerprint no longer matches
anything.

```sh
git revert -m 1 <stage-4-pr-merge-commit>
```

Then clean the runtime state inside any cloud environment that was already
prepared:

```sh
rm -f ~/.config/<project-slug>/codex-cloud.env
rm -f ~/.config/<project-slug>/codex-cloud-secrets.env
rm -rf ~/.cache/<project-slug>/codex-cloud
```

Finally remove the single `. "~/.config/<project-slug>/codex-cloud.env"` line the
bootstrap appended to `~/.bashrc`, and clear the hosted environment's setup,
maintenance, and `CODEX_CLOUD` settings. The committed rollback proof binds the
exact base and implementation SHAs, the synthetic merge parent order, and the
predecessor/reverted tree identities.
