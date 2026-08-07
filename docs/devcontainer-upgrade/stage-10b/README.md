# Stage 10B Sentry and external-write safety

The requirement this stage discharges is one sentence, and it is **not**
capability-qualified:

> Credential presence alone MUST NOT authorize a remote write; a write SHALL
> require explicit intent plus credentials, treat partial configuration as a
> warning/no-op, remain quiet when absent, and query the resource back to assert
> healthy final state after an intentional write.

Sentry is that requirement's *example*, not its scope. So the stage splits. The
**telemetry** half is gated on `sentry`; the **external-write** half that must
hold in every render is core, and lands as new rules in `ci-contract.ts` plus a
post-push readback in the OpenSpec archive wrapper — the one place in this
repository where an intentional remote write actually happens.

```sh
bun run telemetry:check  # registry, mode, wiring, ownership, and the seven legs
bun run ci:check         # now also refuses a credential in the wrong place
bun run openspec:check   # now also requires the archive push to be verified
```

Nothing about this stage lives outside the tree — no repository variable, no
branch-protection change, no operator step — but adopting it does cost **one
container rebuild**, for a reason worth reading before you assume otherwise.
See deviation 18.

## `@sentry/` is eight characters, and that changed the shape from 10A

Stage 10A was shaped by `zod` being three lowercase characters scanned with
`content.includes()`. Here the pre-declared token is `@sentry/` — an npm scope
prefix, beginning with `@` and ending with `/`. `sentry`, `Sentry`,
`SENTRY_DSN`, `libs/observability` and the capability name itself all miss it,
and `SENTRY` already appears unfenced in a shipped core module
(`cloud-contract.ts`'s deployment-credential pattern) without matching.

Prose is therefore free. The residue risk in this stage is **entirely** the new
token it adds — `telemetry:check` — which behaves exactly as `forms:check` did:
fenced in `ci.yml` **and** stripped by `packageRules.sentry`, both or neither.

The one place `@sentry/` genuinely bites is that the guard scans a tree
containing the guard. Every needle — the SDK scope, the initializer, the user
binding, the logger and metrics namespaces, the DSN pattern, the credential-name
patterns and every write shape — is assembled from parts at run time. A path
exemption for the guard's own file is a hole somebody eventually widens.

## The input is a declaration, not a glob

`external-writes.json` sits beside `api-contract.json` and
`ci-matrix-universes.json`, tab-indented with a trailing newline and
`schemaVersion: 1`, validated against `external-writes.schema.json` by the same
`json-schema.ts` that validates `template-parameters.toml`.

```json
{
	"mode": "skeleton",
	"telemetry": null,
	"writes": [],
	"allowedHosts": [],
	"governedElsewhere": [
		{
			"path": "scripts/openspec/archive.sh",
			"authority": "scripts/template/openspec-contract.ts"
		}
	]
}
```

### `mode` is what makes every rule below it non-vacuous

Before any leg runs, the guard derives the tree's actual state and compares it
with the declared one **in both directions**. Four shapes are derived, each the
visible consequence of a telemetry surface or a remote write existing:

- a file under the reserved configuration root `libs/observability/`;
- a file importing the SDK scope (from the AST, not a regex);
- a file calling the SDK initializer;
- a file performing a **write shape** that neither `writes[]` nor
  `governedElsewhere[]` names.

In `skeleton` mode the guard asserts — positively, over the whole tracked tree —
that none of them exist, and it records how many files it read. A scan that read
nothing would report `skeleton` for every tree there will ever be.

### `governedElsewhere[]` is what stops the scan finding nothing

This repository *does* perform a remote write. `scripts/openspec/archive.sh`
pushes to the default branch, and its rules already live in
`scripts/template/openspec-contract.ts` — a module that predates this registry.
A second authority over a file that already has one is the defect 8B recorded
when it added `readUniverseRegistry` rather than a second spelling of the
registry path.

So the write is *named* and *delegated*, and the delegation is reconciled in
both directions: an authority that is not a file is a promise nobody can read, a
delegated path that performs no write is a stale exemption that widens itself,
and an authority that never names the file it governs governs nothing. A
committed test drops the exemption and asserts the derived mode flips to
`active` — the delegation is proved load-bearing rather than decorative.

### A write shape is a command in command position

`"git push"` is an entry in a ban list. `echo "  git push -u origin HEAD"`
prints an instruction to a human. The archive wrapper's own self-healing menu
names the command it did **not** run. None of them push anything.

The scan reads the executable half of executable files only — prose cannot push
a commit — and anchors each needle to the start of a line, after an optional
YAML list dash, an optional `run:` key and any shell keywords. It covers
`git push`, `wrangler [pages] deploy`, `gh release create`, a registry publish
and a method-bearing `curl`.

## The seven legs

| Leg | What it refuses |
| --- | --- |
| Mode reconciliation | A tree that grew a surface the registry calls `skeleton`, and a registry that declares one the tree does not carry |
| Wiring and ownership | A missing package script, an unfenced or conditional step, a gated path that is not gated, signed or stripped |
| Delegated authority | A non-existent authority, a stale exemption, an authority that never reads its file |
| SDK confinement | The SDK imported, initialized, or its logger/metrics reached outside a declared module — and the **user binding anywhere at all** |
| Truth table | An upload gated on one half, a credential read where the intent does not dominate, a silent partial state, a server-reaching scope |
| Declared writes | A write with no intent, an unread credential, a verifier equal to a write command, a verifier that is itself a write, an unread final state |
| Credentials, scrubbing and hosts | A committed credential literal, an impure scrubber, a missing `beforeSend`, `sendDefaultPii` not pinned, a wildcard or path-bearing allowlist entry |

### The gate is intent × credential, never an environment flag

The reference implementation's own header names the bug this cost it: gating a
source-map upload on `CI` rather than on release-plus-token meant **local builds
were minting phantom releases**, and a leaked CI token in a developer's shell
was enough to write.

The static half is an AST projection of `disable: !release || !authToken`.
Something must read *both* halves, or the gate is on one half and therefore on
nothing. No **use** of the credential may sit in a branch the release does not
dominate — resolved one hop through the local the environment variable is read
into, because a gate reads `process.env` once and then decides. And the partial
state must be loud: a build that silently skips the upload is a build nobody
notices skipping it.

### Confinement is an allowlist derived from the registry

A denylist over SDK entry points is a list of the call sites somebody already
found, and the first spelling nobody thought of ships an identity into a crash
report. The allowed set is `telemetry.configModules[]` plus the declared
`scrubModule`, so a project extends the allowlist by *declaring* a module. The
reference's allowlist header says the rest: never weaken the guard's patterns to
work around a violation; fix the call site instead.

The user binding is refused in **every** file, declared or not. Its whole
purpose is to attach an identity to a report that leaves the building.

### The DSN is public and the token is not, and both are checked

The reference passes its DSN as a repository **variable** and its upload token
as an environment-scoped **secret**. So the non-secrecy rule runs in both
directions: the variable declared as client-visible may not read like a
credential, and the upload token must. The credential vocabulary for that rule
deliberately excludes `DSN` and `KEY`, because a blanket "looks like a secret"
rule would refuse the one name that is correct.

## The workflow rules are core, and written before the first deploy job

The renderer has no inverse fence — a fenced block is simply *gone*, with no
`else` branch — so gating these on `sentry` would silently remove them from
every project that turns telemetry off, which is the exact failure the program
exists to prevent. Four rules, all negative requirements today because no
workflow here references the credential context at all:

1. **No credential interpolated into a `run:` body.** Attacker-influenced text
   spliced into a script is an injection; a *credential* spliced into one is the
   secret written into the command the runner executes, where a `set -x` or a
   crash dump prints it.
2. **None at the workflow level**, where it reaches every step of every job
   including the ones that run a third-party action and whatever that loads.
3. **None at the job level**, which looks scoped and is not: the step that
   needed it is indistinguishable from the four that did not.
4. **No `pull_request_target` trigger.** It runs with the base repository's
   secrets against a head a fork controls.

Plus: a step that receives a credential must declare an `if:`, and the existing
"a selection decides what is CHECKED, never what is SHIPPED" rule extends to any
job holding a credential, whatever its id says.

None of these name a capability, a guard script or a package script.
`ci-contract.ts` is copied into every rendered project.

## The archive push is verified against the remote

`archive.sh` already re-fetched and asserted the new commit's parent *before*
pushing, and asserted nothing afterwards. A push that returned 0 is a claim
about a local process: a hook that rewrote the ref, a mirror answering for a
stale replica and a proxy that accepted and dropped the pack all return 0 to the
pusher.

```
#  11 the push did not verify against the remote
```

After a successful push the wrapper runs
`git ls-remote --exit-code origin refs/heads/<default>` and refuses unless it
equals the archive commit exactly, printing the same self-healing menu the
rejection arm already prints. The success message is unchanged.

The paired rule in `openspec-contract.ts` asserts the readback sits **after**
the push — a query before it would assert exactly what the pre-push check
already does while establishing nothing about the write — that its result is
bound, and that the binding is assigned exactly once. A superseded assignment
makes the comparison trivially true and is invisible in a diff that only reads
the first one. The stripper it reads through preserves a `#` inside a quoted
string, because the wrapper itself carries `${#COMMIT_SUBJECT}` in a message.

`archive.sh` is Stage 9's file. Nothing was renamed or removed; every change is
additive, and `openspec.test.ts` plus `template:validate` ran in the same
commit.

## Nothing here needs a telemetry account

The reference's own provisioning script says it in its header: never run the
write path against the real API from an agent session, and the script's own
verification is `bash -n`, a linter, and a dry run that makes zero network calls
*including GETs*. Four proofs, none of which touches the network:

1. **A loopback request recorder.** It binds `127.0.0.1:0` and injects the port
   it was given — environment assumptions pass on a laptop and fail inside a
   container — and it records *every* request including ones no allowlist
   permits, which is what lets one fixture assert both that a permitted write
   reached its host and that a refused one never opened a socket. The reference
   has no recorder, no interceptor and no fetch wrapper of any kind, so this one
   is invented rather than ported.
2. **An injected uploader** implementing the table as an executable, so the four
   states are run rather than read: `0 / 0 / 0 / N` observed requests.
3. **The credential-literal scan proved by planting one** and removing it in a
   `finally`. A tree-wide scan that finds nothing is only meaningful when
   something proves it *would* find something.
4. **The declared verifier exercised against a canned final state**, including
   the wrong one.

No real or valid-looking DSN, token, org or project appears anywhere in the tree
or the evidence. Every fixture host is `example.invalid` — reserved by the DNS
specification, so it can never resolve — or loopback, and the collector removes
every `SENTRY_*` variable from the environment each captured command receives,
sealing the **names** only.

## Validation

```sh
bun run telemetry:check
bun run ci:check && bun run openspec:check
bun run template:validate && bun run template:typecheck && bun run typecheck
bun test scripts/template/__tests__
bunx biome check
bash -n scripts/openspec/archive.sh
bash scripts/worktree/selftest.sh && bash .codex/cloud/selftest.sh
bun run template:fixtures "$(mktemp -d)"   # + YAML parse, workflow graph, residue
```

## Live evidence capture

```sh
# 1. Push the branch and open the pull request. ci.yml triggers on `push` only for
#    the default branch, so a feature branch produces no run until a PR exists.
# 2. Wait for the required gate to go green at the implementation head.
# 3. Capture on the HOST. Unlike the moon and OpenSpec stages this one owns no
#    container-only binary: the guard is a standalone script over node:, Bun and
#    the catalog-pinned compiler, and the only external tools are git and gh.
bun scripts/template/collect-stage-ten-b-evidence.ts capture \
  --implementation <sha> --gate-run <id>
```

Fifteen exact commands with sha256-bound raw logs under
`evidence/stage-10b-telemetry-run/`. Eight are the refusal matrix run one leg at
a time, because a suite-wide green says the *file* passed and what a record has
to be able to say is that a **named** rule was exercised. Two of those legs
point at the core suites (`ci.test.ts`, `openspec.test.ts`), because the rules
they exercise are core and may not be driven from a suite that names a
capability token.

The validator is environment-agnostic: sealed values bound to other sealed
values and to Git objects the record names, run-shape assertions anchored on the
record's own `gateNeeds` with a subset identity test, and the committed workflow
read as a file in the tree rather than as a property of the machine.
`template:validate` is deliberately **not** a captured command — it aggregates
this record, so it cannot appear inside it.

## Scope

**Added:** `external-writes.json`, `external-writes.schema.json`,
`scripts/template/telemetry-contract.ts`,
`scripts/template/validate-telemetry.ts` (all four gated on `sentry`);
`scripts/template/__tests__/telemetry.test.ts` and its two fixture modules;
`scripts/template/stage-ten-b-evidence.ts`,
`collect-stage-ten-b-evidence.ts`, `__tests__/stage-ten-b-evidence.test.ts`;
`evidence/stage-10b-telemetry.{json,schema.json}` and `-run/`; this README.

**Modified:** `scripts/template/ci-contract.ts` (four core rules);
`scripts/template/openspec-contract.ts` (readback ordering, binding and
single-assignment rules, and an exported quote-aware shell stripper);
`scripts/openspec/archive.sh` (the readback and exit code 11);
`scripts/template/validate.ts`; `ci.test.ts`, `openspec.test.ts`,
`cloud.test.ts`, `forms.test.ts`, `template.test.ts`; `.github/workflows/ci.yml`
(one fenced step); `package.json`; `.devcontainer/secrets.example`;
`template-ownership.json`; `AGENTS.md` + mirrors; `CHANGES.md`; `tasks.md`.

**Unchanged, deliberately:** `template-parameters.toml`; all three
`fixtures/template/*.toml`; `bun.lock`; `.codex/cloud/contract.toml`;
`scripts/template/toolchain.ts`; `ci-matrix-universes.json`; `moon.yml`;
`.moon/workspace.yml`; `apps/`; `libs/`.

## Rollback

`git revert -m 1 <stage-10b-pr-merge-commit>` — atomic and **order-independent**.
`rollback.outsideTheTree` is empty: there is no repository variable, no
branch-protection change and no operator step. (Stage 7's recorded list was also
empty, but its branch-protection change made its rollback order-dependent in
fact — "empty" is a claim about the field, not automatically about ordering.)

The reverted tree carries none of the four added paths and the implementation
tree carries all of them, proved by a synthetic merge in the sealed record.
`libs/observability` stays reserved and empty either way, and
`.codex/cloud/contract.toml` is untouched in both directions.

Both directions cost **one container rebuild**: run `bash scripts/worktree/up.sh`
once after adopting and once after reverting. See deviation 18.

## Decisions and deviations

Recorded because the next stage inherits them.

1. **`writes[].authority` was dropped and `writes[].command` added.** The plan's
   field list carried `authority` on declared writes, but for a declared write
   the registry *is* the authority — a field with one possible value adds no
   fact, and `governedElsewhere[]` exists precisely for the writes whose
   authority is elsewhere. `command` replaces it because the accepted decision
   requires asserting that `verify` "may not appear in `writes[].command`",
   which the original field list had no home for.
2. **`TELEMETRY_UPLOAD_BIN` lives in the test fixture, not the contract module.**
   `FORMS_GENERATE_BIN` and `MOON_BIN` are exported by their guards because
   those guards *execute* the declared command. This one never does — its static
   half is an AST projection — so an injection point in the shipped module would
   be a hook nothing uses.
3. **`forms.test.ts` changed in commit 1**, which the plan did not anticipate. It
   pinned `capabilityInventory.absent` verbatim, and `sentry` has to leave that
   list. Found by a full-suite run; commits 1–3 were re-created so commit 1
   carries the fix and every commit is green. **Caution for later stages:**
   `bun test … | tail -N` reports *tail's* exit code, which masked the failure
   for two commits. Redirect to a file and check `$?`.
4. **The write-shape scan is scoped to shell command position** — `git push`,
   `wrangler [pages] deploy`, `gh release create`, a registry publish, and a
   method-bearing `curl` — in the executable half of executable files. A
   `fetch(…, {method: "POST"})` in TypeScript is *not* currently a detected
   shape. Widening it is a guard change that did not belong in a `test(…)`
   commit; the scoping and its reasoning are documented in the guard.
5. **`archive.sh`'s success message is unchanged**, per the accepted decision,
   even though the readback now makes a VERIFIED wording accurate.
6. **`validateWrapperPolicy` and a new `shellCode` helper are exported** from
   `openspec-contract.ts` so the four static readback mutations can drive the leg
   directly. No Stage 9 `REQUIRED_MUTATIONS` sentence was renamed or removed.
7. **`REFUSAL_MATRIX` gained exit code 11 and `usage()`'s `sed` range moved**
   from `#  10 ` to `#  11 `. Without the second edit the usage block would have
   stopped printing before the new code, and the matrix test asserts both
   directions.
8. **Two extra `ci.test.ts` mutations** beyond the four the plan named: a
   job-level `env:` and a `tolerate()` for a credential step that *does* declare
   an `if:`. The landmine about core rules not naming capability tokens did not
   bite — all six mutations are token-free workflow edits, so none had to move
   into `telemetry.test.ts` the way 10A's did.
9. **The cloud allow-list coverage landed in commit 6.** The accepted decision
   required a committed test for the existing `SENTRY_*` refusal but the commit
   plan assigned it to none of the eight commits; it is a test, so it went with
   the tests.
10. **The credential-literal scan needs more than length.** A length-only rule
    fired on `.codex/cloud/selftest.sh`'s 35-character sentinel, so a value must
    also carry digits and must not read as hyphenated words. Both near-misses
    are `tolerate()` cases. A rule that cried wolf on every long constant would
    be turned off within a week.
11. **The injected uploader is spawned asynchronously.** `Bun.spawnSync`
    deadlocks against an in-process `Bun.serve` recorder: the loop that must
    answer the child's request is the loop the synchronous spawn blocked. It
    presents as a hung uploader and a test timeout, not as an error. Any later
    stage that drives a recorder from a test or a collector must use
    `Bun.spawn` + `await proc.exited`.
12. **`host.redactedEnvironmentKeys` is empty in the sealed record**, which is
    the correct and expected outcome on a host that has no telemetry credential
    at all — which is every host that should be running this capture. The
    redaction is proved by a committed test that plants a value and asserts
    neither it nor its key survives, plus a second test that sweeps every bound
    log.
13. **Ship four tasks, not five.** `tasks.md` declares 14.1–14.4 and 14.4 already
    bundles the secrets registry, the fixtures, the evidence, the rules, the docs
    and `CHANGES.md`. No 14.5 was invented — the second consecutive stage where
    the brief said five and the task list said four.
14. **The capture runs on the host**, for the same reason 10A's did: this stage
    owns no container-only binary, so a container hop would add a moving part
    and prove nothing.
15. **The pull request was opened before the live capture.** `ci.yml` triggers on
    `push` only for the default branch, so a feature-branch push produces no run
    at all. The capture still sits at the implementation boundary, which is what
    the record asserts, and the evidence and documentation commits that follow it
    keep that boundary an ancestor of HEAD.
16. **`capabilityInventory.alwaysEmittedPartial` still lists `"moon"`**, which
    has not been a capability since PR #21 and which nothing validates. Left
    exactly as 8B and 10A left it, and noted again rather than fixed by accident
    while editing `capabilityInventory.absent`.
17. **`fixture-manifest.json` names `sentry`** in the disabled renders, as part
    of the omission reason. `scanDisabledResidue` skips that file by name and
    10A recorded the same situation for `zod`. Since the capability *name* is not
    a token here this is benign — but do not "fix" it by removing the skip.
18. **This stage costs one container rebuild, and the plan said it would not.**
    The accepted decisions required a fenced `sentry` block in
    `.devcontainer/secrets.example` *and* asserted that nothing under
    `.devcontainer/**` forces a rebuild. In this repository those two are
    incompatible: `scripts/worktree/contract.toml` lists `.devcontainer` — the
    whole directory — as a `definition_fingerprint_inputs` entry, and the
    Dockerfile bakes that directory in as a definition stamp
    (`COPY .devcontainer /tmp/devenv-definition/.devcontainer`). A comment-only
    edit to an example file the image never reads therefore invalidates the
    stamp layer, `doctor.sh` reports `container.definition` changed, and the
    commit hooks' `--require-ready` bridge refuses until `up.sh` runs.

    It was found the only way it could be: the documentation commit would not
    commit. The block was kept — the accepted decision's substance is that
    14.4's "secrets registry" means `secrets.example`, and the `codex_cloud`
    fenced block already lives in that same file — and the *claim* was corrected
    instead. `rollback.containerRebuildRequired` is sealed `true`, the schema
    pins it `true` with the reason, and the evidence was captured **after** the
    documentation commit so the record describes the tree that actually ships.
    That inverts the planned commit order: documentation is commit 7 and the
    sealed record is commit 8.

    The cost is one cached rebuild of a single late layer, not a cold build.
    Any future stage that touches **any** file under `.devcontainer/**` — README,
    example, comment — inherits this and should say so up front rather than
    discovering it at commit time.
