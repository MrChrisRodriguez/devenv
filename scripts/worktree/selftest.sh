#!/usr/bin/env bash
# Hermetic smoke test for the isolated worktree runtime.
#
# Hermetic is the whole point: no container engine, no daemon, no network, and
# no host registry. Everything that mutates runs inside a throwaway sandbox with
# its own HOME and its own Git repository, so this is safe to run in CI, on a
# developer's machine, and in the middle of a working day without touching the
# real checkout's generated state or another worktree's ports.
#
# It is a bounded downstream smoke, not the behaviour matrix: real worktree
# trees, container ownership, concurrency, and cleanup isolation are covered by
# the template's own test suite. What this proves is that a rendered project's
# runtime is internally coherent and degrades correctly.
#
# Exit 0 with a final `Worktree selftest: passed` line is the contract.
#
# Usage:
#   bash scripts/worktree/selftest.sh

set -euo pipefail

WORKTREE_LABEL="Worktree selftest"
WORKTREE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/worktree/lib.sh
. "$WORKTREE_RUNTIME_DIR/lib.sh"

usage() {
	cat >&2 <<'USAGE'
Usage: bash scripts/worktree/selftest.sh
  Run the hermetic runtime smoke test. It takes no arguments and mutates nothing
  outside a throwaway sandbox.
USAGE
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		*)
			usage
			exit 2
			;;
	esac
done

SANDBOX=""
CHECKS=0

discard_sandbox() {
	[ -z "$SANDBOX" ] || rm -rf "$SANDBOX"
}
trap discard_sandbox EXIT

pass() {
	CHECKS=$((CHECKS + 1))
	printf '%s: ok - %s\n' "$WORKTREE_LABEL" "$1"
}

skip() {
	printf '%s: skipped - %s\n' "$WORKTREE_LABEL" "$1"
}

fail() {
	printf '%s: FAILED - %s\n' "$WORKTREE_LABEL" "$1" >&2
	exit 1
}

SCALAR_KEYS="version project_slug environment_prefix docker_resource_prefix
local_domain_stem development_user container_workspace generated_state
mutable_persistence shared_cache host_config_root registry_directory
manifest_directory caddy_snippet_directory generated_environment
generated_container_environment run_directory devcontainer_config
toolchain_manifest published_container_port published_host_port_variable
preferred_offset_modulus collision_scan_limit manifest_schema_version
registry_schema_version doctor_schema_version default_probe_timeout_seconds
startup_timeout_seconds diagnostic_staggered_mode
friendly_domain_pattern direct_host host_caddy always_publish_direct_url
container_engine container_cli container_cli_package bridge_command
ensure_command doctor_command"

LIST_KEYS="definition_fingerprint_inputs legacy_cleanup_commands runtime_scripts services"

check_contract() {
	local key
	for key in $SCALAR_KEYS; do
		if ! wt_contract_value "$key" >/dev/null 2>&1; then
			fail "the contract is missing the scalar key $key"
		fi
	done
	for key in $LIST_KEYS; do
		if ! wt_contract_list "$key" >/dev/null 2>&1; then
			fail "the contract is missing the array key $key"
		fi
	done
	pass "the contract declares every key the runtime reads"
}

check_runtime_scripts() {
	local script path mode
	for script in $(wt_contract_list runtime_scripts); do
		path="$REPO_ROOT/$script"
		[ -f "$path" ] || fail "the declared runtime script $script is missing"
		mode="$(wt_file_mode "$path")"
		[ -x "$path" ] || fail "the runtime script $script is not executable (mode $mode)"
		bash -n "$path" >/dev/null 2>&1 ||
			fail "the runtime script $script has a bash syntax error"
		grep -q 'set -euo pipefail' "$path" ||
			fail "the runtime script $script does not fail closed with set -euo pipefail"
	done
	pass "every declared runtime script exists, is executable, and fails closed"
}

check_definition_fingerprint() {
	local fingerprint image bun_binary
	fingerprint="$(bash "$WORKTREE_RUNTIME_DIR/ensure.sh" --definition-fingerprint)" ||
		fail "the definition fingerprint could not be computed"
	case "$fingerprint" in
		[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
		*) fail "the definition fingerprint is not a lowercase digest: $fingerprint" ;;
	esac
	[ "${#fingerprint}" -eq 64 ] ||
		fail "the definition fingerprint is ${#fingerprint} characters, not 64"
	pass "the definition fingerprint is a 64 character sha-256 digest"

	# The image owns the authoritative implementation; this runtime carries a bash
	# twin because the host needs it before Bun exists. They must agree.
	bun_binary="$(command -v bun 2>/dev/null || true)"
	if [ -z "$bun_binary" ] || [ ! -r "$REPO_ROOT/.devcontainer/devcontainer-fingerprint.sh" ]; then
		skip "fingerprint parity needs Bun and the image-owned fingerprint script"
		return 0
	fi
	image="$(bash "$REPO_ROOT/.devcontainer/devcontainer-fingerprint.sh" "$REPO_ROOT")" ||
		fail "the image-owned fingerprint script failed"
	[ "$image" = "$fingerprint" ] ||
		fail "the host fingerprint $fingerprint differs from the image fingerprint $image"
	pass "the host fingerprint equals the image-owned authority"
}

build_sandbox() {
	local script
	SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/devenv-worktree-selftest.XXXXXX")"
	mkdir -p "$SANDBOX/home" "$SANDBOX/main/scripts/worktree" "$SANDBOX/main/.devcontainer"
	for script in $(wt_contract_list runtime_scripts); do
		cp "$REPO_ROOT/$script" "$SANDBOX/main/$script"
	done
	# A container engine and CLI that cannot exist. Proving that the bridge
	# degrades with an instruction must not depend on whether this machine happens
	# to have Docker installed.
	sed -e 's/^container_engine = .*/container_engine = "devenv-selftest-absent-engine"/' \
		-e 's/^container_cli = .*/container_cli = "devenv-selftest-absent-cli"/' \
		"$WORKTREE_CONTRACT" >"$SANDBOX/main/scripts/worktree/contract.toml"
	printf 'node_modules\n' >"$SANDBOX/main/.dockerignore"
	printf 'bun = "1.0.0"\n' >"$SANDBOX/main/.prototools"
	printf '{ "name": "Selftest" }\n' >"$SANDBOX/main/.devcontainer/devcontainer.json"
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" init -q -b main
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" config user.email selftest@example.invalid
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" config user.name "Worktree Selftest"
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" config commit.gpgsign false
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" add -A
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" commit -qm selftest
	HOME="$SANDBOX/home" git -C "$SANDBOX/main" worktree add -q "$SANDBOX/linked" -b linked
}

# Every sandbox command runs with the sandbox HOME and without the container and
# cloud markers, so running this selftest from inside a container still exercises
# the host code paths it is written to check.
sandbox_run() {
	local directory="$1"
	shift
	(
		cd "$directory" || exit 1
		unset DEVCONTAINER
		# capability:start codex_cloud
		unset CODEX_CLOUD
		# capability:end codex_cloud
		HOME="$SANDBOX/home" "$@"
	)
}

sandbox_environment_value() {
	wt_env_file_value "$1/$(wt_contract_value generated_environment)" "$2"
}

check_generated_environment() {
	local prefix first second offset source registry
	prefix="$(wt_contract_value environment_prefix)"

	sandbox_run "$SANDBOX/linked" bash "$SANDBOX/linked/scripts/worktree/env.sh" \
		>"$SANDBOX/env.out" 2>"$SANDBOX/env.err" ||
		fail "generating the worktree environment failed: $(cat "$SANDBOX/env.err")"
	first="$(cat "$SANDBOX/linked/$(wt_contract_value generated_environment)")"
	sandbox_run "$SANDBOX/linked" bash "$SANDBOX/linked/scripts/worktree/env.sh" \
		>>"$SANDBOX/env.out" 2>>"$SANDBOX/env.err" ||
		fail "regenerating the worktree environment failed"
	second="$(cat "$SANDBOX/linked/$(wt_contract_value generated_environment)")"
	[ "$first" = "$second" ] ||
		fail "regenerating the worktree environment is not byte-identical"

	offset="$(sandbox_environment_value "$SANDBOX/linked" "${prefix}_WORKTREE_OFFSET")"
	case "$offset" in
		'' | *[!0-9]*) fail "the recorded offset '$offset' is not a number" ;;
	esac
	[ "$offset" -ge 1 ] ||
		fail "a linked worktree must not take the main checkout's offset 0"
	source="$(sandbox_environment_value "$SANDBOX/linked" "${prefix}_WORKTREE_OFFSET_SOURCE")"
	case "$source" in
		preferred | alternate) ;;
		*) fail "the recorded offset source '$source' is not preferred or alternate" ;;
	esac
	pass "identity and port allocation are deterministic and regenerate identically"

	sandbox_run "$SANDBOX/main" bash "$SANDBOX/main/scripts/worktree/env.sh" \
		>>"$SANDBOX/env.out" 2>>"$SANDBOX/env.err" ||
		fail "generating the main checkout environment failed"
	[ "$(sandbox_environment_value "$SANDBOX/main" "${prefix}_WORKTREE_OFFSET")" = "0" ] ||
		fail "the main checkout must own offset 0"

	registry="$(wt_contract_value registry_directory)"
	# The quoted tilde arm is deliberate: it MATCHES a literal leading "~/" in
	# the contract value rather than expanding one.
	# shellcheck disable=SC2088
	case "$registry" in
		"~/"*)
			registry="$SANDBOX/home/${registry#\~/}/ports.json"
			[ -r "$registry" ] || fail "the sandbox port registry was never written"
			grep -q '"entries"' "$registry" ||
				fail "the sandbox port registry has no entries object"
			# One entry: the main checkout is never registered.
			[ "$(grep -c '"offset"' "$registry")" -eq 1 ] ||
				fail "the main checkout must not hold a registry entry"
			;;
		*) skip "registry inspection needs a home-relative host configuration root" ;;
	esac
	pass "the main checkout keeps offset 0 and is never registered"
}

check_bridge_degradation() {
	local status=0
	sandbox_run "$SANDBOX/linked" bash "$SANDBOX/linked/scripts/worktree/exec.sh" true \
		>"$SANDBOX/bridge.out" 2>"$SANDBOX/bridge.err" || status=$?
	[ "$status" -eq 6 ] ||
		fail "the bridge must exit 6 without a container engine, not $status"
	grep -q 'container engine is unavailable' "$SANDBOX/bridge.err" ||
		fail "the bridge must name the missing container engine: $(cat "$SANDBOX/bridge.err")"
	pass "the bridge degrades with an instruction when no container engine exists"
}

check_argument_handling() {
	local script status
	for script in env.sh ensure.sh exec.sh manifest.sh services.sh up.sh down.sh cleanup.sh doctor.sh; do
		status=0
		sandbox_run "$SANDBOX/linked" \
			bash "$SANDBOX/linked/scripts/worktree/$script" --devenv-unsupported-argument \
			>/dev/null 2>"$SANDBOX/usage.err" || status=$?
		[ "$status" -eq 2 ] ||
			fail "$script must reject an unsupported argument with exit 2, not $status"
		grep -q "Usage: bash scripts/worktree/$script" "$SANDBOX/usage.err" ||
			fail "$script must print its usage on standard error"
	done
	pass "every entry point rejects an unsupported argument with a usage message"
}

# The doctor's check inventory is its published contract, and --list-checks is
# the bounded, probe-free way to read it. Asserting the generated state is
# byte-identical listing-wise afterwards is the hermetic half of the read-only
# claim the doctor makes about itself.
check_doctor_inventory() {
	local state before after output status=0
	state="$SANDBOX/linked/$(wt_contract_value generated_state)"
	before="$(find "$state" | LC_ALL=C sort)"
	output="$(sandbox_run "$SANDBOX/linked" \
		bash "$SANDBOX/linked/scripts/worktree/doctor.sh" --list-checks \
		2>"$SANDBOX/doctor.err")" || status=$?
	after="$(find "$state" | LC_ALL=C sort)"
	[ "$status" -eq 0 ] ||
		fail "the doctor could not list its checks: $(cat "$SANDBOX/doctor.err")"
	[ -n "$output" ] || fail "the doctor listed no checks"
	case "$output" in
		host.context*) ;;
		*) fail "the doctor's inventory must begin with host.context" ;;
	esac
	[ "$before" = "$after" ] ||
		fail "listing the doctor's checks changed the generated state"
	pass "the doctor lists its check inventory without probing or writing"
}

main() {
	check_contract
	check_runtime_scripts
	check_definition_fingerprint
	build_sandbox
	check_generated_environment
	check_bridge_degradation
	check_argument_handling
	check_doctor_inventory
	printf '%s: %d checks passed\n' "$WORKTREE_LABEL" "$CHECKS"
	printf 'Worktree selftest: passed\n'
}

main
