# Changelog

This file documents changes made to this template repository. Each entry provides enough detail for downstream projects (repos based on this template) to adopt the same change manually.

---

## 2026-05-28 — Fix: claim root-owned volumes upfront so on-create can't abort mid-chain

**Symptom:** A build log showed `on-create.sh` exiting status 1 at the Claude Octopus step, so every later script — `setup-claude-warp.sh`, `setup-graphify.sh`, the extension sync, and crucially `setup-shell.sh` — never ran. Since `setup-shell.sh` installs the proto-activating `~/.zshrc` template, the downstream symptom was `bun`/`bunx`/`proto` missing from the interactive shell PATH (a stock Oh My Zsh `~/.zshrc` left in place) and husky `pre-commit` hooks failing with `bunx: not found`.

**Root cause:** Docker named volumes mount **empty as `root:root`** unless the image pre-populated the path (copy-on-first-use seeds the volume with the image dir's ownership). `~/.proto` is pre-created in the Dockerfile and the `base:trixie` image happens to ship `/home/vscode/.config`, but `~/.codex` / `~/.gemini` are neither — so they mount `root:root` and the `vscode` user can't write to them. Two writes then failed: OpenSpec's Codex refresh (`EACCES … mkdir '/home/vscode/.codex/prompts'`, swallowed/non-fatal) and `setup-claude-octopus.sh`'s `ln -s … ~/.codex/claude-octopus` (`Permission denied`). Because `on-create.sh` runs `set -e` and **sources** each helper, that unguarded `ln` failure aborted the whole remaining chain.

**Fix 1 — claim every volume-mounted home dir once, upfront.** A single loop in `on-create.sh`, right after the secrets block and before any tool script runs (order-independent — important because `setup-openspec.sh` writes `~/.codex/prompts` *before* `setup-codex.sh` would run, so a per-script chown there is too late):
```bash
for d in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config" "$HOME/.proto"; do
    if [ -d "$d" ] && [ "$(stat -c '%U' "$d")" != "$(whoami)" ]; then
        sudo chown -R "$(whoami):$(whoami)" "$d"
    fi
done
```
This also closes a latent `~/.config` gap: nothing claimed it — it worked only by relying on the base image shipping it as `vscode`, which breaks the moment the mount is scoped to an image-unpopulated subdir (e.g. `~/.config/ccstatusline`). `setup-claude.sh` and `setup-proto.sh` keep their own existing claims as harmless belt-and-suspenders.

**Fix 2 — fault tolerance (defense in depth).** The three `mkdir`/`ln -s` calls in `setup-claude-octopus.sh` (`~/.codex`, `~/.opencode`, `~/.agents/skills`) are now `|| echo "⚠️  …"` guarded, so an optional integration step degrades to a warning instead of killing the whole setup under `set -e`. (Same spirit as the existing "sourced scripts use `return`, not `exit`" convention — here it was an external command tripping `set -e`.)

Verified: the claim loop is a no-op on a container where the dirs are already `vscode`-owned; all touched scripts pass `bash -n`.

---

## 2026-05-28 — Feat: ccstatusline auto-installs on rebuild (Claude Code status line)

**Goal:** Keep the Claude Code status line working across container rebuilds. `~/.claude/settings.json` points `statusLine.command` at the bare `ccstatusline` binary, but that binary installs to `~/.bun/bin`, which is **not** volume-mounted — so every rebuild wipes it and Claude Code warns that the status line command failed.

**New `setup-ccstatusline.sh` on-create script:**
- Installs the binary on every rebuild with `bun add -g ccstatusline` (guarded by a `command -v ccstatusline` check so re-runs are idempotent). `~/.bun/bin` is already on PATH via `setup_proto_env`, same as graphify's `~/.local/bin`.
- Seeds `~/.config/ccstatusline/settings.json` from the committed `.ccstatusline-settings.bak` **only when the config is missing**, so a fresh `~/.config` volume gets the intended status line (model · context · git branch · git changes) without manual reconfiguration. An existing config is never clobbered. (`~/.config` *is* volume-mounted, so the config normally persists on its own — this is just the fresh-volume fallback.)

**Wired into `on-create.sh`** immediately after `setup-claude.sh` (it backs the `statusLine` command in `~/.claude/settings.json`). Verified: first run installs `ccstatusline@2.2.19` and seeds the config identical to the backup; second run no-ops on both the binary and the config.

---

## 2026-05-28 — Fix: Graphify install survives Python 3.14 (clang→gcc) + stop tracking per-container pointers

**Goal:** Keep the on-rebuild Graphify auto-install working on the proto-managed Python 3.14 toolchain, and stop committing per-container pointer files.

**1. Compiler fallback in `setup-graphify.sh` (clang → gcc/g++):**
`graphifyy` (0.8.22) depends on `tree-sitter-dm` (0.25.1), which ships no prebuilt wheel for proto's Python 3.14 on this arch, so `uv tool install` compiles it from source. Python 3.14's `sysconfig` hardcodes **clang/clang++** for `CC`, `CXX`, `LDSHARED`, and `LDCXXSHARED`, but the devcontainer image ships only **gcc/g++** — so the build fails with `error: command 'clang' failed: No such file or directory`. Before installing, when `clang` is absent and `gcc` is present, export the overrides:
```bash
export CC="${CC:-gcc}"
export CXX="${CXX:-g++}"
export LDSHARED="${LDSHARED:-gcc -shared}"
export LDCXXSHARED="${LDCXXSHARED:-g++ -shared}"
```
Overriding `CC`/`CXX` alone is insufficient — the *link* step (`LDSHARED`/`LDCXXSHARED`) independently hardcodes clang and must be redirected too. Verified by reproducing the failure and confirming the fix yields a working `graphify 0.8.22`.

**2. Stop tracking per-container pointer/lock files (`.gitignore`):**
```
graphify-out/.graphify_root
graphify-out/.graphify_python
graphify-out/.rebuild.lock
```
`.graphify_root` (repo root) and `.graphify_python` (absolute path to the uv-tools Python) are regenerated per container and are meaningless — or wrong — in another container, so they shouldn't be committed. If already tracked, untrack once with `git rm --cached graphify-out/.graphify_root graphify-out/.graphify_python`.

---

## 2026-05-28 — Feature: AUTH-PERSISTENCE.md guide + Octopus provider allowlist

**Goal:** Document how auth/secrets persist (a living reference for adding credentialed tools), and add an explicit, repo-scoped allowlist for which providers Claude Octopus may use.

**1. `.devcontainer/AUTH-PERSISTENCE.md`:**
A reference doc covering the two persistence mechanisms — API keys via the two-tier host secrets files vs. device/OAuth logins on `${devcontainerId}`-keyed named volumes — the "pick one per tool per project" rule (an API-key env var shadows a device login), a table of what each volume persists today, per-tool login steps, and how to replicate the setup in another repo. Read it before wiring up a new credentialed CLI.

**2. Provider allowlist (`.devcontainer/devcontainer.json` → `containerEnv`):**
```jsonc
"OCTO_ALLOWED_PROVIDERS": "claude codex gemini opencode"
```
Claude Octopus (octo plugin) reads `OCTO_ALLOWED_PROVIDERS` at runtime via its `provider-allowlist.sh` lib: a space/comma-separated list where **unset = all detected providers allowed**, and any provider omitted from a non-empty list is treated as unavailable **even if installed**. Set it to the four CLIs this template installs. `claude` must stay in the list (it's the orchestrator). No setup-script change is needed — the env var alone gates `check-providers.sh` and fleet construction. It's non-secret and repo-specific, so it lives in version control, not the host secrets file. Recognized names: `codex gemini opencode copilot qwen ollama openrouter perplexity` + `claude` (aliases: `claude`/`anthropic`/`sonnet`, `codex`/`openai`, `gemini`/`google`, `local`→`ollama`).

---

## 2026-05-28 — Feature: Persist ~/.config tool configs across rebuilds, isolated per repo

**Goal:** Keep CLI/tool configuration under `~/.config` (e.g. `ccstatusline/settings.json`) alive across devcontainer rebuilds, scoped per-project, without committing it to the repo.

**1. Named volume over `~/.config` (`.devcontainer/devcontainer.json` → `mounts`):**
```jsonc
"source=config-home-${devcontainerId},target=/home/vscode/.config,type=volume",
```
`${devcontainerId}` scopes the volume per devcontainer, so each project gets its own isolated config store that survives rebuilds (a rebuild keeps the same id). A **named volume** (not a host bind mount) is the right tool here because of Docker's copy-on-first-use: when an empty named volume is first mounted onto a path the image already populated, Docker copies that image content into the volume; a bind mount would instead *shadow* the path and hide it. Targeting all of `~/.config` (rather than one subdir) means every tool writing under `~/.config/*` persists automatically — broad by design. To scope tighter, target a single subdir instead, e.g. `target=/home/vscode/.config/ccstatusline`.

**2. Seed once before the first rebuild (critical):**
Copy-on-first-use copies from the **image**, not from files written at runtime. A config you created interactively lives in the container's writable layer, so the new empty volume shadows it and it's lost on the rebuild that introduces the mount. Relay it through the bind-mounted workspace:
```bash
# Before rebuild (current container):
cp ~/.config/ccstatusline/settings.json /workspace/.ccstatusline-settings.bak
# After rebuild (volume now active):
mkdir -p ~/.config/ccstatusline
cp /workspace/.ccstatusline-settings.bak ~/.config/ccstatusline/settings.json
rm /workspace/.ccstatusline-settings.bak
```
Only needed for configs **not** regenerated by an on-create script. In this template, `~/.config/{proto,rtk,opencode,openspec,moon}` are rewritten on every rebuild, so they need no seeding — `ccstatusline` is the one that does. After this one-time seed the volume persists across all future rebuilds.

**3. Keep the relay file out of git (`.gitignore`):**
```
.ccstatusline-settings.bak
```

**Gotchas:**
- **Rebuild vs. recreate:** the volume survives rebuilds but is keyed to `${devcontainerId}`; a full delete-and-recreate generates a new id and drops the volume (same as any `*-${devcontainerId}` volume).
- **No host-side editing:** the config lives inside the Docker volume, not on the host — edit it from inside the container.
- **No overlapping mounts:** confirm no other mount targets a path under `~/.config`. The existing tool-home volumes sit at `~/.claude`, `~/.codex`, `~/.gemini`, `~/.proto` (not under `~/.config`), so there's no conflict.

**Alternative (host-durable + editable):** a bind mount survives even a full recreate and is editable from the host, but does *not* copy-on-first-use (it shadows) and the host dir must exist first: `"source=${localEnv:HOME}/.config/ccstatusline,target=/home/vscode/.config/ccstatusline,type=bind,consistency=cached"`.

---

## 2026-05-28 — Feature: Persist AI CLI logins across rebuilds, isolated per repo

**Goal:** Make Claude Code, Codex, and Gemini CLI logins survive container rebuilds, while keeping multiple project repos isolated — each repo gets its own accounts/keys with no cross-repo collisions.

**1. Named-volume mounts keyed by `${devcontainerId}` (`.devcontainer/devcontainer.json` → `mounts`):**
Each AI CLI's home dir is backed by a Docker named volume whose name embeds `${devcontainerId}` (automatically unique per repo, so logins never collide):
```jsonc
"source=claude-code-config-${devcontainerId},target=/home/vscode/.claude,type=volume",  // pre-existing
"source=codex-home-${devcontainerId},target=/home/vscode/.codex,type=volume",           // added
"source=gemini-home-${devcontainerId},target=/home/vscode/.gemini,type=volume",          // added
```
`~/.claude` was already volume-backed; only `~/.codex` and `~/.gemini` needed adding. Verify each CLI's actual home dir before mounting — Codex defaults to `~/.codex` (`CODEX_HOME`, holds `config.toml` + `auth.json`), Gemini to `~/.gemini` (holds `oauth_creds.json`), Claude to `~/.claude` (`CLAUDE_CONFIG_DIR`). Do **not** bind-mount to a literal host path (e.g. `~/.codex`): that shares one login across every repo, defeating isolation. The `${devcontainerId}` form gives each repo its own volume.

**2. Unique `DEVCONTAINER_PROJECT` slug (`.devcontainer/devcontainer.json` → `containerEnv`):**
Set `DEVCONTAINER_PROJECT` to a distinct lowercase slug per repo (here: `devenv`, was the placeholder `my-project`). This is the namespace handle for per-project secrets (`~/.config/devcontainer/secrets.d/<slug>` on the host). Two repos sharing a slug would share per-project keys.

**3. API key vs device login — pick one per tool per project:**
The two-tier secrets loader writes any keys from the host secret files into `/etc/environment`, so a present `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` **shadows** the corresponding CLI's device login. Choose one method per tool per project. Note Graphify's semantic extraction also reads those same Gemini/OpenAI keys, so a key set for Graphify will shadow a Gemini CLI device login.

**One-time logins (after rebuild):**
```bash
claude         # /login (or use an API key)
codex login    # device/OAuth — omit OPENAI_API_KEY to let this win
gemini         # /auth → Google login — omit GEMINI_API_KEY/GOOGLE_API_KEY to let this win
```
These now persist on the per-repo volumes; subsequent rebuilds skip re-login.

---

## 2026-05-27 — Feature: Warp integration (ACP detection signals + Claude Code Warp plugin) + trust workspace for Gemini CLI

**Goal:** Integrate the Warp terminal with the devcontainer on two fronts — let Claude Code detect Warp and open its structured-output channel (ACP), and auto-install Warp's official Claude Code plugin — and separately silence Gemini CLI's workspace-trust prompt inside the container.

**1. Forward Warp ACP detection signals (`.devcontainer/devcontainer.json` → `remoteEnv`):**
Forward three host vars from Warp into the container, each as `${localEnv:NAME}`:
- `WARP_CLI_AGENT_PROTOCOL_VERSION` — Warp's Agent Client Protocol version
- `WARP_CLIENT_VERSION` — Warp app version
- `TERM_PROGRAM` — `WarpTerminal` when launched from Warp

When all three are present, Claude Code detects it's running under Warp and opens a structured-output channel (ACP) instead of plain ANSI. The host sets these automatically when a terminal is spawned from Warp; without `remoteEnv` forwarding they're lost at the container boundary and Claude Code falls back to plain text.

**2. Auto-install the Claude Code Warp plugin:**
Add `.devcontainer/on-create/setup-claude-warp.sh`, which installs [claude-code-warp](https://github.com/warpdotdev/claude-code-warp) (Warp's official plugin) so its commands/skills are available without manual `/plugin marketplace add` + `/plugin install`. The script:
- Runs `claude plugin marketplace add warpdotdev/claude-code-warp` then `claude plugin install warp@claude-code-warp`.
- Skips if `~/.claude/plugins/cache/claude-code-warp/warp` already exists (the `~/.claude` volume persists this across rebuilds, so the install runs once per fresh volume).
- Gracefully no-ops if the `claude` CLI is not on PATH.

Source it in `.devcontainer/on-create.sh` **after** `setup-claude.sh` so the `claude` CLI is available.

**3. Trust the workspace for Gemini CLI (`.devcontainer/devcontainer.json` → `containerEnv`):**
Add `GEMINI_CLI_TRUST_WORKSPACE=true`. Suppresses the interactive "Do you trust the workspace?" prompt Gemini CLI shows on first run inside the mounted `/workspace`. Safe in a devcontainer because the workspace is the user's own bind-mounted code.

**Verification (after rebuild):**
```bash
echo "$TERM_PROGRAM $WARP_CLIENT_VERSION $WARP_CLI_AGENT_PROTOCOL_VERSION"
# → e.g. "WarpTerminal 0.2025.xx.xx.xx 0.1.0" when launched from Warp
echo "$GEMINI_CLI_TRUST_WORKSPACE"                 # → true
ls ~/.claude/plugins/cache/claude-code-warp/warp   # plugin payload present
```
If `TERM_PROGRAM` is empty inside the container, the terminal wasn't launched from Warp (or the host lacks the var) — Claude Code just uses plain ANSI, which is harmless.

---

## 2026-05-27 — Feature: auto-install Graphify (project-scoped) + commit the initial knowledge graph

**Goal:** Install [graphify](https://github.com/safishamsi/graphify) — a knowledge-graph builder for code/docs that AI assistants query instead of grepping raw files — register it at **project scope** with Claude Code, Codex CLI, OpenCode, and Gemini CLI, and commit an initial graph so fresh clones and `git worktree`s inherit a working setup without rebuilding (a rebuild costs Gemini API credits on every fresh checkout).

**Why project-scope (not user-scope like the octopus/warp installs):** Graphify ships a `--project` flag that writes skill files and PreToolUse hooks into the project directory. Committing those files means (1) git worktrees inherit them via the tracked tree — user-scoped installs run from `on-create.sh`, which doesn't fire on worktree creation; and (2) container rebuilds don't regenerate them, so the working tree stays clean.

**How to implement:**

1. **Add `uv` to `.prototools`** (graphify's recommended install method; the [Phault/proto-toml-plugins](https://github.com/Phault/proto-toml-plugins) repo already used for `fly`/`infisical`/`dagger` ships a maintained `uv` plugin):
   ```toml
   uv = "0.11.16"
   # ...
   [plugins]
   uv = "https://raw.githubusercontent.com/Phault/proto-toml-plugins/main/uv/plugin.toml"
   ```

2. **Add `.devcontainer/on-create/setup-graphify.sh`** that installs the CLI **with the `[gemini]` extra**, idempotently (skip if `graphify` is already on PATH):
   ```bash
   uv tool install 'graphifyy[gemini]'
   ```
   The `[gemini]` extra is **required**, not optional: graphify prefers Gemini for semantic extraction whenever `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set (this devcontainer provides them via the host-mounted secrets file), but talks to Gemini through the **OpenAI SDK**. The base `graphifyy` package omits `openai`, so plain `uv tool install graphifyy` fails at the extraction step with `… requires the openai package`. The extra adds ~3MB (openai SDK + httpx). If your secrets profile sets `OPENAI_API_KEY` instead, the same `[gemini]` extra covers that code path too. The script does **not** run `graphify install --project` — those files are committed (step 4).

3. **Source it in `.devcontainer/on-create.sh`** after `setup-proto.sh`, so `uv` is on PATH first.

4. **One-time, in a fresh clone of the template:** run the project-scoped installer for each platform, then commit the generated files:
   ```bash
   graphify install --project
   graphify install --project --platform codex
   graphify install --project --platform opencode
   graphify install --project --platform gemini
   ```
   This produces:
   - `.claude/skills/graphify/`, `.claude/CLAUDE.md` (graphify section), `.claude/settings.json` (PreToolUse hook)
   - `.agents/skills/graphify/` (Codex skill), `.codex/hooks.json` (PreToolUse hook — references the absolute path `/home/vscode/.local/bin/graphify`, fine in this devcontainer where the user is always `vscode`)
   - `.opencode/skills/graphify/`, `.opencode/plugins/graphify.js`, `.opencode/opencode.json`
   - `.gemini/skills/graphify/`, `.gemini/settings.json` (BeforeTool hook)
   - `## graphify` sections appended to the top-level `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`

5. **Exclude graphify's generated output from Biome.** The lint-staged pre-commit hook runs `biome check --write` on staged files; graphify's `graph.html` trips lint rules (unused functions, value-returning `forEach` callbacks) and `cache/*.json` gets reformatted on `--write`, mutating graphify's own output. Add a single exclude to the existing `files.includes` array in **`biome.jsonc`**:
   ```jsonc
   "includes": ["**", "!graphify-out/**"]
   ```
   **Two gotchas, both learned the hard way here:**
   - **Do not create a separate `biome.json` for this.** Biome's config discovery prefers `.json` over `.jsonc` in the same directory, so a stray `biome.json` silently shadows `biome.jsonc` — all its linter overrides, VCS integration, and other excludes are ignored with no warning or error. Audit which file is active with `bunx biome rage | grep Path:`.
   - **Use a single `!` to exclude.** `!!pattern` is Biome v2's *re-include* operator, so `!!graphify-out/**` on top of `**` is a no-op.

6. **`.gitignore` the per-user output files** (per the [graphify README](https://github.com/safishamsi/graphify#what-files-it-handles)) — everything else in `graphify-out/` is intentionally committable so the graph is shared across the team:
   ```
   graphify-out/manifest.json   # per-machine file hashes (diff on every machine)
   graphify-out/cost.json       # local API spend tracker
   ```

7. **Build and commit the initial graph:** run `/graphify .` (or `graphify build .`), then commit the shareable artifacts:
   - `graph.json` (~196 KB) — the structured graph used by `graphify query`
   - `graph.html` (~224 KB) — interactive visualization (open in a browser)
   - `GRAPH_REPORT.md` (~8 KB) — human-readable architecture summary
   - `cache/` — semantic-extraction cache, reused on incremental updates
   - `.graphify_labels.json` (community labels), `.graphify_root`, `.graphify_python` (pointer files)

   **Caveat:** `.graphify_root` (`/workspace`) and `.graphify_python` (`…/uv/tools/graphifyy/bin/python`) are absolute paths matching this devcontainer's layout. A downstream repo with a different path or a non-`uv` install should **not** copy ours — delete `graphify-out/` and regenerate with `/graphify .`.

**Verification (after rebuild):**
```bash
graphify --version                                  # 0.8.21+
ls .claude/skills/graphify .agents/skills/graphify  # skill files present
grep -A1 PreToolUse .claude/settings.json           # hook registered
bunx biome rage | grep Path:                        # → biome.jsonc (NOT biome.json)
bunx biome check graphify-out/graph.html            # → "These paths were provided but ignored"
graphify query "where is bun configured" | head -30 # returns a scoped subgraph
```
Then type `/graphify .` in any assistant to build the graph and `graphify query "<question>"` to consult it. The PreToolUse hooks nudge the assistant toward the graph automatically once `graphify-out/graph.json` exists.

**Trade-offs / notes for downstream:**
- The Codex hook bakes in the absolute path `/home/vscode/.local/bin/graphify`. If you change the devcontainer user, regenerate `.codex/hooks.json` with `graphify install --project --platform codex`.
- No other graphify extras (`pdf`, `office`, `video`) are installed by default — add per-project with `uv tool install --with "graphifyy[pdf]" graphifyy`.
- Building the graph is user-initiated and per-worktree: worktrees inherit the configuration but each builds its own graph.

---

## 2026-05-27 — Feature: auto-install Claude Octopus during devcontainer setup

**Goal:** Install [claude-octopus](https://github.com/nyldn/claude-octopus) — a multi-LLM orchestration layer with `/octo:*` commands and 50+ skills — automatically when the devcontainer is created, so it's available across Claude Code, Codex CLI, and OpenCode without manual setup steps.

**How to implement:**
1. Add `.devcontainer/on-create/setup-claude-octopus.sh`. The script:
   - Clones `nyldn/claude-octopus` once to `~/.local/share/claude-octopus` (canonical location, shared by all CLIs via symlinks — avoids cloning the repo three times per rebuild).
   - For **Claude Code**: runs `claude plugin marketplace add https://github.com/nyldn/plugins.git` then `claude plugin install octo@nyldn-plugins`. Skipped if `~/.claude/plugins/cache/nyldn-plugins/octo` already exists (the `~/.claude` volume persists this across rebuilds).
   - For **Codex CLI**: symlinks `~/.codex/claude-octopus` → canonical clone (only if `codex` is on PATH).
   - For **OpenCode**: symlinks `~/.opencode/claude-octopus` → canonical clone (only if `opencode` is on PATH).
   - Creates the shared skill-discovery symlink `~/.agents/skills/claude-octopus` → `<canonical>/skills` (this is the path both Codex and OpenCode read for skill files; the README shows them creating it independently, but they can share one symlink safely).
   - All steps are idempotent — re-running the script does nothing if everything is already in place.
2. In `.devcontainer/on-create.sh`, source the new script **after** `setup-claude.sh`, `setup-opencode.sh`, and `setup-codex.sh` — the script needs those CLIs on PATH to detect them and install the Claude Code plugin.

**Verification (after rebuild):**
```bash
ls -l ~/.codex/claude-octopus ~/.opencode/claude-octopus ~/.agents/skills/claude-octopus   # all symlinks resolved
ls ~/.local/share/claude-octopus/skills | head                                              # shows skill dirs
ls ~/.claude/plugins/cache/nyldn-plugins/octo                                               # contains version dir
```

Inside Claude Code, run `/octo:setup` to walk through provider configuration (one-time, interactive).

---

## 2026-05-13 — Fix: devcontainer on-create reliability (RTK, claude-mem, oh-my-opencode, sourced-script `exit`)

**Goal:** Several independent on-create failures were silently degrading the devcontainer: the RTK token-compression hook was never patched into `~/.claude/settings.json`; the `claude-mem` plugin's first-run SessionStart hook failed; the oh-my-opencode plugin was never registered in `opencode.json`; and sourced helper scripts used `exit` (which killed the parent `on-create.sh`, preventing later scripts like `setup-shell.sh` from running).

**Root causes:**
1. **RTK:** `rtk init -g` detects non-interactive shell mode (on-create runs without a TTY) and defaults to "N" at the "Patch existing settings.json?" prompt, then exits without writing the hook config. RTK ships an `--auto-patch` flag for exactly this scenario.
2. **claude-mem:** The plugin's SessionStart hook runs `bun install` on a manifest of `tree-sitter-*` packages whose post-install scripts shell out to `node-gyp`. The devcontainer's node feature is configured with `nodeGypDependencies: false`, and npm's bundled node-gyp isn't symlinked onto `$PATH` — so the spawn fails with ENOENT and the hook exits non-zero. (The packages themselves work at runtime via shipped prebuilds; only the install-script step fails.)
3. **oh-my-opencode:** Upstream installer's version comparison is lexicographic — `"1.14.48"` compares as less than `"1.4.0"` because `'1' < '4'` at the second segment. The installer prints `Detected OpenCode 1.x.x, but 1.4.0+ is required` and aborts before writing `opencode.json`, even on currently-released opencode versions.
4. **Sourced-script `exit`:** Helper scripts sourced by `on-create.sh` used `exit N` for early termination, which kills the parent shell instead of returning from the helper — silently preventing later scripts (notably `setup-shell.sh`) from running.

**How to implement:**
1. In `.devcontainer/on-create/setup-claude.sh`, after `setup_proto_env`, install `node-gyp` globally if missing:
   ```bash
   if command -v npm &> /dev/null && ! command -v node-gyp &> /dev/null; then
       npm install -g node-gyp >/dev/null 2>&1 || \
           echo "⚠️   Could not install node-gyp; some Claude Code plugins may fail their first install"
   fi
   ```
   npm is already on `$PATH` from the devcontainer node feature and ships `node-gyp` as a bundled dep, so `npm i -g node-gyp` just creates the bin symlink.
2. In `.devcontainer/on-create/setup-claude.sh`, change `rtk init -g` to `rtk init -g --auto-patch` so the hook config is patched into `~/.claude/settings.json` non-interactively (also creates `~/.claude/settings.json.bak`).
3. In `.devcontainer/on-create/setup-oh-my-opencode.sh`, replace the `bunx oh-my-opencode install …` block (and its 3-retry verification loop) with: (a) `bun install -g oh-my-opencode` if not already globally installed, (b) write `~/.config/opencode/opencode.json` directly with `{"$schema":"https://opencode.ai/config.json","plugin":["oh-my-openagent"]}`. This bypasses the broken upstream version check. The plugin is dual-published as `oh-my-opencode` (legacy npm name) and `oh-my-openagent` (new name accepted by opencode without a warning).
4. Replace every `exit N` with `return N` in the sourced helpers — `setup-vscode-extensions.sh` (3 occurrences) and `setup-oh-my-opencode.sh` (3 occurrences) — and add a convention comment at the top of `on-create.sh` documenting that sourced helpers must use `return`, not `exit`. Audit with `grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh` (should return empty).
5. **One-off cleanup (per devcontainer):** if a previous run left `/workspace/.codex` as a 0-byte regular file instead of a directory (visible as `ENOTDIR` from `openspec init`), run once: `chmod u+w /workspace/.codex && rm /workspace/.codex`. Not applicable if `.codex/` is already a directory (which it is in this repo). No script changes needed — this is a workspace-data issue, not a setup-script bug.

**Verification (after rebuild):**
```bash
command -v node-gyp                                          # /usr/local/share/nvm/.../bin/node-gyp
grep -A 5 PreToolUse ~/.claude/settings.json                 # shows rtk hook claude
cat ~/.config/opencode/opencode.json                         # has plugin: ["oh-my-openagent"]
test -d /workspace/.codex && echo ok || echo "still bad"     # ok
grep -nH -E "^[[:space:]]*exit[[:space:]]+[0-9]" .devcontainer/on-create/*.sh   # empty
```

---

## 2026-04-14 — Add Gemini CLI and Codex CLI to devcontainer

**Goal:** Include Gemini CLI and OpenAI Codex CLI as additional AI coding tools in the devcontainer.

**How to implement:**
1. Create `.devcontainer/on-create/setup-gemini.sh` — installs `@google/gemini-cli` globally via bun with an idempotency check.
2. Create `.devcontainer/on-create/setup-codex.sh` — installs `@openai/codex` globally via bun with an idempotency check.
3. In `.devcontainer/on-create.sh`, source both scripts (they're already wired in from the setup-shell.sh reordering).
4. In `README.md`, add authentication instructions for both tools (Gemini: Google account or `GEMINI_API_KEY`; Codex: `OPENAI_API_KEY`) and list them in the AI Tools section.

---

## 2026-04-14 — Pre-commit hook to enforce changelog updates

**Goal:** Automatically block significant commits that don't include a CHANGES.md update, so the changelog never falls behind.

**How to implement:**
1. In `.claude/settings.json`, add a `PreToolUse` hook with matcher `Bash(git commit*)`:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash(git commit*)",
           "hooks": [
             {
               "type": "command",
               "command": "bash -c '...check CHANGES.md is staged...'"
             }
           ]
         }
       ]
     }
   }
   ```
2. The hook extracts the conventional commit type (`feat:`, `fix:`, etc.) from `$TOOL_INPUT` and skips the check for minor types (`docs`, `chore`, `style`, `ci`, `test`).
3. For significant types (`feat`, `fix`, `refactor`, `perf`, `build`), it verifies `CHANGES.md` is in the staged files via `git diff --cached --name-only`. If missing, it exits with code 2 (block + message).

---

## 2026-04-14 — Run setup-shell.sh last in on-create.sh

**Goal:** Prevent tool installers from overwriting custom shell config during container setup.

**How to implement:**
1. In `.devcontainer/on-create.sh`, move the `source /workspace/.devcontainer/on-create/setup-shell.sh` line from early in the script (after `setup-proto.sh`) to the very end, after all other installer scripts and `setup-vscode-extensions.sh`.
2. Add a comment explaining why it must run last: tool installers (e.g. bun via proto) overwrite `~/.zshrc`, so our shell config must be written after all of them finish.

**Why:** Bun's installer (and potentially others) overwrites `~/.zshrc` during setup. When `setup-shell.sh` ran early, later installers would clobber the custom shell config, breaking devpod SSH auto-cd, aliases, PATH, and completions.

---

## 2026-04-08 — Add a shared commit policy in AGENTS.md (all agents)

**Goal:** Every AI agent (Claude Code, Cursor, Opencode) should always commit and push after each significant change without waiting for user confirmation — and follow the *same* policy, not a Claude-only copy.

**How to implement:**
1. Add a "Commit Policy" section to `AGENTS.md` (the shared-conventions file all agents consume):
   ```markdown
   ## Commit Policy
   ALWAYS commit and push after completing each significant change. Do NOT wait for the user to ask. Before committing, update `/workspace/CHANGES.md` with a dated entry (Goal + How to implement).
   ```
2. In `CLAUDE.md`, reference `@AGENTS.md` for shared conventions rather than duplicating the policy. (The policy was first added directly to `CLAUDE.md`, then moved into `AGENTS.md` the same day so all agents inherit one copy.)

---

## 2026-03-23 — Add OpenSpec skills/commands and improve Claude Code setup

**Goal:** Provide OpenSpec workflow skills (explore, propose, apply, archive) as slash commands for Claude Code and Codex. Also fix a stale-binary issue in the Claude Code setup script.

**How to implement:**
1. Create OpenSpec skill definitions under `.claude/skills/` and `.codex/skills/` for four workflows: `openspec-apply-change`, `openspec-archive-change`, `openspec-explore`, and `openspec-propose`.
2. Create corresponding slash commands under `.claude/commands/opsx/` (`apply.md`, `archive.md`, `explore.md`, `propose.md`).
3. In `.devcontainer/on-create/setup-claude.sh`, add a step to remove any stale bun-installed `claude-code` binary before installing the native binary, and use an explicit path check (`[ -f ~/.local/bin/claude ]`) instead of `command -v`.

---

## 2026-03-21 — Allow CI test step to pass with no tests

**Goal:** The template ships with no test files, so `bun test` fails and breaks CI. Let CI stay green until downstream projects add their own tests.

**How to implement:**
1. In `.github/workflows/ci.yml`, add `continue-on-error: true` to the test step:
   ```yaml
   - run: bun test
     continue-on-error: true
   ```

---

## 2026-04-08 — Devcontainer upgrades: Trixie, RTK, zsh default shell, SSH workspace dir, disable Moby

**Goal:** Modernize the devcontainer base image, add token compression tooling, fix SSH shell defaults, and switch from Moby to Docker CE.

**How to implement:**
1. **Upgrade base image to Debian 13 (Trixie):** In `.devcontainer/Dockerfile`, change base image tag from `bookworm` to `trixie`. Brings GLIBC 2.41, OpenSSL 3.4+, GCC 14.
2. **Add RTK (token compression):** In `Dockerfile`, add a new `RUN` step after git-delta:
   ```dockerfile
   RUN ARCH=$(uname -m) \
       && wget -q "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${ARCH}-unknown-linux-gnu.tar.gz" -O /tmp/rtk.tar.gz \
       && tar xzf /tmp/rtk.tar.gz -C /usr/local/bin/ \
       && chmod +x /usr/local/bin/rtk \
       && rm /tmp/rtk.tar.gz
   ```
   In `.devcontainer/on-create/setup-claude.sh`, add RTK hook initialization:
   ```bash
   if command -v rtk &> /dev/null; then
       rtk init -g
   fi
   ```
   RTK requires GLIBC 2.39+, which is why the Trixie upgrade is a prerequisite. Saves 60-90% tokens on Claude Code bash output.
3. **Set zsh as default login shell for SSH:** In `Dockerfile`, add before `USER vscode`:
   ```dockerfile
   RUN chsh -s /usr/bin/zsh vscode
   ```
   In `devcontainer.json`, flip: `"configureZshAsDefaultShell": true`. SSH reads `/etc/passwd` (ignoring env vars), which `chsh` fixes.
4. **SSH starts in /workspace:** In `.devcontainer/configs/.shell_common`, add before PATH exports:
   ```bash
   [[ "$PWD" == "$HOME" ]] && cd /workspace
   ```
   Only fires when the shell opens in `$HOME` (the SSH default).
5. **Disable Moby:** In `devcontainer.json`, update docker-in-docker feature:
   ```json
   "ghcr.io/devcontainers/features/docker-in-docker:2": { "moby": false }
   ```

---

## 2026-03-21 — macOS onboarding: host setup script + README Quick Start & prerequisites

**Goal:** Let a non-technical user go from a bare Mac to a running devcontainer with minimal manual steps — a one-command host bootstrap plus copy-paste README instructions.

**How to implement:**
1. **Host setup script — `init-host.sh`** (repo root). Installs, via Homebrew: Xcode CLT, Docker Desktop, Git, DevPod, the Warp terminal (`brew install --cask warp`, between DevPod and IDE installation), an IDE (Cursor or VS Code, user's choice), GitHub CLI, and SSH keys. Also creates the host directories used for container mounts.
2. **README — "Prerequisites (Host Machine Setup)"** section before "Getting Started", covering: Docker Desktop, Git, DevPod, an IDE, SSH keys, GitHub CLI, and host directory creation. Point Mac users to `init-host.sh` as the one-command path. Remove the now-redundant `mkdir` from the secrets step (covered here).
3. **README — "Quick Start (Mac)"** section at the top: the `curl | bash` one-liner, clone, init, and `devpod up`. Note the repo must be **public** for the `curl` one-liner to work without authentication.
4. **Template cleanup:** add `rm -f init-host.sh` to the template-only file cleanup in `init-new-project.sh` so the host script doesn't carry into downstream projects (see the project-init cleanup entry).

---

## 2026-03-20 — Clean up template-only files during project init

**Goal:** `init-new-project.sh` bootstraps a new project from the template; template-history files and the bootstrap script itself should not survive into the downstream project's tree.

**How to implement (all in `init-new-project.sh`):**
1. In the template-only file cleanup section, remove files that only make sense in the template repo — add `rm -f CHANGES.md` alongside the existing `rm -f bun.lock`. (The macOS onboarding entry also adds `rm -f init-host.sh` here.)
2. Add `rm -f "$0"` just before the `git add .` / initial-commit step so the bootstrap script deletes itself before being committed to the new repo.

---

## 2026-03-20 — Add Claude and Codex to Openspec init

**Goal:** Ensure Openspec generates configuration for all coding agents used in the template, not just Cursor and OpenCode.

**How to implement:**
1. In `.devcontainer/on-create/setup-openspec.sh`, update the `openspec init` command to include `claude` and `codex`:
   ```bash
   openspec init --tools claude,codex,cursor,opencode --force
   ```

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
3. Scope all named Docker volume names with `${devcontainerId}` so multiple checkouts of this template on the same host each get their own volumes (see the Proto tool caching entry for the `~/.proto` volume mount and the cross-device-link rationale).

---

## 2026-03-16 — Host-mounted two-tier secrets system (incl. GitHub token forwarding)

**Goal:** `${localEnv:VAR}` in `devcontainer.json` only works when the IDE process itself has the env var set — GUI apps launched from Dock, Spotlight, or DevPod don't inherit shell exports, making this approach unreliable. Replace it with a bind-mounted secrets file that all container processes can read directly, regardless of how the IDE was launched. This is also how rate-limit tokens get forwarded: proto resolves tool versions via the GitHub API, and unauthenticated requests are capped at 60/hr per IP — putting `GITHUB_TOKEN` in the secrets file raises this to 5,000/hr.

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
   File format — one `KEY=value` per line, `#` for comments. Put API and rate-limit tokens here:
   ```
   GITHUB_TOKEN=ghp_...          # raises GitHub API limit 60/hr → 5,000/hr (used by proto)
   CONTEXT7_API_KEY=your-key-here
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

**`remoteEnv` fallback for `GITHUB_TOKEN`:** `remoteEnv: { "GITHUB_TOKEN": "${localEnv:GITHUB_TOKEN}" }` also forwards the token, but only when the IDE was launched from a shell that already has it set — prefer the secrets file, which works in GUI-launched IDEs too. If both are configured, the secrets file wins (it's loaded last).

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
