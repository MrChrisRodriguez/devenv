# {{PROJECT_NAME}}

> Short description of this project.

## Getting started

```bash
bun install
```

## Development

Created from the [devenv](https://github.com/MrChrisRodriguez/devenv) template.
See `AGENTS.md` and `CLAUDE.md` for shared conventions.

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
executes the command in place. Never run Docker, DevPod, devcontainer lifecycle,
deployment, or remote push commands from a cloud task.

<!-- capability:end codex_cloud -->

