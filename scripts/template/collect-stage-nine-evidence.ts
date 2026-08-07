// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	AGENT_SURFACES,
	VENDOR_ARTIFACTS,
	validateAgentRulesContract,
} from "./agent-rules-contract";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { inspectOpenspec } from "./openspec-contract";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	EXPECTED_OBSERVATIONS,
	expectedStageNineCommands,
	GATED_PATHS,
	GENERATED_ARTIFACT_COUNT,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	lifecycleWorkspacePath,
	REPLACED_ARTIFACTS,
	renderWorkspacePath,
	rollbackWorkspacePath,
	STAGE_EIGHT_B_MERGE_SHA,
	STAGE_NINE_COMMAND_IDS,
	STAGE_NINE_FIXTURES,
	type StageNineCommandId,
	validateStageNineEvidenceValue,
} from "./stage-nine-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-9-openspec.json");
const SCHEMA_PATH = resolve(ROOT, "evidence/stage-9-openspec.schema.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const OPENSPEC_GUARD_SCRIPT = "openspec:check";
const RULES_GUARD_SCRIPT = "rules:check";
const TEMPLATE_CHANGE = "portable-devcontainer-upgrade";

// The lifecycle surface. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const LIFECYCLE_INPUTS = [
	".claude",
	".github",
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	"openspec/config.yaml",
	"package.json",
	"scripts/openspec",
	"scripts/template/agent-rules",
	"scripts/template/agent-rules-contract.ts",
	"scripts/template/openspec-contract.ts",
	"scripts/template/sync-agent-rules.ts",
	"scripts/template/validate-agent-rules.ts",
	"scripts/template/validate-openspec.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
];

// The Stage 9 evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-nine-evidence.ts",
	"scripts/template/collect-stage-nine-evidence.ts",
	"scripts/template/__tests__/stage-nine-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-9-openspec.json",
	"evidence/stage-9-openspec.schema.json",
	"evidence/stage-9-openspec-run/",
	"graphify-out",
	"node_modules",
	"tmp",
];

interface Execution {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageNineCommandId;
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
	status: "pass";
}

function usage(): string {
	return [
		"usage:",
		"  bun scripts/template/collect-stage-nine-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-nine-evidence.ts probe-lifecycle --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-nine-evidence.ts probe-render-openspec --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-nine-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs INSIDE the devcontainer: the pinned OpenSpec CLI, node and gh",
		"are image- or workspace-owned and the host has none of them.",
		"  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-nine-evidence.ts capture …",
	].join("\n");
}

function parseOptions(args: string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
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
		...(environment ? { env: environment } : {}),
		stdin: "ignore",
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

function checked(
	command: string[],
	cwd = ROOT,
	environment?: Record<string, string>,
): Execution {
	const result = execute(command, cwd, environment);
	if (result.exitCode !== 0)
		throw new Error(
			`Command failed (${result.exitCode}): ${JSON.stringify(command)}\n${result.stderr || result.stdout}`,
		);
	return result;
}

function gitSha(revision: string, cwd = ROOT): string {
	const sha = checked(
		["git", "rev-parse", "--verify", `${revision}^{commit}`],
		cwd,
	).stdout.trim();
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
	id: StageNineCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `${LOG_ROOT_RELATIVE}/${id}.stdout`;
	const stderrPath = `${LOG_ROOT_RELATIVE}/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	if (execution.exitCode !== 0)
		throw new Error(
			`Stage 9 command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
		);
	console.log(`  ${id} passed in ${Math.round((completed - started) / 1000)}s`);
	const { sha256 } = await import("./stage-four-evidence");
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
			status: "pass",
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
			`Stage 9 capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsInsideTheContainer(): void {
	// The pinned OpenSpec CLI is a workspace binary and node is image-owned. A
	// capture attempted on the host would either fail on the missing runtime or,
	// worse, find some other openspec and seal a version this repository never
	// pins.
	if (process.env["DEVCONTAINER"] !== "true")
		throw new Error(
			"Stage 9 evidence must be captured inside the devcontainer:\n  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-nine-evidence.ts capture …",
		);
	for (const [binary, hint] of [
		["node", "rebuild the devcontainer image"],
		["gh", "gh auth login"],
		["python3", "rebuild the devcontainer image"],
		["shasum", "rebuild the devcontainer image"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 9 capture needs ${binary} on PATH (${hint})`);
}

function assertTemporary(workspace: string): string {
	const path = resolve(workspace);
	if (!path.startsWith("/tmp/") || path.length < 12)
		throw new Error(`Refusing to work outside /tmp: ${path}`);
	return path;
}

const PROPOSAL = [
	"# Disposable probe",
	"",
	"## Why",
	"",
	"A throwaway change that exists only so one whole archive lifecycle can be observed end to end.",
	"",
	"## What Changes",
	"",
	"- **probe-cap:** one requirement",
	"",
].join("\n");

function deltaSpec(capability: string, requirement: string): string {
	return [
		`# ${capability}`,
		"",
		"## ADDED Requirements",
		"",
		`### Requirement: ${requirement}`,
		"",
		"The system SHALL probe.",
		"",
		"#### Scenario: Probing",
		"",
		"- **WHEN** probed",
		"- **THEN** it answers",
		"",
	].join("\n");
}

function tasks(complete: number, remaining: number): string {
	const lines = ["## 1. Work", ""];
	for (let index = 0; index < complete; index += 1)
		lines.push(`- [x] 1.${index + 1} Done`);
	for (let index = 0; index < remaining; index += 1)
		lines.push(`- [ ] 2.${index + 1} Pending`);
	lines.push("");
	return lines.join("\n");
}

const NARROW_ENVIRONMENT = (home: string): Record<string, string> => ({
	PATH: process.env["PATH"] ?? "",
	HOME: home,
	LANG: "C",
	// The declared "run in place" value of the wrapper's one injection point.
	// No container is involved: this probe already runs inside one.
	OPENSPEC_BRIDGE: "",
});

async function writeChange(
	root: string,
	name: string,
	options: {
		complete: number;
		remaining: number;
		capability: string;
		requirement: string;
	},
): Promise<void> {
	const directory = resolve(root, "openspec/changes", name);
	await mkdir(resolve(directory, "specs", options.capability), {
		recursive: true,
	});
	await Bun.write(
		resolve(directory, ".openspec.yaml"),
		"schema: spec-driven\ncreated: 2026-01-01\n",
	);
	await Bun.write(resolve(directory, "proposal.md"), PROPOSAL);
	await Bun.write(
		resolve(directory, "tasks.md"),
		tasks(options.complete, options.remaining),
	);
	await Bun.write(
		resolve(directory, "specs", options.capability, "spec.md"),
		deltaSpec(options.capability, options.requirement),
	);
}

/**
 * One whole archive lifecycle, in a throwaway clone with its own bare origin.
 *
 * This is the only thing in the record that shows the wrapper doing its job
 * rather than refusing to. It runs the REAL pinned CLI through a shim inside the
 * clone's own node_modules, because the guard refuses a binary anywhere else —
 * and it never touches this repository's own OpenSpec tree, which is asserted at
 * the end rather than assumed.
 */
export async function probeLifecycle(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const base = assertTemporary(options.workspace);
	await rm(base, { recursive: true, force: true });
	const clone = resolve(base, "clone");
	const origin = resolve(base, "origin.git");
	const change = "disposable-archive-probe";
	const environment = NARROW_ENVIRONMENT(base);
	const identity = [
		"-c",
		"user.email=stage-nine@example.invalid",
		"-c",
		"user.name=Stage Nine Probe",
		"-c",
		"commit.gpgsign=false",
	];
	const git = (cwd: string, ...args: string[]): Execution =>
		checked(["git", "-C", cwd, ...identity, ...args], root, environment);

	await mkdir(resolve(clone, ".moon"), { recursive: true });
	await mkdir(resolve(clone, "scripts/openspec"), { recursive: true });
	await mkdir(resolve(clone, "scripts/template"), { recursive: true });
	await Bun.write(
		resolve(clone, ".moon/workspace.yml"),
		[
			"projects:",
			"  sources:",
			"    root: '.'",
			"vcs:",
			"  defaultBranch: 'main'",
			"",
		].join("\n"),
	);
	await Bun.write(resolve(clone, ".gitignore"), "node_modules/\n");
	await Bun.write(
		resolve(clone, "scripts/openspec/archive.sh"),
		Bun.file(resolve(root, "scripts/openspec/archive.sh")),
	);
	await chmod(resolve(clone, "scripts/openspec/archive.sh"), 0o755);
	// The real guard, not a stand-in: the wrapper re-runs `openspec:check` on the
	// archived tree before it commits, and a probe that faked that step would
	// prove nothing about the one validation gating the commit.
	for (const name of ["openspec-contract.ts", "validate-openspec.ts"])
		await Bun.write(
			resolve(clone, "scripts/template", name),
			Bun.file(resolve(root, "scripts/template", name)),
		);
	await Bun.write(
		resolve(clone, "package.json"),
		`${JSON.stringify(
			{
				name: "stage-nine-lifecycle-probe",
				workspaces: {
					catalog: {
						"@fission-ai/openspec": (
							(await Bun.file(resolve(root, "package.json")).json()) as {
								workspaces: { catalog: Record<string, string> };
							}
						).workspaces.catalog["@fission-ai/openspec"],
					},
				},
				scripts: {
					"openspec:check": "bun scripts/template/validate-openspec.ts",
				},
			},
			null,
			"\t",
		)}\n`,
	);
	await Bun.write(
		resolve(clone, "openspec/config.yaml"),
		Bun.file(resolve(root, "openspec/config.yaml")),
	);
	await writeChange(clone, change, {
		complete: 3,
		remaining: 0,
		capability: "probe-cap",
		requirement: "Disposable Probe",
	});
	await writeChange(clone, "still-open", {
		complete: 1,
		remaining: 2,
		capability: "still-open-cap",
		requirement: "Still Open",
	});
	await mkdir(resolve(clone, "node_modules/.bin"), { recursive: true });
	const shim = resolve(clone, "node_modules/.bin/openspec");
	await Bun.write(
		shim,
		`#!/usr/bin/env bash\nexec node ${resolve(root, "node_modules/@fission-ai/openspec/bin/openspec.js")} "$@"\n`,
	);
	await chmod(shim, 0o755);

	checked(
		["git", "init", "--quiet", "--bare", "--initial-branch=main", origin],
		root,
		environment,
	);
	git(clone, "init", "--quiet", "--initial-branch=main");
	git(clone, "add", "-A");
	git(clone, "commit", "--quiet", "--no-verify", "-m", "chore: probe fixture");
	git(clone, "config", "user.email", "stage-nine@example.invalid");
	git(clone, "config", "user.name", "Stage Nine Probe");
	git(clone, "remote", "add", "origin", origin);
	git(clone, "push", "--quiet", "-u", "origin", "main");
	const originBefore = git(
		origin,
		"rev-parse",
		"refs/heads/main",
	).stdout.trim();
	const stillOpenBefore = await Bun.file(
		resolve(clone, "openspec/changes/still-open/tasks.md"),
	).text();

	const wrapper = ["bash", "scripts/openspec/archive.sh", "--change", change];
	const first = execute(wrapper, clone, environment);
	const date = new Date().toISOString().slice(0, 10);
	const destination = `openspec/changes/archive/${date}-${change}`;
	const mainSpec = await Bun.file(
		resolve(clone, "openspec/specs/probe-cap/spec.md"),
	)
		.text()
		.catch(() => "");
	const committed = execute(
		["git", "-C", clone, "show", "--name-only", "--format=", "HEAD"],
		root,
		environment,
	)
		.stdout.split("\n")
		.filter(Boolean);
	// Read BEFORE the duplicate-destination section below re-creates the change:
	// every one of these is a fact about the tree the first run left behind, and
	// asking after the restore would answer a different question.
	const afterArchive = {
		activeDirectoryRemoved: !(await Bun.file(
			resolve(clone, "openspec/changes", change, "proposal.md"),
		).exists()),
		archiveEntryPresent: await Bun.file(
			resolve(clone, destination, "proposal.md"),
		).exists(),
		mainSpecRequirementApplied: mainSpec.includes(
			"### Requirement: Disposable Probe",
		),
		secondChangeUntouched:
			(await Bun.file(
				resolve(clone, "openspec/changes/still-open/tasks.md"),
			).text()) === stillOpenBefore,
		commitSubject: execute(
			["git", "-C", clone, "log", "-1", "--format=%s"],
			root,
			environment,
		).stdout.trim(),
		originAdvanced:
			git(origin, "rev-parse", "refs/heads/main").stdout.trim() !==
			originBefore,
	};

	// The duplicate-destination refusal: the CLI would rewrite the main specs and
	// then report the duplicate with exit 0, so the wrapper has to see it first.
	await writeChange(clone, change, {
		complete: 3,
		remaining: 0,
		capability: "probe-cap",
		requirement: "Disposable Probe",
	});
	git(clone, "add", "-A");
	git(
		clone,
		"commit",
		"--quiet",
		"--no-verify",
		"-m",
		"chore: restore the probe",
	);
	git(clone, "push", "--quiet", "origin", "main");
	const beforeSecond = git(clone, "rev-parse", "HEAD").stdout.trim();
	const second = execute(wrapper, clone, environment);
	const afterSecond = git(clone, "rev-parse", "HEAD").stdout.trim();
	const secondStatus = execute(
		["git", "-C", clone, "status", "--porcelain", "--untracked-files=all"],
		root,
		environment,
	).stdout.trim();

	// The standing constraint, checked rather than trusted: this repository's own
	// active change was never a participant in any of the above.
	const inspection = await inspectOpenspec(root);
	const active = inspection.roots[0]?.changes.map((entry) => entry.name) ?? [];

	const result = {
		change,
		archiveExitCode: first.exitCode,
		destination,
		...afterArchive,
		stagedOutsideRoot: committed.filter((path) => !path.startsWith("openspec/"))
			.length,
		committedPathCount: committed.length,
		secondRunExitCode: second.exitCode,
		secondRunTouchedTree: secondStatus !== "" || beforeSecond !== afterSecond,
		templateChangeStillActive: active.includes(TEMPLATE_CHANGE),
	};
	await rm(base, { recursive: true, force: true });
	if (result.archiveExitCode !== 0)
		throw new Error(`The lifecycle probe did not archive:\n${first.stderr}`);
	return { result };
}

/**
 * What each fixture actually received, on its own terms.
 *
 * The two halves are the gated surface and the CORE one. A project without the
 * capability must receive none of the OpenSpec paths, no `openspec:check` and no
 * fenced step — while still receiving both cross-agent rule scripts and the
 * ungated `rules:check` step, because every project has agent rule files.
 */
export async function probeRenderOpenspec(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_NINE_FIXTURES) {
			const output = resolve(workspace, declared.name);
			const rendered = await renderFixture({
				root,
				fixtureName: declared.name,
				output,
			});
			const gatedPaths: string[] = [];
			for (const path of GATED_PATHS) {
				if (await Bun.file(resolve(output, path)).exists())
					gatedPaths.push(path);
			}
			const manifest = (await Bun.file(
				resolve(output, "package.json"),
			).json()) as {
				scripts: Record<string, string>;
			};
			const packageScripts = [
				OPENSPEC_GUARD_SCRIPT,
				RULES_GUARD_SCRIPT,
				"rules:sync",
			].filter((name) => typeof manifest.scripts[name] === "string");
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			let generatedArtifactCount = 0;
			for (const path of VENDOR_ARTIFACTS) {
				if (await Bun.file(resolve(output, path)).exists())
					generatedArtifactCount += 1;
			}
			const agents = await Bun.file(resolve(output, "AGENTS.md")).text();
			fixtures.push({
				name: declared.name,
				capabilityEnabled: declared.capabilityEnabled,
				gatedPaths: gatedPaths.sort(),
				packageScripts: packageScripts.sort(),
				openspecStepPresent: workflow.includes(
					`bun run ${OPENSPEC_GUARD_SCRIPT}`,
				),
				rulesStepPresent: workflow.includes(`bun run ${RULES_GUARD_SCRIPT}`),
				generatedArtifactCount,
				lifecycleProsePresent: agents.includes("OpenSpec Lifecycle Ownership"),
				ruleSurfaces: AGENT_SURFACES.length,
				ruleErrors: await validateAgentRulesContract(output, { vendor: false }),
				residueFindings: rendered.residue.findings,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageNineRollback(options: {
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
	return { ...proof, addedPaths: [...ADDED_PATHS], addedPathsRemoved: true };
}

async function capture(options: {
	implementation: string;
	gateRun: number;
}): Promise<void> {
	assertToolingIsInsideTheContainer();
	const baseSha = gitSha(STAGE_EIGHT_B_MERGE_SHA);
	const implementationSha = gitSha(options.implementation);
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
			...LIFECYCLE_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The lifecycle surface changed after the implementation boundary; recapture at the new boundary",
		);

	const workflow = await Bun.file(resolve(ROOT, WORKFLOW_PATH)).text();
	const gateContext = aggregateGateContext(workflow);
	if (!gateContext)
		throw new Error("The committed workflow declares no aggregate gate name");
	const jobs = (Bun.YAML.parse(workflow) as Record<string, unknown>)[
		"jobs"
	] as Record<string, Record<string, unknown>>;
	const gateNeeds = (jobs["ci-gate"]?.["needs"] as string[]) ?? [];
	const nameWithOwner = checked([
		"gh",
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]).stdout.trim();

	const now = new Date();
	const runId = `stage9-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		repository: { nameWithOwner, gateContext },
		live: { "live-gate": { run: { runId: options.gateRun } } },
	};
	const expected = expectedStageNineCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageNineCommandId, Execution>();
	for (const id of STAGE_NINE_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageNineCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageNineCommandId) => executions.get(id)?.stderr ?? "";
	const lastLine = (text: string) =>
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? "";
	const counts = (text: string) => ({
		passCount: Number(/ (\d+) pass/.exec(text)?.[1] ?? -1),
		failCount: Number(/ (\d+) fail/.exec(text)?.[1] ?? -1),
	});

	const lifecycle = jsonObject(stdout("disposable-lifecycle"), "lifecycle");
	const renders = jsonObject(
		stdout("rendered-fixture-artifacts"),
		"rendered-fixture-artifacts",
	);
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const openspecVersion = checked([
		"./node_modules/.bin/openspec",
		"--version",
	]).stdout.trim();

	const evidence = {
		schemaVersion: 1,
		stage: "stage-9-openspec",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			openspecCatalogPin: (
				(await Bun.file(resolve(ROOT, "package.json")).json()) as {
					workspaces: { catalog: Record<string, string> };
				}
			).workspaces.catalog["@fission-ai/openspec"],
		},
		host: {
			os: uname("-s").toLowerCase(),
			architecture: uname("-m"),
			kernel: uname("-r"),
			insideDevcontainer: true,
			bunVersion: checked(["bun", "--version"]).stdout.trim(),
			openspecVersion,
			ghVersion: /\d+\.\d+\.\d+/.exec(
				checked(["gh", "--version"]).stdout,
			)?.[0] as string,
		},
		repository: {
			nameWithOwner,
			workflowFile: WORKFLOW_PATH,
			gateJobId: "ci-gate",
			gateContext,
			gateNeeds,
			openspecGuardScript: OPENSPEC_GUARD_SCRIPT,
			rulesGuardScript: RULES_GUARD_SCRIPT,
			archiveWrapper: "scripts/openspec/archive.sh",
			capability: "openspec",
		},
		commands: records,
		guards: {
			openspec: {
				commandId: "openspec-guard",
				command: `bun run ${OPENSPEC_GUARD_SCRIPT}`,
				summary: lastLine(stdout("openspec-guard")),
			},
			rules: {
				commandId: "rules-guard",
				command: `bun run ${RULES_GUARD_SCRIPT}`,
				summary: lastLine(stdout("rules-guard")),
			},
			archiveRefusals: {
				commandId: "archive-refusals",
				testFile: "scripts/template/__tests__/openspec.test.ts",
				...counts(stderr("archive-refusals")),
			},
			agentRules: {
				commandId: "vendor-artifact-regeneration",
				testFile: "scripts/template/__tests__/agent-rules.test.ts",
				...counts(stderr("vendor-artifact-regeneration")),
			},
		},
		lifecycle: {
			commandId: "disposable-lifecycle",
			result: lifecycle["result"],
		},
		vendorArtifacts: {
			commandId: "vendor-artifact-regeneration",
			artifacts: [...VENDOR_ARTIFACTS],
			replaced: [...REPLACED_ARTIFACTS],
			expectedCount: GENERATED_ARTIFACT_COUNT,
		},
		renderFixtures: {
			commandId: "rendered-fixture-artifacts",
			fixtures: renders["fixtures"],
		},
		live: {
			"live-gate": {
				commandId: "live-gate",
				heavyLaneRan: EXPECTED_OBSERVATIONS[0].heavyLaneRan,
				run: {
					runId: document["databaseId"],
					url: document["url"],
					event: document["event"],
					headBranch: document["headBranch"],
					headSha: document["headSha"],
					conclusion: document["conclusion"],
					gateJobId: Number(gateValues["gateJobId"]),
					gateConclusion: String(gateJob?.["conclusion"] ?? ""),
					gateLogSha256: gateValues["gateLogSha256"],
					upstreamResults: gateValues["upstreamResults"] ?? "",
					jobs: runJobs
						.filter((job) => job["name"] !== gateContext)
						.map((job) => ({
							name: String(job["name"]),
							conclusion: String(job["conclusion"]),
						})),
				},
			},
		},
		coverage: [
			{
				id: "multi-root-validation",
				task: "12.1 repository-local multi-root strict validation",
				reason:
					"The guard enumerates every openspec/config.yaml by walking the tree and cross-checking the git index, then drives the pinned repository-local CLI once per root with that root's own working directory and requires the two answers to agree exactly in both directions.",
				commandIds: ["openspec-guard", "archive-refusals"],
			},
			{
				id: "anti-vacuity",
				task: "12.1 anti-vacuity and active/archive hygiene",
				reason:
					"A root that declares nothing fails rather than passing, the reported item total is compared against this repository's own count rather than against the array the same command printed, and the archive rules the CLI never looks at are checked from the tree: prefix, calendar date, UTC future, active-and-archived, nested archive, empty entry and an orphaned delta requirement.",
				commandIds: ["openspec-guard", "archive-refusals"],
			},
			{
				id: "archive-refusals",
				task: "12.2 refuse unsafe archives before touching the tree",
				reason:
					"Every documented exit code of the wrapper is exercised against a synthetic clone with a real bare origin, each case asserting both the exact diagnostic and that the tree is byte-for-byte what it was, and the suite closes the matrix in both directions so a documented refusal cannot go unobserved.",
				commandIds: ["archive-refusals"],
			},
			{
				id: "archive-publication",
				task: "12.3 publish only after validation succeeds",
				reason:
					"One whole lifecycle runs against the real pinned CLI in a throwaway clone: the change is archived, its ADDED requirement reaches the main specs, the unfinished second change is untouched, only the OpenSpec root is staged, the commit subject is exact, the bare origin advances, and a second run refuses on the destination the first one occupied.",
				commandIds: ["disposable-lifecycle", "archive-refusals"],
			},
			{
				id: "canonical-rules",
				task: "12.4 consolidate canonical cross-agent rules",
				reason:
					"AGENTS.md is the only source of the mirrored blocks, the guard rejects drift, a region the canonical file does not declare, and canonical text restated outside a region, and the required-surface table records that Codex receives no OpenSpec artifacts as a scan that fails when one appears.",
				commandIds: ["rules-guard", "vendor-artifact-regeneration"],
			},
			{
				id: "generated-artifacts",
				task: "12.4 mechanically synchronized tool-specific commands and skills",
				reason:
					"All fourteen Claude artifacts are regenerated by spawning the pinned CLI into a scratch directory and compared byte for byte, regeneration is shown to be deterministic across two runs, both archive surfaces delegate to the wrapper, and the vendor directory-move procedure is absent from the whole tree.",
				commandIds: ["vendor-artifact-regeneration", "rules-guard"],
			},
			{
				id: "capability-isolation",
				task: "12.5 the lifecycle is present only where it is enabled",
				reason:
					"Each fixture is rendered and inspected for the gated paths, the package scripts, the fenced step and the fourteen artifacts, the cross-agent rule surface is checked to be core in every one of them, and each render is put through the anti-residue scan and the rules contract on its own terms.",
				commandIds: ["rendered-fixture-artifacts", "live-gate"],
			},
			{
				id: "rollback",
				task: "12.5 rollback",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 8B predecessor, and that tree is shown to carry none of the seven paths this stage adds while the implementation tree carries all of them; nothing about this stage lives outside the tree.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-9-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload. Stage 8B's entry existed because its switch lived
			// outside the tree; this stage has no such switch.
			outsideTheTree: [],
			containerRebuildRequired: false,
			scope:
				"Revert the OpenSpec lifecycle contract and its entrypoint, the host archive wrapper, the cross-agent rules contract, its guard and its generator, the committed delegation body, the three package scripts, the two steps in the required lane, the canonical blocks and every generated mirror region, the fourteen regenerated Claude artifacts, the ownership wiring, the documentation, and this record as one Stage 9 bundle. Nothing about this stage lives outside the tree: there is no repository variable, no branch-protection change and no operator step, and nothing under .devcontainer/** changed, so adopting or reverting it costs no container rebuild. The active change portable-devcontainer-upgrade stays ACTIVE through Stage 11 either way — no capture, proof or guard in this stage archives it, and a committed test asserts that.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageNineEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 9 evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 9 evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-lifecycle") {
		console.log(
			JSON.stringify(
				await probeLifecycle({ workspace: required(options, "--workspace") }),
			),
		);
	} else if (subcommand === "probe-render-openspec") {
		console.log(
			JSON.stringify(
				await probeRenderOpenspec({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageNineRollback({
					base: required(options, "--base"),
					implementation: required(options, "--implementation"),
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else {
		console.error(usage());
		process.exit(2);
	}
}

// Referenced so the sealed workspace-path helpers stay bound to the collector
// that uses them; the capture builds its commands from the same functions the
// validator derives them with.
void [lifecycleWorkspacePath, renderWorkspacePath, rollbackWorkspacePath];
