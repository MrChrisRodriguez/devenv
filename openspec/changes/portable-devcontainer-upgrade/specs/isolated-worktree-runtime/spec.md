## ADDED Requirements

### Requirement: Stable isolated worktree allocation
Each canonical checkout/worktree SHALL receive a sanitized identity, stable deterministic preferred offset with collision-safe fallback, distinct validated service ports/URLs, and a distinct mutable persistence root in ignored generated state.

#### Scenario: Two worktrees run together
- **WHEN** two linked worktrees are activated concurrently
- **THEN** their identities, port blocks, manifests, containers, process state, and mutable persistence are distinct while valid prior offsets remain stable

#### Scenario: Preferred ports collide
- **WHEN** a worktree's deterministic port block is already claimed
- **THEN** allocation selects a deterministic valid fallback without changing another worktree's state

### Requirement: Container ownership and fast ensure
The runtime MUST identify a container by canonical checkout path and devcontainer config path, mount both the worktree and its Git common directory, and reuse a recorded container only after validating ID shape, running state, ownership labels, config path, definition fingerprint, and Git mount.

#### Scenario: Ready state is stale or foreign
- **WHEN** the recorded ID, fingerprint, labels, config, running state, or Git mount is invalid
- **THEN** the fast path rejects it and the authorized full ensure safely repairs or recreates this worktree's container without using another checkout's container

#### Scenario: Linked-worktree Git runs inside container
- **WHEN** Git status, hooks, switch, checkout, or commit runs in a linked worktree container
- **THEN** the command sees the correct shared Git metadata and operates on the intended worktree

### Requirement: Environment-aware command bridge
The bridge MUST execute directly inside the devcontainer, execute directly in verified cloud, or lazily ensure and enter the current host worktree's container as the development user while preserving nested working directory, generated environment, persistence root, local-bin precedence, interactivity, and child exit status.

#### Scenario: Host invokes from a nested directory
- **WHEN** a project command is requested from a directory below the repository root
- **THEN** the command runs in the corresponding path below the container workspace

#### Scenario: No command is supplied
- **WHEN** the bridge is interactive and receives no command
- **THEN** it opens the intended login shell in the verified execution environment

### Requirement: Generated manifests, routing, and persistence
Lifecycle operations SHALL atomically publish schema-versioned active/inactive/removed worktree state with canonical repository path, identity, ports, direct loopback URL, optional friendly `.localhost` URL, status, and update time; every service in one worktree SHALL use its single persistence root.

#### Scenario: Host Caddy is absent or reload fails
- **WHEN** friendly routing is unavailable
- **THEN** the direct loopback URL remains valid and lifecycle reports the friendly-route warning without advertising a working friendly route

#### Scenario: One launcher diverges from persistence override
- **WHEN** a service, seed path, setup command, or local harness substitutes a shared/hardcoded persistence path
- **THEN** the persistence propagation guard fails

### Requirement: Semantic bounded lifecycle
Service profiles SHALL start in declared dependency order using bounded semantic health checks that validate expected content, detect premature or post-readiness process death, and retain staggered startup only as an explicit diagnostic fallback.

#### Scenario: Unrelated listener returns HTTP 200
- **WHEN** a port accepts HTTP but its response does not match the service health contract
- **THEN** readiness fails with bounded diagnostics rather than marking the service healthy

#### Scenario: Cleanup is requested
- **WHEN** a worktree is stopped or removed
- **THEN** only resources proven to belong to that worktree are removed, legacy volumes are handled explicitly, remaining scoped resources are reported, and incomplete cleanup exits nonzero

### Requirement: Read-only secure doctor
The host doctor SHALL provide human and schema-versioned JSON output with stable check IDs and `PASS|WARN|FAIL|SKIP`, bounded probes, default/strict exit semantics, and no generation, repair, install, reload, start, stop, or deletion.

#### Scenario: Generated state is malicious
- **WHEN** a manifest contains traversal, symlink escape, malformed identity/port, control bytes, unknown fields, secret-like values, or an external URL
- **THEN** the doctor rejects it before filesystem access or network probing, emits no secret, and leaves filesystem, Docker, and routing state unchanged

#### Scenario: Strict mode contains a warning
- **WHEN** all checks avoid `FAIL` but at least one produces `WARN`
- **THEN** normal mode succeeds and strict mode fails using the documented exit contract
