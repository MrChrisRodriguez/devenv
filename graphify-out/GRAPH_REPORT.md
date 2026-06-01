# Graph Report - workspace  (2026-06-01)

## Corpus Check
- 80 files · ~55,790 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 922 nodes · 876 edges · 88 communities (66 shown, 22 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `58c6b643`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Base TypeScript Config|Base TypeScript Config]]
- [[_COMMUNITY_Devcontainer Setup Scripts|Devcontainer Setup Scripts]]
- [[_COMMUNITY_Root Package Manifest|Root Package Manifest]]
- [[_COMMUNITY_Devcontainer JSON Config|Devcontainer JSON Config]]
- [[_COMMUNITY_VS Code Customizations|VS Code Customizations]]
- [[_COMMUNITY_Start App TS Config|Start App TS Config]]
- [[_COMMUNITY_Stagehand TS Config|Stagehand TS Config]]
- [[_COMMUNITY_Devcontainer Features|Devcontainer Features]]
- [[_COMMUNITY_Forwarded Ports Config|Forwarded Ports Config]]
- [[_COMMUNITY_Worker TS Config|Worker TS Config]]
- [[_COMMUNITY_Workspace Catalog Deps|Workspace Catalog Deps]]
- [[_COMMUNITY_Claude Code Settings|Claude Code Settings]]
- [[_COMMUNITY_Skill & Plugin Manifests|Skill & Plugin Manifests]]
- [[_COMMUNITY_Library TS Config|Library TS Config]]
- [[_COMMUNITY_Next.js TS Config|Next.js TS Config]]
- [[_COMMUNITY_Workspace VS Code Settings|Workspace VS Code Settings]]
- [[_COMMUNITY_Host Init Scripts|Host Init Scripts]]
- [[_COMMUNITY_OpenSpec Slash Commands|OpenSpec Slash Commands]]
- [[_COMMUNITY_MCP Server Config|MCP Server Config]]
- [[_COMMUNITY_Moon Build System|Moon Build System]]
- [[_COMMUNITY_Codex Hooks Config|Codex Hooks Config]]
- [[_COMMUNITY_Gemini Hooks Config|Gemini Hooks Config]]
- [[_COMMUNITY_OpenCode Plugin Deps|OpenCode Plugin Deps]]
- [[_COMMUNITY_Agent Guideline Docs|Agent Guideline Docs]]
- [[_COMMUNITY_Extensions Sync Script|Extensions Sync Script]]
- [[_COMMUNITY_OpenCode Config|OpenCode Config]]
- [[_COMMUNITY_Graphify OpenCode Plugin|Graphify OpenCode Plugin]]
- [[_COMMUNITY_VS Code Extensions|VS Code Extensions]]
- [[_COMMUNITY_Husky Shell Lib|Husky Shell Lib]]
- [[_COMMUNITY_Husky Hooks|Husky Hooks]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]

## God Nodes (most connected - your core abstractions)
1. `Changelog` - 40 edges
2. `compilerOptions` - 38 edges
3. `compilerOptions` - 19 edges
4. `What You Must Do When Invoked` - 16 edges
5. `What You Must Do When Invoked` - 16 edges
6. `/graphify` - 15 edges
7. `/graphify` - 15 edges
8. `/graphify` - 14 edges
9. `What You Must Do When Invoked` - 14 edges
10. `compilerOptions` - 12 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `Moon Tasks`  [INFERRED]
  .github/workflows/ci.yml → .moon/tasks.yml
- `Opsx Archive Command` --references--> `OpenSpec Config`  [INFERRED]
  .opencode/commands/opsx-archive.md → openspec/config.yaml
- `Claude Code Guidelines` --references--> `Agent Guidelines`  [EXTRACTED]
  CLAUDE.md → AGENTS.md
- `Moon Toolchain` --conceptually_related_to--> `Moon Workspace`  [EXTRACTED]
  .moon/toolchains.yml → .moon/workspace.yml
- `Moon Tasks` --conceptually_related_to--> `Moon Workspace`  [EXTRACTED]
  .moon/tasks.yml → .moon/workspace.yml

## Communities (88 total, 22 thin omitted)

### Community 0 - "Base TypeScript Config"
Cohesion: 0.05
Nodes (43): compileOnSave, compilerOptions, allowJs, allowSyntheticDefaultImports, allowUnreachableCode, allowUnusedLabels, alwaysStrict, declaration (+35 more)

### Community 1 - "Devcontainer Setup Scripts"
Cohesion: 0.08
Nodes (16): load_secrets_file(), optional(), setup-biome.sh script, setup-ccstatusline.sh script, setup-claude-octopus.sh script, setup-claude.sh script, setup-claude-warp.sh script, setup-codex.sh script (+8 more)

### Community 2 - "Root Package Manifest"
Cohesion: 0.05
Nodes (37): @biomejs/biome, dotenv, @fission-ai/openspec, husky, opencode-ai, tsx, @types/bun, @types/node (+29 more)

### Community 3 - "Devcontainer JSON Config"
Cohesion: 0.05
Nodes (41): label, onAutoForward, label, onAutoForward, label, onAutoForward, label, onAutoForward (+33 more)

### Community 4 - "VS Code Customizations"
Cohesion: 0.08
Nodes (25): args, path, customizations, vscode, source.fixAll, editor.codeActionsOnSave, editor.defaultFormatter, editor.formatOnSave (+17 more)

### Community 5 - "Start App TS Config"
Cohesion: 0.09
Nodes (21): compilerOptions, allowImportingTsExtensions, alwaysStrict, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+13 more)

### Community 6 - "Stagehand TS Config"
Cohesion: 0.12
Nodes (15): compilerOptions, allowImportingTsExtensions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, noEmit, outDir (+7 more)

### Community 7 - "Devcontainer Features"
Cohesion: 0.13
Nodes (15): features, ghcr.io/devcontainers/features/common-utils:2, ghcr.io/devcontainers/features/docker-in-docker:2, ghcr.io/devcontainers/features/git:1, ghcr.io/devcontainers/features/github-cli:1, ghcr.io/devcontainers/features/node:1, configureZshAsDefaultShell, installOhMyZsh (+7 more)

### Community 8 - "Forwarded Ports Config"
Cohesion: 0.05
Nodes (43): code:block10 (You are a graphify extraction subagent. Read the files liste), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash (mkdir -p graphify-out), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c ") (+35 more)

### Community 9 - "Worker TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, jsx, lib, noEmit, noPropertyAccessFromIndexSignature, noUnusedLocals, noUnusedParameters, types (+3 more)

### Community 10 - "Workspace Catalog Deps"
Cohesion: 0.05
Nodes (38): code:block1 (/graphify                                             # full), code:bash (if [ ! -f graphify-out/.graphify_python ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (if [ ! -f graphify-out/.graphify_extract.json ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+30 more)

### Community 11 - "Claude Code Settings"
Cohesion: 0.20
Nodes (9): Changelog, args, command, env, DEFAULT_MINIMUM_TOKENS, hooks, PreToolUse, mcpServers (+1 more)

### Community 13 - "Library TS Config"
Cohesion: 0.25
Nodes (7): compilerOptions, composite, declaration, noEmit, outDir, extends, include

### Community 14 - "Next.js TS Config"
Cohesion: 0.25
Nodes (7): compilerOptions, jsx, lib, plugins, exclude, extends, include

### Community 15 - "Workspace VS Code Settings"
Cohesion: 0.29
Nodes (6): typescript.enablePromptUseWorkspaceTsdk, typescript.tsdk, yaml.schemas, file:///workspace/.moon/cache/schemas/tasks.json, file:///workspace/.moon/cache/schemas/toolchain.json, file:///workspace/.moon/cache/schemas/workspace.json

### Community 16 - "Host Init Scripts"
Cohesion: 0.40
Nodes (3): Project Template, init-host.sh script, init-new-project.sh script

### Community 17 - "OpenSpec Slash Commands"
Cohesion: 0.40
Nodes (5): OpenSpec Config, Opsx Apply Command, Opsx Archive Command, Opsx Explore Command, Opsx Propose Command

### Community 18 - "MCP Server Config"
Cohesion: 0.50
Nodes (3): context7, bunx, @upstash/context7-mcp

### Community 19 - "Moon Build System"
Cohesion: 0.50
Nodes (4): CI Workflow, Moon Tasks, Moon Toolchain, Moon Workspace

### Community 22 - "OpenCode Plugin Deps"
Cohesion: 0.05
Nodes (38): code:block1 (/graphify                                             # full), code:bash (if [ ! -f graphify-out/.graphify_python ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (if [ ! -f graphify-out/.graphify_extract.json ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+30 more)

### Community 25 - "OpenCode Config"
Cohesion: 0.06
Nodes (36): code:bash (mkdir -p graphify-out), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (LOCAL_PATH=$(graphify clone <github-url> [--branch <branch>]), code:bash (graphify export obsidian), code:bash (graphify export html  # auto-aggregates to community view if), code:bash (graphify export wiki), code:bash (graphify export neo4j), code:bash (graphify export neo4j --push bolt://localhost:7687 --user ne) (+28 more)

### Community 26 - "Graphify OpenCode Plugin"
Cohesion: 0.06
Nodes (36): code:bash (mkdir -p graphify-out), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (LOCAL_PATH=$(graphify clone <github-url> [--branch <branch>]), code:bash (graphify export obsidian), code:bash (graphify export html  # auto-aggregates to community view if), code:bash (graphify export wiki), code:bash (graphify export neo4j), code:bash (graphify export neo4j --push bolt://localhost:7687 --user ne) (+28 more)

### Community 30 - "Community 30"
Cohesion: 0.06
Nodes (34): code:block1 (/graphify                                             # full), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash (if [ ! -f graphify-out/.graphify_extract.json ]; then), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c "), code:bash ($(cat .graphify_python) -c ") (+26 more)

### Community 31 - "Community 31"
Cohesion: 0.07
Nodes (29): 1. Install Docker, 2. Install Git, 3. Install DevPod, 4. Install an IDE (Code Editor), 5. Set Up SSH Keys (if you don't have them already), 6. Install GitHub CLI (optional but recommended), 7. Create the Host Directories, code:bash (# 1. Set up your Mac (installs Docker, Git, DevPod, Warp, an) (+21 more)

### Community 32 - "Community 32"
Cohesion: 0.10
Nodes (20): 2026-01-09 — Project initialization script (`init-new-project.sh`), 2026-01-11 — Housekeeping: Biome upgrade, port trimming, Openspec skills migration, 2026-03-16 — Context7 MCP server integration, 2026-03-20 — Add CHANGES.md for template change tracking, 2026-03-20 — Add Claude and Codex to Openspec init, 2026-03-20 — Clean up template-only files during project init, 2026-03-21 — Allow CI test step to pass with no tests, 2026-03-21 — macOS onboarding: host setup script + README Quick Start & prerequisites (+12 more)

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (17): Check for context, code:block1 (┌─────────────────────────────────────────┐), code:bash (openspec list --json), code:block3 (User: I'm thinking about adding real-time collaboration), code:block4 (User: The auth system is a mess), code:block5 (User: /opsx:explore add-auth-system), code:block6 (User: Should we use Postgres or SQLite?), code:block7 (## What We Figured Out) (+9 more)

### Community 34 - "Community 34"
Cohesion: 0.11
Nodes (17): Check for context, code:block1 (┌─────────────────────────────────────────┐), code:bash (openspec list --json), code:block3 (User: I'm thinking about adding real-time collaboration), code:block4 (User: The auth system is a mess), code:block5 (User: /opsx:explore add-auth-system), code:block6 (User: Should we use Postgres or SQLite?), code:block7 (## What We Figured Out) (+9 more)

### Community 35 - "Community 35"
Cohesion: 0.11
Nodes (17): Check for context, code:block1 (┌─────────────────────────────────────────┐), code:bash (openspec list --json), code:block3 (User: I'm thinking about adding real-time collaboration), code:block4 (User: The auth system is a mess), code:block5 (User: /opsx:explore add-auth-system), code:block6 (User: Should we use Postgres or SQLite?), code:block7 (## What We Figured Out) (+9 more)

### Community 36 - "Community 36"
Cohesion: 0.15
Nodes (13): code:bash ($(cat graphify-out/.graphify_python) -c "), code:block11 ([Agent tool call 1: files 1-15, subagent_type="general-purpo), code:bash (PROJECT_ROOT=$(cat graphify-out/.graphify_root)), code:block13 (You are a graphify extraction subagent. Read the files liste), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+5 more)

### Community 37 - "Community 37"
Cohesion: 0.15
Nodes (12): Adding this to another repo, code:jsonc ("source=codex-home-${devcontainerId},target=/home/vscode/.co), Dev Container Auth & Secrets Persistence, Mechanism 1 — API keys via host secrets files, Mechanism 2 — Device-auth logins via named volumes, Mechanism 3 — Host-captured terminal signals (Warp ACP), Per-tool auth setup, Provider allowlist (not auth, but related) (+4 more)

### Community 38 - "Community 38"
Cohesion: 0.15
Nodes (13): code:bash ($(cat graphify-out/.graphify_python) -c "), code:block11 ([Agent tool call 1: files 1-15, subagent_type="general-purpo), code:bash (PROJECT_ROOT=$(cat graphify-out/.graphify_root)), code:block13 (You are a graphify extraction subagent. Read the files liste), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+5 more)

### Community 39 - "Community 39"
Cohesion: 0.17
Nodes (11): Check for context, code:block1 (┌─────────────────────────────────────────┐), code:bash (openspec list --json), Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do (+3 more)

### Community 40 - "Community 40"
Cohesion: 0.17
Nodes (11): Check for context, code:block1 (┌─────────────────────────────────────────┐), code:bash (openspec list --json), Ending Discovery, Guardrails, OpenSpec Awareness, The Stance, What You Don't Have To Do (+3 more)

### Community 41 - "Community 41"
Cohesion: 0.18
Nodes (10): A. Delete files/dirs, B. Edit wiring, C. Docs, D. Changelog (append-only), Deliver / Verify, Phase Weights, Provider Requirements, Session Plan — Remove OpenCode (+2 more)

### Community 42 - "Community 42"
Cohesion: 0.20
Nodes (9): Agent Guidelines, Bun APIs, Code Quality, code:block1 (apps/      # deployable applications (Next.js, Elysia, Cloud), Commit Policy, graphify, Monorepo Structure, Runtime (+1 more)

### Community 43 - "Community 43"
Cohesion: 0.25
Nodes (7): Claude Code Guidelines, code:ts#index.ts (import index from "./index.html"), code:html#index.html (<html>), code:tsx#frontend.tsx (import React from "react";), code:sh (bun --hot ./index.ts), Frontend, graphify

### Community 44 - "Community 44"
Cohesion: 0.29
Nodes (6): code:bash (mkdir -p openspec/changes/archive), code:bash (mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-), code:block3 (## Archive Complete), code:block4 (## Archive Complete), code:block5 (## Archive Complete (with warnings)), code:block6 (## Archive Failed)

### Community 45 - "Community 45"
Cohesion: 0.29
Nodes (6): Boundaries / Non-goals, Context, Job Statement, Scope (locked via /octo:plan questions), Session Intent Contract, Success Criteria

### Community 46 - "Community 46"
Cohesion: 0.29
Nodes (6): code:bash (mkdir -p openspec/changes/archive), code:bash (mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-), code:block3 (## Archive Complete), code:block4 (## Archive Complete), code:block5 (## Archive Complete (with warnings)), code:block6 (## Archive Failed)

### Community 47 - "Community 47"
Cohesion: 0.29
Nodes (7): 2026-05-27 — Feature: auto-install Graphify (project-scoped) + commit the initial knowledge graph, code:toml (uv = "0.11.16"), code:bash (uv tool install 'graphifyy[gemini]'), code:bash (graphify install --project), code:jsonc ("includes": ["**", "!graphify-out/**"]), code:block18 (graphify-out/manifest.json   # per-machine file hashes (diff), code:bash (graphify --version                                  # 0.8.21)

### Community 48 - "Community 48"
Cohesion: 0.33
Nodes (5): code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions apply --change "<name>" --json), code:block3 (## Implementing: <change-name> (schema: <schema-name>)), code:block4 (## Implementation Complete), code:block5 (## Implementation Paused)

### Community 49 - "Community 49"
Cohesion: 0.33
Nodes (5): code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions apply --change "<name>" --json), code:block3 (## Implementing: <change-name> (schema: <schema-name>)), code:block4 (## Implementation Complete), code:block5 (## Implementation Paused)

### Community 50 - "Community 50"
Cohesion: 0.33
Nodes (5): code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions apply --change "<name>" --json), code:block3 (## Implementing: <change-name> (schema: <schema-name>)), code:block4 (## Implementation Complete), code:block5 (## Implementation Paused)

### Community 51 - "Community 51"
Cohesion: 0.33
Nodes (5): code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions apply --change "<name>" --json), code:block3 (## Implementing: <change-name> (schema: <schema-name>)), code:block4 (## Implementation Complete), code:block5 (## Implementation Paused)

### Community 52 - "Community 52"
Cohesion: 0.33
Nodes (5): code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions apply --change "<name>" --json), code:block3 (## Implementing: <change-name> (schema: <schema-name>)), code:block4 (## Implementation Complete), code:block5 (## Implementation Paused)

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (6): 2026-01-11 — Moon 2.x, workspace config, and GitHub Actions CI, code:toml (moon = "2.1.0"), code:yaml (projects:), code:yaml (bun:), code:yaml (tasks:), code:yaml (name: CI)

### Community 54 - "Community 54"
Cohesion: 0.33
Nodes (6): 2026-03-16 — Host-mounted two-tier secrets system (incl. GitHub token forwarding), code:bash (mkdir -p ~/.config/devcontainer/secrets.d), code:block45 (GITHUB_TOKEN=ghp_...          # raises GitHub API limit 60/h), code:json ("containerEnv": {), code:bash (load_secrets_file() {), code:bash ([ -f /run/devcontainer-config/secrets ] && set -a && source )

### Community 55 - "Community 55"
Cohesion: 0.33
Nodes (6): 2026-04-08 — Devcontainer upgrades: Trixie, RTK, zsh default shell, SSH workspace dir, disable Moby, code:dockerfile (RUN ARCH=$(uname -m) \), code:bash (if command -v rtk &> /dev/null; then), code:dockerfile (RUN chsh -s /usr/bin/zsh vscode), code:bash ([[ "$PWD" == "$HOME" ]] && cd /workspace), code:json ("ghcr.io/devcontainers/features/docker-in-docker:2": { "moby)

### Community 56 - "Community 56"
Cohesion: 0.40
Nodes (4): code:bash (openspec new change "<name>"), code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions <artifact-id> --change "<name>" --json), code:bash (openspec status --change "<name>")

### Community 57 - "Community 57"
Cohesion: 0.40
Nodes (4): code:bash (openspec new change "<name>"), code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions <artifact-id> --change "<name>" --json), code:bash (openspec status --change "<name>")

### Community 58 - "Community 58"
Cohesion: 0.40
Nodes (4): code:bash (openspec new change "<name>"), code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions <artifact-id> --change "<name>" --json), code:bash (openspec status --change "<name>")

### Community 59 - "Community 59"
Cohesion: 0.40
Nodes (4): code:bash (openspec new change "<name>"), code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions <artifact-id> --change "<name>" --json), code:bash (openspec status --change "<name>")

### Community 60 - "Community 60"
Cohesion: 0.40
Nodes (4): code:bash (openspec new change "<name>"), code:bash (openspec status --change "<name>" --json), code:bash (openspec instructions <artifact-id> --change "<name>" --json), code:bash (openspec status --change "<name>")

### Community 61 - "Community 61"
Cohesion: 0.40
Nodes (5): 2026-01-11 — Husky + commitlint for enforced commit conventions, code:bash (bun add -D husky @commitlint/cli @commitlint/config-conventi), code:bash (bunx husky init), code:ts (export default { extends: ["@commitlint/config-conventional"), code:json ({)

### Community 62 - "Community 62"
Cohesion: 0.40
Nodes (5): 2026-03-16 — Proto tool caching via persistent Docker volume, code:json ("mounts": [), code:bash (if ! command -v proto &>/dev/null; then), code:bash (if [ "$(stat -c '%U' ~/.proto)" != "vscode" ]; then), code:dockerfile (USER vscode)

### Community 63 - "Community 63"
Cohesion: 0.50
Nodes (3): code:bash (mkdir -p openspec/changes/archive), code:bash (mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-), code:block3 (## Archive Complete)

### Community 64 - "Community 64"
Cohesion: 0.50
Nodes (3): code:bash (mkdir -p openspec/changes/archive), code:bash (mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-), code:block3 (## Archive Complete)

### Community 65 - "Community 65"
Cohesion: 0.50
Nodes (3): code:bash (mkdir -p openspec/changes/archive), code:bash (mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-), code:block3 (## Archive Complete)

### Community 66 - "Community 66"
Cohesion: 0.50
Nodes (4): 2026-03-16 — On-create idempotency: skip already-installed tools on recreate, code:bash (if ! command -v opencode &>/dev/null; then), code:bash (if ! opencode config show 2>/dev/null | grep -q "oh-my-openc), code:json ("postCreateCommand": "export PATH=$HOME/.proto/shims:$PATH &)

### Community 67 - "Community 67"
Cohesion: 0.50
Nodes (4): 2026-05-28 — Feature: Persist ~/.config tool configs across rebuilds, isolated per repo, code:block10 (.ccstatusline-settings.bak), code:jsonc ("source=config-home-${devcontainerId},target=/home/vscode/.c), code:bash (# Before rebuild (current container):)

### Community 69 - "Community 69"
Cohesion: 0.67
Nodes (3): 2026-03-15 — Dockerfile: migrate system installs to image layer, code:dockerfile (FROM mcr.microsoft.com/devcontainers/base:ubuntu), code:json ("build": {)

### Community 70 - "Community 70"
Cohesion: 0.67
Nodes (3): 2026-03-15 — Opencode and Openspec setup, code:bash (if ! command -v opencode &>/dev/null; then), code:bash (bun install -g @fission-ai/openspec)

### Community 71 - "Community 71"
Cohesion: 0.67
Nodes (3): 2026-03-16 — devcontainer hardening: extra CLI tools and scoped volume names, code:dockerfile (RUN apt-get install -y fd-find nano vim procps sudo \), code:json ("containerEnv": {)

### Community 72 - "Community 72"
Cohesion: 0.67
Nodes (3): 2026-05-13 — Fix: devcontainer on-create reliability (RTK, claude-mem, oh-my-opencode, sourced-script `exit`), code:bash (if command -v npm &> /dev/null && ! command -v node-gyp &> /), code:bash (command -v node-gyp                                         )

### Community 73 - "Community 73"
Cohesion: 0.67
Nodes (3): 2026-05-28 — Feature: Persist AI CLI logins across rebuilds, isolated per repo, code:jsonc ("source=claude-code-config-${devcontainerId},target=/home/vs), code:bash (claude         # /login (or use an API key))

### Community 74 - "Community 74"
Cohesion: 0.67
Nodes (3): 2026-05-28 — Fix: Graphify install survives Python 3.14 (clang→gcc) + stop tracking per-container pointers, code:bash (export CC="${CC:-gcc}"), code:block6 (graphify-out/.graphify_root)

## Knowledge Gaps
- **629 isolated node(s):** `init-new-project.sh script`, `extends`, `target`, `module`, `moduleResolution` (+624 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Changelog` connect `Community 32` to `Community 47`, `Community 53`, `Community 54`, `Community 55`, `Community 61`, `Community 62`, `Community 66`, `Community 67`, `Community 69`, `Community 70`, `Community 71`, `Community 72`, `Community 73`, `Community 74`, `Community 77`, `Community 78`, `Community 79`, `Community 80`, `Community 81`, `Community 82`, `Community 83`, `Community 84`, `Community 85`, `Community 86`, `Community 87`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `What You Must Do When Invoked` connect `Graphify OpenCode Plugin` to `Community 38`, `OpenCode Plugin Deps`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Why does `What You Must Do When Invoked` connect `OpenCode Config` to `Workspace Catalog Deps`, `Community 36`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **What connects `init-new-project.sh script`, `extends`, `target` to the rest of the system?**
  _629 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Base TypeScript Config` be split into smaller, more focused modules?**
  _Cohesion score 0.045454545454545456 - nodes in this community are weakly interconnected._
- **Should `Devcontainer Setup Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.08266129032258064 - nodes in this community are weakly interconnected._
- **Should `Root Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.05263157894736842 - nodes in this community are weakly interconnected._