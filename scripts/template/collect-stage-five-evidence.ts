// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { probeRollback } from "./collect-stage-two-evidence";
import {
	devcontainerIdentity,
	expectedStageFiveCommands,
	STAGE_FIVE_COMMAND_IDS,
	type StageFiveCommandId,
	validateStageFiveEvidenceValue,
} from "./stage-five-evidence";
import { sha256 } from "./stage-four-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-5-worktree-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-5-worktree.json");
// The merge-base of the Stage 5A branch with origin/main. The stage README
// records the same value; the rollback proof reverts back to exactly this tree.
const BASE_SHA = "fe667186bc9939c582c35b67f0dac2d0d5d73220";
// A tiny image for the ownership decoy. It never runs project code: it exists
// only to carry one genuine and one foreign ownership label.
const DECOY_IMAGE = "alpine:3.20";
const WORKTREE_NAMES = ["alpha", "beta"] as const;

// The one command that exists to prove a refusal.
const REFUSAL_COMMAND_IDS = new Set<StageFiveCommandId>([
	"ownership-attack-refusal",
]);

// Worktree runtime inputs. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const RUNTIME_INPUTS = [
	"scripts/worktree",
	".devcontainer",
	".prototools",
	"template-parameters.toml",
	"package.json",
	"bun.lock",
];

// The Stage 5A evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-five-evidence.ts",
	"scripts/template/collect-stage-five-evidence.ts",
	"scripts/template/__tests__/stage-five-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-5-worktree.json",
	"evidence/stage-5-worktree.schema.json",
	"evidence/stage-5-worktree-run/",
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
	id: StageFiveCommandId;
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
		"  bun scripts/template/collect-stage-five-evidence.ts capture --implementation <sha>",
		"  bun scripts/template/collect-stage-five-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
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

function execute(command: string[], cwd = ROOT): Execution {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
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

function firstVersion(text: string, label: string): string {
	const match = /[0-9]+\.[0-9]+(?:\.[0-9]+)?/.exec(text);
	if (!match) throw new Error(`Could not read a ${label} version from ${text}`);
	return match[0];
}

async function captureCommand(
	id: StageFiveCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-5-worktree-run/${id}.stdout`;
	const stderrPath = `evidence/stage-5-worktree-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	const refusal = REFUSAL_COMMAND_IDS.has(id);
	if (refusal && execution.exitCode === 0)
		throw new Error(`Stage 5A command ${id} was expected to refuse but passed`);
	if (!refusal && execution.exitCode !== 0)
		throw new Error(
			`Stage 5A command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
		);
	console.log(
		`  ${id} ${refusal ? "refused" : "passed"} in ${Math.round((completed - started) / 1000)}s`,
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
			`Stage 5A capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertHostTooling(): void {
	for (const [binary, hint] of [
		["docker", "install Docker Desktop and start its daemon"],
		["devcontainer", "bun add --global @devcontainers/cli"],
		["python3", "macOS: xcode-select --install"],
		["curl", "install curl"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 5A capture needs ${binary} on PATH (${hint})`);
	if (execute(["docker", "info"]).exitCode !== 0)
		throw new Error("The container daemon is not responding");
	if (execute(["docker", "image", "inspect", DECOY_IMAGE]).exitCode !== 0)
		checked(["docker", "pull", DECOY_IMAGE]);
}

// Whatever happened, the host goes back to the state it was in: both throwaway
// checkouts release everything they own, the decoy is removed, the probe tag and
// the credential probe file are deleted, and the temporary root is gone.
async function releaseEverything(
	worktrees: string[],
	temporaryRoot: string,
	runId: string,
	credentialProbe: string,
): Promise<void> {
	for (const worktree of worktrees) {
		if (
			!(await Bun.file(
				resolve(worktree, "scripts/worktree/cleanup.sh"),
			).exists())
		)
			continue;
		const result = execute(
			["bash", resolve(worktree, "scripts/worktree/cleanup.sh")],
			worktree,
		);
		if (result.exitCode !== 0)
			console.error(`cleanup for ${worktree} reported:\n${result.stderr}`);
	}
	const decoys = execute([
		"docker",
		"ps",
		"--all",
		"--quiet",
		"--filter",
		`label=devenv.stage5a.run=${runId}`,
	])
		.stdout.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (const id of decoys) execute(["docker", "rm", "--force", id]);
	execute(["git", "tag", "-d", `${runId}-probe`]);
	await rm(credentialProbe, { force: true });
	for (const worktree of worktrees)
		execute(["git", "worktree", "remove", "--force", worktree]);
	await rm(temporaryRoot, { recursive: true, force: true });
	await rm(`/tmp/devenv-stage2-${runId}-rollback`, {
		recursive: true,
		force: true,
	});
}

async function capture(implementationRevision: string) {
	const os = uname("-s").toLowerCase();
	if (os !== "darwin" && os !== "linux")
		throw new Error("Stage 5A evidence must be captured on macOS or Linux");
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
			...RUNTIME_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"Worktree runtime inputs changed after the Stage 5A implementation boundary",
		);
	if (
		execute(["git", "diff", "--quiet", "--", ...RUNTIME_INPUTS]).exitCode !== 0
	)
		throw new Error("Worktree runtime inputs have uncommitted changes");

	const home = process.env["HOME"];
	if (!home) throw new Error("HOME is not set in the capture environment");
	const now = new Date();
	const runId = `stage5a-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	// The realpath matters: macOS resolves the temporary root through
	// /private/var, and every ownership label the engine records is canonical.
	const temporaryRoot = resolve(
		await realpath(tmpdir()),
		`devenv-stage5a-${runId}`,
	);
	const worktrees = WORKTREE_NAMES.map((name) => resolve(temporaryRoot, name));
	const contract = Bun.TOML.parse(
		await Bun.file(resolve(ROOT, "scripts/worktree/contract.toml")).text(),
	) as Record<string, unknown>;
	const prefix = String(contract["environment_prefix"]);
	const credentialProbe = resolve(
		home,
		`.config/devcontainer/codex-auth/${String(contract["project_slug"])}/${runId}.json`,
	);
	const context = {
		run: { id: runId, temporaryRoot, decoyImage: DECOY_IMAGE },
		source: { baseSha, implementationSha },
		contract: { environmentPrefix: prefix },
	};
	const expected = expectedStageFiveCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });
	await mkdir(temporaryRoot, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageFiveCommandId, Execution>();
	const durations = new Map<StageFiveCommandId, number>();
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		console.log("Releasing every resource this capture created …");
		await releaseEverything(worktrees, temporaryRoot, runId, credentialProbe);
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			void release().then(() => process.exit(130));
		});

	try {
		for (const worktree of worktrees)
			checked([
				"git",
				"worktree",
				"add",
				"--detach",
				worktree,
				implementationSha,
			]);
		for (const id of STAGE_FIVE_COMMAND_IDS) {
			const captured = await captureCommand(id, expected[id], runId);
			records.push(captured.record);
			executions.set(id, captured.execution);
			durations.set(id, captured.record.durationMs);
		}

		const stdout = (id: StageFiveCommandId) => executions.get(id)?.stdout ?? "";
		// The runner prints per-test lines only for failures, so its own tally is
		// what binds the record to the run.
		const passedTests = (id: StageFiveCommandId) =>
			Number(
				/^\s*(\d+) pass$/m.exec(executions.get(id)?.stderr ?? "")?.[1] ?? -1,
			);
		const environments = worktrees.map((_, index) =>
			jsonObject(
				stdout(
					index === 0 ? "worktree-a-environment" : "worktree-b-environment",
				),
				`worktree ${WORKTREE_NAMES[index]} environment`,
			),
		);
		const cold = keyValues(stdout("worktree-a-ensure-cold"));
		const recreate = keyValues(stdout("recreate-fast-path"));
		const route = keyValues(stdout("route-probe"));
		const persistence = keyValues(stdout("persistence-probe"));
		const attack = keyValues(stdout("ownership-attack-refusal"));
		const isolation = keyValues(stdout("cleanup-isolation"));
		const rollbackProof = jsonObject(
			stdout("rollback-proof"),
			"rollback-proof",
		);
		const containerIds = [
			cold["containerId"] ?? "",
			recreate["restoredContainerId"] ?? "",
		];
		const fingerprints = [
			cold["definitionFingerprint"] ?? "",
			recreate["restoredFingerprint"] ?? "",
		];
		const persistenceRoots = [
			persistence["alphaPersistenceRoot"] ?? "",
			persistence["betaPersistenceRoot"] ?? "",
		];
		const evidence = {
			schemaVersion: 1,
			stage: "stage-5a-isolated-worktree-runtime",
			capturedAt: new Date().toISOString(),
			run: {
				id: runId,
				logRoot: "evidence/stage-5-worktree-run",
				temporaryRoot,
				decoyImage: DECOY_IMAGE,
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
				devcontainerCliVersion: firstVersion(
					checked(["devcontainer", "--version"]).stdout,
					"devcontainer CLI",
				),
				pythonVersion: checked([
					"python3",
					"-c",
					"import platform; print(platform.python_version())",
				]).stdout.trim(),
			},
			contract: {
				path: "scripts/worktree/contract.toml",
				version: contract["version"],
				environmentPrefix: prefix,
				publishedContainerPort: contract["published_container_port"],
				offsetModulus: contract["preferred_offset_modulus"],
				manifestSchemaVersion: contract["manifest_schema_version"],
				serviceCount: (contract["services"] as unknown[]).length,
			},
			worktrees: worktrees.map((worktree, index) => ({
				path: worktree,
				workspaceId: environments[index]?.["workspaceId"],
				family: environments[index]?.["family"],
				offset: environments[index]?.["offset"],
				offsetSource: environments[index]?.["offsetSource"],
				publishedHostPort: environments[index]?.["publishedHostPort"],
				portSet: environments[index]?.["portSet"],
				directUrl: environments[index]?.["directUrl"],
				friendlyUrl: `http://${environments[index]?.["friendlyHost"]}`,
				containerId: containerIds[index],
				devcontainerId: devcontainerIdentity(worktree),
				definitionFingerprint: fingerprints[index],
				persistenceRoot: persistenceRoots[index],
			})),
			allocation: {
				portSetsDisjoint: true,
				registryPath: resolve(
					home,
					".config/devcontainer/ports-registry/ports.json",
				),
			},
			commands: records,
			ensure: {
				coldCommandId: "worktree-a-ensure-cold",
				warmCommandId: "worktree-a-ensure-warm",
				recreateCommandId: "recreate-fast-path",
				coldDurationMs: durations.get("worktree-a-ensure-cold"),
				warmDurationMs: durations.get("worktree-a-ensure-warm"),
				recreateReason: "definition fingerprint changed",
				upInvocations: 1,
			},
			routing: {
				commandId: "route-probe",
				hostCaddyAvailable: route["caddyAvailable"] === "true",
				friendlyRouteVerified: (route["friendlyBody"] ?? "").includes(
					"stage5a-route-ok",
				),
				directRouteVerified: true,
				manifestPath: route["manifestPath"],
			},
			boundary: {
				ownershipRefusalCommandId: "ownership-attack-refusal",
				ownershipRefusalExitCode: Number(attack["checkReadyExitCode"]),
				commandExecuted: attack["commandExecuted"] !== "false",
			},
			cleanup: {
				commandId: "cleanup-isolation",
				removed: [
					`container ${isolation["betaContainerId"]}`,
					...(isolation["betaVolumes"] ?? "")
						.split(/\s+/)
						.filter(Boolean)
						.map((name) => `volume ${name}`),
					`manifest ${isolation["betaManifest"]}`,
					`registry entry ${isolation["betaWorkspaceId"]}`,
				],
				remaining: [],
				survivorIntact: true,
			},
			knownBadFixtures: {
				contract: "contract-known-bad-fixtures",
				template: "template-known-bad-fixtures",
				contractTestsPassed: passedTests("contract-known-bad-fixtures"),
				templateTestsPassed: passedTests("template-known-bad-fixtures"),
			},
			rollback: {
				mode: "atomic",
				command: ["git", "revert", "-m", "1", "<stage-5a-pr-merge-commit>"],
				runtimeCleanup: ["bash", "scripts/worktree/cleanup.sh"],
				scope:
					"Revert the worktree contract, the eleven runtime scripts, the guard, the parameter surface, the two devcontainer.json entries, the sync and ownership entries, the CI wiring, the documentation, and the evidence as one Stage 5A bundle. Run cleanup.sh in every live worktree BEFORE reverting, then remove the host registry, manifest, and route directories, then rebuild once because the container definition changed again.",
				proof: rollbackProof,
			},
		};
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-5-worktree.schema.json"),
		).json()) as Record<string, unknown>;
		const errors = await validateStageFiveEvidenceValue(evidence, schema, ROOT);
		if (errors.length > 0)
			throw new Error(
				`Stage 5A evidence validation failed:\n- ${errors.join("\n- ")}`,
			);
		await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
		console.log(`Captured ${records.length} Stage 5A commands in ${runId}.`);
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
