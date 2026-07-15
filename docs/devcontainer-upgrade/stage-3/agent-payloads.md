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

## Gemini headless watchdog

The real exact-pinned Gemini launcher stays at
`/home/vscode/.payloads/gemini/bin/gemini`. The image copies
`.devcontainer/configs/gemini-watchdog` to
`/home/vscode/.local/bin/gemini`, so the normal image PATH selects the
watchdog without renaming or modifying the payload.

Interactive calls, help/version queries, `--prompt-interactive`, calls with an
explicit `--output-format`/`-o`, and calls with
`GEMINI_WATCHDOG_BYPASS=1` pass their arguments and standard streams through
unchanged. Explicit `-p`/`--prompt` calls and non-TTY stdin prompts gain
`--output-format stream-json`; a bare call passes through only when stdin is a
TTY. The watchdog validates complete bounded JSONL
events, prints only sanitized assistant text, and resets its idle deadline only
for non-empty assistant text or structurally valid `tool_use`/`tool_result`
activity. Malformed, unknown, user, init, result, and error events do not keep a
stalled process alive. Partial lines are capped before decoding, and repeated
diagnostics are suppressed after a small fixed count.

The watchdog starts the real CLI as a dedicated process group. Idle timeout or
a wrapper signal addresses the whole group, waits a bounded grace interval,
and escalates to `SIGKILL`; normal leader exit also cleans any remaining group
members. Timeout exits `124`, a missing real binary exits `127`, configuration
errors exit `2`, and normal or signal child status propagates (`128 + signal`
for signalled children). Defaults and bounded overrides are:

| Variable | Default | Purpose |
|---|---:|---|
| `GEMINI_WATCHDOG_IDLE_SECONDS` | `300` | Maximum gap between valid text/tool events |
| `GEMINI_WATCHDOG_TERM_GRACE_SECONDS` | `5` | Grace after the first group signal |
| `GEMINI_WATCHDOG_MAX_PARTIAL_BYTES` | `65536` | Maximum incomplete JSONL line |
| `GEMINI_WATCHDOG_BYPASS` | unset | Set to `1` only for explicit pass-through |

The shipped wrapper always invokes the default absolute payload path. Hermetic
tests patch a temporary wrapper copy instead of exposing payload substitution
through the runtime environment.

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
When Graphify is disabled, all three copies and its image/setup payload are
omitted. Octopus removes only its exact legacy shared-root link before exposing
each skill through one collision-checked symlink in the Codex user skill root;
setup refuses project or user shared-root collisions instead of shadowing them.

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
bun test scripts/template/__tests__/gemini-watchdog.test.ts
bun test scripts/template/__tests__/image.test.ts
bun run template:test
bun run template:typecheck
bun run template:fixtures
bunx biome check --no-errors-on-unmatched .
docker build --target development --tag devenv-stage3-agents .
```

Mutation coverage rejects a floating Context7 version, mutable Octopus commit,
bad Warp checksum, runtime Git fetch, floating MCP launcher, non-login PATH
reordering, stale installed-plugin authority, a shadowed/moved Gemini wrapper,
runtime payload substitution, missing non-TTY/process-group controls, missing
capability ownership, and duplicate or disabled Graphify discovery. Hermetic fake-Gemini tests cover all pass-through classes,
stream argument selection, sanitization, valid activity, malformed streams,
oversized partial lines, timeout escalation, missing binaries, normal/signal
status propagation, wrapper signals, and descendant cleanup.

A runtime image smoke must verify all enabled launchers, four shell modes, local
plugin manifests, persisted source repair, and the absence of shared Graphify
skill residue.

## Acceptance evidence

The reviewed implementation boundary is
`af2ac5b288c226e8ee5c86e30325ecb2ae46b45c`, based on the merged Stage 2
commit `2a2d4ab71723a608e7170d93a47622b6d92d2fac`. The committed run
`stage3-20260715t150405z-af2ac5b2` exercised ARM64 image
`sha256:9010dd4ed9ca43be94025199d47c02fff5755f5f9c522321a77963dffe33c5ff`
with 14 exact commands:

1. A cached `development_browser` build and exact image inspection.
2. The image-owned Stage 2 verifier followed by a real Playwright page launch,
   assertion, and clean close using the baked `1.59.1` headless shell.
3. All six enabled launcher paths and both local Claude plugin sources.
4. A deliberate stale Octopus/Warp installed-source mutation followed by
   local-only repair, plus shared Graphify residue absence.
5. Bash and Zsh login/non-login PATH probes.
6. The existing browser, agent, and 14-case Gemini watchdog known-bad suites.
7. Second-worktree storage measurement and a synthetic mainline-revert proof
   whose final tree equals the Stage 2 predecessor.

The warm browser build took 2,345 ms versus the Stage 2 warm build's 3,469 ms.
Second-worktree observed growth was 4,775,936 bytes versus Stage 2's 4,472,832
bytes and the Stage 0 baseline of 96,111,608 bytes. The browser preflight took
1,756 ms end-to-end, including container startup and image verification.

The machine-readable record is `evidence/stage-3-runtimes.json`; its strict
schema is `evidence/stage-3-runtimes.schema.json`, and every exact argv,
timestamp, result, and stdout/stderr SHA-256 is bound to the raw files under
`evidence/stage-3-runtimes-run/`. Reproduce the capture from a clean descendant
of the boundary with:

```sh
docker buildx build \
  --file .devcontainer/Dockerfile \
  --platform linux/arm64 \
  --target development_browser \
  --tag devenv-stage3-edaa9dd \
  --progress plain \
  --load .
bun scripts/template/collect-stage-three-evidence.ts capture \
  --image devenv-stage3-edaa9dd \
  --implementation af2ac5b288c226e8ee5c86e30325ecb2ae46b45c
```

Stage 3 proves the local devcontainer and required CI browser profile. Stage 4
owns cloud parity: its browser profile must install the same Playwright pin,
set `PLAYWRIGHT_BROWSERS_PATH`, write the same
`.devenv-playwright-version` marker under that payload root, and run the
repository's unchanged `bun run browser:preflight`. The core cloud profile must
not install a browser.

Rollback is atomic: revert the eventual Stage 3 merge commit with
`git revert -m 1 <stage-3-pr-merge-commit>`, rebuild, and recreate the
devcontainer. Do not roll back only a package pin, source commit, checksum,
skill path, MCP command, or setup script.
