# Troubleshooting

Symptoms that look like defects and are not, and the two or three that are.

Each entry names the mechanism rather than the fix alone, because every one of
these has been diagnosed twice by somebody who could not tell a designed
behaviour from a bug.

---

## `exec.sh --require-ready` exits 7 and a commit is refused

**This is the designed behaviour, not a broken hook.**

The Git hooks run project commands through
`bash scripts/worktree/exec.sh --require-ready`. That flag uses the container
this checkout **already** has and refuses to start one: it exits **7** and names
`up.sh` in the message.

The reason is that a container build takes minutes and a commit takes seconds.
A hook that started a container would turn `git commit` into a build trigger,
and the first person to hit it on a slow morning would delete the hook.

```bash
bash scripts/worktree/up.sh   # once, then commits work for the life of the checkout
```

`down.sh` stops the container but keeps its ports, data and identity, so a
commit after `down.sh` will exit 7 again until the next `up.sh`. Only
`cleanup.sh` releases the reservation.

---

## The container rebuilds after a change you thought was cosmetic

**Anything under `.devcontainer/` is a container-definition fingerprint input,
including comments.**

The runtime derives a definition fingerprint from `.dockerignore`,
`.prototools` and the whole of `.devcontainer/`, and a changed fingerprint means
every existing container for the project is recreated on its next `up.sh`. A
comment-only edit to a file in that directory costs exactly as much as a
`Dockerfile` change, because the fingerprint is over bytes and not over meaning.

The inputs are declared once, in `scripts/worktree/contract.toml`:

```toml
definition_fingerprint_inputs = [".dockerignore", ".prototools", ".devcontainer"]
```

If a rebuild surprises you, `git diff` those three paths first. If a change
under `.devcontainer/` is genuinely cosmetic and the rebuild is unwanted, the
answer is to batch it with the next change that needs one — not to remove the
path from the fingerprint, which would let a real definition change ship into a
stale container.

---

## Two clones of the same project collide

**Keep one clone of a project per host and use linked worktrees for parallel
work.**

Every checkout derives its identity — its port set, its route, its persisted
data root and its manifest path — from the project and workspace names. A second
**independent clone** of the same repository derives the *same* identity as the
first, so the two compete for one port reservation and one manifest.

Linked worktrees are the supported way to work on several branches at once:
each one is a distinct workspace and gets its own container, ports, data root
and URL.

```bash
git worktree add ../myproject-featurex featurex
cd ../myproject-featurex && bash scripts/worktree/up.sh
```

This is a documented rule rather than an enforced one: the runtime cannot tell a
second clone from a first one, because from inside either checkout they look
identical.

<!-- capability:start codex_cloud -->
---

## `cloud:check` reports `fingerprint input bun.lock is missing`

**Expected in a freshly generated project, and it is not a defect.**

`bun.lock` is deliberately omitted when a project is generated from the
template: a lockfile is a statement about *your* dependency set, and inheriting
the template's would pin packages you never chose. The cloud contract lists
`bun.lock` among its fingerprint inputs because that is the correct list for a
project that has installed once.

Run an install and the message goes away:

```bash
bash scripts/worktree/exec.sh bun install
```

Do **not** resolve it by dropping `bun.lock` from the cloud contract's
fingerprint inputs. That would make the cloud environment stop noticing a real
dependency change, which is the thing the fingerprint exists to catch.

<!-- capability:end codex_cloud -->

---

## The generated project has fewer files than the template

**That is the capability model working.**

A generated project receives only the surfaces its profile enables. Guards for
capabilities you did not turn on are omitted along with their package scripts,
their workflow steps and their agent instructions, so nothing in the tree
refers to a file that is not there. `fixture-manifest.json` in a rendered
fixture records exactly what was emitted and what was left out, and why.

Template-only tooling — the fixture definitions, the golden render manifests and
the release gate that compares them — is omitted from every profile, because its
inputs do not exist in a generated project and a command whose inputs are absent
is worse than no command at all.

---

## Where to look next

| Question | Where it is answered |
|---|---|
| What a capability turns on or off | `template-parameters.toml` and `docs/devcontainer-upgrade/stage-0/template-ownership.json` |
| Why a file is owned by the template or by the project | the `ownershipRules` list in that same file |
| What the runtime reads about itself | `scripts/worktree/contract.toml` |
| Whether this checkout is healthy | `bash scripts/worktree/doctor.sh` and `--json` for a machine-readable answer |
| What each guard refuses | the `## … Ownership` sections of `AGENTS.md` |
