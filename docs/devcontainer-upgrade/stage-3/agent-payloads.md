# Stage 3 agent payload contract

This slice makes every enabled global agent tool image-owned and removes the
network-dependent first-run setup that previously cloned plugins or invoked a
floating Context7 package. Capability rendering is part of the contract: the
minimal fixture omits Context7, Octopus, and Warp completely, while the full
fixture includes their image stages, launchers, setup, configuration, tests,
and rules.

## Exact authorities

| Payload | Image authority | Verification |
|---|---|---|
| Codex | `CODEX_VERSION=0.144.4` | complete Bun global payload and relative launcher |
| Gemini | `GEMINI_VERSION=0.50.0` | complete Bun global payload and relative launcher |
| Claude | `CLAUDE_VERSION=2.1.210` | architecture-specific SHA-256 before executable install |
| Graphify | `GRAPHIFY_VERSION=0.9.16` | isolated uv tool payload and launchers |
| ccstatusline | `CCSTATUSLINE_VERSION=2.2.23` | complete Bun global payload and relative launcher |
| Context7 MCP | `CONTEXT7_VERSION=3.2.3` | complete Bun global payload; committed MCP settings invoke `context7-mcp` directly |
| Claude Octopus | commit `f42f34a8f9a7ee5b9324e8b2d23159878c132b02` | archive SHA-256 `64104245973939c1508babb4503bef56fdf455ffe57370758a8d07fbc0866263` |
| Warp Claude plugin | commit `58c823da195346a7e6645fd2d9484d0e38db6bc2` | archive SHA-256 `054607a80b7eb5571615925a6991082091d063b4eac591499177716421f76557` |

Docker arguments are the only version/source authorities. Renovate discovers
package versions and immutable Git commits in isolated, non-automerge changes;
the image build intentionally fails until every affected checksum is reviewed.

## Runtime boundary

On-create scripts verify launchers and payload markers. Octopus and Warp use
Claude's plugin command only against the verified local payload, with a
30-second bound. No runtime script may clone Git, add an HTTP marketplace, run
`bun install -g`, invoke floating `bunx`, or repair an image payload.
Persisted marketplaces must identify the image payload as a local directory,
and each installed plugin cache must contain the same commit/checksum source
marker as the image. Setup replaces stale marketplace registrations or plugin
caches from the local payload without contacting the network.

Codex discovers Graphify only from `.codex/skills/graphify`; Claude and Gemini
retain their agent-specific copies. `.agents/skills/graphify` is forbidden.
Octopus exposes each skill through one collision-checked symlink in the Codex
user skill root, and setup refuses an existing different owner instead of
shadowing it.

Every shell mode uses the same precedence:

1. `/workspace/node_modules/.bin`
2. `~/.proto/shims`
3. `~/.proto/bin`
4. `~/.local/bin`

The contract checks Bash/Zsh login and non-login sources, editor `remoteEnv`,
and on-create setup. Image smoke should additionally execute all four shell
forms against the selected image.

## Verification

```bash
bun install --frozen-lockfile
bun run image:check
bun test scripts/template/__tests__/image.test.ts
bun run template:test
bun run template:typecheck
bun run template:fixtures
bunx biome check --no-errors-on-unmatched .
docker build --target development --tag devenv-stage3-agents .
```

Mutation coverage rejects a floating Context7 version, mutable Octopus commit,
bad Warp checksum, runtime Git fetch, floating MCP launcher, non-login PATH
reordering, stale installed-plugin authority, and duplicate Graphify discovery.
A runtime image smoke must verify all enabled launchers, four shell modes, local
plugin manifests, persisted source repair, and the absence of shared Graphify
skill residue.

Rollback is atomic: revert the eventual Stage 3 merge commit with
`git revert -m 1 <stage-3-pr-merge-commit>`, rebuild, and recreate the
devcontainer. Do not roll back only a package pin, source commit, checksum,
skill path, MCP command, or setup script.
