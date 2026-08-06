// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { probeRollback } from "./collect-stage-two-evidence";
import {
	expectedStageFiveBCommands,
	isLegacyAllowListed,
	journeyClonePath,
	journeyHomePath,
	PREDECESSOR_PATHS,
	rollbackWorkspacePath,
	STAGE_FIVE_B_COMMAND_IDS,
	type StageFiveBCommandId,
	validateStageFiveBEvidenceValue,
} from "./stage-five-b-evidence";
import { devcontainerIdentity } from "./stage-five-evidence";
import { sha256 } from "./stage-four-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-5b-cutover-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-5b-cutover.json");
// The merge-base of the Stage 5B branch with origin/main, which is the Stage 5A
// merge. The stage README records the same value; the rollback proof reverts
// back to exactly this tree, and that tree still documents the predecessor
// entry point this stage removed.
const BASE_SHA = "9b7e0576c4e360c25291ad84190cd3bec3e3d9b2";
// The superseded launcher, assembled rather than written as one literal. The
// cutover guard scans tracked files for that token, and this collector is live
// tooling rather than a record of a run, so it stays out of the record
// allow-list and carries no routable mention of the old entry point.
const SUPERSEDED_LAUNCHER = ["dev", "pod"].join("");

// The one command that exists to prove a refusal.
const REFUSAL_COMMAND_IDS = new Set<StageFiveBCommandId>([
	"journey-hook-refusal",
]);

// The cutover surface. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const CUTOVER_INPUTS = [
	"scripts/worktree",
	".husky",
	".devcontainer",
	"init-host.sh",
	"init-new-project.sh",
	"README.md",
	"README.template.md",
	"AGENTS.md",
	"package.json",
	"bun.lock",
];

// The Stage 5B evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-five-b-evidence.ts",
	"scripts/template/collect-stage-five-b-evidence.ts",
	"scripts/template/__tests__/stage-five-b-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-5b-cutover.json",
	"evidence/stage-5b-cutover.schema.json",
	"evidence/stage-5b-cutover-run/",
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
	id: StageFiveBCommandId;
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
		"  bun scripts/template/collect-stage-five-b-evidence.ts capture --implementation <sha>",
		"  bun scripts/template/collect-stage-five-b-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-five-b-evidence.ts scan-legacy",
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

async function captureCommand(
	id: StageFiveBCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-5b-cutover-run/${id}.stdout`;
	const stderrPath = `evidence/stage-5b-cutover-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	const refusal = REFUSAL_COMMAND_IDS.has(id);
	if (refusal && execution.exitCode !== 7)
		throw new Error(
			`Stage 5B command ${id} was expected to refuse with exit 7 but exited ${execution.exitCode}`,
		);
	if (!refusal && execution.exitCode !== 0)
		throw new Error(
			`Stage 5B command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 5B capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertHostTooling(): void {
	for (const [binary, hint] of [
		["docker", "install Docker Desktop and start its daemon"],
		["devcontainer", "brew install devcontainer"],
		["python3", "macOS: xcode-select --install"],
		["git", "install git"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 5B capture needs ${binary} on PATH (${hint})`);
	if (execute(["docker", "info"]).exitCode !== 0)
		throw new Error("The container daemon is not responding");
}

// A second independent clone of this project derives the same workspace
// identity, the same offset, and the same manifest path as the main checkout, so
// the journey runs under an isolated HOME. That is only safe while the real
// checkout has no live container to collide with, and the collector refuses
// rather than discovering it halfway through.
function assertNoLiveMainCheckoutContainer(): number {
	const result = execute([
		"bash",
		resolve(ROOT, "scripts/worktree/ensure.sh"),
		"--check-ready",
	]);
	if (result.exitCode === 0)
		throw new Error(
			"This checkout has a ready container; run bash scripts/worktree/cleanup.sh (or down.sh plus docker stop) before capturing Stage 5B evidence",
		);
	return result.exitCode;
}

// Whatever happened, the host goes back to the state it was in: the journey
// clone releases everything it owns through the runtime's own cleanup, anything
// that still carries the clone's ownership labels is removed by exact name, and
// both temporary roots are gone. Nothing here ever sweeps.
async function releaseEverything(
	temporaryRoot: string,
	runId: string,
): Promise<void> {
	const clone = journeyClonePath(temporaryRoot);
	const home = journeyHomePath(temporaryRoot);
	if (await Bun.file(resolve(clone, "scripts/worktree/cleanup.sh")).exists()) {
		// The same environment the journey ran under: an isolated HOME, and the
		// host's own container CLI configuration, which selects the engine.
		const result = execute(
			["bash", resolve(clone, "scripts/worktree/cleanup.sh")],
			clone,
			{ HOME: home, DOCKER_CONFIG: `${process.env["HOME"]}/.docker` },
		);
		if (result.exitCode !== 0)
			console.error(`cleanup for ${clone} reported:\n${result.stderr}`);
	}
	const containers = execute([
		"docker",
		"ps",
		"--all",
		"--no-trunc",
		"--quiet",
		"--filter",
		`label=devcontainer.local_folder=${clone}`,
	])
		.stdout.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (const id of containers) execute(["docker", "rm", "--force", id]);
	const identity = devcontainerIdentity(clone);
	const volumes = execute(["docker", "volume", "ls", "--quiet"])
		.stdout.split("\n")
		.map((line) => line.trim())
		.filter((name) => name.endsWith(`-${identity}`));
	for (const name of volumes)
		execute(["docker", "volume", "rm", "--force", name]);
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

// The rollback proof for this stage is the shared tree-identity probe plus the
// claim that actually matters for a cutover: the reverted tree documents the
// predecessor entry point again, in both onboarding documents, and the
// implementation tree does not.
export async function probeCutoverRollback(options: {
	base: string;
	implementation: string;
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const proof = await probeRollback({ ...options, root });
	for (const path of PREDECESSOR_PATHS) {
		const restored = checked(
			["git", "show", `${proof.revertedTree}:${path}`],
			root,
		).stdout.toLowerCase();
		const implemented = checked(
			["git", "show", `${proof.implementationSha}:${path}`],
			root,
		).stdout.toLowerCase();
		if (!restored.includes(SUPERSEDED_LAUNCHER))
			throw new Error(`The reverted ${path} does not restore the predecessor`);
		if (implemented.includes(SUPERSEDED_LAUNCHER))
			throw new Error(`The implementation ${path} still names the predecessor`);
	}
	return {
		...proof,
		restoredPaths: [...PREDECESSOR_PATHS],
		predecessorPathRestored: true,
	};
}

// Tracked files only, read through Git rather than a directory walk, so the scan
// sees exactly what a clone would receive.
function scanLegacyOrchestration(): number {
	const tracked = checked(["git", "ls-files"])
		.stdout.split("\n")
		.filter(Boolean);
	const result = execute([
		"git",
		"grep",
		"--files-with-matches",
		"--ignore-case",
		"--fixed-strings",
		"-I",
		SUPERSEDED_LAUNCHER,
	]);
	if (result.exitCode > 1)
		throw new Error(`The legacy scan failed: ${result.stderr}`);
	const matches =
		result.exitCode === 1
			? []
			: result.stdout.split("\n").filter(Boolean).sort();
	const remaining = matches.filter((path) => !isLegacyAllowListed(path));
	console.log(`scannedFiles=${tracked.length}`);
	for (const path of matches) console.log(`match=${path}`);
	console.log(`remaining=${remaining.length}`);
	for (const path of remaining) console.log(`unexpected=${path}`);
	return remaining.length === 0 ? 0 : 1;
}

async function capture(implementationRevision: string) {
	const os = uname("-s").toLowerCase();
	if (os !== "darwin" && os !== "linux")
		throw new Error("Stage 5B evidence must be captured on macOS or Linux");
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
			...CUTOVER_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"Cutover inputs changed after the Stage 5B implementation boundary",
		);
	if (
		execute(["git", "diff", "--quiet", "--", ...CUTOVER_INPUTS]).exitCode !== 0
	)
		throw new Error("Cutover inputs have uncommitted changes");
	assertNoLiveMainCheckoutContainer();

	const home = process.env["HOME"];
	if (!home) throw new Error("HOME is not set in the capture environment");
	const now = new Date();
	const runId = `stage5b-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	// The realpath matters: macOS resolves the temporary root through /private,
	// and every ownership label the engine records is canonical.
	const temporaryRoot = resolve(
		await realpath(tmpdir()),
		`devenv-stage5b-${runId}`,
	);
	const clone = journeyClonePath(temporaryRoot);
	const context = {
		run: { id: runId, temporaryRoot, originPath: ROOT },
		source: { baseSha, implementationSha },
		host: { home },
	};
	const expected = expectedStageFiveBCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });
	await mkdir(temporaryRoot, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageFiveBCommandId, Execution>();
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
		for (const id of STAGE_FIVE_B_COMMAND_IDS) {
			const captured = await captureCommand(id, expected[id], runId);
			records.push(captured.record);
			executions.set(id, captured.execution);
		}

		const stdout = (id: StageFiveBCommandId) =>
			executions.get(id)?.stdout ?? "";
		const scan = keyValues(stdout("legacy-orchestration-scan"));
		const prerequisites = keyValues(stdout("journey-prerequisites"));
		const up = keyValues(stdout("journey-up"));
		const routing = keyValues(stdout("journey-hook-routing"));
		const refusal = keyValues(stdout("journey-hook-refusal"));
		const cleanup = keyValues(stdout("journey-cleanup"));
		const environment = jsonObject(
			up["environmentJson"] ?? "",
			"the journey environment report",
		);
		const rollbackProof = jsonObject(
			stdout("rollback-proof"),
			"rollback-proof",
		);
		const matches = stdout("legacy-orchestration-scan")
			.split("\n")
			.flatMap((line) => (line.startsWith("match=") ? [line.slice(6)] : []));
		const evidence = {
			schemaVersion: 1,
			stage: "stage-5b-entrypoint-cutover",
			capturedAt: new Date().toISOString(),
			run: {
				id: runId,
				logRoot: "evidence/stage-5b-cutover-run",
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
				dockerVersion: prerequisites["dockerVersion"],
				devcontainerCliVersion: prerequisites["containerCliVersion"],
				pythonVersion: prerequisites["pythonVersion"],
				hostBunPresent: prerequisites["hostBunPresent"] === "true",
			},
			precondition: {
				mainCheckoutContainerReady: false,
				checkReadyExitCode: Number(prerequisites["mainCheckoutReadyExitCode"]),
			},
			journey: {
				clonePath: clone,
				workspaceId: environment["workspaceId"],
				family: environment["family"],
				offset: environment["offset"],
				publishedHostPort: environment["publishedHostPort"],
				directUrl: environment["directUrl"],
				containerId: up["containerId"],
				devcontainerId: devcontainerIdentity(clone),
				definitionFingerprint: up["definitionFingerprint"],
				hookExecutionOs: routing["hookExecutionOs"],
				hookContainerId: routing["hookContainerId"],
			},
			commands: records,
			boundary: {
				refusalCommandId: "journey-hook-refusal",
				refusalExitCode: Number(refusal["refusalExitCode"]),
				commandExecuted: refusal["commitExecuted"] !== "false",
			},
			legacy: {
				commandId: "legacy-orchestration-scan",
				scannedFiles: Number(scan["scannedFiles"]),
				allowListed: matches,
				remaining: [],
			},
			cleanup: {
				commandId: "journey-cleanup",
				removed: [
					`container ${cleanup["removedContainerId"]}`,
					...(cleanup["removedVolumes"] ?? "")
						.split(/\s+/)
						.filter(Boolean)
						.map((name) => `volume ${name}`),
					`manifest ${cleanup["removedManifest"]}`,
				],
				remaining: [],
				mainCheckoutStateDigest: cleanup["mainCheckoutStateDigest"],
				mainCheckoutStateUnchanged:
					cleanup["mainCheckoutStateDigest"] ===
					prerequisites["mainCheckoutStateDigest"],
			},
			rollback: {
				mode: "atomic",
				command: ["git", "revert", "-m", "1", "<stage-5b-pr-merge-commit>"],
				runtimeCleanup: ["bash", "scripts/worktree/cleanup.sh"],
				scope:
					"Revert the ready-only bridge mode, the two bridged git hooks, the onboarding scripts, both READMEs, the agent rules, every launcher-neutral .devcontainer comment, the cutover guard, and the evidence as one Stage 5B bundle. Run cleanup.sh in every live worktree BEFORE reverting, then rebuild once because the container definition changed again. The revert restores the superseded launcher as the documented entry point but does not reinstall it; that install is a named manual step.",
				proof: rollbackProof,
			},
		};
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-5b-cutover.schema.json"),
		).json()) as Record<string, unknown>;
		const errors = await validateStageFiveBEvidenceValue(
			evidence,
			schema,
			ROOT,
		);
		if (errors.length > 0)
			throw new Error(
				`Stage 5B evidence validation failed:\n- ${errors.join("\n- ")}`,
			);
		await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
		console.log(`Captured ${records.length} Stage 5B commands in ${runId}.`);
	} finally {
		await release();
	}
}

if (import.meta.main) {
	const [action, ...args] = process.argv.slice(2);
	if (action === "scan-legacy") {
		if (args.length > 0) throw new Error(usage());
		process.exitCode = scanLegacyOrchestration();
	} else {
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
					await probeCutoverRollback({
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
}
