# Changelog

This file documents changes made to this template repository. Each entry provides enough detail for downstream projects (repos based on this template) to adopt the same change manually.

---

## 2026-03-20 — Add Claude and Codex to Openspec init

**Goal:** Ensure Openspec generates configuration for all coding agents used in the template, not just Cursor and OpenCode.

**How to implement:**
1. In `.devcontainer/on-create/setup-openspec.sh`, update the `openspec init` command to include `claude` and `codex`:
   ```bash
   openspec init --tools claude,codex,cursor,opencode --force
   ```

---

## 2026-03-20 — Self-delete init-new-project.sh after use

**Goal:** The bootstrap script is a one-time operation for instantiating a new project from the template. It should not remain in the new project's tree.

**How to implement:**
1. In `init-new-project.sh`, add `rm -f "$0"` just before the `git add .` / initial commit step so the script deletes itself before being committed to the new repo.

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

## 2026-03-16 — GitHub Token forwarding to raise API rate limits

**Goal:** Proto resolves tool versions via the GitHub API. Unauthenticated requests are capped at 60/hr per IP — easily exhausted in a shared network or CI. Forwarding `GITHUB_TOKEN` raises this to 5,000/hr.

**How to implement:**
Two complementary paths (both can be active; secrets file wins on conflict since it's loaded last):

1. **Via host shell** — forward the token automatically from the host environment:
   ```json
   // .devcontainer/devcontainer.json
   "remoteEnv": {
     "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}"
   }
   ```
2. **Via secrets file** (recommended for persistence — works even in GUI-launched IDEs):
   ```
   # ~/.config/devcontainer/secrets
   GITHUB_TOKEN=ghp_your_token_here
   ```
3. Document `GITHUB_TOKEN` as a recommended common secret in your `devcontainer.json` comment block or `secrets.example`.

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
3. Scope all named Docker volume names with `${devcontainerId}` so multiple checkouts of this template on the same host each get their own volumes:
   ```json
   "mounts": [
     "source=devcontainer-${devcontainerId}-proto,target=/home/vscode/.proto,type=volume"
   ]
   ```

---

## 2026-03-16 — Host-mounted two-tier secrets system

**Goal:** `${localEnv:VAR}` in `devcontainer.json` only works when the IDE process itself has the env var set — GUI apps launched from Dock, Spotlight, or DevPod don't inherit shell exports, making this approach unreliable. Replace with a bind-mounted secrets file that all container processes can read directly, regardless of how the IDE was launched.

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
   File format — one `KEY=value` per line, `#` for comments:
   ```
   CONTEXT7_API_KEY=your-key-here
   GITHUB_TOKEN=ghp_...
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
