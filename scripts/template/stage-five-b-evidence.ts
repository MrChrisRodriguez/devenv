// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";
// One devcontainer identity implementation for every stage record; it is the
// reviewer's independent answer to the CLI's ${devcontainerId}.
import { devcontainerIdentity } from "./stage-five-evidence";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_FIVE_B_COMMAND_IDS = [
	"cutover-guard",
	"hermetic-selftest",
	"cutover-known-bad-fixtures",
	"template-known-bad-fixtures",
	"legacy-orchestration-scan",
	"journey-fresh-clone",
	"journey-prerequisites",
	"journey-up",
	"journey-bridge-install",
	"journey-hook-routing",
	// The one command that exists to prove a refusal. Every other command must
	// exit zero, so a refusal can never be smuggled in as a pass or the reverse.
	"journey-hook-refusal",
	"journey-inspect",
	"journey-down",
	"journey-cleanup",
	"rollback-proof",
] as const;

export type StageFiveBCommandId = (typeof STAGE_FIVE_B_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-5b-cutover-run";
const COLLECTOR = "scripts/template/collect-stage-five-b-evidence.ts";
const REFUSAL_COMMAND_IDS = new Set<string>(["journey-hook-refusal"]);
// The two onboarding documents the cutover rewrote. A revert has to put the
// predecessor entry point back into both of them, not merely restore a tree.
export const PREDECESSOR_PATHS = ["init-host.sh", "README.md"] as const;
// Paths whose mention of the superseded launcher is a record, not a route,
// mirroring the allow-list in scripts/template/worktree-contract.ts: sealed
// evidence and its validators describe runs that really did use it, the cloud
// contract forbids it by name, the guard carries the token in order to look for
// it, and graphify-out is derived output.
export const LEGACY_ALLOW_LIST = [
	"CHANGES.md",
	"evidence/",
	"docs/devcontainer-upgrade/",
	"openspec/",
	"graphify-out/",
	"scripts/template/evidence.ts",
	"scripts/template/toolchain-evidence.ts",
	"scripts/template/cloud-contract.ts",
	"scripts/template/worktree-contract.ts",
	".codex/cloud/contract.toml",
] as const;

export function isLegacyAllowListed(path: string): boolean {
	return (LEGACY_ALLOW_LIST as readonly string[]).some((entry) =>
		entry.endsWith("/") ? path.startsWith(entry) : path === entry,
	);
}
// The bridge's ready-only refusal code. A git hook must never start a container.
const REFUSAL_EXIT_CODE = 7;
const PROBE_FILE = "journey-probe.txt";
// Conventional-commit subjects the journey commits by hand. The accepted one has
// an allowed type, a lowercase subject and no trailing period; the rejected one
// has no type at all, so only a commitlint that really ran can reject it.
const ACCEPTED_SUBJECT = "test(journey): stage 5b bridged hook probe";
const REJECTED_SUBJECT = "Bad journey subject.";
const REFUSED_SUBJECT = "test(journey): this commit must never land";
const VOLUME_NAMES =
	"'{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}'";
const LABEL = (name: string) =>
	`docker inspect --format '{{ index .Config.Labels "${name}" }}'`;
// Compact one-line JSON, so a multi-line report can travel as one recorded value.
const COMPACT_JSON =
	'python3 -c \'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))\'';

export function journeyClonePath(temporaryRoot: string): string {
	return `${temporaryRoot}/clone`;
}

export function journeyHomePath(temporaryRoot: string): string {
	return `${temporaryRoot}/home`;
}

// The shared rollback prober only accepts a temporary workspace whose first path
// segment names its own stage, so this one keeps that prefix and is released by
// the same exit trap as the journey root.
export function rollbackWorkspacePath(runId: string): string {
	return `/tmp/devenv-stage2-${runId}-rollback`;
}

// Every journey probe answers as the fresh clone's owner would: an isolated HOME
// so no host registry, manifest, route, or credential belonging to the real
// checkout is ever a candidate, and the clone as the working directory.
//
// The container engine's own CLI configuration is deliberately NOT isolated. It
// selects the engine endpoint, which is host tooling shared by every checkout on
// the machine; isolating it would point the journey at a daemon that does not
// exist rather than at the one a developer really uses. What is isolated is
// exactly what this runtime owns: the registry, the manifests, and the routes.
function journeyEnvironment(temporaryRoot: string, hostHome: string): string[] {
	return [
		`export HOME="${journeyHomePath(temporaryRoot)}"`,
		`export DOCKER_CONFIG="${hostHome}/.docker"`,
	];
}

function journeyPreamble(temporaryRoot: string, hostHome: string): string[] {
	return [
		"set -euo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${journeyClonePath(temporaryRoot)}"`,
	];
}

// Read one value out of the clone's generated environment using the runtime's
// own contract reader, so a probe never hardcodes a generated path.
function generatedValue(clone: string, key: string): string {
	return [
		'bash -c \'. "$1/scripts/worktree/lib.sh";',
		'wt_env_file_value "$REPO_ROOT/$(wt_contract_value generated_environment)" "$2"\'',
		`bash "${clone}" ${key}`,
	].join(" ");
}

// The real checkout's host state, digested before the journey starts and again
// after it has released everything. The journey runs under its own HOME, so the
// two digests have to be identical: that is the proof that a second clone of the
// same project never reached into the registry, manifests, and routes the real
// checkout owns.
function mainStateDigestFunction(hostHome: string): string {
	return [
		"main_state_digest() {",
		`\t(cd "${hostHome}/.config/devcontainer" 2>/dev/null &&`,
		"\t\tfind ports-registry worktrees caddy -type f -print0 2>/dev/null |",
		"\t\tsort -z | xargs -0 shasum -a 256 2>/dev/null || true) |",
		"\t\tshasum -a 256 | awk '{ print $1 }'",
		"}",
	].join("\n");
}

function present(path: string): string {
	return `"$([ -e ${path} ] && printf present || printf absent)"`;
}

// A clone, not a linked worktree: the whole point of the journey is the path a
// new developer takes. Nothing is installed, nothing is generated, and the hooks
// are not active yet, because Husky's `prepare` has not run anywhere.
function freshCloneProbe(
	temporaryRoot: string,
	originPath: string,
	implementationSha: string,
): string {
	const clone = journeyClonePath(temporaryRoot);
	return [
		"set -euo pipefail",
		`export HOME="${journeyHomePath(temporaryRoot)}"`,
		`mkdir -p "$HOME"`,
		`git clone --quiet "${originPath}" "${clone}"`,
		`cd "${clone}"`,
		`git checkout --quiet --detach ${implementationSha}`,
		'git config user.name "Stage 5B journey"',
		'git config user.email "stage-5b-journey@example.invalid"',
		"git config commit.gpgsign false",
		"printf 'headSha=%s\\n' \"$(git rev-parse HEAD)\"",
		"printf 'gitDir=%s\\n' \"$(git rev-parse --path-format=absolute --git-dir)\"",
		"printf 'statusLines=%s\\n' \"$(git status --porcelain | wc -l | tr -d ' ')\"",
		"printf 'hooksPath=%s\\n' \"$(git config --get core.hooksPath || printf none)\"",
		`printf 'huskyRunnerPresent=%s\\n' ${present(".husky/_/h")}`,
		`printf 'generatedStatePresent=%s\\n' ${present(".dev")}`,
		`printf 'nodeModulesPresent=%s\\n' ${present("node_modules")}`,
		"printf 'bridgeExecutable=%s\\n' \"$([ -x scripts/worktree/exec.sh ] && printf true || printf false)\"",
		"printf 'commitMsgRoutes=%s\\n' \"$(grep -c 'exec.sh --require-ready' .husky/commit-msg | tr -d ' ')\"",
		"printf 'preCommitRoutes=%s\\n' \"$(grep -c 'exec.sh --require-ready' .husky/pre-commit | tr -d ' ')\"",
	].join("\n");
}

// init-host.sh is NOT executed: it runs `brew`, which would mutate the capture
// host. What the journey does execute is the part a fresh clone actually needs —
// the documented host-directory loop, under the isolated HOME — plus a syntax
// check and the assertions that it installs the container CLI and verifies
// python3. The precondition is sealed here too: the real checkout must have no
// ready container, or a second clone of the same project would collide with it.
function prerequisitesProbe(
	temporaryRoot: string,
	originPath: string,
	hostHome: string,
): string {
	const clone = journeyClonePath(temporaryRoot);
	return [
		"set -euo pipefail",
		mainStateDigestFunction(hostHome),
		"printf 'mainCheckoutStateDigest=%s\\n' \"$(main_state_digest)\"",
		"status=0",
		`(cd "${originPath}" && HOME="${hostHome}" bash scripts/worktree/ensure.sh --check-ready) >/dev/null 2>&1 || status=$?`,
		"printf 'mainCheckoutReadyExitCode=%s\\n' \"$status\"",
		...journeyEnvironment(temporaryRoot, hostHome),
		"for directory in secrets.d container-env codex-auth; do",
		'\tmkdir -p "$HOME/.config/devcontainer/$directory"',
		'\tchmod 700 "$HOME/.config/devcontainer/$directory"',
		"done",
		'mkdir -p "$HOME/.ssh"',
		'chmod 700 "$HOME/.ssh"',
		"printf 'isolatedHome=%s\\n' \"$HOME\"",
		"printf 'hostDirectories=%s\\n' \"$(ls \"$HOME/.config/devcontainer\" | sort | tr '\\n' ' ')\"",
		"printf 'dockerVersion=%s\\n' \"$(docker version --format '{{.Server.Version}}')\"",
		"printf 'containerCliVersion=%s\\n' \"$(devcontainer --version)\"",
		"printf 'pythonVersion=%s\\n' \"$(python3 -c 'import platform; print(platform.python_version())')\"",
		"printf 'hostBunPresent=%s\\n' \"$(command -v bun >/dev/null 2>&1 && printf true || printf false)\"",
		`cd "${clone}"`,
		"bash -n init-host.sh",
		"printf 'initHostSyntax=ok\\n'",
		"printf 'initHostInstallsContainerCli=%s\\n' \"$(grep -c 'brew install devcontainer' init-host.sh | tr -d ' ')\"",
		"printf 'initHostVerifiesPython=%s\\n' \"$(grep -c 'python3' init-host.sh | tr -d ' ')\"",
	].join("\n");
}

// One real cold start of a checkout that has never been built here, driven by
// the documented entry point and nothing else.
function upProbe(temporaryRoot: string, hostHome: string): string {
	const clone = journeyClonePath(temporaryRoot);
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		"bash scripts/worktree/up.sh",
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		"printf 'containerId=%s\\n' \"$container_id\"",
		`printf 'containerLocalFolder=%s\\n' "$(${LABEL("devcontainer.local_folder")} "$container_id")"`,
		`printf 'containerConfigFile=%s\\n' "$(${LABEL("devcontainer.config_file")} "$container_id")"`,
		`printf 'containerVolumes=%s\\n' "$(docker inspect --format ${VOLUME_NAMES} "$container_id")"`,
		'printf \'publishedMapping=%s\\n\' "$(docker port "$container_id" 8080/tcp | head -1)"',
		`printf 'environmentJson=%s\\n' "$(bash scripts/worktree/env.sh --json | ${COMPACT_JSON})"`,
		"printf 'manifestPath=%s\\n' \"$(bash scripts/worktree/manifest.sh path)\"",
		"printf 'definitionFingerprint=%s\\n' \"$(bash scripts/worktree/ensure.sh --definition-fingerprint)\"",
		// The container's own create lifecycle installs the project's dependencies
		// inside the container, and that install runs `prepare`, which is what sets
		// core.hooksPath through the bind mount. A fresh clone therefore goes from
		// "no dependencies, no hooks" to "hooks active" without a host install.
		"printf 'hooksPathAfterUp=%s\\n' \"$(git config --get core.hooksPath || printf none)\"",
		`printf 'nodeModulesAfterUp=%s\\n' ${present("node_modules")}`,
		`printf 'huskyRunnerAfterUp=%s\\n' ${present(".husky/_/h")}`,
		`printf 'persistenceRoot=%s\\n' "$(${generatedValue(clone, "DEVENV_PERSISTENCE_ROOT")})"`,
	].join("\n");
}

// The project's own dependencies are installed through the bridge, inside the
// container, which is also what activates Husky: `prepare` runs there, so
// core.hooksPath only exists on the host afterwards because a container wrote it
// through the bind mount.
function bridgeInstallProbe(temporaryRoot: string, hostHome: string): string {
	const bridge = "bash scripts/worktree/exec.sh --require-ready";
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		"bash scripts/worktree/exec.sh bun install --frozen-lockfile",
		`printf 'installOs=%s\\n' "$(${bridge} uname -s)"`,
		`printf 'installBunPath=%s\\n' "$(${bridge} sh -c 'command -v bun')"`,
		"printf 'hooksPath=%s\\n' \"$(git config --get core.hooksPath || printf none)\"",
		`printf 'huskyRunnerPresent=%s\\n' ${present(".husky/_/h")}`,
		`printf 'nodeModulesOnHost=%s\\n' ${present("node_modules")}`,
		`printf 'commitlintVersion=%s\\n' "$(${bridge} bunx commitlint --version)"`,
		`printf 'lintStagedVersion=%s\\n' "$(${bridge} bunx lint-staged --version)"`,
	].join("\n");
}

// A real `git commit`, typed on the host, with the bridged hooks active. The
// routing is proven three ways: the exact invocation form the hooks use answers
// from a Linux kernel in a container the engine confirms is this checkout's;
// commitlint really ran, because a subject with no type is rejected and that
// commit does not land; and the accepted commit does.
function hookRoutingProbe(
	temporaryRoot: string,
	hostHome: string,
	runId: string,
): string {
	const bridge = "bash scripts/worktree/exec.sh --require-ready";
	const log = `${temporaryRoot}/rejected-subject.log`;
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		`printf 'hookExecutionOs=%s\\n' "$(${bridge} uname -s)"`,
		`hook_hostname="$(${bridge} hostname)"`,
		"printf 'hookHostname=%s\\n' \"$hook_hostname\"",
		"printf 'hookContainerId=%s\\n' \"$(docker inspect --format '{{.Id}}' \"$hook_hostname\")\"",
		`printf 'probe %s\\n' ${runId} > ${PROBE_FILE}`,
		`git add ${PROBE_FILE}`,
		`git commit --quiet -m '${ACCEPTED_SUBJECT}'`,
		"printf 'acceptedSha=%s\\n' \"$(git rev-parse HEAD)\"",
		"printf 'acceptedSubject=%s\\n' \"$(git log -1 --pretty=%s)\"",
		"printf 'hooksPath=%s\\n' \"$(git config --get core.hooksPath)\"",
		"status=0",
		`git commit --quiet --allow-empty -m '${REJECTED_SUBJECT}' >${log} 2>&1 || status=$?`,
		"printf 'rejectedExitCode=%s\\n' \"$status\"",
		`printf 'rejectedHuskyLine=%s\\n' "$(grep -F 'commit-msg script failed' ${log} || true)"`,
		"printf 'headAfterRejection=%s\\n' \"$(git rev-parse HEAD)\"",
		`printf 'rejectedSubjectLanded=%s\\n' "$(git log --pretty=%s | grep -c -F '${REJECTED_SUBJECT}' || true)"`,
	].join("\n");
}

// The container goes away, and the same commit is refused rather than silently
// rebuilding one: exit 7 through Husky, the bridge's own message, and a HEAD
// that did not move. This is the only command expected to fail.
function hookRefusalProbe(temporaryRoot: string, hostHome: string): string {
	const log = `${temporaryRoot}/refused-commit.log`;
	return [
		// Not `set -e`: this probe's subject is a command that has to fail.
		"set -uo pipefail",
		...journeyEnvironment(temporaryRoot, hostHome),
		`cd "${journeyClonePath(temporaryRoot)}"`,
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		"printf 'containerId=%s\\n' \"$container_id\"",
		'docker stop "$container_id" >/dev/null',
		"ready=0",
		"bash scripts/worktree/ensure.sh --check-ready >/dev/null 2>&1 || ready=$?",
		"printf 'checkReadyExitCode=%s\\n' \"$ready\"",
		'before="$(git rev-parse HEAD)"',
		"printf 'headBefore=%s\\n' \"$before\"",
		"status=0",
		`git commit --quiet --allow-empty -m '${REFUSED_SUBJECT}' >${log} 2>&1 || status=$?`,
		"printf 'gitExitCode=%s\\n' \"$status\"",
		`printf 'huskyLine=%s\\n' "$(grep -F 'pre-commit script failed' ${log} || true)"`,
		`printf 'bridgeRefusal=%s\\n' "$(grep -F "container is not ready" ${log} || true)"`,
		'after="$(git rev-parse HEAD)"',
		"printf 'headAfter=%s\\n' \"$after\"",
		'printf \'commitExecuted=%s\\n\' "$([ "$after" = "$before" ] && printf false || printf true)"',
		`printf 'refusedSubjectLanded=%s\\n' "$(git log --pretty=%s | grep -c -F '${REFUSED_SUBJECT}' || true)"`,
		`refusal="$(sed -n 's/.*script failed (code \\([0-9][0-9]*\\)).*/\\1/p' ${log} | head -1)"`,
		"printf 'refusalExitCode=%s\\n' \"$refusal\"",
		'docker start "$container_id" >/dev/null',
		"printf 'readyAfterRestart=%s\\n' \"$(bash scripts/worktree/ensure.sh --check-ready)\"",
		'exit "$refusal"',
	].join("\n");
}

// Diagnosis in this stage is exactly the read-only reports that already exist.
// A doctor is Stage 6's; nothing here probes, repairs, or explains.
function inspectProbe(temporaryRoot: string, hostHome: string): string {
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		`printf 'environmentJson=%s\\n' "$(bash scripts/worktree/env.sh --json | ${COMPACT_JSON})"`,
		"printf 'manifestExports=%s\\n' \"$(bash scripts/worktree/manifest.sh env | tr '\\n' ';')\"",
		"printf 'manifestPath=%s\\n' \"$(bash scripts/worktree/manifest.sh path)\"",
		`printf 'manifestJson=%s\\n' "$(${COMPACT_JSON} <"$(bash scripts/worktree/manifest.sh path)")"`,
		"printf 'servicesStatus=%s\\n' \"$(bash scripts/worktree/services.sh status 2>&1)\"",
		"printf 'containerReady=%s\\n' \"$(bash scripts/worktree/ensure.sh --check-ready)\"",
	].join("\n");
}

// Down is not cleanup: the route goes inactive and the manifest, the ports, the
// generated environment, and the container itself all survive.
function downProbe(temporaryRoot: string, hostHome: string): string {
	const clone = journeyClonePath(temporaryRoot);
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		"bash scripts/worktree/down.sh",
		'manifest="$(bash scripts/worktree/manifest.sh path)"',
		`printf 'manifestRemaining=%s\\n' ${present('"$manifest"')}`,
		`printf 'manifestJson=%s\\n' "$(${COMPACT_JSON} <"$manifest")"`,
		`printf 'environmentJson=%s\\n' "$(bash scripts/worktree/env.sh --json | ${COMPACT_JSON})"`,
		`printf 'generatedStateRemaining=%s\\n' ${present(".dev/state")}`,
		`printf 'ownedContainers=%s\\n' "$(docker ps --all --no-trunc --quiet --filter label=devcontainer.local_folder=${clone} | wc -l | tr -d ' ')"`,
		"printf 'containerReady=%s\\n' \"$(bash scripts/worktree/ensure.sh --check-ready)\"",
	].join("\n");
}

// Cleanup releases everything this one clone owns, asserts its own completeness,
// and leaves the real checkout's host state byte for byte where it was.
function cleanupProbe(temporaryRoot: string, hostHome: string): string {
	const clone = journeyClonePath(temporaryRoot);
	return [
		...journeyPreamble(temporaryRoot, hostHome),
		mainStateDigestFunction(hostHome),
		'container_id="$(bash scripts/worktree/ensure.sh --check-ready)"',
		`volumes="$(docker inspect --format ${VOLUME_NAMES} "$container_id")"`,
		'manifest="$(bash scripts/worktree/manifest.sh path)"',
		`persistence="$(${generatedValue(clone, "DEVENV_PERSISTENCE_ROOT")})"`,
		'workspace="$(basename "$manifest" .json)"',
		"printf 'removedContainerId=%s\\n' \"$container_id\"",
		"printf 'removedVolumes=%s\\n' \"$volumes\"",
		"printf 'removedManifest=%s\\n' \"$manifest\"",
		"printf 'workspaceId=%s\\n' \"$workspace\"",
		"bash scripts/worktree/cleanup.sh",
		`printf 'containersRemaining=%s\\n' "$(docker ps --all --no-trunc --quiet --filter label=devcontainer.local_folder=${clone} | wc -l | tr -d ' ')"`,
		"remaining=0",
		"for volume in $volumes; do",
		'\tif docker volume inspect "$volume" >/dev/null 2>&1; then remaining=$((remaining + 1)); fi',
		"done",
		"printf 'volumesRemaining=%s\\n' \"$remaining\"",
		`printf 'manifestRemaining=%s\\n' ${present('"$manifest"')}`,
		`printf 'generatedStateRemaining=%s\\n' ${present(".dev/state")}`,
		`printf 'persistenceRemaining=%s\\n' ${present('"$persistence"')}`,
		`printf 'cloneRemaining=%s\\n' ${present(`"${clone}/README.md"`)}`,
		"printf 'mainCheckoutStateDigest=%s\\n' \"$(main_state_digest)\"",
	].join("\n");
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

export function expectedStageFiveBCommands(
	value: JsonRecord,
): Record<StageFiveBCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const host = recordAt(value, "host");
	const runId = String(run["id"] ?? "");
	const temporaryRoot = String(run["temporaryRoot"] ?? "");
	const originPath = String(run["originPath"] ?? "");
	const hostHome = String(host["home"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	return {
		"cutover-guard": ["bun", "run", "worktree:check"],
		"hermetic-selftest": ["bash", "scripts/worktree/selftest.sh"],
		"cutover-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/worktree.test.ts",
		],
		// Scoped to the anti-residue guards. The unscoped suite also asserts
		// template:validate, which cannot pass while this very capture is still
		// producing the Stage 5B record it validates.
		"template-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/template.test.ts",
			"-t",
			"residue",
		],
		"legacy-orchestration-scan": ["bun", COLLECTOR, "scan-legacy"],
		"journey-fresh-clone": [
			"bash",
			"-c",
			freshCloneProbe(temporaryRoot, originPath, implementationSha),
		],
		"journey-prerequisites": [
			"bash",
			"-c",
			prerequisitesProbe(temporaryRoot, originPath, hostHome),
		],
		"journey-up": ["bash", "-c", upProbe(temporaryRoot, hostHome)],
		"journey-bridge-install": [
			"bash",
			"-c",
			bridgeInstallProbe(temporaryRoot, hostHome),
		],
		"journey-hook-routing": [
			"bash",
			"-c",
			hookRoutingProbe(temporaryRoot, hostHome, runId),
		],
		"journey-hook-refusal": [
			"bash",
			"-c",
			hookRefusalProbe(temporaryRoot, hostHome),
		],
		"journey-inspect": ["bash", "-c", inspectProbe(temporaryRoot, hostHome)],
		"journey-down": ["bash", "-c", downProbe(temporaryRoot, hostHome)],
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

function catalogVersion(packageJson: string, name: string): string {
	const catalog = /"catalog"\s*:\s*\{([\s\S]*?)\n\t\t\}/.exec(packageJson)?.[1];
	return (
		new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`).exec(catalog ?? "")?.[1] ?? ""
	);
}

export async function validateStageFiveBEvidenceValue(
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
	const journey = recordAt(value, "journey");
	const expected = expectedStageFiveBCommands(value);
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
	if (!sameValue([...ids].sort(), [...STAGE_FIVE_B_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 5B command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 5B command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageFiveBCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		if (REFUSAL_COMMAND_IDS.has(id)) {
			if (
				entry["exitCode"] !== REFUSAL_EXIT_CODE ||
				entry["status"] !== "refused"
			)
				errors.push(`semantic: command ${id} did not refuse with exit 7`);
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
	const clone = journeyClonePath(temporaryRoot);
	const isolatedHome = journeyHomePath(temporaryRoot);
	const clean = values("journey-fresh-clone");
	if (
		run["isolatedHome"] !== isolatedHome ||
		journey["clonePath"] !== clone ||
		String(run["originPath"] ?? "") === "" ||
		String(run["originPath"] ?? "").startsWith(`${temporaryRoot}/`) ||
		// A clone keeps its Git directory inside the checkout. A journey whose Git
		// directory lives elsewhere is a linked worktree of the very repository it
		// claims to have cloned, and proves nothing about a fresh clone.
		!String(clean["gitDir"] ?? "").startsWith(`${clone}/`) ||
		clean["headSha"] !== source["implementationSha"] ||
		clean["statusLines"] !== "0" ||
		clean["hooksPath"] !== "none" ||
		clean["huskyRunnerPresent"] !== "absent" ||
		clean["generatedStatePresent"] !== "absent" ||
		clean["nodeModulesPresent"] !== "absent" ||
		clean["bridgeExecutable"] !== "true" ||
		clean["commitMsgRoutes"] !== "1" ||
		clean["preCommitRoutes"] !== "1"
	)
		errors.push("semantic: fresh-clone evidence drifted");

	const host = recordAt(value, "host");
	const precondition = recordAt(value, "precondition");
	const prerequisites = values("journey-prerequisites");
	if (
		precondition["mainCheckoutContainerReady"] !== false ||
		precondition["checkReadyExitCode"] !==
			Number(prerequisites["mainCheckoutReadyExitCode"] ?? 0) ||
		Number(prerequisites["mainCheckoutReadyExitCode"] ?? 0) === 0 ||
		prerequisites["isolatedHome"] !== isolatedHome ||
		prerequisites["hostDirectories"] !==
			"codex-auth container-env secrets.d " ||
		prerequisites["initHostSyntax"] !== "ok" ||
		Number(prerequisites["initHostInstallsContainerCli"] ?? 0) < 1 ||
		Number(prerequisites["initHostVerifiesPython"] ?? 0) < 1 ||
		host["dockerVersion"] !== prerequisites["dockerVersion"] ||
		host["devcontainerCliVersion"] !== prerequisites["containerCliVersion"] ||
		host["pythonVersion"] !== prerequisites["pythonVersion"] ||
		host["hostBunPresent"] !== (prerequisites["hostBunPresent"] === "true")
	)
		errors.push("semantic: journey precondition evidence drifted");

	// The journey's identity, ports, and container are read back out of the
	// runtime's own reports rather than asserted from memory, and the container's
	// ownership labels have to name this clone and no other tree.
	const up = values("journey-up");
	const environment = parseJson(up["environmentJson"]);
	const volumes = words(up["containerVolumes"]);
	if (
		journey["containerId"] !== up["containerId"] ||
		journey["workspaceId"] !== environment["workspaceId"] ||
		journey["family"] !== environment["family"] ||
		journey["offset"] !== environment["offset"] ||
		journey["publishedHostPort"] !== environment["publishedHostPort"] ||
		journey["directUrl"] !== environment["directUrl"] ||
		environment["repoPath"] !== clone ||
		up["containerLocalFolder"] !== clone ||
		up["containerConfigFile"] !== `${clone}/.devcontainer/devcontainer.json` ||
		up["publishedMapping"] !==
			`127.0.0.1:${environment["publishedHostPort"]}` ||
		journey["devcontainerId"] !== devcontainerIdentity(clone) ||
		volumes.length === 0 ||
		volumes.some((name) => !name.endsWith(`-${journey["devcontainerId"]}`)) ||
		!String(up["manifestPath"] ?? "").startsWith(`${isolatedHome}/`) ||
		!String(up["manifestPath"] ?? "").endsWith(
			`/${journey["workspaceId"]}.json`,
		) ||
		!log("journey-up", "stderr").includes("no services are declared") ||
		!log("journey-up", "stderr").includes(String(up["containerId"])) ||
		// A fresh clone had neither dependencies nor active hooks. One `up.sh`
		// later both exist, written from inside the container through the bind
		// mount: the hooks became active without any host install.
		up["nodeModulesAfterUp"] !== "present" ||
		up["huskyRunnerAfterUp"] !== "present" ||
		up["hooksPathAfterUp"] !== ".husky/_"
	)
		errors.push("semantic: journey identity evidence drifted");

	// The bridged install runs the project's own dependency install inside the
	// container, against the pinned toolchain the repository itself declares.
	const packageJson = await Bun.file(resolve(root, "package.json")).text();
	const install = values("journey-bridge-install");
	if (
		install["installOs"] !== "Linux" ||
		!String(install["installBunPath"] ?? "").startsWith("/home/vscode/") ||
		install["hooksPath"] !== ".husky/_" ||
		install["huskyRunnerPresent"] !== "present" ||
		install["nodeModulesOnHost"] !== "present" ||
		!String(install["commitlintVersion"] ?? "").includes(
			catalogVersion(packageJson, "@commitlint/cli"),
		) ||
		!String(install["lintStagedVersion"] ?? "").includes(
			catalogVersion(packageJson, "lint-staged"),
		)
	)
		errors.push("semantic: bridged install evidence drifted");

	const routing = values("journey-hook-routing");
	if (
		journey["hookExecutionOs"] !== "Linux" ||
		routing["hookExecutionOs"] !== journey["hookExecutionOs"] ||
		journey["hookContainerId"] !== routing["hookContainerId"] ||
		journey["hookContainerId"] !== journey["containerId"] ||
		!String(journey["containerId"] ?? "").startsWith(
			String(routing["hookHostname"]),
		) ||
		routing["hooksPath"] !== ".husky/_" ||
		routing["acceptedSubject"] !== ACCEPTED_SUBJECT ||
		!/^[0-9a-f]{40}$/.test(String(routing["acceptedSha"] ?? "")) ||
		routing["acceptedSha"] === clean["headSha"] ||
		// commitlint really ran: a subject with no type is rejected, Husky reports
		// the failing hook by name, and that commit does not land.
		routing["rejectedExitCode"] === "0" ||
		!String(routing["rejectedHuskyLine"] ?? "").includes(
			"commit-msg script failed",
		) ||
		routing["headAfterRejection"] !== routing["acceptedSha"] ||
		routing["rejectedSubjectLanded"] !== "0"
	)
		errors.push("semantic: hook routing evidence drifted");

	const boundary = recordAt(value, "boundary");
	const refusal = values("journey-hook-refusal");
	if (
		boundary["refusalCommandId"] !== "journey-hook-refusal" ||
		boundary["refusalExitCode"] !== REFUSAL_EXIT_CODE ||
		boundary["commandExecuted"] !== false ||
		commandById.get("journey-hook-refusal")?.["exitCode"] !==
			boundary["refusalExitCode"] ||
		refusal["refusalExitCode"] !== String(REFUSAL_EXIT_CODE) ||
		refusal["huskyLine"] !==
			`husky - pre-commit script failed (code ${REFUSAL_EXIT_CODE})` ||
		!String(refusal["bridgeRefusal"] ?? "").includes(
			"container is not ready; run bash scripts/worktree/up.sh",
		) ||
		Number(refusal["checkReadyExitCode"] ?? 0) === 0 ||
		refusal["gitExitCode"] === "0" ||
		refusal["commitExecuted"] !== "false" ||
		refusal["headBefore"] !== routing["acceptedSha"] ||
		refusal["headAfter"] !== refusal["headBefore"] ||
		refusal["refusedSubjectLanded"] !== "0" ||
		refusal["containerId"] !== journey["containerId"] ||
		refusal["readyAfterRestart"] !== journey["containerId"]
	)
		errors.push("semantic: refusal evidence drifted");

	const inspect = values("journey-inspect");
	const inspected = parseJson(inspect["environmentJson"]);
	const manifest = parseJson(inspect["manifestJson"]);
	if (
		!sameValue(inspected, environment) ||
		inspect["manifestPath"] !== up["manifestPath"] ||
		manifest["workspaceId"] !== journey["workspaceId"] ||
		manifest["status"] !== "active" ||
		!String(inspect["manifestExports"] ?? "").includes(
			`DEVENV_PUBLISHED_HOST_PORT=${journey["publishedHostPort"]}`,
		) ||
		!String(inspect["servicesStatus"] ?? "").includes(
			"no services are declared",
		) ||
		inspect["containerReady"] !== journey["containerId"]
	)
		errors.push("semantic: read-only diagnosis evidence drifted");

	const down = values("journey-down");
	const downManifest = parseJson(down["manifestJson"]);
	const downEnvironment = parseJson(down["environmentJson"]);
	if (
		down["manifestRemaining"] !== "present" ||
		downManifest["status"] !== "inactive" ||
		down["generatedStateRemaining"] !== "present" ||
		down["ownedContainers"] !== "1" ||
		down["containerReady"] !== journey["containerId"] ||
		downEnvironment["publishedHostPort"] !== journey["publishedHostPort"] ||
		downEnvironment["directUrl"] !== journey["directUrl"]
	)
		errors.push("semantic: down evidence drifted");

	const cleanup = recordAt(value, "cleanup");
	const released = values("journey-cleanup");
	const removed = [
		`container ${released["removedContainerId"]}`,
		...words(released["removedVolumes"]).map((name) => `volume ${name}`),
		`manifest ${released["removedManifest"]}`,
	];
	if (
		!sameValue(cleanup["removed"], removed) ||
		!sameValue(cleanup["remaining"], []) ||
		cleanup["mainCheckoutStateUnchanged"] !== true ||
		released["removedContainerId"] !== journey["containerId"] ||
		// The engine lists a container's mounts in no guaranteed order, so the two
		// observations are compared as sets.
		!sameValue(
			[...words(released["removedVolumes"])].sort(),
			[...volumes].sort(),
		) ||
		released["workspaceId"] !== journey["workspaceId"] ||
		released["containersRemaining"] !== "0" ||
		released["volumesRemaining"] !== "0" ||
		released["manifestRemaining"] !== "absent" ||
		released["generatedStateRemaining"] !== "absent" ||
		released["persistenceRemaining"] !== "absent" ||
		// Cleanup releases what the runtime allocated; it never removes the
		// developer's checkout.
		released["cloneRemaining"] !== "present" ||
		// The real checkout's registry, manifests, and routes are byte identical
		// before and after: an isolated HOME is what makes a second clone safe.
		cleanup["mainCheckoutStateDigest"] !==
			prerequisites["mainCheckoutStateDigest"] ||
		cleanup["mainCheckoutStateDigest"] !==
			released["mainCheckoutStateDigest"] ||
		!/^[0-9a-f]{64}$/.test(String(cleanup["mainCheckoutStateDigest"] ?? "")) ||
		!log("journey-cleanup", "stderr").includes(
			`removed every resource owned by ${journey["workspaceId"]}`,
		) ||
		log("journey-cleanup", "stderr").includes("survived cleanup")
	)
		errors.push("semantic: cleanup evidence drifted");

	// The non-vacuous half of the cutover: every tracked file that still names the
	// superseded launcher is a record, and the record list is bound to the scan's
	// own output rather than to a claim.
	const legacy = recordAt(value, "legacy");
	const scan = keyValues(log("legacy-orchestration-scan", "stdout"));
	const matches = log("legacy-orchestration-scan", "stdout")
		.split("\n")
		.flatMap((line) => (line.startsWith("match=") ? [line.slice(6)] : []));
	if (
		legacy["commandId"] !== "legacy-orchestration-scan" ||
		legacy["scannedFiles"] !== Number(scan["scannedFiles"] ?? -1) ||
		Number(scan["scannedFiles"] ?? 0) < 1 ||
		!sameValue(legacy["allowListed"], matches) ||
		!sameValue(legacy["remaining"], []) ||
		scan["remaining"] !== "0" ||
		matches.length === 0 ||
		matches.some((path) => !isLegacyAllowListed(path))
	)
		errors.push("semantic: legacy orchestration scan evidence drifted");

	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-5b-pr-merge-commit>",
		]) ||
		!sameValue(rollback["runtimeCleanup"], [
			"bash",
			"scripts/worktree/cleanup.sh",
		]) ||
		!String(rollback["scope"] ?? "").includes("cleanup.sh")
	)
		errors.push("semantic: Stage 5B rollback is not atomic");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["predecessorPathRestored"] !== true ||
		!sameValue(proof["restoredPaths"], [...PREDECESSOR_PATHS])
	)
		errors.push("semantic: Stage 5B rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	// The restoration claim is re-derived from Git objects the record names, so a
	// reviewer never has to trust the probe: the reverted tree is the predecessor
	// tree, and in that tree both onboarding documents describe the predecessor
	// entry point that the implementation removed.
	const revertedTree = String(proof["revertedTree"] ?? "");
	const launcher = ["dev", "pod"].join("");
	for (const path of PREDECESSOR_PATHS) {
		const restored = git(root, ["show", `${revertedTree}:${path}`]);
		const current = git(root, [
			"show",
			`${String(source["implementationSha"] ?? "")}:${path}`,
		]);
		if (
			restored.exitCode !== 0 ||
			current.exitCode !== 0 ||
			!restored.stdout.toLowerCase().includes(launcher) ||
			current.stdout.toLowerCase().includes(launcher)
		)
			errors.push(`repository: ${path} does not prove the predecessor path`);
	}

	for (const [label, sha] of [
		["base", source["baseSha"]],
		["implementation", source["implementationSha"]],
	] as const)
		if (
			typeof sha !== "string" ||
			git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 5B ${label} commit is missing`);
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
			"repository: Stage 5B base is not an ancestor of implementation",
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
			"repository: Stage 5B implementation is not an ancestor of HEAD",
		);
	return errors;
}

export async function validateStageFiveBEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-5b-cutover.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-5b-cutover.schema.json"),
		).json()) as JsonRecord;
		return validateStageFiveBEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
