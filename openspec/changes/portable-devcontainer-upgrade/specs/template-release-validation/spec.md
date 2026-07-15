## ADDED Requirements

### Requirement: Every guard proves good and bad behavior
Each mechanically enforceable invariant SHALL have a required guard with a valid case, known-bad mutation, and anti-vacuity behavior when it enumerates repository inputs.

#### Scenario: Expected inputs disappear
- **WHEN** a workflow, project, manifest, spec root, or dependency scan unexpectedly discovers no inputs
- **THEN** the guard fails distinctly instead of passing vacuously

### Requirement: Stage evidence is machine-readable and reversible
Every implementation PR MUST record before/after SHAs, exact commands, machine-readable results, key logs, mutation proof, relevant live resource identities, performance/storage comparison, rollback command/switch, rollback proof, and clean-tree confirmation.

#### Scenario: Stage is ready for review
- **WHEN** a stage implementation is published
- **THEN** its PR contains enough committed or attached evidence to reproduce acceptance and rollback from that exact head

### Requirement: Generated fixture release gate
Before release, the template SHALL generate and validate minimal, cloud, and full fixtures, run every enabled hermetic guard and applicable live smoke, and scan outputs for source-project identifiers, fixed source ports, mutable pins, obsolete commands, duplicate rules/skills, and disabled-capability residue.

#### Scenario: Minimal fixture contains optional residue
- **WHEN** a disabled capability leaves a script, dependency, workflow, test, or agent instruction in the minimal fixture
- **THEN** the release gate fails

#### Scenario: Full fixture is exercised
- **WHEN** the full fixture is built for release
- **THEN** exact-head CI, full default-branch/nightly CI, image build, two-worktree isolation, doctor security, cloud profiles, optional browser launch, OpenSpec lifecycle, and enabled dependency guards all pass

### Requirement: No regression against baseline budgets
Warm command latency, startup/readiness, clean and incremental rebuild behavior, and second-worktree disk growth SHALL be no worse than the recorded baseline unless an explicit reviewed budget exception explains the trade-off.

#### Scenario: Performance budget regresses
- **WHEN** final measurements exceed the accepted Stage 0 baseline/budget
- **THEN** release is blocked until the regression is corrected or a documented exception is approved

### Requirement: Release only from exact green head
The template SHALL be tagged or released only after exact-head PR CI is green and a full default-branch or nightly run validates the same final capability set.

#### Scenario: Required signal is stale or incomplete
- **WHEN** the green run belongs to a different commit or omits an enabled required guard
- **THEN** the release is refused
