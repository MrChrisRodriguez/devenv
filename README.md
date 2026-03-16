# Project Template

This is a **template repository** designed to be the starting point for new projects. When you clone this repository and build the devcontainer, it becomes your own completely new project.

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

   API keys and secrets are stored in `~/.config/devcontainer/` on your host machine and bind-mounted read-only into every container. There are two tiers — both use the same `KEY=value` format, and per-project values override common ones when the same key appears in both.

   ```bash
   mkdir -p ~/.config/devcontainer/secrets.d
   chmod 700 ~/.config/devcontainer/secrets.d
   ```

   **Common secrets** — loaded in every project (MCP servers, shared tooling):

   ```bash
   # ~/.config/devcontainer/secrets
   CONTEXT7_API_KEY=your-key-from-context7.com/dashboard
   # ANOTHER_SHARED_KEY=...
   ```

   **Per-project secrets** — loaded only for a specific container, named after `DEVCONTAINER_PROJECT` in `devcontainer.json`:

   ```bash
   # ~/.config/devcontainer/secrets.d/confiador   (for this template)
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

You're now ready to start building your new project!


--------------------------------


AI Tools:
- Openspec (https://github.com/fission-ai/openspec)
- Opencode (https://opencode.ai/)
- oh-my-opencode (https://github.com/danzilberdan/oh-my-opencode)
- Claude Code
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