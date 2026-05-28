# Dev Container Auth & Secrets Persistence

How API keys and CLI login tokens survive container rebuilds, and how we keep
them isolated per project. Read this before adding a new credentialed tool to
the dev container.

## The core problem

A dev container's `$HOME` is **ephemeral**. Anything a tool writes at runtime
(`~/.codex/auth.json`, `~/.gemini/oauth_creds.json`, …) lives in the container's
writable layer and is **destroyed on every rebuild/recreate** unless it is one
of:

1. **Re-derived at boot** from a persistent host source (env-var secrets), or
2. **Stored on a named volume** that outlives the container.

If a CLI "asks you to log in again after every rebuild," it's because its
credential file is neither of the above.

## Two mechanisms, two jobs

| Auth style | Where it persists | Use for |
|------------|-------------------|---------|
| **API key** (env var) | Host secrets file → loaded into env at boot | Keys you can paste: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` |
| **Device / OAuth login** (token file on disk) | Named Docker volume keyed by `${devcontainerId}` | Subscription logins: `codex login`, `claude` login, Gemini "Login with Google" |

Pick **one per tool per project**. If an API-key env var is set, most CLIs use
it and ignore any device-login token. So for a given project, either set the
key *or* do the device login — not both.

### Mechanism 1 — API keys via host secrets files

Two tiers, both `KEY=value` (see [`secrets.example`](./secrets.example)):

- **Common** — `~/.config/devcontainer/secrets` — shared across *all* your projects.
- **Per-project** — `~/.config/devcontainer/secrets.d/<DEVCONTAINER_PROJECT>` — overrides common for *this* container only.

`on-create.sh` sources common first, then the per-project file (project wins on
key collision), and writes both into `/etc/environment` so every process —
terminals, the editor's extension host, MCP subprocesses — inherits them.

This is how per-project / per-company keys work with **no collisions**: put a
project's keys in its own `secrets.d/<slug>` file. Different slug = different
file = different keys.

### Mechanism 2 — Device-auth logins via named volumes

Add a volume line to `devcontainer.json` → `mounts` for the tool's home dir:

```jsonc
"source=codex-home-${devcontainerId},target=/home/vscode/.codex,type=volume",
```

- It's a **Docker-managed named volume**, not a host path you browse. On a Linux
  Docker host the data lives at `/var/lib/docker/volumes/<name>/_data`; on Docker
  Desktop it's inside the Docker VM.
- **No collisions** because the volume *name* embeds `${devcontainerId}` — a hash
  unique to each workspace-folder + devcontainer-config pair. Each repo gets its
  own volume → its own login → its own account. The isolation is automatic; you
  never name or manage the id.
- **Never** bind-mount a tool's auth to a literal host path
  (`source=${localEnv:HOME}/.codex,...`) — every container would share one host
  dir, so all projects share one login and clobber each other's tokens.

### Mechanism 3 — Host-captured terminal signals (Warp ACP)

Some signals are injected by the host terminal **per session**, not stored
anywhere persistent — Warp sets `TERM_PROGRAM=WarpTerminal`, `WARP_CLIENT_VERSION`,
and `WARP_CLI_AGENT_PROTOCOL_VERSION` only inside the terminals it spawns. Claude
Code reads them to switch to ACP structured output. Forwarding via `remoteEnv`
`${localEnv:...}` does **not** work: DevPod re-resolves `localEnv` against its own
(often GUI-launched) process env on every rebuild, finds the vars absent, and bakes
in empty values — so detection silently reverts to plain ANSI.

Instead, `initializeCommand` runs [`host/capture-warp-env.sh`](./host/capture-warp-env.sh)
**on the host** before each `devpod up`. It writes whatever Warp vars are present
to `~/.config/devcontainer/warp-env`, overwriting a key only when a fresh non-empty
value exists (so a value seeded from one Warp-terminal launch survives later
GUI-launched rebuilds). `on-create.sh` then loads that file into `/etc/environment`
like the secrets files. **Seed it by running `devpod up .` from a Warp terminal at
least once**; there's no way to obtain Warp's per-terminal vars without going
through a Warp terminal once.

## What this container persists today

| Path | Volume name | Holds | Status |
|------|-------------|-------|--------|
| `~/.claude` | `claude-code-config-${devcontainerId}` | Claude Code login + config | ✅ persisted (pre-existing) |
| `~/.codex` | `codex-home-${devcontainerId}` | Codex device-auth token | ✅ persisted |
| `~/.gemini` | `gemini-home-${devcontainerId}` | Gemini settings + OAuth token (if used) | ✅ persisted |
| `~/.config` | `config-home-${devcontainerId}` | XDG config for other CLIs (catch-all) | ✅ persisted |
| `~/.proto` | `proto-home-${devcontainerId}` | Proto-managed toolchain | ✅ persisted |
| `/commandhistory` | `claude-code-shellhistory-${devcontainerId}` | shell history | ✅ persisted |

## Per-tool auth setup

- **Claude** — already persisted by the pre-existing `~/.claude` volume. Logging
  in once survives rebuilds. No action needed.
- **Codex** — device-auth. Run once per project: `codex login --device-auth`
  (prints a code + URL; approve in any browser). Token lands in
  `~/.codex/auth.json` on the volume and survives rebuilds.
  - *Do not* set `OPENAI_API_KEY` for this project if using device-auth — the key
    would shadow the login.
- **Gemini** — currently authenticates via the common `GEMINI_API_KEY` secret
  (API-key mode), so device-auth is not active. The `~/.gemini` volume persists
  settings/history regardless, and would hold the OAuth token if you switch to
  "Login with Google" (remove `GEMINI_API_KEY` from secrets first, since the key
  takes precedence).

## Provider allowlist (not auth, but related)

`OCTO_ALLOWED_PROVIDERS` in `devcontainer.json` → `containerEnv` controls which
providers Claude Octopus may use. It's non-secret and repo-specific, so it lives
in version control (not the host secrets file). The value is a space- or
comma-separated list of provider names; when **unset, every detected provider is
allowed**. Anything omitted is treated as unavailable **even if installed** — so
the allowlist is how you turn off a provider you don't want a given repo to use.

This repo allows **`claude codex gemini opencode`** — the four CLIs it installs.
To disable one, drop it from the list; to enable another, add its name. The
provider names Octopus recognizes are `codex`, `gemini`, `opencode`, `copilot`,
`qwen`, `ollama`, `openrouter`, `perplexity`, plus `claude`. **Keep `claude` in
the list — it's the orchestrator.** Recognized aliases: `claude`/`anthropic`/
`sonnet`, `codex`/`openai`, `gemini`/`google`, `local`→`ollama`.

## Where we track keys / tokens

- **`secrets.example`** is the registry of every key the dev container expects,
  with comments on which tier (common vs project) and which service uses it. When
  you add a credentialed tool, add its key there with a comment — that file is the
  source of truth for "what secrets exist," even though the real values live only
  on the host (never committed).
- **Volumes** are self-documenting via the `mounts` block in `devcontainer.json`.

## Adding this to another repo

1. Give the repo a **unique** `DEVCONTAINER_PROJECT` in `devcontainer.json` →
   `containerEnv`. This is its namespace handle for the secrets tier.
2. Per-project keys → `~/.config/devcontainer/secrets.d/<that-slug>` on your host.
3. Device-auth tools → add one `…-${devcontainerId}` volume line per tool to
   `mounts`, then log in once.
4. Provider allowlist → copy the `OCTO_ALLOWED_PROVIDERS` line and edit it to the
   providers that repo should use (keep `claude`).
