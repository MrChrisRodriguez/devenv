#!/usr/bin/env bash
# Hermetic behavior test for the Codex Cloud bootstrap, doctor, and exec path.
#
# No network access and no writes outside one temporary directory. Every pinned
# tool - including "uname" - is replaced by a stub that reports the value the
# committed contract pins, so the Linux-only setup path is exercised from any
# development machine and an upstream registry outage can never fail this run.

set -euo pipefail

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$CLOUD_DIR/lib.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TEST_HOME="$WORK/home"
TEST_BIN="$WORK/bin"
TEST_REPO="$WORK/repo"
SECRET_NAME="GH_TOKEN"
SECRET_VALUE="codex-cloud-selftest-sentinel-value"

fail() {
	echo "Codex cloud selftest: $*" >&2
	exit 1
}

file_mode() {
	if stat -c '%a' "$1" >/dev/null 2>&1; then
		stat -c '%a' "$1"
	else
		stat -f '%Lp' "$1"
	fi
}

# Contract-derived paths, resolved against the test home rather than the real
# one. A subshell keeps the override from leaking into this process.
test_persisted_environment="$(
	HOME="$TEST_HOME"
	cloud_persisted_environment_file
)"
test_persisted_secrets="$(
	HOME="$TEST_HOME"
	cloud_persisted_secrets_file
)"
test_marker_core="$(
	HOME="$TEST_HOME"
	cloud_marker_file core
)"

mkdir -p "$TEST_HOME" "$TEST_BIN" "$TEST_REPO/.codex"
cp -R "$REPO_ROOT/.codex/cloud" "$TEST_REPO/.codex/cloud"
for relative_path in $(cloud_contract_list fingerprint_inputs); do
	mkdir -p "$TEST_REPO/$(dirname "$relative_path")"
	if [ -f "$REPO_ROOT/$relative_path" ]; then
		cp "$REPO_ROOT/$relative_path" "$TEST_REPO/$relative_path"
	else
		# A freshly rendered project creates its first lock file on install.
		# The hermetic test only needs each declared input to exist and stay
		# byte-stable between the bootstrap and the doctor.
		: >"$TEST_REPO/$relative_path"
	fi
done

write_stub() {
	local name="$1"
	local version="$2"
	cat >"$TEST_BIN/$name" <<STUB
#!/bin/sh
case "\$1" in
	--version | -v | -V) echo "${name} ${version}" ;;
esac
exit 0
STUB
	chmod 0755 "$TEST_BIN/$name"
}

for tool in $(cloud_contract_list required_tools); do
	write_stub "$tool" "$(cloud_tool_version "$tool")"
done

# capability:start graphify
write_stub "$(cloud_contract_value graphify_binary)" "$(cloud_contract_value graphify_version)"
# capability:end graphify

cat >"$TEST_BIN/bun" <<STUB
#!/bin/sh
case "\$*" in
	--version) echo "$(cloud_tool_version bun)" ;;
	"install --frozen-lockfile") mkdir -p node_modules/.bin ;;
esac
exit 0
STUB
chmod 0755 "$TEST_BIN/bun"

cat >"$TEST_BIN/uname" <<'STUB'
#!/bin/sh
case "$1" in
	-m) echo "x86_64" ;;
	*) echo "Linux" ;;
esac
exit 0
STUB
chmod 0755 "$TEST_BIN/uname"

cat >"$TEST_BIN/timeout" <<'STUB'
#!/bin/sh
shift
exec "$@"
STUB
chmod 0755 "$TEST_BIN/timeout"

cat >"$TEST_BIN/sudo" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod 0755 "$TEST_BIN/sudo"

# capability:start playwright
cat >"$TEST_BIN/bunx" <<STUB
#!/bin/sh
case "\$*" in
	*"playwright@"*) : >"$WORK/browser-install-invoked" ;;
esac
exit 0
STUB
chmod 0755 "$TEST_BIN/bunx"
# capability:end playwright

run_cloud() {
	local script="$1"
	shift
	env -i \
		HOME="$TEST_HOME" \
		PATH="$TEST_BIN:/usr/bin:/bin" \
		bash "$TEST_REPO/.codex/cloud/${script}" "$@"
}

run_cloud_with_secret() {
	local script="$1"
	shift
	env -i \
		HOME="$TEST_HOME" \
		PATH="$TEST_BIN:/usr/bin:/bin" \
		"${SECRET_NAME}=${SECRET_VALUE}" \
		bash "$TEST_REPO/.codex/cloud/${script}" "$@"
}

status=0
run_cloud_with_secret bootstrap.sh core >"$WORK/bootstrap-1.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/bootstrap-1.log" >&2
	fail "first core bootstrap exited ${status}"
}
if grep -Fq "$SECRET_VALUE" "$WORK/bootstrap-1.log"; then
	fail "bootstrap echoed a secret value"
fi

status=0
run_cloud bootstrap.sh core >"$WORK/bootstrap-2.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/bootstrap-2.log" >&2
	fail "repeated core bootstrap exited ${status}"
}

source_line=". \"${test_persisted_environment}\""
occurrences="$(grep -Fxc "$source_line" "$TEST_HOME/.bashrc" || true)"
[ "$occurrences" = "1" ] ||
	fail "the shell hook appears ${occurrences} times after two bootstraps"

[ "$(file_mode "$test_persisted_secrets")" = "600" ] ||
	fail "the persisted secrets file is not mode 600"
grep -Eq "^export ${SECRET_NAME}=" "$test_persisted_secrets" ||
	fail "a secret set only during the first run was not upserted"

[ ! -e "$WORK/browser-install-invoked" ] ||
	fail "the core profile installed a browser payload"

status=0
run_cloud doctor.sh --quiet >"$WORK/doctor-cold.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/doctor-cold.log" >&2
	fail "the doctor did not accept a cold shell through the persisted marker"
}

status=0
run_cloud doctor.sh --known-bad >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "the doctor accepted an unsupported argument"

status=0
run_cloud exec.sh >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "exec accepted an empty command"

status=0
run_cloud bootstrap.sh known-bad >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "bootstrap accepted an unsupported profile"

printf 'stale' >"$test_marker_core"
status=0
run_cloud doctor.sh >"$WORK/doctor-stale.log" 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "the doctor accepted a stale fingerprint"
grep -Fq "fingerprint is missing or stale" "$WORK/doctor-stale.log" ||
	fail "the doctor did not name the stale fingerprint"

status=0
run_cloud exec.sh touch "$WORK/should-not-exist" >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "exec ran a command in an unhealthy environment"
[ ! -e "$WORK/should-not-exist" ] ||
	fail "exec executed the requested command despite an unhealthy environment"

mv "$test_persisted_environment" "$WORK/persisted-environment.bak"
status=0
run_cloud exec.sh true >/dev/null 2>&1 || status=$?
[ "$status" -eq 3 ] || fail "exec exited ${status} outside a verified cloud environment"
mv "$WORK/persisted-environment.bak" "$test_persisted_environment"

status=0
run_cloud bootstrap.sh core >"$WORK/bootstrap-3.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/bootstrap-3.log" >&2
	fail "bootstrap did not restore a stale environment"
}
status=0
run_cloud doctor.sh --quiet >/dev/null 2>&1 || status=$?
[ "$status" -eq 0 ] || fail "the doctor rejected a restored environment"

# capability:start playwright
browser_profile="$(cloud_contract_value browser_profile)"
browser_marker="$(
	HOME="$TEST_HOME"
	cloud_expand_home "$(cloud_contract_value browser_payload_root)"
)/$(cloud_contract_value browser_marker_basename)"

status=0
run_cloud bootstrap.sh "$browser_profile" >"$WORK/bootstrap-browser.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/bootstrap-browser.log" >&2
	fail "the browser bootstrap exited ${status}"
}
[ -e "$WORK/browser-install-invoked" ] ||
	fail "the browser profile did not install its payload"
[ "$(cat "$browser_marker")" = "$(cloud_contract_value browser_playwright_version)" ] ||
	fail "the browser payload marker does not carry the contract version"

status=0
run_cloud doctor.sh --quiet >"$WORK/doctor-browser.log" 2>&1 || status=$?
[ "$status" -eq 0 ] || {
	cat "$WORK/doctor-browser.log" >&2
	fail "the doctor rejected a prepared browser profile"
}
# capability:end playwright

echo "Codex cloud selftest: passed"
