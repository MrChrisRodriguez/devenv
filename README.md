# Project Template

This is a **template repository** designed to be the starting point for new projects. When you clone this repository, run the init script, and build the devcontainer, it becomes your own completely new project with a full AI-assisted toolchain pre-configured.

The setup has four stages:

1. **[Host Machine Setup](#host-machine-setup)** — install Docker, the Dev Container CLI, an editor, etc. (once per machine)
2. **[Repository Configuration](#repository-configuration)** — clone the template and turn it into your own repo
3. **[Secrets](#secrets)** — drop API keys where the container can read them
4. **[Starting the Dev Container](#starting-the-dev-container)** — build and open the container, then sign in to the AI CLIs

Two sections after that describe the template itself rather than your project:
**[Capabilities and Profiles](#capabilities-and-profiles)** explains what a
generated project does and does not receive, and
**[Validating the Template](#validating-the-template)** is for people changing
the template rather than using it. Symptoms that look like defects and are not
are collected in **[docs/troubleshooting.md](docs/troubleshooting.md)**.

---

## Host Machine Setup

These steps install the tools your machine needs to build and run the development container. You only do this **once per machine**.

### macOS (automated)

On a Mac, a single script installs everything: Xcode Command Line Tools, Homebrew, Git, Docker Desktop, the Dev Container CLI, Warp, your choice of editor, the GitHub CLI (and logs you in), and SSH keys (and adds them to GitHub). It also verifies `python3` and creates the host directories the container mounts.

Open **Terminal** (search "Terminal" in Spotlight) and run:

```bash
curl -fsSL https://raw.githubusercontent.com/MrChrisRodriguez/devenv/main/init-host.sh | bash
```

The script is interactive — it will prompt you to pick an editor and to confirm a few steps. When it finishes, skip ahead to **[Repository Configuration](#repository-configuration)**.

> If Docker isn't running yet, the script will pause and ask you to open Docker Desktop and wait for the whale icon in your menu bar before continuing.

### Windows / Linux (manual)

The automated script above is macOS-only. On Windows or Linux, install the following by hand.

#### 1. Docker

Docker runs the development container that has all your tools pre-configured.

- **Windows**: Install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/). You may be prompted to enable WSL 2 — follow the prompts and restart if asked.
- **Linux**: Install [Docker Engine](https://docs.docker.com/engine/install/) for your distribution, optionally with [Docker Desktop for Linux](https://www.docker.com/products/docker-desktop/).

Verify:
```bash
docker --version
```

#### 2. Git

- **Windows**: Install [Git for Windows](https://git-scm.com/download/win) with the default options.
- **Linux**: `sudo apt install git` (Debian/Ubuntu) or `sudo dnf install git` (Fedora).

#### 3. Dev Container CLI

The [`devcontainer` CLI](https://github.com/devcontainers/cli) is the reference implementation of the Development Containers specification, and it is what builds and starts your container. `scripts/worktree` is written against its behaviour: the `devcontainer.local_folder` and `devcontainer.config_file` ownership labels, per-invocation `--mount`, `--remove-existing-container`, and `${devcontainerId}` volume identity.

```bash
npm install --global @devcontainers/cli
```

On macOS `init-host.sh` installs it with `brew install devcontainer` instead. Do **not** install it with Bun: Bun is not a host prerequisite here, and running `bun install` on the host writes host-platform binaries into the `node_modules` the container bind-mounts.

Verify:
```bash
devcontainer --version
```

#### 4. python3

Used for one thing: the atomic JSON port-registry and manifest writes in `scripts/worktree`. Most systems already have it.

```bash
python3 --version
```

- **Windows**: install from [python.org](https://www.python.org/downloads/) or `winget install Python.Python.3`.
- **Linux**: `sudo apt install python3` (Debian/Ubuntu) or `sudo dnf install python3` (Fedora).
- **macOS**: `xcode-select --install` supplies it.

#### 5. An IDE (code editor)

You need **[VS Code](https://code.visualstudio.com/)** — Microsoft's free code editor. The container integrates with it automatically.

Install it and open it once so it can attach to a running container.

#### 6. GitHub CLI (recommended)

The GitHub CLI lets the init script automatically create your repository on GitHub.

- **Windows**: `winget install GitHub.cli`
- **Linux**: see [cli.github.com/manual/installation](https://cli.github.com/manual/installation)

Authenticate:
```bash
gh auth login
```

#### 7. SSH keys (if you don't have them)

SSH keys let you push to GitHub without entering your password each time.

```bash
# Check for existing keys
ls ~/.ssh/id_ed25519.pub 2>/dev/null && echo "You have SSH keys" || echo "No SSH keys found"

# Create one if needed
ssh-keygen -t ed25519 -C "your-email@example.com"
```

Then add the public key to GitHub: copy the output of `cat ~/.ssh/id_ed25519.pub`, go to [github.com/settings/keys](https://github.com/settings/keys), click **New SSH key**, and paste it in.

#### 8. Host directories

The container bind-mounts config directories from your host. Create them so Docker doesn't auto-create them root-owned:

```bash
for dir in secrets.d container-env codex-auth; do
  mkdir -p ~/.config/devcontainer/"$dir"
  chmod 700 ~/.config/devcontainer/"$dir"
done
```

- `secrets.d/` — per-project secret files you author, as `secrets.d/<project>`.
- `container-env/` — the validated Docker `--env-file`. On every container start, `.devcontainer/host/prepare-container-env.sh` merges `~/.config/devcontainer/secrets` and `secrets.d/<project>` into `container-env/<project>.env` (mode `0600`); `runArgs` in `devcontainer.json` names that file with `--env-file`, so it is how host secrets reach every container process.
- `codex-auth/` — read-write mount source for the Codex auth snapshot, as `codex-auth/<project>`. It must be host-owned so the container user can write the captured-back token.

`init-host.sh` creates all three for you. The per-project leaf names are created at container start.

---

## Repository Configuration

Turn this template into your own project. This is a one-time step per project.

### 1. Clone the template

```bash
git clone https://github.com/MrChrisRodriguez/devenv.git <your-project-name>
cd <your-project-name>
```

### 2. Initialize your project

This is a template — you don't want to build on its git history. The init script resets git, records the template baseline (so you can sync template updates later), sets `DEVCONTAINER_PROJECT` in `.devcontainer/devcontainer.json` for you, swaps in a fresh project README, and creates an initial commit.

```bash
./init-new-project.sh <your-project-name>
```

The argument can be:

| Argument | Behavior |
| --- | --- |
| `my-project` | Repo name only — assumes GitHub and your username as the owner |
| `username/my-project` or `org/my-project` | Full name — builds the GitHub URL for that owner/org |
| `https://github.com/username/my-project.git` | Full URL — used as-is |
| *(none)* | Resets git but configures no remote (add one later) |

**Automatic repository creation**: if the GitHub CLI (`gh`) is installed and authenticated, the script creates the repo on GitHub if it doesn't already exist — for personal accounts and organizations alike. Make sure your `gh` account has permission to create repos in the target org.

After it runs, push your code:

```bash
git push -u origin main
```

### 3. Update `package.json`

Set the project `name` in `package.json` to match your new project.

---

## Secrets

API keys and secrets live in `~/.config/devcontainer/` on your **host** machine and are bind-mounted read-only into every container. There are two tiers — both use plain `KEY=value` lines (no `export`, no quotes), and a per-project value overrides a common one when the same key appears in both.

| File | Scope | Good for |
| --- | --- | --- |
| `~/.config/devcontainer/secrets` | Every project | Shared keys: `GITHUB_TOKEN`, `CONTEXT7_API_KEY`, `ANTHROPIC_API_KEY` |
| `~/.config/devcontainer/secrets.d/<project>` | One container | Project-specific: `DATABASE_URL`, `STRIPE_SECRET_KEY` |

The per-project file is named after `DEVCONTAINER_PROJECT` in `.devcontainer/devcontainer.json` (the init script already set this to your project name).

A starting template lives at `.devcontainer/secrets.example`. Copy it and fill in your keys:

```bash
cp .devcontainer/secrets.example ~/.config/devcontainer/secrets
$EDITOR ~/.config/devcontainer/secrets

# Per-project secrets (replace my-project with your DEVCONTAINER_PROJECT slug)
$EDITOR ~/.config/devcontainer/secrets.d/my-project
```

Lock down permissions so only you can read them:

```bash
chmod 600 ~/.config/devcontainer/secrets
chmod 600 ~/.config/devcontainer/secrets.d/*
```

> **Tip:** Setting `GITHUB_TOKEN` in the common secrets file raises the GitHub/proto API rate limit from 60 to 5000 requests/hour. If `GITHUB_TOKEN` is already exported in your host shell, it's also forwarded into the container automatically.

> **Why not `.zshrc`?** GUI apps (Dock, Spotlight, an editor launched from the Dock) don't inherit shell env vars, so `export` in `.zshrc` is invisible to any process that starts the container from outside a terminal. The secrets files are bind-mounted directly, so they work no matter how the container was launched.

---

## Starting the Dev Container

### 1. Start the container

From your project directory:

```bash
bash scripts/worktree/up.sh
```

That is the entry point. It generates this checkout's environment, reserves its host ports, starts (or reuses) the one container this checkout owns, publishes its route, and prints the URLs. The first run takes a few minutes to build the image; after that it is fast, and running it again on an already-healthy container is a no-op that hands back the identical URLs.

Every checkout — this clone and each linked `git worktree` — owns exactly one container, one port set, one persisted data root, and one URL. Keep **one clone of a project per host** and use linked worktrees for parallel work: a second independent clone of the same repository resolves to the same workspace identity and would collide with this one.

```bash
bash scripts/worktree/down.sh      # stop, keeping ports, data, and the container
bash scripts/worktree/cleanup.sh   # release everything this checkout owns
```

> **Using Warp?** Run that first `up.sh` from a **Warp terminal**. The container captures Warp's environment on the host during the initial build so Claude Code can detect Warp's ACP integration inside the container. Because `up.sh` runs from the terminal you are already in, this is the normal path rather than a special step.

### 2. Run commands in the container

```bash
bash scripts/worktree/exec.sh bun install   # run one command
bash scripts/worktree/exec.sh               # open a login shell
```

`exec.sh` is the command boundary. On the host it reconciles this checkout's container and re-invokes itself inside it; already inside the container it sources `.devcontainer/environment.sh`, activates Proto, and runs in place — the same command line works from either side, and a nested directory maps to the matching directory inside the container. Git hooks use `exec.sh --require-ready`, which uses the container this checkout already has and exits **7** naming `up.sh` rather than turning a commit into a container build.

Run the remaining steps through `exec.sh`, or from a login shell it opened.

> **Other launchers.** `.devcontainer/devcontainer.json` is a fully spec-compliant definition, so VS Code's Dev Containers extension, the `devcontainer` CLI directly, and third-party workspace managers can all still open this folder. Treat that as an editor convenience: a container started that way gets an ephemeral host port and none of the runtime's stable port, route, per-worktree isolation, or manifest. `up.sh` is the supported entry point.

### 3. Authenticate the AI CLIs

The container ships with several AI CLIs that need a one-time sign-in.

**Gemini CLI** — run it and follow the login prompts (Google account or API key). You can also set `GEMINI_API_KEY` in your secrets file.

```bash
gemini
```

**Codex CLI** — needs an OpenAI API key. Add `OPENAI_API_KEY` to your common or per-project secrets file so it's available automatically, then run:

```bash
codex
```

**Claude Code** is pre-installed and authenticates through the editor extension or `claude` on first run.

You're now ready to start building!

---

## Capabilities and Profiles

This template is not one tree with optional bits switched off at runtime. It is
a **generator**: `template-parameters.toml` declares nineteen supported
capabilities, and a generated project receives only the files, package scripts,
workflow steps and agent instructions belonging to the ones its profile enables.
Everything else is omitted, so nothing in the generated tree points at a file
that is not there.

The nineteen: `devcontainer`, `claude`, `codex`, `codex_cloud`, `gemini`,
`openspec`, `graphify`, `context7`, `ccstatusline`, `claude_octopus`,
`claude_warp`, `moon_affected_selection`, `playwright`, `cloudflare_workers`,
`better_auth`, `rhf_zod`, `sentry`, `vite_websocket_proxy` and `tanstack_start`.

Three committed profiles under `fixtures/template/` fix a value for every one of
them, and each is rendered and validated on every change:

| Profile | What it is for |
|---|---|
| `minimal` | the core Bun devcontainer with no cloud, browser, affected-selection or application-stack integrations |
| `cloud` | the Cloudflare Worker and Codex Cloud profile, without browser or application-stack integrations |
| `full` | every supported capability enabled, which is what release validation exercises |

Two consequences worth knowing before they surprise you. A disabled capability
leaves **no residue**: a scan over every generated file refuses a leftover
script, dependency, workflow, test or agent instruction belonging to a
capability the profile turned off. And ownership is declared rather than
guessed — `docs/devcontainer-upgrade/stage-0/template-ownership.json` records,
for every path, whether the template owns it, your project owns it, or it is
generated, and whether an update should merge it or leave it alone.

---

## Validating the Template

This section is for changing the template, not for using it. A generated project
needs none of it.

```bash
bun run template:validate        # parameters, evidence records and every hermetic guard
bun run template:fixtures <dir>  # render minimal, cloud and full
bun run template:release-check   # the release gate: goldens, scans, acceptance, budgets
bun run template:release-sync    # regenerate the committed golden render manifests
```

Fifteen `*:check` guards run on every pull request — `ci`, `toolchain`,
`image`, `browser`, `cloud`, `forms`, `openspec`, `proxy`, `telemetry`,
`start`, `experiments`, `rules`, `worktree`, `affected` and `graph` — and each
one has a section in `AGENTS.md` describing what it refuses. They all report
into one required status check, **`ci-gate`**, which is the only thing branch
protection needs to know about.

The `template:` prefix on the four commands above is load-bearing: it is what
removes them from a generated project's `package.json`. Their inputs — the
fixture definitions, the golden manifests under `fixtures/golden/` and
`release.json` — are omitted from every profile, so a generated project would
receive a command with nothing to run it against.

Golden render manifests pin the path, mode and SHA-256 of every file each
profile emits. If a change moves them, that is not a failure to work around:

```bash
bun run template:release-sync    # regenerate
git diff fixtures/golden/        # then review, because a golden is an expectation
```

---

## What's Included

**AI tooling**
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's CLI agent
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Codex CLI](https://github.com/openai/codex)
- [OpenSpec](https://github.com/fission-ai/openspec) — spec-driven workflow
- [Context7 MCP](https://context7.com) — up-to-date library docs for Claude Code
- [Claude Octopus](https://github.com/nyldn/claude-octopus) and [Warp integration](https://github.com/warpdotdev/claude-code-warp) — checksum-verified local plugin payloads with no first-run network install
- [Graphify](https://github.com/safishamsi/graphify) and ccstatusline — image-owned knowledge-graph and Claude status tooling
- [Biome](https://biomejs.dev) — formatter and linter

**Toolchain**
- [Bun](https://bun.sh) — runtime, bundler, and package manager
- [Proto](https://moonrepo.dev/proto) — toolchain version manager
- Zsh + [Zinit](https://github.com/zdharma-continuum/zinit) + [Powerlevel10k](https://github.com/romkatv/powerlevel10k)
- fzf, ripgrep, tree, unzip, xz-utils
- Git, GitHub CLI, Docker

All global AI launchers are exact-pinned image payloads. Repository-local
commands and Proto shims resolve first in Bash and Zsh; on-create verifies the
payloads and only registers plugins from their local checksum-verified source.
