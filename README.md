# Project Template

This is a **template repository** designed to be the starting point for new projects. When you clone this repository, run the init script, and build the devcontainer, it becomes your own completely new project with a full AI-assisted toolchain pre-configured.

The setup has four stages:

1. **[Host Machine Setup](#host-machine-setup)** — install Docker, DevPod, an editor, etc. (once per machine)
2. **[Repository Configuration](#repository-configuration)** — clone the template and turn it into your own repo
3. **[Secrets](#secrets)** — drop API keys where the container can read them
4. **[Starting the Dev Container](#starting-the-dev-container)** — build and open the container, then sign in to the AI CLIs

---

## Host Machine Setup

These steps install the tools your machine needs to build and run the development container. You only do this **once per machine**.

### macOS (automated)

On a Mac, a single script installs everything: Xcode Command Line Tools, Homebrew, Git, Docker Desktop, DevPod, Warp, your choice of editor, the GitHub CLI (and logs you in), and SSH keys (and adds them to GitHub). It also creates the host directories the container mounts.

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

#### 3. DevPod

DevPod builds and manages your development container.

- Download from [devpod.sh](https://devpod.sh/) (installers for Windows and Linux are available).
- Open DevPod and make sure **Docker** is selected as the default provider (it usually is).

Verify:
```bash
devpod version
```

#### 4. An IDE (code editor)

You need one of these — the container integrates with them automatically:

- **[Cursor](https://www.cursor.com/)** — AI-native editor built on VS Code
- **[VS Code](https://code.visualstudio.com/)** — Microsoft's free code editor

Install one and open it once so DevPod can detect it.

#### 5. GitHub CLI (recommended)

The GitHub CLI lets the init script automatically create your repository on GitHub.

- **Windows**: `winget install GitHub.cli`
- **Linux**: see [cli.github.com/manual/installation](https://cli.github.com/manual/installation)

Authenticate:
```bash
gh auth login
```

#### 6. SSH keys (if you don't have them)

SSH keys let you push to GitHub without entering your password each time.

```bash
# Check for existing keys
ls ~/.ssh/id_ed25519.pub 2>/dev/null && echo "You have SSH keys" || echo "No SSH keys found"

# Create one if needed
ssh-keygen -t ed25519 -C "your-email@example.com"
```

Then add the public key to GitHub: copy the output of `cat ~/.ssh/id_ed25519.pub`, go to [github.com/settings/keys](https://github.com/settings/keys), click **New SSH key**, and paste it in.

#### 7. Host directories

The container bind-mounts a config directory from your host. Create it so Docker doesn't complain:

```bash
mkdir -p ~/.config/devcontainer/secrets.d
chmod 700 ~/.config/devcontainer/secrets.d
```

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

> **Why not `.zshrc`?** GUI apps (Dock, Spotlight, DevPod) don't inherit shell env vars, so `export` in `.zshrc` is invisible to the IDE process that starts the container. The secrets files are bind-mounted directly, so they work no matter how the IDE was launched.

---

## Starting the Dev Container

### 1. Build the container

From your project directory, create the DevPod workspace. **The very first build needs `--recreate`** to provision cleanly:

```bash
devpod up . --recreate
```

The first run takes a few minutes to build the image. After that, opening the project is fast:

```bash
devpod up .
```

> **Using Warp?** Run that first `devpod up .` from a **Warp terminal**. The container captures Warp's environment on the host during the initial build so Claude Code can detect Warp's ACP integration inside the container.

### 2. Connect to the container

Open a shell inside the running container:

```bash
devpod ssh .
```

(You can also open the workspace directly in your editor from the DevPod UI.) Run the remaining steps from inside this shell.

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

## What's Included

**AI tooling**
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's CLI agent
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Codex CLI](https://github.com/openai/codex)
- [OpenSpec](https://github.com/fission-ai/openspec) — spec-driven workflow
- [Context7 MCP](https://context7.com) — up-to-date library docs for Claude Code and Cursor
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
