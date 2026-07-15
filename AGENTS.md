# Agent Guidelines

Shared conventions for all AI coding tools (Claude Code, Cursor, etc.).

## Runtime

**Always use Bun — never Node.js, npm, pnpm, or Vite.**

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
  - `tsconfig.next.base.json` — Next.js apps
  - `tsconfig.worker.base.json` — Cloudflare Workers

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
