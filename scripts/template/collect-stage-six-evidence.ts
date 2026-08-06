// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { probeRollback } from "./collect-stage-two-evidence";
import { devcontainerIdentity } from "./stage-five-evidence";
import { sha256 } from "./stage-four-evidence";
import {
	ADDED_PATHS,
	COLLISION_WORKSPACE_ID,
	DOCTOR_REFUSAL_EXIT_CODES,
	expectedStageSixCommands,
	fabricatedManifestPath,
	journeyHomePath,
	rollbackWorkspacePath,
	STAGE_SIX_COMMAND_IDS,
	type StageSixCommandId,
	validateStageSixEvidenceValue,
	WORKTREE_NAMES,
	worktreePath,
} from "./stage-six-evidence";
import { DOCTOR_CHECK_IDS } from "./worktree-contract";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-6-doctor-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-6-doctor.json");
// The merge-base of the Stage 6 branch with origin/main, which is the Stage 5B
// merge. The stage README records the same value; the rollback proof reverts
// back to exactly this tree, and that tree carries no doctor at all.
const BASE_SHA = "9961f7e6c6797738012665c16222ff1afc1441cd";

// The diagnostic surface. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const DOCTOR_INPUTS = [
	"scripts/worktree",
	".devcontainer",
	".prototools",
	"AGENTS.md",
	"README.template.md",
	"package.json",
	"bun.lock",
];

// The Stage 6 evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-six-evidence.ts",
	"scripts/template/collect-stage-six-evidence.ts",
	"scripts/template/__tests__/stage-six-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-6-doctor.json",
	"evidence/stage-6-doctor.schema.json",
	"evidence/stage-6-doctor-run/",
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
	id: StageSixCommandId;
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
		"  bun scripts/template/collect-stage-six-evidence.ts capture --implementation <sha>",
		"  bun scripts/template/collect-stage-six-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
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

function execute(
	command: string[],
	cwd = ROOT,
	environment?: Record<string, string>,
): Execution {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(environment ? { env: { ...process.env, ...environment } } : {}),
	});
	return {
		command,
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function checked(command: string[], cwd = ROOT): Execution {
	const result = execute(command, cwd);
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

function contractValue(key: string): string {
	return checked([
		"bash",
		"-c",
		`. "${ROOT}/scripts/worktree/lib.sh"; wt_contract_value "$1"`,
		"bash",
		key,
	]).stdout.trim();
}

async function captureCommand(
	id: StageSixCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-6-doctor-run/${id}.stdout`;
	const stderrPath = `evidence/stage-6-doctor-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	const refusal = DOCTOR_REFUSAL_EXIT_CODES[id];
	if (refusal !== undefined && execution.exitCode !== refusal)
		throw new Error(
			`Stage 6 command ${id} was expected to refuse with exit ${refusal} but exited ${execution.exitCode}`,
		);
	if (refusal === undefined && execution.exitCode !== 0)
		throw new Error(
			`Stage 6 command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
		);
	console.log(
		`  ${id} ${refusal === undefined ? "passed" : "refused"} in ${Math.round((completed - started) / 1000)}s`,
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
			status: refusal === undefined ? "pass" : "refused",
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
			`Stage 6 capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertHostTooling(): void {
	for (const [binary, hint] of [
		["docker", "install Docker Desktop and start its daemon"],
		["devcontainer", "brew install devcontainer"],
		["python3", "macOS: xcode-select --install"],
		["curl", "install curl"],
		["git", "install git"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 6 capture needs ${binary} on PATH (${hint})`);
	if (execute(["docker", "info"]).exitCode !== 0)
		throw new Error("The container daemon is not responding");
}

// Whatever happened, the host goes back to the state it was in: each throwaway
// worktree releases what it owns through the runtime's own cleanup, anything
// still carrying its ownership labels is removed by exact name, the linked
// worktrees are detached from the repository, and both temporary roots are gone.
// Nothing here ever sweeps.
async function releaseEverything(
	temporaryRoot: string,
	runId: string,
): Promise<void> {
	const home = journeyHomePath(temporaryRoot);
	for (const name of WORKTREE_NAMES) {
		const path = worktreePath(temporaryRoot, name);
		if (await Bun.file(resolve(path, "scripts/worktree/cleanup.sh")).exists()) {
			const result = execute(
				["bash", resolve(path, "scripts/worktree/cleanup.sh")],
				path,
				{ HOME: home, DOCKER_CONFIG: `${process.env["HOME"]}/.docker` },
			);
			if (result.exitCode !== 0)
				console.error(`cleanup for ${path} reported:\n${result.stderr}`);
		}
		const containers = execute([
			"docker",
			"ps",
			"--all",
			"--no-trunc",
			"--quiet",
			"--filter",
			`label=devcontainer.local_folder=${path}`,
		])
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const id of containers) execute(["docker", "rm", "--force", id]);
		const identity = devcontainerIdentity(path);
		const volumes = execute(["docker", "volume", "ls", "--quiet"])
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter((volume) => volume.endsWith(`-${identity}`));
		for (const volume of volumes)
			execute(["docker", "volume", "rm", "--force", volume]);
		execute(["git", "worktree", "remove", "--force", path]);
	}
	execute([
		"git",
		"worktree",
		"remove",
		"--force",
		rollbackWorkspacePath(runId),
	]);
	await rm(rollbackWorkspacePath(runId), { recursive: true, force: true });
	await rm(temporaryRoot, { recursive: true, force: true });
}

// This stage is additive: it adds a diagnosis and changes nothing the runtime
// does. The rollback proof is therefore the shared tree-identity probe plus the
// claim that matters for an addition — the reverted tree does not carry the
// doctor, and the implementation tree does.
export async function probeDoctorRollback(options: {
	base: string;
	implementation: string;
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const proof = await probeRollback({ ...options, root });
	for (const path of ADDED_PATHS) {
		const reverted = execute(
			["git", "cat-file", "-e", `${proof.revertedTree}:${path}`],
			root,
		);
		const implemented = execute(
			["git", "cat-file", "-e", `${proof.implementationSha}:${path}`],
			root,
		);
		if (reverted.exitCode === 0)
			throw new Error(`The reverted tree still carries ${path}`);
		if (implemented.exitCode !== 0)
			throw new Error(`The implementation tree does not carry ${path}`);
	}
	return {
		...proof,
		addedPaths: [...ADDED_PATHS],
		addedPathsRemoved: true,
	};
}

async function capture(implementationRevision: string) {
	const os = uname("-s").toLowerCase();
	if (os !== "darwin" && os !== "linux")
		throw new Error("Stage 6 evidence must be captured on macOS or Linux");
	assertHostTooling();
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
			...DOCTOR_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"Diagnostic inputs changed after the Stage 6 implementation boundary",
		);
	if (
		execute(["git", "diff", "--quiet", "--", ...DOCTOR_INPUTS]).exitCode !== 0
	)
		throw new Error("Diagnostic inputs have uncommitted changes");

	const home = process.env["HOME"];
	if (!home) throw new Error("HOME is not set in the capture environment");
	const now = new Date();
	const runId = `stage6-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	// The realpath matters: macOS resolves the temporary root through /private,
	// and every ownership label the engine records is canonical.
	const temporaryRoot = resolve(
		await realpath(tmpdir()),
		`devenv-stage6-${runId}`,
	);
	const context = {
		run: { id: runId, temporaryRoot, originPath: ROOT },
		source: { baseSha, implementationSha },
		host: { home },
	};
	const expected = expectedStageSixCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });
	await mkdir(temporaryRoot, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageSixCommandId, Execution>();
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		console.log("Releasing every resource this capture created …");
		await releaseEverything(temporaryRoot, runId);
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			void release().then(() => process.exit(130));
		});

	try {
		for (const id of STAGE_SIX_COMMAND_IDS) {
			const captured = await captureCommand(id, expected[id], runId);
			records.push(captured.record);
			executions.set(id, captured.execution);
		}

		const stdout = (id: StageSixCommandId) => executions.get(id)?.stdout ?? "";
		const healthyValues = keyValues(stdout("live-healthy-json"));
		const strictValues = keyValues(stdout("live-strict"));
		const collisionValues = keyValues(stdout("live-duplicate-port-claim"));
		const stoppedValues = keyValues(stdout("live-stopped-container"));
		const insideValues = keyValues(stdout("live-inside-container"));
		const invalidValues = keyValues(stdout("live-invalid-argument"));
		const snapshotValues = keyValues(stdout("non-mutation-snapshot"));
		const cleanupValues = keyValues(stdout("journey-cleanup"));
		const healthyReport = jsonObject(
			healthyValues["reportJson"] ?? "",
			"the healthy doctor report",
		);
		const summary = healthyReport["summary"] as Record<string, number>;
		if (Number(summary["warn"] ?? 0) < 1)
			throw new Error(
				"The healthy diagnosis carried no warning, so --strict would be a vacuous proof",
			);
		const insideReport = jsonObject(
			insideValues["reportJson"] ?? "",
			"the in-container doctor report",
		);
		const insideChecks = (insideReport["checks"] ?? []) as Array<
			Record<string, unknown>
		>;
		const collisionReport = jsonObject(
			collisionValues["reportJson"] ?? "",
			"the duplicate-claim doctor report",
		);
		const collisionCheck = (
			(collisionReport["checks"] ?? []) as Array<Record<string, unknown>>
		).find((entry) => entry["id"] === "manifests.port-collision");
		const stoppedReport = jsonObject(
			stoppedValues["reportJson"] ?? "",
			"the stopped-container doctor report",
		);
		const stoppedStatus = (id: string): string => {
			const found = (
				(stoppedReport["checks"] ?? []) as Array<Record<string, unknown>>
			).find((entry) => entry["id"] === id);
			return String(found?.["status"] ?? "");
		};
		const worktrees = WORKTREE_NAMES.map((name, index) => {
			const path = worktreePath(temporaryRoot, name);
			const observed = keyValues(
				stdout(index === 0 ? "journey-worktree-a-up" : "journey-worktree-b-up"),
			);
			const environment = jsonObject(
				observed["environmentJson"] ?? "",
				`the ${name} environment report`,
			);
			return {
				name,
				path,
				workspaceId: environment["workspaceId"],
				family: environment["family"],
				offset: environment["offset"],
				publishedHostPort: environment["publishedHostPort"],
				directUrl: environment["directUrl"],
				containerId: observed["containerId"],
				devcontainerId: devcontainerIdentity(path),
				definitionFingerprint: observed["definitionFingerprint"],
			};
		});
		const rollbackProof = jsonObject(
			stdout("rollback-proof"),
			"rollback-proof",
		);
		const removed = WORKTREE_NAMES.flatMap((name) => [
			`container ${cleanupValues[`${name}ContainerId`]}`,
			...(cleanupValues[`${name}Volumes`] ?? "")
				.split(/\s+/)
				.filter(Boolean)
				.map((volume) => `volume ${volume}`),
			`manifest ${cleanupValues[`${name}Manifest`]}`,
		]);
		const evidence = {
			schemaVersion: 1,
			stage: "stage-6-worktree-doctor",
			capturedAt: new Date().toISOString(),
			run: {
				id: runId,
				logRoot: "evidence/stage-6-doctor-run",
				temporaryRoot,
				isolatedHome: journeyHomePath(temporaryRoot),
				originPath: ROOT,
			},
			source: { baseSha, implementationSha, treeClean: true },
			host: {
				os,
				architecture: uname("-m"),
				kernel: uname("-r"),
				home,
				dockerVersion: checked([
					"docker",
					"version",
					"--format",
					"{{.Server.Version}}",
				]).stdout.trim(),
				devcontainerCliVersion: checked([
					"devcontainer",
					"--version",
				]).stdout.trim(),
				pythonVersion: checked([
					"python3",
					"-c",
					"import platform; print(platform.python_version())",
				]).stdout.trim(),
				curlPresent: true,
			},
			doctor: {
				command: contractValue("doctor_command"),
				schemaVersion: Number(contractValue("doctor_schema_version")),
				checkIds: [...DOCTOR_CHECK_IDS],
				exitCodes: { healthy: 0, failure: 1, invalidArgument: 2 },
			},
			worktrees,
			commands: records,
			healthy: {
				commandId: "live-healthy-json",
				doctorExitCode: Number(healthyValues["doctorExitCode"]),
				pass: summary["pass"],
				warn: summary["warn"],
				fail: summary["fail"],
				skip: summary["skip"],
			},
			strict: {
				commandId: "live-strict",
				doctorExitCode: Number(strictValues["doctorExitCode"]),
				warnCount: summary["warn"],
				checksIdentical:
					JSON.stringify(
						jsonObject(strictValues["reportJson"] ?? "", "the strict report")[
							"checks"
						],
					) === JSON.stringify(healthyReport["checks"]),
			},
			collision: {
				commandId: "live-duplicate-port-claim",
				checkId: "manifests.port-collision",
				status: String(collisionCheck?.["status"] ?? ""),
				claimedPort: Number(collisionValues["claimedPort"]),
				holders: [
					COLLISION_WORKSPACE_ID,
					String(worktrees[0]?.workspaceId),
				].sort(),
				fabricatedManifest: fabricatedManifestPath(temporaryRoot),
				beforeDigest: collisionValues["beforeDigest"],
				afterDigest: collisionValues["afterDigest"],
				manifestsUnchanged:
					collisionValues["beforeDigest"] === collisionValues["afterDigest"],
			},
			stopped: {
				commandId: "live-stopped-container",
				containerId: stoppedValues["containerId"],
				runtimeStatus: stoppedStatus("container.runtime"),
				fastReadyStatus: stoppedStatus("container.fast-ready"),
				portStatus: stoppedStatus("container.port"),
				toolsStatus: stoppedStatus("container.tools"),
				doctorExitCode: Number(stoppedValues["doctorExitCode"]),
				strictExitCode: Number(stoppedValues["strictExitCode"]),
			},
			refusals: [
				{
					commandId: "live-inside-container",
					exitCode: Number(insideValues["doctorExitCode"]),
					checkIds: insideChecks.map((entry) => String(entry["id"])),
					message: String(insideChecks[0]?.["detail"] ?? ""),
					commandExecuted: false,
				},
				{
					commandId: "live-invalid-argument",
					exitCode: Number(invalidValues["doctorExitCode"]),
					checkIds: [],
					message: invalidValues["refusalMessage"] ?? "",
					commandExecuted: false,
				},
			],
			nonMutation: {
				commandId: "non-mutation-snapshot",
				invocations: Number(snapshotValues["invocations"]),
				beforeDigest: snapshotValues["beforeDigest"],
				afterDigest: snapshotValues["afterDigest"],
				beforeListing: snapshotValues["beforeListing"],
				afterListing: snapshotValues["afterListing"],
				unchanged:
					snapshotValues["beforeDigest"] === snapshotValues["afterDigest"] &&
					snapshotValues["beforeListing"] === snapshotValues["afterListing"],
			},
			cleanup: {
				commandId: "journey-cleanup",
				removed,
				remaining: [],
				realCheckoutStateDigest: cleanupValues["realCheckoutStateDigest"],
				realCheckoutStateUnchanged:
					cleanupValues["realCheckoutStateDigest"] ===
					keyValues(stdout("journey-worktree-a-up"))["realCheckoutStateDigest"],
			},
			rollback: {
				mode: "atomic",
				command: ["git", "revert", "-m", "1", "<stage-6-pr-merge-commit>"],
				runtimeCleanup: [],
				containerRebuildRequired: false,
				scope:
					"Revert the doctor, the three contract keys and the runtime_scripts entry, the shared identity derivation in lib.sh, the guard, the documentation, and the evidence as one Stage 6 bundle. This stage is additive and diagnostic: no runtime resource is allocated by it, so nothing has to be released before reverting, and no .devcontainer file changed, so there is no container rebuild in either direction. Downstream projects that already scripted `bash scripts/worktree/doctor.sh` lose that command and nothing else.",
				proof: rollbackProof,
			},
		};
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-6-doctor.schema.json"),
		).json()) as Record<string, unknown>;
		const errors = await validateStageSixEvidenceValue(evidence, schema, ROOT);
		if (errors.length > 0)
			throw new Error(
				`Stage 6 evidence validation failed:\n- ${errors.join("\n- ")}`,
			);
		await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
		console.log(`Captured ${records.length} Stage 6 commands in ${runId}.`);
	} finally {
		await release();
	}
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
				await probeDoctorRollback({
					base: required(options, "--base"),
					implementation: required(options, "--implementation"),
					workspace: required(options, "--workspace"),
				}),
				null,
				2,
			),
		);
	} else throw new Error(usage());
}
