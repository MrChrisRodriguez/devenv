# Project Template

This is a **template repository** designed to be the starting point for new projects. When you clone this repository and build the devcontainer, it becomes your own completely new project.

## Quick Start (Mac)

Open Terminal (search "Terminal" in Spotlight) and paste these commands one at a time:

```bash
# 1. Set up your Mac (installs Docker, Git, DevPod, Warp, an editor, etc.)
curl -fsSL https://raw.githubusercontent.com/MrChrisRodriguez/devenv/main/init-host.sh | bash

# 2. Clone and create your project
git clone https://github.com/MrChrisRodriguez/devenv.git my-project
cd my-project
./init-new-project.sh my-project

# 3. Start the development container
devpod up .
```

That's it. The first run takes a few minutes to build the container. After that, `devpod up .` opens your project in seconds.

> If you're on **Windows or Linux**, skip to the [manual prerequisites](#prerequisites-host-machine-setup) below.

---

## Prerequisites (Host Machine Setup)

If you used the Quick Start above, you can skip this section. These are the manual steps for reference, or for Windows/Linux users.

### 1. Install Docker

Docker runs the development container that has all your tools pre-configured.

- **Mac**: Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/). Open it once after installing and let it finish starting up (you'll see the whale icon in your menu bar).
- **Windows**: Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/). You may be prompted to enable WSL 2 — follow the prompts and restart if asked.
- **Linux**: Install Docker Engine following the [official instructions](https://docs.docker.com/engine/install/) for your distribution, then install [Docker Desktop for Linux](https://www.docker.com/products/docker-desktop/) or just use the engine directly.

After installing, open a terminal and verify it works:
```bash
docker --version
```

### 2. Install Git

Git tracks your code changes and lets you clone this template.

- **Mac**: Open Terminal and run `git --version`. If it's not installed, macOS will prompt you to install the Xcode Command Line Tools — click "Install" and follow the prompts.
- **Windows**: Download and install [Git for Windows](https://git-scm.com/download/win). Use the default options during installation.
- **Linux**: Run `sudo apt install git` (Debian/Ubuntu) or `sudo dnf install git` (Fedora).

### 3. Install DevPod

DevPod is the tool that builds and manages your development container.

- Download and install from [devpod.sh](https://devpod.sh/). Installers are available for Mac, Windows, and Linux.
- After installing, open DevPod and make sure **Docker** is selected as the default provider (it usually is).
- You can also install the CLI: on Mac, run `brew install devpod` or use the installer from the website.

Verify it works:
```bash
devpod version
```

### 4. Install an IDE (Code Editor)

You need one of these editors — the development container integrates with them automatically:

- **[Cursor](https://www.cursor.com/)** — AI-native code editor built on VS Code
- **[VS Code](https://code.visualstudio.com/)** — Microsoft's free code editor

Install either one, then open it once so DevPod can detect it.

### 5. Set Up SSH Keys (if you don't have them already)

SSH keys let you push code to GitHub without entering your password every time.

Check if you already have keys:
```bash
ls ~/.ssh/id_ed25519.pub 2>/dev/null && echo "You have SSH keys" || echo "No SSH keys found"
```

If you don't have keys, create them:
```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
```
Press Enter to accept the default location, then set a passphrase (or press Enter for none).

Add your public key to GitHub:
1. Copy your key: `cat ~/.ssh/id_ed25519.pub` (Mac/Linux) and select the output
2. Go to [github.com/settings/keys](https://github.com/settings/keys)
3. Click "New SSH key", paste it in, and save

### 6. Install GitHub CLI (optional but recommended)

The GitHub CLI lets the init script automatically create repositories for you.

- **Mac**: `brew install gh`
- **Windows**: `winget install GitHub.cli`
- **Linux**: See [cli.github.com/manual/installation](https://cli.github.com/manual/installation)

Then authenticate:
```bash
gh auth login
```
Follow the prompts to log in with your GitHub account.

### 7. Create the Host Directories

The container mounts a few directories from your host machine. Create them so Docker doesn't complain:

```bash
mkdir -p ~/.config/devcontainer/secrets.d
mkdir -p ~/.local/share/opencode
chmod 700 ~/.config/devcontainer/secrets.d
```

---

You're all set! Continue to **Getting Started** below to create your first project.

## Getting Started

1. **Clone this template repository**
   ```bash
   git clone https://github.com/MrChrisRodriguez/devenv.git <your-project-name>
   cd <your-project-name>
   ```

2. **Initialize your new project** (Important!)
   
   This is a template; you don't want to build on the existing git history. Run the initialization script to reset git and set up your new repository. **Give your project a name** when running the script:
   ```bash
   ./init-new-project.sh <your-project-name>
   ```
   
   Or if you want to create it in an organization:
   ```bash
   ./init-new-project.sh <org-name>/<your-project-name>
   ```
   
   The script accepts:
   - A repository name (e.g., `my-new-project`) - will assume GitHub and use your GitHub username
   - A full repository name (e.g., `username/my-new-project` or `orgname/my-new-project`) - will create GitHub URL
   - A full repository URL (e.g., `https://github.com/username/my-new-project.git`)
   - No argument - will reset git but not set up a remote (you can add it manually later)
   
   **Automatic repository creation**: If you have GitHub CLI (`gh`) installed and authenticated, the script will automatically create the repository on GitHub if it doesn't exist. This works for both personal accounts and organizations (e.g., `myorg/myproject`). Make sure your GitHub CLI is authenticated with an account that has permission to create repositories in the target organization. Otherwise, you'll need to create it manually first.
   
   After running the script, if you provided a repository, push your code:
   ```bash
   git push -u origin main
   ```
   
   **Don't forget to update `package.json`** with your project's name after initialization!

3. **Create your secrets files** (one-time host setup)

   API keys and secrets are stored in `~/.config/devcontainer/` on your host machine and bind-mounted read-only into every container. There are two tiers — both use the same `KEY=value` format, and per-project values override common ones when the same key appears in both. (The directories were already created in the Prerequisites step above.)

   **Common secrets** — loaded in every project (MCP servers, shared tooling):

   ```bash
   # ~/.config/devcontainer/secrets
   CONTEXT7_API_KEY=your-key-from-context7.com/dashboard
   # ANOTHER_SHARED_KEY=...
   ```

   **Per-project secrets** — loaded only for a specific container, named after `DEVCONTAINER_PROJECT` in `devcontainer.json`:

   ```bash
   # ~/.config/devcontainer/secrets.d/my-project   (for this template)
   # ~/.config/devcontainer/secrets.d/my-other-app  (for another project)
   DATABASE_URL=postgres://...
   STRIPE_SECRET_KEY=sk_live_...
   ```

   Lock down permissions so only you can read them:

   ```bash
   chmod 600 ~/.config/devcontainer/secrets
   chmod 600 ~/.config/devcontainer/secrets.d/*
   ```

   > **Why not `.zshrc`?** GUI apps (Dock, Spotlight, DevPod) don't inherit shell env vars, so `export` in `.zshrc` is invisible to the IDE process that starts the container. The secrets files are bind-mounted directly, so they work regardless of how the IDE was launched.

   > **When cloning this template** for a new project, update `DEVCONTAINER_PROJECT` in `.devcontainer/devcontainer.json` to a short lowercase slug matching the name you used for the per-project secrets file (e.g. `"my-other-app"`).

4. **Create a new DevPod workspace**

   After initializing your project, create a new DevPod workspace for your codebase using your default provider:
   ```bash
   devpod up .
   ```

5. **Authenticate Opencode**
   ```bash
   opencode auth
   ```

6. **Authenticate Gemini CLI**

   Gemini CLI requires a Google Gemini API key. On first run, it will prompt you to log in:
   ```bash
   gemini
   ```
   Follow the prompts to authenticate with your Google account or provide an API key. You can also set the `GEMINI_API_KEY` environment variable in your secrets file.

7. **Authenticate Codex CLI**

   Codex CLI requires an OpenAI API key. Set it before first use:
   ```bash
   export OPENAI_API_KEY=your-key-here
   ```
   You can add `OPENAI_API_KEY` to your common or per-project secrets file so it's available automatically. Then run:
   ```bash
   codex
   ```

You're now ready to start building your new project!


--------------------------------


AI Tools:
- Openspec (https://github.com/fission-ai/openspec)
- Opencode (https://opencode.ai/)
- oh-my-opencode (https://github.com/danzilberdan/oh-my-opencode)
- Claude Code
- Gemini CLI (https://github.com/google-gemini/gemini-cli)
- Codex CLI (https://github.com/openai/codex)
- Context7 MCP (https://context7.com) — up-to-date library docs for Claude Code, Cursor, and OpenCode
- Biome

Toolchain:
- Bun
- Proto
- Zsh
- Zinit
- Powerlevel10k
- Fzf
- Ripgrep
- Tree
- Unzip
- Xz-utils
- Git
- Github CLI
- Docker