**Current status (2026-07-15):** 20 of 82 tasks are complete. Stages 0 through 3 have merged; Stage 4 is next.

## 1. Stage 0 PR — Inventory, Parameters, and Baseline

This stage establishes the source-of-truth parameters and baseline measurements so later changes can be generated consistently and compared against known behavior, performance, storage, and rollback data.

- [x] 1.1 Add and schema-validate `template-parameters.toml` with project, path, toolchain, service, CI, worktree, and capability defaults derived from the current template
- [x] 1.2 Inventory template-owned files, downstream sync exclusions/overrides, hardcoded identities/paths/ports, version authorities, and enabled versus supported capabilities
- [x] 1.3 Add minimal, cloud, and full fixture definitions plus a deterministic fixture renderer that omits disabled capabilities
- [x] 1.4 Capture recoverable pre-migration SHA, image/container/volume inventory, tool and lock multiplicity, CI checks/duration, build/restart/readiness timings, command latency samples, and second-worktree disk growth
- [x] 1.5 Validate all existing generated paths, add fixture anti-residue assertions, document rollback as observational, update `CHANGES.md`, and publish machine-readable Stage 0 evidence

## 2. Stage 1 PR — Repository Toolchain and Dependency Contract

This stage creates one exact, reproducible authority for tools and dependencies—including Proto, Bun, the package catalog and lockfile, devcontainer features, checksums, and TypeScript paths—and adds guards that catch drift.

- [x] 2.1 Exact-pin root Proto tools and immutable plugin commit URLs, add checksum-verified architecture-aware Proto bootstrap metadata, and add Node/Caddy/k6 only when selected
- [x] 2.2 Exact-pin project CLIs and shared dependencies in the root catalog/lockfile, convert all consumers to catalog ownership, and put workspace-local binaries first
- [x] 2.3 Generate and commit a digest-pinned devcontainer feature lock and remove TypeScript `baseUrl`/absolute source-project aliases in favor of rendered config-relative paths
- [x] 2.4 Add non-vacuous guards for mutable/floating pins, catalog bypass, second lock resolutions, coupled Cloudflare/Better Auth/RHF-Zod families, TypeScript `baseUrl`, and bad installer checksums
- [x] 2.5 Prove each guard with temporary known-bad mutations, run frozen install/typecheck/fixture generation, document atomic rollback and evidence, update rules/docs/`CHANGES.md`, and refresh Graphify without staging graph artifacts

## 3. Stage 2 PR — Devcontainer Image Architecture

This stage moves reusable tools into a layered, immutable devcontainer image, verifies that each checkout matches the image before startup, and eliminates per-worktree tool duplication.

- [x] 3.1 Split the Dockerfile into stable base, Proto foundation, Proto auxiliary, Graphify, browser, agent CLI, Claude, shell, and final assembly payloads selected by capabilities
- [x] 3.2 Generate foundation/auxiliary Proto partitions from the root manifest and add a union-equality drift guard with negative fixtures
- [x] 3.3 Make `~/.proto` image-owned, add the manifest marker and complete devcontainer-definition fingerprint, remove the active Proto volume, and retain scoped legacy-volume cleanup
- [x] 3.4 Exact-pin every direct download through Docker ARG plus per-architecture checksum, make fallbacks read the owner pin, add isolated Renovate rules, and remove Docker-in-Docker/redundant features/unused installers
- [x] 3.5 Validate clean/warm builds, layer invalidation, stale-image refusal, supported architectures, shell PATHs, and second-worktree storage; record rollback/evidence and update rules/docs/`CHANGES.md`

## 4. Stage 3 PR — Browser and Agent Runtime Payloads

This stage adds pinned browser and agent runtime payloads, local-only plugin setup, a bounded Gemini watchdog, and real launch, shell, and evidence checks.

- [x] 4.1 Implement capability-gated Playwright package/lock/Docker pin coherence and bake the matching headless shell, FFmpeg, and libraries into its isolated image stage
- [x] 4.2 Add a repository-local browser preflight that launches, loads/verifies a page, closes cleanly, and runs after creation plus in CI/cloud browser profiles
- [x] 4.3 Exact-pin enabled Codex, Gemini, Claude, Graphify, ccstatusline, Context7, and Octopus payloads; remove duplicate skill paths and floating first-run/runtime installs
- [x] 4.4 Implement the Gemini headless watchdog with pass-through, streaming JSON activity, bounded partial lines, timeout 124, signal escalation, child-code propagation, bypass, and process-group cleanup
- [x] 4.5 Run pin/runtime/watchdog known-bad fixtures and real bounded smoke, verify login/non-login PATH ownership, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 5. Stage 4 PR — Codex Cloud Parity

This stage gives Codex Cloud the same verified core and browser toolchain as the local devcontainer, with bounded bootstrap, a read-only doctor, and safe direct execution.

- [ ] 5.1 Add a validated cloud contract with core/browser profiles, exact aligned tools, architectures, checksums, markers, commands, fingerprint inputs, and network posture
- [ ] 5.2 Add the shared checksum-pinned Proto installer and idempotent bounded bootstrap with frozen dependencies, profile-specific browser setup, and fresh-shell environment persistence
- [ ] 5.3 Add the fail-closed read-only cloud doctor for marker/profile/fingerprint/tool/dependency/browser validation
- [ ] 5.4 Route verified cloud commands directly before host orchestration and forbid Docker, worktree lifecycle, deployment, and production credentials in cloud
- [ ] 5.5 Add hermetic bootstrap/contract mutation tests and separate path/schedule/manual core/browser network smoke; record rollback/evidence and update rules/docs/`CHANGES.md`

## 6. Stage 5A PR — Additive Isolated Worktree Runtime

This stage builds the new multi-worktree runtime alongside the existing entrypoint, giving each checkout its own identity, ports, container, persistence, routing, and lifecycle.

- [ ] 6.1 Implement validated worktree identity, stable collision-safe offset/port allocation, generated environment, service/profile registry, URLs, and per-worktree persistence
- [ ] 6.2 Implement container ensure with canonical checkout/config ownership, Git-common-directory mount, deterministic definition fingerprint, and validated ready-state fast path
- [ ] 6.3 Implement the environment-aware command bridge with nested cwd mapping, development user, local-bin precedence, generated environment, direct container/cloud paths, and interactive shell behavior
- [ ] 6.4 Implement atomic active/inactive/removed manifests, direct loopback routing, optional validated host Caddy snippets, and single-root persistence propagation
- [ ] 6.5 Implement semantic dependency-ordered startup, bounded readiness/liveness, explicit staggered diagnostic mode, scoped down/cleanup, and legacy resource cleanup
- [ ] 6.6 Validate two live worktrees, ownership attacks, Git operations, routes, persistence, recreate/fast path, authentication round trip, and cleanup isolation; keep the old entrypoint as rollback and update evidence/rules/docs/`CHANGES.md`

## 7. Stage 5B PR — Entrypoint Cutover

This stage switches users and tooling to the isolated command bridge after soak testing, removes superseded orchestration, and proves onboarding and rollback end to end.

- [ ] 7.1 Route host project tooling, hooks that need project tools, onboarding commands, generated README content, and agent instructions through the isolated bridge
- [ ] 7.2 Keep project commands direct inside the devcontainer/verified cloud and keep Docker, lifecycle, routing, and remote pushes host-owned
- [ ] 7.3 Remove obsolete competing orchestration/install paths after soak while preserving data formats and the documented rollback commit
- [ ] 7.4 Run a fresh-clone onboarding journey from prerequisites through setup/up/diagnosis/down/cleanup, update evidence/rules/docs/`CHANGES.md`, and prove rollback restores the predecessor path

## 8. Stage 6 PR — Secure Read-only Worktree Doctor

This stage adds a read-only doctor that explains environment health in human and JSON form while safely rejecting malformed or untrusted generated state.

- [ ] 8.1 Implement human and schema-versioned JSON output, stable check IDs/statuses, configurable bounded probes, normal/strict exit semantics, and invalid-argument exit 2
- [ ] 8.2 Add checks for host requirements, Docker/devcontainer CLI, generated state, ownership/readiness/Git mount, volumes/ports/tools, optional Caddy, routes, and duplicate active port claims
- [ ] 8.3 Parse only allowlisted fields, canonicalize/contain paths, reject traversal/symlink/control/malformed/external targets, restrict probes to loopback/`.localhost`, and redact secrets
- [ ] 8.4 Add healthy/recoverable/wrong-owner/missing-tool/route/collision/strict/JSON/inside-container and malicious-state fixtures with before/after non-mutation snapshots
- [ ] 8.5 Run unit and live doctor acceptance, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 9. Stage 7 PR — CI Bootstrap and Workflow Safety

This stage makes CI bootstrap deterministic and workflows fail closed, with correct triggers, timeouts, concurrency, aggregate gates, and mutation-tested policy checks.

- [ ] 9.1 Add one composite action that requires the exact root Bun pin and performs optional frozen install with bounded attempts; atomically convert every workflow caller
- [ ] 9.2 Make PR workflows base-branch agnostic with ready-for-review activity and separate draft/ready concurrency lanes; add non-vacuous structural trigger tests
- [ ] 9.3 Add explicit job timeouts, remove permissive `continue-on-error`, unsupported inputs/contexts, mutable action inputs, fixed sleeps, blanket retries, and unmeasured Bun caching
- [ ] 9.4 Add one `always()` aggregate gate with every correctness/detection/selection/oracle dependency and explicit informational/network-smoke exclusions
- [ ] 9.5 Add mutation tests for setup input/context, trigger forms, aggregate dependency/results, semantic readiness/liveness, runtime ownership, compiler coverage, and network isolation; update evidence/rules/docs/`CHANGES.md`

## 10. Stage 8A PR — Moon Graph and Full-mode Gate

This stage introduces Moon's project graph and a validated CI universe while keeping execution in full-matrix mode, so dependency metadata can be proved before it affects selection.

- [ ] 10.1 Exact-pin/configure Moon and generate project `moon.yml` files whose `dependsOn` matches workspace manifests and relevant source imports
- [ ] 10.2 Define the sole non-empty CI universe registry and require every generated CI-covered project to be registered exactly as intended
- [ ] 10.3 Implement an independent workspace/import graph oracle that rejects missing/extra/unknown edges/projects and query failure
- [ ] 10.4 Add leaf, fan-out, deepest-transitive, root/global, project-manifest, docs-only, and universe corruption fixtures while CI remains full-matrix
- [ ] 10.5 Run graph/universe mutation proof and full CI, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 11. Stage 8B PR — Moon Affected Selection

This stage enables Moon-based affected-project selection after shadow comparison, with conservative full-run fallbacks for risky or uncertain changes.

- [ ] 11.1 Add the single `full|moon` switch and select full for default-branch pushes, schedules, deployments, manual full runs, root/global/unknown inputs, or selector/diff/Moon/query failure
- [ ] 11.2 Diff PR/merge-queue events against the actual base with sufficient history, include deep dependents, and intersect results with validated explicit universes
- [ ] 11.3 Make affected selection and graph oracle direct aggregate dependencies, prevent affected-only deployment paths, and fail loudly without output on invalid universe metadata
- [ ] 11.4 Compare shadow results, flip only the mode variable after representative proof, observe PR and full cycles, then remove every second selector/shadow path
- [ ] 11.5 Run full/docs/leaf/fan-out/deep/global/error/universe/stacked-PR mutations, document `full` rollback and evidence, and update rules/docs/`CHANGES.md`

## 12. Stage 9 PR — OpenSpec and Agent Lifecycle

This stage makes OpenSpec validation and archival safe and reproducible, and consolidates agent rules so all supported assistants follow one lifecycle.

- [ ] 12.1 Add repository-local multi-root strict OpenSpec validation using CLI-returned roots/context paths with anti-vacuity and active/archive hygiene checks
- [ ] 12.2 Add an executable archive wrapper requiring explicit selection when ambiguous plus freshly fetched clean current `main` exactly equal to `origin/main`
- [ ] 12.3 Implement delta assessment/sync, duplicate-destination refusal, post-archive strict validation, and commit/push only after success
- [ ] 12.4 Consolidate canonical cross-agent rules and mechanically synchronize required tool-specific commands/skills without duplicate normative text
- [ ] 12.5 Prove feature/dirty/stale/missing-base/duplicate/ambiguous/invalid archive refusal and one disposable post-merge lifecycle; record rollback/evidence and update docs/`CHANGES.md`

## 13. Stage 10A PR — Shared Schemas, Forms, and API Contracts

This stage generates shared request and response contracts for forms, servers, and APIs, eliminating parallel handwritten types and making contract drift block deployment.

- [ ] 13.1 Add capability-gated browser-safe shared request schemas/types, server parsing, RHF/Zod catalog family, visible business-rejection mapping, and remove superseded validators atomically
- [ ] 13.2 Generate response types from authoritative OpenAPI/contracts and block handwritten parallel response types plus inline authorization outside the policy seam
- [ ] 13.3 Make OpenAPI drift block every deployment path and add browser/server, malformed HTTP, deployment-skew, authorization, mutation, and anti-vacuity tests
- [ ] 13.4 Validate generated enabled/disabled fixtures, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 14. Stage 10B PR — Sentry and External-write Safety

This stage adds capability-gated Sentry configuration and explicit safeguards around external writes so telemetry and remote mutations occur only with complete intent and credentials.

- [ ] 14.1 Add capability-gated centralized Sentry configuration with quiet-none, warn/disabled-partial, and enabled-both release/token semantics
- [ ] 14.2 Require explicit intent plus credentials for every generated external write and query/assert the final remote state after intentional writes
- [ ] 14.3 Add direct truth-table, token-only local-build zero-request, partial-config, allowlist, outage, and final-state tests
- [ ] 14.4 Validate generated enabled/disabled fixtures, record rollback/evidence, and update secrets registry/rules/docs/`CHANGES.md`

## 15. Stage 10C PR — Vite WebSocket Proxy Safety

This stage generates correct HTTP and WebSocket proxy configuration and proves real WebSocket and HMR behavior, preventing structurally valid but nonfunctional proxy setups.

- [ ] 15.1 Generate enabled development and preview proxy routes in aligned object form with `ws: true`
- [ ] 15.2 Add non-vacuous structural proxy policy tests and real HTTP/WebSocket/HMR handshake tests with string-shorthand and missing-`ws` mutations
- [ ] 15.3 Validate generated enabled/disabled fixtures, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 16. Stage 10D PR — TanStack Start Safety

This stage makes the TanStack Start stack strict and reproducible, aligns its Cloudflare tool family, and proves SSR reads plus browser mutations in a generated fixture.

- [ ] 16.1 Generate the strict shared Start TypeScript base without `baseUrl` or nonexistent globals and align Cloudflare Vite/runtime pins as one family
- [ ] 16.2 Typecheck, test, build, and smoke one SSR read plus one browser mutation through the intended proxy in the generated fixture
- [ ] 16.3 Add pin/config/build/graph mutations, validate enabled/disabled fixtures, record rollback/evidence, and update rules/docs/`CHANGES.md`

## 17. Stage 10E PR — Experiment Hygiene

This stage defines how experiments are created, removed, or promoted without weakening dependency, graph, CI, dead-code, or release hygiene.

- [ ] 17.1 Add disposable/promoted experiment metadata and guards that preserve Moon, dead-code, manifest, typecheck, universe, and CI strictness
- [ ] 17.2 Add removal and promotion fixtures proving dependencies/registrations are removed or full ownership/graph/universe/tests/docs are added
- [ ] 17.3 Record reusable findings separately, validate mutation failures, document rollback/evidence, and update rules/docs/`CHANGES.md`

## 18. Stage 11 PR — Final Template Release

This stage runs the complete release gate across generated fixtures and live environments, resolves baseline regressions, finalizes documentation, and tags only a clean, green template.

- [ ] 18.1 Add deterministic generation golden tests for minimal, cloud, and full capability fixtures plus disabled-residue/source-identifier/mutable-pin/duplicate-rule scans
- [ ] 18.2 Run clean/incremental image builds, simultaneous worktrees, doctor security, full and affected CI modes, cloud profiles, browser preflight, OpenSpec lifecycle, dependency guards, and enabled stack tests
- [ ] 18.3 Compare final performance/storage/reliability with Stage 0 and resolve or explicitly approve every regression
- [ ] 18.4 Finalize onboarding, troubleshooting, generated README, legacy cleanup, canonical agent rules, and release rollback documentation
- [ ] 18.5 Require exact-head green PR CI plus full default-branch/nightly evidence, verify a clean tree, update `CHANGES.md`, and only then tag/release the template
