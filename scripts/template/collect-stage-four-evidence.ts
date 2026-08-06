// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { probeRollback } from "./collect-stage-two-evidence";
import {
	expectedStageFourCommands,
	STAGE_FOUR_COMMAND_IDS,
	type StageFourCommandId,
	sha256,
	validateStageFourEvidenceValue,
} from "./stage-four-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-4-cloud-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-4-cloud.json");
// The merge-base of the Stage 4 branch with origin/main. The stage README
// records the same value; the rollback proof reverts back to exactly this tree.
const BASE_SHA = "3a7f06415fe160e17c7c2592e04f7aa98c361d71";

// Commands that exist to prove a refusal. Everything else must exit zero.
const REFUSAL_COMMAND_IDS = new Set<StageFourCommandId>([
	"stale-fingerprint-refusal",
	"exec-boundary-refusal",
]);

// Cloud runtime inputs. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const RUNTIME_INPUTS = [
	".codex/cloud",
	".prototools",
	".devcontainer",
	"package.json",
	"bun.lock",
];

// The Stage 4 evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-four-evidence.ts",
	"scripts/template/collect-stage-four-evidence.ts",
	"scripts/template/__tests__/stage-four-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-4-cloud.json",
	"evidence/stage-4-cloud.schema.json",
	"evidence/stage-4-cloud-run/",
	"graphify-out",
	"node_modules",
];

interface Execution {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageFourCommandId;
	command: string[];
	runId: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	stdoutPath: string;
	stderrPath: string;
	stdoutSha256: string;
	stderrSha256: string;
	exitCode: number;
	status: "pass" | "refused";
}

function usage(): string {
	return [
		"usage:",
		"  bun scripts/template/collect-stage-four-evidence.ts capture --implementation <sha>",
		"  bun scripts/template/collect-stage-four-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
	].join("\n");
}

function parseOptions(args: string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || !value || value.startsWith("--"))
			throw new Error(usage());
		if (options.has(key)) throw new Error(`Duplicate option ${key}`);
		options.set(key, value);
	}
	return options;
}

function required(options: Map<string, string>, key: string): string {
	const value = options.get(key);
	if (!value) throw new Error(`Missing ${key}\n${usage()}`);
	return value;
}

function execute(command: string[]): Execution {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		command,
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function checked(command: string[]): Execution {
	const result = execute(command);
	if (result.exitCode !== 0)
		throw new Error(
			`Command failed (${result.exitCode}): ${JSON.stringify(command)}\n${result.stderr || result.stdout}`,
		);
	return result;
}

function gitSha(revision: string): string {
	const sha = checked([
		"git",
		"rev-parse",
		"--verify",
		`${revision}^{commit}`,
	]).stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(sha))
		throw new Error(`Invalid commit ${revision}`);
	return sha;
}

function jsonObject(text: string, label: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${label} did not emit one JSON object: ${String(error)}`);
	}
}

function keyValues(text: string): Record<string, string> {
	return Object.fromEntries(
		text.split("\n").flatMap((line) => {
			const match = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);
			return match?.[1] ? [[match[1], match[2] ?? ""]] : [];
		}),
	);
}

function uname(flag: string): string {
	return checked(["uname", flag]).stdout.trim();
}

async function captureCommand(
	id: StageFourCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-4-cloud-run/${id}.stdout`;
	const stderrPath = `evidence/stage-4-cloud-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	const refusal = REFUSAL_COMMAND_IDS.has(id);
	if (refusal && execution.exitCode === 0)
		throw new Error(`Stage 4 command ${id} was expected to refuse but passed`);
	if (!refusal && execution.exitCode !== 0)
		throw new Error(
			`Stage 4 command ${id} failed (${execution.exitCode}); see ${stderrPath}`,
		);
	return {
		record: {
			id,
			command,
			runId,
			startedAt,
			completedAt: new Date(completed).toISOString(),
			durationMs: Math.max(1, completed - started),
			stdoutPath,
			stderrPath,
			stdoutSha256: sha256(execution.stdout),
			stderrSha256: sha256(execution.stderr),
			exitCode: execution.exitCode,
			status: refusal ? "refused" : "pass",
		},
		execution,
	};
}

function assertCaptureTreeIsClean(): void {
	const dirty = checked([
		"git",
		"status",
		"--porcelain",
		"--untracked-files=all",
	])
		.stdout.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean)
		.filter(
			(path) => !CAPTURE_PATHS.some((allowed) => path.startsWith(allowed)),
		);
	if (dirty.length > 0)
		throw new Error(
			`Stage 4 capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

async function capture(implementationRevision: string) {
	if (uname("-s") !== "Linux")
		throw new Error("Stage 4 evidence must be captured on Linux");
	const baseSha = gitSha(BASE_SHA);
	const implementationSha = gitSha(implementationRevision);
	checked(["git", "merge-base", "--is-ancestor", baseSha, implementationSha]);
	checked(["git", "merge-base", "--is-ancestor", implementationSha, "HEAD"]);
	assertCaptureTreeIsClean();
	if (
		execute([
			"git",
			"diff",
			"--quiet",
			implementationSha,
			"HEAD",
			"--",
			...RUNTIME_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"Cloud runtime inputs changed after the Stage 4 implementation boundary",
		);
	if (
		execute(["git", "diff", "--quiet", "--", ...RUNTIME_INPUTS]).exitCode !== 0
	)
		throw new Error("Cloud runtime inputs have uncommitted changes");

	const home = process.env["HOME"];
	if (!home) throw new Error("HOME is not set in the capture environment");
	const now = new Date();
	const runId = `stage4-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
	};
	const expected = expectedStageFourCommands(context);
	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });
	const records: CapturedCommand[] = [];
	const executions = new Map<StageFourCommandId, Execution>();
	const durations = new Map<StageFourCommandId, number>();
	for (const id of STAGE_FOUR_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
		durations.set(id, captured.record.durationMs);
	}

	const contract = Bun.TOML.parse(
		await Bun.file(resolve(ROOT, ".codex/cloud/contract.toml")).text(),
	) as Record<string, unknown>;
	const fresh = keyValues(executions.get("fresh-shell-core")?.stdout ?? "");
	const browser = keyValues(executions.get("doctor-browser")?.stdout ?? "");
	const stale = keyValues(
		executions.get("stale-fingerprint-refusal")?.stdout ?? "",
	);
	const refusal = keyValues(
		executions.get("exec-boundary-refusal")?.stdout ?? "",
	);
	const rollbackProof = jsonObject(
		executions.get("rollback-proof")?.stdout ?? "",
		"rollback-proof",
	);
	if (
		!(executions.get("doctor-browser")?.stdout ?? "").includes(
			"Browser preflight passed",
		)
	)
		throw new Error("The browser doctor did not report a completed launch");
	const evidence = {
		schemaVersion: 1,
		stage: "stage-4-codex-cloud-parity",
		capturedAt: new Date().toISOString(),
		run: {
			id: runId,
			logRoot: "evidence/stage-4-cloud-run",
			temporaryRoot: `/tmp/devenv-stage2-${runId}`,
		},
		source: { baseSha, implementationSha, cloudTreeClean: true },
		host: {
			os: uname("-s").toLowerCase(),
			architecture: uname("-m"),
			kernel: uname("-r"),
			home,
		},
		contract: {
			path: ".codex/cloud/contract.toml",
			version: contract["version"],
			defaultProfile: contract["default_profile"],
			profiles: [contract["default_profile"], contract["browser_profile"]],
			tools: Object.fromEntries(
				["proto", "bun", "node", "moon", "python", "uv", "jq"].map((tool) => [
					tool,
					contract[`tool_${tool}`],
				]),
			),
			protoChecksums: {
				"x86_64-unknown-linux-gnu": contract["proto_sha256_x86_64_linux"],
				"aarch64-unknown-linux-gnu": contract["proto_sha256_aarch64_linux"],
			},
			browserPin: contract["browser_playwright_version"],
			graphifyPin: contract["graphify_version"],
			secretAllowList: contract["secret_allow_list"],
			fingerprintInputs: contract["fingerprint_inputs"],
		},
		commands: records,
		idempotency: {
			coldCommandId: "cold-bootstrap-core",
			warmCommandId: "warm-bootstrap-core",
			freshShellCommandId: "fresh-shell-core",
			fingerprint: fresh["fingerprint"],
			bashrcSourceLines: Number(fresh["bashrcSourceLines"]),
			coldDurationMs: durations.get("cold-bootstrap-core"),
			warmDurationMs: durations.get("warm-bootstrap-core"),
		},
		browser: {
			commandId: "doctor-browser",
			profile: contract["browser_profile"],
			environment: contract["browser_environment_variable"],
			payloadRoot: browser["payloadRoot"],
			markerPath: browser["markerPath"],
			markerVersion: browser["markerVersion"],
			referenceMarkerPath: contract["browser_reference_marker_path"],
			requiredCommand: contract["browser_required_command"],
			launchPassed: true,
		},
		boundary: {
			staleCommandId: "stale-fingerprint-refusal",
			refusalCommandId: "exec-boundary-refusal",
			unhealthyExecExitCode: Number(stale["execExitCode"]),
			execRefusalExitCode: Number(refusal["execRefusalExitCode"]),
			commandExecuted:
				stale["commandExecuted"] !== "false" ||
				refusal["commandExecuted"] !== "false",
		},
		knownBadFixtures: {
			contract: "contract-known-bad-fixtures",
			template: "template-known-bad-fixtures",
		},
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-4-pr-merge-commit>"],
			runtimeCleanup: [
				"rm",
				"-rf",
				contract["persisted_environment"],
				contract["persisted_secrets_environment"],
				contract["fingerprint_marker_directory"],
			],
			scope:
				"Revert the cloud contract, scripts, selftest, guard, CI wiring, ownership, documentation, and evidence as one Stage 4 bundle; then delete the persisted cloud environment, secrets, and fingerprint marker in every prepared cloud environment.",
			proof: rollbackProof,
		},
	};
	const schema = (await Bun.file(
		resolve(ROOT, "evidence/stage-4-cloud.schema.json"),
	).json()) as Record<string, unknown>;
	const errors = await validateStageFourEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 4 evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`Captured ${records.length} Stage 4 commands in ${runId}.`);
}

if (import.meta.main) {
	const [action, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (action === "capture") {
		for (const key of options.keys())
			if (key !== "--implementation")
				throw new Error(`Unknown option ${key}\n${usage()}`);
		await capture(required(options, "--implementation"));
	} else if (action === "probe-rollback") {
		for (const key of options.keys())
			if (!["--base", "--implementation", "--workspace"].includes(key))
				throw new Error(`Unknown option ${key}\n${usage()}`);
		console.log(
			JSON.stringify(
				await probeRollback({
					base: required(options, "--base"),
					implementation: required(options, "--implementation"),
					workspace: required(options, "--workspace"),
					root: ROOT,
				}),
				null,
				2,
			),
		);
	} else throw new Error(usage());
}
