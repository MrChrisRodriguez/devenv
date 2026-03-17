# Agent Guidelines

Shared conventions for all AI coding tools (Claude Code, Opencode, Cursor, etc.).

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

- Path alias: `@<project>/*` → `/workspace/libs/*/src`
- Monorepo tasks (lint, typecheck, test, build) are defined in `.moon/tasks.yml` and run via `moon`

## Code Quality

- **Formatter/linter:** Biome — run as `bunx biome check --write .`
- **Commits:** Conventional Commits enforced by commitlint (`feat`, `fix`, `refactor`, `chore`, `docs`, `test`)
- **TypeScript:** strict mode, extend from the appropriate base config in the repo root:
  - `tsconfig.base.json` — general use
  - `tsconfig.lib.base.json` — shared libraries
  - `tsconfig.next.base.json` — Next.js apps
  - `tsconfig.worker.base.json` — Cloudflare Workers

## Secrets

Secrets are host-mounted, not environment variables in the image:

- Common: `~/.config/devcontainer/secrets` — shared across all projects
- Per-project: `~/.config/devcontainer/secrets.d/<DEVCONTAINER_PROJECT>` — overrides common

See `.devcontainer/secrets.example` for a list of expected keys.
