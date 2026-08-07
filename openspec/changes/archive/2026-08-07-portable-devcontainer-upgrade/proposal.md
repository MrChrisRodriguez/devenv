## Why

The template currently relies on mutable tool downloads, runtime installation, fixed ports, a per-container Proto volume, permissive CI, and host-specific assumptions that make generated projects slow to reproduce and unsafe to run in parallel worktrees. The approved migration kit dated 2026-07-14 provides the contract needed to replace those seams with pinned, testable, capability-aware behavior.

## What Changes

- Add a completed template parameter and capability model so project identity, paths, tools, services, ports, and optional stacks are generated deliberately.
- Establish exact ownership for repository tools, image tools, feature digests, project CLIs, and coupled dependency families.
- Rebuild the devcontainer around independently cached image payloads, image-owned Proto, immutable downloads, and fail-closed drift checks.
- Add reproducible Codex Cloud core/browser profiles with an idempotent bootstrap and read-only doctor.
- Add one isolated container, port allocation, manifest, persistence root, command bridge, lifecycle, and safe doctor per checkout/worktree.
- Harden GitHub Actions with a single pinned Bun setup action, base-branch-agnostic PR triggers, explicit timeouts, negative policy tests, and an aggregate required gate.
- Make Moon affected selection, OpenSpec lifecycle, browser tooling, Cloudflare, and stack-specific protections capability-gated and non-vacuous.
- Consolidate durable cross-agent rules and release evidence for generated minimal and full fixtures.
- **BREAKING**: remove the mutable `~/.proto` volume, floating tool/plugin installs, fixed port forwarding, and direct host execution paths after their replacements pass acceptance.

## Capabilities

### New Capabilities

- `template-capability-model`: Parameter ownership, capability flags, generated fixtures, disabled-capability omission, and baseline evidence.
- `reproducible-toolchain-image`: Exact tool/dependency ownership, immutable installation, layered image payloads, drift guards, and optional browser/agent runtimes.
- `codex-cloud-parity`: Machine-readable cloud profiles, idempotent bootstrap, fingerprinted state, fail-closed diagnosis, and direct cloud execution.
- `isolated-worktree-runtime`: Per-worktree identity, ports, containers, Git metadata, persistence, routing, command execution, lifecycle, and read-only diagnosis.
- `ci-governance`: Pinned dependency bootstrap, PR trigger/concurrency policy, aggregate gating, reliable tests, and optional Moon affected selection.
- `agent-spec-safety`: Canonical agent rules, OpenSpec post-merge lifecycle, secret boundaries, external-write intent, and experiment hygiene.
- `template-release-validation`: Golden generation, negative/mutation coverage, live smoke evidence, performance/storage comparison, and final template release criteria.

### Modified Capabilities

None. This repository has no existing canonical OpenSpec capability specs.

## Impact

The change affects `.prototools`, `package.json`, `bun.lock`, TypeScript bases, `.devcontainer/`, `.codex/`, `.github/`, `.moon/`, agent-rule surfaces, host/project initialization, template synchronization, tests, generated fixtures, and developer documentation. Delivery is split into independently reviewable PRs; capability-specific artifacts are emitted only when enabled, and obsolete paths are removed only in the PR that cuts over to a verified replacement.
