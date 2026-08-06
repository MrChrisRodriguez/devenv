// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_FIVE_COMMAND_IDS = [
	"contract-guard",
	"hermetic-selftest",
	"contract-known-bad-fixtures",
	"template-known-bad-fixtures",
	"worktree-a-environment",
	"worktree-b-environment",
	"worktree-a-ensure-cold",
	"worktree-b-ensure-cold",
	"worktree-a-ensure-warm",
	// Runs against worktree B so the recreate never disturbs the worktree whose
	// route, persistence, and bridge every later command depends on.
	"recreate-fast-path",
	"git-operations",
	"ownership-attack-refusal",
	"route-probe",
	"persistence-probe",
	"authentication-round-trip",
	"volume-identity",
	"bridge-dispatch",
	"cleanup-isolation",
	"rollback-proof",
] as const;

export type StageFiveCommandId = (typeof STAGE_FIVE_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-5-worktree-run";
const CONTRACT_PATH = "scripts/worktree/contract.toml";
const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const WORKTREE_NAMES = ["alpha", "beta"] as const;
// The one command that exists to prove a refusal. Every other command must exit
// zero, so a refusal can never be smuggled in as a pass or the reverse.
const REFUSAL_COMMAND_IDS = new Set<string>(["ownership-attack-refusal"]);
const ROUTE_TOKEN = "stage5a-route-ok";
const CREDENTIAL_DIRECTORY = "/home/vscode/.config/devcontainer/codex-auth";
const SESSION_DIRECTORY = "/home/vscode/.codex";

function worktreePath(temporaryRoot: string, index: number): string {
	return `${temporaryRoot}/${WORKTREE_NAMES[index] ?? "alpha"}`;
}

// Read one value out of a worktree's generated environment using the runtime's
// own contract reader, so a probe never hardcodes a generated path.
function generatedValue(worktree: string, key: string): string {
	return [
		'bash -c \'. "$1/scripts/worktree/lib.sh";',
		'wt_env_file_value "$REPO_ROOT/$(wt_contract_value generated_environment)" "$2"\'',
		`bash ${worktree} ${key}`,
	].join(" ");
}

const VOLUME_NAMES =
	"'{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Name}} {{end}}{{end}}'";

function environmentProbe(worktree: string): string {
	return [
		"set -euo pipefail",
		`bash ${worktree}/scripts/worktree/env.sh`,
		// --json never allocates: it reports the environment that now exists.
		`bash ${worktree}/scripts/worktree/env.sh --json`,
	].join("\n");
}

function ensureProbe(worktree: string): string {
	return [
		"set -euo pipefail",
		`printf 'definitionFingerprint=%s\\n' "$(bash ${worktree}/scripts/worktree/ensure.sh --definition-fingerprint)"`,
		`printf 'containerId=%s\\n' "$(bash ${worktree}/scripts/worktree/ensure.sh)"`,
	].join("\n");
}

// A definition change must recreate rather than reuse, a restored definition
// must recreate back, and the fast path must then answer without another `up`.
function recreateProbe(worktree: string): string {
	const ensure = `bash ${worktree}/scripts/worktree/ensure.sh`;
	return [
		"set -euo pipefail",
		`config=${worktree}/${DEVCONTAINER_PATH}`,
		`printf 'beforeContainerId=%s\\n' "$(${ensure})"`,
		`printf 'beforeFingerprint=%s\\n' "$(${ensure} --definition-fingerprint)"`,
		"printf '\\n' >>\"$config\"",
		`printf 'changedFingerprint=%s\\n' "$(${ensure} --definition-fingerprint)"`,
		`printf 'recreatedContainerId=%s\\n' "$(${ensure})"`,
		`git -C ${worktree} checkout -- ${DEVCONTAINER_PATH}`,
		`printf 'restoredFingerprint=%s\\n' "$(${ensure} --definition-fingerprint)"`,
		`printf 'restoredContainerId=%s\\n' "$(${ensure})"`,
		`printf 'readyContainerId=%s\\n' "$(${ensure} --check-ready)"`,
	].join("\n");
}

// Git inside the container has to resolve the pointer a linked worktree's `.git`
// file records, which only works because the shared Git common directory is
// mounted at the very path it has on the host. The tag round trip proves that
// mount is writable, not merely readable.
function gitOperationsProbe(worktree: string, runId: string): string {
	const bridge = `bash ${worktree}/scripts/worktree/exec.sh`;
	const tag = `${runId}-probe`;
	return [
		"set -euo pipefail",
		`cd ${worktree}`,
		`printf 'headSha=%s\\n' "$(${bridge} git rev-parse HEAD)"`,
		`printf 'commonDir=%s\\n' "$(${bridge} git rev-parse --path-format=absolute --git-common-dir)"`,
		`printf 'statusLines=%s\\n' "$(${bridge} git status --porcelain | wc -l | tr -d ' ')"`,
		`${bridge} git tag ${tag}`,
		`printf 'tagVisibleOnHost=%s\\n' "$(git -C ${worktree} tag --list ${tag} | wc -l | tr -d ' ')"`,
		`${bridge} git tag -d ${tag} >/dev/null`,
		`printf 'tagRemoved=%s\\n' "$(git -C ${worktree} tag --list ${tag} | wc -l | tr -d ' ')"`,
	].join("\n");
}

// A running container that carries this checkout's local_folder label but a
// foreign config_file label must be refused, and the command the caller asked
// for must provably never run inside it. The decoy is removed either way.
function ownershipAttackProbe(
	alpha: string,
	runId: string,
	image: string,
): string {
	const name = `${runId}-decoy`;
	const sentinel = "/tmp/stage5a-ownership-sentinel";
	return [
		"set -uo pipefail",
		`run_dir=${alpha}/.dev/state/run`,
		`docker rm --force ${name} >/dev/null 2>&1 || true`,
		`decoy="$(docker run --detach --name ${name} \\`,
		`  --label devenv.stage5a.run=${runId} \\`,
		`  --label devcontainer.local_folder=${alpha} \\`,
		`  --label devcontainer.config_file=${alpha}/.devcontainer/impostor.json \\`,
		`  ${image} sleep 900)"`,
		"printf 'decoyContainerId=%s\\n' \"$decoy\"",
		'genuine="$(cat "$run_dir/container.id")"',
		"printf 'genuineContainerId=%s\\n' \"$genuine\"",
		`fingerprint="$(bash ${alpha}/scripts/worktree/ensure.sh --definition-fingerprint)"`,
		'cp "$run_dir/container.id" "$run_dir/container.id.backup"',
		'cp "$run_dir/container.ready" "$run_dir/container.ready.backup"',
		'printf \'%s\\n\' "$decoy" >"$run_dir/container.id"',
		'printf \'%s %s\\n\' "$decoy" "$fingerprint" >"$run_dir/container.ready"',
		"status=0",
		`accepted="$(bash ${alpha}/scripts/worktree/ensure.sh --check-ready 2>/dev/null)" || status=$?`,
		"printf 'checkReadyExitCode=%s\\n' \"$status\"",
		"printf 'acceptedContainerId=%s\\n' \"$accepted\"",
		`docker exec "$decoy" rm -f ${sentinel} >/dev/null 2>&1 || true`,
		"bridge=0",
		`(cd ${alpha} && bash scripts/worktree/exec.sh sh -c 'printf %s ${runId} > ${sentinel}') >/dev/null 2>&1 || bridge=$?`,
		"printf 'bridgeExitCode=%s\\n' \"$bridge\"",
		"executed=true",
		`if ! docker exec "$decoy" test -e ${sentinel} >/dev/null 2>&1; then executed=false; fi`,
		"printf 'commandExecuted=%s\\n' \"$executed\"",
		'reconciled="$(cat "$run_dir/container.id")"',
		"printf 'reconciledContainerId=%s\\n' \"$reconciled\"",
		'if [ "$reconciled" = "$genuine" ]; then',
		'\trm -f "$run_dir/container.id.backup" "$run_dir/container.ready.backup"',
		"else",
		'\tmv -f "$run_dir/container.id.backup" "$run_dir/container.id"',
		'\tmv -f "$run_dir/container.ready.backup" "$run_dir/container.ready"',
		"fi",
		'docker rm --force "$decoy" >/dev/null 2>&1 || true',
		'exit "$status"',
	].join("\n");
}

// The template declares no services, so the probe supplies the one thing a route
// needs: something answering on the published container port. The body, not the
// status code, is what proves the response came from this container.
function routeProbe(worktree: string, prefix: string): string {
	const bridge = `bash ${worktree}/scripts/worktree/exec.sh`;
	return [
		"set -euo pipefail",
		`cd ${worktree}`,
		"bash scripts/worktree/up.sh",
		'eval "$(bash scripts/worktree/manifest.sh env)"',
		"cat >\".dev/stage5a-route.js\" <<'JS'",
		`Bun.serve({ port: 8080, hostname: "0.0.0.0", fetch: () => new Response("${ROUTE_TOKEN}\\n") });`,
		"JS",
		`${bridge} bash -c "setsid nohup bun /workspace/.dev/stage5a-route.js >/tmp/stage5a-route.log 2>&1 </dev/null & sleep 2"`,
		"body=",
		"for attempt in 1 2 3 4 5 6 7 8 9 10; do",
		`\tbody="$(curl --silent --fail --max-time 5 "$${prefix}_DIRECT_URL/" || true)"`,
		`\tcase "$body" in *${ROUTE_TOKEN}*) break ;; esac`,
		"\tsleep 2",
		"done",
		`printf 'directUrl=%s\\n' "$${prefix}_DIRECT_URL"`,
		"printf 'directBody=%s\\n' \"$body\"",
		"resolution=dns",
		`friendly="$(curl --silent --fail --max-time 5 "$${prefix}_FRIENDLY_URL/" || true)"`,
		'if [ -z "$friendly" ]; then',
		"\tresolution=resolve-override",
		`\tfriendly="$(curl --silent --fail --max-time 5 --resolve "$${prefix}_FRIENDLY_HOST:80:127.0.0.1" "$${prefix}_FRIENDLY_URL/" || true)"`,
		"fi",
		`printf 'friendlyUrl=%s\\n' "$${prefix}_FRIENDLY_URL"`,
		"printf 'friendlyBody=%s\\n' \"$friendly\"",
		"printf 'friendlyResolution=%s\\n' \"$resolution\"",
		"printf 'caddyAvailable=%s\\n' \"$(command -v caddy >/dev/null 2>&1 && printf true || printf false)\"",
		'manifest="$(bash scripts/worktree/manifest.sh path)"',
		"printf 'manifestPath=%s\\n' \"$manifest\"",
		'printf \'manifestStatus=%s\\n\' "$(python3 -c \'import json,sys; print(json.load(open(sys.argv[1]))["status"])\' "$manifest")"',
	].join("\n");
}

// Each checkout owns its own data root, and the container writes into the very
// directory the host sees, because the checkout is the bind mount.
function persistenceProbe(
	alpha: string,
	beta: string,
	prefix: string,
	runId: string,
): string {
	const write = (worktree: string, token: string) =>
		`(cd ${worktree} && bash scripts/worktree/exec.sh sh -c 'mkdir -p "$${prefix}_PERSISTENCE_ROOT" && printf %s ${token} > "$${prefix}_PERSISTENCE_ROOT/stage5a-probe"')`;
	// No leading parenthesis: `$((` would open an arithmetic expansion.
	const read = (worktree: string) =>
		`cd ${worktree} && bash scripts/worktree/exec.sh sh -c 'cat "$${prefix}_PERSISTENCE_ROOT/stage5a-probe"'`;
	return [
		"set -euo pipefail",
		`alpha_root="$(${generatedValue(alpha, `${prefix}_PERSISTENCE_ROOT`)})"`,
		`beta_root="$(${generatedValue(beta, `${prefix}_PERSISTENCE_ROOT`)})"`,
		"printf 'alphaPersistenceRoot=%s\\n' \"$alpha_root\"",
		"printf 'betaPersistenceRoot=%s\\n' \"$beta_root\"",
		write(alpha, `${runId}-alpha`),
		write(beta, `${runId}-beta`),
		'printf \'alphaOnHost=%s\\n\' "$(cat "$alpha_root/stage5a-probe")"',
		'printf \'betaOnHost=%s\\n\' "$(cat "$beta_root/stage5a-probe")"',
		`printf 'alphaInContainer=%s\\n' "$(${read(alpha)})"`,
		`printf 'betaInContainer=%s\\n' "$(${read(beta)})"`,
	].join("\n");
}

// The credential surface is a host bind mount shared by every checkout of the
// project; the agent home beside it is a per-checkout volume. A login therefore
// crosses worktrees while live session state does not.
function authenticationProbe(
	alpha: string,
	beta: string,
	runId: string,
): string {
	const credential = `${CREDENTIAL_DIRECTORY}/${runId}.json`;
	const marker = `${SESSION_DIRECTORY}/${runId}.marker`;
	const mountSource = (worktree: string) =>
		`docker inspect --format '{{range .Mounts}}{{if eq .Destination "${CREDENTIAL_DIRECTORY}"}}{{.Source}}{{end}}{{end}}' "$(bash ${worktree}/scripts/worktree/ensure.sh --check-ready)"`;
	return [
		"set -euo pipefail",
		`(cd ${alpha} && bash scripts/worktree/exec.sh sh -c 'printf %s ${runId} > ${credential}; printf %s alpha > ${marker}')`,
		`printf 'credentialReadByBeta=%s\\n' "$(cd ${beta} && bash scripts/worktree/exec.sh cat ${credential})"`,
		"isolated=true",
		`if (cd ${beta} && bash scripts/worktree/exec.sh test -e ${marker}) >/dev/null 2>&1; then isolated=false; fi`,
		"printf 'sessionStateIsolated=%s\\n' \"$isolated\"",
		`printf 'alphaCredentialSource=%s\\n' "$(${mountSource(alpha)})"`,
		`printf 'betaCredentialSource=%s\\n' "$(${mountSource(beta)})"`,
		`(cd ${alpha} && bash scripts/worktree/exec.sh rm -f ${credential} ${marker})`,
	].join("\n");
}

// The ${devcontainerId} this runtime computes host-side has to be the one the
// container CLI actually used, or cleanup would name volumes that do not exist.
function volumeIdentityProbe(alpha: string, beta: string): string {
	return [
		"set -euo pipefail",
		`alpha_id="$(bash ${alpha}/scripts/worktree/ensure.sh --check-ready)"`,
		`beta_id="$(bash ${beta}/scripts/worktree/ensure.sh --check-ready)"`,
		"printf 'alphaContainerId=%s\\n' \"$alpha_id\"",
		"printf 'betaContainerId=%s\\n' \"$beta_id\"",
		`printf 'alphaVolumes=%s\\n' "$(docker inspect --format ${VOLUME_NAMES} "$alpha_id")"`,
		`printf 'betaVolumes=%s\\n' "$(docker inspect --format ${VOLUME_NAMES} "$beta_id")"`,
	].join("\n");
}

function bridgeProbe(
	alpha: string,
	beta: string,
	prefix: string,
	runId: string,
): string {
	const bridge = `bash ${alpha}/scripts/worktree/exec.sh`;
	return [
		"set -euo pipefail",
		// A nested directory must map to the matching directory in the container.
		`cd ${alpha}/scripts`,
		`printf 'workdir=%s\\n' "$(${bridge} pwd)"`,
		`printf 'user=%s\\n' "$(${bridge} id -un)"`,
		`printf 'argv=%s\\n' "$(${bridge} printf '%s|' one 'two three' 'four"five')"`,
		"status=0",
		`${bridge} sh -c 'exit 42' || status=$?`,
		"printf 'exitStatus=%s\\n' \"$status\"",
		`printf 'workspaceId=%s\\n' "$(${bridge} sh -c 'printf %s "$${prefix}_WORKSPACE_ID"')"`,
		`printf 'bunPath=%s\\n' "$(${bridge} sh -c 'command -v bun')"`,
		`${bridge} sh -c 'printf %s ${runId} > /workspace/.dev/stage5a-bridge'`,
		`printf 'sentinelInAlpha=%s\\n' "$(cat ${alpha}/.dev/stage5a-bridge)"`,
		`printf 'sentinelInBeta=%s\\n' "$([ -e ${beta}/.dev/stage5a-bridge ] && printf present || printf absent)"`,
	].join("\n");
}

// Cleanup is exact target only: everything worktree B owns goes, and everything
// worktree A owns keeps working, including its live route.
function cleanupIsolationProbe(
	alpha: string,
	beta: string,
	prefix: string,
): string {
	const present = (path: string) =>
		`"$([ -e ${path} ] && printf present || printf absent)"`;
	const registryQuery =
		'python3 -c \'import json,sys; print("present" if sys.argv[2] in json.load(open(sys.argv[1]))["entries"] else "absent")\'';
	return [
		"set -euo pipefail",
		`registry="$(bash -c '. "$1/scripts/worktree/lib.sh"; wt_expand_home "$(wt_contract_value registry_directory)"' bash ${alpha})/ports.json"`,
		`alpha_workspace="$(${generatedValue(alpha, `${prefix}_WORKSPACE_ID`)})"`,
		`beta_workspace="$(${generatedValue(beta, `${prefix}_WORKSPACE_ID`)})"`,
		`alpha_manifest="$(bash ${alpha}/scripts/worktree/manifest.sh path)"`,
		`beta_manifest="$(bash ${beta}/scripts/worktree/manifest.sh path)"`,
		`beta_id="$(bash ${beta}/scripts/worktree/ensure.sh --check-ready)"`,
		`beta_volumes="$(docker inspect --format ${VOLUME_NAMES} "$beta_id")"`,
		"printf 'betaWorkspaceId=%s\\n' \"$beta_workspace\"",
		"printf 'betaContainerId=%s\\n' \"$beta_id\"",
		"printf 'betaVolumes=%s\\n' \"$beta_volumes\"",
		"printf 'betaManifest=%s\\n' \"$beta_manifest\"",
		`bash ${beta}/scripts/worktree/cleanup.sh`,
		`printf 'betaContainersRemaining=%s\\n' "$(docker ps --all --no-trunc --quiet --filter label=devcontainer.local_folder=${beta} | wc -l | tr -d ' ')"`,
		"remaining=0",
		"for volume in $beta_volumes; do",
		'\tif docker volume inspect "$volume" >/dev/null 2>&1; then remaining=$((remaining + 1)); fi',
		"done",
		"printf 'betaVolumesRemaining=%s\\n' \"$remaining\"",
		`printf 'betaManifestRemaining=%s\\n' ${present('"$beta_manifest"')}`,
		`printf 'betaStateRemaining=%s\\n' ${present(`${beta}/.dev/state`)}`,
		`printf 'betaRegistryRemaining=%s\\n' "$(${registryQuery} "$registry" "$beta_workspace")"`,
		`printf 'survivorContainerId=%s\\n' "$(bash ${alpha}/scripts/worktree/ensure.sh --check-ready)"`,
		`printf 'survivorManifestRemaining=%s\\n' ${present('"$alpha_manifest"')}`,
		`printf 'survivorRegistryRemaining=%s\\n' "$(${registryQuery} "$registry" "$alpha_workspace")"`,
		`printf 'survivorBody=%s\\n' "$(curl --silent --fail --max-time 5 "$(${generatedValue(alpha, `${prefix}_DIRECT_URL`)})/" || true)"`,
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

function recordsAt(value: JsonRecord, key: string): JsonRecord[] {
	return arrayAt(value, key).filter(isRecord);
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

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// The container CLI's ${devcontainerId}: sha-256 of the compact, sorted JSON of
// the two ownership values, rendered base 32 over 0-9a-v and left padded to 52.
// The runtime computes the same value in python3; this is the reviewer's
// independent answer, and the live capture binds both to Docker's real volumes.
export function devcontainerIdentity(worktree: string): string {
	const payload = JSON.stringify({
		"devcontainer.config_file": `${worktree}/${DEVCONTAINER_PATH}`,
		"devcontainer.local_folder": worktree,
	});
	const alphabet = "0123456789abcdefghijklmnopqrstuv";
	let value = 0n;
	for (const byte of new Bun.CryptoHasher("sha256").update(payload).digest())
		value = (value << 8n) | BigInt(byte);
	let digits = "";
	while (value > 0n) {
		digits = `${alphabet[Number(value % 32n)]}${digits}`;
		value /= 32n;
	}
	return digits.padStart(52, "0");
}

export function expectedStageFiveCommands(
	value: JsonRecord,
): Record<StageFiveCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const contract = recordAt(value, "contract");
	const runId = String(run["id"] ?? "");
	const temporaryRoot = String(run["temporaryRoot"] ?? "");
	const image = String(run["decoyImage"] ?? "");
	const prefix = String(contract["environmentPrefix"] ?? "");
	const alpha = worktreePath(temporaryRoot, 0);
	const beta = worktreePath(temporaryRoot, 1);
	return {
		"contract-guard": ["bun", "run", "worktree:check"],
		"hermetic-selftest": ["bash", "scripts/worktree/selftest.sh"],
		"contract-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/worktree.test.ts",
		],
		// Scoped to the anti-residue guards. The unscoped suite also asserts
		// template:validate, which cannot pass while this very capture is still
		// producing the Stage 5A record it validates.
		"template-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/template.test.ts",
			"-t",
			"residue",
		],
		"worktree-a-environment": ["bash", "-c", environmentProbe(alpha)],
		"worktree-b-environment": ["bash", "-c", environmentProbe(beta)],
		"worktree-a-ensure-cold": ["bash", "-c", ensureProbe(alpha)],
		"worktree-b-ensure-cold": ["bash", "-c", ensureProbe(beta)],
		"worktree-a-ensure-warm": ["bash", "-c", ensureProbe(alpha)],
		"recreate-fast-path": ["bash", "-c", recreateProbe(beta)],
		"git-operations": ["bash", "-c", gitOperationsProbe(alpha, runId)],
		"ownership-attack-refusal": [
			"bash",
			"-c",
			ownershipAttackProbe(alpha, runId, image),
		],
		"route-probe": ["bash", "-c", routeProbe(alpha, prefix)],
		"persistence-probe": [
			"bash",
			"-c",
			persistenceProbe(alpha, beta, prefix, runId),
		],
		"authentication-round-trip": [
			"bash",
			"-c",
			authenticationProbe(alpha, beta, runId),
		],
		"volume-identity": ["bash", "-c", volumeIdentityProbe(alpha, beta)],
		"bridge-dispatch": ["bash", "-c", bridgeProbe(alpha, beta, prefix, runId)],
		"cleanup-isolation": [
			"bash",
			"-c",
			cleanupIsolationProbe(alpha, beta, prefix),
		],
		"rollback-proof": [
			"bun",
			"scripts/template/collect-stage-five-evidence.ts",
			"probe-rollback",
			"--base",
			String(source["baseSha"] ?? ""),
			"--implementation",
			String(source["implementationSha"] ?? ""),
			"--workspace",
			`/tmp/devenv-stage2-${runId}-rollback`,
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
	return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

function contractScalar(source: string, key: string): string {
	const match = new RegExp(
		`^${key}\\s*=\\s*(?:"([^"]*)"|([0-9]+)|(true|false))\\s*$`,
		"m",
	).exec(source);
	return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function declaredServiceCount(contract: string): number {
	const inside = /^services\s*=\s*\[(.*)\]\s*$/m.exec(contract)?.[1] ?? "";
	return [...inside.matchAll(/"[^"]*"/g)].length;
}

function declaredVolumePrefixes(devcontainer: string): string[] {
	const prefixes: string[] = [];
	for (const match of devcontainer.matchAll(
		/source=([A-Za-z0-9][A-Za-z0-9_.-]*)-\$\{devcontainerId\}/g,
	))
		if (match[1] && !prefixes.includes(match[1])) prefixes.push(match[1]);
	return prefixes;
}

export async function validateStageFiveEvidenceValue(
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
	const host = recordAt(value, "host");
	const expected = expectedStageFiveCommands(value);
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
	if (!sameValue([...ids].sort(), [...STAGE_FIVE_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 5A command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 5A command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageFiveCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		if (REFUSAL_COMMAND_IDS.has(id)) {
			if (entry["exitCode"] === 0 || entry["status"] !== "refused")
				errors.push(`semantic: command ${id} did not refuse`);
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

	const contractSource = await Bun.file(resolve(root, CONTRACT_PATH)).text();
	const devcontainer = await Bun.file(resolve(root, DEVCONTAINER_PATH)).text();
	const contract = recordAt(value, "contract");
	if (
		contract["path"] !== CONTRACT_PATH ||
		String(contract["version"]) !== contractScalar(contractSource, "version") ||
		String(contract["environmentPrefix"]) !==
			contractScalar(contractSource, "environment_prefix") ||
		String(contract["publishedContainerPort"]) !==
			contractScalar(contractSource, "published_container_port") ||
		String(contract["offsetModulus"]) !==
			contractScalar(contractSource, "preferred_offset_modulus") ||
		String(contract["manifestSchemaVersion"]) !==
			contractScalar(contractSource, "manifest_schema_version") ||
		contract["serviceCount"] !== declaredServiceCount(contractSource)
	)
		errors.push("repository: contract evidence differs from its authority");

	// Two worktrees, and every identity-bearing value has to differ between them.
	const worktrees = recordsAt(value, "worktrees");
	const [alpha, beta] = worktrees;
	const temporaryRoot = String(run["temporaryRoot"] ?? "");
	let isolationDrifted = worktrees.length !== 2;
	for (const [index, worktree] of worktrees.entries()) {
		if (worktree["path"] !== worktreePath(temporaryRoot, index))
			isolationDrifted = true;
		if (
			worktree["devcontainerId"] !==
			devcontainerIdentity(String(worktree["path"] ?? ""))
		)
			isolationDrifted = true;
		if (
			!String(worktree["workspaceId"] ?? "").endsWith(`-${worktree["family"]}`)
		)
			isolationDrifted = true;
		if (
			!String(worktree["directUrl"] ?? "").endsWith(
				`:${worktree["publishedHostPort"]}`,
			)
		)
			isolationDrifted = true;
		if (
			!Array.isArray(worktree["portSet"]) ||
			!(worktree["portSet"] as unknown[]).includes(
				worktree["publishedHostPort"],
			)
		)
			isolationDrifted = true;
	}
	if (alpha && beta) {
		for (const key of [
			"path",
			"workspaceId",
			"family",
			"offset",
			"publishedHostPort",
			"containerId",
			"devcontainerId",
			"persistenceRoot",
			"directUrl",
			"friendlyUrl",
		])
			if (alpha[key] === beta[key]) isolationDrifted = true;
		const left = (alpha["portSet"] ?? []) as number[];
		const right = new Set((beta["portSet"] ?? []) as number[]);
		if (left.some((port) => right.has(port))) isolationDrifted = true;
		if (alpha["definitionFingerprint"] !== beta["definitionFingerprint"])
			isolationDrifted = true;
	}
	const allocation = recordAt(value, "allocation");
	if (
		allocation["portSetsDisjoint"] !== true ||
		!String(allocation["registryPath"] ?? "").startsWith(
			`${String(host["home"] ?? "")}/`,
		)
	)
		isolationDrifted = true;
	if (isolationDrifted)
		errors.push("semantic: worktree isolation evidence drifted");

	// Every recorded worktree value is parsed back out of the environment report
	// the runtime itself emitted, so nothing here is asserted from memory.
	for (const [index, worktree] of worktrees.entries()) {
		const id =
			index === 0 ? "worktree-a-environment" : "worktree-b-environment";
		let reported: JsonRecord = {};
		try {
			reported = JSON.parse(log(id, "stdout")) as JsonRecord;
		} catch {
			errors.push(`repository: ${id} did not report one JSON environment`);
			continue;
		}
		if (
			reported["workspaceId"] !== worktree["workspaceId"] ||
			reported["family"] !== worktree["family"] ||
			reported["offset"] !== worktree["offset"] ||
			reported["offsetSource"] !== worktree["offsetSource"] ||
			reported["publishedHostPort"] !== worktree["publishedHostPort"] ||
			reported["directUrl"] !== worktree["directUrl"] ||
			`http://${reported["friendlyHost"]}` !== worktree["friendlyUrl"] ||
			reported["repoPath"] !== worktree["path"] ||
			!sameValue(reported["portSet"], worktree["portSet"])
		)
			errors.push(`repository: ${id} evidence differs from its bound log`);
	}

	// One cold `devcontainer up` per worktree, a fast path that starts nothing,
	// and a definition change that recreates rather than reuses.
	const ensure = recordAt(value, "ensure");
	const cold = values("worktree-a-ensure-cold");
	const warm = values("worktree-a-ensure-warm");
	const recreate = values("recreate-fast-path");
	const started = "starting the container for";
	if (
		ensure["coldDurationMs"] !==
			commandById.get("worktree-a-ensure-cold")?.["durationMs"] ||
		ensure["warmDurationMs"] !==
			commandById.get("worktree-a-ensure-warm")?.["durationMs"] ||
		Number(ensure["warmDurationMs"] ?? 0) >=
			Number(ensure["coldDurationMs"] ?? 0) ||
		ensure["upInvocations"] !== 1 ||
		occurrences(log("worktree-a-ensure-cold", "stderr"), started) !== 1 ||
		occurrences(log("worktree-a-ensure-warm", "stderr"), started) !== 0 ||
		cold["containerId"] !== warm["containerId"] ||
		cold["containerId"] !== alpha?.["containerId"] ||
		cold["definitionFingerprint"] !== alpha?.["definitionFingerprint"]
	)
		errors.push("semantic: container ensure evidence drifted");
	if (
		ensure["recreateReason"] !== "definition fingerprint changed" ||
		!log("recreate-fast-path", "stderr").includes(
			"recreating the container because its definition changed",
		) ||
		recreate["beforeFingerprint"] === recreate["changedFingerprint"] ||
		recreate["restoredFingerprint"] !== recreate["beforeFingerprint"] ||
		recreate["recreatedContainerId"] === recreate["beforeContainerId"] ||
		recreate["restoredContainerId"] === recreate["recreatedContainerId"] ||
		recreate["readyContainerId"] !== recreate["restoredContainerId"] ||
		recreate["restoredContainerId"] !== beta?.["containerId"] ||
		recreate["restoredFingerprint"] !== beta?.["definitionFingerprint"]
	)
		errors.push("repository: recreate evidence differs from its bound log");

	const gitOperations = values("git-operations");
	if (
		gitOperations["headSha"] !== source["implementationSha"] ||
		gitOperations["commonDir"] !== `${resolve(root)}/.git` ||
		gitOperations["statusLines"] !== "0" ||
		gitOperations["tagVisibleOnHost"] !== "1" ||
		gitOperations["tagRemoved"] !== "0"
	)
		errors.push(
			"repository: linked-worktree Git evidence differs from its log",
		);

	const boundary = recordAt(value, "boundary");
	const attack = values("ownership-attack-refusal");
	if (
		boundary["ownershipRefusalCommandId"] !== "ownership-attack-refusal" ||
		boundary["commandExecuted"] !== false ||
		Number(boundary["ownershipRefusalExitCode"] ?? 0) === 0 ||
		commandById.get("ownership-attack-refusal")?.["exitCode"] !==
			boundary["ownershipRefusalExitCode"] ||
		attack["checkReadyExitCode"] !==
			String(boundary["ownershipRefusalExitCode"]) ||
		attack["commandExecuted"] !== "false" ||
		attack["acceptedContainerId"] !== "" ||
		!/^[0-9a-f]{64}$/.test(String(attack["decoyContainerId"] ?? "")) ||
		attack["bridgeExitCode"] !== "0" ||
		attack["decoyContainerId"] === attack["genuineContainerId"] ||
		attack["reconciledContainerId"] !== attack["genuineContainerId"] ||
		attack["genuineContainerId"] !== alpha?.["containerId"]
	)
		errors.push("semantic: container ownership boundary evidence drifted");

	const routing = recordAt(value, "routing");
	const route = values("route-probe");
	if (
		routing["directRouteVerified"] !== true ||
		routing["hostCaddyAvailable"] !== (route["caddyAvailable"] === "true") ||
		routing["friendlyRouteVerified"] !==
			String(route["friendlyBody"] ?? "").includes(ROUTE_TOKEN) ||
		!String(route["directBody"] ?? "").includes(ROUTE_TOKEN) ||
		route["directUrl"] !== alpha?.["directUrl"] ||
		route["friendlyUrl"] !== alpha?.["friendlyUrl"] ||
		route["manifestStatus"] !== "active" ||
		routing["manifestPath"] !== route["manifestPath"] ||
		!String(routing["manifestPath"] ?? "").endsWith(
			`/${alpha?.["workspaceId"]}.json`,
		)
	)
		errors.push("semantic: routing evidence drifted");

	const persistence = values("persistence-probe");
	const runId = String(run["id"] ?? "");
	if (
		persistence["alphaPersistenceRoot"] !== alpha?.["persistenceRoot"] ||
		persistence["betaPersistenceRoot"] !== beta?.["persistenceRoot"] ||
		persistence["alphaOnHost"] !== `${runId}-alpha` ||
		persistence["betaOnHost"] !== `${runId}-beta` ||
		persistence["alphaInContainer"] !== persistence["alphaOnHost"] ||
		persistence["betaInContainer"] !== persistence["betaOnHost"]
	)
		errors.push("repository: persistence evidence differs from its bound log");

	const authentication = values("authentication-round-trip");
	if (
		authentication["credentialReadByBeta"] !== runId ||
		authentication["sessionStateIsolated"] !== "true" ||
		authentication["alphaCredentialSource"] === "" ||
		authentication["alphaCredentialSource"] !==
			authentication["betaCredentialSource"]
	)
		errors.push("semantic: authentication round-trip evidence drifted");

	// Docker's own answer, this runtime's answer, and the reviewer's answer all
	// have to be the same 52 characters, for every declared volume prefix.
	const identity = values("volume-identity");
	const prefixes = declaredVolumePrefixes(devcontainer);
	let volumesDrifted = prefixes.length === 0;
	for (const [index, worktree] of worktrees.entries()) {
		const observed = words(
			identity[index === 0 ? "alphaVolumes" : "betaVolumes"],
		);
		if (
			identity[index === 0 ? "alphaContainerId" : "betaContainerId"] !==
			worktree["containerId"]
		)
			volumesDrifted = true;
		for (const prefix of prefixes)
			if (!observed.includes(`${prefix}-${worktree["devcontainerId"]}`))
				volumesDrifted = true;
	}
	if (volumesDrifted)
		errors.push("repository: volume identity differs from the engine's answer");

	const bridge = values("bridge-dispatch");
	if (
		bridge["workdir"] !== "/workspace/scripts" ||
		bridge["user"] !== "vscode" ||
		bridge["argv"] !== 'one|two three|four"five|' ||
		bridge["exitStatus"] !== "42" ||
		bridge["workspaceId"] !== alpha?.["workspaceId"] ||
		bridge["sentinelInAlpha"] !== runId ||
		bridge["sentinelInBeta"] !== "absent" ||
		!String(bridge["bunPath"] ?? "").endsWith("/bun")
	)
		errors.push("semantic: bridge dispatch evidence drifted");

	const cleanup = recordAt(value, "cleanup");
	const isolation = values("cleanup-isolation");
	const removed = [
		`container ${isolation["betaContainerId"]}`,
		...words(isolation["betaVolumes"]).map((name) => `volume ${name}`),
		`manifest ${isolation["betaManifest"]}`,
		`registry entry ${isolation["betaWorkspaceId"]}`,
	];
	if (
		!sameValue(cleanup["removed"], removed) ||
		!sameValue(cleanup["remaining"], []) ||
		cleanup["survivorIntact"] !== true ||
		isolation["betaWorkspaceId"] !== beta?.["workspaceId"] ||
		isolation["betaContainerId"] !== beta?.["containerId"] ||
		isolation["betaContainersRemaining"] !== "0" ||
		isolation["betaVolumesRemaining"] !== "0" ||
		isolation["betaManifestRemaining"] !== "absent" ||
		isolation["betaStateRemaining"] !== "absent" ||
		isolation["betaRegistryRemaining"] !== "absent" ||
		isolation["survivorContainerId"] !== alpha?.["containerId"] ||
		isolation["survivorManifestRemaining"] !== "present" ||
		isolation["survivorRegistryRemaining"] !== "present" ||
		!String(isolation["survivorBody"] ?? "").includes(ROUTE_TOKEN) ||
		!log("cleanup-isolation", "stderr").includes(
			`removed every resource owned by ${beta?.["workspaceId"]}`,
		) ||
		log("cleanup-isolation", "stderr").includes("survived cleanup")
	)
		errors.push("semantic: cleanup evidence drifted");

	// The test runner prints per-test lines only for failures, so the binding is
	// the run's own tally: a recorded pass count that the log agrees with, no
	// failures, and exactly the one suite the command names.
	const knownBad = recordAt(value, "knownBadFixtures");
	const suiteOutcome = (
		id: string,
	): { passed: number; failed: number; files: number } => {
		const source = log(id, "stderr");
		return {
			passed: Number(/^\s*(\d+) pass$/m.exec(source)?.[1] ?? -1),
			failed: Number(/^\s*(\d+) fail$/m.exec(source)?.[1] ?? -1),
			files: Number(/across (\d+) files?\./.exec(source)?.[1] ?? -1),
		};
	};
	const contractSuite = suiteOutcome("contract-known-bad-fixtures");
	const templateSuite = suiteOutcome("template-known-bad-fixtures");
	if (
		knownBad["contract"] !== "contract-known-bad-fixtures" ||
		knownBad["template"] !== "template-known-bad-fixtures" ||
		knownBad["contractTestsPassed"] !== contractSuite.passed ||
		knownBad["templateTestsPassed"] !== templateSuite.passed
	)
		errors.push("semantic: known-bad fixture binding drifted");
	if (
		!log("contract-guard", "stdout").includes(
			"Validated worktree runtime contract keys",
		) ||
		!log("hermetic-selftest", "stdout").includes("Worktree selftest: passed") ||
		contractSuite.passed < 1 ||
		contractSuite.failed !== 0 ||
		contractSuite.files !== 1 ||
		templateSuite.passed < 1 ||
		templateSuite.failed !== 0 ||
		templateSuite.files !== 1 ||
		log("contract-known-bad-fixtures", "stderr").includes("(fail)") ||
		log("template-known-bad-fixtures", "stderr").includes("(fail)")
	)
		errors.push(
			"repository: hermetic guard evidence differs from its bound logs",
		);

	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-5a-pr-merge-commit>",
		]) ||
		!sameValue(rollback["runtimeCleanup"], [
			"bash",
			"scripts/worktree/cleanup.sh",
		]) ||
		!String(rollback["scope"] ?? "").includes("cleanup.sh")
	)
		errors.push("semantic: Stage 5A rollback is not atomic");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true
	)
		errors.push("semantic: Stage 5A rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	for (const [label, sha] of [
		["base", source["baseSha"]],
		["implementation", source["implementationSha"]],
	] as const)
		if (
			typeof sha !== "string" ||
			git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 5A ${label} commit is missing`);
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
			"repository: Stage 5A base is not an ancestor of implementation",
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
			"repository: Stage 5A implementation is not an ancestor of HEAD",
		);
	return errors;
}

export async function validateStageFiveEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-5-worktree.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-5-worktree.schema.json"),
		).json()) as JsonRecord;
		return validateStageFiveEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
