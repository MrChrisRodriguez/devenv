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
2. **Stored on a named volume** that outlives the container, or
3. **Kept on the host** and bound back into the container.

If a CLI "asks you to log in again after every rebuild," its credential file is
none of the above.

## Credential class decides the mechanism

Persistence is chosen per credential **class**, not one-size-fits-all — because a
single uniform mechanism is not simultaneously simplest and safest for every
CLI. Two questions decide it:

1. **Is there a static, long-lived credential?** If yes, an env-var secret
   (Mechanism 1) is simplest and never decays. If no, the on-disk credential
   refreshes/rotates and must live on a writable store.
2. **How churny is the tool's home dir?** A home dir with actively-written state
   (especially SQLite) must **not** be shared live across concurrent containers —
   share at most the single credential file.

| Tool | Credential class | Mechanism | Home dir |
|------|------------------|-----------|----------|
| **Claude Code** | Long-lived token (`claude setup-token`, subscription) | **Env secret** — `CLAUDE_CODE_OAUTH_TOKEN` (Mechanism 1) | `~/.claude` stays a per-`${devcontainerId}` volume (isolated per worktree) |
| **Gemini** | API key | **Env secret** — `GEMINI_API_KEY` (Mechanism 1) | `~/.gemini` volume holds only settings/history |
| **Codex** | Rotating `refresh_token` in `auth.json` (no static token) | **Seed-on-create** — share only `auth.json` via a host snapshot (Mechanism 3) | `~/.codex` stays a per-`${devcontainerId}` volume; live SQLite/state never shared |
<!-- capability:start context7 -->
| **Context7 MCP** | API key | **Env secret** — `CONTEXT7_API_KEY` (Mechanism 1) | none (stateless launcher) |
<!-- capability:end context7 -->
| **GitHub (push)** | PAT per org | **Env secret** — routed at push time (see [GitHub push auth](#github-push-auth-credential-routing-by-org)) | none (never written to disk) |

**Parallel-worktree live-state isolation guarantee.** The normal workflow runs
several agents in parallel git worktrees, each its own container. No tool's *live
state* — Claude session transcripts / `plugins/` / `history`, Codex
`logs_*`/`state_*`/`memories_*` SQLite — is ever shared across concurrent
containers. Only the *login* is shared, and only as either an env-injected token
(Claude, Gemini) or a single seeded file (Codex `auth.json`). So concurrent
agents can never lock-contend on or corrupt each other's state. Sharing the login
never drags the live state along with it.

**One login per tool per project.** If an API-key env var is set, most CLIs use
it and ignore any device-login token — so set the key *or* do the device login,
not both. Claude is the exception: its `CLAUDE_CODE_OAUTH_TOKEN` is the intended
persistent path and needs no interactive login at all.

**Accepted costs** (all convenience limits, never safety):

- **Claude:** a one-time `claude setup-token` to mint the token, and a static
  long-lived token sitting in your host secrets file (same trust boundary as
  every other key there).
- **Codex:** if several long-lived concurrent containers cross the access-token
  expiry and each first-refreshes from the same seeded `refresh_token`,
  provider-side rotation may invalidate all but one → a single re-login + re-seed.
  No state is ever corrupted; login continuity is best-effort, safety is not.
- **Gemini:** none beyond holding an API key.

### Mechanism 1 — API keys and long-lived tokens via host secrets files

Any credential that has a **static, non-refreshing** form persists this way — a
pasteable API key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, …) *or*
a purpose-built long-lived login token. Claude Code's `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`) is the token case: it never refreshes to a file, so
the env-var path is both the simplest (one line in an existing file) and the most
robust (no on-disk credential to isolate, no capture-back, no decay). The CLI
reads it from the environment on every rebuild and in every worktree, so Claude is
authenticated at first use with no interactive login.

Two tiers, both literal, single-line `KEY=value` (see
[`secrets.example`](./secrets.example)):

- **Common** — `~/.config/devcontainer/secrets` — shared across *all* your projects.
- **Per-project** — `~/.config/devcontainer/secrets.d/<DEVCONTAINER_PROJECT>` — overrides common for *this* container only.

`devcontainer.json` → `initializeCommand` is an **object of named host entries**,
and its unconditional `prepare-container-env` entry runs
[`host/prepare-container-env.sh`](./host/prepare-container-env.sh), which
validates common first and project second (project wins), then atomically writes a
mode-`0600` Docker environment file at
`~/.config/devcontainer/container-env/devenv.env`. `devcontainer.json` →
`runArgs --env-file` points at that file, so Docker applies it to **PID 1** and
every process descended from it: lifecycle hooks, login and interactive shells,
the editor extension host, MCP subprocesses, `docker exec` sessions, and
long-running dev servers. There is no `/etc/environment` mirror and no
`postStart` re-sync — the container's environment *is* the prepared file.

**The env file is a creation-time snapshot; shells refresh sooner.** A key added
or rotated on the host reaches **new shells immediately** — `environment.sh`
re-reads the same mounted sources under `/run/devcontainer-config` through
`lib/env-file.sh` on every shell bootstrap, so any bash/zsh started after the
edit (and anything launched from it) sees the new value with no rebuild. What
does *not* refresh is the PID-1 snapshot every non-shell surface inherits:
already-running processes, the editor extension host, MCP subprocesses, and
long-running dev servers keep the environment Docker applied at creation. For
those, rerun `initializeCommand` (any `devpod up` / rebuild) so the file is
regenerated, and **restart/recreate the container** so Docker re-applies it.

**The parser never evaluates secret files as shell code.**
[`lib/env-file.sh`](./lib/env-file.sh) reads them line by line: blank lines and
lines whose first non-space character is `#` are ignored; an optional leading
`export` is tolerated for migration. Everything after the first `=` is a literal
single-line value, so spaces and additional `=` characters work. Matching
whole-value single or double quotes are removed, but interpolation, command
substitution, multiline values, and invalid variable names are **not** supported.
Invalid input fails before container creation and reports only its file/line or
key, never its value.

[`environment.sh`](./environment.sh) is the canonical in-container environment —
one file sourced by every command path (login shells, interactive shells, and
lifecycle scripts) so PATH, Proto activation, and derived variables are identical
everywhere. It is deliberately quiet and idempotent; interactive concerns
(aliases, prompt, completions, history) do not belong in it. Project-specific
variables go in an optional `environment.project.sh` hook next to it, which keeps
a repo's own knobs out of the shared file. Neither file holds secret *values* —
those arrive from the `--env-file` snapshot described above.

**Local Docker trust-boundary trade-off:** values passed through `--env-file`
are visible to anyone who can inspect the container's Docker metadata. Such a
principal can already control the container and read the mounted secret files.
Preparation output, lifecycle logs, and tests must still remain value-free.

This is how per-project / per-company keys work with **no collisions**: put a
project's keys in its own `secrets.d/<slug>` file. Different slug = different
file = different keys = a different generated `container-env/<slug>.env`.

### Mechanism 2 — Device-auth logins via named volumes

Add a volume line to `devcontainer.json` → `mounts` for the tool's home dir:

```jsonc
"source=codex-home-${devcontainerId},target=/home/vscode/.codex,type=volume",
```

- It's a **Docker-managed named volume**, not a host path you browse. On a Linux
  Docker host the data lives at `/var/lib/docker/volumes/<name>/_data`; on Docker
  Desktop it's inside the Docker VM.
- **No collisions** because the volume *name* embeds `${devcontainerId}` — a hash
  unique to each workspace-folder + devcontainer-config pair. Each repo (and each
  worktree) gets its own volume → its own state. The isolation is automatic; you
  never name or manage the id.
- **Never** bind-mount a tool's *whole home dir* to a literal host path
  (`source=${localEnv:HOME}/.codex,...`) — every container would share one host
  dir, so all projects share one login **and** their live SQLite/state, which
  lock-contends and can corrupt. (Sharing just the single `auth.json` file is
  Mechanism 3 below — safe because no live state travels.)

These per-`${devcontainerId}` volumes isolate each worktree's live state, but they
do not carry a *login* across worktrees: **Claude** login rides
`CLAUDE_CODE_OAUTH_TOKEN` (Mechanism 1) and **Codex** login is seeded from a
shared `auth.json` snapshot (Mechanism 3). The volumes remain the home for
everything that *should* stay per-worktree.

`~/.proto` is deliberately **not** a volume — see
[What this container persists today](#what-this-container-persists-today).

### Mechanism 3 — Project-scoped shared credential via a host bind mount

Some state should persist **and** be *shared across every worktree/container of
the same project*, while still isolated between projects. The mechanism is a
read-write bind mount to a **host** directory namespaced by a **literal project
slug** — it survives volume wipes, rebuilds, and a new `${devcontainerId}`,
because the data never lives in a Docker volume at all.

Codex is the motivating case, and gets the *single-file* form: it has no static
token (its only durable credential is the rotating `refresh_token` inside
`~/.codex/auth.json`), and its home dir is **churny** — multiple live SQLite files
(`logs_*`, `state_*`, `memories_*`). So only `auth.json` is shared; everything
else stays on the per-`${devcontainerId}` volume:

```jsonc
"source=${localEnv:HOME}/.config/devcontainer/codex-auth/devenv,target=/home/vscode/.config/devcontainer/codex-auth,type=bind,consistency=cached",
```

- **Shared across all worktrees of this project** *because* the slug is a literal
  (`devenv`) in the committed `devcontainer.json`: every worktree checks out the
  same value → same host path → one shared snapshot. (A
  `${localWorkspaceFolderBasename}`-derived path would give each worktree folder a
  different name and fragment the store — don't use it here.)
- **Isolated between projects** — another repo's `devcontainer.json` carries its
  own slug → its own host dir. Same guarantee the `secrets.d/<slug>` tier gives
  keys.
- This is the *opposite* choice from the Mechanism 2 warning above, and
  deliberately so: binding a whole churny home dir to a shared host path is a
  corruption bug; binding **one** credential file is not, because no live state
  travels with it.
- The host dir is pre-created by
  [`host/prepare-container-env.sh`](./host/prepare-container-env.sh) (the
  unconditional `prepare-container-env` entry of `initializeCommand`) with a
  non-fatal `mkdir -p`, so it is owned by the host user and writable by the
  container's `vscode` (uid 1000). It lives in *that* script, not the
  capability-gated `capture-warp-env` one, because the Codex bind mount exists
  whether or not Warp support is rendered. If the mkdir is ever skipped, Docker
  auto-creates the source root-owned and on-create's volume-claim loop repairs
  ownership on the next create. The mkdir lives in the script rather than an
  inline `&&`-chained `initializeCommand` on purpose: a chained mkdir failure
  would abort `devcontainer up` entirely.

[`on-create/codex-auth-snapshot.sh`](./on-create/codex-auth-snapshot.sh) runs two
guarded steps. It runs from **two triggers** so a login propagates promptly: on
container create (invoked by `setup-codex.sh`) **and** on every Claude session
start (a `SessionStart` hook in `.claude/settings.json`) — so a fresh
`codex login` reaches the snapshot without waiting for a full recreate. It always
exits `0` (a hook must never fail a session) and is a silent no-op when the
snapshot bind is absent.

- **Seed** — iff the container has **no** local `~/.codex/auth.json` and the
  snapshot holds valid JSON, copy snapshot → local with `cp -pn` (mode `0600`). A
  live local credential is **never** clobbered (that's the whole point — the
  snapshot must not overwrite a fresher local login). The corollary: a container
  that already holds a *stale* local credential is **not** auto-refreshed from a
  newer snapshot — deliberately, since "newer snapshot mtime" does not prove
  "more valid," and clobbering could break a container whose local login is
  actually current. To adopt a newer shared login, `codex login` again or delete
  `~/.codex/auth.json` and reopen a session (which re-seeds). `cp -pn` preserves
  the snapshot's mtime (so the seeded file is not spuriously "newer" — see the
  capture guard next) and refuses to clobber a login that raced into place.
- **Capture-back** — iff the local `auth.json` is valid, **newer** than the
  snapshot, **and its content differs** from the snapshot, copy local → snapshot
  via a same-dir temp file + atomic rename. The content check is load-bearing:
  plain `cp` doesn't preserve mtime, so without it a just-seeded local file would
  re-capture identical content, bump the snapshot's mtime, and strand a genuinely
  newer credential in a concurrent worktree that then compares "older". Single
  small file, last-writer-wins among *different* valid tokens.

Validity is checked with `jq`, then `python3`, then a minimal structural check
(leading `{` and trailing `}`) — never a bare non-empty test, so a truncated or
unrelated file can't overwrite the shared credential snapshot.

Why a single-file copy-on-create and not a bind of `auth.json` itself: the file
is rewritten via temp-file+rename on refresh, so a single-file bind mount would
strand writes on a detached inode and let the host copy go stale. Copying at
create/session time sidesteps that.

**Known tradeoff — snapshot rotation.** If several long-lived concurrent
containers cross the access-token expiry and each first-refreshes from the same
seeded `refresh_token`, provider-side rotation can invalidate all but one → a
single re-login in the affected container, which re-seeds the snapshot. This is a
convenience limit, not a safety one: because only `auth.json` is shared and the
live SQLite/state stays per-worktree, **no state is ever corrupted**. Login
continuity is best-effort; state isolation is guaranteed.

**Known tradeoff — concurrent captures are last-writer-wins.** Capture uses an
atomic same-dir temp+rename, so a reader never sees a partial file and the
snapshot is always one complete valid credential. It does **not** serialize two
containers capturing at the same instant: if two worktrees each `codex login`
(producing two *different* valid tokens) and their captures interleave, the one
whose `mv` lands last wins — which may be the slightly-older of the two. Both are
valid working logins and each container keeps its own local credential, so the
only possible cost is the same as rotation above (a single re-login if the token
that won was already provider-rotated-out) — never corruption. A cross-container
lock is deliberately avoided: `flock` on a host bind mount is unreliable across
Docker backends and would give false confidence for a bounded, no-corruption edge
that is already an accepted non-goal.

**Known tradeoff — capture is triggered, not continuous.** Capture runs on
container-create and on Claude `SessionStart`, not the instant `codex login`
finishes. A login done mid-session propagates at the next session start (or
recreate); until then it lives only on that worktree's volume. If that volume is
destroyed before any capture fires, the fresh login is lost (re-login required) —
again a convenience cost, never corruption.

The same bind pattern generalizes to any *project-scoped shared* data (a memory
store, a shared cache). Apply it only where cross-worktree sharing is the goal and
concurrent writes are either rare or benign — for churny live state, Mechanism 2's
per-`${devcontainerId}` isolation is the correct answer.

### Mechanism 4 — Host-captured terminal signals (Warp ACP)

Some signals are injected by the host terminal **per session**, not stored
anywhere persistent — Warp sets `TERM_PROGRAM=WarpTerminal`, `WARP_CLIENT_VERSION`,
and `WARP_CLI_AGENT_PROTOCOL_VERSION` only inside the terminals it spawns. Claude
Code reads them to switch to ACP structured output. Forwarding via `remoteEnv`
`${localEnv:...}` does **not** work: DevPod re-resolves `localEnv` against its own
(often GUI-launched) process env on every rebuild, finds the vars absent, and bakes
in empty values — so detection silently reverts to plain ANSI.

Instead, the `capture-warp-env` entry of `initializeCommand` runs
[`host/capture-warp-env.sh`](./host/capture-warp-env.sh)
**on the host** before each `devpod up`. It writes whatever Warp vars are present
to `~/.config/devcontainer/warp-env`, overwriting a key only when a fresh non-empty
value exists (so a value seeded from one Warp-terminal launch survives later
GUI-launched rebuilds). `configs/.shell_common` then sources that file (via the
read-only bind mount at `/run/devcontainer-config/warp-env`) with `set -a` in **every
interactive shell**, so the vars are exported and Claude Code — a child of that shell
— inherits them. This is scoped to interactive shells on purpose: it's the only place
Warp detection matters, it needs no rebuild (a new shell picks up refreshed values
immediately), and it never touches non-interactive contexts. **Seed it by running
`devpod up .` from a Warp terminal at least once**; there's no way to obtain Warp's
per-terminal vars without going through a Warp terminal once.

This script is deliberately Warp-only. `initializeCommand` is an **object of named
entries**, so the host-side work that must happen regardless of capabilities —
writing the `--env-file` (Mechanism 1) and pre-creating the project-slug bind
sources (Mechanism 3) — lives in the separate, unconditional
`prepare-container-env` entry. That separation is what lets a Warp-disabled
render drop this file *and* its entry while the container still creates: gating
the only `initializeCommand` would leave `runArgs --env-file` pointing at a file
nothing writes, and `docker run` would fail at create.

## What this container persists today

| Path | Volume name | Holds | Status |
|------|-------------|-------|--------|
| `CLAUDE_CODE_OAUTH_TOKEN` | — (env secret, Mechanism 1) | Claude Code **login** | ✅ persisted (host secrets file → injected every rebuild/worktree; no interactive login) |
| `~/.claude` | `claude-code-config-${devcontainerId}` | Claude Code config + session transcripts/plugins/history (**not** the login) | ✅ persisted per worktree (isolated live state) |
| `GEMINI_API_KEY` | — (env secret, Mechanism 1) | Gemini **login** (API-key mode) | ✅ persisted (host secrets file → injected every rebuild/worktree) |
| `~/.gemini` | `gemini-home-${devcontainerId}` | Gemini settings + history only | ✅ persisted |
| `~/.codex` | `codex-home-${devcontainerId}` | Codex live state (`logs_*`/`state_*`/`memories_*` SQLite); `auth.json` seeded on create | ✅ persisted per worktree (isolated live state) |
| `~/.config/devcontainer/codex-auth` | host bind → `~/.config/devcontainer/codex-auth/devenv` | Codex `auth.json` snapshot (login) | ✅ persisted (survives volume wipe; **shared** across worktrees, isolated per project — Mechanism 3) |
<!-- capability:start context7 -->
| `CONTEXT7_API_KEY` | — (env secret, Mechanism 1) | Context7 MCP server key | ✅ persisted |
<!-- capability:end context7 -->
| `~/.config` | `config-home-${devcontainerId}` | XDG config for other CLIs (catch-all) | ✅ persisted |
| `~/.proto` | Image layer (**no volume**) | Proto-managed toolchain | ✅ rebuilt from `.prototools`; not duplicated per worktree |
| `/commandhistory` | `claude-code-shellhistory-${devcontainerId}` | shell history | ✅ persisted |

`~/.proto` is deliberately the exception to the per-worktree volume pattern. The
complete pinned toolchain is already present in the image; mounting a fresh named
volume over it makes Docker copy that toolchain into every worktree. A change to
`.prototools` participates in the devcontainer definition fingerprint, so it
rebuilds the image, and startup fails fast if the image marker is stale. Never add
a `~/.proto` mount back; use
[`host/cleanup-legacy-proto-volume.sh`](./host/cleanup-legacy-proto-volume.sh) to
remove old ones.

## Per-tool auth setup

- **Claude** — long-lived token (Mechanism 1). Run `claude setup-token` **once**
  (on your host or any authed Claude), copy the printed token into your **common**
  secrets file as `CLAUDE_CODE_OAUTH_TOKEN=…`, and rebuild. Claude is then authed
  at first use on every rebuild and every worktree with no interactive login. The
  `~/.claude` volume still persists per-worktree config/transcripts/plugins, but
  the login no longer depends on it.
- **Codex** — seed-on-create (Mechanism 3). Run `codex login` **once** in any of
  the project's containers; the token lands in `~/.codex/auth.json` and
  `codex-auth-snapshot.sh` captures it back to the shared host snapshot on the next
  Claude session start (or recreate), so later worktrees/rebuilds are seeded
  automatically without another login. `~/.codex`'s live SQLite/state stays
  isolated per worktree.
  - *Do not* set `OPENAI_API_KEY` for this project if using the login — the key
    would shadow it.
  - An occasional single re-login can still be needed if provider-side rotation
    invalidates a seeded `refresh_token` across concurrent containers (see the
    Mechanism 3 tradeoffs above). No state is lost.
- **Gemini** — currently authenticates via the common `GEMINI_API_KEY` secret
  (API-key mode), so device-auth is not active. The `~/.gemini` volume persists
  settings/history regardless, and would hold the OAuth token if you switch to
  "Login with Google" (remove `GEMINI_API_KEY` from secrets first, since the key
  takes precedence).
- **Git identity** — `~/.gitconfig` is on the ephemeral layer, so set
  `GIT_USER_NAME` / `GIT_USER_EMAIL` in your **common** secrets file. `on-create.sh`
  rewrites the global gitconfig from them on every create; without them `git commit`
  fails with "Author identity unknown" after a rebuild. (Identity is the same across
  your projects, so it belongs in the common tier, not per-project.)

<!-- capability:start claude_octopus -->
## Provider allowlist (not auth, but related)

`OCTO_ALLOWED_PROVIDERS` in `devcontainer.json` → `containerEnv` controls which
providers Claude Octopus may use. It's non-secret and repo-specific, so it lives
in version control (not the host secrets file). The value is a space- or
comma-separated list of provider names; when **unset, every detected provider is
allowed**. Anything omitted is treated as unavailable **even if installed** — so
the allowlist is how you turn off a provider you don't want a given repo to use.

This repo allows **`claude codex gemini`** — the three CLIs it installs.
To disable one, drop it from the list; to enable another, add its name. The
provider names Octopus recognizes are `codex`, `gemini`, `opencode`, `copilot`,
`qwen`, `ollama`, `openrouter`, `perplexity`, plus `claude`. **Keep `claude` in
the list — it's the orchestrator.** Recognized aliases: `claude`/`anthropic`/
`sonnet`, `codex`/`openai`, `gemini`/`google`, `local`→`ollama`. A provider you
add here also needs its key in host secrets (e.g. `openrouter` →
`OPENROUTER_API_KEY`).
<!-- capability:end claude_octopus -->

## GitHub push auth (credential routing by org)

`git push` over HTTPS needs a token, and different GitHub orgs need different ones
(your personal `GITHUB_TOKEN` is read-only on org repos). Rather than configure each
repo, a **global credential helper routes by org**:

- `.devcontainer/scripts/git-credential-org-router.sh` — reads the repo's org from the
  push request (`credential.useHttpPath=true` passes the path) and emits the matching
  token from the environment. Tokens are read at push time and **never written to disk**
  (not in `.git/config`, the remote URL, or output). The helper contains **no org names** —
  it resolves the token env var per org as: (1) the **host map file** below, else (2) the
  `<ORG>_GITHUB_TOKEN` **convention** (org upper-cased, non-alphanumeric → `_`), else
  (3) `GITHUB_TOKEN` fallback.
- `.devcontainer/on-create/setup-git-credentials.sh` wires it into **global** git config.
  `~/.gitconfig` isn't a persisted volume, so re-applying on each create is what makes it
  survive rebuilds.
- The tokens themselves are ordinary Mechanism 1 env secrets: they ride the prepared
  `--env-file`, so they are present for pushes from any shell, hook, or agent process.

**The org list lives on the host, not in git.** The optional map file
`~/.config/devcontainer/github-token-map` (mounted read-only at
`/run/devcontainer-config/`) holds `org=ENV_VAR_NAME` lines — one per org whose token var
doesn't match the convention. Keeping it on the host mount means client/org names never
land in any repo's history.

**To add an org:** define its PAT env var in host secrets, then either name it per the
convention (no map entry needed) or add an `org=VAR` line to the host map file. Nothing
repo-specific, and nothing to commit — routing is by the remote's org, and each repo's
`/workspace` is its own bind mount.

## Where we track keys / tokens

- **`secrets.example`** is the registry of every key the dev container expects,
  with comments on which tier (common vs project) and which service uses it. When
  you add a credentialed tool, add its key there with a comment — that file is the
  source of truth for "what secrets exist," even though the real values live only
  on the host (never committed).
- **Volumes and binds** are self-documenting via the `mounts` block in
  `devcontainer.json`; the generated env file is named in `runArgs --env-file`.

## Adding this to another repo

1. Give the repo a **unique** `DEVCONTAINER_PROJECT` in `devcontainer.json` →
   `containerEnv`. This is its namespace handle for the secrets tier and the
   canonical slug everything else must match.
2. Per-project keys → `~/.config/devcontainer/secrets.d/<that-slug>` on your host;
   identity and shared keys stay in the common `~/.config/devcontainer/secrets`.
3. **Keep the slug in sync across the four places it appears.** Static JSON can't
   reference `DEVCONTAINER_PROJECT` from a mount or `runArgs` string, so the
   literal is unavoidably repeated — hence this checklist:
   1. `DEVCONTAINER_PROJECT` in `containerEnv` (the canonical slug),
   2. the `--env-file` path `…/container-env/<slug>.env` in `runArgs`,
   3. the `PROJECT="${DEVCONTAINER_PROJECT:-<slug>}"` default in
      `host/prepare-container-env.sh` — which also drives that script's
      `mkdir -p "$CONFIG_DIR/codex-auth/$PROJECT"`, so the snapshot dir needs no
      separate edit, and
   4. the mount `source=…/codex-auth/<slug>` in `devcontainer.json`.

   Same slug across a repo's worktrees = shared login snapshot; a different slug
   per repo = isolation.
4. Copy `initializeCommand` as an **object of named entries** and keep the
   `prepare-container-env` entry unconditional — it is what generates the
   `--env-file` named in `runArgs`, and without it container creation fails
   outright. Capability-gated host work (such as `capture-warp-env`) belongs in
   *additional* named entries that can be dropped independently; never make the
   env-file preparation ride inside one of them.
5. Device-auth / stateful tools → add one `…-${devcontainerId}` volume line per
   tool to `mounts`, then log in once. Never mount `~/.proto`.
6. Claude login → add `CLAUDE_CODE_OAUTH_TOKEN` to your **common** secrets file
   (mint it once with `claude setup-token`). No per-repo `devcontainer.json` edit:
   it rides the existing `--env-file` injection like any other key.
7. Codex login → copy the Mechanism 3 bind line plus its `mkdir -p` (items 3.4 and
   3.5 above). `codex-auth-snapshot.sh` reads the fixed container path
   (`~/.config/devcontainer/codex-auth`), so it is slug-agnostic — no per-repo edit.
   Copy its `SessionStart` hook entry in `.claude/settings.json` too, so a fresh
   `codex login` propagates without a full recreate.
<!-- capability:start claude_octopus -->
8. Provider allowlist → copy the `OCTO_ALLOWED_PROVIDERS` line and edit it to the
   providers that repo should use (keep `claude`).
<!-- capability:end claude_octopus -->

**Out of scope (for now):** bridging these secrets into a *cloud* agent runtime
(e.g. Codex cloud, where secrets are stripped before the agent phase) is not part
of this template. Everything above covers the local devcontainer path only.
