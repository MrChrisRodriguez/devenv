## ADDED Requirements

### Requirement: Committed template parameter authority
The template SHALL define one committed parameter registry for project identity, workspace paths, Docker resource prefixes, local domains, default branch, toolchain authorities, supported architectures, service descriptors, safety limits, and capability flags.

#### Scenario: Generated project replaces template identity
- **WHEN** a project is initialized with a valid project name
- **THEN** every generated project identifier, environment prefix, resource label, domain stem, secret override path, and path alias is derived from the registry and project input

#### Scenario: Invalid parameter is rejected
- **WHEN** a project name, path, port, architecture, service dependency, or capability combination violates the registry schema
- **THEN** generation fails before writing a partially configured project

### Requirement: Capability-complete generation
The generator MUST emit the implementation, dependency entries, workflows, tests, documentation, and agent rules for an enabled capability as one coherent bundle and MUST omit them all when that capability is disabled.

#### Scenario: Minimal fixture omits optional stacks
- **WHEN** the minimal fixture disables cloud, browser, Cloudflare, Moon affected selection, and stack-specific integrations
- **THEN** its generated tree contains no dead commands, empty workflows, dependencies, guards, or agent instructions for those capabilities

#### Scenario: Full fixture includes selected capabilities
- **WHEN** the full fixture enables every supported capability
- **THEN** every enabled capability has executable implementation, positive and known-bad tests, documentation, and a required guard

### Requirement: Representative fixtures and baseline
The repository SHALL generate minimal, cloud-enabled, and full-capability fixtures and SHALL record a recoverable pre-migration baseline before runtime changes begin.

#### Scenario: Stage affects a fixture
- **WHEN** an implementation stage changes generated behavior
- **THEN** its PR identifies and validates every affected representative fixture

#### Scenario: Baseline is reproducible
- **WHEN** migration performance or storage is evaluated
- **THEN** clean build, warm rebuild, warm command latency, readiness, second-worktree disk growth, resources, tool versions, lock multiplicity, and CI duration are compared with the recorded Stage 0 evidence

### Requirement: Downstream synchronization boundaries
Template synchronization MUST update template-owned infrastructure without overwriting application code, project README content, project OpenSpec changes/specs, generated graph data, or project-owned lock and change history.

#### Scenario: Customized downstream file
- **WHEN** a downstream template-owned file differs from its recorded baseline
- **THEN** synchronization performs a three-way merge or asks for explicit resolution instead of silently replacing it

#### Scenario: New conditional artifact is disabled downstream
- **WHEN** a template update adds an artifact for a capability disabled by the downstream registry
- **THEN** synchronization does not leave the artifact active in the downstream project
