// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";
// One devcontainer identity implementation for every stage record; it is the
// reviewer's independent answer to the CLI's ${devcontainerId}.
import { devcontainerIdentity } from "./stage-five-evidence";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";
// The inventory the guard enforces against the script. Importing it here is what
// makes the record, the guard, and the shipped doctor one claim rather than three.
import { DOCTOR_CHECK_IDS } from "./worktree-contract";

type JsonRecord = Record<string, unknown>;

export const STAGE_SIX_COMMAND_IDS = [
	"doctor-guard",
	"hermetic-selftest",
	"doctor-known-bad-fixtures",
	"doctor-check-inventory",
	"journey-worktree-a-up",
	"journey-worktree-b-up",
	"live-healthy-human",
	"live-healthy-json",
	"live-strict",
	"live-second-worktree",
	"live-duplicate-port-claim",
	"live-stopped-container",
	// The two commands that exist to prove a refusal. Every other command must
	// exit zero, so a refusal can never be smuggled in as a pass or the reverse.
	"live-inside-container",
	"live-invalid-argument",
	"non-mutation-snapshot",
	"journey-cleanup",
	"rollback-proof",
] as const;

export type StageSixCommandId = (typeof STAGE_SIX_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-6-doctor-run";
const COLLECTOR = "scripts/template/collect-stage-six-evidence.ts";
const DOCTOR = "bash scripts/worktree/doctor.sh";

// The doctor's exit contract, which is what the two refusals below prove: 1 is a
// reported failure, 2 is an argument refused before a single check ran.
export const DOCTOR_REFUSAL_EXIT_CODES: Record<string, number> = {
	"live-inside-container": 1,
	"live-invalid-argument": 2,
};

// The two throwaway linked worktrees. `s6` is their parent directory because the
// runtime names a linked worktree for its parent and its own directory, so this
// is what fixes the two families at `s6-alpha` and `s6-beta`.
export const WORKTREE_NAMES = ["alpha", "beta"] as const;

// The workspace id the duplicate-claim command fabricates. It is a manifest and
// nothing else: no checkout, no registry entry, no container, and it is written
// into the isolated manifest directory and deleted by the same command.
export const COLLISION_WORKSPACE_ID = "s6-collision-probe";

// The one path this stage adds to the runtime. A revert has to take it back out,
// which is the additive half of the rollback proof.
export const ADDED_PATHS = ["scripts/worktree/doctor.sh"] as const;

const VOLUME_NAMES =
	"'{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}'";
// Compact one-line JSON, so a whole doctor report can travel as one recorded value.
const COMPACT_JSON =
	'python3 -c \'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))\'';

export function journeyHomePath(temporaryRoot: string): string {
	return `${temporaryRoot}/home`;
}

export function worktreeParentPath(temporaryRoot: string): string {
	return `${temporaryRoot}/s6`;
}

export function worktreePath(temporaryRoot: string, name: string): string {
	return `${worktreeParentPath(temporaryRoot)}/${name}`;
}

export function fabricatedManifestPath(temporaryRoot: string): string {
	return `${journeyHomePath(temporaryRoot)}/.config/devcontainer/worktrees/${COLLISION_WORKSPACE_ID}.json`;
}

// The shared rollback prober only accepts a temporary workspace whose first path
// segment names its own stage, so this one keeps that prefix and is released by
// the same exit trap as the journey root.
export function rollbackWorkspacePath(runId: string): string {
	return `/tmp/devenv-stage2-${runId}-rollback`;
}

// Every live command answers as a second developer on this machine would: an
// isolated HOME, so no registry, manifest, or route belonging to the real
// checkout is ever a candidate. The container engine's own CLI configuration is
// deliberately NOT isolated — it selects the engine endpoint, which is host
// tooling shared by every checkout on the machine.
function journeyEnvironment(temporaryRoot: string, hostHome: string): string[] {
	return [
		`export HOME="${journeyHomePath(temporaryRoot)}"`,
		`export DOCKER_CONFIG="${hostHome}/.docker"`,
	];
}

function journeyPreamble(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string[] {
	return [
		"set -euo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${worktree}"`,
	];
}

// Read one contract value using the runtime's own reader, so a probe never
// hardcodes a value the contract owns.
function contractValue(worktree: string, key: string): string {
	return [
		'bash -c \'. "$1/scripts/worktree/lib.sh"; wt_contract_value "$2"\'',
		`bash "${worktree}" ${key}`,
	].join(" ");
}

// Read one value out of a worktree's generated environment through the same
// reader, so a probe never hardcodes a generated path either.
function generatedValue(worktree: string, key: string): string {
	return [
		'bash -c \'. "$1/scripts/worktree/lib.sh";',
		'wt_env_file_value "$REPO_ROOT/$(wt_contract_value generated_environment)" "$2"\'',
		`bash "${worktree}" ${key}`,
	].join(" ");
}

function present(path: string): string {
	return `"$([ -e ${path} ] && printf present || printf absent)"`;
}

// The real checkout's host state, digested before the journey starts and again
// after it has released everything. The journey runs under its own HOME, so the
// two digests have to be identical: that is the proof that two throwaway
// worktrees never reached into the registry, manifests, and routes the real
// checkout owns.
function realStateDigestFunction(hostHome: string): string {
	return [
		"real_state_digest() {",
		`\t(cd "${hostHome}/.config/devcontainer" 2>/dev/null &&`,
		"\t\tfind ports-registry worktrees caddy -type f -print0 2>/dev/null |",
		"\t\tsort -z | xargs -0 shasum -a 256 2>/dev/null || true) |",
		"\t\tshasum -a 256 | awk '{ print $1 }'",
		"}",
	].join("\n");
}

// Everything the doctor could possibly write to, in one digest: the isolated
// host configuration root and both worktrees' generated state.
function isolatedStateDigestFunction(temporaryRoot: string): string {
	const paths = WORKTREE_NAMES.map(
		(name) => `"${worktreePath(temporaryRoot, name)}/.dev"`,
	).join(" ");
	return [
		"isolated_state_digest() {",
		'\t(find "$HOME/.config/devcontainer" ' + paths + " -type f -print0",
		"\t\t2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null || true) |",
		"\t\tshasum -a 256 | awk '{ print $1 }'",
		"}",
		"isolated_state_listing() {",
		'\t(find "$HOME/.config/devcontainer" ' + paths + " 2>/dev/null | sort) |",
		"\t\tshasum -a 256 | awk '{ print $1 }'",
		"}",
	].join("\n");
}

// One real linked worktree, brought up through the documented entry point, and
// then given something to serve. The template declares no services, so without a
// listener the published port answers nothing and `route.direct` would be
// diagnosing an empty container rather than a route. The listener is the
// container's own Proto-managed interpreter, bound to the contract's declared
// container port, and it dies with the container.
function worktreeUpProbe(
	temporaryRoot: string,
	hostHome: string,
	originPath: string,
	implementationSha: string,
	name: string,
): string {
	const home = journeyHomePath(temporaryRoot);
	const path = worktreePath(temporaryRoot, name);
	return [
		"set -euo pipefail",
		realStateDigestFunction(hostHome),
		"printf 'realCheckoutStateDigest=%s\\n' \"$(real_state_digest)\"",
		...journeyEnvironment(temporaryRoot, hostHome),
		"for directory in secrets.d container-env codex-auth; do",
		'\tmkdir -p "$HOME/.config/devcontainer/$directory"',
		'\tchmod 700 "$HOME/.config/devcontainer/$directory"',
		"done",
		'mkdir -p "$HOME/.ssh"',
		'chmod 700 "$HOME/.ssh"',
		`mkdir -p "${worktreeParentPath(temporaryRoot)}"`,
		`git -C "${originPath}" worktree add --detach --quiet "${path}" ${implementationSha}`,
		`cd "${path}"`,
		"printf 'headSha=%s\\n' \"$(git rev-parse HEAD)\"",
		"printf 'gitDir=%s\\n' \"$(git rev-parse --path-format=absolute --git-dir)\"",
		"printf 'gitCommonDir=%s\\n' \"$(git rev-parse --path-format=absolute --git-common-dir)\"",
		`printf 'isolatedHome=%s\\n' "${home}"`,
		"bash scripts/worktree/up.sh",
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		"printf 'containerId=%s\\n' \"$container_id\"",
		`printf 'environmentJson=%s\\n' "$(bash scripts/worktree/env.sh --json | ${COMPACT_JSON})"`,
		"printf 'manifestPath=%s\\n' \"$(bash scripts/worktree/manifest.sh path)\"",
		"printf 'definitionFingerprint=%s\\n' \"$(bash scripts/worktree/ensure.sh --definition-fingerprint)\"",
		`development_user="$(${contractValue(path, "development_user")})"`,
		`container_workspace="$(${contractValue(path, "container_workspace")})"`,
		`container_port="$(${contractValue(path, "published_container_port")})"`,
		'printf \'publishedMapping=%s\\n\' "$(docker port "$container_id" "$container_port/tcp" | head -1)"',
		`printf 'containerVolumes=%s\\n' "$(docker inspect --format ${VOLUME_NAMES} "$container_id")"`,
		'docker exec --detach --user "$development_user" --workdir "$container_workspace" \\',
		'\t"$container_id" /usr/bin/bash -lc \\',
		'\t"exec python -m http.server $container_port --bind 0.0.0.0"',
		"printf 'listener=python -m http.server %s\\n' \"$container_port\"",
		`direct="$(${generatedValue(path, "DEVENV_DIRECT_URL")})"`,
		"printf 'directUrl=%s\\n' \"$direct\"",
		"code=000",
		"for attempt in 1 2 3 4 5 6 7 8 9 10; do",
		'\tcode="$(curl --silent --max-time 5 --output /dev/null --write-out \'%{http_code}\' "$direct" || printf 000)"',
		'\tcase "$code" in 2[0-9][0-9] | 3[0-9][0-9]) break ;; esac',
		"\tsleep 2",
		"done",
		"printf 'directProbeCode=%s\\n' \"$code\"",
		'[ "$code" = "200" ]',
		"printf 'listenerAnswers=true\\n'",
	].join("\n");
}

// The doctor as a developer actually reads it. Every field the record later
// binds is read back out of the report rather than asserted from memory, and the
// whole report travels in the log.
function healthyHumanProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		...journeyPreamble(temporaryRoot, hostHome, worktree),
		"status=0",
		`report="$(${DOCTOR})" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		"printf 'workspace=%s\\n' \"$(printf '%s\\n' \"$report\" | sed -n 's/^  workspace: //p')\"",
		"printf 'summary=%s\\n' \"$(printf '%s\\n' \"$report\" | sed -n 's/^Summary: //p')\"",
		"printf 'checkLines=%s\\n' \"$(printf '%s\\n' \"$report\" | grep -c '^\\[' || true)\"",
		"printf 'failLines=%s\\n' \"$(printf '%s\\n' \"$report\" | grep -c '^\\[FAIL\\]' || true)\"",
		"printf 'firstCheck=%s\\n' \"$(printf '%s\\n' \"$report\" | grep '^\\[' | head -n 1)\"",
		"printf 'lastCheck=%s\\n' \"$(printf '%s\\n' \"$report\" | grep '^\\[' | tail -n 1)\"",
		'[ "$status" = "0" ]',
		"printf 'healthy=true\\n'",
		"printf -- '--- report ---\\n%s\\n' \"$report\"",
	].join("\n");
}

// The same diagnosis as one machine-readable document. This is the report the
// record's check inventory, statuses, and summary are all bound to.
function healthyJsonProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		...journeyPreamble(temporaryRoot, hostHome, worktree),
		"status=0",
		`report="$(${DOCTOR} --json)" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
		'[ "$status" = "0" ]',
		"printf 'healthy=true\\n'",
	].join("\n");
}

// --strict is a pure exit-code modifier. The proof is that the checks array is
// byte for byte the healthy run's while the exit code is not.
function strictProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		...journeyPreamble(temporaryRoot, hostHome, worktree),
		"status=0",
		`report="$(${DOCTOR} --strict --json)" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
	].join("\n");
}

// The second worktree, diagnosed on its own terms. Two checkouts of one
// repository are the case this whole runtime exists for, so the record proves
// they hold different identities, offsets, ports, and containers.
function secondWorktreeProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		...journeyPreamble(temporaryRoot, hostHome, worktree),
		"status=0",
		`report="$(${DOCTOR} --json)" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
		'[ "$status" = "0" ]',
		"printf 'healthy=true\\n'",
	].join("\n");
}

// The promise the previous stage made and this one keeps: the registry says who
// was allocated what, the manifest scan says who is actually claiming what. The
// second claimant is fabricated as a manifest and nothing else, it is written
// into the ISOLATED manifest directory, the manifest directory is digested on
// both sides of the diagnosis, and the same command deletes it again.
function duplicatePortClaimProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	const fabricated = fabricatedManifestPath(temporaryRoot);
	return [
		...journeyPreamble(temporaryRoot, hostHome, worktree),
		'manifest_directory="$HOME/.config/devcontainer/worktrees"',
		"manifest_digest() {",
		'\t(cd "$manifest_directory" && find . -type f -print0 | sort -z |',
		"\t\txargs -0 shasum -a 256) | shasum -a 256 | awk '{ print $1 }'",
		"}",
		'own="$(bash scripts/worktree/manifest.sh path)"',
		'port="$(python3 -c \'import json,sys; print(json.load(open(sys.argv[1]))["hostPort"])\' "$own")"',
		`printf '{"schemaVersion": 1, "workspaceId": "${COLLISION_WORKSPACE_ID}", "repoPath": "%s", "family": "${COLLISION_WORKSPACE_ID}", "offset": 0, "hostPort": %s, "friendlyHost": "${COLLISION_WORKSPACE_ID}.devenv.localhost", "caddySnippet": "", "status": "active"}\\n' \\`,
		`\t"${temporaryRoot}/no-such-checkout" "$port" >"${fabricated}"`,
		`printf 'fabricatedManifest=%s\\n' "${fabricated}"`,
		"printf 'claimedPort=%s\\n' \"$port\"",
		'before="$(manifest_digest)"',
		"status=0",
		`report="$(${DOCTOR} --json)" || status=$?`,
		'after="$(manifest_digest)"',
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		"printf 'beforeDigest=%s\\n' \"$before\"",
		"printf 'afterDigest=%s\\n' \"$after\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
		`rm -f "${fabricated}"`,
		`printf 'fabricationRemoved=%s\\n' "$([ -e "${fabricated}" ] && printf false || printf true)"`,
		'[ "$before" = "$after" ]',
		'[ "$status" = "1" ]',
		"printf 'diagnosed=true\\n'",
	].join("\n");
}

// A stopped container is recoverable, not broken, and the doctor has to say so
// without touching it: the runtime warns, everything that needed a running
// container skips with its reason, and the container is still there afterwards.
function stoppedContainerProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		// Not `set -e`: this probe stops a container on purpose and reads exit
		// codes that are the subject rather than an accident.
		"set -uo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${worktree}"`,
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		"printf 'containerId=%s\\n' \"$container_id\"",
		'docker stop "$container_id" >/dev/null',
		"status=0",
		`report="$(${DOCTOR} --json)" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
		"strict=0",
		`${DOCTOR} --strict >/dev/null 2>&1 || strict=$?`,
		"printf 'strictExitCode=%s\\n' \"$strict\"",
		'docker start "$container_id" >/dev/null',
		'ready=""',
		"for attempt in 1 2 3 4 5 6 7 8 9 10; do",
		'\tready="$(bash scripts/worktree/ensure.sh --check-ready 2>/dev/null)" && break',
		'\tready=""',
		"\tsleep 2",
		"done",
		"printf 'readyAfterRestart=%s\\n' \"$ready\"",
		`development_user="$(${contractValue(worktree, "development_user")})"`,
		`container_workspace="$(${contractValue(worktree, "container_workspace")})"`,
		`container_port="$(${contractValue(worktree, "published_container_port")})"`,
		'docker exec --detach --user "$development_user" --workdir "$container_workspace" \\',
		'\t"$container_id" /usr/bin/bash -lc \\',
		'\t"exec python -m http.server $container_port --bind 0.0.0.0"',
		"printf 'listenerRestarted=true\\n'",
		"exit 0",
	].join("\n");
}

// Inside a container every host answer would be wrong rather than merely
// unavailable, so this is a refusal and not a degradation: one check, one
// failure, and nothing else asked.
function insideContainerProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		"set -uo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${worktree}"`,
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		"printf 'containerId=%s\\n' \"$container_id\"",
		`development_user="$(${contractValue(worktree, "development_user")})"`,
		`container_workspace="$(${contractValue(worktree, "container_workspace")})"`,
		"status=0",
		'report="$(docker exec --user "$development_user" \\',
		'\t--workdir "$container_workspace" --env DEVCONTAINER=true \\',
		`\t"$container_id" /usr/bin/bash -lc '${DOCTOR} --json')" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		`printf 'reportJson=%s\\n' "$(printf '%s' "$report" | ${COMPACT_JSON})"`,
		'exit "$status"',
	].join("\n");
}

// An unsupported argument is answered before a single check runs, with an empty
// report on stdout and the reason on stderr.
function invalidArgumentProbe(
	temporaryRoot: string,
	hostHome: string,
	worktree: string,
): string {
	return [
		"set -uo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${worktree}"`,
		"status=0",
		`message="$(${DOCTOR} --timeout 0 2>&1 1>/dev/null)" || status=$?`,
		"printf 'doctorExitCode=%s\\n' \"$status\"",
		"printf 'refusalMessage=%s\\n' \"$message\"",
		`printf 'stdoutBytes=%s\\n' "$(${DOCTOR} --timeout 0 2>/dev/null | wc -c | tr -d ' ')"`,
		'exit "$status"',
	].join("\n");
}

// The claim the whole stage rests on, measured rather than asserted: every form
// of the doctor, in both worktrees, with the isolated host configuration root
// and both generated state trees digested and listed on either side.
function nonMutationProbe(temporaryRoot: string, hostHome: string): string {
	const lines = [
		"set -euo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		isolatedStateDigestFunction(temporaryRoot),
		'before="$(isolated_state_digest)"',
		'before_listing="$(isolated_state_listing)"',
		"invocations=0",
		`for directory in ${WORKTREE_NAMES.map((name) => `"${worktreePath(temporaryRoot, name)}"`).join(" ")}; do`,
		'\tcd "$directory"',
		'\tfor form in "" "--json" "--strict" "--timeout 5" "--list-checks" "--help"; do',
		`\t\t${DOCTOR} $form >/dev/null 2>&1 || true`,
		"\t\tinvocations=$((invocations + 1))",
		"\tdone",
		"done",
		'after="$(isolated_state_digest)"',
		'after_listing="$(isolated_state_listing)"',
		"printf 'invocations=%s\\n' \"$invocations\"",
		"printf 'beforeDigest=%s\\n' \"$before\"",
		"printf 'afterDigest=%s\\n' \"$after\"",
		"printf 'beforeListing=%s\\n' \"$before_listing\"",
		"printf 'afterListing=%s\\n' \"$after_listing\"",
		'[ "$before" = "$after" ]',
		'[ "$before_listing" = "$after_listing" ]',
		"printf 'unchanged=true\\n'",
	];
	return lines.join("\n");
}

// Cleanup releases everything the two throwaway worktrees own, asserts its own
// completeness, and leaves the real checkout's host state byte for byte where it
// was. The checkouts themselves survive: cleanup releases what the runtime
// allocated, never a developer's directory.
function cleanupProbe(temporaryRoot: string, hostHome: string): string {
	const lines: string[] = [
		"set -euo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		realStateDigestFunction(hostHome),
	];
	for (const name of WORKTREE_NAMES) {
		const path = worktreePath(temporaryRoot, name);
		lines.push(
			`cd "${path}"`,
			'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
			`volumes="$(docker inspect --format ${VOLUME_NAMES} "$container_id")"`,
			'manifest="$(bash scripts/worktree/manifest.sh path)"',
			`printf '${name}ContainerId=%s\\n' "$container_id"`,
			`printf '${name}Volumes=%s\\n' "$volumes"`,
			`printf '${name}Manifest=%s\\n' "$manifest"`,
			`printf '${name}WorkspaceId=%s\\n' "$(basename "$manifest" .json)"`,
			"bash scripts/worktree/cleanup.sh",
			`printf '${name}ContainersRemaining=%s\\n' "$(docker ps --all --no-trunc --quiet --filter label=devcontainer.local_folder=${path} | wc -l | tr -d ' ')"`,
			"remaining=0",
			"for volume in $volumes; do",
			'\tif docker volume inspect "$volume" >/dev/null 2>&1; then remaining=$((remaining + 1)); fi',
			"done",
			`printf '${name}VolumesRemaining=%s\\n' "$remaining"`,
			`printf '${name}ManifestRemaining=%s\\n' ${present('"$manifest"')}`,
			`printf '${name}GeneratedStateRemaining=%s\\n' ${present('".dev/state"')}`,
			`printf '${name}CheckoutRemaining=%s\\n' ${present(`"${path}/README.md"`)}`,
		);
	}
	lines.push("printf 'realCheckoutStateDigest=%s\\n' \"$(real_state_digest)\"");
	return lines.join("\n");
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	return isRecord(value[key]) ? (value[key] as JsonRecord) : {};
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
	return Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function keyValues(value: string): JsonRecord {
	return Object.fromEntries(
		value.split("\n").flatMap((line) => {
			const match = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);
			return match?.[1] ? [[match[1], match[2] ?? ""]] : [];
		}),
	);
}

function words(value: unknown): string[] {
	return String(value ?? "")
		.split(/\s+/)
		.filter(Boolean);
}

function parseJson(value: unknown): JsonRecord {
	try {
		const parsed = JSON.parse(String(value ?? ""));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

// One doctor report, reduced to the two things every assertion below needs: the
// emitted inventory and the status each id carried.
interface DoctorReport {
	ids: string[];
	statuses: Map<string, string>;
	summary: JsonRecord;
	exitCode: unknown;
	workspace: JsonRecord;
	schemaVersion: unknown;
}

function doctorReport(value: unknown): DoctorReport {
	const document = parseJson(value);
	const checks = Array.isArray(document["checks"]) ? document["checks"] : [];
	const ids: string[] = [];
	const statuses = new Map<string, string>();
	for (const entry of checks) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		ids.push(entry["id"]);
		statuses.set(entry["id"], String(entry["status"] ?? ""));
	}
	return {
		ids,
		statuses,
		summary: recordAt(document, "summary"),
		exitCode: document["exitCode"],
		workspace: recordAt(document, "workspace"),
		schemaVersion: document["schemaVersion"],
	};
}

export function expectedStageSixCommands(
	value: JsonRecord,
): Record<StageSixCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const host = recordAt(value, "host");
	const runId = String(run["id"] ?? "");
	const temporaryRoot = String(run["temporaryRoot"] ?? "");
	const originPath = String(run["originPath"] ?? "");
	const hostHome = String(host["home"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	const alpha = worktreePath(temporaryRoot, WORKTREE_NAMES[0]);
	const beta = worktreePath(temporaryRoot, WORKTREE_NAMES[1]);
	return {
		"doctor-guard": ["bun", "run", "worktree:check"],
		"hermetic-selftest": ["bash", "scripts/worktree/selftest.sh"],
		"doctor-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/worktree.test.ts",
		],
		// Runs on the real checkout with the real HOME on purpose: the flag runs
		// no probe and touches nothing, so it is the one live command that is safe
		// to point at the machine's own state.
		"doctor-check-inventory": [
			"bash",
			"scripts/worktree/doctor.sh",
			"--list-checks",
		],
		"journey-worktree-a-up": [
			"bash",
			"-c",
			worktreeUpProbe(
				temporaryRoot,
				hostHome,
				originPath,
				implementationSha,
				WORKTREE_NAMES[0],
			),
		],
		"journey-worktree-b-up": [
			"bash",
			"-c",
			worktreeUpProbe(
				temporaryRoot,
				hostHome,
				originPath,
				implementationSha,
				WORKTREE_NAMES[1],
			),
		],
		"live-healthy-human": [
			"bash",
			"-c",
			healthyHumanProbe(temporaryRoot, hostHome, alpha),
		],
		"live-healthy-json": [
			"bash",
			"-c",
			healthyJsonProbe(temporaryRoot, hostHome, alpha),
		],
		"live-strict": ["bash", "-c", strictProbe(temporaryRoot, hostHome, alpha)],
		"live-second-worktree": [
			"bash",
			"-c",
			secondWorktreeProbe(temporaryRoot, hostHome, beta),
		],
		"live-duplicate-port-claim": [
			"bash",
			"-c",
			duplicatePortClaimProbe(temporaryRoot, hostHome, alpha),
		],
		"live-stopped-container": [
			"bash",
			"-c",
			stoppedContainerProbe(temporaryRoot, hostHome, alpha),
		],
		"live-inside-container": [
			"bash",
			"-c",
			insideContainerProbe(temporaryRoot, hostHome, alpha),
		],
		"live-invalid-argument": [
			"bash",
			"-c",
			invalidArgumentProbe(temporaryRoot, hostHome, alpha),
		],
		"non-mutation-snapshot": [
			"bash",
			"-c",
			nonMutationProbe(temporaryRoot, hostHome),
		],
		"journey-cleanup": ["bash", "-c", cleanupProbe(temporaryRoot, hostHome)],
		"rollback-proof": [
			"bun",
			COLLECTOR,
			"probe-rollback",
			"--base",
			String(source["baseSha"] ?? ""),
			"--implementation",
			implementationSha,
			"--workspace",
			rollbackWorkspacePath(runId),
		],
	};
}

function git(
	root: string,
	args: string[],
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

export async function validateStageSixEvidenceValue(
	value: unknown,
	schema: JsonRecord,
	root: string,
): Promise<string[]> {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const expected = expectedStageSixCommands(value);
	const commands = arrayAt(value, "commands");
	const commandById = new Map(
		commands.flatMap((entry) =>
			isRecord(entry) && typeof entry["id"] === "string"
				? [[entry["id"] as string, entry] as const]
				: [],
		),
	);
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string"
			? [entry["id"] as string]
			: [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_SIX_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 6 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 6 command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageSixCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		const refusal = DOCTOR_REFUSAL_EXIT_CODES[id];
		if (refusal !== undefined) {
			if (entry["exitCode"] !== refusal || entry["status"] !== "refused")
				errors.push(
					`semantic: command ${id} did not refuse with exit ${refusal}`,
				);
		} else if (entry["exitCode"] !== 0 || entry["status"] !== "pass")
			errors.push(`semantic: command ${id} did not pass`);
		for (const stream of ["stdout", "stderr"] as const) {
			const path = `${LOG_ROOT}/${id}.${stream}`;
			if (entry[`${stream}Path`] !== path)
				errors.push(`semantic: command ${id} ${stream} path drifted`);
			const file = Bun.file(resolve(root, path));
			if (!(await file.exists()))
				errors.push(`repository: command ${id} ${stream} log is missing`);
			else {
				const bytes = await file.bytes();
				logs.set(`${id}.${stream}`, new TextDecoder().decode(bytes));
				if (entry[`${stream}Sha256`] !== sha256(bytes))
					errors.push(`repository: command ${id} ${stream} digest drifted`);
			}
		}
	}
	const log = (id: string, stream: "stdout" | "stderr"): string =>
		logs.get(`${id}.${stream}`) ?? "";
	const values = (id: string): JsonRecord => keyValues(log(id, "stdout"));

	// Every sealed path is bound to another sealed path, never to the tree this
	// validator happens to be running in: a reviewer's checkout lives somewhere
	// else entirely, and the capture host's layout is not the property under test.
	const temporaryRoot = String(run["temporaryRoot"] ?? "");
	const isolatedHome = journeyHomePath(temporaryRoot);
	const doctor = recordAt(value, "doctor");
	const healthyReport = doctorReport(values("live-healthy-json")["reportJson"]);
	const inventoryLines = log("doctor-check-inventory", "stdout")
		.split("\n")
		.filter(Boolean);
	// Four independent statements of the same inventory: the guard's exported
	// list, the record's, the flag the shipped script publishes, and the ids a
	// real diagnosis actually emitted.
	if (
		!sameValue(doctor["checkIds"], [...DOCTOR_CHECK_IDS]) ||
		!sameValue(inventoryLines, [...DOCTOR_CHECK_IDS]) ||
		!sameValue(healthyReport.ids, [...DOCTOR_CHECK_IDS]) ||
		doctor["command"] !== "bash scripts/worktree/doctor.sh" ||
		healthyReport.schemaVersion !== doctor["schemaVersion"]
	)
		errors.push("semantic: doctor check inventory drifted");

	// Two throwaway linked worktrees of one repository, each with its own
	// identity, offset, port, and container. The Git directory of each lives
	// outside its checkout, which is what makes it a linked worktree rather than
	// a clone wearing one's name.
	const worktrees = arrayAt(value, "worktrees").filter(isRecord);
	const upCommandIds = ["journey-worktree-a-up", "journey-worktree-b-up"];
	if (worktrees.length !== WORKTREE_NAMES.length) {
		errors.push("semantic: journey worktree evidence drifted");
	} else {
		for (const [index, name] of WORKTREE_NAMES.entries()) {
			const sealed = worktrees[index] ?? {};
			const path = worktreePath(temporaryRoot, name);
			const observed = values(upCommandIds[index] ?? "");
			const environment = parseJson(observed["environmentJson"]);
			const volumes = words(observed["containerVolumes"]);
			if (
				sealed["name"] !== name ||
				sealed["path"] !== path ||
				observed["headSha"] !== source["implementationSha"] ||
				String(observed["gitDir"] ?? "").startsWith(`${path}/.git/`) ||
				!String(observed["gitDir"] ?? "").includes("/worktrees/") ||
				observed["isolatedHome"] !== isolatedHome ||
				sealed["workspaceId"] !== environment["workspaceId"] ||
				sealed["family"] !== environment["family"] ||
				sealed["family"] !== `s6-${name}` ||
				sealed["offset"] !== environment["offset"] ||
				sealed["publishedHostPort"] !== environment["publishedHostPort"] ||
				sealed["directUrl"] !== environment["directUrl"] ||
				environment["repoPath"] !== path ||
				sealed["containerId"] !== observed["containerId"] ||
				sealed["devcontainerId"] !== devcontainerIdentity(path) ||
				sealed["definitionFingerprint"] !== observed["definitionFingerprint"] ||
				volumes.length === 0 ||
				volumes.some(
					(volume) => !volume.endsWith(`-${sealed["devcontainerId"]}`),
				) ||
				observed["publishedMapping"] !==
					`127.0.0.1:${environment["publishedHostPort"]}` ||
				!String(observed["manifestPath"] ?? "").startsWith(
					`${isolatedHome}/`,
				) ||
				// The route only means something if something answers it.
				observed["directProbeCode"] !== "200" ||
				observed["listenerAnswers"] !== "true"
			)
				errors.push("semantic: journey worktree evidence drifted");
		}
		const [first, second] = worktrees;
		for (const key of [
			"workspaceId",
			"family",
			"offset",
			"publishedHostPort",
			"directUrl",
			"containerId",
			"devcontainerId",
		] as const)
			if (first?.[key] === undefined || first?.[key] === second?.[key])
				errors.push("semantic: journey worktree evidence drifted");
	}

	// A healthy diagnosis, read back out of both renderings of the same run.
	const healthy = recordAt(value, "healthy");
	const human = values("live-healthy-human");
	const machine = values("live-healthy-json");
	const summary = healthyReport.summary;
	const firstWorktree = worktrees[0] ?? {};
	if (
		healthy["commandId"] !== "live-healthy-json" ||
		healthy["doctorExitCode"] !== 0 ||
		machine["doctorExitCode"] !== "0" ||
		human["doctorExitCode"] !== "0" ||
		human["healthy"] !== "true" ||
		machine["healthy"] !== "true" ||
		healthyReport.exitCode !== 0 ||
		healthyReport.workspace["id"] !== firstWorktree["workspaceId"] ||
		human["workspace"] !== firstWorktree["workspaceId"] ||
		healthy["pass"] !== summary["pass"] ||
		healthy["warn"] !== summary["warn"] ||
		healthy["fail"] !== summary["fail"] ||
		healthy["skip"] !== summary["skip"] ||
		summary["fail"] !== 0 ||
		summary["skip"] !== 0 ||
		human["failLines"] !== "0" ||
		human["checkLines"] !== String(DOCTOR_CHECK_IDS.length) ||
		human["summary"] !==
			`${summary["pass"]} pass, ${summary["warn"]} warn, ${summary["fail"]} fail, ${summary["skip"]} skip` ||
		!String(human["firstCheck"] ?? "").includes(DOCTOR_CHECK_IDS[0]) ||
		!String(human["lastCheck"] ?? "").includes(
			DOCTOR_CHECK_IDS[DOCTOR_CHECK_IDS.length - 1] ?? "",
		)
	)
		errors.push("semantic: healthy diagnosis evidence drifted");

	// --strict changed the exit code and nothing else. The comparison is the
	// whole checks array, not a count.
	const strict = recordAt(value, "strict");
	const strictValues = values("live-strict");
	const strictReport = parseJson(strictValues["reportJson"]);
	const healthyChecks = parseJson(machine["reportJson"])["checks"];
	if (
		strict["commandId"] !== "live-strict" ||
		strict["doctorExitCode"] !== 1 ||
		strictValues["doctorExitCode"] !== "1" ||
		strictReport["exitCode"] !== 1 ||
		strict["checksIdentical"] !== true ||
		!sameValue(strictReport["checks"], healthyChecks) ||
		strict["warnCount"] !== summary["warn"] ||
		// Vacuous without a warning to promote.
		Number(summary["warn"] ?? 0) < 1
	)
		errors.push("semantic: strict exit modifier evidence drifted");

	// The second worktree diagnosed on its own terms.
	const second = doctorReport(values("live-second-worktree")["reportJson"]);
	const secondWorktree = worktrees[1] ?? {};
	if (
		!sameValue(second.ids, [...DOCTOR_CHECK_IDS]) ||
		second.exitCode !== 0 ||
		second.workspace["id"] !== secondWorktree["workspaceId"] ||
		values("live-second-worktree")["healthy"] !== "true"
	)
		errors.push("semantic: second worktree evidence drifted");

	// The duplicate claim: one FAIL naming both holders and the port, the
	// manifest directory byte identical across the diagnosis, and the fabricated
	// manifest gone by the time the command returned.
	const collision = recordAt(value, "collision");
	const claim = values("live-duplicate-port-claim");
	const claimReport = doctorReport(claim["reportJson"]);
	const claimCheck = parseJson(claim["reportJson"])["checks"];
	const collisionCheck = (Array.isArray(claimCheck) ? claimCheck : []).find(
		(entry) => isRecord(entry) && entry["id"] === "manifests.port-collision",
	);
	const detail = isRecord(collisionCheck)
		? String(collisionCheck["detail"] ?? "")
		: "";
	if (
		collision["commandId"] !== "live-duplicate-port-claim" ||
		collision["checkId"] !== "manifests.port-collision" ||
		collision["status"] !== "FAIL" ||
		claimReport.statuses.get("manifests.port-collision") !== "FAIL" ||
		claimReport.exitCode !== 1 ||
		claim["doctorExitCode"] !== "1" ||
		collision["fabricatedManifest"] !== fabricatedManifestPath(temporaryRoot) ||
		claim["fabricatedManifest"] !== collision["fabricatedManifest"] ||
		claim["fabricationRemoved"] !== "true" ||
		String(collision["claimedPort"]) !== String(claim["claimedPort"]) ||
		String(collision["claimedPort"]) !==
			String(firstWorktree["publishedHostPort"]) ||
		!sameValue(
			collision["holders"],
			[COLLISION_WORKSPACE_ID, String(firstWorktree["workspaceId"])].sort(),
		) ||
		!detail.includes(COLLISION_WORKSPACE_ID) ||
		!detail.includes(String(firstWorktree["workspaceId"])) ||
		!detail.includes(String(collision["claimedPort"])) ||
		collision["beforeDigest"] !== claim["beforeDigest"] ||
		collision["afterDigest"] !== claim["afterDigest"] ||
		collision["beforeDigest"] !== collision["afterDigest"] ||
		collision["manifestsUnchanged"] !== true ||
		// The registry never knew about the fabricated claimant, which is exactly
		// why the manifest scan is an independent cross-check rather than a second
		// reading of the registry.
		claimReport.statuses.get("registry.port-collision") !== "PASS"
	)
		errors.push("semantic: duplicate port claim evidence drifted");

	// A stopped container is a warning and a cascade of reasons, not a crash, and
	// the container is still there afterwards.
	const stopped = recordAt(value, "stopped");
	const stoppedValues = values("live-stopped-container");
	const stoppedReport = doctorReport(stoppedValues["reportJson"]);
	if (
		stopped["commandId"] !== "live-stopped-container" ||
		stopped["containerId"] !== firstWorktree["containerId"] ||
		stoppedValues["containerId"] !== firstWorktree["containerId"] ||
		stoppedValues["readyAfterRestart"] !== firstWorktree["containerId"] ||
		stopped["runtimeStatus"] !== "WARN" ||
		stoppedReport.statuses.get("container.runtime") !== "WARN" ||
		stopped["fastReadyStatus"] !== "SKIP" ||
		stoppedReport.statuses.get("container.fast-ready") !== "SKIP" ||
		stopped["portStatus"] !== "SKIP" ||
		stoppedReport.statuses.get("container.port") !== "SKIP" ||
		stopped["toolsStatus"] !== "SKIP" ||
		stoppedReport.statuses.get("container.tools") !== "SKIP" ||
		// Ownership still answers: a stopped container is still inspectable, so
		// the doctor loses the questions that need it running and no others.
		stoppedReport.statuses.get("container.ownership") !== "PASS" ||
		!sameValue(stoppedReport.ids, [...DOCTOR_CHECK_IDS]) ||
		stopped["doctorExitCode"] !==
			Number(stoppedValues["doctorExitCode"] ?? -1) ||
		stoppedReport.exitCode !== stopped["doctorExitCode"] ||
		stopped["strictExitCode"] !==
			Number(stoppedValues["strictExitCode"] ?? -1) ||
		stoppedValues["listenerRestarted"] !== "true"
	)
		errors.push("semantic: stopped container evidence drifted");

	// The two refusals. Each one is a command that had to fail, and the record
	// binds the failure to what the doctor actually emitted.
	const refusals = arrayAt(value, "refusals").filter(isRecord);
	const insideReport = doctorReport(
		values("live-inside-container")["reportJson"],
	);
	const insideChecks = parseJson(values("live-inside-container")["reportJson"])[
		"checks"
	];
	const insideDetail = String(
		(Array.isArray(insideChecks) && isRecord(insideChecks[0])
			? insideChecks[0]["detail"]
			: "") ?? "",
	);
	const invalid = values("live-invalid-argument");
	if (
		refusals.length !== 2 ||
		refusals[0]?.["commandId"] !== "live-inside-container" ||
		refusals[0]?.["exitCode"] !== 1 ||
		refusals[0]?.["commandExecuted"] !== false ||
		!sameValue(refusals[0]?.["checkIds"], ["host.context"]) ||
		commandById.get("live-inside-container")?.["exitCode"] !== 1 ||
		values("live-inside-container")["doctorExitCode"] !== "1" ||
		!sameValue(insideReport.ids, ["host.context"]) ||
		insideReport.statuses.get("host.context") !== "FAIL" ||
		insideReport.exitCode !== 1 ||
		refusals[0]?.["message"] !== "DEVCONTAINER=true" ||
		insideDetail !== refusals[0]?.["message"] ||
		refusals[1]?.["commandId"] !== "live-invalid-argument" ||
		refusals[1]?.["exitCode"] !== 2 ||
		refusals[1]?.["commandExecuted"] !== false ||
		!sameValue(refusals[1]?.["checkIds"], []) ||
		commandById.get("live-invalid-argument")?.["exitCode"] !== 2 ||
		invalid["doctorExitCode"] !== "2" ||
		// Exit 2 is answered before a single check runs, so stdout carries no
		// report at all.
		invalid["stdoutBytes"] !== "0" ||
		!String(invalid["refusalMessage"] ?? "").includes(
			"timeout must be between 1 and 30 seconds",
		) ||
		String(refusals[1]?.["message"] ?? "") !== String(invalid["refusalMessage"])
	)
		errors.push("semantic: refusal evidence drifted");

	// The measured claim: every form of the doctor, in both worktrees, and the
	// isolated host state identical byte for byte and entry for entry.
	const nonMutation = recordAt(value, "nonMutation");
	const snapshot = values("non-mutation-snapshot");
	if (
		nonMutation["commandId"] !== "non-mutation-snapshot" ||
		nonMutation["invocations"] !== Number(snapshot["invocations"] ?? -1) ||
		Number(snapshot["invocations"] ?? 0) < 12 ||
		nonMutation["beforeDigest"] !== snapshot["beforeDigest"] ||
		nonMutation["afterDigest"] !== snapshot["afterDigest"] ||
		nonMutation["beforeListing"] !== snapshot["beforeListing"] ||
		nonMutation["afterListing"] !== snapshot["afterListing"] ||
		nonMutation["beforeDigest"] !== nonMutation["afterDigest"] ||
		nonMutation["beforeListing"] !== nonMutation["afterListing"] ||
		nonMutation["unchanged"] !== true ||
		snapshot["unchanged"] !== "true" ||
		!/^[0-9a-f]{64}$/.test(String(nonMutation["afterDigest"] ?? ""))
	)
		errors.push("semantic: non-mutation evidence drifted");

	// Cleanup released both worktrees completely, and the real checkout's
	// registry, manifests, and routes are byte identical to the digest taken
	// before any of this started.
	const cleanup = recordAt(value, "cleanup");
	const released = values("journey-cleanup");
	const removed: string[] = [];
	for (const [index, name] of WORKTREE_NAMES.entries()) {
		removed.push(
			`container ${released[`${name}ContainerId`]}`,
			...words(released[`${name}Volumes`]).map((volume) => `volume ${volume}`),
			`manifest ${released[`${name}Manifest`]}`,
		);
		if (
			released[`${name}ContainerId`] !== worktrees[index]?.["containerId"] ||
			released[`${name}WorkspaceId`] !== worktrees[index]?.["workspaceId"] ||
			released[`${name}ContainersRemaining`] !== "0" ||
			released[`${name}VolumesRemaining`] !== "0" ||
			released[`${name}ManifestRemaining`] !== "absent" ||
			released[`${name}GeneratedStateRemaining`] !== "absent" ||
			// Cleanup releases what the runtime allocated; it never removes a
			// developer's checkout.
			released[`${name}CheckoutRemaining`] !== "present" ||
			!log("journey-cleanup", "stderr").includes(
				`removed every resource owned by ${released[`${name}WorkspaceId`]}`,
			)
		)
			errors.push("semantic: cleanup evidence drifted");
	}
	const upDigests = upCommandIds.map(
		(id) => values(id)["realCheckoutStateDigest"],
	);
	if (
		cleanup["commandId"] !== "journey-cleanup" ||
		!sameValue(cleanup["removed"], removed) ||
		!sameValue(cleanup["remaining"], []) ||
		cleanup["realCheckoutStateUnchanged"] !== true ||
		cleanup["realCheckoutStateDigest"] !==
			released["realCheckoutStateDigest"] ||
		upDigests.some((digest) => digest !== cleanup["realCheckoutStateDigest"]) ||
		!/^[0-9a-f]{64}$/.test(String(cleanup["realCheckoutStateDigest"] ?? "")) ||
		log("journey-cleanup", "stderr").includes("survived cleanup")
	)
		errors.push("semantic: cleanup evidence drifted");

	// Additive and diagnostic: reverting removes a diagnosis, so there is no
	// runtime resource to release first and no container definition to rebuild.
	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-6-pr-merge-commit>",
		]) ||
		!sameValue(rollback["runtimeCleanup"], []) ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild")
	)
		errors.push("semantic: Stage 6 rollback is not additive");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 6 rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	// The restoration claim is re-derived from Git objects the record names, so a
	// reviewer never has to trust the probe: the reverted tree is the predecessor
	// tree, and in that tree the doctor this stage added does not exist.
	const revertedTree = String(proof["revertedTree"] ?? "");
	for (const path of ADDED_PATHS) {
		const restored = git(root, ["cat-file", "-e", `${revertedTree}:${path}`]);
		const current = git(root, [
			"cat-file",
			"-e",
			`${String(source["implementationSha"] ?? "")}:${path}`,
		]);
		if (restored.exitCode === 0 || current.exitCode !== 0)
			errors.push(`repository: ${path} does not prove the additive boundary`);
	}

	for (const [label, sha] of [
		["base", source["baseSha"]],
		["implementation", source["implementationSha"]],
	] as const)
		if (
			typeof sha !== "string" ||
			git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 6 ${label} commit is missing`);
	if (
		typeof source["baseSha"] === "string" &&
		typeof source["implementationSha"] === "string" &&
		git(root, [
			"merge-base",
			"--is-ancestor",
			source["baseSha"] as string,
			source["implementationSha"] as string,
		]).exitCode !== 0
	)
		errors.push(
			"repository: Stage 6 base is not an ancestor of implementation",
		);
	if (
		typeof source["implementationSha"] === "string" &&
		git(root, [
			"merge-base",
			"--is-ancestor",
			source["implementationSha"] as string,
			"HEAD",
		]).exitCode !== 0
	)
		errors.push(
			"repository: Stage 6 implementation is not an ancestor of HEAD",
		);
	return errors;
}

export async function validateStageSixEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-6-doctor.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-6-doctor.schema.json"),
		).json()) as JsonRecord;
		return validateStageSixEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
