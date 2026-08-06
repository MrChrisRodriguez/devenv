# {{PROJECT_NAME}}

> Short description of this project.

## Getting started

```bash
bash scripts/worktree/up.sh                    # start this checkout's container
bash scripts/worktree/exec.sh bun install      # install dependencies inside it
```

Dependencies are installed **inside** the container, never on the host: Bun is not
a host prerequisite here, and a host `bun install` would write host-platform
binaries into the `node_modules` the container bind-mounts.

## Development

Created from the [devenv](https://github.com/MrChrisRodriguez/devenv) template.
See `AGENTS.md` and `CLAUDE.md` for shared conventions.

### Host prerequisites

The development container needs three things on the host, and nothing else:

- A container engine — Docker Desktop, or any daemon `docker` can talk to.
- The `devcontainer` CLI: `brew install devcontainer` on macOS, or
  `npm install --global @devcontainers/cli` on Linux and Windows. The runtime
  depends on reference-CLI behaviour — the `devcontainer.local_folder` and
  `devcontainer.config_file` ownership labels, per-invocation `--mount`,
  `--remove-existing-container`, and `${devcontainerId}` volume identity.
- `python3`, used only for atomic JSON registry and manifest writes. macOS ships
  it with `xcode-select --install`.

Bun is **not** a host prerequisite. It lives in the image, which is why the CLI is
installed with `brew` or `npm` and never with `bun add --global`.

### Parallel worktrees

Every checkout — the main clone and each linked `git worktree` — owns exactly
one container, one port set, one persisted data root, and one URL. Nothing is
shared between them except the repository's Git metadata, so two agents can work
on two branches at the same time without stepping on each other.

Keep **one clone of this project per host** and use linked worktrees for
parallelism. A second independent clone of the same repository derives the same
workspace identity as the first, so it would claim the same ports and the same
manifest path.

```sh
git worktree add ../feature-x -b feature-x
cd ../feature-x
bash scripts/worktree/up.sh          # environment, container, route, services
bash scripts/worktree/exec.sh <cmd>  # run a project command in this checkout
bash scripts/worktree/down.sh        # stop, keeping ports and data
bash scripts/worktree/cleanup.sh     # release everything this checkout owns
```

`up.sh` prints two URLs. The direct one, `http://127.0.0.1:<port>`, is always
published and always authoritative. The friendly one,
`http://<worktree>.<project>.localhost`, is a convenience served by an optional
host [Caddy](https://caddyserver.com) that imports every checkout's generated
snippet — add `import ~/.config/devcontainer/caddy/*.caddy` to your Caddyfile
once and every worktree routes itself from then on. Without Caddy the runtime
warns once and keeps going.

The host port is not random and not hand-assigned: `scripts/worktree/env.sh`
derives a candidate offset from the worktree's name and then has a host-global
registry (`~/.config/devcontainer/ports-registry/ports.json`) arbitrate it, by
comparing whole derived port sets rather than offsets, so two checkouts can
never overlap. `down.sh` keeps that reservation; only `cleanup.sh` returns it.

Run project commands through `bash scripts/worktree/exec.sh`. From the host it
reconciles this checkout's container and re-invokes itself inside it; already
inside the container it sources `.devcontainer/environment.sh`, activates Proto,
and runs in place. The same command line works from either side, and a nested
directory maps to the matching directory inside the container.

The git hooks use `bash scripts/worktree/exec.sh --require-ready`, which runs in
the container this checkout already has and exits **7** naming `up.sh` rather than
starting one — committing is not a build trigger. Run `up.sh` once and commits work
normally; `git commit --no-verify` is the escape hatch. `.devcontainer/devcontainer.json`
stays a fully spec-compliant definition, so an editor or the `devcontainer` CLI can
still open this folder, but only `up.sh` gives this checkout a stable port, a route,
isolation from sibling worktrees, and a manifest.

<!-- capability:start codex_cloud -->

### Codex Cloud

Codex Cloud is a second, already-containerized environment. Nothing wires it up
automatically: configure it once in the hosted environment settings, and every
other moving part is committed in this repository under `.codex/cloud/`.

1. Set `CODEX_CLOUD=true` in the hosted environment variables. The cloud scripts
   fail closed until it is present, so a fresh cache whose setup command was
   missing or failed refuses to run project commands instead of running them
   against an unprepared tree.
2. Use `bash .codex/cloud/bootstrap.sh` as both the setup command and the
   maintenance command. It is idempotent and bounded: tool installs are
   version-gated, the shell hook is appended exactly once, allow-listed secrets
   are upserted into a mode-`0600` file, and the run ends by recording an
   environment fingerprint and self-verifying through the doctor.
3. Leave agent internet access unrestricted. `.codex/cloud/contract.toml` records
   that posture next to every pinned tool version, architecture checksum,
   persisted path, and fingerprint input the scripts read.

Two profiles are available. `core` installs the Proto-pinned toolchain and the
frozen dependency set. `browser` adds the repository-pinned headless Chromium
payload and verifies it with the repository's unchanged browser preflight
command; select it by passing it to the bootstrap
(`bash .codex/cloud/bootstrap.sh browser`).

Run project commands through `bash .codex/cloud/exec.sh <command>`. It sources
the persisted cloud environment, runs the read-only doctor, and only then
executes the command in place. Never run Docker, container lifecycle, deployment,
or remote push commands from a cloud task.

<!-- capability:end codex_cloud -->

