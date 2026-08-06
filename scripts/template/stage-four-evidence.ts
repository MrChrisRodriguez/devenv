// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const STAGE_FOUR_COMMAND_IDS = [
	"contract-guard",
	"hermetic-selftest",
	"contract-known-bad-fixtures",
	"cold-bootstrap-core",
	"warm-bootstrap-core",
	"doctor-core",
	"fresh-shell-core",
	"template-known-bad-fixtures",
	// Both refusals run while the core profile is the prepared one, so the
	// stale marker they corrupt and restore is the one the doctor consults.
	"stale-fingerprint-refusal",
	"exec-boundary-refusal",
	"cold-bootstrap-browser",
	"doctor-browser",
	"rollback-proof",
] as const;

export type StageFourCommandId = (typeof STAGE_FOUR_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-4-cloud-run";
const CONTRACT_PATH = ".codex/cloud/contract.toml";
const STAGE_THREE_EVIDENCE = "evidence/stage-3-runtimes.json";
const CONTRACT_TOOLS = [
	"proto",
	"bun",
	"node",
	"moon",
	"python",
	"uv",
	"jq",
] as const;
const ARCHITECTURES = [
	"x86_64-unknown-linux-gnu",
	"aarch64-unknown-linux-gnu",
] as const;
// Two commands must fail: they exist to prove the cloud refuses. Every other
// command must pass, so a refusal can never be smuggled in as a passing result.
const REFUSAL_COMMAND_IDS = new Set<string>([
	"stale-fingerprint-refusal",
	"exec-boundary-refusal",
]);

// The fresh-shell probe proves three things one argv cannot: the persisted
// marker bridges a cold non-interactive shell, the ~/.bashrc hook survived two
// bootstraps exactly once, and the recorded fingerprint is the one on disk.
const FRESH_SHELL_PROBE = [
	"set -euo pipefail",
	". .codex/cloud/lib.sh",
	'persisted="$(cloud_persisted_environment_file)"',
	'printf \'bashrcSourceLines=%s\\n\' "$(grep -Fc "$persisted" "$HOME/.bashrc" || true)"',
	'printf \'fingerprint=%s\\n\' "$(cat "$(cloud_marker_file core)")"',
	"env -u CODEX_CLOUD -u CODEX_CLOUD_PROFILE bash .codex/cloud/doctor.sh --quiet",
	"printf 'freshShellDoctor=pass\\n'",
].join("\n");

// The browser doctor probe reports the payload root it is about to verify
// before the doctor verifies it, so the recorded marker path and version are
// bound to the same run that launched the browser.
const BROWSER_DOCTOR_PROBE = [
	"set -euo pipefail",
	". .codex/cloud/lib.sh",
	'payload_root="$(cloud_expand_home "$(cloud_contract_value browser_payload_root)")"',
	'marker="$payload_root/$(cloud_contract_value browser_marker_basename)"',
	"printf 'payloadRoot=%s\\n' \"$payload_root\"",
	"printf 'markerPath=%s\\n' \"$marker\"",
	'printf \'markerVersion=%s\\n\' "$(cat "$marker")"',
	"bash .codex/cloud/doctor.sh",
].join("\n");

// A real stale marker, a real doctor refusal, a real exec refusal, and proof
// that the requested command never ran. The marker is restored either way so
// the capture continues from a healthy environment.
function staleFingerprintProbe(runId: string): string {
	return [
		"set -uo pipefail",
		". .codex/cloud/lib.sh",
		"set +e",
		`sentinel="/tmp/devenv-stage4-${runId}-stale-sentinel"`,
		'rm -f "$sentinel"',
		'marker="$(cloud_marker_file core)"',
		'cp "$marker" "$marker.backup"',
		"printf 'stale' >\"$marker\"",
		"doctor_status=0",
		"bash .codex/cloud/doctor.sh || doctor_status=$?",
		"exec_status=0",
		'bash .codex/cloud/exec.sh touch "$sentinel" || exec_status=$?',
		'mv -f "$marker.backup" "$marker"',
		"executed=true",
		'if [ ! -e "$sentinel" ]; then executed=false; fi',
		'rm -f "$sentinel"',
		"printf 'doctorExitCode=%s\\n' \"$doctor_status\"",
		"printf 'execExitCode=%s\\n' \"$exec_status\"",
		"printf 'commandExecuted=%s\\n' \"$executed\"",
		'exit "$doctor_status"',
	].join("\n");
}

// An environment that is not a verified cloud must refuse with exit 3 and must
// not execute anything, even when the persisted marker exists for another home.
function execBoundaryProbe(runId: string): string {
	return [
		"set -uo pipefail",
		`sentinel="/tmp/devenv-stage4-${runId}-boundary-sentinel"`,
		`home="/tmp/devenv-stage4-${runId}-unverified-home"`,
		'rm -f "$sentinel"',
		'rm -rf "$home"',
		'mkdir -p "$home"',
		"status=0",
		'env -u CODEX_CLOUD -u CODEX_CLOUD_PROFILE HOME="$home" bash .codex/cloud/exec.sh touch "$sentinel" || status=$?',
		"executed=true",
		'if [ ! -e "$sentinel" ]; then executed=false; fi',
		'rm -f "$sentinel"',
		'rm -rf "$home"',
		"printf 'execRefusalExitCode=%s\\n' \"$status\"",
		"printf 'commandExecuted=%s\\n' \"$executed\"",
		'exit "$status"',
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

export function sha256(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function expectedStageFourCommands(
	value: JsonRecord,
): Record<StageFourCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const runId = String(run["id"] ?? "");
	return {
		"contract-guard": ["bun", "run", "cloud:check"],
		"hermetic-selftest": ["bash", ".codex/cloud/selftest.sh"],
		"contract-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/cloud.test.ts",
		],
		// Scoped to the anti-residue guards. The unscoped suite also asserts
		// template:validate, which cannot pass while this very capture is still
		// producing the Stage 4 record it validates.
		"template-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/template.test.ts",
			"-t",
			"residue",
		],
		"cold-bootstrap-core": ["bash", ".codex/cloud/bootstrap.sh", "core"],
		"warm-bootstrap-core": ["bash", ".codex/cloud/bootstrap.sh", "core"],
		"doctor-core": ["bash", ".codex/cloud/doctor.sh"],
		"fresh-shell-core": ["bash", "-c", FRESH_SHELL_PROBE],
		"cold-bootstrap-browser": ["bash", ".codex/cloud/bootstrap.sh", "browser"],
		"doctor-browser": ["bash", "-c", BROWSER_DOCTOR_PROBE],
		"stale-fingerprint-refusal": ["bash", "-c", staleFingerprintProbe(runId)],
		"exec-boundary-refusal": ["bash", "-c", execBoundaryProbe(runId)],
		"rollback-proof": [
			"bun",
			"scripts/template/collect-stage-four-evidence.ts",
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

function dockerArgument(source: string, name: string): string {
	return new RegExp(`^ARG ${name}=([^\\s]+)$`, "m").exec(source)?.[1] ?? "";
}

function expandHome(value: string, home: string): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: The contract stores a literal ${HOME} placeholder the cloud scripts expand without eval.
	return value.replaceAll("${HOME}", home);
}

export async function validateStageFourEvidenceValue(
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
	const expected = expectedStageFourCommands(value);
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
	if (!sameValue([...ids].sort(), [...STAGE_FOUR_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 4 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 4 command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageFourCommandId;
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

	const contract = Bun.TOML.parse(
		await Bun.file(resolve(root, CONTRACT_PATH)).text(),
	) as JsonRecord;
	const prototools = Bun.TOML.parse(
		await Bun.file(resolve(root, ".prototools")).text(),
	) as JsonRecord;
	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const packageJson = (await Bun.file(
		resolve(root, "package.json"),
	).json()) as JsonRecord;
	const catalog = recordAt(recordAt(packageJson, "workspaces"), "catalog");
	const checksums = new Map<string, string>();
	for (const line of (
		await Bun.file(resolve(root, ".devcontainer/proto-checksums.txt")).text()
	).split("\n")) {
		const match = /^([0-9a-f]{64})\s+proto_cli-(\S+)\.tar\.xz$/.exec(
			line.trim(),
		);
		if (match?.[1] && match[2]) checksums.set(match[2], match[1]);
	}

	const contractEvidence = recordAt(value, "contract");
	const tools = recordAt(contractEvidence, "tools");
	const protoChecksums = recordAt(contractEvidence, "protoChecksums");
	let authorityDrifted = false;
	if (
		contractEvidence["path"] !== CONTRACT_PATH ||
		contractEvidence["version"] !== contract["version"] ||
		contractEvidence["defaultProfile"] !== contract["default_profile"]
	)
		authorityDrifted = true;
	for (const tool of CONTRACT_TOOLS)
		if (
			tools[tool] !== prototools[tool] ||
			tools[tool] !== contract[`tool_${tool}`]
		)
			authorityDrifted = true;
	for (const [target, key] of [
		[ARCHITECTURES[0], "proto_sha256_x86_64_linux"],
		[ARCHITECTURES[1], "proto_sha256_aarch64_linux"],
	] as const)
		if (
			protoChecksums[target] !== checksums.get(target) ||
			protoChecksums[target] !== contract[key]
		)
			authorityDrifted = true;
	if (
		contractEvidence["browserPin"] !== contract["browser_playwright_version"] ||
		contractEvidence["browserPin"] !== catalog["@playwright/test"] ||
		contractEvidence["browserPin"] !==
			dockerArgument(dockerfile, "PLAYWRIGHT_VERSION")
	)
		authorityDrifted = true;
	if (
		contractEvidence["graphifyPin"] !== contract["graphify_version"] ||
		contractEvidence["graphifyPin"] !==
			dockerArgument(dockerfile, "GRAPHIFY_VERSION")
	)
		authorityDrifted = true;
	if (
		!sameValue(
			contractEvidence["secretAllowList"],
			contract["secret_allow_list"],
		) ||
		!sameValue(
			contractEvidence["fingerprintInputs"],
			contract["fingerprint_inputs"],
		)
	)
		authorityDrifted = true;
	if (authorityDrifted)
		errors.push("repository: cloud pin evidence differs from its authority");

	const homeDirectory = String(host["home"] ?? "");
	const browser = recordAt(value, "browser");
	const stageThree = (await Bun.file(
		resolve(root, STAGE_THREE_EVIDENCE),
	).json()) as JsonRecord;
	const handoff = recordAt(stageThree, "cloudHandoff");
	const payloadRoot = expandHome(
		String(contract["browser_payload_root"] ?? ""),
		homeDirectory,
	);
	if (
		browser["commandId"] !== "doctor-browser" ||
		browser["profile"] !== handoff["requiredProfile"] ||
		browser["environment"] !== handoff["requiredEnvironment"] ||
		browser["requiredCommand"] !== handoff["requiredCommand"] ||
		browser["referenceMarkerPath"] !== handoff["requiredMarkerPath"] ||
		browser["referenceMarkerPath"] !== contract["browser_reference_marker_path"]
	)
		errors.push("semantic: Stage 3 browser handoff drifted");
	if (
		homeDirectory.length === 0 ||
		browser["payloadRoot"] !== payloadRoot ||
		browser["markerPath"] !==
			`${payloadRoot}/${String(contract["browser_marker_basename"] ?? "")}` ||
		browser["markerVersion"] !== contractEvidence["browserPin"] ||
		browser["launchPassed"] !== true
	)
		errors.push("semantic: cloud browser payload evidence drifted");
	const browserLog = keyValues(logs.get("doctor-browser.stdout") ?? "");
	if (
		browserLog["payloadRoot"] !== browser["payloadRoot"] ||
		browserLog["markerPath"] !== browser["markerPath"] ||
		browserLog["markerVersion"] !== browser["markerVersion"] ||
		!(logs.get("doctor-browser.stdout") ?? "").includes(
			"Codex cloud doctor: healthy (browser",
		) ||
		!(logs.get("doctor-browser.stdout") ?? "").includes(
			"Browser preflight passed",
		)
	)
		errors.push("repository: browser evidence differs from its bound logs");

	const idempotency = recordAt(value, "idempotency");
	const freshLog = keyValues(logs.get("fresh-shell-core.stdout") ?? "");
	const fingerprint = String(idempotency["fingerprint"] ?? "");
	if (
		idempotency["coldCommandId"] !== "cold-bootstrap-core" ||
		idempotency["warmCommandId"] !== "warm-bootstrap-core" ||
		idempotency["freshShellCommandId"] !== "fresh-shell-core" ||
		idempotency["bashrcSourceLines"] !== 1
	)
		errors.push("semantic: bootstrap idempotency evidence drifted");
	if (
		freshLog["fingerprint"] !== fingerprint ||
		freshLog["bashrcSourceLines"] !==
			String(idempotency["bashrcSourceLines"]) ||
		freshLog["freshShellDoctor"] !== "pass" ||
		idempotency["coldDurationMs"] !==
			commandById.get("cold-bootstrap-core")?.["durationMs"] ||
		idempotency["warmDurationMs"] !==
			commandById.get("warm-bootstrap-core")?.["durationMs"] ||
		fingerprint.length !== 64 ||
		!(logs.get("cold-bootstrap-core.stdout") ?? "").includes(
			`fingerprint ${fingerprint.slice(0, 12)}`,
		) ||
		!(logs.get("warm-bootstrap-core.stdout") ?? "").includes(
			`fingerprint ${fingerprint.slice(0, 12)}`,
		) ||
		!(logs.get("doctor-core.stdout") ?? "").includes(
			`Codex cloud doctor: healthy (core, fingerprint ${fingerprint.slice(0, 12)}`,
		)
	)
		errors.push(
			"repository: bootstrap idempotency evidence differs from its bound logs",
		);

	const boundary = recordAt(value, "boundary");
	const staleLog = keyValues(
		logs.get("stale-fingerprint-refusal.stdout") ?? "",
	);
	const refusalLog = keyValues(logs.get("exec-boundary-refusal.stdout") ?? "");
	if (
		boundary["staleCommandId"] !== "stale-fingerprint-refusal" ||
		boundary["refusalCommandId"] !== "exec-boundary-refusal" ||
		boundary["execRefusalExitCode"] !== 3 ||
		boundary["commandExecuted"] !== false ||
		Number(boundary["unhealthyExecExitCode"] ?? 0) === 0 ||
		staleLog["commandExecuted"] !== "false" ||
		refusalLog["commandExecuted"] !== "false" ||
		staleLog["execExitCode"] !== String(boundary["unhealthyExecExitCode"]) ||
		refusalLog["execRefusalExitCode"] !==
			String(boundary["execRefusalExitCode"]) ||
		commandById.get("exec-boundary-refusal")?.["exitCode"] !==
			boundary["execRefusalExitCode"] ||
		!(logs.get("stale-fingerprint-refusal.stderr") ?? "").includes(
			"environment fingerprint is missing or stale",
		) ||
		!(logs.get("exec-boundary-refusal.stderr") ?? "").includes(
			"not a verified Codex Cloud environment",
		)
	)
		errors.push("semantic: cloud execution boundary evidence drifted");

	const knownBad = recordAt(value, "knownBadFixtures");
	if (
		knownBad["contract"] !== "contract-known-bad-fixtures" ||
		knownBad["template"] !== "template-known-bad-fixtures"
	)
		errors.push("semantic: known-bad fixture binding drifted");
	const contractFixtureLog =
		logs.get("contract-known-bad-fixtures.stderr") ?? "";
	const templateFixtureLog =
		logs.get("template-known-bad-fixtures.stderr") ?? "";
	if (
		!(logs.get("contract-guard.stdout") ?? "").includes(
			"Validated Codex Cloud contract",
		) ||
		!(logs.get("hermetic-selftest.stdout") ?? "").includes(
			"Codex cloud selftest: passed",
		) ||
		!contractFixtureLog.includes(
			"passes the source tree and rejects known-bad cloud contract mutations",
		) ||
		!contractFixtureLog.includes(
			"runs the hermetic cloud bootstrap selftest",
		) ||
		!contractFixtureLog.includes("0 fail") ||
		!templateFixtureLog.includes(
			"known-bad Codex Cloud residue is detected and named",
		) ||
		!templateFixtureLog.includes(
			"renders minimal twice with identical manifests and no disabled residue",
		) ||
		!templateFixtureLog.includes("0 fail")
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
			"<stage-4-pr-merge-commit>",
		]) ||
		!sameValue(rollback["runtimeCleanup"], [
			"rm",
			"-rf",
			String(contract["persisted_environment"] ?? ""),
			String(contract["persisted_secrets_environment"] ?? ""),
			String(contract["fingerprint_marker_directory"] ?? ""),
		])
	)
		errors.push("semantic: Stage 4 rollback is not atomic");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true
	)
		errors.push("semantic: Stage 4 rollback proof drifted");
	try {
		if (
			!sameValue(proof, JSON.parse(logs.get("rollback-proof.stdout") ?? "{}"))
		)
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
			errors.push(`repository: Stage 4 ${label} commit is missing`);
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
			"repository: Stage 4 base is not an ancestor of implementation",
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
			"repository: Stage 4 implementation is not an ancestor of HEAD",
		);
	return errors;
}

export async function validateStageFourEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-4-cloud.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-4-cloud.schema.json"),
		).json()) as JsonRecord;
		return validateStageFourEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
