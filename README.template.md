# {{PROJECT_NAME}}

> Short description of this project.

Created from the [devenv](https://github.com/MrChrisRodriguez/devenv) template — a
containerized, Bun-first monorepo with an AI-assisted toolchain pre-configured.

---

## The dev container

All work happens inside a [DevPod](https://devpod.sh/) dev container so the toolchain
(Bun, Proto, the AI CLIs, linters) is identical on every machine. You build it once,
then reconnect whenever you come back to the project.

### Rebuild / start the container

Run these from the project directory **on your host machine** (not inside the container):

```bash
# First build, or any time you change .devcontainer/* — provisions cleanly:
devpod up . --recreate

# Day-to-day: reconnect to the existing workspace (fast):
devpod up .
```

> **Using Warp?** Run the build from a **Warp terminal** so the container can capture
> Warp's environment and Claude Code can detect its ACP integration inside the container.

### Get a shell inside the container

```bash
devpod ssh .
```

You can also open the workspace directly in your editor (Cursor / VS Code) from the
DevPod UI. Run all the commands below **from inside the container.**

### Other lifecycle commands

```bash
devpod list              # see your workspaces
devpod stop .            # stop the container (state is preserved)
devpod delete .          # tear it down completely; next `devpod up` rebuilds
```

---

## Secrets

API keys are **not** baked into the image. They live on your **host** at
`~/.config/devcontainer/` and are bind-mounted read-only into the container. Plain
`KEY=value` lines (no `export`, no quotes); a per-project value overrides a common one.

| File | Scope |
| --- | --- |
| `~/.config/devcontainer/secrets` | Shared across all projects (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, …) |
| `~/.config/devcontainer/secrets.d/{{PROJECT_NAME}}` | This project only (`DATABASE_URL`, `STRIPE_SECRET_KEY`, …) |

The per-project file is named after `DEVCONTAINER_PROJECT` in
`.devcontainer/devcontainer.json`. See `.devcontainer/secrets.example` for the expected
keys. After editing, lock them down: `chmod 600 ~/.config/devcontainer/secrets*`.

To add or change a secret, edit the host file and **rebuild** (`devpod up . --recreate`)
so the new value is mounted.

---

## Getting started

Inside the container:

```bash
bun install
```

### AI CLIs (one-time sign-in)

The container ships with several AI CLIs:

- **Claude Code** — `claude` (authenticates via the editor extension or on first run)
- **Gemini CLI** — `gemini` (Google login or `GEMINI_API_KEY` in secrets)
- **Codex CLI** — `codex` (needs `OPENAI_API_KEY` in secrets)

---

## Using the dev environment

### Bun is preferred (not required)

Bun is the built-in runtime and package manager — reach for it first; it's fast and
already configured. It isn't mandatory: use Node, npm/pnpm, Vite, or whatever a tool or
framework expects when that's the better fit. Common Bun equivalents:

| Common task | Bun equivalent |
|---|---|
| `node <file>` / `ts-node <file>` | `bun <file>` |
| `npm install` / `pnpm install` | `bun install` |
| `npm run <script>` | `bun run <script>` |
| `npx <pkg>` | `bunx <pkg>` |
| `jest` / `vitest` | `bun test` |
| `webpack` / `esbuild` | `bun build <file>` |

When you're on Bun, its native APIs save a dependency: `Bun.serve()`, `bun:sqlite`,
`Bun.sql` (Postgres), `Bun.redis`, `Bun.file()`, `Bun.$` (shell). Bun also loads `.env`
automatically — no `dotenv` needed.

### Monorepo layout

```
apps/      # deployable applications (Next.js, Elysia, Workers, …)
libs/      # shared packages, imported via the @<project>/* path alias
scripts/   # one-off tooling
```

Tasks (lint, typecheck, test, build) are defined in `.moon/tasks.yml` and run via `moon`.

### Code quality

- **Format / lint:** `bunx biome check --write .`
- **TypeScript:** strict mode; extend the right base config — `tsconfig.base.json`,
  `tsconfig.lib.base.json`, `tsconfig.next.base.json`, or `tsconfig.worker.base.json`.
- **Commits:** Conventional Commits, enforced by commitlint
  (`feat`, `fix`, `refactor`, `chore`, `docs`, `test`). A Husky pre-commit hook runs
  Biome on staged files.

See `AGENTS.md` and `CLAUDE.md` for the full conventions the AI tools follow.

### Knowledge graph (graphify)

Run `/graphify` in Claude Code to build/query a knowledge graph of this codebase under
`graphify-out/`. Refresh it with `graphify update .` after changes. Keep
`graphify-out/` out of feature commits — refresh it only in a dedicated
`chore(graphify)` commit (a pre-commit hook enforces this).

---

## Syncing template updates

This repo records the template commit it was forked from in `.template-ref`. To pull in
later improvements to the dev container / toolchain without touching your app code:

```bash
scripts/sync-devcontainer.sh
```

It does per-file, content-aware 3-way merges, never touches `apps/`, `libs/`, your
`scripts/`, or `openspec/`, and commits nothing on its own. Run
`scripts/sync-devcontainer.sh --help` for options (`--dry-run`, `--yes`, …).
