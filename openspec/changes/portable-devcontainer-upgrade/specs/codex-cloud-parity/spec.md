## ADDED Requirements

### Requirement: Machine-readable cloud contract
When Codex Cloud is enabled, the repository SHALL commit a versioned contract defining core/browser profiles, setup and maintenance commands, required environment markers, exact tools, supported architectures, installer checksums, default profile, and network posture.

#### Scenario: Contract value is missing or mutable
- **WHEN** a required key, exact version, supported profile, architecture checksum, or known contract field is missing, malformed, unknown, or floating
- **THEN** the hermetic contract guard fails

### Requirement: Idempotent bounded bootstrap
Cloud setup and maintenance MUST use one idempotent bootstrap that installs the contract-pinned toolchain with bounded network attempts, uses frozen dependencies, installs the browser only for the browser profile, and persists environment/PATH state for fresh shells.

#### Scenario: Bootstrap runs twice
- **WHEN** bootstrap is executed twice for the same profile
- **THEN** both runs succeed and the second run preserves the same verified versions and deterministic fingerprint

#### Scenario: Core profile is selected
- **WHEN** bootstrap runs with the core profile
- **THEN** browser installation is not attempted

### Requirement: Fail-closed read-only cloud doctor
The cloud doctor MUST perform no installation or repair and MUST fail on a missing cloud marker, unsupported profile, missing/stale fingerprint, tool mismatch, missing frozen dependencies, or browser-launch failure.

#### Scenario: Contract input changes
- **WHEN** any committed input controlling the prepared environment changes after bootstrap
- **THEN** the doctor fails with a maintenance instruction until bootstrap records the new fingerprint

#### Scenario: Browser profile is healthy
- **WHEN** every browser-profile requirement matches
- **THEN** the doctor launches the repository-pinned browser, verifies a known page, closes it, and reports healthy

### Requirement: Cloud direct execution boundary
The command bridge SHALL detect verified cloud execution before host orchestration, run the cloud doctor, execute directly when healthy, and never invoke Docker, devcontainer lifecycle, deployment, or host worktree scripts in cloud.

#### Scenario: Cloud doctor fails
- **WHEN** `CODEX_CLOUD=true` is present but the cloud doctor is unhealthy
- **THEN** the requested project command does not execute and no host/container orchestration is attempted

### Requirement: Separate hermetic and networked evidence
Required PR checks SHALL use hermetic cloud contract/bootstrap tests, while real core/browser bootstrap smoke SHALL be path-triggered, scheduled, and manually runnable outside unrelated required gates.

#### Scenario: External registry is unavailable
- **WHEN** a real network smoke encounters an upstream outage
- **THEN** the smoke reports the outage without making an unrelated PR's aggregate gate fail
