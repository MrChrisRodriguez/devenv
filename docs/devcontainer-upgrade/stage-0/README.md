# Stage 0 baseline

Stage 0 records the pre-migration template and adds only template metadata,
fixture tooling, and evidence. It intentionally does not change the active
devcontainer runtime.

## Scope

- `template-parameters.toml` is the parameter and capability authority.
- `template-ownership.json` classifies template, project, generated, and
  evidence paths and records current synchronization boundaries.
- `fixtures/template/*.toml` define explicit minimal, cloud, and full profiles.
- `scripts/template/` validates parameters, renders fixtures atomically, and
  rejects disabled-capability residue.
- `evidence/stage-0-baseline.json` is the schema-validated measurement record.

The empty `services` registry is deliberate. The current template advertises
editor-forwarding ports, but it does not own an application service graph.
Adding speculative services would turn hints into unsupported runtime behavior.

## Measurement method

Measurements use the last pre-migration runtime commit in two detached,
equivalent worktrees. The harness uses an isolated home directory with empty
host-mount targets and no loaded project secrets. Every created container is
labeled with a unique evidence run ID; cleanup removes only containers and
volumes proven by those labels and only image tags created by the run. It never
uses Docker prune.

The clean and warm image builds succeeded. Fresh container startup failed in
the existing `onCreateCommand`: Proto reported that all 11 selected tool
installs failed, so readiness, successful devcontainer restart, and warm command
latency are recorded as unavailable with the failed command, exit code, and log
digest. The running but lifecycle-unready container supported a separately named
diagnostic exec-latency sample; it is not the warm-command performance budget.
Values are never replaced with zero or an estimate.

Absolute host paths, secret values, and environment contents are excluded from
committed evidence. Reproduction commands use symbolic worktree and isolated
home placeholders.

## Validation

Run the Stage 0 gates with Bun:

```sh
bun run template:validate
bun run template:test
bun run template:typecheck
bun run template:fixtures tmp/stage-0-fixtures
```

The test suite includes known-bad mutations for unknown registry fields,
escaping paths, capability dependency drift, service cycles, and disabled
capability residue. Invalid fixture input must fail before publishing output.

## Rollback

Rollback is observational because Stage 0 does not replace a runtime path.
Revert the Stage 0 commit bundle to remove the registry, renderer, fixtures,
inventory, and evidence. The pre-migration runtime SHA in the evidence remains
the recovery reference. Do not selectively revert only the evidence or
parameter registry because they are one reviewed baseline bundle.
