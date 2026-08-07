# Stage 10C Vite WebSocket proxy safety

Tasks 15.1–15.3. Capability gate: **`vite_websocket_proxy`**. Domain word:
**`proxy`**. Predecessor: the Stage 10B merge `99acb85`.

A development proxy is the rare surface that can be **structurally perfect and
silently nonfunctional**. A string-shorthand target answers HTTP correctly and
never proxies a WebSocket. A route that rewrites its path cannot forward an
upgrade either. A server bound to the container's loopback is unreachable
through the one port that crosses the host boundary. A pinned hot-reload client
port is right for one published origin and wrong for the other. None of those
produce an error. They produce a page that loads, an application that renders,
and a socket that never opens.

`tasks.md:143` says it in one line — "preventing structurally valid but
nonfunctional proxy setups" — and that sentence is this stage's whole thesis.

## The spike came first, and its scope matters more than its result

**Finding: `Bun.serve` + `server.upgrade()` proxies a WebSocket upgrade end to
end. It works.** An upstream `Bun.serve` echo, a second `Bun.serve` forwarding,
and a real `new WebSocket` client: HTTP returned the upstream body, the socket
opened with `readyState === 1` and echoed its frame, and a control proxy that
never calls `upgrade()` correctly failed to open. A second spike confirmed
`new WebSocket(url, { headers })` and host-based upgrade refusal both work, which
is what made the hot-reload and cross-site cases *executed* rather than
simulated. No fallback to a raw `Bun.listen()` TCP relay was needed.

**That validates the HARNESS, not the build tool under Bun, and the difference
is load-bearing.** The reference implementation's measurement is about Bun's
`node:http` compatibility layer, where a proxied upgrade fires the upgrade event
and the socket handed over never flushes a byte back to the real client —
`tests/e2e-game-day-browser/harness/proxy.ts:25-30`, "verified live 2026-07-19:
identical handshake 101s under node, dead-airs under bun" — which is why its own
harness is bundled with `--target=node` and launched under `node`
(`scripts/ci/start-game-day-browser-harness.sh:117-125`). A development server's
`server.proxy` is `http-proxy` over `node:http`. That is a *different code path*
from `Bun.serve`'s native upgrade, so the spike does not clear it and **the
runtime refusal (A11) stands**. The registry declares `runtime`, and
`runtime: "bun"` beside any forwarding route is refused unless a
`wsRuntimeWaiver` carries a reason the guard prints.

## There is no spec delta, and that is the finding

Greps over `openspec/changes/portable-devcontainer-upgrade/specs/**` for `vite`,
`proxy`, `websocket`, `ws`, `hmr`, `dev server`, `handshake`, `101` and
`shorthand` return **zero** requirements naming any of them. Stage 10C is the
first stage in this program with no dedicated requirement. Its scope is set by
`tasks.md` 15.1–15.3, and what it discharges is the cross-cutting requirements
at the surface those tasks name. **The spec deltas were not amended** — the
change is approved and under implementation, and adding a requirement now
re-opens the specification pull request. The mapping is stated here instead.

| Requirement | Path | What 10C discharges |
|---|---|---|
| **Every guard proves good and bad behavior** — "a workflow, project, manifest, spec root, or dependency scan unexpectedly discovers no inputs → the guard fails distinctly instead of passing vacuously" | `specs/template-release-validation/spec.md:3-9` | 15.2's word *non-vacuous*, the `mode` reconciliation that makes an empty tree an assertion rather than a skip, and the compiler-shape check that turned a silent "found nothing" into a named refusal |
| **Reliable test execution** — "use semantic readiness plus liveness, block unintended external calls, and avoid blanket retries/timeouts/fixed sleeps" | `specs/ci-governance/spec.md:41-47` | the loopback-only proxy-target rule, and the handshake harness's no-sleep bounded readiness |
| **Generated manifests, routing, and persistence** — "a port accepts HTTP but its response does not match the service health contract → readiness fails with bounded diagnostics rather than marking the service healthy" | `specs/isolated-worktree-runtime/spec.md:43-49` | exactly `tasks.md:143`'s "structurally valid but nonfunctional", one layer up: a proxy that answers 200 on `/api` and drops every `Upgrade` |
| **Capability-complete generation** — "its generated tree contains no dead commands, empty workflows, dependencies, guards, or agent instructions for those capabilities" | `specs/template-capability-model/spec.md:15-21` | every file, script, workflow step and agent-rule sentence fenced on `vite_websocket_proxy` |

Inherited and not re-litigated: `design.md:21` Non-Goals — "Enabling
Cloudflare, Playwright, Better Auth, RHF/Zod, Sentry, **Vite proxy**, or
TanStack Start by default when the template has no corresponding generated
application."

## `ws: true` is a new point on the spectrum, and the first evadable one

`zod` (10A) was three lowercase characters matched everywhere. `@sentry/` (10B)
was an npm scope with no false positives. **`ws: true` is eight characters and a
*code shape* rather than a name**, and that changes what it is fit for.

False positives are near zero: nothing in this repository writes `{ ws: true }`,
and Bun's own WebSocket surface spells it `websocket: { … }`. **False negatives
are the finding.** `ws: true` is a whitespace-sensitive substring of *formatted
source*: `ws:true`, `ws : true`, `"ws": true` and a line-broken object all fail
to match. Biome formats to `ws: true`, so a committed formatted file matches —
but a token that a formatter setting can evade cannot be a guard's mechanism.

**Consequence:** the token is fit for `scanDisabledResidue` — which asks "did an
omitted file leak" — and unfit as the guard's rule. Every structural leg reads
the **TypeScript AST**, which is the reference's own answer to the same problem
in `scripts/routing-validate.ts`. Nothing in `proxy-contract.ts` is a
`content.includes("ws: true")`, and every needle the guard *does* search for is
assembled from parts at run time, because this guard scans a tree that contains
this guard.

A related fact that no previous stage had: **the capability *name* is not a
token here.** `vite_websocket_proxy`, and even the tool's name, may appear in
core prose without failing the residue scan. The `AGENTS.md` fence is required
by the capability-completeness scenario, not by the scanner.

## The input is a declaration, not a glob

`proxy-routes.json` sits beside `api-contract.json` and `external-writes.json`,
tab-indented with a trailing newline, `schemaVersion: 1`, validated against
`proxy-routes.schema.json` by the same `json-schema.ts`. It declares `mode`,
`configPath`, `runtime`, an optional `wsRuntimeWaiver`, `publishedContainerPort`
and `friendlyDomainPattern`, the two servers, **one shared `routes[]` table**,
and its `upstreams[]`.

**The route table is declared once and shared by both servers.** The reference's
deleted SPA configuration had three development routes and two preview routes
with disjoint keys, so a surface that worked in development disappeared in
preview. Declaring one table makes alignment a property of the declaration
rather than a rule somebody has to remember — and the guard still compares the
*rendered* configuration's two proxy objects, because a hand edit can
reintroduce the drift the registry cannot express.

**`mode` is what makes every rule below it non-vacuous.** Three shapes are
derived: a build-tool configuration file at any depth (its *presence* is what
marks a frontend, which is `check-deploy-build-env.ts:470`'s own predicate), a
direct build-tool dependency in the catalog or `devDependencies`, and a source
file declaring a proxy table. In `skeleton` mode the guard asserts, positively,
over the whole tracked tree, that none exist, and it records how many files it
read — a scan that read nothing would report `skeleton` forever.

## The eleven legs

1. **Registry** — present, parses, matches its schema, and is the only one.
2. **Mode reconciliation** — declared against derived, both directions, before
   any leg below runs.
3. **Wiring** — `proxy:check` in `package.json`, the fenced `ci.yml` step, the
   ownership rules, the `validate.ts` call.
4. **Configuration identity** — an ordinary in-tree file, not a symlink, exactly
   one hard link, canonicalizing to the declared path. A guard that reads a
   symlink or a hardlinked twin validates a file it does not own.
5. **AST shape** — no `export =`, exactly one *effective* default export so a
   commented-out decoy never counts, an object literal. Both the bare-object and
   `defineConfig(object)` forms are accepted, and the unambiguous-binding rule
   fires **only** when the helper is actually used.
6. **Route shape** — object form, `ws`/`changeOrigin`/`secure` stated
   explicitly, loopback targets that a declared upstream binds (in both
   directions), no `rewrite` beside a forwarded upgrade, no insecure `https`.
7. **Dev/preview alignment** — same paths, same targets, same `ws` values.
8. **Host validation** — no wildcard, no empty entry, no `all`, no
   `allowedHosts: true`; the loopback family plus the friendly domain suffix.
9. **Reachability** — `strictPort` pinned, a wide bind, and exactly one process
   on the published container port.
10. **HMR and asset origin** — both `null`, with a pinned client port refused and
    a client port equal to the published port refused by name.
11. **Renderer drift and the runtime policy** — the declared configuration must
    equal the rendered bytes exactly, and `runtime: "bun"` beside a forwarding
    route is a waivable refusal.

## The HMR rule is the inverse of the advice everybody gives

Two origins are browser-visible **at once**, and this repository publishes both
by contract:

- direct — `http://127.0.0.1:<8080 + offset>` (`scripts/worktree/env.sh:503-510`;
  `template-parameters.toml:60` `always_publish_direct_url = true`)
- friendly — `http://<workspace>.<project>.localhost` on port **80**
  (`template-parameters.toml:53`; `scripts/worktree/manifest.sh:223-225`)

A pinned `hmr.clientPort` is a single number. It can match at most one of them,
and it silently breaks the other: the page loads, the application renders, and
the reload socket dials a port nothing is listening on. With the override left
`null` the client derives the socket URL from `location`, which is correct for
**both**. `server.origin` carries the same defect one layer over, for asset URLs.

**The reference is the evidence.** `docs/DEVELOP.md:665-666` gives exactly the
pinning advice — "If HMR can't connect behind the proxy, set
`server.hmr.clientPort`" — and it is **stale**: no application there has a
`server` block at all, and `scripts/dev/Caddyfile:29-36` answers the documented
path with a 503. Advice nobody executes is advice nobody found wrong.

## The wide bind and the strict allowlist are one argument

A WebSocket handshake is **not** subject to CORS. The browser sends the request
and attaches the user's ambient cookies whatever any `Access-Control-*` header
says, so a cross-site page can open an authenticated socket unless the server
checks the `Origin`/`Host` itself — the reference's own
`apps/gateway/src/cors.ts:109-140` `isTrustedWsOrigin` names it Cross-Site
WebSocket Hijacking and implements exactly that check.

So `allowedHosts: true` is not a convenience, it is one word that deletes the
defense, and it is refused in the registry *and* in the configuration. The bind
must still be wide, because a server on the container's loopback is unreachable
through `-p 127.0.0.1:X:8080`. Neither half is optional, and the executed
harness proves both: an allowed host opens and an attacker host is refused.

## Nothing here needs a dev server, a browser or a socket to the outside

The guard is hermetic: it reads a committed declaration and the AST of whatever
configuration that declaration names. The handshake harness binds three
listeners, all on `127.0.0.1:0` with the port injected, and talks to nothing but
loopback. Every wait is bounded, so the failure mode this whole stage exists for
— a hang, not an error — presents as a failed assertion rather than a suite that
never finishes.

## Archaeology: the reference's live tree has no dev-server proxy at all

**All four tracked `vite.config.ts` files in the reference carry exactly `base`,
`build`, `environments`, `resolve` and `plugins`. Not one has a `server` or
`preview` block.** Verified negatives across its whole tracked tree:
`allowedHosts` 0 hits, `hmr\s*:` 0, `server.origin` 0, `changeOrigin` 0,
`rewrite:` 0, `secure: false` 0, `ws\s*:\s*true` 0 code hits,
`Switching Protocols` 0.

The invariant this stage is built on survives in exactly one place, and it must
be cited as **archaeology and never as live reference code**:
`.claude/worktrees/matrix-expect-url/apps/speed-math-web/vite.config.ts:115-117`
— "Object form (not the string shorthand) so `ws: true` forwards the WebSocket
upgrade… **A string target never proxies WS**." That file is in an **untracked
worktree**. All four `*-web` SPAs were deleted by the Start migration and are
gone from `HEAD`. A later reader who goes looking for it in the tracked tree
will not find it.

The one live citation is better than the archaeological one:
`apps/prediction-market-start/src/ws-client.ts:123-136` — "In standalone mode,
connect directly to the backend (**Vite can't proxy WebSocket upgrades with path
rewriting**)." That is a named upstream casualty of the `rewrite` + `ws` rule,
in a file that still exists.

## Findings recorded, not acted on

Three real facts about `scripts/worktree/**` were found and deliberately **not**
fixed here, because nothing in this repository exercises them while
`services = []`. The next stage inherits the facts rather than rediscovering
them.

1. **`http_code_is_healthy` rejects `101`.** `scripts/worktree/doctor.sh:1385-1390`
   accepts only `2xx|3xx`, so a pure-WebSocket listener answering `101 Switching
   Protocols` would FAIL `route.direct`. This is a genuine, currently-latent
   defect. It is out of scope here because `services = []` makes it
   unexercisable, and fixing it would be a change to a file no test in this
   stage can drive.
2. **`body_matches` has no WebSocket expectation.**
   `scripts/worktree/services.sh:226-249` accepts exactly
   `http-2xx | http-2xx-html | json-status-ok` and dies on anything else. A
   `websocket-101` expectation would be a `template-parameters.schema.json` enum
   change, a `services.sh` change and a `worktree-contract.ts` change — with no
   subject, which is precisely the vacuity this stage exists to prevent.
3. **The worktree Caddy snippet upgrades WebSockets implicitly and that is
   fine.** `scripts/worktree/manifest.sh:223-225` emits a bare `reverse_proxy`,
   the same shape as the reference's `scripts/dev/Caddyfile:20-42`, whose
   WebSocket path works. Worse, `doctor.sh:1336,1367-1375` asserts the snippet's
   exact bytes and `worktree-contract.ts` pins the same string, so "make the
   upgrade explicit" is a three-file change to make a working thing look more
   working.

## No core rule, and the absence is deliberate

Unlike 10B, **every artifact and every rule in this stage is gated**. 10B's core
half existed because its spec sentence was not capability-qualified — "credential
presence alone MUST NOT authorize a remote write" is about *any* write, and this
repository performs one. Stage 10C has **no spec sentence at all**, and this
repository performs no HTTP proxying, runs no development server and binds no
socket outside tests. A core rule about proxies in a tree with no proxy is
vacuous by construction, which is the exact failure
`specs/template-release-validation/spec.md:3-9` names.

The one candidate was examined and rejected: a `ci-contract.ts` rule forbidding a
workflow step from binding a server to `0.0.0.0`. The workflows here contain no
server at all; it would be a rule with no subject. Recorded so the next reader
does not assume it was forgotten.

## Validation

```sh
bun run proxy:check
bun run ci:check && bun run forms:check && bun run telemetry:check
bun run toolchain:check && bun run image:check && bun run browser:check
bun run cloud:check && bun run openspec:check && bun run rules:check
bun run worktree:check && bun run affected:check && bun run graph:check
bun run template:validate && bun run template:typecheck && bun run typecheck
bun test scripts/template/__tests__ > /tmp/suite.log 2>&1; echo $?   # never | tail
bun test --rerun-each=2 scripts/template/__tests__/proxy.test.ts     # no leaked listener
bash scripts/worktree/selftest.sh && bash .codex/cloud/selftest.sh
bunx biome check
git diff --stat .devcontainer/                                       # MUST be empty
git diff --stat bun.lock                                             # MUST be empty
```

`bun test … | tail -N` reports **tail's** exit code. Redirect to a file and read
`$?`; this masked a real failure for two commits in Stage 10B.

## Live evidence capture

```sh
# 1. Push the branch and open the pull request. ci.yml triggers on `push` only for
#    the default branch, so a feature branch produces no run until a PR exists.
# 2. Wait for the required gate to go green at the implementation head. Poll with
#    `gh run view <id> --json status,conclusion`; never `gh run watch`.
# 3. Capture on the HOST. Like the two contract stages before it, this one owns no
#    container-only binary: the guard is a standalone script over node:, Bun and
#    the catalog-pinned compiler, and the only external tools are git, gh, python3
#    and shasum.
bun scripts/template/collect-stage-ten-c-evidence.ts capture \
  --implementation <implementation-sha> --gate-run <run-id>
```

Seventeen exact commands with sha256-bound raw logs; ten of them are the refusal
matrix run one leg at a time. `template:validate` is deliberately **not** a
captured command: it aggregates every hermetic contract including this record, so
run before the record exists it fails, and run after it can never seal its own
log. Never rebase or amend after a capture — the record asserts the boundary is
an ancestor of `HEAD`.

## Scope

**Added:** `proxy-routes.json`, `proxy-routes.schema.json`,
`scripts/template/proxy-contract.ts`, `scripts/template/validate-proxy.ts` (all
four gated on `vite_websocket_proxy`);
`scripts/template/__tests__/proxy.test.ts` and its two fixture modules
(`proxy-route-workspaces.ts`, `websocket-harness.ts`);
`scripts/template/stage-ten-c-evidence.ts`,
`collect-stage-ten-c-evidence.ts`, `__tests__/stage-ten-c-evidence.test.ts`;
`evidence/stage-10c-proxy.{json,schema.json}` and `-run/`; this README.

**Modified:** `scripts/template/validate.ts`;
`scripts/template/__tests__/template.test.ts` (residue cases),
`forms.test.ts` and `telemetry.test.ts` (the `capabilityInventory.absent` pins);
`.github/workflows/ci.yml` (one fenced step); `package.json`;
`template-ownership.json`; `AGENTS.md` + mirrors; `CHANGES.md`; `tasks.md`.

**Unchanged, deliberately:** `.devcontainer/**`; `scripts/worktree/**` including
`contract.toml`; `template-parameters.toml`; all three
`fixtures/template/*.toml`; `bun.lock`; `package.json#workspaces.catalog` and
`#devDependencies`; `scripts/template/ci-contract.ts`;
`scripts/template/toolchain.ts`; `ci-matrix-universes.json`; `moon.yml`;
`.moon/workspace.yml`; `apps/`; `libs/`; `openspec/changes/…/specs/**`.

## Rollback

`git revert -m 1 <stage-10c-pr-merge-commit>` — atomic and **order-independent**.
`rollback.outsideTheTree` is empty: there is no repository variable, no
branch-protection change and no operator step. (Stage 7's recorded list was also
empty, but its branch-protection change made its rollback order-dependent in
fact — "empty" is a claim about the field, not automatically about ordering.)

The reverted tree carries none of the four added paths and the implementation
tree carries all of them, proved by a synthetic merge in the sealed record.
`vite.config.ts` stays reserved and absent either way.

**Neither direction costs a container rebuild**, and that is a decision rather
than luck — see deviation 17. `rollback.containerRebuildRequired` is sealed
`false` and the schema pins it `false` with the reason;
`repository.devcontainerFilesChanged` is the measured `0` that backs it.

## Decisions and deviations

Recorded because the next stage inherits them.

1. **Two real bugs were found by the tests, and one fix landed outside its "own"
   commit.**
   - `validateRouteShape` called `new URL(route.target)` unguarded, so a
     malformed target made the guard **throw** instead of reporting — suppressing
     every other finding beside it. Fixed in commit 2 with safe
     `targetPort`/`targetScheme` helpers.
   - **`typescript()` checked resolution and not shape.** In a rendered project
     `require("typescript")` returned something that was *not* the compiler, so
     every AST leg answered "found nothing" — the exact **vacuous pass** this
     guard exists to refuse, and the class the whole program hunts. The shape
     check landed in **commit 6**, a `test(…)` commit, because the commit-6
     rendered-fixture test is what found it; rewriting four already-green commits
     to relocate a four-line fix was the worse trade. The rendered-fixture test
     now asserts **both** verdicts: the distinct failure before install, and
     green after.
2. **Dev/preview alignment is enforced against the configuration AST, not the
   registry.** The registry declares one shared `routes[]`, so registry-side
   alignment holds by construction and a rule there would be tautological. The
   AST leg catches a hand-edited file, which is the only way the drift can
   actually reappear.
3. **"Upgrade-bearing path" was made decidable** as "the target's scheme is `ws:`
   or `wss:`". The plan's phrasing had no predicate a guard could evaluate. The
   missing-`ws` refusal therefore lives in the configuration AST leg, where `ws`
   can genuinely be absent; the registry schema requires it.
4. **`activeContract()` carries a `wsRuntimeWaiver`.** A11's refusal would
   otherwise fail every fixture from commits 2–3 the moment commit 4 landed.
   Dedicated tests cover refusal-without-waiver, toleration-with, and the
   stale-waiver refusal in both directions.
5. **The `defineConfig` helper test drives `readEffectiveConfig` directly.**
   Commit 4's drift leg pins exact bytes, so the helper form cannot coexist with
   a rendered file. The AST leg and the drift leg answer different questions and
   the test targets the right one.
6. **The hop-by-hop `Connection` rule is proved as a function, not as a socket.**
   Bun's native `server.upgrade()` owns the handshake headers itself — which is
   precisely *why* the harness uses it instead of hand-rolling a forwarder, and
   why the reference's hazard cannot arise here by construction.
   `buildProxyForwardHeaders` is real (it runs on the HTTP forward path) and is
   asserted in both modes, with the naive stripper as the executed
   counter-example.
7. **Every render check runs post-`git add`.** `render-fixture.ts` enumerates via
   `git ls-files --stage`, so untracked new files are invisible to the renderer
   and a "the capability's files are missing from `full`" result is an artefact
   of staging rather than of ownership. Not a plan deviation, but it invalidated
   one gate run mid-flight.
8. **Four sealed refusal sentences had to become literal fragments.** The
   evidence module binds diagnostics by substring, and four of the chosen
   sentences are built in the test by template interpolation
   (`${CONFIG_PATH}`, `${WORKTREE_CONTRACT_PATH}`, `${REGISTRY_PATH}`), so the
   full sentence never appears literally. Found by the collector's own
   self-validation before it wrote anything, which is the check working. The
   sealed strings are now distinctive literal fragments of the same refusals.
9. **The generated evidence record is biome-formatted after capture**, exactly as
   Stage 10B's was. The digests bind the *logs*, not the JSON, and the validator
   reads the record through `Bun.file().json()`, so formatting is irrelevant to
   every assertion. Noted because a re-capture always produces an unformatted
   file that `lint-staged` then rewrites.
10. **Every evidence leg points at one suite.** 10B split its legs across three
    suites because two of its rules were core and could not be exercised from a
    file naming a capability token. This stage adds no core rule at all (see
    above), so there is no unfenced behaviour for a core suite to exercise.
11. **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`**, which
    has not been a capability since PR #21 and which nothing validates. Left
    exactly as 8B, 10A and 10B left it, and noted again rather than fixed by
    accident while editing `capabilityInventory.absent`.
12. **`fixture-manifest.json` names `vite_websocket_proxy`** in the disabled
    renders as part of the omission reason. `scanDisabledResidue` skips that file
    by name. Doubly benign here, because the capability *name* is not a signature
    token for this capability — do not "fix" it by removing the skip.
13. **The residue path signature was widened without editing the Stage 0
    string.** `capabilitySignatures.vite_websocket_proxy.paths` was exactly
    `["vite.config.ts"]`, matched against a path with no glob, so
    `apps/web/vite.config.ts` and a root `vite.config.mts` both slipped through.
    `**/vite.config.*` **joins** the reserved entry rather than replacing it, so
    the reservation stays legible in the diff and in the sealed record.
14. **Ship three tasks, not more.** `tasks.md` declares 15.1–15.3 and 15.3
    bundles fixtures, rollback, evidence, rules, docs and `CHANGES.md` into one
    line. The third consecutive stage where the declared count is smaller than
    the surrounding stages' shape, and the smallest yet. Nothing was invented.
15. **The capture runs on the host**, for the same reason 10A's and 10B's did:
    this stage owns no container-only binary, so a container hop would add a
    moving part and prove nothing.
16. **The pull request was opened before the live capture.** `ci.yml` triggers on
    `push` only for the default branch, so a feature-branch push produces no run
    at all. The capture sits at the implementation boundary, and the evidence and
    documentation commits that follow keep that boundary an ancestor of `HEAD`.
17. **This stage costs NO container rebuild, and that is the deliberate
    inversion of Stage 10B deviation 18.** `scripts/worktree/contract.toml:45`
    lists `.devcontainer` — the whole directory — as a
    `definition_fingerprint_inputs` entry, and the Dockerfile bakes that
    directory in as a definition stamp, so 10B paid a full rebuild for a
    comment-only edit to an example file the image never reads.

    The one thing in this stage that would have touched it is **adding a
    dev-server or HMR port** to `forwardPorts`/`portsAttributes`. That was
    refused, and the reason is functional before it is procedural: exactly one
    port crosses the container boundary
    (`.devcontainer/devcontainer.json:8-13` publishes
    `127.0.0.1:${localEnv:DEVENV_PUBLISHED_HOST_PORT}:8080` and nothing else),
    `forwardPorts` is an editor convenience the file itself says so at `:173`,
    and the worktree runtime does not use it. A development server on 5173 would
    be invisible to the host whatever `forwardPorts` said. The reference reached
    the same conclusion in prose: `docs/DEVELOP.md:611-618` — "Only the Caddy
    port crosses that boundary… do not forward the game web/worker ports."

    Because nothing under `.devcontainer/**` is touched, the planned commit order
    holds: **evidence is commit 7 and documentation is commit 8**, the Stage 9
    and 10A order. 10B had to swap them. `git diff --stat .devcontainer/` was
    checked on every commit of this branch, and the sealed record carries the
    measured `devcontainerFilesChanged: 0` rather than the promise.
18. **Stage 10D depends on this capability.** `template-parameters.toml:117`
    declares `tanstack_start = ["cloudflare_workers", "vite_websocket_proxy"]`,
    so 10D cannot render without it. That is why the registry and the renderer
    are genuinely usable rather than a placeholder, and why anything the
    registry could model was modelled rather than left to a convention a README
    describes. The registry ships `mode: "skeleton"`; **flipping it to `active`
    with a real generated `vite.config.ts` is 10D's move**, and
    `renderViteConfig()` already emits a configuration that needs no dependency.
