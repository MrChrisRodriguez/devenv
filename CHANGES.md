# Changelog

This file documents changes made to this template repository. Each entry provides enough detail for downstream projects (repos based on this template) to adopt the same change manually.

---

## 2026-07-14 — Fix: close Stage 2 adversarial evidence gaps

**Goal:** Prevent a workspace binary from forging the image-definition check and make the recorded architecture, storage, cache, and rollback evidence reject cached or fabricated observations.

**How to implement:** Resolve Proto and the versioned native Bun executable through fixed, absolute image-owned paths only after validating the mounted root manifest against its baked checksum; never compute the fingerprint through Proto's environment-sensitive shim. Pass that Bun explicitly to the fingerprint helper and reject any tool path that escapes the baked Proto root. Invoke the lifecycle shell and verification utilities through absolute system paths so workspace-local Bash, readlink, sha256sum, awk, or tr binaries cannot intercept the contract. Prove the boundary with a changed devcontainer definition plus malicious `/workspace/node_modules/.bin` contract tools that print the baked marker. Run each supported-architecture evidence build with cache disabled and require the architecture-sensitive base, Proto, Claude, and final stages to execute. Deep-bind JSON probe records to their hashed raw logs, recompute cache counts and storage arithmetic, compare the Stage 0 storage baseline, use deterministic synthetic-merge metadata, and derive rollback trees and parent order from the real Git boundary.

The immutable remediated implementation boundary is `36a97dabc7ff6de870e574f33792c7d55f973ba5`; evidence-only commits follow it without changing image inputs.

The replacement run `stage2-20260715t080439z-9f48b8ee` executed both supported architectures without cache, refused the shadow-Bun definition attack, measured 4,403,200 bytes of second-worktree growth against the 96,111,608-byte Stage 0 baseline, and restored the actual predecessor tree through the deterministic mainline-revert proof.

**Changed files:**
- `.devcontainer/devcontainer-fingerprint.sh`, `.devcontainer/on-create/setup-proto.sh` — absolute image-owned fingerprint execution and realpath enforcement.
- `scripts/template/image-evidence.ts`, `scripts/template/collect-stage-two-evidence.ts`, evidence schema/tests — uncached architecture proof and non-vacuous log/Git/metric validation.
- `docs/devcontainer-upgrade/stage-2/README.md`, `scripts/template/image-contract.ts`, image tests — operator contract and regression guards.

## 2026-07-14 — Add: reproducible payload-oriented devcontainer image

**Goal:** Move the complete development toolchain out of per-container mutation and into independently cached, capability-rendered image payloads. Every image download, Proto partition, retained feature, marker, and runtime verification path now has one exact owner, while stale definitions fail closed instead of silently repairing themselves.

**How to implement:** Build from digest-pinned Docker syntax and base images, install stable system tools once, split the root Proto tool/plugin set into exact foundation and auxiliary cache partitions, and assemble isolated Graphify, Playwright, Codex, Gemini, ccstatusline, Claude/node-gyp, and pinned Zinit payload stages. Copy each complete payload before creating its relative launcher symlink in the final image so Docker never dereferences a global-package link and drops runtime dependencies. Keep `.prototools` user-facing, prove both partition unions equal it, and keep `~/.proto` image-owned by removing its active volume. Restrict the build context to `.dockerignore`, `.prototools`, and `.devcontainer`; hash those complete inputs including modes and symlink targets into read-only image markers; make on-create verify the markers and payload paths without installation or ownership repair. Pin every direct artifact by Docker ARG and architecture checksum, reject unsupported architectures and mutable URLs, isolate Renovate updates, retain only digest-locked GitHub CLI, and provide exact-ID unattached legacy Proto-volume cleanup. Normalize Bash and Zsh login profiles so repository-local binaries and Proto shims precede global launchers in every shell mode. Keep prior-stage evidence sealed to its recorded implementation and merge snapshots so later, unrelated source changes cannot invalidate an already reviewed historical run. Bind the Stage 2 run to immutable base and implementation commits, derive all clean/warm/architecture/invalidation/shell/storage/rollback commands from one validator authority, safely replace only the collector-owned raw-log directory on retries, bypass cache only for the mutated Codex owner and final assembly so repeated invalidation proofs remain non-vacuous, retain raw log digests, parse probe diagnostics from their JSON values so multiline output binds exactly, and publish evidence only after schema, semantic, and command-binding validation succeeds. Make that sealed evidence part of the required template validation gate. Render browser and agent stages only for selected capabilities, run `image:check` in generated CI, and require a real selected-target Docker build. Roll back the image, devcontainer definition, partitions, runtime verification, and feature lock together; never restore the Proto volume without reverting the entire ownership model.

**Changed files:**
- `.devcontainer/Dockerfile`, `.devcontainer/prototools.*`, `.dockerignore`, `renovate.json` — staged image payloads, exact download ownership, cache partitions, and restricted context.
- `.devcontainer/devcontainer.json`, `.devcontainer/devcontainer-lock.json`, `.devcontainer/devcontainer-fingerprint.sh` — retained feature, image-owned Proto, and complete definition markers.
- `.devcontainer/on-create*`, `.devcontainer/configs/.zshrc`, `.devcontainer/host/cleanup-legacy-proto-volume.sh` — fail-closed verification, immutable shell setup, and scoped legacy cleanup.
- `scripts/template/image-contract.ts`, renderer/tests, `.github/workflows/ci.yml`, `AGENTS.md` — rendered guard, negative mutation proof, real image build gate, and ongoing ownership rules.
- `scripts/template/image-evidence.ts`, `scripts/template/collect-stage-two-evidence.ts`, `evidence/stage-2-image*.json`, `docs/devcontainer-upgrade/stage-2/README.md` — command-bound capture, strict evidence validation, storage comparison, and atomic rollback proof.

## 2026-07-14 — Add: exact repository toolchain and dependency contract

**Goal:** Make the template's repository toolchain reproducible before changing the image architecture. Every selected Proto tool, project CLI, shared dependency, devcontainer feature, supported Proto archive, and TypeScript alias now has one exact visible authority, with fail-closed guards and machine-readable evidence.

**How to implement:** Exact-pin `.prototools` and replace community plugin branches with immutable commits; make Proto own selected Node and remove the competing feature; verify the exact Proto archive against per-architecture SHA-256 metadata before extraction. Invoke the installer on every create so partial persistent-volume installs self-repair, and require both Proto executables before the fast path. Move project packages into the root catalog, convert non-peer consumers to `catalog:` while permitting compatible catalog-owned peer ranges, regenerate `bun.lock`, and keep workspace-local binaries first. Commit the devcontainer feature digest lock, render config-relative `${configDir}` TypeScript aliases without `baseUrl`, and omit optional package authorities and their guard branches from disabled fixtures. Ship the live guard into rendered projects and recursively scan every non-generated manifest, TypeScript config, package lock, workflow, and local composite action outside ignored build/cache trees; validate every setup-bun action independently with case-insensitive action-repository matching and keep Cloudflare runtime packages lock-owned. Biome-format transformed output before computing its manifest, and make fresh generated CI prove its first project-owned lock, live guard, and retained lint step before freezing later installs. Run the repository/evidence validator, executed known-bad mutation suite, frozen install, generated-project guard, fixture generation, strict template typecheck, and Biome. Bind run IDs, timestamps, raw stdout/stderr artifacts, their recomputed digests, and observed diagnostics into the reviewed implementation boundary. Combine the isolated DevPod stop/remove/volume-delete/recreate exercise with a deterministic synthetic merge revert whose parents and tree are recomputed from the reviewed commits, whose reverted tree exactly matches the actual predecessor tree, and a predecessor image check proving Node resolves from the restored feature with no Proto Node shim. Upgrade Cloudflare, Better Auth, RHF/Zod, or Playwright only as an atomic family. Roll back the merge bundle by stopping the workspace, removing the exact stopped container to release its volume references, reverting with `git revert -m 1 <stage-1-pr-merge-commit>`, removing only the captured project Proto volume, and recreating; never revert a pin, catalog, lock, checksum, or coupled-family member alone.

**Changed files:**
- `.prototools`, `.devcontainer/install-proto.sh`, `.devcontainer/proto-checksums.txt` — exact Proto selection, immutable plugins, and fail-closed architecture checksum bootstrap.
- `package.json`, `bun.lock`, `.devcontainer/devcontainer-lock.json` — exact catalog consumers, singleton package families, and digest-pinned features.
- `.devcontainer/**`, `.github/workflows/ci.yml` — one frozen root install, local-bin PATH precedence, local CLI use, and the Stage 1 CI contract gate.
- `tsconfig*.json`, `scripts/template/**`, `template-parameters*`, `fixtures/template/**` — config-relative aliases, capability-aware package ownership, live guards, and non-vacuous mutation tests.
- `evidence/stage-1-toolchain*.json`, `docs/devcontainer-upgrade/stage-1/README.md`, `AGENTS.md` — strict evidence, operator contract, rollback, and ongoing change rules.

## 2026-07-14 — Add: Stage 0 portable devcontainer baseline

**Goal:** Establish a reproducible, reviewable pre-migration baseline without changing the active devcontainer runtime. The baseline must make template inputs and ownership visible, prove disabled-capability omission, and preserve failed measurements honestly so later stages can compare performance, storage, and reliability against observed behavior.

**How to implement:** Validate `template-parameters.toml` and its schema, keep application services empty until a generated project owns a real service graph, and render the explicit minimal/cloud/full fixtures through `scripts/template/`. Use the ownership inventory to omit project-owned, generated, and template-only evidence paths; strip template-only CI blocks, remove capability-owned package entries, require fixture filename/identity agreement, canonicalize output aliases, protect worktree/common Git metadata, and derive generator-inventory coverage from the lifecycle entrypoint. Run the Bun validation, test, typecheck, and fixture commands; capture image builds and two isolated legacy worktrees using uniquely labeled Docker resources; publish the schema-validated evidence with command/log digests and an observational rollback that rejects active runtime-path changes through the immutable Stage 0 boundary. Merge the stage with a merge commit so that boundary remains reachable, and roll it back with `git revert -m 1 <merge-commit>`. Do not prune Docker or stage Graphify output.

**Changed files:**
- `template-parameters.toml`, `template-parameters.schema.json` — project, path, port, toolchain authority, capability, CI, worktree, and generation contracts.
- `fixtures/template/*.toml`, `scripts/template/**` — deterministic atomic fixture rendering, validation, and known-bad mutation tests.
- `docs/devcontainer-upgrade/stage-0/**` — ownership inventory, synchronization risks, measurement method, and rollback.
- `evidence/stage-0-baseline*.json`, `scripts/template/evidence.ts` — machine-readable measured evidence, strict schema, anti-vacuity checks, commit-lineage proof, and observational runtime-diff validation pinned to an immutable Stage 0 boundary.
- `package.json` — Bun entry points for the Stage 0 gates.
- `.github/workflows/ci.yml` — required Stage 0 schema, mutation, typecheck, fixture, and full-history commit-lineage gate.

## 2026-07-14 — Plan: portable devcontainer upgrade contract

**Goal:** Convert the approved `devcontainer-updates` migration kit into repository-native, testable OpenSpec contracts before changing template runtime behavior. The review found mutable Proto plugin URLs and package versions, runtime/global installers, a per-container Proto volume, fixed ports, Docker-in-Docker, permissive CI, and no verified worktree or Codex Cloud execution boundary.

**How to implement:** Apply the active `portable-devcontainer-upgrade` change in the ordered PR groups in `openspec/changes/portable-devcontainer-upgrade/tasks.md`. Begin with inventory/parameters and a measured baseline, then land the toolchain, image, agent/browser, cloud, additive worktree, cutover, doctor, CI, Moon, OpenSpec, conditional stack, and final-release stages from the latest green `main`. Each PR must include its implementation, required guard, known-bad mutation, documentation/agent rules, rollback, and exact-head evidence; disabled capabilities must generate no residue. Keep this OpenSpec change active through shipping and archive it only after the final implementation PR merges from a clean current default branch.

**Changed files:**
- `openspec/changes/portable-devcontainer-upgrade/proposal.md` — motivation, capability list, breaking cutovers, and impact.
- `openspec/changes/portable-devcontainer-upgrade/design.md` — version ownership, image/runtime architecture, execution boundaries, worktree safety, CI rollout, risks, and migration order.
- `openspec/changes/portable-devcontainer-upgrade/specs/*/spec.md` — seven capability contracts with positive and negative scenarios.
- `openspec/changes/portable-devcontainer-upgrade/tasks.md` — 82 verifiable tasks grouped into independently reviewable implementation stages.

## 2026-06-10 — Change: export devcontainer secrets to children + re-sync /etc/environment on start

**Problem:** Secrets had two load paths and a late-added key (one appended to the host secrets file *after* the container was created) fell through both. (1) `/etc/environment`, written by `on-create.sh`, is captured once at create and goes stale — new keys never land there until a rebuild. (2) `configs/.shell_common` re-sourced the file every interactive shell (so it *saw* late keys) but used a plain `source`, so the values stayed local to that one zsh and child processes (Claude Code, `wrangler`, `!`-bash, tool subshells) didn't inherit them. Net: the persistent exported copy was missing the key and the per-shell copy that had it never exported it.

**What changed:**
1. **`configs/.shell_common`** now wraps the two secrets `source` lines in `set -a` / `set +a` — identical to the warp-env block just below it (whose comment already documented this exact pitfall). Any new shell now exports all secrets, including ones added after create, to its children. Takes effect in new shells, no rebuild.
2. **New `.devcontainer/on-create/setup-secrets.sh`** owns secrets loading: it exports the host-mounted common + per-project secrets into the current process **and** mirrors them into `/etc/environment` idempotently — it replaces a marker-delimited block (`# >>> devcontainer-secrets >>>` … `<<<`) instead of appending, so re-runs never accumulate duplicates. `on-create.sh` now **sources** it (so create-time tool installers still inherit API keys like `GEMINI_API_KEY`), and it also runs from **`postStartCommand`**, so keys added after create re-sync to `/etc/environment` on the next container start (no rebuild). It stays in onCreate *and* postStart — not "instead of" — because the installers need secrets present during setup.

**Why downstream cares:** To adopt manually — wrap your `.shell_common` secrets `source` lines in `set -a`/`set +a`; copy `setup-secrets.sh`; replace the inline secrets block in `on-create.sh` with `source .../setup-secrets.sh`; and prepend `bash /workspace/.devcontainer/on-create/setup-secrets.sh;` to your `postStartCommand`. After adding a key to the host secrets file: open a **new shell** for terminal processes, and **restart** the container (or run `bash .devcontainer/on-create/setup-secrets.sh`) to refresh `/etc/environment` for the extension host.

**Changed files:**
- `.devcontainer/configs/.shell_common` — `set -a`/`set +a` around the secrets source lines.
- `.devcontainer/on-create/setup-secrets.sh` — new; idempotent export + `/etc/environment` block sync.
- `.devcontainer/on-create.sh` — inline secrets block replaced by `source`-ing the new script.
- `.devcontainer/devcontainer.json` — `postStartCommand` re-syncs secrets before `bun install`.

## 2026-06-10 — Change: drop the template graph when scaffolding a new project

**What changed:** `init-new-project.sh` now `rm -rf graphify-out` in its template-only cleanup block (alongside `bun.lock`, `CHANGES.md`, `init-host.sh`). The committed graph describes the template's own scaffolding — `apps/` and `libs/` ship empty (`.gitkeep`), so every node is plumbing (`init-*.sh`, tsconfigs, `.husky/`, devcontainer scripts), none of it the code a child will write. Inherited into a child it's misleading (`graphify query` returns scaffolding nodes and omits the child's real code until a rebuild) and bloats the initial commit by ~1.3 MB. A graph-less child degrades cleanly — the agent rule files gate on "when `graphify-out/graph.json` exists" — and the first `/graphify` run builds a graph of the child's own code.

**Why downstream cares:** Existing repos are unaffected (this only touches project *creation*). The `.gitattributes`/`.gitignore`/pre-commit guardrails added in the entry below stay inert until the child builds its first graph, then apply to *its* graph as intended.

**Changed files:**
- `init-new-project.sh` — `rm -rf graphify-out` in the template-only removal block.

## 2026-06-10 — Change: keep the committed graphify graph out of review diffs

**What changed:** Three guardrails so `graphify-out/` ships to every clone (its original benefit) but can never bloat a diff or get committed by accident:

1. **New root `.gitattributes`** marks every committed graphify artifact `-diff linguist-generated` — Git renders them as "Binary files differ" instead of expanding 500k-line diffs, and GitHub collapses them in PRs and excludes them from language stats. Beyond the four rules from the upstream source (graph.json, manifest.json, GRAPH_REPORT.md, .graphify_*.json), this repo also commits `graph.html` (~674 KB), `cache/**`, and dated snapshot dirs, so rules for those were added too. Inert until `graphify-out/` exists — safe to ship unconditionally.
2. **`graphify-out/GRAPH_REPORT.md.tmp`** added to the root `.gitignore` graphify block (the transient temp written during report regeneration). The block's existing decision — `graph.json`/`graph.html`/`GRAPH_REPORT.md`/`cache/` stay **committed** — is unchanged; we did not adopt the upstream's "ignore cache/" stance.
3. **A `pre-commit` guard** (in `.husky/pre-commit`, ahead of `lint-staged`) rejects a commit that stages `graphify-out/graph.json` alongside any non-graphify file. A pure `chore(graphify)` graph-refresh commit passes. A matching one-line rule was added to the graphify section of `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.

**Why downstream cares:** Projects created from this template are *born* with `graphify-out/` tracked (init-new-project copies it; sync-devcontainer excludes it). To adopt manually: copy the root `.gitattributes`, append the two `graphify-out/` lines to your `.gitignore` and the pre-commit guard block to `.husky/pre-commit`, and add the "never `git add graphify-out/` in a feature commit" bullet to your agent rule files. The guard runs under `sh`; it uses plain `grep` (no `-q`/`-v` combo) so it's portable across grep implementations.

**Changed files:**
- `.gitattributes` — new; `-diff linguist-generated` for graph.json, graph.html, manifest.json, GRAPH_REPORT.md, .graphify_*.json, cache/**, and snapshot dirs.
- `.gitignore` — added `graphify-out/GRAPH_REPORT.md.tmp`.
- `.husky/pre-commit` — guard rejecting mixed graph+feature commits, before `lint-staged`.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — one-line graphify-commit-hygiene rule.

## 2026-06-10 — Change: update default ccstatusline layout

**What changed:** Reworked the seeded ccstatusline layout in `.devcontainer/ccstatusline-settings.json` to **model · thinking-effort · git-branch · context-percentage · (flex) · claude-session-id** (`flexMode: full-until-compact`, `colorLevel: 3`), replacing the previous model · context-length · git-branch · git-changes layout. This is the config new containers seed on a fresh `~/.config` volume. The committed seed intentionally omits ccstatusline's `installation` metadata block (`{method:"pinned", installedVersion:…}`) — it's per-install state ccstatusline writes itself, and pinning a version in the shared seed would fight the `bun add -g ccstatusline` (latest) install.

**Why downstream cares:** Existing repos already have a seeded `~/.config/ccstatusline/settings.json` and won't be overwritten (the setup script never clobbers an existing config). To adopt the new layout in an existing container, copy `.devcontainer/ccstatusline-settings.json` over `~/.config/ccstatusline/settings.json`, or edit it via `ccstatusline` (the TUI configurator).

**Changed files:**
- `.devcontainer/ccstatusline-settings.json` — new default layout.

## 2026-06-10 — Fix: new repos get the ccstatusline status line automatically

**What changed:** A freshly-created repo built its container with the `ccstatusline` binary installed but Claude Code still showed its default status line. Two gaps caused this: (1) **nothing wrote the `statusLine` block into the container's `~/.claude/settings.json`** — `setup-ccstatusline.sh` only installed the binary, and `~/.claude` is a fresh per-project Docker volume on a new repo, so the key was simply absent; (2) the layout seed was copied from `/workspace/.ccstatusline-settings.bak`, which is **`.gitignore`d and not committed**, so it never travelled with the template (it was a transient relay file, not a real seed). `setup-ccstatusline.sh` now (a) seeds the layout from a committed `.devcontainer/ccstatusline-settings.json`, and (b) merges the `statusLine` block into `~/.claude/settings.json` via `jq` — creating the file if absent, preserving any existing keys, and never clobbering a `statusLine` the user set by hand.

**Why downstream cares:** Any repo already created from the template won't retroactively get the status line. To adopt manually: copy the two changed files below, then either rebuild the container or run `bash .devcontainer/on-create/setup-ccstatusline.sh`. Or just add this to `~/.claude/settings.json` inside the container: `"statusLine": {"type":"command","command":"ccstatusline","padding":0,"refreshInterval":10}` (and `bun add -g ccstatusline` if the binary is missing).

**Changed files:**
- `.devcontainer/on-create/setup-ccstatusline.sh` — seed layout from the committed config; merge `statusLine` into `~/.claude/settings.json` with `jq` (idempotent, non-clobbering).
- `.devcontainer/ccstatusline-settings.json` — new committed layout seed (model · context · git branch · git changes), replacing the gitignored `.bak`.
- `.devcontainer/on-create.sh` — corrected the comment above the ccstatusline step (it now actually writes the statusLine block).

## 2026-06-10 — Change: restructure `README.md` into setup-stage sections

**What changed:** Removed the incomplete "Quick Start (Mac)" block (it was confusing because it duplicated and diverged from the fuller instructions below it). Reorganized the README into four clearly-labeled stages — **Host Machine Setup** (macOS automated via `init-host.sh` vs. Windows/Linux manual steps), **Repository Configuration** (clone + `init-new-project.sh`, with the arg behaviors in a table), **Secrets** (two-tier table + `secrets.example` copy flow + `GITHUB_TOKEN` rate-limit tip), and **Starting the Dev Container**. Documented that the **first build must use `devpod up . --recreate`** to provision cleanly, that you then `devpod ssh .` to connect, and that the first build should be run from a Warp terminal so the Warp env capture works. Replaced the raw trailing tool/toolchain lists with a linked "What's Included" section.

**Changed files:**
- `README.md` — full rewrite of structure (content preserved/expanded; no behavior change to scripts).

## 2026-06-02 — Add: package.json infra-key warning in `sync-devcontainer.sh`

**What changed:** Because `package.json` is project-owned (the sync keeps your version), template-managed config embedded in it — `lint-staged`, `commitlint`, and the husky `scripts.prepare` — can silently go missing downstream, which makes the husky `pre-commit`/`commit-msg` hooks fail (`lint-staged could not find any valid configuration`). The sync now checks your `package.json` against the template's for those keys after the file pass and prints a paste-ready warning for any that are missing, plus the `bun add -D …` line for the matching dev deps.

**Changed files:**
- `scripts/sync-devcontainer.sh` — new `check_pkg_infra()` (runs via `bun`/`node`, with a grep-only fallback) called at the end of the file-sync step; warns with the template's actual values for missing `lint-staged`/`commitlint`/`scripts.prepare`.

## 2026-06-02 — Add: `README.template.md` (new repos get a project README, not the template's)

**What changed:** New projects no longer inherit the template's own README. `init-new-project.sh` now renders `README.template.md` into the new repo's `README.md` (substituting `{{PROJECT_NAME}}`) and removes the template file. The sync excludes README files so a project's README is never overwritten.

**Added files:**
- `README.template.md` — minimal starter README with a `{{PROJECT_NAME}}` placeholder.

**Changed files:**
- `init-new-project.sh` — before self-deleting, if `README.template.md` exists: derive the project name (from the repo arg, else the directory name), `sed` the placeholder, write `README.md`, and `rm` the template file.
- `scripts/sync-devcontainer.sh` — `is_excluded()` now skips `README.md` (project-owned) and `README.template.md` (template-only), so README content never flows downstream.

**Downstream note:** repos created before this change still carry the old template README; replace it by hand (sync intentionally won't touch it).

## 2026-06-02 — Add: `scripts/sync-devcontainer.sh` (catch a downstream repo up to this template)

**What changed:** New helper to sync this template's infra layer into another repo that has drifted behind, using **content-aware, per-file classification** plus **true 3-way merges** — not a hardcoded path list. Run it from inside the target (apps) repo. It adds this template as a git remote, fetches, and decides each file's fate by comparing content. Project code (`apps/`/`libs/`/`scripts/`) is excluded, so app wiring (glob-discovered) is untouched. Nothing is committed automatically.

**Added files:**
- `scripts/sync-devcontainer.sh` — usage: `scripts/sync-devcontainer.sh [<template-url-or-path>] [--branch main] [--no-merge] [--dry-run] [--yes]`. The URL is optional once `.template-ref` records one.

**Changed files:**
- `init-new-project.sh` — now captures the template commit SHA + URL **before** wiping git history and writes them to `.template-ref` in the new project, so downstream syncs have a baseline for 3-way merges.

**How classification works (per template-managed file):**
- **identical** (your file == template's current) → nothing to do.
- **new** (template added a file you lack) → add it.
- **pristine/stale** (your file matches *some past* template version, i.e. never hand-edited) → replace wholesale, automatically.
- **modified** (matches *no* template version, i.e. you customized it) → if a baseline is known, run `git merge-file` for a real 3-way merge (clean merges are staged; conflicts get standard markers for manual resolution); with no baseline, fall back to a diff + `keep/take/skip` prompt. Nothing is overwritten without confirmation.
- **Deletions** the template made are auto-detected: a tracked file that was template-managed but is gone from the template, and still matches a historical template version, is pruned (pristine); if you'd modified it, you're asked. `PRUNE_PATHS` is an explicit safety list (prefilled with the OpenCode artifacts).
- After a successful run, `.template-ref` is restamped to the new template commit so the next sync merges against the right baseline.

**Never synced:** `openspec/changes/` + `openspec/specs/` (your project's spec content), `apps/`/`libs/`/`scripts/*` project code (except the sync script), `graphify-out/`, `bun.lock`, `CHANGES.md`, `init-new-project.sh`, `init-host.sh`, `.template-ref`. `openspec/config.yaml` *is* synced but, being customized, goes through the merge/review path rather than wholesale replace.

## 2026-06-01 — Remove: OpenCode and oh-my-opencode (installation + all references)

**What changed:** OpenCode is no longer a provider this template ships. Its installers, committed config, devcontainer wiring, dependency, and docs are all removed. Historical CHANGES.md entries mentioning OpenCode are intentionally left intact — they remain accurate history.

**Removed files:**
- `.devcontainer/on-create/setup-opencode.sh` and `.devcontainer/on-create/setup-oh-my-opencode.sh` (installer scripts).
- `.opencode/` (committed config dir: `command/`, `commands/`, `plugins/graphify.js`, `skills/`, `opencode.json`, `oh-my-opencode.jsonc`, plus its `package.json`/`bun.lock`/`node_modules`).
- `opencode.jsonc` (repo-root OpenCode config).

**Edited:**
- `.devcontainer/on-create.sh` — drop the two `optional …setup-opencode.sh`/`setup-oh-my-opencode.sh` calls; remove "opencode" from the install-ordering comments and the sourced-script `set -e` warning comment.
- `.devcontainer/devcontainer.json` — remove the `${localEnv:HOME}/.local/share/opencode → /mnt/opencode-mount` bind mount; change `OCTO_ALLOWED_PROVIDERS` from `"claude codex gemini opencode"` to `"claude codex gemini"`.
- `.devcontainer/on-create/setup-claude-octopus.sh` — delete the "OpenCode (skills only, via symlink)" block; reword the canonical-clone and shared-skills-symlink comments to drop OpenCode.
- `.devcontainer/on-create/setup-graphify.sh` — drop the `.opencode/plugins/graphify.js` example from the committed-files comment.
- `.devcontainer/on-create/setup-openspec.sh` — `openspec init --tools` now `claude,codex,cursor` (was `…,opencode`).
- `.devcontainer/secrets.example` — `OPENAI_API_KEY` comment now references the Codex CLI instead of the "Opencode Codex auth plugin".
- `.devcontainer/AUTH-PERSISTENCE.md` — "this repo allows" line now lists three CLIs (`claude codex gemini`). The separate list of provider names Octopus *recognizes* is left unchanged (it documents Octopus's capabilities, not our install).
- `init-host.sh` — remove `mkdir -p "$HOME/.local/share/opencode"`.
- `.gitignore` — remove `**/opencode/auth.json`.
- `package.json` — remove `opencode-ai` from both the workspace `catalog` and `devDependencies`; `bun install` refreshes `bun.lock` (1 package removed).
- `README.md` — remove the `mkdir -p ~/.local/share/opencode` step, the "Authenticate Opencode" auth step (remaining auth steps renumbered), the Opencode + oh-my-opencode entries in the AI Tools list, and the OpenCode mention in the Context7 MCP line.
- `AGENTS.md` — drop "Opencode" from the AI-coding-tools list.

**How to adopt downstream:** delete the files listed above, apply the edits, run `bun install` to drop `opencode-ai` from the lockfile, and rebuild the container — `on-create` no longer attempts the OpenCode install.

**Verification:**
```bash
grep -rni opencode . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=graphify-out \
  --exclude=bun.lock --exclude=build-log.log --exclude=CHANGES.md
# only .devcontainer/AUTH-PERSISTENCE.md (Octopus-recognized provider list) should match
bun -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'   # package.json still valid
```

---

## 2026-05-28 — Fix: make Warp ACP detection persist across rebuilds (host-captured env, not `${localEnv:...}` forwarding)

**What broke:** The Warp ↔ Claude Code integration added on 2026-05-27 forwarded three host signals (`TERM_PROGRAM`, `WARP_CLIENT_VERSION`, `WARP_CLI_AGENT_PROTOCOL_VERSION`) into the container via `remoteEnv` using `${localEnv:...}`. After any rebuild, all three came back **empty** inside the container, so Claude Code fell back to plain ANSI instead of ACP structured output.

**Root cause:** `${localEnv:VAR}` is resolved by whatever process brings the container up — here **DevPod** — against *its own* environment, fresh on every rebuild with no memory. But Warp injects those vars **only into the interactive terminals it spawns**; they are not persistent global host vars. DevPod is frequently launched from a GUI (Dock/Spotlight), whose env never had them (the same pitfall the README documents for secrets). So `localEnv` resolved to empty and nothing was ever persisted inside the container — `remoteEnv` simply recomputed the same empty result each rebuild.

**Fix — capture on the host, source into interactive shells:**

1. **`.devcontainer/host/capture-warp-env.sh`** (new, runs on the **host**): writes whatever `TERM_PROGRAM`/`WARP_*` vars are present to `~/.config/devcontainer/warp-env`, overwriting a key **only when a fresh non-empty value exists**. A value seeded from one Warp-terminal launch therefore survives later GUI-launched rebuilds instead of being clobbered.
2. **`devcontainer.json`** — add `initializeCommand` to run that script before each `devpod up`; **remove** the three dead `${localEnv:WARP_*}` lines from `remoteEnv`; add a `_comment_warp` explaining why forwarding was dropped.
3. **`configs/.shell_common`** (sourced by both `.bashrc` and `.zshrc`) — source `/run/devcontainer-config/warp-env` (the host file via the read-only bind mount) inside `set -a … set +a` so the vars are **exported** and Claude Code, a child of the shell, inherits them. Scoped to interactive shells on purpose — that's the only place Warp detection matters, it needs no rebuild (a new shell picks up refreshed values immediately), and it leaves non-interactive contexts untouched.

**How to adopt downstream:** copy `host/capture-warp-env.sh`, add the `initializeCommand` line, drop any `${localEnv:WARP_*}`/`TERM_PROGRAM` entries from `remoteEnv`, and add the `set -a; source /run/devcontainer-config/warp-env; set +a` guard to `.shell_common` (or your shell rc). **Seed it once by running `devpod up .` from a Warp terminal** — there's no way to obtain Warp's per-terminal vars otherwise.

**Verification:**
```bash
cat ~/.config/devcontainer/warp-env       # on host: three KEY=value lines
# open a NEW interactive shell in the container, then:
env | grep -E 'WARP|TERM_PROGRAM'          # all three non-empty (exported to children)
```

**Caveat:** values refresh only when you next `devpod up` from Warp (which re-runs the host capture); between ups the file holds the last captured versions. Acceptable for a template whose premise is connecting via Warp.

---

## 2026-05-28 — Fix: wrap non-critical on-create installers in optional() so one failure can't abort the chain

**Goal:** Close the last instance of the "sourced script aborts the whole chain" failure class (see the entry below for the volume-permission instance). All `on-create/*.sh` helpers are **sourced** into `on-create.sh`'s `set -e` shell, so any unguarded `return N` or failing command aborts every script after it. The clearest live hazard: `setup-oh-my-opencode.sh` does `return 1` (lines 24/31/36) when opencode is missing or below its min version — and it runs at step 6 of 14, so that `return 1` would skip everything downstream **including `setup-shell.sh`**, which installs the proto-activating `~/.zshrc`. That's the same root failure (no shell setup → `bun`/`proto` missing from PATH → husky `bunx: not found`) reached by a different trigger.

**Change:** An `optional()` helper in `on-create.sh` wraps each non-critical installer:
```bash
optional() {
    source "$1" || echo "⚠️   $(basename "$1") failed; continuing setup without it"
}
```
- **Hard `source` (unchanged):** `setup-proto.sh` (bun/PATH for everything depends on it — must abort on failure) and `setup-shell.sh` (the final step, with nothing downstream to strand; its failure should surface, not be hidden).
- **`optional` (all the rest):** biome, claude, ccstatusline, opencode, oh-my-opencode, openspec, gemini, codex, octopus, warp, graphify, vscode-extensions.

**Bash semantics (verified under bash 5.2, not assumed):** Unguarded `source X` under `set -e` aborts the chain on both a `return 1` and a mid-script failure. `source X || echo` lets the chain continue and fires on an explicit `return N`. A subshell on the left of `||` is **not** the right form — `( source X )` discards X's side effects (PATH/env exports) and suppresses `set -e` inside exactly the same as the plain form, so it buys nothing. Note `source X || …` also disables `set -e` *within* X for that call, so `optional()` reacts to X's final/return status, not a mid-script failure — acceptable for standalone installers; where a specific step must be caught we still guard that command directly (e.g. the octopus `mkdir`/`ln`). Simulated both the `return 1` and unguarded cases to confirm; `bash -n` passes. (Credit: the `optional()` approach came from a sibling template repo that hit the same gap.)

---

## 2026-05-28 — Fix: claim root-owned volumes upfront so on-create can't abort mid-chain

**Symptom:** A build log showed `on-create.sh` exiting status 1 at the Claude Octopus step, so every later script — `setup-claude-warp.sh`, `setup-graphify.sh`, the extension sync, and crucially `setup-shell.sh` — never ran. Since `setup-shell.sh` installs the proto-activating `~/.zshrc` template, the downstream symptom was `bun`/`bunx`/`proto` missing from the interactive shell PATH (a stock Oh My Zsh `~/.zshrc` left in place) and husky `pre-commit` hooks failing with `bunx: not found`.

**Root cause:** Docker named volumes mount **empty as `root:root`** unless the image pre-populated the path (copy-on-first-use seeds the volume with the image dir's ownership). `~/.proto` is pre-created in the Dockerfile and the `base:trixie` image happens to ship `/home/vscode/.config`, but `~/.codex` / `~/.gemini` are neither — so they mount `root:root` and the `vscode` user can't write to them. Two writes then failed: OpenSpec's Codex refresh (`EACCES … mkdir '/home/vscode/.codex/prompts'`, swallowed/non-fatal) and `setup-claude-octopus.sh`'s `ln -s … ~/.codex/claude-octopus` (`Permission denied`). Because `on-create.sh` runs `set -e` and **sources** each helper, that unguarded `ln` failure aborted the whole remaining chain.

**Fix 1 — claim every volume-mounted home dir once, upfront.** A single loop in `on-create.sh`, right after the secrets block and before any tool script runs (order-independent — important because `setup-openspec.sh` writes `~/.codex/prompts` *before* `setup-codex.sh` would run, so a per-script chown there is too late):
```bash
for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config" "$HOME/.proto"; do
    if [ -d "$d" ] && [ "$(stat -c '%U' "$d")" != "$(whoami)" ]; then
        sudo chown -R "$(whoami):$(whoami)" "$d"
    fi
done
```
This also closes a latent `~/.config` gap: nothing claimed it — it worked only by relying on the base image shipping it as `vscode`, which breaks the moment the mount is scoped to an image-unpopulated subdir (e.g. `~/.config/ccstatusline`). `setup-claude.sh` and `setup-proto.sh` keep their own existing claims as harmless belt-and-suspenders.

**Fix 2 — fault tolerance (defense in depth).** The three `mkdir`/`ln -s` calls in `setup-claude-octopus.sh` (`~/.codex`, `~/.opencode`, `~/.agents/skills`) are now `|| echo "⚠️  …"` guarded, so an optional integration step degrades to a warning instead of killing the whole setup under `set -e`. (Same spirit as the existing "sourced scripts use `return`, not `exit`" convention — here it was an external command tripping `set -e`.)

Verified: the claim loop is a no-op on a container where the dirs are already `vscode`-owned; all touched scripts pass `bash -n`.

---

## 2026-05-28 — Feat: ccstatusline auto-installs on rebuild (Claude Code status line)

**Goal:** Keep the Claude Code status line working across container rebuilds. `~/.claude/settings.json` points `statusLine.command` at the bare `ccstatusline` binary, but that binary installs to `~/.bun/bin`, which is **not** volume-mounted — so every rebuild wipes it and Claude Code warns that the status line command failed.

**New `setup-ccstatusline.sh` on-create script:**
- Installs the binary on every rebuild with `bun add -g ccstatusline` (guarded by a `command -v ccstatusline` check so re-runs are idempotent). `~/.bun/bin` is already on PATH via `setup_proto_env`, same as graphify's `~/.local/bin`.
- Seeds `~/.config/ccstatusline/settings.json` from the committed `.ccstatusline-settings.bak` **only when the config is missing**, so a fresh `~/.config` volume gets the intended status line (model · context · git branch · git changes) without manual reconfiguration. An existing config is never clobbered. (`~/.config` *is* volume-mounted, so the config normally persists on its own — this is just the fresh-volume fallback.)

**Wired into `on-create.sh`** immediately after `setup-claude.sh` (it backs the `statusLine` command in `~/.claude/settings.json`). Verified: first run installs `ccstatusline@2.2.19` and seeds the config identical to the backup; second run no-ops on both the binary and the config.

---

## 2026-05-28 — Fix: Graphify install survives Python 3.14 (clang→gcc) + stop tracking per-container pointers

**Goal:** Keep the on-rebuild Graphify auto-install working on the proto-managed Python 3.14 toolchain, and stop committing per-container pointer files.

**1. Compiler fallback in `setup-graphify.sh` (clang → gcc/g++):**
`graphifyy` (0.8.22) depends on `tree-sitter-dm` (0.25.1), which ships no prebuilt wheel for proto's Python 3.14 on this arch, so `uv tool install` compiles it from source. Python 3.14's `sysconfig` hardcodes **clang/clang++** for `CC`, `CXX`, `LDSHARED`, and `LDCXXSHARED`, but the devcontainer image ships only **gcc/g++** — so the build fails with `error: command 'clang' failed: No such file or directory`. Before installing, when `clang` is absent and `gcc` is present, export the overrides:
```bash
export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"
export LDSHARED="${LDSHARED:-gcc -shared}"
export LDCXXSHARED="${LDCXXSHARED:-g++ -shared}"
```
Overriding `CC`/`CXX` alone is insufficient — the *link* step (`LDSHARED`/`LDCXXSHARED`) independently hardcodes clang and must be redirected too. Verified by reproducing the failure and confirming the fix yields a working `graphify 0.8.22`.

**2. Stop tracking per-container pointer/lock files (`.gitignore`):**
```
graphify-out/.graphify_root
graphify-out/.graphify_python
graphify-out/.rebuild.lock
```
`.graphify_root` (repo root) and `.graphify_python` (absolute path to the uv-tools Python) are regenerated per container and are meaningless — or wrong — in another container, so they shouldn't be committed. If already tracked, untrack once with `git rm --cached graphify-out/.graphify_root graphify-out/.graphify_python`.

---

## 2026-05-28 — Feature: AUTH-PERSISTENCE.md guide + Octopus provider allowlist

**Goal:** Document how auth/secrets persist (a living reference for adding credentialed tools), and add an explicit, repo-scoped allowlist for which providers Claude Octopus may use.

**1. `.devcontainer/AUTH-PERSISTENCE.md`:**
A reference doc covering the two persistence mechanisms — API keys via the two-tier host secrets files vs. device/OAuth logins on `${devcontainerId}`-keyed named volumes — the "pick one per tool per project" rule (an API-key env var shadows a device login), a table of what each volume persists today, per-tool login steps, and how to replicate the setup in another repo. Read it before wiring up a new credentialed CLI.

**2. Provider allowlist (`.devcontainer/devcontainer.json` → `containerEnv`):**
```jsonc
"OCTO_ALLOWED_PROVIDERS": "claude codex gemini opencode"
```
Claude Octopus (octo plugin) reads `OCTO_ALLOWED_PROVIDERS` at runtime via its `provider-allowlist.sh` lib: a space/comma-separated list where **unset = all detected providers allowed**, and any provider omitted from a non-empty list is treated as unavailable **even if installed**. Set it to the four CLIs this template installs. `claude` must stay in the list (it's the orchestrator). No setup-script change is needed — the env var alone gates `check-providers.sh` and fleet construction. It's non-secret and repo-specific, so it lives in version control, not the host secrets file. Recognized names: `codex gemini opencode copilot qwen ollama openrouter perplexity` + `claude` (aliases: `claude`/`anthropic`/`sonnet`, `codex`/`openai`, `gemini`/`google`, `local`→`ollama`).

---

## 2026-05-28 — Feature: Persist ~/.config tool configs across rebuilds, isolated per repo

**Goal:** Keep CLI/tool configuration under `~/.config` (e.g. `ccstatusline/settings.json`) alive across devcontainer rebuilds, scoped per-project, without committing it to the repo.

**1. Named volume over `~/.config` (`.devcontainer/devcontainer.json` → `mounts`):**
```jsonc
"source=config-home-${devcontainerId},target=/home/vscode/.config,type=volume",
```
`${devcontainerId}` scopes the volume per devcontainer, so each project gets its own isolated config store that survives rebuilds (a rebuild keeps the same id). A **named volume** (not a host bind mount) is the right tool here because of Docker's copy-on-first-use: when an empty named volume is first mounted onto a path the image already populated, Docker copies that image content into the volume; a bind mount would instead *shadow* the path and hide it. Targeting all of `~/.config` (rather than one subdir) means every tool writing under `~/.config/*` persists automatically — broad by design. To scope tighter, target a single subdir instead, e.g. `target=/home/vscode/.config/ccstatusline`.

**2. Seed once before the first rebuild (critical):**
Copy-on-first-use copies from the **image**, not from files written at runtime. A config you created interactively lives in the container's writable layer, so the new empty volume shadows it and it's lost on the rebuild that introduces the mount. Relay it through the bind-mounted workspace:
```bash
# Before rebuild (current container):
cp ~/.config/ccstatusline/settings.json /workspace/.ccstatusline-settings.bak
# After rebuild (volume now active):
mkdir -p ~/.config/ccstatusline
cp /workspace/.ccstatusline-settings.bak ~/.config/ccstatusline/settings.json
rm /workspace/.ccstatusline-settings.bak
```
Only needed for configs **not** regenerated by an on-create script. In this template, `~/.config/{proto,rtk,opencode,openspec,moon}` are rewritten on every rebuild, so they need no seeding — `ccstatusline` is the one that does. After this one-time seed the volume persists across all future rebuilds.

**3. Keep the relay file out of git (`.gitignore`):**
```
.ccstatusline-settings.bak
```

**Gotchas:**
- **Rebuild vs. recreate:** the volume survives rebuilds but is keyed to `${devcontainerId}`; a full delete-and-recreate generates a new id and drops the volume (same as any `*-${devcontainerId}` volume).
- **No host-side editing:** the config lives inside the Docker volume, not on the host — edit it from inside the container.
- **No overlapping mounts:** confirm no other mount targets a path under `~/.config`. The existing tool-home volumes sit at `~/.claude`, `~/.codex`, `~/.gemini`, `~/.proto` (not under `~/.config`), so there's no conflict.

**Alternative (host-durable + editable):** a bind mount survives even a full recreate and is editable from the host, but does *not* copy-on-first-use (it shadows) and the host dir must exist first: `"source=${localEnv:HOME}/.config/ccstatusline,target=/home/vscode/.config/ccstatusline,type=bind,consistency=cached"`.

---

## 2026-05-28 — Feature: Persist AI CLI logins across rebuilds, isolated per repo

**Goal:** Make Claude Code, Codex, and Gemini CLI logins survive container rebuilds, while keeping multiple project repos isolated — each repo gets its own accounts/keys with no cross-repo collisions.

**1. Named-volume mounts keyed by `${devcontainerId}` (`.devcontainer/devcontainer.json` → `mounts`):**
Each AI CLI's home dir is backed by a Docker named volume whose name embeds `${devcontainerId}` (automatically unique per repo, so logins never collide):
```jsonc
"source=claude-code-config-${devcontainerId},target=/home/vscode/.claude,type=volume",  // pre-existing
"source=codex-home-${devcontainerId},target=/home/vscode/.codex,type=volume",           // added
"source=gemini-home-${devcontainerId},target=/home/vscode/.gemini,type=volume",          // added
```
`~/.claude` was already volume-backed; only `~/.codex` and `~/.gemini` needed adding. Verify each CLI's actual home dir before mounting — Codex defaults to `~/.codex` (`CODEX_HOME`, holds `config.toml` + `auth.json`), Gemini to `~/.gemini` (holds `oauth_creds.json`), Claude to `~/.claude` (`CLAUDE_CONFIG_DIR`). Do **not** bind-mount to a literal host path (e.g. `~/.codex`): that shares one login across every repo, defeating isolation. The `${devcontainerId}` form gives each repo its own volume.

**2. Unique `DEVCONTAINER_PROJECT` slug (`.devcontainer/devcontainer.json` → `containerEnv`):**
Set `DEVCONTAINER_PROJECT` to a distinct lowercase slug per repo (here: `devenv`, was the placeholder `my-project`). This is the namespace handle for per-project secrets (`~/.config/devcontainer/secrets.d/<slug>` on the host). Two repos sharing a slug would share per-project keys.

**3. API key vs device login — pick one per tool per project:**
The two-tier secrets loader writes any keys from the host secret files into `/etc/environment`, so a present `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` **shadows** the corresponding CLI's device login. Choose one method per tool per project. Note Graphify's semantic extraction also reads those same Gemini/OpenAI keys, so a key set for Graphify will shadow a Gemini CLI device login.

**One-time logins (after rebuild):**
```bash
claude         # /login (or use an API key)
codex login    # device/OAuth — omit OPENAI_API_KEY to let this win
gemini         # /auth → Google login — omit GEMINI_API_KEY/GOOGLE_API_KEY to let this win
```
These now persist on the per-repo volumes; subsequent rebuilds skip re-login.

---

## 2026-05-27 — Feature: Warp integration (ACP detection signals + Claude Code Warp plugin) + trust workspace for Gemini CLI

**Goal:** Integrate the Warp terminal with the devcontainer on two fronts — let Claude Code detect Warp and open its structured-output channel (ACP), and auto-install Warp's official Claude Code plugin — and separately silence Gemini CLI's workspace-trust prompt inside the container.

**1. Forward Warp ACP detection signals (`.devcontainer/devcontainer.json` → `remoteEnv`):**
Forward three host vars from Warp into the container, each as `${localEnv:NAME}`:
- `WARP_CLI_AGENT_PROTOCOL_VERSION` — Warp's Agent Client Protocol version
- `WARP_CLIENT_VERSION` — Warp app version
- `TERM_PROGRAM` — `WarpTerminal` when launched from Warp

When all three are present, Claude Code detects it's running under Warp and opens a structured-output channel (ACP) instead of plain ANSI. The host sets these automatically when a terminal is spawned from Warp; without `remoteEnv` forwarding they're lost at the container boundary and Claude Code falls back to plain text.

**2. Auto-install the Claude Code Warp plugin:**
Add `.devcontainer/on-create/setup-claude-warp.sh`, which installs [claude-code-warp](https://github.com/warpdotdev/claude-code-warp) (Warp's official plugin) so its commands/skills are available without manual `/plugin marketplace add` + `/plugin install`. The script:
- Runs `claude plugin marketplace add warpdotdev/claude-code-warp` then `claude plugin install warp@claude-code-warp`.
- Skips if `~/.claude/plugins/cache/claude-code-warp/warp` already exists (the `~/.claude` volume persists this across rebuilds, so the install runs once per fresh volume).
- Gracefully no-ops if the `claude` CLI is not on PATH.

Source it in `.devcontainer/on-create.sh` **after** `setup-claude.sh` so the `claude` CLI is available.

**3. Trust the workspace for Gemini CLI (`.devcontainer/devcontainer.json` → `containerEnv`):**
Add `GEMINI_CLI_TRUST_WORKSPACE=true`. Suppresses the interactive "Do you trust the workspace?" prompt Gemini CLI shows on first run inside the mounted `/workspace`. Safe in a devcontainer because the workspace is the user's own bind-mounted code.

**Verification (after rebuild):**
```bash
echo "$TERM_PROGRAM $WARP_CLIENT_VERSION $WARP_CLI_AGENT_PROTOCOL_VERSION"
# → e.g. "WarpTerminal 0.2025.xx.xx.xx 0.1.0" when launched from Warp
echo "$GEMINI_CLI_TRUST_WORKSPACE"                 # → true
ls ~/.claude/plugins/cache/claude-code-warp/warp   # plugin payload present
```
If `TERM_PROGRAM` is empty inside the container, the terminal wasn't launched from Warp (or the host lacks the var) — Claude Code just uses plain ANSI, which is harmless.

---

## 2026-05-27 — Feature: auto-install Graphify (project-scoped) + commit the initial knowledge graph

**Goal:** Install [graphify](https://github.com/safishamsi/graphify) — a knowledge-graph builder for code/docs that AI assistants query instead of grepping raw files — register it at **project scope** with Claude Code, Codex CLI, OpenCode, and Gemini CLI, and commit an initial graph so fresh clones and `git worktree`s inherit a working setup without rebuilding (a rebuild costs Gemini API credits on every fresh checkout).

**Why project-scope (not user-scope like the octopus/warp installs):** Graphify ships a `--project` flag that writes skill files and PreToolUse hooks into the project directory. Committing those files means (1) git worktrees inherit them via the tracked tree — user-scoped installs run from `on-create.sh`, which doesn't fire on worktree creation; and (2) container rebuilds don't regenerate them, so the working tree stays clean.

**How to implement:**

1. **Add `uv` to `.prototools`** (graphify's recommended install method; the [Phault/proto-toml-plugins](https://github.com/Phault/proto-toml-plugins) repo already used for `fly`/`infisical`/`dagger` ships a maintained `uv` plugin):
   ```toml
   uv = "0.11.16"
   # ...
   [plugins]
   uv = "https://raw.githubusercontent.com/Phault/proto-toml-plugins/main/uv/plugin.toml"
   ```

2. **Add `.devcontainer/on-create/setup-graphify.sh`** that installs the CLI **with the `[gemini]` extra**, idempotently (skip if `graphify` is already on PATH):
   ```bash
   uv tool install 'graphifyy[gemini]'
   ```
   The `[gemini]` extra is **required**, not optional: graphify prefers Gemini for semantic extraction whenever `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set (this devcontainer provides them via the host-mounted secrets file), but talks to Gemini through the **OpenAI SDK**. The base `graphifyy` package omits `openai`, so plain `uv tool install graphifyy` fails at the extraction step with `… requires the openai package`. The extra adds ~3MB (openai SDK + httpx). If your secrets profile sets `OPENAI_API_KEY` instead, the same `[gemini]` extra covers that code path too. The script does **not** run `graphify install --project` — those files are committed (step 4).

3. **Source it in `.devcontainer/on-create.sh`** after `setup-proto.sh`, so `uv` is on PATH first.

4. **One-time, in a fresh clone of the template:** run the project-scoped installer for each platform, then commit the generated files:
   ```bash
   graphify install --project
   graphify install --project --platform codex
   graphify install --project --platform opencode
   graphify install --project --platform gemini
   ```
   This produces:
   - `.claude/skills/graphify/`, `.claude/CLAUDE.md` (graphify section), `.claude/settings.json` (PreToolUse hook)
   - `.agents/skills/graphify/` (Codex skill), `.codex/hooks.json` (PreToolUse hook — references the absolute path `/home/vscode/.local/bin/graphify`, fine in this devcontainer where the user is always `vscode`)
   - `.opencode/skills/graphify/`, `.opencode/plugins/graphify.js`, `.opencode/opencode.json`
   - `.gemini/skills/graphify/`, `.gemini/settings.json` (BeforeTool hook)
   - `## graphify` sections appended to the top-level `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`

5. **Exclude graphify's generated output from Biome.** The lint-staged pre-commit hook runs `biome check --write` on staged files; graphify's `graph.html` trips lint rules (unused functions, value-returning `forEach` callbacks) and `cache/*.json` gets reformatted on `--write`, mutating graphify's own output. Add a single exclude to the existing `files.includes` array in **`biome.jsonc`**:
   ```jsonc
   "includes": ["**", "!graphify-out/**"]
   ```
   **Two gotchas, both learned the hard way here:**
   - **Do not create a separate `biome.json` for this.** Biome's config discovery prefers `.json` over `.jsonc` in the same directory, so a stray `biome.json` silently shadows `biome.jsonc` — all its linter overrides, VCS integration, and other excludes are ignored with no warning or error. Audit which file is active with `bunx biome rage | grep Path:`.
   - **Use a single `!` to exclude.** `!!pattern` is Biome v2's *re-include* operator, so `!!graphify-out/**` on top of `**` is a no-op.

6. **`.gitignore` the per-user output files** (per the [graphify README](https://github.com/safishamsi/graphify#what-files-it-handles)) — everything else in `graphify-out/` is intentionally committable so the graph is shared across the team:
   ```
   graphify-out/manifest.json   # per-machine file hashes (diff on every machine)
   graphify-out/cost.json       # local API spend tracker
   ```

7. **Build and commit the initial graph:** run `/graphify .` (or `graphify build .`), then commit the shareable artifacts:
   - `graph.json` (~196 KB) — the structured graph used by `graphify query`
   - `graph.html` (~224 KB) — interactive visualization (open in a browser)
   - `GRAPH_REPORT.md` (~8 KB) — human-readable architecture summary
   - `cache/` — semantic-extraction cache, reused on incremental updates
   - `.graphify_labels.json` (community labels), `.graphify_root`, `.graphify_python` (pointer files)

   **Caveat:** `.graphify_root` (`/workspace`) and `.graphify_python` (`…/uv/tools/graphifyy/bin/python`) are absolute paths matching this devcontainer's layout. A downstream repo with a different path or a non-`uv` install should **not** copy ours — delete `graphify-out/` and regenerate with `/graphify .`.

**Verification (after rebuild):**
```bash
graphify --version                                  # 0.8.21+
ls .claude/skills/graphify .agents/skills/graphify  # skill files present
grep -A1 PreToolUse .claude/settings.json           # hook registered
bunx biome rage | grep Path:                        # → biome.jsonc (NOT biome.json)
bunx biome check graphify-out/graph.html            # → "These paths were provided but ignored"
graphify query "where is bun configured" | head -30 # returns a scoped subgraph
```
Then type `/graphify .` in any assistant to build the graph and `graphify query "<question>"` to consult it. The PreToolUse hooks nudge the assistant toward the graph automatically once `graphify-out/graph.json` exists.

**Trade-offs / notes for downstream:**
- The Codex hook bakes in the absolute path `/home/vscode/.local/bin/graphify`. If you change the devcontainer user, regenerate `.codex/hooks.json` with `graphify install --project --platform codex`.
- No other graphify extras (`pdf`, `office`, `video`) are installed by default — add per-project with `uv tool install --with "graphifyy[pdf]" graphifyy`.
- Building the graph is user-initiated and per-worktree: worktrees inherit the configuration but each builds its own graph.

---

## 2026-05-27 — Feature: auto-install Claude Octopus during devcontainer setup

**Goal:** Install [claude-octopus](https://github.com/nyldn/claude-octopus) — a multi-LLM orchestration layer with `/octo:*` commands and 50+ skills — automatically when the devcontainer is created, so it's available across Claude Code, Codex CLI, and OpenCode without manual setup steps.

**How to implement:**
1. Add `.devcontainer/on-create/setup-claude-octopus.sh`. The script:
   - Clones `nyldn/claude-octopus` once to `~/.local/share/claude-octopus` (canonical location, shared by all CLIs via symlinks — avoids cloning the repo three times per rebuild).
   - For **Claude Code**: runs `claude plugin marketplace add https://github.com/nyldn/plugins.git` then `claude plugin install octo@nyldn-plugins`. Skipped if `~/.claude/plugins/cache/nyldn-plugins/octo` already exists (the `~/.claude` volume persists this across rebuilds).
   - For **Codex CLI**: symlinks `~/.codex/claude-octopus` → canonical clone (only if `codex` is on PATH).
   - For **OpenCode**: symlinks `~/.opencode/claude-octopus` → canonical clone (only if `opencode` is on PATH).
   - Creates the shared skill-discovery symlink `~/.agents/skills/claude-octopus` → `<canonical>/skills` (this is the path both Codex and OpenCode read for skill files; the README shows them creating it independently, but they can share one symlink safely).
   - All steps are idempotent — re-running the script does nothing if everything is already in place.
2. In `.devcontainer/on-create.sh`, source the new script **after** `setup-claude.sh`, `setup-opencode.sh`, and `setup-codex.sh` — the script needs those CLIs on PATH to detect them and install the Claude Code plugin.

**Verification (after rebuild):**
```bash
ls -l ~/.codex/claude-octopus ~/.opencode/claude-octopus ~/.agents/skills/claude-octopus   # all symlinks resolved
ls ~/.local/share/claude-octopus/skills | head                                              # shows skill dirs
ls ~/.claude/plugins/cache/nyldn-plugins/octo                                               # contains version dir
```

Inside Claude Code, run `/octo:setup` to walk through provider configuration (one-time, interactive).

---

## 2026-05-13 — Fix: devcontainer on-create reliability (RTK, claude-mem, oh-my-opencode, sourced-script `exit`)

**Goal:** Several independent on-create failures were silently degrading the devcontainer: the RTK token-compression hook was never patched into `~/.claude/settings.json`; the `claude-mem` plugin's first-run SessionStart hook failed; the oh-my-opencode plugin was never registered in `opencode.json`; and sourced helper scripts used `exit` (which killed the parent `on-create.sh`, preventing later scripts like `setup-shell.sh` from running).

**Root causes:**
1. **RTK:** `rtk init -g` detects non-interactive shell mode (on-create runs without a TTY) and defaults to "N" at the "Patch existing settings.json?" prompt, then exits without writing the hook config. RTK ships an `--auto-patch` flag for exactly this scenario.
2. **claude-mem:** The plugin's SessionStart hook runs `bun install` on a manifest of `tree-sitter-*` packages whose post-install scripts shell out to `node-gyp`. The devcontainer's node feature is configured with `nodeGypDependencies: false`, and npm's bundled node-gyp isn't symlinked onto `$PATH` — so the spawn fails with ENOENT and the hook exits non-zero. (The packages themselves work at runtime via shipped prebuilds; only the install-script step fails.)
3. **oh-my-opencode:** Upstream installer's version comparison is lexicographic — `"1.14.48"` compares as less than `"1.4.0"` because `'1' < '4'` at the second segment. The installer prints `Detected OpenCode 1.x.x, but 1.4.0+ is required` and aborts before writing `opencode.json`, even on currently-released opencode versions.
4. **Sourced-script `exit`:** Helper scripts sourced by `on-create.sh` used `exit N` for early termination, which kills the parent shell instead of returning from the helper — silently preventing later scripts (notably `setup-shell.sh`) from running.

**How to implement:**
1. In `.devcontainer/on-create/setup-claude.sh`, after `setup_proto_env`, install `node-gyp` globally if missing:
   ```bash
   if command -v npm &> /dev/null && ! command -v node-gyp &> /dev/null; then
       npm install -g node-gyp >/dev/null 2>&1 || \
           echo "⚠️   Could not install node-gyp; some Claude Code plugins may fail their first install"
   fi
   ```
   npm is already on `$PATH` from the devcontainer node feature and ships `node-gyp` as a bundled dep, so `npm i -g node-gyp` just creates the bin symlink.
2. In `.devcontainer/on-create/setup-claude.sh`, change `rtk init -g` to `rtk init -g --auto-patch` so the hook config is patched into `~/.claude/settings.json` non-interactively (also creates `~/.claude/settings.json.bak`).
3. In `.devcontainer/on-create/setup-oh-my-opencode.sh`, replace the `bunx oh-my-opencode install …` block (and its 3-retry verification loop) with: (a) `bun install -g oh-my-opencode` if not already globally installed, (b) write `~/.config/opencode/opencode.json` directly with `{"$schema":"https://opencode.ai/config.json","plugin":["oh-my-openagent"]}`. This bypasses the broken upstream version check. The plugin is dual-published as `oh-my-opencode` (legacy npm name) and `oh-my-openagent` (new name accepted by opencode without a warning).
4. Replace every `exit N` with `return N` in the sourced helpers — `setup-vscode-extensions.sh` (3 occurrences) and `setup-oh-my-opencode.sh` (3 occurrences) — and add a convention comment at the top of `on-create.sh` documenting that sourced helpers must use `return`, not `exit`. Audit with `grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh` (should return empty).
5. **One-off cleanup (per devcontainer):** if a previous run left `/workspace/.codex` as a 0-byte regular file instead of a directory (visible as `ENOTDIR` from `openspec init`), run once: `chmod u+w /workspace/.codex && rm /workspace/.codex`. Not applicable if `.codex/` is already a directory (which it is in this repo). No script changes needed — this is a workspace-data issue, not a setup-script bug.

**Verification (after rebuild):**
```bash
command -v node-gyp                                          # /usr/local/share/nvm/.../bin/node-gyp
grep -A 5 PreToolUse ~/.claude/settings.json                 # shows rtk hook claude
cat ~/.config/opencode/opencode.json                         # has plugin: ["oh-my-openagent"]
test -d /workspace/.codex && echo ok || echo "still bad"     # ok
grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh   # empty
```

---

## 2026-04-14 — Add Gemini CLI and Codex CLI to devcontainer

**Goal:** Include Gemini CLI and OpenAI Codex CLI as additional AI coding tools in the devcontainer.

**How to implement:**
1. Create `.devcontainer/on-create/setup-gemini.sh` — installs `@google/gemini-cli` globally via bun with an idempotency check.
2. Create `.devcontainer/on-create/setup-codex.sh` — installs `@openai/codex` globally via bun with an idempotency check.
3. In `.devcontainer/on-create.sh`, source both scripts (they're already wired in from the setup-shell.sh reordering).
4. In `README.md`, add authentication instructions for both tools (Gemini: Google account or `GEMINI_API_KEY`; Codex: `OPENAI_API_KEY`) and list them in the AI Tools section.

---

## 2026-04-14 — Pre-commit hook to enforce changelog updates

**Goal:** Automatically block significant commits that don't include a CHANGES.md update, so the changelog never falls behind.

**How to implement:**
1. In `.claude/settings.json`, add a `PreToolUse` hook with matcher `Bash(git commit*)`:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash(git commit*)",
           "hooks": [
             {
               "type": "command",
               "command": "bash -c '...check CHANGES.md is staged...'"
             }
           ]
         }
       ]
     }
   }
   ```
2. The hook extracts the conventional commit type (`feat:`, `fix:`, etc.) from `$TOOL_INPUT` and skips the check for minor types (`docs`, `chore`, `style`, `ci`, `test`).
3. For significant types (`feat`, `fix`, `refactor`, `perf`, `build`), it verifies `CHANGES.md` is in the staged files via `git diff --cached --name-only`. If missing, it exits with code 2 (block + message).

---

## 2026-04-14 — Run setup-shell.sh last in on-create.sh

**Goal:** Prevent tool installers from overwriting custom shell config during container setup.

**How to implement:**
1. In `.devcontainer/on-create.sh`, move the `source /workspace/.devcontainer/on-create/setup-shell.sh` line from early in the script (after `setup-proto.sh`) to the very end, after all other installer scripts and `setup-vscode-extensions.sh`.
2. Add a comment explaining why it must run last: tool installers (e.g. bun via proto) overwrite `~/.zshrc`, so our shell config must be written after all of them finish.

**Why:** Bun's installer (and potentially others) overwrites `~/.zshrc` during setup. When `setup-shell.sh` ran early, later installers would clobber the custom shell config, breaking devpod SSH auto-cd, aliases, PATH, and completions.

---

## 2026-04-08 — Add a shared commit policy in AGENTS.md (all agents)

**Goal:** Every AI agent (Claude Code, Cursor, Opencode) should always commit and push after each significant change without waiting for user confirmation — and follow the *same* policy, not a Claude-only copy.

**How to implement:**
1. Add a "Commit Policy" section to `AGENTS.md` (the shared-conventions file all agents consume):
   ```markdown
   ## Commit Policy
   ALWAYS commit and push after completing each significant change. Do NOT wait for the user to ask. Before committing, update `/workspace/CHANGES.md` with a dated entry (Goal + How to implement).
   ```
2. In `CLAUDE.md`, reference `@AGENTS.md` for shared conventions rather than duplicating the policy. (The policy was first added directly to `CLAUDE.md`, then moved into `AGENTS.md` the same day so all agents inherit one copy.)

---

## 2026-03-23 — Add OpenSpec skills/commands and improve Claude Code setup

**Goal:** Provide OpenSpec workflow skills (explore, propose, apply, archive) as slash commands for Claude Code and Codex. Also fix a stale-binary issue in the Claude Code setup script.

**How to implement:**
1. Create OpenSpec skill definitions under `.claude/skills/` and `.codex/skills/` for four workflows: `openspec-apply-change`, `openspec-archive-change`, `openspec-explore`, and `openspec-propose`.
2. Create corresponding slash commands under `.claude/commands/opsx/` (`apply.md`, `archive.md`, `explore.md`, `propose.md`).
3. In `.devcontainer/on-create/setup-claude.sh`, add a step to remove any stale bun-installed `claude-code` binary before installing the native binary, and use an explicit path check (`[ -f ~/.local/bin/claude ]`) instead of `command -v`.

---

## 2026-03-21 — Allow CI test step to pass with no tests

**Goal:** The template ships with no test files, so `bun test` fails and breaks CI. Let CI stay green until downstream projects add their own tests.

**How to implement:**
1. In `.github/workflows/ci.yml`, add `continue-on-error: true` to the test step:
   ```yaml
   - run: bun test
     continue-on-error: true
   ```

---

## 2026-04-08 — Devcontainer upgrades: Trixie, RTK, zsh default shell, SSH workspace dir, disable Moby

**Goal:** Modernize the devcontainer base image, add token compression tooling, fix SSH shell defaults, and switch from Moby to Docker CE.

**How to implement:**
1. **Upgrade base image to Debian 13 (Trixie):** In `.devcontainer/Dockerfile`, change base image tag from `bookworm` to `trixie`. Brings GLIBC 2.41, OpenSSL 3.4+, GCC 14.
2. **Add RTK (token compression):** In `Dockerfile`, add a new `RUN` step after git-delta:
   ```dockerfile
   RUN ARCH=$(uname -m) \
       && wget -q "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${ARCH}-unknown-linux-gnu.tar.gz" -O /tmp/rtk.tar.gz \
       && tar xzf /tmp/rtk.tar.gz -C /usr/local/bin/ \
       && chmod +x /usr/local/bin/rtk \
       && rm /tmp/rtk.tar.gz
   ```
   In `.devcontainer/on-create/setup-claude.sh`, add RTK hook initialization:
   ```bash
   if command -v rtk &> /dev/null; then
       rtk init -g
   fi
   ```
   RTK requires GLIBC 2.39+, which is why the Trixie upgrade is a prerequisite. Saves 60-90% tokens on Claude Code bash output.
3. **Set zsh as default login shell for SSH:** In `Dockerfile`, add before `USER vscode`:
   ```dockerfile
   RUN chsh -s /usr/bin/zsh vscode
   ```
   In `devcontainer.json`, flip: `"configureZshAsDefaultShell": true`. SSH reads `/etc/passwd` (ignoring env vars), which `chsh` fixes.
4. **SSH starts in /workspace:** In `.devcontainer/configs/.shell_common`, add before PATH exports:
   ```bash
   [[ "$PWD" == "$HOME" ]] && cd /workspace
   ```
   Only fires when the shell opens in `$HOME` (the SSH default).
5. **Disable Moby:** In `devcontainer.json`, update docker-in-docker feature:
   ```json
   "ghcr.io/devcontainers/features/docker-in-docker:2": { "moby": false }
   ```

---

## 2026-03-21 — macOS onboarding: host setup script + README Quick Start & prerequisites

**Goal:** Let a non-technical user go from a bare Mac to a running devcontainer with minimal manual steps — a one-command host bootstrap plus copy-paste README instructions.

**How to implement:**
1. **Host setup script — `init-host.sh`** (repo root). Installs, via Homebrew: Xcode CLT, Docker Desktop, Git, DevPod, the Warp terminal (`brew install --cask warp`, between DevPod and IDE installation), an IDE (Cursor or VS Code, user's choice), GitHub CLI, and SSH keys. Also creates the host directories used for container mounts.
2. **README — "Prerequisites (Host Machine Setup)"** section before "Getting Started", covering: Docker Desktop, Git, DevPod, an IDE, SSH keys, GitHub CLI, and host directory creation. Point Mac users to `init-host.sh` as the one-command path. Remove the now-redundant `mkdir` from the secrets step (covered here).
3. **README — "Quick Start (Mac)"** section at the top: the `curl | bash` one-liner, clone, init, and `devpod up`. Note the repo must be **public** for the `curl` one-liner to work without authentication.
4. **Template cleanup:** add `rm -f init-host.sh` to the template-only file cleanup in `init-new-project.sh` so the host script doesn't carry into downstream projects (see the project-init cleanup entry).

---

## 2026-03-20 — Clean up template-only files during project init

**Goal:** `init-new-project.sh` bootstraps a new project from the template; template-history files and the bootstrap script itself should not survive into the downstream project's tree.

**How to implement (all in `init-new-project.sh`):**
1. In the template-only file cleanup section, remove files that only make sense in the template repo — add `rm -f CHANGES.md` alongside the existing `rm -f bun.lock`. (The macOS onboarding entry also adds `rm -f init-host.sh` here.)
2. Add `rm -f "$0"` just before the `git add .` / initial-commit step so the bootstrap script deletes itself before being committed to the new repo.

---

## 2026-03-20 — Add Claude and Codex to Openspec init

**Goal:** Ensure Openspec generates configuration for all coding agents used in the template, not just Cursor and OpenCode.

**How to implement:**
1. In `.devcontainer/on-create/setup-openspec.sh`, update the `openspec init` command to include `claude` and `codex`:
   ```bash
   openspec init --tools claude,codex,cursor,opencode --force
   ```

---

## 2026-03-20 — Switch Claude Code to native binary installer

**Goal:** Use the official `claude install` native binary instead of the npm package (`bun install -g @anthropic-ai/claude-code`). The native binary is the recommended installation method and doesn't depend on Node/Bun for the CLI itself.

**How to implement:**
1. In `.devcontainer/on-create/setup-claude.sh`, replace `bun install -g @anthropic-ai/claude-code` with:
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   The native binary installs to `~/.local/bin/claude`.
2. Add `$HOME/.local/bin` to PATH in `.devcontainer/on-create/setup-common.sh` (inside `setup_proto_env()`).
3. Add `$HOME/.local/bin` to the front of the PATH export in `.devcontainer/configs/.shell_common` so interactive shells find the binary.
4. Remove the `mkdir -p ~/.config/claude-code` line from `setup-claude.sh` — the native binary uses `~/.claude` (already managed by the volume mount).

---

## 2026-03-20 — Add CHANGES.md for template change tracking

**Goal:** Establish a changelog so that projects forked from this template can track and adopt upstream improvements.

**How to implement:**
1. Create a `CHANGES.md` file at the repo root with this structure: a top-level heading, a brief description of purpose, and entries formatted as `## YYYY-MM-DD — Title`.
2. Each entry should include a **Goal** and **How to implement** section with step-by-step instructions for adopting the change in a downstream repo.
3. Update this file before committing and pushing any significant change to the template.

---

## 2026-03-17 — Preserve empty directories with `.gitkeep`

**Goal:** Keep `apps/`, `libs/`, and `scripts/` in version control even when empty, so the monorepo structure is present from the first clone.

**How to implement:**
1. For each empty directory you want to track, add an empty placeholder file:
   ```bash
   touch apps/.gitkeep libs/.gitkeep scripts/.gitkeep
   git add apps/.gitkeep libs/.gitkeep scripts/.gitkeep
   ```
2. Git does not track directories — only files. The `.gitkeep` filename is a convention; the file has no content and no special meaning to git.

---

## 2026-03-16 — On-create idempotency: skip already-installed tools on recreate

**Goal:** Make container rebuilds fast by skipping setup steps that have already run. Without this, opencode (~70s) and oh-my-opencode reinstall on every `devpod up`, and the banner hardcodes a project name.

**How to implement:**
1. In `.devcontainer/on-create/setup-opencode.sh`, wrap the install in a presence check:
   ```bash
   if ! command -v opencode &>/dev/null; then
     # install opencode
   fi
   ```
2. In `.devcontainer/on-create/setup-oh-my-opencode.sh`, check whether the plugin is already configured before running `bunx`:
   ```bash
   if ! opencode config show 2>/dev/null | grep -q "oh-my-opencode"; then
     # install plugin
   fi
   ```
3. In `.devcontainer/devcontainer.json`, ensure `postCreateCommand` and `postStartCommand` include `~/.proto/shims` in `PATH` — this is where proto places tool binaries, not `~/.proto/bin`:
   ```json
   "postCreateCommand": "export PATH=$HOME/.proto/shims:$PATH && bun install"
   ```
4. Replace any hardcoded project name in on-create banners with `$DEVCONTAINER_PROJECT`.

---

## 2026-03-16 — Node.js LTS devcontainer feature (required for Claude Code)

**Goal:** Claude Code (`@anthropic-ai/claude-code`) is a Node.js package. Even when installed via Bun, it requires `node` to be present on `PATH`. Without it, `claude mcp add` fails with `/usr/bin/env: 'node': No such file or directory`.

**How to implement:**
1. In `.devcontainer/devcontainer.json`, add the Node.js LTS feature:
   ```json
   "features": {
     "ghcr.io/devcontainers/features/node:1": {
       "version": "lts"
     }
   }
   ```
2. Rebuild the container. Node will be available at the system level for all processes.

---

## 2026-03-16 — Proto tool caching via persistent Docker volume

**Goal:** Proto re-downloads all tools (bun, node, moon, etc.) on every container recreation, taking ~9 minutes. Mounting `~/.proto` as a named Docker volume makes downloaded binaries persist across rebuilds — first build is normal, subsequent rebuilds are seconds.

**How to implement:**
1. In `.devcontainer/devcontainer.json`, add a named volume mount for `~/.proto` scoped by `devcontainerId` to prevent cross-project collisions:
   ```json
   "mounts": [
     "source=devcontainer-${devcontainerId}-proto,target=/home/vscode/.proto,type=volume"
   ]
   ```
2. Because the Docker volume hides any files baked into the image at that path, you cannot pre-install proto in the Dockerfile and have it persist. Instead, bootstrap proto in `setup-proto.sh`:
   ```bash
   if ! command -v proto &>/dev/null; then
     curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --no-profile
   fi
   proto use  # installs all tools listed in .prototools
   ```
3. Add a `chown` guard in case the volume is first mounted as root:
   ```bash
   if [ "$(stat -c '%U' ~/.proto)" != "vscode" ]; then
     sudo chown -R vscode:vscode ~/.proto
   fi
   ```
4. In the Dockerfile, pre-create `~/.proto` as the `vscode` user so Docker volume inherits correct ownership on first mount:
   ```dockerfile
   USER vscode
   RUN mkdir -p /home/vscode/.proto
   ```
5. **Cross-device link fix:** Do not mount only subdirectories (`~/.proto/tools`, `~/.proto/plugins`) as separate volumes. Proto downloads to `~/.proto/temp/` then renames into `tools/` and `plugins/`. If these are on different filesystems, you get `Invalid cross-device link (os error 18)`. Mounting the entire `~/.proto` as one volume avoids this.

---

## 2026-03-16 — devcontainer hardening: extra CLI tools and scoped volume names

**Goal:** Add missing but commonly needed CLI tools (`fd`, `nano`, `vim`, `procps`/`ps`, `sudo`), set environment variables that improve terminal and IDE behavior, and scope Docker volume names so multiple projects on the same host don't share volumes.

**How to implement:**
1. In the Dockerfile, install additional tools and create symlinks:
   ```dockerfile
   RUN apt-get install -y fd-find nano vim procps sudo \
     && ln -s /usr/bin/fdfind /usr/local/bin/fd \
     && ln -s /usr/bin/batcat /usr/local/bin/bat
   ```
2. In `.devcontainer/devcontainer.json`, add these container environment variables:
   ```json
   "containerEnv": {
     "DEVCONTAINER": "true",
     "POWERLEVEL9K_DISABLE_GITSTATUS": "true"
   }
   ```
   `DEVCONTAINER=true` is a standard signal to tools that they're running inside a container. `POWERLEVEL9K_DISABLE_GITSTATUS` prevents Powerlevel10k from running git status on every prompt (a significant slowdown in large repos).
3. Scope all named Docker volume names with `${devcontainerId}` so multiple checkouts of this template on the same host each get their own volumes (see the Proto tool caching entry for the `~/.proto` volume mount and the cross-device-link rationale).

---

## 2026-03-16 — Host-mounted two-tier secrets system (incl. GitHub token forwarding)

**Goal:** `${localEnv:VAR}` in `devcontainer.json` only works when the IDE process itself has the env var set — GUI apps launched from Dock, Spotlight, or DevPod don't inherit shell exports, making this approach unreliable. Replace it with a bind-mounted secrets file that all container processes can read directly, regardless of how the IDE was launched. This is also how rate-limit tokens get forwarded: proto resolves tool versions via the GitHub API, and unauthenticated requests are capped at 60/hr per IP — putting `GITHUB_TOKEN` in the secrets file raises this to 5,000/hr.

**How to implement:**
1. On the host, create the secrets directory and files:
   ```bash
   mkdir -p ~/.config/devcontainer/secrets.d
   chmod 700 ~/.config/devcontainer/secrets.d
   # Common secrets (all projects):
   touch ~/.config/devcontainer/secrets
   chmod 600 ~/.config/devcontainer/secrets
   # Per-project secrets (named after DEVCONTAINER_PROJECT):
   touch ~/.config/devcontainer/secrets.d/my-project
   chmod 600 ~/.config/devcontainer/secrets.d/my-project
   ```
   File format — one `KEY=value` per line, `#` for comments. Put API and rate-limit tokens here:
   ```
   GITHUB_TOKEN=ghp_...          # raises GitHub API limit 60/hr → 5,000/hr (used by proto)
   CONTEXT7_API_KEY=your-key-here
   ```
2. In `.devcontainer/devcontainer.json`, bind-mount the config directory and set `DEVCONTAINER_PROJECT`:
   ```json
   "containerEnv": {
     "DEVCONTAINER_PROJECT": "my-project"
   },
   "mounts": [
     "source=${localEnv:HOME}/.config/devcontainer,target=/run/devcontainer-config,type=bind,readonly"
   ]
   ```
3. In `.devcontainer/on-create.sh`, load secrets early so all subsequent scripts and MCP subprocesses inherit them:
   ```bash
   load_secrets_file() {
     local file="$1"
     [ -f "$file" ] || return 0
     while IFS= read -r line || [ -n "$line" ]; do
       [[ "$line" =~ ^#|^$ ]] && continue
       echo "$line" | sudo tee -a /etc/environment > /dev/null
     done < "$file"
   }
   load_secrets_file /run/devcontainer-config/secrets
   load_secrets_file /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT}
   ```
   Writing to `/etc/environment` ensures ALL container processes (extension hosts, MCP servers, terminals) inherit the vars — not just the calling shell.
4. In `.devcontainer/configs/.shell_common`, add the same two-tier load for interactive terminal sessions (belt-and-suspenders):
   ```bash
   [ -f /run/devcontainer-config/secrets ] && set -a && source /run/devcontainer-config/secrets && set +a
   [ -f /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT} ] && set -a && source /run/devcontainer-config/secrets.d/${DEVCONTAINER_PROJECT} && set +a
   ```
5. When cloning this template for a new project, update `DEVCONTAINER_PROJECT` in `devcontainer.json` to match the per-project secrets filename.

**`remoteEnv` fallback for `GITHUB_TOKEN`:** `remoteEnv: { "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}" }` also forwards the token, but only when the IDE was launched from a shell that already has it set — prefer the secrets file, which works in GUI-launched IDEs too. If both are configured, the secrets file wins (it's loaded last).

---

## 2026-03-16 — Context7 MCP server integration

**Goal:** Register the Context7 MCP server into Claude Code during container creation so Claude always has access to up-to-date library documentation. Add an idempotency check so it isn't re-registered on every container rebuild.

**How to implement:**
1. Ensure `CONTEXT7_API_KEY` is available in the container (via the secrets system above).
2. In an on-create script, register the MCP server with an idempotency guard:
   ```bash
   if ! claude mcp list 2>/dev/null | grep -q "context7"; then
     claude mcp add --scope user context7 -- bunx @upstash/context7-mcp
   fi
   ```
3. Node.js must be installed (see the Node.js LTS entry above) — the `claude` CLI requires `node` on `PATH` to run `mcp add`.
4. Add `CONTEXT7_API_KEY` to your `~/.config/devcontainer/secrets` file on the host.

---

## 2026-03-16 — AGENTS.md: shared AI conventions across all tools

**Goal:** Claude Code (CLAUDE.md), Opencode, and Cursor each have their own instruction files. Duplicating conventions across all of them creates drift. `AGENTS.md` becomes the single source of truth for shared rules; each tool-specific file references it.

**How to implement:**
1. Create `AGENTS.md` at the repo root with shared conventions: runtime preferences (Bun-first APIs), monorepo structure, code quality rules, and secrets handling.
2. In `CLAUDE.md`, reference it at the top:
   ```markdown
   Shared conventions (Bun-first, monorepo structure, code quality, secrets) are in @AGENTS.md.
   ```
3. Configure Opencode and Cursor to also load `AGENTS.md` as context.
4. Keep tool-specific instructions (e.g., Bun's `Bun.serve()` frontend patterns for Claude) in their respective files; only truly shared rules go in `AGENTS.md`.

---

## 2026-03-15 — Dockerfile: migrate system installs to image layer

**Goal:** `on-create.sh` was installing apt packages, git-delta, Proto, and Zinit from scratch on every container rebuild. Moving these into a Dockerfile bakes them into the image layer — they only reinstall when the image itself is rebuilt, not on every `devpod up`.

**How to implement:**
1. Create `.devcontainer/Dockerfile`:
   ```dockerfile
   FROM mcr.microsoft.com/devcontainers/base:ubuntu
   USER root
   # System packages
   RUN apt-get update && apt-get install -y \
     git curl unzip xz-utils tree ripgrep fzf \
     && rm -rf /var/lib/apt/lists/*
   # git-delta
   RUN curl -fsSL https://github.com/dandavison/delta/releases/download/.../git-delta_..._arm64.deb -o /tmp/delta.deb \
     && dpkg -i /tmp/delta.deb && rm /tmp/delta.deb
   # Zinit (shallow clone to avoid slow-network hangs)
   RUN git clone --depth 1 https://github.com/zdharma-continuum/zinit.git /usr/local/share/zinit
   # Pre-create ~/.proto so volume mounts inherit correct ownership
   USER vscode
   RUN mkdir -p /home/vscode/.proto
   ```
2. Reference the Dockerfile in `.devcontainer/devcontainer.json`:
   ```json
   "build": {
     "dockerfile": "Dockerfile"
   }
   ```
3. Remove the corresponding install steps from `on-create.sh` — leave only user/project-specific configuration (shell config copies, Biome, Claude Code, Opencode, etc.).
4. **Zinit note:** Always use `--depth 1` when cloning Zinit. A full history clone hangs for 15+ minutes on slow networks.

---

## 2026-03-15 — Opencode and Openspec setup

**Goal:** Install and configure Opencode (an AI coding tool) and Openspec (a spec-driven development workflow), including slash commands usable from both Cursor and Opencode.

**How to implement:**
1. In `.devcontainer/on-create/setup-opencode.sh`, install Opencode and add it to PATH:
   ```bash
   if ! command -v opencode &>/dev/null; then
     bun install -g opencode
   fi
   ```
2. Create `.opencode/command/` with markdown files for each slash command (e.g., `openspec-apply.md`, `openspec-proposal.md`). Mirror the same files to `.cursor/commands/` for Cursor users.
3. In `.devcontainer/on-create/setup-openspec.sh`, install Openspec globally:
   ```bash
   bun install -g @fission-ai/openspec
   openspec init --yes
   ```
4. Add Openspec to `package.json` devDependencies and document usage conventions in `AGENTS.md`.
5. Mount Opencode auth if needed — see `devcontainer.json` `mounts` for the auth socket pattern.

---

## 2026-01-11 — Husky + commitlint for enforced commit conventions

**Goal:** Enforce conventional commit format (`feat:`, `fix:`, `chore:`, etc.) automatically on every commit via git hooks, preventing malformed commit messages from ever entering the history.

**How to implement:**
1. Install dependencies:
   ```bash
   bun add -D husky @commitlint/cli @commitlint/config-conventional
   ```
2. Initialize Husky and add hooks:
   ```bash
   bunx husky init
   echo "bunx commitlint --edit \$1" > .husky/commit-msg
   echo "bunx lint-staged" > .husky/pre-commit
   ```
3. Create `commitlint.config.ts` (or `.commitlintrc`):
   ```ts
   export default { extends: ["@commitlint/config-conventional"] };
   ```
4. In `package.json`, add the prepare script and lint-staged config:
   ```json
   {
     "scripts": {
       "prepare": "husky"
     },
     "lint-staged": {
       "*.{ts,tsx,js,jsx,json}": ["biome check --write"]
     }
   }
   ```
5. In `.devcontainer/devcontainer.json`, set `postCreateCommand` to include `bun install` so Husky hooks are registered automatically when the container is created.

---

## 2026-01-09 — Project initialization script (`init-new-project.sh`)

**Goal:** Cloning a template repo brings along its entire git history. The initialization script resets git, sets up a fresh remote, and optionally auto-creates the GitHub repository — reducing a multi-step manual process to a single command.

**How to implement:**
1. Create `init-new-project.sh` at the repo root. The script should:
   - Accept a repo name, `org/name`, or full URL as an argument
   - Run `rm -rf .git && git init && git add -A && git commit -m "Initial commit."` to reset history
   - Derive the remote URL from the argument (assume GitHub if no host given)
   - If `gh` CLI is available and authenticated, create the repo automatically: `gh repo create <name> --private --source=. --remote=origin`
   - Add the remote and optionally push: `git remote add origin <url>`
   - Auto-update `DEVCONTAINER_PROJECT` in `.devcontainer/devcontainer.json` to the new project slug
   - Remove `bun.lock` so the new project starts with a clean lockfile: `rm -f bun.lock`
2. Make it executable: `chmod +x init-new-project.sh`
3. Document usage in `README.md` covering all input forms: bare name, `org/name`, full URL, and no argument.

---

## 2026-01-11 — Moon 2.x, workspace config, and GitHub Actions CI

**Goal:** Upgrade Moon from 1.x to 2.x and configure the monorepo task system with inherited lint, typecheck, test, and build tasks wired to Bun and Biome. Add a CI workflow that runs these tasks on every push and PR to main.

**How to implement:**
1. In `.prototools`, update tool versions:
   ```toml
   moon = "2.1.0"
   proto = "0.55.4"
   bun = "1.x"
   ```
2. Create `.moon/workspace.yml`:
   ```yaml
   projects:
     apps: "apps/*"
     libs: "libs/*"
     scripts: "scripts/*"
   ```
3. Create `.moon/toolchain.yml` pointing to Bun:
   ```yaml
   bun:
     version: "1.x"
   ```
4. Create `.moon/tasks.yml` with inherited tasks:
   ```yaml
   tasks:
     lint:
       command: biome check .
     typecheck:
       command: bun tsc --noEmit
     test:
       command: bun test
     build:
       command: bun run build
   ```
5. Create `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   jobs:
     ci:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v2
         - run: bun install
         - run: bun run lint
         - run: bun run typecheck
         - run: bun test
   ```
6. In `package.json`, fix `engines` to `"bun": ">=1.3.4"` (not Node) and add scripts that delegate to Moon or Bun directly.

---

## 2026-01-11 — Housekeeping: Biome upgrade, port trimming, Openspec skills migration

**Goal:** Routine maintenance items bundled together.

- **Biome 2.4.7 → 2.4.8**: Update `@biomejs/biome` in `package.json` and migrate `biome.jsonc` schema URL to the current version.
- **Trim forwarded ports**: Reduced `devcontainer.json` `forwardPorts` from 15 entries to 4 (the ports actually used), reducing noise in the IDE ports panel.
- **Openspec skills migration**: Moved Openspec slash-command definitions to the canonical location under `.opencode/command/` and `.cursor/commands/` and removed the outdated `openspec/project.md`.
