## ADDED Requirements

### Requirement: Single pinned Bun bootstrap
All GitHub workflows SHALL use one composite action that requires the repository's exact Bun version, optionally installs frozen dependencies with bounded attempts, and rejects an empty version; every job SHALL have an outer timeout.

#### Scenario: Caller omits or drifts Bun version
- **WHEN** a workflow omits the version input, supplies an empty/floating value, or duplicates a divergent Bun literal
- **THEN** a required structural or runtime guard fails before dependencies install

#### Scenario: Composite metadata uses an unavailable context
- **WHEN** an expression references an unsupported context anywhere in action metadata, including descriptions
- **THEN** the composite-action policy test fails

### Requirement: Base-branch-agnostic PR execution
Every gating PR workflow MUST avoid `branches` and `branches-ignore`, include appropriate activity/path filters, trigger ready-for-review when draft work is skipped, and isolate draft and ready concurrency lanes.

#### Scenario: Stacked PR targets a non-default branch
- **WHEN** a pull request targets its parent feature branch
- **THEN** the same gating workflows run against that PR's exact head

#### Scenario: Base filter mutation is added
- **WHEN** block, inline, quoted, include, or exclude base-branch filtering is introduced under `pull_request`
- **THEN** a non-vacuous structural test fails

### Requirement: Always-reporting aggregate gate
CI SHALL expose one aggregate status that runs with `always()`, directly depends on every correctness/detection/selection/oracle job, fails for failure or cancellation, permits intentional skips, and excludes explicitly informational coverage and real-network smoke.

#### Scenario: Required job is removed or cancelled
- **WHEN** a correctness job is absent from aggregate dependencies or reports failed/cancelled
- **THEN** policy validation or the aggregate gate fails

### Requirement: Reliable test execution
Generated projects MUST typecheck test/E2E sources, use the runtime required by each test stack, use semantic readiness plus liveness, block unintended external calls, isolate mutable database state, use repository-local browser tools, and avoid blanket retries/timeouts/fixed sleeps.

#### Scenario: Infrastructure dies after readiness
- **WHEN** a service, browser, or capture process exits after the initial readiness gate
- **THEN** the test reports an infrastructure failure rather than an application or visual regression

### Requirement: Moon graph authority is independently verified
When Moon affected selection is enabled, every project SHALL declare exact internal dependencies, every CI-covered project SHALL belong to a non-empty explicit universe, and a required independent oracle SHALL compare Moon with workspace manifests and imports while CI remains in full mode.

#### Scenario: Project edge or universe drifts
- **WHEN** an edge is missing/extra, an import is undeclared, a project is unknown/missing, or a universe is missing/malformed/duplicated/empty
- **THEN** the graph/universe gate fails rather than certifying Moon from its own declarations

### Requirement: Safe affected selection rollout
Affected selection SHALL be controlled by one `full|moon` switch, diff PRs against their actual event base with sufficient history, include deep dependents, select full for root/global/unknown changes and non-PR full events, select full on computation errors, and fail loudly on invalid universes.

#### Scenario: Selection computation fails
- **WHEN** base history, diff, Moon, or a project query fails
- **THEN** every valid universe receives the full matrix

#### Scenario: Docs-only PR is valid
- **WHEN** only classified documentation changes and universes are healthy
- **THEN** heavy project matrices may be empty while the aggregate gate still reports
