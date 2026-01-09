# Project Template

This is a **template repository** designed to be the starting point for new projects. When you clone this repository and build the devcontainer, it becomes your own completely new project.

## Getting Started

1. **Clone this repository**
   ```bash
   git clone <repository-url>
   cd <project-directory>
   ```

2. **Build and open the devcontainer**
   - Open the project in VS Code (or your preferred editor with devcontainer support)
   - The devcontainer will automatically build and configure the development environment

3. **Initialize your new project** (Important!)
   
   This is a template; you don't want to build on the existing git history. Run the initialization script to reset git and set up your new repository:
   ```bash
   ./init-new-project.sh [repository-name-or-url]
   ```
   
   The script accepts:
   - A repository name (e.g., `my-new-project`) - will assume GitHub and use your git config username
   - A full repository name (e.g., `username/my-new-project`) - will create GitHub URL
   - A full repository URL (e.g., `https://github.com/username/my-new-project.git`)
   - No argument - will reset git but not set up a remote (you can add it manually later)
   
   After running the script, if you provided a repository, push your code:
   ```bash
   git push -u origin main
   ```

4. **Authenticate Opencode**
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