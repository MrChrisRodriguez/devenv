## ADDED Requirements

### Requirement: Canonical cross-agent rules
The template SHALL maintain one canonical set of execution, worktree, toolchain, cloud, CI, affected-selection, specification, secrets/external-effects, test, and stack-specific rules; agent-specific surfaces SHALL point to or mechanically mirror those rules without divergent normative copies.

#### Scenario: Mechanically testable rule changes
- **WHEN** an invariant is added or changed
- **THEN** its implementation, guard, known-bad regression, developer documentation, and every required agent surface change in the same PR

### Requirement: Honest active OpenSpec lifecycle
When OpenSpec is enabled, tooling MUST discover applicable roots and CLI-returned context paths, use the repository-local CLI, check tasks only after completion, keep completed changes active through feature/shipping PRs, and place post-deployment work in operator runbooks.

#### Scenario: Implementation begins
- **WHEN** an agent applies an active change
- **THEN** it reads status, apply instructions, and every returned context file rather than assuming fixed artifact names or root scope

#### Scenario: Feature branch change is complete
- **WHEN** all implementation tasks are checked on a feature branch
- **THEN** validation reports an expected notice and does not archive the change

### Requirement: Guarded post-merge archive
Archive MUST run only from a clean dedicated default-branch worktree whose HEAD equals a freshly fetched remote default branch, with explicit change selection when ambiguous, duplicate-destination refusal, delta assessment/sync, strict all-root validation, and no commit/push on failure.

#### Scenario: Archive precondition is unsafe
- **WHEN** the worktree is a feature branch, dirty, stale, lacks the remote base, has an existing destination, has ambiguous selection, or fails strict validation
- **THEN** the wrapper refuses before publishing invalid archive state

### Requirement: Secret and authentication isolation
Secrets MUST never be committed, baked, printed, or written to generated manifests; host secrets SHALL use a common tier plus project override; tracing SHALL be disabled while loading; and device/OAuth state SHALL use devcontainer-ID-scoped volumes with one authentication mode per tool/project.

#### Scenario: Project secret overrides common secret
- **WHEN** the same valid key exists in both tiers
- **THEN** the project value is available to child processes without exposing either value in logs

### Requirement: Explicit external-write intent
Credential presence alone MUST NOT authorize a remote write; a write SHALL require explicit intent plus credentials, treat partial configuration as a warning/no-op, remain quiet when absent, and query the resource back to assert healthy final state after an intentional write.

#### Scenario: Local build has only a token
- **WHEN** a credential such as a Sentry token is mounted without release/deployment intent
- **THEN** the build makes no remote write and the request-recorder test observes zero calls

### Requirement: Experiment hygiene
Experiments SHALL be marked disposable or promoted and MUST NOT weaken Moon, dead-code, manifest, typecheck, or CI guards; removal SHALL remove dependencies/registration, while promotion SHALL add normal ownership, graph, universe, tests, and documentation.

#### Scenario: Disposable app is removed
- **WHEN** a spike is deleted
- **THEN** no dependency, workspace registration, universe entry, or guard exception remains, while reusable findings may remain in a decision/backlog artifact
