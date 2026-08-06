# Agent Guidelines

Shared conventions for all AI coding tools (Claude Code, Codex, Gemini CLI, etc.).

## Agent Command Environment

Decide **where** a command runs before deciding what to type.

- Unless you are already inside this repository's development container or in a verified cloud task, route every project command through `bash scripts/worktree/exec.sh <command> [args...]`. That includes `bun`, `bunx`, `moon`, `tsc`, test runners, and every `package.json` script. The bridge is safe to call from either side: inside the container it executes in place.
- Stay on the host for host-owned work: `docker`, the `devcontainer` CLI, Git worktree management, remote pushes, every `scripts/worktree/*.sh` lifecycle script, and every `.devcontainer/host/*.sh` script. Starting a container from inside one is never correct.
- Read-only Git commands and file editing stay on the host too: the checkout is bind mounted, so both sides see the same bytes and the host answer is faster.
- Git commands that fire hooks — `git commit`, `git merge`, `git rebase` without `--no-verify` — reach the container through the hooks themselves, so run them on the host and let `.husky/*` do the routing.
- Never install project dependencies on the host. `bun install` belongs inside the container (`bash scripts/worktree/exec.sh bun install`); a host install writes host-platform binaries into the bind-mounted `node_modules`.
- `package.json` scripts and `.moon` tasks stay direct commands. Wrapping them in the bridge would recurse the moment they run inside the container.

## Runtime

**Always use Bun — never Node.js, npm, pnpm, or Vite.** This governs the project runtime and its dependencies. It does not govern host prerequisites: the `devcontainer` CLI is installed with `brew install devcontainer` or `npm install --global @devcontainers/cli`, because Bun is not a host prerequisite and a host `bun install` would poison the bind-mounted `node_modules`.

| Instead of | Use |
|---|---|
| `node <file>` / `ts-node <file>` | `bun <file>` |
| `npm install` / `yarn` / `pnpm install` | `bun install` |
| `npm run <script>` | `bun run <script>` |
| `npx <pkg>` | `bunx <pkg>` |
| `jest` / `vitest` | `bun test` |
| `webpack` / `esbuild` | `bun build <file>` |
| `dotenv` | _(not needed — Bun loads .env automatically)_ |

## Bun APIs

Prefer Bun-native APIs over third-party equivalents:

- `Bun.serve()` — HTTP server with WebSocket support. Don't use `express`.
- `bun:sqlite` — SQLite. Don't use `better-sqlite3`.
- `Bun.redis` — Redis. Don't use `ioredis`.
- `Bun.sql` — Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` — built-in. Don't use `ws`.
- `Bun.file()` — file I/O. Don't use `node:fs` readFile/writeFile.
- `Bun.$` — shell commands. Don't use `execa`.

## Monorepo Structure

```
apps/      # deployable applications (Next.js, Elysia, Cloudflare Workers, etc.)
libs/      # shared packages imported via @<project>/* path alias
scripts/   # one-off tooling scripts
```

- Path alias: `@<project>/*` → `${configDir}/../../libs/*/src` from each consuming project config
- Monorepo tasks (lint, typecheck, test, build) are defined in `.moon/tasks.yml` and run via `moon`

## Code Quality

- **Formatter/linter:** Biome — run as `bunx biome check --write .`
- **Commits:** Conventional Commits enforced by commitlint (`feat`, `fix`, `refactor`, `chore`, `docs`, `test`)
- **TypeScript:** strict mode, extend from the appropriate base config in the repo root:
  - `tsconfig.base.json` — general use
  - `tsconfig.lib.base.json` — shared libraries
  - `tsconfig.worker.base.json` — Cloudflare Workers
  - `tsconfig.start.base.json` — TanStack Start apps

## Toolchain Ownership

- `.prototools` is the only authority for Proto-managed tools and plugin locators; versions are exact and community plugins use immutable commit URLs.
- `.devcontainer/proto-checksums.txt` owns the supported-architecture Proto archive digests. Checksum mismatches and unsupported architectures fail closed.
- The root `package.json` catalog plus `bun.lock` own project CLIs and shared dependencies. Consumers use `catalog:` and workspace-local binaries resolve before global tools.
- `.devcontainer/devcontainer-lock.json` pins every configured feature by release and digest. Do not let Proto and a feature own the same tool.
- Cloudflare package family versions are coupled; update the family and its lock resolutions atomically.
- Better Auth package family versions are coupled; update the family and its lock resolutions atomically.
- RHF/Zod package family versions are coupled; update the family and its lock resolutions atomically.
- Playwright package family versions are coupled; update the family and its lock resolutions atomically.
- TypeScript paths must be config-relative with `${configDir}`. Do not add `baseUrl` or absolute source-project aliases.
- Run `bun run toolchain:check` after changing any tool, package, feature, checksum, TypeScript path, or PATH authority.

## Devcontainer Image Ownership

- `.prototools` remains the only human-edited Proto authority. The foundation and auxiliary manifests are Docker cache partitions whose tool and plugin union must equal the root manifest exactly.
- `~/.proto`, agent CLI payloads, Graphify, Claude, and Zinit are image-owned. Container lifecycle scripts verify them and fail with a rebuild/recreate instruction; they must not download, install, chown, or repair those payloads.
- Docker `ARG` values own non-Proto image versions. Direct downloads require exact versions, immutable URLs, supported-architecture selection, and reviewed SHA-256 values.
- `.dockerignore`, `.prototools`, and every `.devcontainer` file are definition-fingerprint inputs. Update the fingerprint contract when build inputs move.
- The active devcontainer must not mount `~/.proto`; use only `.devcontainer/host/cleanup-legacy-proto-volume.sh` with an exact devcontainer ID for old volumes.
- Run `bun run image:check` plus the clean image build after changing Docker stages, payload pins, derived Proto manifests, mounts, or on-create ownership.
- Stage 2 evidence is command-bound to its immutable implementation boundary. Do not hand-edit `evidence/stage-2-image.json` or its raw logs; rerun the documented collector so schema, semantic, digest, architecture, storage, and rollback proofs remain aligned.
- Agent CLIs are exact image payloads. Runtime setup may verify them but must never download or repair a global agent tool.
<!-- capability:start gemini -->
- Gemini's real CLI remains `/home/vscode/.payloads/gemini/bin/gemini`; `/home/vscode/.local/bin/gemini` is the image-owned watchdog. Keep TTY-interactive, version, explicit-output-format, and bypass calls pass-through, and treat non-TTY stdin plus explicit prompts as bounded headless runs.
<!-- capability:end gemini -->
<!-- capability:start context7 -->
- Context7 is an exact image payload; MCP settings invoke its launcher directly instead of a floating `bunx` package.
<!-- capability:end context7 -->
<!-- capability:start claude_octopus -->
- Claude Octopus is a checksum-verified image payload. Runtime setup may only perform bounded registration from its local directory; it must never fetch a marketplace or clone a repository.
<!-- capability:end claude_octopus -->
<!-- capability:start claude_warp -->
- Claude Warp is a checksum-verified image payload. Runtime setup may only perform bounded registration from its local directory; it must never fetch a marketplace or clone a repository.
<!-- capability:end claude_warp -->
- Skill names must be unique across each agent's effective project/shared discovery roots. Graphify is agent-specific at `.codex/skills/graphify`, `.claude/skills/graphify`, and `.gemini/skills/graphify`; do not restore `.agents/skills/graphify`.

## Browser Runtime Ownership

- The Playwright catalog pin, `@playwright/test`/`playwright`/`playwright-core` lock resolutions, Docker `PLAYWRIGHT_VERSION`, baked headless shell, and FFmpeg payload are one atomic version family.
- Browser-enabled profiles use only `scripts/browser-preflight.ts` for launch verification. It must require `PLAYWRIGHT_BROWSERS_PATH`, match its payload marker to the repository package pin, launch the one baked headless shell, verify a repository-local page, and close the page and browser.
- Playwright dependencies, image stages, package scripts, preflight, CI job, post-create wiring, documentation, and agent rules must all be omitted when the capability is disabled.
- Run `bun run browser:check` and the real `development_browser` image preflight after changing any Playwright authority, browser library, renderer rule, or browser-profile command.

<!-- capability:start codex_cloud -->
## Codex Cloud Ownership

- Codex Cloud is a separate, already-containerized environment. Its setup and maintenance command is the committed `bash .codex/cloud/bootstrap.sh`; the hosted settings it requires are recorded in `.codex/cloud/contract.toml`.
- The hosted environment must set `CODEX_CLOUD=true` independently, so a fresh cache with a missing or failed setup command still takes the fail-closed cloud path.
- Run project commands through `bash .codex/cloud/exec.sh <command>`. It sources the persisted marker, runs `.codex/cloud/doctor.sh --quiet`, and executes directly without Docker.
- Never run `docker`, container lifecycle CLIs, `.devcontainer/host/*`, worktree lifecycle scripts, deployments, or remote pushes from a cloud task. `.codex/cloud/contract.toml` names the forbidden commands and the guard enforces that list. Deployment and production credentials stay in GitHub Actions.
- Only the contract's `secret_allow_list` (plus names in `CODEX_CLOUD_PERSIST_EXTRA_ENV`) is bridged into the agent phase, written to a `0600` file, never echoed.
- If the doctor reports a stale fingerprint, stop and run `bash .codex/cloud/bootstrap.sh <profile>` before executing project commands.
- Run `bun run cloud:check` and `bash .codex/cloud/selftest.sh` after changing any cloud contract value, cloud script, Proto pin, checksum, or browser payload authority.

<!-- capability:end codex_cloud -->
## Worktree Runtime Ownership

- Every checkout — the main clone and each linked worktree — owns exactly one development container. `scripts/worktree/contract.toml` is the generated authority for its identity, ports, paths, and commands; regenerate it from `template-parameters.toml` and never hand-edit it.
- Run project commands through `bash scripts/worktree/exec.sh <command> [args...]`. Inside the container it sources `.devcontainer/environment.sh`, activates Proto, and executes in place; from the host it lazily reconciles this checkout's container and re-invokes itself inside it. The same command works from either side.
- Keep host-only orchestration on the host: `docker`, the `devcontainer` CLI, Git worktree management, remote pushes, and every `scripts/worktree/*.sh` lifecycle script. Direct file inspection and editing stay on the host because the checkout is bind mounted.
- `scripts/worktree/env.sh` owns the generated environment and the host port registry. Allocation is host-only and is refused inside a container: a container's `~/.config` is an isolated writable volume, so a registry write there would succeed and be wrong.
- A worktree's offset disambiguates HOST ports only. Container-internal ports are never offset, because each container owns its own network namespace.
- Container ownership is exact: a container belongs to a checkout only when both `devcontainer.local_folder` and `devcontainer.config_file` labels name it, it is running, and the shared Git common directory is mounted at its host path. Never reuse another checkout's container.
- `.dockerignore`, `.prototools`, and every `.devcontainer` file are definition-fingerprint inputs. Changing one makes `scripts/worktree/ensure.sh` recreate the container with `--remove-existing-container` on the next run.
- Host prerequisites are the container engine, the `devcontainer` CLI (`@devcontainers/cli`), and `python3` for atomic registry and manifest writes. Bun is not a host prerequisite.
- Never hardcode a port, a volume prefix, a persistence path, or a project identity in a runtime script. Read it from the contract or from the generated environment.
- `bash scripts/worktree/down.sh` is not cleanup. It stops the declared services and marks the route inactive while the registry entry, the reserved ports, the generated environment, the persisted data, and the container all survive, so a later `up.sh` hands back the identical URLs. `bash scripts/worktree/cleanup.sh` is the destructive one: it releases the ports, removes this checkout's container, its `${devcontainerId}` volumes, its manifest and route, and its generated state, and exits non-zero listing whatever survived.
- Each checkout publishes `~/.config/devcontainer/worktrees/<workspace-id>.json` (its manifest) and, while active, `~/.config/devcontainer/caddy/<workspace-id>.caddy` (its route). The manifest survives `down.sh`, because it carries the reserved ports; only `cleanup.sh` deletes it.
- The friendly `.localhost` route is optional and never load bearing. It needs a host Caddy that imports `~/.config/devcontainer/caddy/*.caddy`; without one the runtime warns and the direct loopback URL stays authoritative.
- This runtime is the entry point, not an addition to one. `bash scripts/worktree/up.sh` starts a checkout and `bash scripts/worktree/exec.sh` runs commands in it; the superseded launcher is gone from onboarding, documentation, and the git hooks. `.devcontainer/devcontainer.json` stays fully spec compliant so an editor or the `devcontainer` CLI can still open this folder, but a container started that way is an editor convenience with an ephemeral port and no route, isolation, or manifest.
- The git hooks run project tooling through `bash scripts/worktree/exec.sh --require-ready`, which uses the container this checkout already has and exits **7** with an instruction to run `up.sh` rather than starting one — a commit is not a build trigger. The bridge's exit codes are 2 unsupported argument, 3 identity collision, 4 port exhaustion, 6 missing container engine or CLI, and 7 not ready. `git commit --no-verify` is the escape hatch.
- Keep one clone of a project per host and use linked worktrees for parallel work. A second independent clone of the same repository derives the same workspace identity, so it claims the same ports and the same manifest path as the first.
- `bash scripts/worktree/doctor.sh` is the read-only diagnosis. Run it on the host, never through the bridge — every question it asks is a host question. It reports host prerequisites, linked-worktree Git metadata, generated state, container ownership, mounts, tools, host routing, both URLs, the port registry, and cross-worktree port collisions, and it changes none of them: it starts nothing, allocates nothing, publishes nothing, takes no lock, and repairs nothing.
- The doctor's exit codes are **0** healthy, **1** any `FAIL` (or any `WARN` under `--strict`, which only changes the exit code and never a check), and **2** an unsupported argument, refused before a single check runs. `--json` emits one machine-readable document, `--list-checks` prints the ordered check inventory while probing nothing, and `--timeout <1-30>` is the only knob. Inside a container it records one `host.context` failure and stops.
- Act on what the doctor reports; it never acts for you. Its remediations name the commands that do: `bash scripts/worktree/up.sh` to reconcile, `bash scripts/worktree/env.sh --force` to regenerate the environment, and `bash scripts/worktree/cleanup.sh` to release what this checkout owns.
- Runtime environment knobs, all prefixed with the contract's environment prefix: `<PREFIX>_STARTUP_MODE=staggered` replaces readiness gates with bounded delays, `<PREFIX>_STAGGER_SECONDS` sets that delay, `<PREFIX>_SERVICE_START_TIMEOUT` bounds a single service's readiness wait, `<PREFIX>_HOST_CADDY_BIN` and `<PREFIX>_HOST_CADDYFILE` override host Caddy discovery, and `WORKTREE_ENSURE_LOCK_TIMEOUT_SECONDS` bounds the container lifecycle lock.
- Every runtime script writes its diagnostics to stderr, so stdout stays parseable: `env.sh --json`, `ensure.sh` (a container id), `manifest.sh path|env`, and `services.sh order|status` are the only stdout producers. Every entry point exits 2 with a usage block on an unsupported argument.

## Commit Policy

ALWAYS commit and push after completing each significant change. Do NOT wait for the user to ask. Before committing, update `/workspace/CHANGES.md` with a dated entry (Goal + How to implement).

## Secrets

Secrets are host-mounted, not environment variables in the image:

- Common: `~/.config/devcontainer/secrets` — shared across all projects
- Per-project: `~/.config/devcontainer/secrets.d/<DEVCONTAINER_PROJECT>` — overrides common

See `.devcontainer/secrets.example` for a list of expected keys.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- Never `git add graphify-out/` in a feature commit. Refresh the graph only in a dedicated `chore(graphify)` commit on the default branch — a `pre-commit` hook rejects `graphify-out/graph.json` staged alongside non-graphify files.
