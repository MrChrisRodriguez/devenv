# Stage 10D TanStack Start safety

Tasks 16.1–16.3. Capability gate: `tanstack_start`. Domain word: `start`.
Predecessor: the Stage 10C merge `4859e086be715206c7a83ec089b7475d40a274e3`.

Everything this stage adds is gated on `tanstack_start`. The one core edit is
the Cloudflare pin family in `scripts/template/toolchain.ts`, and it is fenced
on `cloudflare_workers` — the capability this one *depends on* — for a reason
this document spends a section on.

## The defects of this stack are the quiet kind

Three of them, and each has a named upstream casualty.

**A `compilerOptions.types` entry that does not resolve fails `tsc` with TS2688
and leaves `vite build` completely green**, because esbuild ignores `types`
entirely. The reference implementation hit exactly this, wrote it down as a
HARD constraint of its migration spike, and fixed it in a named commit.

**A build-time variable missing from a deploy job's environment compiles to the
literal `undefined`.** The bundle ships, the Worker boots, nothing throws, and
every truthiness-guarded consumer just stops rendering. There is no runtime
signal anywhere — not in telemetry, not in the Worker logs, not in a smoke test
that only asserts a 200. That is how two links and a notification inbox went
missing in production in the repository this stage mirrors.

**A public prefix that disagrees with the served asset directory returns 404 in
the built Worker alone.** The reference wrote the reason into its own
configuration: rewriting URLs in HTML does not move the physical directory the
asset binding serves, so the development server stays perfectly green while the
production artefact 404s every rewritten URL.

None of the three produces an error where anyone is looking. That is the thesis.

## `tsconfig.start.base.json` was broken, and nothing could tell

Since Stage 0 the file has carried:

```jsonc
"types": ["@tanstack/react-router/globals"],
```

`@tanstack/react-router` exports no `./globals` subpath. Modern releases
register route types through declaration merging (`declare module` on the
router's `Register` interface), not through an ambient global type library. So
`tsc` fails on that entry with **TS2688**.

It went unreported for four stages for two compounding reasons:

1. `vite build` never reads `types`. Only the typechecker does.
2. **No project in this repository extends the file.** `tsconfig.json` includes
   `apps/**`, `libs/**` and `scripts/**` and extends `tsconfig.base.json`;
   `template:typecheck` compiles `scripts/template` only; `apps/` holds a
   `.gitkeep`. A configuration that compiles zero files is green forever.

The reference documented the identical trap in its own tree, in a proof config
that matched **zero** files under `tsc --listFiles`: *"it was compiled by
nothing in the root typecheck chain, and a cast could kill the shared browser
mid-process with every check green."*

That is why the commit-2 proof **runs the compiler**. The test writes a
temporary workspace with no `node_modules` at all — the repository base, the
repaired base, and one project that genuinely `extends` it — and invokes the
catalog-pinned `tsc` through `Bun.spawn` with a bounded deadline:

| Run | Result |
|---|---|
| The repaired base | exit `0`, empty output |
| The reserved entry reintroduced | `error TS2688: Cannot find type definition file for '@tanstack/react-router/globals'`, non-zero |
| Restored | exit `0` again |
| A stale concrete `include` entry, alone | `error TS18003`, non-zero |

A build-based proof would have been green in every one of those directions. A
JSON assertion would have proved only that somebody typed the right string.

## The repair, and the two rules that close the class

The base now `extends "./tsconfig.base.json"` like `tsconfig.worker.base.json`
and `tsconfig.lib.base.json` do. The standalone version silently dropped
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noPropertyAccessFromIndexSignature`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch` and
`useUnknownInCatchVariables` while calling itself strict — and `tasks.md:153`
asks for a **strict** shared base. What it overrides is now four deliberate
lines: `types: []`, the DOM libraries, `jsx`, and `allowImportingTsExtensions`.

The guard reads the **effective** options through the whole extends chain,
because a base that inherits a strict set states nothing at all in the file you
are reading.

`app.config.ts` leaves `include`. It was the entry file of a build generation
this stack replaced with `vite.config.ts`; the reference has zero of them and
its own base still carries the stale entry. The generalized rule: **every
concrete filename in `include` must correspond to an artefact some declared
application produces.** Directory entries and globs are not concrete filenames
and stay legal. When a stale concrete entry is the *only* matching pattern the
compiler exits TS18003 rather than typechecking nothing, which the suite
executes.

Two rules close the class rather than the instance:

- **Every `types` entry must resolve** — and the package root is deliberately
  *not* a resolution fallback, because the defect is a subpath the package does
  not export, so accepting the root would answer "found it" for the exact string
  that made the compiler fail.
- **Any entry in `forbiddenTypes` is refused on its name**, whether it resolves
  or not. Removing the one bad entry fixes this file and leaves the class open.

Where no module resolver is available at all the guard emits a **notice**, not a
pass and not an error: a blind is not a miss.

`baseUrl` is deliberately *not* re-checked here. `toolchain.ts:609-618` already
refuses it in every `tsconfig*.json` in the tree and Stage 1's evidence seals
the diagnostic; this base has always been inside that glob. The guard prints a
notice naming the core rule instead of putting two sentences on one defect.

## The first capability with declared dependencies

`template-parameters.toml:117` reads `tanstack_start = ["cloudflare_workers",
"vite_websocket_proxy"]`. That single line is the most consequential thing in
this stage, and it forced a rule the program had not needed before.

`parameters.ts` calls `validateCapabilityDependencies` on every fixture's
capability map and on `[capabilities.defaults]`, so **no fixture and no default
set can enable this capability without both dependencies** — the parse fails
first. A static `import "./proxy-contract"` from `start-contract.ts` would
therefore resolve in every render that contains `start-contract.ts`.

It is still refused, and the reason is that the guarantee is a **generation-time
guarantee that expires at generation.** `template-parameters.toml` is
`renderPolicy: omit`, so the file declaring the dependency edge is not in the
generated project and nothing downstream re-validates it. A project that deletes
`proxy-routes.json` and `scripts/template/proxy-contract.ts` — an entirely
ordinary thing to do when it decides it does not want a development proxy —
turns a static import into a **module-load crash**. `start:check` would not
report a diagnostic; it would fail to start. A file read reports
`start: proxy-routes.json is absent, so …` and every other leg still runs.

**The rule, in one sentence:** *a gated contract module may import core or
same-capability modules only; a declared capability dependency earns the right
to read a dependency's committed registry file with a named notice when it is
absent, and nothing more.*

The precedent already existed one stage back: 10C reads
`scripts/worktree/contract.toml` — gated on `devcontainer`, which is not even a
declared dependency of `vite_websocket_proxy` — as data with a named absence
notice. This stage does the identical thing one dependency edge closer.

## The Cloudflare half is a different kind, and lands in a different place

`tasks.md:153` names two unrelated deliverables in one line: a TypeScript base
gated on `tanstack_start`, and a Cloudflare package family gated on
`cloudflare_workers`. They live behind **different fences**, in **different
files**, in **different modules** — one gated, one core.

There is no `cloudflare-contract.ts` to import: that capability's rules live
*inside* core `toolchain.ts`, fenced inline. So the family alignment is a **core
edit under a `cloudflare_workers` fence**, and it is correct that it does not
live in the gated Start module: the family must hold whenever Cloudflare is
enabled *whether or not* anything of this stack is, and `cloud.toml` — Cloudflare
on, Start off — is precisely the fixture that proves it. The sealed record
measures that directly: `buildToolFamilyPresent` is `true` in the `cloud` render
and `false` in `minimal`.

This is also the requirement this stage discharges. `specs/reproducible-toolchain-image/spec.md:14-19`
enumerates five family members — *"Wrangler, workerd, Miniflare, the Workers
Vitest pool, or **the Vite plugin**"* — and `toolchain.ts` owned all five.
**`vite` itself was in none of them**, and `@cloudflare/vite-plugin` *is* the
Vite plugin the scenario names, whose entire job is to be loaded by a `vite` the
guard did not govern.

Three legs close it:

1. **`vite` joins the lock-resolution singletons**, conditionally on the
   plugin's catalog presence. A second build-tool resolution is the moment the
   plugin and the runtime it drives stop being one family.
2. **The plugin's OWN declared peer range is read out of `bun.lock` and
   reconciled** against the resolution the lock chose. The authority is the
   package's metadata rather than a number typed into a guard, so the rule
   cannot go stale against an upgrade. Measured today: the plugin declares
   `vite: "^6.1.0 || ^7.0.0 || ^8.0.0"` and `vite` resolves exactly once at
   `8.1.4`. The family is coherent as committed and the rule is green on its
   first run.
3. **A floating or ranged spec for `vite` or any `@vitejs/*` package in any
   workspace manifest is refused.**

Leg three is the hole the reference's own family guard concedes in writing:

> **SCOPE, STATED HONESTLY:** this guard governs the three catalog-coupled
> Cloudflare packages above. It does NOT ban a floating `"latest"` repo-wide,
> and 19 such specs remain (`vite`, `vitest`, …). … **do not read this guard's
> green as covering it.**

and whose migration spike wrote the recommendation down without acting on it:
*"a future vite major could break Start with a zero-line diff. Consider
catalog-pinning vite when Start goes to production."* The divergence is already
live there: `vite "8.1.4"` in four applications against `"^8.0.16"` in one
library, and `@vitejs/plugin-react "6.0.3"` against **`"latest"`** in two more.

**And `bun.lock` does not move.** Catalog-pinning is what the reference
recommends and it is one line plus an install — but it would put a build-tool
pin in a template that runs no build and ship that version to every generated
project that never installs it. The rule closes the same hole, it is enforceable
in a project that *does* install the tool, and this is the fourth consecutive
stage with an empty lockfile diff. `lockfileChanged: false` is sealed and
asserted against `git diff` between the predecessor and the boundary.

## No generated application, for the fourth time and a new reason

`apps/` and `libs/` stay empty; the registry ships `mode: "skeleton"` with
`apps: []`. `design.md:21` names TanStack Start in its Non-Goals by name. But
16.2 says "**in the generated fixture**", so the collision needs an answer
rather than a restatement.

Three structural reasons, only the third of which is new to this stage:

1. A minimal application of this stack needs `@tanstack/react-start`,
   `@tanstack/react-router`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`
   and `@cloudflare/vite-plugin` as *direct* dependencies — six catalog entries
   and a large install, in a program where three consecutive stages shipped with
   an empty `bun.lock` diff.
2. It would be a Moon project, so it would need a `ci-matrix-universes.json`
   entry — a file gated on `moon_affected_selection`, a **different** capability,
   with no comment syntax to fence a JSON array element. In the legal combination
   `tanstack_start=true, moon_affected_selection=false` the registry would name a
   project that does not exist.
3. **The reference's own harness does not use the application's source.** It
   builds, then drives the *built* worker under the pinned command-line tool
   against a *verified* `dist/server/wrangler.json`. So the portable proof is a
   contract over the artefact, not the artefact — which is exactly what this
   stage ships.

So 16.2 is discharged in four executed forms, none of which installs anything:

| 16.2 clause | How it is executed here |
|---|---|
| typecheck | the catalog-pinned compiler over a synthetic project that genuinely extends the repaired base, with no `node_modules` |
| test | the mutation matrix, twelve legs captured one at a time |
| build | the built-artefact contract, driven against a synthetic `dist/server/wrangler.json` whose shape the registry declares |
| smoke one SSR read plus one browser mutation through the intended proxy | two `Bun.serve` listeners on `127.0.0.1:0`, one origin, real `fetch` |

## One server render read and one browser mutation, executed

The proxy is the **single browser-visible origin**, because that is what
production serves: the apex router dispatches the server-rendered document AND
proxies the mutation prefix, so the browser sees one origin where migrated
routes render and mutations are same-origin. A harness with two origins would be
testing a topology nobody ships.

Four assertions carry it:

- A document `GET` returns 200 with the three declared headers and increments
  the server-side render counter **by exactly one**, read *after* the case and
  *before* teardown. "The handler saw nothing" and "the handler was already
  gone" produce the same empty answer.
- A `POST` mutation over the same origin reaches the upstream, arrives with
  every identity-override header **stripped** — the reference measured that an
  injected one *would* be honored, silently passing a path production rejects —
  and does **not** move the render counter again. That is the zero-refetch
  property, and it is what makes "server render read" mean something: the read
  happened on the server, and it did not happen again because of the client.
- A non-read method on the document path returns **405 naming what it allows**,
  carrying the cache directive on that class too.
- `HEAD` is answered with GET semantics minus the body.

**Framing headers are recomputed and never copied.** Copying describes a body
that no longer exists — the upstream body arrives already decompressed and the
proxy rewrites it besides — which in the reference made *every* browser fetch
die with a content-length mismatch on the very first document. The proof is the
header set the proxy builds, because the server runtime recomputes on the way
out and would mask the defect end to end; the end-to-end case then asserts the
recomputed length matches the rewritten body byte for byte.

Every listener binds `127.0.0.1:0` with its port injected, both are stopped in a
`finally`, and one case asserts the origin is unreachable once the case that
opened it returned. `start.test.ts` is run twice in one session
(`--rerun-each=2`, 86 passing) to prove no case leaks a listener into the next,
which an ephemeral bind makes silent otherwise.

**What this deliberately does not prove is hydration.** See the findings section.

## The reserved residue token could not fire

Stage 0 reserved `@tanstack/start` as this capability's token. **That package
does not exist.** The real packages are `@tanstack/react-start` and
`@tanstack/solid-start`, and neither string contains the reserved one — it was
the pre-1.0 name. Verified two ways: `bun.lock:407` lists both real names among
`better-auth`'s optional peers, and `resolvedOccurrences(lock, "@tanstack/react-start")`
returns `[]`.

So the reservation could not catch the one thing it was written for: a
downstream project that installs the framework and then disables the capability.

`@tanstack/` — eight characters, an npm scope, the `@sentry/` shape 10B proved
free of false positives — **joins** the reserved string rather than replacing it,
so the Stage 0 reservation stays legible in the diff and in the sealed record.
The committed test asserts both halves: the scope fires on a real dependency and
the reserved string does not. `start:check` is the second token, verified at zero
occurrences in the tracked tree before it was reserved.

**And the token this stage must never add is the bare word `start`.**
`capability:start` is the opening fence marker in `ci.yml`, `toolchain.ts`,
`AGENTS.md`, `render-fixture.ts` and every gated file in the repository;
`startup_timeout_seconds` is in `template-parameters.toml:131`;
`tsconfig.start.base` is in `AGENTS.md:66`. A bare-word token would fail every
render of every profile, immediately.

## Nothing here needs an application, a bundler or a worker runtime

Every leg is hermetic. The guard reads a committed declaration, the JSON shape
of whatever worker configuration that declaration names, and the syntax tree of
the tracked tree. The one external binary it uses is the catalog-pinned
compiler, reached through `createRequire` with a **shape** check rather than a
resolution check — 10C's deviation #1 is the reason: in a rendered project
`require("typescript")` returned something that was not the compiler, and every
syntax leg answered "found nothing", which is the vacuous pass this whole program
hunts. An unresolvable or wrong-shaped compiler is a **named error**, never a
skipped leg, and the rendered-fixture test asserts both verdicts: the distinct
named failure before `bun install`, and green after.

## Findings recorded, not acted on

- **There is no route-tree staleness guard, here or in the reference.** A grep
  for regeneration, drift or staleness over the reference's `scripts`,
  `.github`, `moon.yml` and application manifests returns **zero hits**, in a
  repository with four production applications of this stack. What exists
  instead reads the committed file as a contract: one application has a route-tree
  contract test asserting the exact route set, and two integrity checks hash the
  file against a committed digest. This template cannot regenerate what it does
  not install, and installing the generator means changing `bun.lock`. The
  registry models the reference's own substitute — a declared route inventory —
  and the staleness gap is recorded here rather than invented as a rule.
- **Hydration is not proved, and cannot be here.** A hydration mismatch means
  the SSR HTML and the first client render disagreed, and detecting it needs a
  browser. `playwright` is a different capability and `browser:check` is gated on
  it. The reference's own console gate matches five patterns — `/hydration
  failed/i`, `/text content does not match server-rendered html/i`, `/server
  rendered html didn.?t match the client/i`, `/hydration mismatch/i`, and
  `/minified react error #(418|423|425)\b/i` — and treats a match as fatal at
  teardown. Recorded for whoever enables that capability. The registry's
  `ssr.determinism` block exists for the same reason: a locale or timezone drift
  between server and client is a classic mismatch source, and it presents as an
  unrelated flake rather than an error.
- **`capabilitySignatures.cloudflare_workers.paths` reserves `wrangler.toml`,
  and an application of this stack writes `wrangler.jsonc`.** All four reference
  applications do; `ls apps/*-start/wrangler.toml` matches nothing. The reserved
  path therefore does not match the file a real project writes. **Not widened
  here**: that is a cross-fence edit to a file whose entire purpose is to keep
  ownership legible, and Stage 11 §18.1 owns the signature sweep.
- **`tsconfig.base.json:31` carries `"@confiador/*"` — a source-project
  identifier in a core file.** `tasks.md:169` (18.1) requires a
  source-identifier scan before release. Flagged for Stage 11, not fixed here.
- **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`**, which has
  not been a capability since PR #21 and which nothing validates. 8B deviation
  #19, 10A #12, 10B #16 and 10C #11 all left it and noted it; so does this one.
- **`fixture-manifest.json` names `tanstack_start`** in the disabled renders as
  part of the omission reason. `scanDisabledResidue` skips that file by name;
  10A #10, 10B #17 and 10C #12 recorded the same. Not a leak.

## The correction to Stage 10C's sealed record

**10C's README recorded, in its own deviation #18, that flipping
`proxy-routes.json` to `active` with a real generated `vite.config.ts` is "10D's
move". It is not, and this stage deliberately does not do it.**

The reason is structural rather than a preference. A `vite.config.ts` for this
stack **must** import `@cloudflare/vite-plugin` and the framework's own Vite
plugin, and the plugin order is load-bearing — the reference's own configuration
says so in as many words. 10C's `renderViteConfig()` emits an import-free
`export default { … }`; it can express a proxy table and it **cannot** express a
plugin array, and a configuration without those two plugins is not a
configuration for this stack. Shipping one would drag six packages into
`bun.lock` and put a build into a template with no application.

So 10D declares its surface in its **own** registry and leaves 10C's registry
byte-identical. The route a real application would use is declared *by id* in
`start-surface.json` and reconciled when `proxy-routes.json` is present.

This paragraph exists because two records that disagree is the failure mode 10B
spent a commit correcting: a reader who finds only one of the two documents will
believe whichever they opened first.

## Scope

**Added (gated on `tanstack_start`):** `start-surface.json`,
`start-surface.schema.json`, `scripts/template/start-contract.ts`,
`scripts/template/validate-start.ts`.

**Added (ungated tooling and tests):**
`scripts/template/__tests__/start.test.ts`,
`scripts/template/__tests__/fixtures/start-workspaces.ts`,
`scripts/template/__tests__/fixtures/start-ssr-harness.ts`,
`scripts/template/stage-ten-d-evidence.ts`,
`scripts/template/collect-stage-ten-d-evidence.ts`,
`scripts/template/__tests__/stage-ten-d-evidence.test.ts`,
`evidence/stage-10d-start.{json,schema.json}` and
`evidence/stage-10d-start-run/`.

**Modified:** `tsconfig.start.base.json` (the repair);
`scripts/template/toolchain.ts` (the `cloudflare_workers`-fenced family legs);
`scripts/template/__tests__/toolchain.test.ts`; `scripts/template/validate.ts`;
`scripts/template/__tests__/template.test.ts`; `.github/workflows/ci.yml` (one
fenced step in the `ci` job); `package.json` (`start:check`);
`docs/devcontainer-upgrade/stage-0/template-ownership.json`; `AGENTS.md` and its
mirrors; `CHANGES.md`; `tasks.md`.

**Unchanged, deliberately:** `template-parameters.toml`; all three fixture
definitions; `bun.lock`; `package.json#workspaces.catalog` and
`#devDependencies`; `.devcontainer/**`; `proxy-routes.json`,
`proxy-routes.schema.json` and `scripts/template/proxy-contract.ts`;
`scripts/worktree/**`; `ci-matrix-universes.json`; `moon.yml`;
`tsconfig.base.json`, `tsconfig.json`, `tsconfig.worker.base.json`,
`tsconfig.lib.base.json`; `apps/`; `libs/`; every spec delta.

**Ownership.** Four `artifactRules` entries gated on the capability; explicit
`copy` `ownershipRules` entries for the two `scripts/template` files inserted
*before* the `scripts/template/**` omit catch-all, and the two root registries
above the final `*` catch-all; the capability's **first ever** `packageRules`
entry stripping `start:check`; four paths added to `capabilitySignatures` beside
the Stage 0 `tsconfig.start.base.json` reservation; two tokens added beside the
Stage 0 string; and `tanstack_start` leaves `capabilityInventory.advertisedOnly`,
because "advertised with nothing generated behind it" stops being true the
moment four gated files ship.

## Requirements this stage discharges

No spec delta names TanStack Start, Start, SSR, hydration, streaming or a route
tree — the only mention anywhere in the change directory outside `tasks.md` is
`design.md:21`. The mapping below is a mapping, not an amendment; the change is
approved and under implementation, and adding a requirement now would re-open
the specification pull request.

| Requirement | Path | What 10D discharges |
|---|---|---|
| Coupled dependency families are atomic | `specs/reproducible-toolchain-image/spec.md:14-19` | `vite` becomes a lock-resolution singleton of the Cloudflare family and its resolution is reconciled against the plugin's own declared peer range |
| Exact tool and dependency ownership | `specs/reproducible-toolchain-image/spec.md:3-8` | a floating `vite` / `@vitejs/*` spec in any workspace manifest is refused — the exact hole the reference concedes in writing |
| Every guard proves good and bad behavior | `specs/template-release-validation/spec.md:3-9` | the mode reconciliation that makes an empty tree an assertion rather than a skip, and the executed compiler proof over a base nothing compiled |
| Capability-complete generation | `specs/template-capability-model/spec.md:15-21` | every file, script, workflow step and agent-rule sentence fenced on `tanstack_start` |
| Reliable test execution | `specs/ci-governance/spec.md:41-47` | the executed harness: loopback-only, `:0`-bound, no `sleep`, counters read before teardown |

## Validation

Run on every commit of this stage:

```
bun run start:check          # from commit 1
bun run toolchain:check      # every commit; the family legs from commit 3
bun run ci:check forms:check telemetry:check proxy:check image:check
bun run browser:check cloud:check openspec:check rules:check
bun run worktree:check affected:check graph:check
bun run template:validate
bun run template:typecheck
bun test scripts/template/__tests__        # redirected to a file; $? read directly
bun test --rerun-each=2 scripts/template/__tests__/start.test.ts
bun run typecheck
bash scripts/worktree/selftest.sh
bash .codex/cloud/selftest.sh
bunx biome check
```

Plus, on every commit: render `minimal`, `cloud` and `full`; YAML-parse each
workflow; `scanDisabledResidue` green on all three; render twice and diff
byte-for-byte; and three diffs that must not lie —

- `git diff --stat .devcontainer/` — **empty**, every commit.
- `git diff --stat bun.lock` — **empty**, every commit.
- `git diff --stat package.json` — non-empty only in commit 1, and only the
  `scripts` block. If the catalog or `devDependencies` moved, the family was
  implemented as a pin instead of a rule.

Final tree: 505 tests across 30 files, 0 failures; every guard green; all three
renders byte-identical across two passes with zero residue findings.

**`bun test … | tail -N` reports *tail's* exit code.** Redirect to a file and
read `$?` directly. 10B lost two commits to this.

**Every render check runs post-`git add`.** `render-fixture.ts` enumerates via
`git ls-files --stage`, so untracked new files are invisible to the renderer and
"the capability's files are missing from `full`" is an artefact of staging. This
stage hit it on commit 1 (deviation 1).

## Live evidence capture

```
# 1. Push the branch and open the pull request. ci.yml triggers on `push` only
#    for the default branch, so a feature branch produces no run until a PR
#    exists.
# 2. Wait for the required gate to go green at the implementation head. Poll
#    with `gh run view <id> --json status,conclusion`; never `gh run watch`.
# 3. Capture on the HOST. Like the three contract stages before it, this one
#    owns no container-only binary: the guard is a standalone script over node:,
#    Bun and the catalog-pinned compiler, and the only external tools are git,
#    gh, python3 and shasum.
bun scripts/template/collect-stage-ten-d-evidence.ts capture \
  --implementation <implementation-head-sha> --gate-run <run-id>
```

The capture refuses a dirty tree, refuses a boundary whose application surface
differs from `HEAD`, refuses any change under `.devcontainer/`, refuses any
change to `bun.lock`, and **self-validates the whole record against its own
schema before it writes a byte**. `template:validate` is deliberately not a
captured command: it aggregates every hermetic contract *including this record*,
so run before the record exists it fails, and run after it can never seal its own
log.

Nineteen commands, twelve of them the refusal matrix one leg at a time. The
sealed diagnostics are **literal fragments** rather than whole sentences —
almost every refusal is assembled with template interpolation, so a complete
sentence would bind the record to a string no file contains. That is 10C's
deviation #8, inherited by design.

## Rollback

```
git revert -m 1 <stage-10d-pr-merge-commit>
```

`outsideTheTree` is empty: no repository variable, no branch-protection change,
no container payload, no advertised port. The revert is order-independent, and
`rollback.containerRebuildRequired: false` is **pinned `const: false` in the
schema** with its reason and backed by a measured `devcontainerFilesChanged: 0`.

The rollback is proved by synthetic merge: `git revert -m 1` over a synthetic
merge of the predecessor and the boundary reproduces the Stage 10C tree exactly.
The additive half shows the reverted tree carries none of the four added paths
while the implementation tree carries all four.

**One half is asymmetric, and the record proves it separately.**
`tsconfig.start.base.json` is a Stage 0 artefact this stage **repairs**, not one
it creates — so it is not in `addedPaths`, and reverting *restores* the version
whose `types` entry names a subpath the router package does not export.
`repairedTsconfigRestored` is sealed `true` and checked by reading both trees'
copies of the file.

## Decisions and deviations

1. **Renders are invisible to untracked files (found on commit 1).**
   `render-fixture.ts` enumerates via `git ls-files --stage`, so the first render
   of `full` omitted all four new files and `start:check` failed inside it with
   "Module not found". This is 10C's deviation #7 recurring; the fix is to
   `git add` before every render check, and it is now in the validation section
   above.
2. **`app.config.ts` dropped from `include`, diverging from the reference.** The
   reference still carries the stale entry. Parity with a stale line is not
   parity with a decision, and the executed TS18003 case shows what the entry
   costs when it is the only matching pattern.
3. **`globMatches` corrupted its own output, and the bug is worth naming.** The
   first implementation chain-replaced glob tokens with regex — `**/` became
   `(?:.*/)?` — and then replaced `?` with `[^/]`, which rewrote the `?` inside
   the expansion the previous pass had just produced. The result was a glob that
   silently matched **nothing**, which is the most dangerous possible failure for
   a rule whose job is to find an exclusion. It is now a character scanner. The
   lesson generalizes: an expansion that contains the token you are about to
   replace cannot be produced by a chain of `String.replace`.
4. **The `types`-resolution leg deliberately excludes the package root.** The
   defect is a *subpath* the package does not export, so a package-root fallback
   would answer "found it" for the exact string that made the compiler fail. This
   makes the rule stricter than a naive implementation and it is the point.
5. **The `namespace-drift` test was split into three in the evidence commit's
   boundary.** The plan's command list names `namespace-drift`, `route-tree` and
   `router-options` as separate legs, and one test covering all three rule
   families would have made three sealed legs run one identical command. The
   split gives each leg a real, independently-runnable proof, and it is a
   test-granularity change with no behaviour attached. The implementation
   boundary was amended to carry it before anything was pushed or captured.
6. **A missing module resolver produces a notice, not a pass and not an error.**
   In a workspace with no `node_modules` at all, "does this type entry resolve"
   has no answer — a blind is not a miss. The guard says so out loud rather than
   reporting that it found nothing wrong, which is the same discipline the absent
   registry notice uses.
7. **The evidence record's forbidden-entry check parses rather than searches.**
   The first version substring-searched `tsconfig.start.base.json` for
   `app.config.ts` and found it — in the comment explaining that it had been
   removed. A file that documents what it no longer contains cannot be validated
   by substring. Caught by the collector's own self-validation before it wrote
   anything, which is exactly what that self-validation is for.
8. **`gatedPaths` is compared sorted.** The render probe reports what it found in
   path order, and this capability's four paths do not happen to be *declared* in
   path order — unlike the previous stage's, which did by coincidence. Caught by
   the same self-validation.

## What this stage did not do

- It shipped **no application**, no `vite.config.ts`, and no new package.
- It added **no CI job** — one fenced step in the existing `ci` job. Adding
  `moon-graph` in 8A turned a green historical capture into a reported
  fabrication and cost a validator repair; `ci-gate`'s `needs` list is sealed as
  `gateNeeds` in every record from Stage 7 onward.
- It added **no advertised port** and touched **nothing** under `.devcontainer/`.
  The port this stack's worker runs on under the pinned development command is
  `8787`, already advertised under `cloudflare_workers` — the capability this one
  requires — so every profile that can enable Start already advertises it.
- It changed **no spec delta**, **no fixture definition**, and **no lockfile
  byte**.
