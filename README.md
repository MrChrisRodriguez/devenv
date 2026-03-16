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

3. **Create a new DevPod workspace**
   
   After initializing your project, create a new DevPod workspace for your codebase using your default provider:
   ```bash
   devpod up .
   ```

4. **Authenticate Opencode**
   ```bash
   opencode auth
   ```

You're now ready to start building your new project!


--------------------------------

## Network Firewall

The devcontainer runs an iptables-based outbound firewall (`init-firewall.sh`) to restrict Claude Code to a known set of safe domains. This prevents accidental or unauthorized network access from inside the container.

### How it works

Every time the container starts, `init-firewall.sh` runs as root before anything else:

1. **Flushes** all existing iptables rules
2. **Resolves allowed domains** to IP addresses using `dig` and adds them to an `ipset` named `allowed-domains`
3. **Sets default policies** to DROP for INPUT, OUTPUT, and FORWARD
4. **Adds allowlist rules** permitting only traffic to/from `allowed-domains`, plus DNS (UDP 53), SSH (TCP 22), and localhost
5. **Verifies** the firewall by confirming `example.com` is blocked and `api.github.com` is reachable

Because IPs are resolved at startup, the allowlist is always current — no hardcoded IPs in the config.

### Currently allowed domains

| Domain | Purpose |
|---|---|
| GitHub (via API meta) | `git push/pull`, API access, Actions |
| `registry.npmjs.org` | `bun install` / npm packages |
| `api.anthropic.com` | Claude Code API |
| `sentry.io` | Error reporting |
| `statsig.anthropic.com`, `statsig.com` | Claude Code telemetry |
| `marketplace.visualstudio.com` | VS Code extension installs |
| `vscode.blob.core.windows.net` | VS Code extension downloads |
| `update.code.visualstudio.com` | VS Code updates |

### Adding a new domain

To allow a new service (e.g. an MCP server, a package registry, or an AI tool), add its hostname to the `for domain in` loop in `.devcontainer/init-firewall.sh`:

```bash
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com" \
    "marketplace.visualstudio.com" \
    "vscode.blob.core.windows.net" \
    "update.code.visualstudio.com" \
    "your-new-domain.com"; do   # <-- add here
```

Then **rebuild the container** (the firewall runs at startup, so a restart alone is enough if you haven't changed the image).

> **Tip:** If a tool is failing silently or timing out, run `sudo iptables -L OUTPUT -n -v` inside the container to check whether traffic is being dropped. You can also check `sudo ipset list allowed-domains` to see what IPs are currently in the allowlist.

### Example: adding Context7

Context7 is an MCP server that fetches up-to-date library documentation. To find what domains it needs, check its documentation or run it once with the firewall temporarily disabled, then inspect the blocked connections. Once you know the hostnames, add them to the loop above — for example:

```bash
    "upstash.io" \
    "context7.com" \
```

Restart the container after editing `init-firewall.sh` for the new rules to take effect.

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