# Stage 10A Shared schemas, forms, and API contracts

This repository ships no application. `apps/` and `libs/` contain a `.gitkeep`
each, there is no server, no route and no OpenAPI document. So the natural
implementation of "make contract drift block deployment" — scan the tree for
violations — would find nothing, report green, and keep doing that forever. A
rule whose normal outcome is silence is not a rule.

Stage 10A therefore ships **contracts-as-guards over a committed declaration**.
`api-contract.json` states what this project's contract surface *is*; the guard
reconciles that declaration with the tree in both directions before any rule
runs, and then runs nine rules over the surface the declaration names.

```sh
bun run forms:check      # registry, mode, wiring, ownership, and the seven legs
bun run ci:check         # now also refuses a delivery lane that skips the guard
```

Nothing under `.devcontainer/**` changed, so adopting this stage costs **no
container rebuild**, and nothing about it lives outside the tree: no repository
variable, no branch-protection change, no operator step.

## `zod` is three lowercase characters, and that shaped everything

`capabilitySignatures.rhf_zod.tokens` has carried `zod`, `react-hook-form` and
`@hookform/resolvers` since Stage 0, and the anti-residue scan is
`content.includes(token)` over **every file** of a render whose capability is
off. `zodResolver`, `zod/v4` and `@hookform/resolvers` all contain a token.

That single fact decided the shape of the stage:

- the registry, its schema and both guard modules are `artifactRules`-gated on
  `rhf_zod`, and all four are declared capability signature **paths**, so a
  leaked copy is *reported* rather than merely absent;
- `forms:check` is a signature **token** and a `packageRules` script, so the
  script name cannot appear anywhere in a render that disabled the family;
- the workflow step that runs it sits inside a `capability:start rhf_zod` fence;
- `ci-contract.ts` and `biome.jsonc` are **core** — copied into every project —
  so neither may name the capability, the script or the package family. The
  delivery rule names a job **id**; the Biome override uses generic globs.

Capital-`Z` `Zod` does not match the lowercase token. That escape hatch is used
in prose and never relied on in code.

## The input is a declaration, not a glob

`api-contract.json` sits beside `ci-matrix-universes.json`, tab-indented with a
trailing newline and `schemaVersion: 1`, and is validated against
`api-contract.schema.json` by the same `json-schema.ts` that validates
`template-parameters.toml`.

```json
{
	"mode": "skeleton",
	"schemaPackages": [],
	"openapi": null,
	"policySeam": null,
	"formModules": [],
	"serverParsers": [],
	"evolution": []
}
```

A second registry anywhere in the tree is a named refusal, exactly as a second
matrix universe registry is: two files claiming to be the authority means
neither is.

### `mode` is what makes every rule below it non-vacuous

Before any leg runs, the guard derives the tree's actual state and compares it
with the declared one **in both directions**. The derivation looks for four
shapes, each the visible consequence of a shared schema surface existing:

| shape | what it is |
|---|---|
| `reserved-path` | a file under `libs/forms/`, the root Stage 0 pre-reserved |
| `schema-import` | a file importing the schema library, in any of five spellings |
| `form-binding` | a file binding a form resolver |
| `generated-artifact` | a file whose first lines carry a generated banner |

In `skeleton` mode the guard asserts, positively and over the whole tracked
tree, that none of them exist — and that the registry declares no surface
either. In `active` mode it asserts the converse. A tree that grows a surface
while the registry still says `skeleton` fails by name and says which file to
look at. The guard never "found nothing and passed".

### The tree is parsed, not grepped

Import specifiers come out of the TypeScript AST through the catalog-pinned
compiler, so all five spellings count: `import … from`, `export … from`,
`import x = require(…)`, a dynamic `import(…)` and a bare side-effect import.
A regex over TypeScript is a substring search wearing a contract's clothes, and
the reference implementation's `ts-morph` would have changed `bun.lock` — which
this program checks per commit.

The compiler is reached through `createRequire(import.meta.url)`, lazily and
memoized, because Bun's ESM namespace for the CJS `typescript` bundle exposes
only `version` and `versionMajorMinor`. A compiler that cannot be resolved is a
**named error**, never a skipped leg.

### Two needles are assembled at run time

The guard scans the tracked tree for a form-resolver binding and for a
generated-artifact banner, and it contains both strings itself. They are built
from parts instead of written out, because the alternative is a path exemption
and a path exemption is a hole somebody eventually widens. The banner scan is
anchored to a file's **first lines** for the same reason: it lets this README,
the changelog and the guard's own tests discuss a banner in prose without
becoming instances of one.

Every walk prunes `.git/`, `node_modules/`, `tmp/`, `dist/` and `graphify-out/`.
`template:fixtures` renders into `tmp/` and a rendered fixture carries a full
copy of this tree, so a walk into one would invent a schema package no commit
owns; `graphify-out/` is tracked here, so a generated knowledge graph would
otherwise stand in front of a rule about generated artifacts.

## The nine legs

1. **Registry** — present, parses, matches its schema, and is the only one.
2. **Mode reconciliation** — the declared state against the derived one, both
   ways, before anything below runs.
3. **Wiring and ownership** — the four gated paths exist, `forms:check` runs the
   entrypoint, the step is unconditional and fenced and lives in the `ci` job,
   and the ownership registry gates every path, strips the script and declares
   every signature.
4. **Browser safety** — an **allowlist**, never a denylist. A denylist over
   server-only modules is a list of the mistakes somebody already made, and the
   first import nobody thought of ships a database driver into a browser bundle.
   A declared package may name the schema library, whatever else it declares,
   and relative paths that resolve *inside its own root* — `../../shared/src/x`
   looks local and is not. Zero files under a declared root is a distinct
   failure.
5. **Drift** — run the declared generator, read the post-state *immediately and
   before any restore*, put the tree back on every exit path, then decide. A
   drifted repository is never left rewritten by the guard that noticed it. The
   binary is injectable through `FORMS_GENERATE_BIN`.
6. **Evolution** — additive-only against `git merge-base`, plus the wire-leniency
   rule. No base and a brand-new artifact are **notices**, never silent passes.
7. **Parallel response types** — the reference's four categories, over a covered
   surface derived from the artifact's own `paths`.
8. **Inline authorization** — the banned denial messages are *read from* the
   declared seam module; a branch that reads a caller role bit and answers with
   a refusal is refused, in both arms of a ternary, with resolution stopping at
   a seam call.
9. **Forms and server parsers** — every resolver binding is registered with an
   empty exemption set, bound fields must exist in the declared schema, and a
   declared parser must import the shared schema, answer with the declared
   envelope, separate a malformed body from a schema rejection, and declare the
   client mapping that makes the rejection visible.

### Deployment skew is a policy gate, not a wire protocol

The reference implementation has **no** skew mechanism: no `426`, no
`X-App-Version`, no contract hash — verified by search, not assumed. What holds
a deploy window together there is policy: additive-only evolution, lenient
error-envelope parsing, and nobody strict-parsing a live response in a browser.

Two halves of that are mechanical and this stage makes them so. The published
artifact may not carry `additionalProperties: false` on a response body, and a
change to the artifact is diffed against the merge base: a removed field, a
removed operation, a newly required field or a changed type is refused unless
`evolution[]` names that operation with a staged `add`, `migrate` or `remove`.
The proof is a two-version fixture — the artifact an old client was generated
from, and the one the server now publishes.

### Biome must not touch generated output

The compare is byte-for-byte, so a reformatted artifact is a *correct* artifact
whose gate is red, and the failure names the file rather than the formatter.
`biome.jsonc` turns off the linter, the formatter **and** the assist actions —
an assist action rewrites a file just as thoroughly as a format does. The rule
is required in both modes: one that only ran once an artifact existed is a rule
the first generated artifact ships without.

## Where the step lives is a constraint, not a preference

One **fenced step** in the existing `ci` job. No new job.

- The cost is fixed and does not scale with the project graph, so it belongs
  beside the OpenSpec lifecycle guard rather than in the lane a selection can
  narrow. A contract gate in a narrowable lane would be skipped by exactly the
  pull requests that change a contract.
- Adding `moon-graph` in Stage 8A turned a green historical capture into a
  reported *fabrication* for Stage 7 and cost a validator repair. A stage that
  adds no lane cannot re-open that wound, and the sealed record asserts
  `addedJobs: 0`.

"Every deployment path" is then a **core** rule in `ci-contract.ts`: a job whose
id matches `deploy|release|publish|promote`, or that declares an `environment:`,
must reach the contract-guard job through `needs` — transitively, because
funnelling through the aggregate gate is the correct shape. A delivery job in a
workflow that declares no contract job cannot satisfy that and is named as the
hole. No such job exists here, which is exactly why the rule is written now: a
rule added alongside the first delivery job is a rule written by the person who
wanted the job.

## Validation

```sh
bun run forms:check                                    # the whole contract
bun run ci:check                                       # including the delivery rule
bun test scripts/template/__tests__/forms.test.ts      # 20 cases
bun test scripts/template/__tests__/ci.test.ts         # 17 cases
bun run template:validate                              # aggregates both, plus the record
bun run template:fixtures /tmp/out                     # three renders, residue-scanned
```

## Live evidence capture

```sh
# 1. Push the branch and open the pull request. ci.yml triggers on `push` only for
#    the default branch, so a feature branch produces no run until a PR exists.
# 2. Wait for the required gate to go green at the implementation head.
# 3. Capture on the HOST. Unlike the moon and OpenSpec stages this one owns no
#    container-only binary: the guard is a standalone script over node:, Bun and
#    the catalog-pinned compiler, and the only external tools are git and gh.
bun scripts/template/collect-stage-ten-a-evidence.ts \
  capture --implementation <boundary-sha> --gate-run <run-id>
```

Twelve exact commands with sha256-bound raw logs under
`evidence/stage-10a-api-contract-run/`. The collector validates the record
against its own schema and semantic rules **before** it writes, and a committed
suite re-validates it and fabricates each claim in turn.

Six of the twelve are the refusal matrix run one leg at a time. That is not
decomposition for tidiness: a suite-wide green says the *file* passed, and what
the record has to be able to say is that a named rule was exercised. Each leg's
`-t` filter is the test's own name, so a renamed or deleted test makes the
capture fail rather than quietly cover nothing — and a committed test asserts
that every filter still names a test that exists.

`template:validate` is deliberately **not** a captured command. It aggregates
every hermetic contract *including this record*, so it cannot appear in the
record it validates: run before the record exists it fails, and run after it can
never seal its own log. The required CI lane runs it instead.

## Scope

- **No seed package.** `apps/` and `libs/` stay empty. A `libs/forms` package
  would be a moon project, so it would have to appear in
  `ci-matrix-universes.json` — a file gated on a *different* capability with no
  comment syntax to fence it — and the combination `moon_affected_selection=true,
  rhf_zod=false` would then render a registry naming a project that does not
  exist. `design.md` forbids it by name, and 8A and 8B both recorded the same
  decision.
- **`libs/forms/**` stays reserved and empty**, and is gated anyway, so the first
  downstream project to use it is governed from its first commit rather than
  from the commit somebody noticed. A reservation is where an artifact *would*
  live, not a promise to create one. The `playwright` capability ships guards and
  no application in exactly the same way.
- **No generator.** This repository has nothing to render, so a shipped renderer
  would be a module that generates nothing. `openapi.generate` is a declared
  command the guard *runs*.
- **No new capability.** `capabilityName` is a closed enum of nineteen and
  `capabilityMap` requires all nineteen with `additionalProperties: false`;
  worse, the contract artifact is rendered *from* the schema registry in the
  reference, so gating the response half on a second flag would split one
  authority in two.
- **`[capabilities.defaults].rhf_zod` stays `false`** and no fixture file
  changed. That is what makes 13.4's "validate generated enabled/disabled
  fixtures" a validation task rather than an authoring one.
- **No wire-level skew protocol.** See above; inventing one for a template would
  ship an unproven protocol.

## Rollback

```sh
git revert -m 1 <stage-10a-pr-merge-commit>
```

Atomic and **order-independent**: there is no repository variable, no
branch-protection change and no operator step, so `rollback.outsideTheTree` is
empty. Note that an empty list is a claim about the recorded field and not about
ordering in general — Stage 7's list was empty too, yet its rollback *is*
order-dependent because of the branch-protection change it made. Nothing under
`.devcontainer/**` changed, so the revert costs no container rebuild, and
`libs/forms` stays reserved and empty either way.

The proof is a synthetic merge followed by `git revert -m 1`, producing a tree
identical to the Stage 9 predecessor and carrying none of the four paths this
stage adds while the implementation tree carries all of them.

## Decisions and deviations

Recorded because the next stage inherits them.

1. **`scripts/template/json-schema.ts` became a core `copy` ownership entry.**
   `forms-contract.ts` ships downstream with the registry *and* its JSON Schema,
   and the registry is validated through `json-schema.ts` — but that module fell
   to the `scripts/template/**` omit catch-all, so a rendered project would have
   received a schema nothing could validate and a static import that fails to
   load. The module is pure, ungated and token-free.
2. **`forms-contract.ts` imports `typescript`**, beyond the planned "`node:*` and
   `./toolchain` only". The compiler API is mandated by the same plan; the rule
   it bends is about *template* modules, and a gated guard may not import another
   capability's module. `./toolchain` turned out unnecessary and is not imported.
3. **The fence assertion is conditional on `template-parameters.toml` existing.**
   The renderer deletes capability markers along with the blocks it keeps, so a
   generated project's step is correctly unfenced; asserting the fence
   unconditionally failed the `full` render. The parameter file is the marker the
   workflow's own browser lane already switches on.
4. **The drift gate compares in-memory bytes rather than running `git diff`.** It
   works in a non-git tree (a rendered fixture), cannot be confused by staged
   versus unstaged state or by a dirty `graphify-out/`, and makes
   restore-on-every-exit-path structural instead of a step somebody can forget.
   The post-state is still read immediately after the generator returns.
5. **`envelope` is the error *code* a parser answers a schema rejection with**
   (e.g. `VALIDATION_ERROR`), not a shape name. A template cannot assert a
   runtime envelope shape statically; the checkable projection is the code plus a
   distinct malformed-body marker plus a declared `clientMapping`.
6. **The evolution base is `FORMS_MERGE_BASE` → `origin/HEAD` → `origin/main` →
   `main`.** A template cannot know a downstream project's default branch and
   `template-parameters.toml` does not ship. Unresolved base and new-artifact are
   **named notices** on a new `inspectFormsContract()` channel printed by the
   entrypoint; `validateFormsContract()` still returns only errors.
7. **Two of the planned commit-5 mutations live in `forms.test.ts`.** "The guard
   step removed from `ci`" and "the fence removed on one side only" are
   assertions of the *gated* module, and `ci-contract.ts` may not name
   `forms:check`. `ci.test.ts` carries the two core-rule mutations instead.
8. **`biome.jsonc` gained a comment block**, which required a quote-aware JSONC
   comment stripper in the guard: a `//` inside a glob is a glob, not a comment.
9. **The parallel-type category names are assembled at run time** even though
   they are only emitted and never searched for. Cheap, and consistent with the
   rule about needles a guard contains.
10. **`fixture-manifest.json` contains the substring `zod`** in the disabled
    renders, as the omission reason `disabled capabilities: rhf_zod`. That file
    is the render's own report and `scanDisabledResidue` skips it by name — it
    already had to, for `playwright`. Every other file of both renders is clean,
    and the sealed record counts them.
11. **The residue proof covers five signature paths, not four.**
    `libs/forms/**` was pre-declared by Stage 0 and is now gated, so its residue
    is proved too.
12. **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`**, which
    has not been a capability since PR #21 and which nothing validates. Left
    exactly as 8B left it, and noted again rather than fixed by accident while
    editing `capabilityInventory.absent`.
13. **13.1's "remove superseded validators atomically" has no deletion target.**
    There is no handwritten validator in this repository to supersede — `apps/`
    and `libs/` contain only `.gitkeep`. Rather than record the clause as
    vacuous, the registry declares exactly one validator per surface and a second
    module claiming the same surface is a named refusal. Atomicity is enforced
    going forward instead of asserted about a past that does not exist.
14. **Ship four tasks, not five.** `tasks.md` declares 13.1–13.4 and 13.4 already
    bundles the fixtures, the evidence and the docs that Stages 11 and 12 split
    across `.4` and `.5`. No 13.5 was invented.
15. **The capture runs on the host.** Every earlier stage that captured inside
    the container owned a container-only binary — a pinned CLI, a toolchain
    installer, an image. This one owns none, so a container hop would add a
    moving part and prove nothing.
16. **The pull request was opened before the live capture.** `ci.yml` triggers on
    `push` only for the default branch, so a feature-branch push produces no run
    at all — the `pull_request` capture the record needs cannot exist until the
    pull request does. The capture is still at the implementation boundary,
    which is what the record asserts.
