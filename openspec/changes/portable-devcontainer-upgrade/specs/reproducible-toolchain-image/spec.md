## ADDED Requirements

### Requirement: Exact tool and dependency ownership
The template MUST use exact, visible versions with one authority per domain: root `.prototools` for Proto tools/plugins, Docker version/checksum arguments for other image binaries, root catalog plus `bun.lock` for project CLIs, and a digest lock for devcontainer features.

#### Scenario: Floating or duplicate authority is introduced
- **WHEN** a mutation adds `latest`, a mutable plugin branch, a mutable release URL, a divergent package pin, a second runtime resolution, or a duplicated Docker/on-create version literal
- **THEN** a non-vacuous required guard fails and names the violated authority

#### Scenario: Frozen install uses local CLIs
- **WHEN** repository dependencies are installed and a project CLI is invoked
- **THEN** frozen Bun installation succeeds and the workspace `node_modules/.bin` command resolves before any global copy

### Requirement: Coupled dependency families are atomic
When a coupled family is enabled, every catalog pin, consumer, lockfile resolution, compatibility guard, image/runtime consumer, and test SHALL change together.

#### Scenario: Cloudflare runtime forks
- **WHEN** Cloudflare is enabled and Wrangler, workerd, Miniflare, the Workers Vitest pool, or the Vite plugin resolves more than once or bypasses catalog ownership
- **THEN** the family guard fails before application tests rely on hoisting

#### Scenario: Disabled family is absent
- **WHEN** Cloudflare, Better Auth, or RHF/Zod is disabled
- **THEN** no family dependency, guard, workflow, or instruction is generated

### Requirement: Image-owned Proto and cache partitions
The devcontainer image SHALL install the exact root Proto toolchain into image-owned `~/.proto`, split foundation and auxiliary manifests only for caching, and verify their union equals the root manifest.

#### Scenario: Root manifest changes after image build
- **WHEN** the checkout's `.prototools` fingerprint differs from the image marker
- **THEN** container setup fails with a rebuild/recreate instruction and does not mutate the installed toolchain

#### Scenario: Derived manifest drifts
- **WHEN** a tool or plugin is missing, duplicated, or divergent between the root and derived manifests
- **THEN** the split-manifest guard fails

#### Scenario: Second worktree starts
- **WHEN** another worktree uses the same image
- **THEN** no per-worktree Proto volume or gigabyte-scale Proto copy is created

### Requirement: Layered immutable image payloads
The Dockerfile SHALL separate independently changing payloads, exact-pin direct downloads with architecture-specific SHA-256 values, reject unsupported architectures, and exclude unproven Docker-in-Docker, redundant features, and duplicate installers.

#### Scenario: Cheap agent pin changes
- **WHEN** only one agent CLI version changes
- **THEN** unrelated Proto, Graphify, browser, and stable system payload stages remain cacheable

#### Scenario: Download checksum is wrong
- **WHEN** an architecture checksum or downloaded artifact is mutated
- **THEN** the build fails before installing the binary

### Requirement: Optional browser runtime coherence
When Playwright is enabled, the exact package pin, lockfile packages, Docker argument, installed browser payload, local/CI/cloud CLI, and real browser launch SHALL agree; otherwise all browser artifacts SHALL be omitted.

#### Scenario: Browser pin drifts
- **WHEN** one Playwright authority differs from the others
- **THEN** a dedicated required pin guard fails before browser tests

#### Scenario: Browser files exist but cannot launch
- **WHEN** the baked browser is corrupt or missing a required library
- **THEN** the preflight fails after attempting to launch, load a known page, verify it, and close cleanly

### Requirement: Exact agent runtime payloads
Enabled agent CLIs SHALL be exact-pinned, reachable in login and non-login shells, free of duplicate skill discovery paths, non-blocking in unattended setup, and invoked through Proto-managed interpreters where applicable.

#### Scenario: Gemini headless process becomes idle
- **WHEN** the enabled Gemini watchdog receives no text or tool activity for its configured bound
- **THEN** it terminates the full child process group, leaves no orphan, and exits 124 while preserving pass-through and normal child exit behavior in other modes
