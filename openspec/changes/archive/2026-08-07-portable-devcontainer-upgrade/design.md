## Context

This repository is a template, not an application. It currently ships an empty Bun/Moon monorepo skeleton plus a DevPod-oriented devcontainer, AI tooling, OpenSpec integration, and a downstream sync script. Tool versions are split across mutable Proto plugin URLs, feature tags, global runtime installers, `package.json`, and CI; `~/.proto` is a per-container volume; ports are fixed; CI permits type/test failures; and there is no worktree-aware command bridge or hosted-cloud contract.

The approved migration contract is broader than every generated project needs. The design therefore separates universal template invariants from conditional capabilities and treats generated minimal, cloud, and full fixtures as the proof that inclusion and omission both work.

## Goals / Non-Goals

**Goals:**

- Make every installed tool, generated behavior, mutable resource, and required check have one visible owner.
- Make generated projects reproducible across local containers, CI, and Codex Cloud.
- Allow multiple linked worktrees to run concurrently without sharing containers, ports, persistence, or agent authentication state.
- Make diagnostics read-only and hostile generated state inert.
- Deliver each migration stage from the latest green `main`, with implementation, guards, negative tests, docs, agent rules, and rollback in the same PR.
- Generate only the rules, scripts, workflows, and dependencies for enabled capabilities.

**Non-Goals:**

- Generating an application-specific service graph in this repository.
- Enabling Cloudflare, Playwright, Better Auth, RHF/Zod, Sentry, Vite proxy, or TanStack Start by default when the template has no corresponding generated application.
- Adding deployment credentials, remote writes, Moon remote execution, or a package cache without independent justification.
- Replaying the source repository's historical PR order or copying its names, ports, routes, checksums, and state layout.

## Decisions

### Use a committed parameter registry and capability renderer

`template-parameters.toml` will own template defaults, supported capabilities, paths, service descriptors, and safety limits. `init-new-project.sh` will render project identity and omit disabled-capability artifacts; fixture generation will exercise minimal, cloud, and full combinations. This is preferred to scattered `sed` replacements because omission, validation, and golden tests become explicit. The existing sync mechanism remains responsible for later template updates and must never overwrite project-owned OpenSpec content or application code.

### Give each version domain one authority

The root `.prototools` file owns Proto tools and immutable plugin locators. Docker `ARG` plus architecture checksums own non-Proto image downloads. The root package catalog and `bun.lock` own project CLIs. A digest lock owns devcontainer features. The cloud contract mirrors exact runtime requirements and is drift-checked against those authorities. Derived Proto partitions exist only to improve cache invalidation and must equal the root manifest as a set.

Alternatives such as runtime `latest` installs, mutable release endpoints, a Node feature with `lts`, and repeated version literals are rejected because they cannot be reproduced or mutation-tested reliably.

### Make the image immutable and payload-oriented

The Dockerfile will use separate stages for base packages, Proto foundation, Proto auxiliary tools, Graphify, browser payloads, agent CLIs, Claude, shell setup, and final assembly. `~/.proto` remains image-owned; an image marker and devcontainer-definition fingerprint fail with a rebuild instruction when stale. Project-local CLIs take precedence on `PATH`.

The browser stage is emitted only when Playwright is enabled. Agent payload stages are emitted only for selected agents. Docker-in-Docker, redundant features, and runtime installers are removed with their replacements.

### Dispatch commands by verified execution environment

One bridge decides among three paths: direct execution inside the devcontainer, direct execution in Codex Cloud after the cloud doctor passes, or host-side ensure plus `docker exec` into the container owned by the current canonical checkout/config pair. Docker, devcontainer lifecycle, host routing, and remote pushes remain host-owned.

This central seam prevents agent rules, Git hooks, and documentation from inventing competing execution paths.

### Treat worktree state as untrusted generated data

Generated state lives under an ignored root and is published atomically. Worktree identifiers, offsets, ports, paths, URLs, container IDs, labels, and manifests are validated before use. The doctor reads only allowlisted fields, canonicalizes paths, restricts probes to loopback or `.localhost`, and never sources generated shell. Stable JSON schema/status/check identifiers are public interfaces.

The service registry drives port allocation, profiles, dependency order, semantic readiness, persistence propagation, and lifecycle. A minimal template with no services still supports container ensure/bridge/doctor without generating dead service commands.

### Roll out CI and Moon separately

The first CI slice introduces a composite pinned Bun action, frozen bounded install, base-branch-agnostic PR triggers, draft/ready concurrency lanes, explicit timeouts, and one aggregate gate. CI remains full-matrix while Moon project metadata, universes, the independent graph oracle, and affected fixtures are established. A later PR enables affected selection behind a single `full|moon` switch; selector errors choose full, while invalid universes fail loudly.

### Keep OpenSpec active through shipping

The active change remains in implementation PRs. Tasks are checked only as their code and validation complete. Archive is a post-merge operation guarded by a clean, freshly fetched default-branch worktree equal to `origin/main`, strict validation across every root, and duplicate refusal. This avoids feature-branch archives that erase review context.

### Use staged, independently mergeable PRs

The delivery order is: specification, inventory/capability baseline, toolchain contract, image architecture, browser/agent payloads, cloud parity, additive worktree runtime, entrypoint cutover, doctor, CI safety, Moon graph, Moon selection, OpenSpec/agent safety, and final release validation. Conditional stack modules receive separate PRs only when enabled. Each branch starts from the latest green default branch; implementation does not start until this specification PR is merged.

## Risks / Trade-offs

- [Large migration surface] → Keep old behavior until each replacement passes its acceptance tests, and use one PR per stage with an explicit rollback.
- [Pinned tools become stale] → Use isolated Renovate updates and drift guards; never trade reviewability for mutable pins.
- [Docker/architecture tests are expensive] → Separate hermetic required tests from path-scoped live image/cloud/browser smoke while keeping direct contract guards required.
- [Template conditionals can leave residue] → Generate minimal/cloud/full fixtures and scan disabled fixtures for dead artifacts, mutable pins, and source-project identifiers.
- [Worktree scripts can mutate the wrong resources] → Require ownership labels, canonical paths, scoped inventories, malicious fixtures, and before/after non-mutation snapshots.
- [Affected CI can skip required work] → Start in full mode, require an independent graph oracle, fall back to full on computation errors, and fail closed on corrupt universes.
- [OpenSpec tasks span many PRs] → Keep task groups aligned to PR boundaries and update checkboxes only on the branch that completes the work.

## Migration Plan

1. Merge the spec-only PR and establish Stage 0 baseline evidence without changing runtime behavior.
2. Land each universal stage from the latest green `main`, retaining its predecessor until acceptance succeeds.
3. Keep capability flags off until their complete implementation, tests, docs, and guards land atomically.
4. Run additive worktree orchestration in soak mode before changing the documented/default entrypoint.
5. Keep CI affected mode `full` until Moon metadata and shadow comparisons are proven, then switch with one repository variable.
6. Generate and validate all supported fixtures, compare performance/storage with baseline, remove obsolete paths, and release.

Rollback is stage-local: revert the atomic stage bundle or flip the documented single rollback switch. Never roll back only a lockfile, catalog pin, coupled dependency member, Proto partition, browser pin, or affected selector component.

## Open Questions

No question blocks the specification. Exact current versions and checksums, service descriptors in downstream fixtures, supported image architectures in live CI, and measured performance budgets are Stage 0/implementation evidence rather than assumptions in this design.
