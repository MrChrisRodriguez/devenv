# Graph Report - .  (2026-05-27)

## Corpus Check
- 94 files · ~63,082 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 326 nodes · 313 edges · 30 communities (21 shown, 9 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.88)
- Token cost: 87,023 input · 2,716 output

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
- [[_COMMUNITY_VS Code Extensions|VS Code Extensions]]
- [[_COMMUNITY_Husky Shell Lib|Husky Shell Lib]]
- [[_COMMUNITY_Husky Hooks|Husky Hooks]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 38 edges
2. `compilerOptions` - 19 edges
3. `compilerOptions` - 12 edges
4. `settings` - 12 edges
5. `catalog` - 10 edges
6. `compilerOptions` - 8 edges
7. `ghcr.io/devcontainers/features/common-utils:2` - 7 edges
8. `containerEnv` - 7 edges
9. `rules` - 6 edges
10. `features` - 6 edges

## Surprising Connections (you probably didn't know these)
- `CI Workflow` --references--> `Moon Tasks`  [INFERRED]
  .github/workflows/ci.yml → .moon/tasks.yml
- `Opsx Archive Command` --references--> `OpenSpec Config`  [INFERRED]
  .opencode/commands/opsx-archive.md → openspec/config.yaml
- `OpenCode Plugin` --references--> `Graphify Skill`  [EXTRACTED]
  .opencode/package.json → .opencode/skills/graphify/SKILL.md
- `Claude Code Guidelines` --references--> `Agent Guidelines`  [EXTRACTED]
  CLAUDE.md → AGENTS.md
- `Moon Toolchain` --conceptually_related_to--> `Moon Workspace`  [EXTRACTED]
  .moon/toolchains.yml → .moon/workspace.yml

## Communities (30 total, 9 thin omitted)

### Community 0 - "Base TypeScript Config"
Cohesion: 0.05
Nodes (43): compileOnSave, compilerOptions, allowJs, allowSyntheticDefaultImports, allowUnreachableCode, allowUnusedLabels, alwaysStrict, declaration (+35 more)

### Community 1 - "Devcontainer Setup Scripts"
Cohesion: 0.08
Nodes (18): load_secrets_file(), is_plugin_configured(), version_ge(), setup-biome.sh script, setup-claude-octopus.sh script, setup-claude.sh script, setup-claude-warp.sh script, setup-codex.sh script (+10 more)

### Community 2 - "Root Package Manifest"
Cohesion: 0.08
Nodes (25): commitlint, extends, rules, devDependencies, @biomejs/biome, @commitlint/cli, @commitlint/config-conventional, @fission-ai/openspec (+17 more)

### Community 3 - "Devcontainer JSON Config"
Cohesion: 0.08
Nodes (24): build, dockerfile, _comment_secrets, containerEnv, COLORTERM, DEVCONTAINER, DEVCONTAINER_PROJECT, POWERLEVEL9K_DISABLE_GITSTATUS (+16 more)

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
Cohesion: 0.15
Nodes (13): label, onAutoForward, label, onAutoForward, label, onAutoForward, label, onAutoForward (+5 more)

### Community 9 - "Worker TS Config"
Cohesion: 0.17
Nodes (11): compilerOptions, jsx, lib, noEmit, noPropertyAccessFromIndexSignature, noUnusedLocals, noUnusedParameters, types (+3 more)

### Community 10 - "Workspace Catalog Deps"
Cohesion: 0.17
Nodes (12): @biomejs/biome, dotenv, @fission-ai/openspec, husky, opencode-ai, tsx, @types/bun, @types/node (+4 more)

### Community 11 - "Claude Code Settings"
Cohesion: 0.20
Nodes (9): Changelog, args, command, env, DEFAULT_MINIMUM_TOKENS, hooks, PreToolUse, mcpServers (+1 more)

### Community 12 - "Skill & Plugin Manifests"
Cohesion: 0.25
Nodes (3): Graphify Skill, OpenCode Plugin, OpenSpec Propose Skill

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

## Knowledge Gaps
- **223 isolated node(s):** `init-new-project.sh script`, `extends`, `target`, `module`, `moduleResolution` (+218 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `customizations` connect `VS Code Customizations` to `Devcontainer JSON Config`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `init-new-project.sh script`, `extends`, `target` to the rest of the system?**
  _223 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Base TypeScript Config` be split into smaller, more focused modules?**
  _Cohesion score 0.045454545454545456 - nodes in this community are weakly interconnected._
- **Should `Devcontainer Setup Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.07899159663865546 - nodes in this community are weakly interconnected._
- **Should `Root Package Manifest` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._
- **Should `Devcontainer JSON Config` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `VS Code Customizations` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._