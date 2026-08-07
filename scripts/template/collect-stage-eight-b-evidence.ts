// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { selectAffected } from "./affected-contract";
import {
	aggregateGateContext,
	validateCiContract,
	validateWorkflowGraph,
} from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { MOON_AFFECTED_ARGV } from "./graph-contract";
import { loadTemplateParameters } from "./parameters";
import { renderFixture } from "./render-fixture";
import { reconcileWithMoon } from "./select-affected";
import {
	ADDED_PATHS,
	EXPECTED_OBSERVATIONS,
	expectedStageEightBCommands,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	moonWorkspacePath,
	renderWorkspacePath,
	rollbackWorkspacePath,
	STAGE_EIGHT_A_MERGE_SHA,
	STAGE_EIGHT_B_COMMAND_IDS,
	STAGE_EIGHT_B_FIXTURES,
	type StageEightBCommandId,
	selectorWorkspacePath,
	validateStageEightBEvidenceValue,
} from "./stage-eight-b-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(
	ROOT,
	"evidence/stage-8b-affected-selection.json",
);
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_DIRECTORY = ".github/workflows";
const SELECTOR_JOB_ID = "affected";
const PROJECT_JOB_ID = "project";
const MODE_VARIABLE = "MOON_AFFECTED_MODE";

// The selection surface. The capture is only meaningful when the tree it ran
// against is identical to the reviewed implementation boundary.
const SELECTION_INPUTS = [
	".github",
	"ci-matrix-universes.json",
	"package.json",
	"template-parameters.toml",
	"scripts/ci/affected-matrices.sh",
	"scripts/template/affected-contract.ts",
	"scripts/template/select-affected.ts",
	"scripts/template/validate-affected.ts",
	"scripts/template/graph-contract.ts",
	"scripts/template/ci-contract.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
];

// The Stage 8B evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-eight-b-evidence.ts",
	"scripts/template/collect-stage-eight-b-evidence.ts",
	"scripts/template/__tests__/stage-eight-b-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-8b-affected-selection.json",
	"evidence/stage-8b-affected-selection.schema.json",
	"evidence/stage-8b-affected-selection-run/",
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
	id: StageEightBCommandId;
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
		"  bun scripts/template/collect-stage-eight-b-evidence.ts capture \\",
		"    --implementation <sha> --full-run <id> --moon-run <id> --docs-run <id> \\",
		"    --docs-base <sha> --docs-head <sha>",
		"  bun scripts/template/collect-stage-eight-b-evidence.ts probe-moon-affected --argv '<argv>' --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-eight-b-evidence.ts probe-selector --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-eight-b-evidence.ts probe-render-affected --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-eight-b-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs INSIDE the devcontainer: moon is image-owned and the host has",
		"neither moon nor proto.",
		"  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-b-evidence.ts capture …",
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
	id: StageEightBCommandId,
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
			`Stage 8B command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 8B capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsInsideTheContainer(): void {
	// moon is image-owned. A capture attempted on the host would either fail on
	// the missing binary or, worse, find some other moon and seal a version this
	// repository never pins.
	if (process.env["DEVCONTAINER"] !== "true")
		throw new Error(
			"Stage 8B evidence must be captured inside the devcontainer:\n  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-b-evidence.ts capture …",
		);
	for (const [binary, hint] of [
		["moon", "rebuild the devcontainer image"],
		["jq", "rebuild the devcontainer image"],
		["gh", "gh auth login"],
		["python3", "rebuild the devcontainer image"],
		["shasum", "rebuild the devcontainer image"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 8B capture needs ${binary} on PATH (${hint})`);
}

function assertTemporary(workspace: string): string {
	const path = resolve(workspace);
	if (!path.startsWith("/tmp/") || path.length < 12)
		throw new Error(`Refusing to work outside /tmp: ${path}`);
	return path;
}

/**
 * Build a synthetic four-project workspace and commit it.
 *
 * This repository's own graph is the root project alone, so `--downstream deep`
 * is unobservable in it: every query would answer "everything" and a capture
 * over that would prove nothing about the flag it pins. The shape below is the
 * smallest one where a leaf, a fan-out and a transitive chain are three
 * different answers.
 */
async function syntheticWorkspace(workspace: string): Promise<string> {
	const path = assertTemporary(workspace);
	await rm(path, { recursive: true, force: true });
	const write = async (relative: string, contents: string): Promise<void> => {
		await mkdir(resolve(path, relative, ".."), { recursive: true });
		await Bun.write(resolve(path, relative), contents);
	};
	await write(
		".moon/workspace.yml",
		[
			"projects:",
			"  globs:",
			"    - 'apps/*'",
			"    - 'libs/*'",
			"  sources:",
			"    root: '.'",
			"vcs:",
			"  defaultBranch: 'main'",
			"",
		].join("\n"),
	);
	await write(".moon/toolchain.yml", "{}\n");
	// moon writes its cache under .moon/ the first time it is asked anything, and
	// `.moon/**` is a GLOBAL input to the classifier. Left untracked-and-added,
	// the second probe case would diff a cache file written by the first and
	// widen to FULL — a real answer to the wrong question.
	await write(".gitignore", ".moon/cache/\n");
	await write(
		"tsconfig.base.json",
		`${JSON.stringify(
			{
				compilerOptions: {
					paths: { "@synthetic/*": ["${configDir}/../../libs/*/src"] },
				},
			},
			null,
			"\t",
		)}\n`,
	);
	await write(
		"package.json",
		`${JSON.stringify({ name: "synthetic" }, null, "\t")}\n`,
	);
	await write("moon.yml", "# the repository as a project\n");
	const projects: Array<[string, string, string[], string]> = [
		["libs/base", "base", [], "export const base = 1;\n"],
		[
			"libs/ui",
			"ui",
			["base"],
			"import '@synthetic/base';\nexport const ui = 1;\n",
		],
		[
			"apps/web",
			"web",
			["ui"],
			"import '@synthetic/ui';\nexport const web = 1;\n",
		],
		["apps/admin", "admin", [], "export const admin = 1;\n"],
	];
	const packageOf = (id: string): string => `@synthetic/${id}`;
	for (const [source, id, dependsOn, body] of projects) {
		await write(
			`${source}/package.json`,
			`${JSON.stringify(
				{
					name: packageOf(id),
					...(dependsOn.length > 0
						? {
								dependencies: Object.fromEntries(
									dependsOn.map((entry) => [packageOf(entry), "workspace:*"]),
								),
							}
						: {}),
				},
				null,
				"\t",
			)}\n`,
		);
		await write(
			`${source}/moon.yml`,
			dependsOn.length > 0
				? `id: '${id}'\ndependsOn:\n${dependsOn.map((entry) => `  - '${entry}'\n`).join("")}`
				: `id: '${id}'\n`,
		);
		await write(`${source}/src/index.ts`, body);
	}
	await write(
		"ci-matrix-universes.json",
		`${JSON.stringify(
			{
				schemaVersion: 1,
				universes: [
					{ id: "ci", projects: ["admin", "base", "root", "ui", "web"] },
				],
			},
			null,
			"\t",
		)}\n`,
	);
	checked(["git", "init", "-q", "-b", "main"], path);
	checked(["git", "config", "user.email", "evidence@example.test"], path);
	checked(["git", "config", "user.name", "evidence"], path);
	checked(["git", "add", "-A"], path);
	checked(["git", "commit", "-qm", "synthetic workspace"], path);
	return path;
}

function moon(
	path: string,
	argv: readonly string[],
	stdin: string,
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["moon", ...argv],
		cwd: path,
		stdin: Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function affectedIds(stdout: string): string {
	try {
		const value = JSON.parse(stdout) as { projects?: Array<{ id?: unknown }> };
		return (value.projects ?? [])
			.map((project) => String(project.id ?? ""))
			.filter(Boolean)
			.sort()
			.join(",");
	} catch {
		return "";
	}
}

/**
 * The pinned affected query, issued against the REAL moon.
 *
 * Four facts are recorded and every one of them is load-bearing: a leaf reaches
 * itself, the deepest library reaches its dependents, empty stdin over a clean
 * tree answers nothing, and empty stdin over a DIRTY tree answers about the
 * working tree instead — which is the hazard the selector guards on the file
 * count for, and it can only be shown by producing it.
 */
export async function probeMoonAffected(options: {
	argv: string;
	workspace: string;
}): Promise<string> {
	const argv = options.argv.split(" ").filter(Boolean);
	const path = await syntheticWorkspace(options.workspace);
	try {
		const all = moon(path, ["query", "projects", "--quiet"], "");
		const leaf = moon(path, argv, "apps/web/src/index.ts\n");
		const deep = moon(path, argv, "libs/base/src/index.ts\n");
		const emptyClean = moon(path, argv, "");
		await Bun.write(
			resolve(path, "apps/admin/src/index.ts"),
			"export const admin = 2;\n",
		);
		const emptyDirty = moon(path, argv, "");
		checked(["git", "checkout", "--", "apps/admin/src/index.ts"], path);
		const jsonFlag = moon(path, [...argv, "--json"], "apps/web/src/index.ts\n");
		for (const [label, result] of [
			["workspace", all],
			["leaf", leaf],
			["deep", deep],
			["empty-clean", emptyClean],
			["empty-dirty", emptyDirty],
		] as const)
			if (result.exitCode !== 0)
				throw new Error(`moon ${label} query exited ${result.exitCode}`);
		return [
			`workspaceProjects=${affectedIds(all.stdout)}`,
			`leafProjects=${affectedIds(leaf.stdout)}`,
			`deepProjects=${affectedIds(deep.stdout)}`,
			`emptyStdinProjects=${affectedIds(emptyClean.stdout)}`,
			`emptyStdinDirtyProjects=${affectedIds(emptyDirty.stdout)}`,
			`jsonFlagExitCode=${jsonFlag.exitCode}`,
			"",
		].join("\n");
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}

/**
 * The committed selector, end to end, against that same real moon.
 *
 * Not a paraphrase of it: `selectAffected` and `reconcileWithMoon` are imported
 * and called, so the sealed answers are the ones the CI entrypoint produces.
 */
export async function probeSelector(options: {
	workspace: string;
}): Promise<Record<string, unknown>> {
	const path = await syntheticWorkspace(options.workspace);
	const cases: Array<Record<string, unknown>> = [];
	try {
		const commit = async (
			files: Record<string, string>,
			message: string,
		): Promise<{ base: string; head: string }> => {
			const base = gitSha("HEAD", path);
			for (const [relative, contents] of Object.entries(files)) {
				await mkdir(resolve(path, relative, ".."), { recursive: true });
				await Bun.write(resolve(path, relative), contents);
			}
			checked(["git", "add", "-A"], path);
			checked(["git", "commit", "-qm", message], path);
			return { base, head: gitSha("HEAD", path) };
		};
		const record = async (
			name: string,
			files: Record<string, string>,
			mode: string,
		): Promise<void> => {
			const { base, head } = await commit(files, name);
			const derived = await selectAffected({
				root: path,
				mode,
				eventName: "pull_request",
				baseSha: base,
				headSha: head,
			});
			const result = await reconcileWithMoon(path, derived, head);
			const consulted = result.annotations.some((annotation) =>
				annotation.includes("agrees:"),
			);
			cases.push({
				name,
				mode: result.mode,
				reason: result.reason,
				selected: result.selected,
				universe: result.universes["ci"] ?? [],
				moonConsulted: consulted,
			});
		};
		await record(
			"leaf",
			{
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 2;\n",
			},
			"moon",
		);
		await record(
			"deep",
			{ "libs/base/src/index.ts": "export const base = 2;\n" },
			"moon",
		);
		await record("docs", { "docs/guide.md": "# guide\n" }, "moon");
		await record("global", { "AGENTS.md": "# agents\n" }, "moon");
		await record(
			"mode-off",
			{ "apps/admin/src/index.ts": "export const admin = 3;\n" },
			"full",
		);
		return { schemaVersion: 1, cases };
	} finally {
		await rm(path, { recursive: true, force: true });
	}
}

/**
 * Render every fixture and report what each one received.
 *
 * The claim is about files a renderer produced, not about the template's own
 * fenced source: a capability whose fence is wrong looks perfectly correct in
 * the template and only becomes visible after rendering. The two JOBS are the
 * assertion that runs in the opposite direction — they must be present in every
 * render, because fencing them would leave a project with no heavy lane at all.
 */
export async function probeRenderAffected(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	const parameters = await loadTemplateParameters(root);
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_EIGHT_B_FIXTURES) {
			const name = declared.name;
			if (!parameters.generation.fixture_names.includes(name))
				throw new Error(`Fixture ${name} is not declared`);
			const output = resolve(workspace, name);
			await renderFixture({ root, fixtureName: name, output, force: true });
			const workflowErrors: string[] = [];
			for (const entry of (
				await readdir(resolve(output, WORKFLOW_DIRECTORY))
			).sort()) {
				if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
				const path = `${WORKFLOW_DIRECTORY}/${entry}`;
				workflowErrors.push(
					...validateWorkflowGraph(
						await Bun.file(resolve(output, path)).text(),
						path,
					),
				);
			}
			const source = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			const value = Bun.YAML.parse(source) as Record<string, unknown>;
			const jobs = (value["jobs"] ?? {}) as Record<
				string,
				Record<string, unknown>
			>;
			const needs = jobs["ci-gate"]?.["needs"];
			const packageJson = (await Bun.file(
				resolve(output, "package.json"),
			).json()) as { scripts?: Record<string, string> };
			const gatedPaths: string[] = [];
			for (const path of ADDED_PATHS)
				if (await Bun.file(resolve(output, path)).exists())
					gatedPaths.push(path);
			// The heavy lane, identified by what it RUNS rather than by its id: a
			// job named `project` that stopped running the suite would satisfy a
			// name check and gate nothing.
			const project = jobs[PROJECT_JOB_ID] ?? {};
			const projectSteps = (
				Array.isArray(project["steps"]) ? project["steps"] : []
			) as Array<Record<string, unknown>>;
			const bodies = projectSteps.map((step) => String(step["run"] ?? ""));
			fixtures.push({
				name,
				capabilityEnabled: declared.capabilityEnabled,
				gatedPaths,
				packageScripts: Object.keys(packageJson.scripts ?? {})
					.filter((script) => script.startsWith("affected:"))
					.sort(),
				jobs: Object.keys(jobs).sort(),
				gateNeeds: Array.isArray(needs) ? needs.map(String) : [],
				gateContext: aggregateGateContext(source) ?? "",
				modeTokenPresent: source.includes(MODE_VARIABLE),
				selectorStepPresent: source.includes(
					"bash scripts/ci/affected-matrices.sh",
				),
				heavyLanePresent:
					bodies.includes("bash scripts/ci/run-tests.sh") &&
					bodies.includes("bun run typecheck") &&
					bodies.some((body) => body.startsWith("bunx biome check")),
				workflowErrors,
				// A rendered project has to pass the workflow contract on its own
				// terms, fences resolved — which is where a rendered-only defect in
				// the two core jobs would surface.
				contractErrors: await validateCiContract(output),
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { schemaVersion: 1, fixtures };
}

// This stage adds one shell entrypoint and three guard modules. The rollback
// proof is the shared tree-identity probe plus the claim that matters for the
// additions — the reverted tree carries none of them and the implementation
// tree carries all of them.
export async function probeAffectedRollback(options: {
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
	runs: Record<string, number>;
	docsBase: string;
	docsHead: string;
}): Promise<void> {
	assertToolingIsInsideTheContainer();
	const baseSha = gitSha(STAGE_EIGHT_A_MERGE_SHA);
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
			...SELECTION_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The selection surface changed after the Stage 8B implementation boundary",
		);
	if (
		execute(["git", "diff", "--quiet", "--", ...SELECTION_INPUTS]).exitCode !==
		0
	)
		throw new Error("The selection surface has uncommitted changes");

	const workflow = await Bun.file(resolve(ROOT, WORKFLOW_PATH)).text();
	const gateContext = aggregateGateContext(workflow);
	if (!gateContext)
		throw new Error("The committed workflow declares no aggregate gate name");
	const jobs = (Bun.YAML.parse(workflow) as Record<string, unknown>)[
		"jobs"
	] as Record<string, Record<string, unknown>>;
	const gateNeeds = (jobs["ci-gate"]?.["needs"] as string[]) ?? [];
	const selectorJobName = String(jobs[SELECTOR_JOB_ID]?.["name"] ?? "");
	const projectJobName = String(jobs[PROJECT_JOB_ID]?.["name"] ?? "");
	if (!selectorJobName || !projectJobName)
		throw new Error("The committed workflow declares no selection lane");
	const parameters = await loadTemplateParameters(ROOT);
	const initialMode = parameters.ci.affected_mode_initial;
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
	const runId = `stage8b-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		repository: { nameWithOwner, gateContext, selectorJobName },
		selection: { queryArgv: [...MOON_AFFECTED_ARGV] },
		live: Object.fromEntries(
			EXPECTED_OBSERVATIONS.map((observation) => [
				observation.id,
				{ run: { runId: options.runs[observation.id] } },
			]),
		),
	};
	const expected = expectedStageEightBCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageEightBCommandId, Execution>();
	for (const id of STAGE_EIGHT_B_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageEightBCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageEightBCommandId) => executions.get(id)?.stderr ?? "";
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

	const toolchain = keyValues(stdout("moon-toolchain"));
	const query = keyValues(stdout("moon-affected-query"));
	const selector = jsonObject(stdout("selector-live"), "selector-live");
	const renders = jsonObject(stdout("rendered-affected"), "rendered-affected");
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const live: Record<string, unknown> = {};
	for (const observation of EXPECTED_OBSERVATIONS) {
		const values = keyValues(stdout(observation.id));
		const document = jsonObject(values["runJson"] ?? "", observation.id);
		const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
		const gateJob = runJobs.find((job) => job["name"] === gateContext);
		live[observation.id] = {
			commandId: observation.id,
			mode: observation.mode,
			reason: observation.reason,
			selectionLine: values["selectionLine"] ?? "",
			universeLine: values["universeLine"] ?? "",
			shadowNarration: Number(values["shadowLines"] ?? 0) > 0,
			heavyLaneRan: observation.heavyLaneRan,
			run: {
				runId: document["databaseId"],
				url: document["url"],
				event: document["event"],
				headBranch: document["headBranch"],
				headSha: document["headSha"],
				baseSha:
					observation.id === "live-gate-docs" ? options.docsBase : baseSha,
				conclusion: document["conclusion"],
				gateJobId: Number(values["gateJobId"]),
				gateConclusion: String(gateJob?.["conclusion"] ?? ""),
				gateLogSha256: values["gateLogSha256"],
				selectorJobId: Number(values["selectorJobId"]),
				selectorLogSha256: values["selectorLogSha256"],
				upstreamResults: values["upstreamResults"] ?? "",
				jobs: runJobs
					.filter((job) => job["name"] !== gateContext)
					.map((job) => ({
						name: String(job["name"]),
						conclusion: String(job["conclusion"]),
					})),
			},
		};
	}
	// The documentation-only cycle is a STACKED pull request whose base is the
	// reviewed boundary: a docs-only diff needs a commit the boundary does not
	// contain, so it cannot sit at the boundary itself.
	const docsRun = live["live-gate-docs"] as { run: Record<string, unknown> };
	docsRun.run["baseSha"] = gitSha(options.docsBase);
	if (docsRun.run["headSha"] !== gitSha(options.docsHead))
		throw new Error("The documentation cycle did not run at the recorded head");

	const evidence = {
		schemaVersion: 1,
		stage: "stage-8b-affected-selection",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			prototoolsMoon: toolchain["prototoolsMoon"],
		},
		host: {
			os: uname("-s").toLowerCase(),
			architecture: uname("-m"),
			kernel: uname("-r"),
			insideDevcontainer: true,
			moonVersion: toolchain["moonVersion"],
			bunVersion: toolchain["bunVersion"],
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
			selectorJobId: SELECTOR_JOB_ID,
			selectorJobName,
			projectJobId: PROJECT_JOB_ID,
			projectJobName,
			modeVariable: MODE_VARIABLE,
			initialMode,
			capability: "moon_affected_selection",
		},
		commands: records,
		guards: {
			affected: {
				commandId: "affected-guard",
				command: "bun run affected:check",
				summary: lastLine(stdout("affected-guard")),
			},
			affectedMutations: {
				commandId: "affected-mutations",
				testFile: "scripts/template/__tests__/affected.test.ts",
				...counts(stderr("affected-mutations")),
			},
			ci: {
				commandId: "ci-guard",
				command: "bun run ci:check",
				summary: lastLine(stdout("ci-guard")),
			},
			ciMutations: {
				commandId: "workflow-policy-mutations",
				testFile: "scripts/template/__tests__/ci.test.ts",
				...counts(stderr("workflow-policy-mutations")),
			},
		},
		selection: {
			commandId: "moon-affected-query",
			queryArgv: [...MOON_AFFECTED_ARGV],
			workspaceProjects: query["workspaceProjects"],
			leafProjects: query["leafProjects"],
			deepProjects: query["deepProjects"],
			emptyStdinProjects: query["emptyStdinProjects"],
			emptyStdinDirtyProjects: query["emptyStdinDirtyProjects"],
			jsonFlagExitCode: Number(query["jsonFlagExitCode"]),
		},
		selector: { commandId: "selector-live", cases: selector["cases"] },
		renderFixtures: {
			commandId: "rendered-affected",
			fixtures: renders["fixtures"],
		},
		live,
		coverage: [
			{
				id: "derived-selection",
				task: "11.1 affected set derived from the committed graph",
				reason:
					"The selector classifies every changed path with the graph oracle's own classifier and closes over reverse reachability, and the live probe shows a leaf reaching only itself while the deepest library reaches both of its transitive dependents in the same synthetic workspace.",
				commandIds: ["affected-guard", "affected-mutations", "selector-live"],
			},
			{
				id: "fail-open",
				task: "11.1 every ambiguity resolves to the full matrix",
				reason:
					"Mode, event, a malformed or unknown base or head, a failed merge-base, a failed diff, a global input and an empty diff each widen to the full universe set, and the entrypoint additionally fails open on a selector crash, a syntax error, unreadable output and a selection missing its universes.",
				commandIds: ["affected-guard", "affected-mutations"],
			},
			{
				id: "fail-closed",
				task: "11.2 the one deliberate hard failure",
				reason:
					"An unusable universe registry exits non-zero with a byte-empty output file rather than emitting an empty matrix, proved for a missing file, a parse failure, an absent universes key, an empty list, a universe with no projects, and a semantically invalid registry the shell preflight cannot see.",
				commandIds: ["affected-guard", "affected-mutations"],
			},
			{
				id: "moon-reconciliation",
				task: "11.1 moon may only widen the selection",
				reason:
					"The pinned argv is issued against the real moon inside the devcontainer and reconciled with the derived answer, the empty-stdin hazard is produced in both directions to show why the file count is guarded, and every abnormal answer including a narrower one is driven to the full matrix through a committed stand-in binary.",
				commandIds: ["moon-toolchain", "moon-affected-query", "selector-live"],
			},
			{
				id: "capability-isolation",
				task: "11.2 capability fencing of the selection surface",
				reason:
					"Each fixture is rendered and inspected for the four gated paths, both package scripts, the mode variable and the selector step, and each render is put through the workflow contract on its own terms so a rendered-only defect in the two core jobs would surface here.",
				commandIds: ["rendered-affected"],
			},
			{
				id: "heavy-lane-gating",
				task: "11.3 the heavy lane runs from the matrix",
				reason:
					"The workflow contract rejects a gate that does not depend on the selector, a matrix job that does not declare its producer, a fromJSON outside a matrix value and a delivery job wired to the selection, and three real runs show the lane running from the emitted matrix and skipping on an empty one.",
				commandIds: [
					"ci-guard",
					"workflow-policy-mutations",
					"live-gate-full",
					"live-gate-moon",
					"live-gate-docs",
				],
			},
			{
				id: "mode-switch",
				task: "11.4 flip the documented single rollback switch",
				reason:
					"The in-tree default is asserted against the recorded parameter, and the three live cycles bracket the flip: the same tree runs full with the shadow narration printed, then runs again with the variable set, and a documentation-only stacked pull request then selects an empty matrix.",
				commandIds: ["live-gate-full", "live-gate-moon", "live-gate-docs"],
			},
			{
				id: "rollback",
				task: "11.5 rollback",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the predecessor, and that tree is shown to carry none of the four paths this stage adds while the implementation tree carries all of them; the repository variable is recorded as the one thing outside the tree.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-8b-pr-merge-commit>"],
			// Unlike every stage before it, this one has something outside the tree.
			outsideTheTree: [
				`repository variable ${MODE_VARIABLE} (set to moon by this stage; flip or delete it BEFORE reverting)`,
			],
			containerRebuildRequired: false,
			scope: `Revert the affected-selection contract, its entrypoint and selector, the committed matrix script, the two package scripts, the fenced mode variable, the affected and project jobs and their gate dependencies, the workflow contract rules, the setup-moon base-ref step, the ownership wiring, the documentation, and this record as one Stage 8B bundle. ORDER MATTERS: flip or delete the repository variable ${MODE_VARIABLE} first, then revert. A revert that leaves it set is harmless while the surface is gone — nothing reads it — but it becomes live again the moment the stage is re-applied, which is a selection nobody decided to turn on. Nothing under .devcontainer/** changed, so adopting or reverting this stage costs no container rebuild. Branch protection needs no operator step: the required context is unchanged, because both new jobs reach the gate through needs instead of becoming second required checks.`,
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(
		resolve(ROOT, "evidence/stage-8b-affected-selection.schema.json"),
	).json()) as Record<string, unknown>;
	const errors = await validateStageEightBEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 8B evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 8B evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			runs: {
				"live-gate-full": Number(required(options, "--full-run")),
				"live-gate-moon": Number(required(options, "--moon-run")),
				"live-gate-docs": Number(required(options, "--docs-run")),
			},
			docsBase: required(options, "--docs-base"),
			docsHead: required(options, "--docs-head"),
		});
	} else if (subcommand === "probe-moon-affected") {
		process.stdout.write(
			await probeMoonAffected({
				argv: required(options, "--argv"),
				workspace: required(options, "--workspace"),
			}),
		);
	} else if (subcommand === "probe-selector") {
		console.log(
			JSON.stringify(
				await probeSelector({ workspace: required(options, "--workspace") }),
			),
		);
	} else if (subcommand === "probe-render-affected") {
		console.log(
			JSON.stringify(
				await probeRenderAffected({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeAffectedRollback({
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
void [
	moonWorkspacePath,
	selectorWorkspacePath,
	renderWorkspacePath,
	rollbackWorkspacePath,
];
