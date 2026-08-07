# Gemini CLI Guidelines

Shared conventions for every agent are in @AGENTS.md. The regions below are generated from it by `bun run rules:sync`; edit the canonical file, never these.

<!-- capability:start openspec -->
## OpenSpec Lifecycle Ownership

<!-- generated:start openspec-lifecycle -->
- `openspec/config.yaml` is the initialization marker and the only OpenSpec file this template owns. `openspec/changes/**` and `openspec/specs/**` are project-owned. Never run `openspec init`: it writes a second, non-experimental command family under different names and injects a managed block into `AGENTS.md` and `CLAUDE.md`.
- The CLI is the repository-local pinned one, and nothing else. A globally installed `openspec` validates a different schema and prints the same green summary while doing it, so `openspec:check` requires a binary inside this repository's `node_modules` whose `--version` equals the `@fission-ai/openspec` catalog entry.
- Set `OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1` and `CI=true` on every invocation. Telemetry is opt-out in this CLI, and a guard must never depend on the network to answer.
- Never trust `openspec archive`. It returns 0 after "Aborted. No files were changed.", and it applies the delta specs to `openspec/specs/**` BEFORE it checks whether `archive/<date>-<name>` exists — then returns 0 when it does, leaving a half-applied tree reported as a success.
- Archive only through `bash scripts/openspec/archive.sh --change <name>`. The wrapper owns every precondition, the UTC destination pre-check, the post-state verification, the rollback, the re-validation, the commit and the push. It is host-only and deliberately has no package script.
- Archive dates are UTC, because the CLI stamps `new Date().toISOString()`. A local date is wrong for several hours a day.
- `openspec:check` runs unconditionally in the `ci` job. `openspec/**` classifies as documentation in the affected-selection oracle, so a lifecycle guard in a lane a selection can narrow would be skipped by exactly the pull requests that change a change.
- The Claude command and skill artifacts under `.claude/commands/opsx/` and `.claude/skills/openspec-*/` are generated from the pinned CLI and must never be hand-edited. Regenerate them with `bun run rules:sync`; `bun run rules:check` fails on drift.
- Codex receives no OpenSpec artifacts at all. The root `AGENTS.md` is its entire surface, and the guard fails if any `.codex/**` file names one.
- Run `bun run openspec:check` after changing a change, a spec, an archive entry, the wrapper, or the CLI pin.
<!-- generated:end openspec-lifecycle -->
<!-- capability:end openspec -->

<!-- capability:start graphify -->
## graphify

<!-- generated:start graphify-rules -->
This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- Never `git add graphify-out/` in a feature commit. Refresh the graph only in a dedicated `chore(graphify)` commit on the default branch — a `pre-commit` hook rejects `graphify-out/graph.json` staged alongside non-graphify files.
<!-- generated:end graphify-rules -->
<!-- capability:end graphify -->
