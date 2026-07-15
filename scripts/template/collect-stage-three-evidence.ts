// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	expectedStageThreeCommands,
	STAGE_THREE_COMMAND_IDS,
	type StageThreeCommandId,
	sha256,
	validateStageThreeEvidenceValue,
} from "./stage-three-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-3-runtimes-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-3-runtimes.json");
const BASE_SHA = "2a2d4ab71723a608e7170d93a47622b6d92d2fac";

interface Execution {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageThreeCommandId;
	command: string[];
	runId: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	stdoutPath: string;
	stderrPath: string;
	stdoutSha256: string;
	stderrSha256: string;
	exitCode: 0;
	status: "pass";
}

function usage(): string {
	return "usage: bun scripts/template/collect-stage-three-evidence.ts capture --image <tag> --implementation <sha>";
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

function dockerArg(source: string, name: string): string {
	const value = new RegExp(`^ARG ${name}=([^\\s]+)$`, "m").exec(source)?.[1];
	if (!value) throw new Error(`Docker authority ${name} is missing`);
	return value;
}

async function captureCommand(
	id: StageThreeCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-3-runtimes-run/${id}.stdout`;
	const stderrPath = `evidence/stage-3-runtimes-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	if (execution.exitCode !== 0)
		throw new Error(
			`Stage 3 command ${id} failed (${execution.exitCode}); see ${stderrPath}`,
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
			exitCode: 0,
			status: "pass",
		},
		execution,
	};
}

async function capture(imageTag: string, implementationRevision: string) {
	const baseSha = gitSha(BASE_SHA);
	const implementationSha = gitSha(implementationRevision);
	checked(["git", "merge-base", "--is-ancestor", baseSha, implementationSha]);
	checked(["git", "merge-base", "--is-ancestor", implementationSha, "HEAD"]);
	const dirty = checked([
		"git",
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		".",
		":(exclude)graphify-out",
	]).stdout.trim();
	if (dirty)
		throw new Error(`Stage 3 capture requires a clean feature tree:\n${dirty}`);
	if (
		execute([
			"git",
			"diff",
			"--quiet",
			implementationSha,
			"HEAD",
			"--",
			".devcontainer",
			"package.json",
			"bun.lock",
			"scripts/browser-preflight.ts",
		]).exitCode !== 0
	)
		throw new Error(
			"Runtime inputs changed after the Stage 3 implementation boundary",
		);

	const inspect = checked([
		"docker",
		"image",
		"inspect",
		"--format",
		"{{json .Id}}|{{json .Architecture}}|{{json .Os}}",
		imageTag,
	]).stdout.trim();
	const [imageIdJson, architectureJson, osJson] = inspect.split("|");
	const imageId = JSON.parse(imageIdJson ?? "null") as string;
	const architecture = JSON.parse(architectureJson ?? "null") as string;
	const os = JSON.parse(osJson ?? "null") as string;
	if (!imageId || !["amd64", "arm64"].includes(architecture) || os !== "linux")
		throw new Error(`Unsupported image identity: ${inspect}`);
	const now = new Date();
	const runId = `stage3-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		image: { tag: imageTag, architecture },
	};
	const expected = expectedStageThreeCommands(context);
	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });
	const records: CapturedCommand[] = [];
	const executions = new Map<StageThreeCommandId, Execution>();
	const durations = new Map<StageThreeCommandId, number>();
	for (const id of STAGE_THREE_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
		durations.set(id, captured.record.durationMs);
	}

	const recordedInspect = (
		executions.get("image-inspect")?.stdout ?? ""
	).trim();
	const [recordedImageIdJson, recordedArchitectureJson, recordedOsJson] =
		recordedInspect.split("|");
	const recordedImageId = JSON.parse(recordedImageIdJson ?? "null") as string;
	const recordedArchitecture = JSON.parse(
		recordedArchitectureJson ?? "null",
	) as string;
	const recordedOs = JSON.parse(recordedOsJson ?? "null") as string;
	if (
		!recordedImageId ||
		recordedArchitecture !== architecture ||
		recordedOs !== os
	)
		throw new Error(`Recorded image identity is invalid: ${recordedInspect}`);
	const launcher = keyValues(executions.get("launcher-smoke")?.stdout ?? "");
	const plugin = keyValues(executions.get("plugin-repair-smoke")?.stdout ?? "");
	if (
		!(executions.get("browser-preflight")?.stdout ?? "").includes(
			"Browser preflight passed",
		)
	)
		throw new Error("Browser preflight did not report a completed launch");
	const shellCases = [
		["bash", "login", "shell-bash-login"],
		["bash", "non-login", "shell-bash-non-login"],
		["zsh", "login", "shell-zsh-login"],
		["zsh", "non-login", "shell-zsh-non-login"],
	] as const;
	const shellPaths = shellCases.map(([shell, mode, id]) => {
		const lines = (executions.get(id)?.stdout ?? "").trim().split("\n");
		if (lines.length !== 4) throw new Error(`Unexpected ${id} output`);
		return {
			shell,
			mode,
			commandId: id,
			bun: lines[0],
			proto: lines[1],
			codex: lines[2],
			path: lines[3],
		};
	});
	const storage = jsonObject(
		executions.get("second-worktree-storage")?.stdout ?? "",
		"second-worktree-storage",
	);
	const rollbackProof = jsonObject(
		executions.get("rollback-proof")?.stdout ?? "",
		"rollback-proof",
	);
	const stageTwo = (await Bun.file(
		resolve(ROOT, "evidence/stage-2-image.json"),
	).json()) as Record<string, unknown>;
	const stageTwoBuilds = stageTwo["builds"] as Record<string, unknown>;
	const stageTwoWarm = stageTwoBuilds["warm"] as Record<string, unknown>;
	const stageTwoStorage = stageTwo["secondWorktreeStorage"] as Record<
		string,
		unknown
	>;
	const dockerfile = await Bun.file(
		resolve(ROOT, ".devcontainer/Dockerfile"),
	).text();
	const evidence = {
		schemaVersion: 1,
		stage: "stage-3-browser-agent-runtimes",
		capturedAt: new Date().toISOString(),
		run: {
			id: runId,
			logRoot: "evidence/stage-3-runtimes-run",
			temporaryRoot: `/tmp/devenv-stage2-${runId}`,
		},
		source: { baseSha, implementationSha, featureTreeClean: true },
		image: {
			tag: imageTag,
			imageId: recordedImageId,
			architecture,
			os,
			pins: {
				playwright: dockerArg(dockerfile, "PLAYWRIGHT_VERSION"),
				codex: dockerArg(dockerfile, "CODEX_VERSION"),
				gemini: dockerArg(dockerfile, "GEMINI_VERSION"),
				graphify: dockerArg(dockerfile, "GRAPHIFY_VERSION"),
				claude: dockerArg(dockerfile, "CLAUDE_VERSION"),
				ccstatusline: dockerArg(dockerfile, "CCSTATUSLINE_VERSION"),
				context7: dockerArg(dockerfile, "CONTEXT7_VERSION"),
				octopusCommit: dockerArg(dockerfile, "OCTOPUS_COMMIT"),
				octopusSha256: dockerArg(dockerfile, "OCTOPUS_SHA256"),
				warpCommit: dockerArg(dockerfile, "WARP_COMMIT"),
				warpSha256: dockerArg(dockerfile, "WARP_SHA256"),
			},
		},
		commands: records,
		browser: {
			commandId: "browser-preflight",
			markerPath: "/home/vscode/.payloads/browser/.devenv-playwright-version",
			markerVersion: launcher["playwright"],
			executablePath: launcher["browserExecutable"],
			launchPassed: true,
		},
		launchers: Object.fromEntries(
			[
				"codex",
				"gemini",
				"graphify",
				"claude",
				"ccstatusline",
				"context7-mcp",
			].map((tool) => [tool, launcher[tool]]),
		),
		shellPaths,
		plugins: {
			commandId: "plugin-repair-smoke",
			octopusInstallPath: plugin["octopusInstallPath"],
			warpInstallPath: plugin["warpInstallPath"],
			persistedSourceRepair: plugin["persistedSourceRepair"] === "pass",
			sharedGraphifyResidue: plugin["sharedGraphifyResidue"] !== "absent",
		},
		knownBadFixtures: {
			browser: "browser-known-bad-fixtures",
			agents: "agent-known-bad-fixtures",
			watchdog: "watchdog-known-bad-fixtures",
			watchdogTestCount: 14,
			idleTimeoutExitCode: 124,
			processGroupCleanup: true,
		},
		comparison: {
			warmBuildCommandId: "warm-browser-build",
			warmBuildDurationMs: durations.get("warm-browser-build"),
			stageTwoWarmBuildDurationMs: stageTwoWarm["durationMs"],
			browserPreflightDurationMs: durations.get("browser-preflight"),
			storageCommandId: "second-worktree-storage",
			secondWorktreeObservedBytes: storage["observedBytes"],
			stageTwoSecondWorktreeObservedBytes: stageTwoStorage["observedBytes"],
			stageZeroSecondWorktreeBaselineBytes: storage["stageZeroBaselineBytes"],
		},
		cloudHandoff: {
			ownerStage: "stage-4-codex-cloud-parity",
			requiredProfile: "browser",
			requiredCommand: "bun run browser:preflight",
			requiredMarkerPath:
				"/home/vscode/.payloads/browser/.devenv-playwright-version",
			requiredEnvironment: "PLAYWRIGHT_BROWSERS_PATH",
		},
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-3-pr-merge-commit>"],
			runtimeCleanup: ["docker", "image", "rm", imageTag],
			scope:
				"Revert browser, agent payload, watchdog, setup, tests, evidence, and documentation as one Stage 3 bundle; then rebuild and recreate the devcontainer.",
			proof: rollbackProof,
		},
	};
	const schema = (await Bun.file(
		resolve(ROOT, "evidence/stage-3-runtimes.schema.json"),
	).json()) as Record<string, unknown>;
	const errors = await validateStageThreeEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 3 evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`Captured ${records.length} Stage 3 commands in ${runId}.`);
}

if (import.meta.main) {
	const [action, ...args] = process.argv.slice(2);
	if (action !== "capture") throw new Error(usage());
	const options = parseOptions(args);
	for (const key of options.keys())
		if (!["--image", "--implementation"].includes(key))
			throw new Error(`Unknown option ${key}\n${usage()}`);
	await capture(
		required(options, "--image"),
		required(options, "--implementation"),
	);
}
