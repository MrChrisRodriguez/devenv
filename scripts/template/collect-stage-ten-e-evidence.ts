// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import {
	CORE_PATHS,
	GUARD_SCRIPT,
	inspectSurfaces,
	readExperimentRegistry,
	validateExperimentContract,
} from "./experiment-contract";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	DECLARED_MODE,
	EXPECTED_OBSERVATIONS,
	expectedStageTenECommands,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	MUTATION_LEGS,
	RESERVED_DIRECTORIES,
	renderWorkspacePath,
	rollbackWorkspacePath,
	SEALED_POLICY,
	SEALED_SURFACE_COUNT,
	STAGE_TEN_D_MERGE_SHA,
	STAGE_TEN_E_COMMAND_IDS,
	STAGE_TEN_E_FIXTURES,
	type StageTenECommandId,
	validateStageTenEEvidenceValue,
} from "./stage-ten-e-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-10e-experiments.json");
const SCHEMA_PATH = resolve(ROOT, "evidence/stage-10e-experiments.schema.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const EXPERIMENT_GUARD_SCRIPT = GUARD_SCRIPT;
const CI_GUARD_SCRIPT = "ci:check";
const REGISTRY_PATH = "experiments.json";
const EXPERIMENT_MUTATION_TEST =
	"scripts/template/__tests__/experiment.test.ts";

// The experiment lifecycle surface at the implementation boundary. The capture
// is only meaningful when the tree it ran against is identical to the reviewed
// boundary, so every input the record describes is compared.
//
// The seven exception surfaces are in this list for a second reason on top of
// the usual one: the whole claim of the stage is that they are at their
// declared values, so a change to any of them after the boundary would make the
// sealed policy describe a tree that no longer exists.
const CONTRACT_INPUTS = [
	".github/workflows/ci.yml",
	".gitignore",
	".moon/workspace.yml",
	"biome.jsonc",
	"bun.lock",
	"ci-matrix-universes.json",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"experiments.json",
	"experiments.schema.json",
	"moon.yml",
	"package.json",
	"scripts/template/experiment-contract.ts",
	"scripts/template/validate-experiment.ts",
	"scripts/template/__tests__/experiment.test.ts",
	"scripts/template/__tests__/fixtures/experiment-workspaces.ts",
	"tsconfig.json",
];

// The Stage 10E evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-ten-e-evidence.ts",
	"scripts/template/collect-stage-ten-e-evidence.ts",
	"scripts/template/__tests__/stage-ten-e-evidence.test.ts",
	"scripts/template/__tests__/experiment.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-10e-experiments.json",
	"evidence/stage-10e-experiments.schema.json",
	"evidence/stage-10e-experiments-run/",
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
	id: StageTenECommandId;
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
		"  bun scripts/template/collect-stage-ten-e-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-ten-e-evidence.ts probe-render-experiments --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-ten-e-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs on the HOST. Like the four contract stages before it this one",
		"owns no container-only binary: the guard is a standalone script over node:,",
		"Bun and git, and the only external tools are git, gh, python3 and shasum.",
		"",
		"No credential is needed, wanted or accepted, and nothing here opens a socket",
		"to anything but loopback.",
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
	id: StageTenECommandId,
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
			`Stage 10E command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 10E capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsPresent(): void {
	// The host, deliberately. Every other stage that captured inside the
	// container did so because it owned a binary the host does not have. This
	// stage owns none: the guard reads JSON, YAML and the Git index, so a
	// container hop would add a moving part and prove nothing.
	for (const [binary, hint] of [
		["git", "install git"],
		["gh", "gh auth login"],
		["python3", "install python3"],
		["shasum", "install perl"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 10E capture needs ${binary} on PATH (${hint})`);
}

function assertTemporary(workspace: string): string {
	const path = resolve(workspace);
	if (!path.startsWith("/tmp/") || path.length < 12)
		throw new Error(`Refusing to work outside /tmp: ${path}`);
	return path;
}

/** The capability fence a line of a rendered workflow sits inside, if any. */
function fenceAround(source: string, needle: string): string | undefined {
	let current: string | undefined;
	for (const line of source.split("\n")) {
		const start = /^\s*#\s*capability:start\s+([a-z0-9_]+)\s*$/.exec(line);
		if (start?.[1]) {
			current = start[1];
			continue;
		}
		if (/^\s*#\s*capability:end\s+[a-z0-9_]+\s*$/.test(line)) {
			current = undefined;
			continue;
		}
		if (line.includes(needle)) return current;
	}
	return undefined;
}

/**
 * What each fixture actually received — and this probe asks the INVERSE of
 * every one before it.
 *
 * Since Stage 10A each render probe has measured that a project WITHOUT a
 * capability carries no trace of it. This surface has no capability: `apps/**`
 * and `libs/**` ship in every render of every profile, so the rule that governs
 * what may appear in them ships in every render too. The four things measured
 * here are therefore all positive — the four files, the package script, the
 * unfenced step, and a guard that returns a real verdict over the rendered tree
 * with all seven surfaces inspected — plus one negative that must stay empty:
 * the anti-residue scan reports nothing about any of it, which is automatic
 * because there is no signature to match. That last assertion exists so a
 * future stage which DOES gate this surface has a failing probe to notice.
 */
export async function probeRenderExperiments(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const name of STAGE_TEN_E_FIXTURES) {
			const output = resolve(workspace, name);
			const rendered = await renderFixture({ root, fixtureName: name, output });
			const corePaths: string[] = [];
			for (const path of CORE_PATHS) {
				if (await Bun.file(resolve(output, path)).exists())
					corePaths.push(path);
			}
			const manifest = (await Bun.file(
				resolve(output, "package.json"),
			).json()) as { scripts: Record<string, string> };
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			const invocation = `bun run ${EXPERIMENT_GUARD_SCRIPT}`;
			const { registry } = await readExperimentRegistry(output);
			const surfaces = registry
				? await inspectSurfaces(output, registry)
				: undefined;
			fixtures.push({
				name,
				corePaths: [...corePaths],
				guardScriptPresent:
					manifest.scripts[EXPERIMENT_GUARD_SCRIPT] ===
					"bun scripts/template/validate-experiment.ts",
				guardStepPresent: workflow.includes(invocation),
				// The renderer strips fence markers along with the blocks it keeps, so
				// a rendered step is unfenced whatever the source said. What this
				// measures is that the step SURVIVED into a render that disables most
				// capabilities, which a fenced step would not have.
				guardStepFenced: fenceAround(workflow, invocation) !== undefined,
				experimentErrors: await validateExperimentContract(output),
				surfacesScanned: surfaces?.scanned ?? 0,
				residueFindings: rendered.residue.findings,
				coreResidueFindings: rendered.residue.findings.filter(
					(finding) =>
						(CORE_PATHS as readonly string[]).includes(finding.path) ||
						finding.signature === EXPERIMENT_GUARD_SCRIPT,
				),
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageTenERollback(options: {
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

async function capture(options: {
	implementation: string;
	gateRun: number;
}): Promise<void> {
	assertToolingIsPresent();
	const baseSha = gitSha(STAGE_TEN_D_MERGE_SHA);
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
			...CONTRACT_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The experiment lifecycle surface changed after the implementation boundary; recapture at the new boundary",
		);
	// The two things that would have cost a container rebuild, measured rather
	// than promised. `.husky/` is counted beside `.devcontainer/` because it is
	// the surface this stage was most tempted to edit — the graphify staging
	// guard makes `pre-commit` look like the natural home for a hygiene rule —
	// and the decision not to is worth a number rather than a sentence.
	const devcontainerFilesChanged = checked([
		"git",
		"diff",
		"--name-only",
		baseSha,
		implementationSha,
		"--",
		".devcontainer",
	])
		.stdout.split("\n")
		.filter(Boolean).length;
	const huskyFilesChanged = checked([
		"git",
		"diff",
		"--name-only",
		baseSha,
		implementationSha,
		"--",
		".husky",
	])
		.stdout.split("\n")
		.filter(Boolean).length;
	if (devcontainerFilesChanged !== 0)
		throw new Error(
			"Stage 10E must not touch .devcontainer; the definition fingerprint would change",
		);
	if (huskyFilesChanged !== 0)
		throw new Error(
			"Stage 10E must not touch .husky; both hooks belong to the worktree contract",
		);
	// The lockfile did not move — the fifth consecutive stage — and neither did
	// the directories this guard governs.
	const lockfileNumstat = checked([
		"git",
		"diff",
		"--numstat",
		baseSha,
		implementationSha,
		"--",
		"bun.lock",
	]).stdout.trim();
	if (lockfileNumstat !== "")
		throw new Error(
			"Stage 10E must not change bun.lock; the guard is node:, ./json-schema and git",
		);
	const workspaceDirectoriesAdded = checked([
		"git",
		"diff",
		"--name-only",
		baseSha,
		implementationSha,
		"--",
		"apps",
		"libs",
	])
		.stdout.split("\n")
		.filter(Boolean).length;
	if (workspaceDirectoriesAdded !== 0)
		throw new Error(
			"Stage 10E must not create an experiment; a template that ships one ships a directory every project has to delete",
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
	const runId = `stage10e-${now
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
	const expected = expectedStageTenECommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageTenECommandId, Execution>();
	for (const id of STAGE_TEN_E_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageTenECommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageTenECommandId) => executions.get(id)?.stderr ?? "";
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

	const renders = jsonObject(
		stdout("rendered-experiments"),
		"rendered-experiments",
	);
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const { registry } = await readExperimentRegistry(ROOT);
	if (!registry)
		throw new Error("The committed experiment registry is unreadable");
	const surfaces = await inspectSurfaces(ROOT, registry);
	if (surfaces.scanned !== SEALED_SURFACE_COUNT || surfaces.errors.length > 0)
		throw new Error(
			`The seven exception surfaces did not inspect clean (${surfaces.scanned} scanned, ${surfaces.errors.length} errors)`,
		);

	const evidence = {
		schemaVersion: 1,
		stage: "stage-10e-experiments",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			declaredMode: DECLARED_MODE,
			// The deliverable of the stage. `experiments: []` is what this template
			// ships, so the record seals the seven exception surfaces rather than a
			// list of experiments — a sealed zero would prove nothing at all.
			policy: JSON.parse(JSON.stringify(SEALED_POLICY)),
			reservedDirectories: JSON.parse(JSON.stringify(RESERVED_DIRECTORIES)),
			surfaceCount: SEALED_SURFACE_COUNT,
			// Sealed as BYTES rather than as a boolean: "changed" hides the size of
			// what changed, and zero is the only number this stage may report.
			lockfileBytesChanged: 0,
			workspaceDirectoriesAdded,
		},
		host: {
			os: uname("-s").toLowerCase(),
			architecture: uname("-m"),
			kernel: uname("-r"),
			// The host, on purpose. This stage owns no container-only binary, so a
			// container hop would add a moving part and prove nothing.
			insideDevcontainer: process.env["DEVCONTAINER"] === "true",
			bunVersion: checked(["bun", "--version"]).stdout.trim(),
			gitVersion: /\d+\.\d+\.\d+/.exec(
				checked(["git", "--version"]).stdout,
			)?.[0] as string,
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
			experimentGuardScript: EXPERIMENT_GUARD_SCRIPT,
			ciGuardScript: CI_GUARD_SCRIPT,
			registryFile: REGISTRY_PATH,
			// Null, and this is the decision the whole stage turns on. Every record
			// since 10A named a capability here. This surface has none: there is no
			// fence, no signature, no residue token and no package rule, because
			// `apps/**` and `libs/**` ship in every render of every profile and a
			// hygiene rule over them that a project could switch off would be absent
			// from exactly the trees that have the directories it governs.
			capability: null,
			// The number that keeps every other sealed record intact. Stage 8A added
			// a job and turned a green historical capture into a reported
			// fabrication; this stage adds one UNFENCED step and nothing else.
			addedJobs: 0,
			// The two things that would have cost every downstream developer a
			// container rebuild, counted rather than promised.
			devcontainerFilesChanged,
			huskyFilesChanged,
		},
		commands: records,
		guards: {
			experiment: {
				commandId: "experiment-guard",
				command: `bun run ${EXPERIMENT_GUARD_SCRIPT}`,
				summary: lastLine(stdout("experiment-guard")),
			},
			ci: {
				commandId: "ci-guard",
				command: `bun run ${CI_GUARD_SCRIPT}`,
				summary: lastLine(stdout("ci-guard")),
			},
		},
		surfaces: {
			commandId: "surface-lock",
			scanned: surfaces.scanned,
			inspected: surfaces.inspections.map((entry) => entry.surface),
			paths: surfaces.inspections.map((entry) => entry.path),
		},
		suites: [
			{
				commandId: "experiment-mutations",
				testFile: EXPERIMENT_MUTATION_TEST,
				...counts(stderr("experiment-mutations")),
			},
			...Object.entries(MUTATION_LEGS).map(([commandId, leg]) => ({
				commandId,
				testFile: leg.testFile,
				...counts(stderr(commandId as StageTenECommandId)),
			})),
		],
		renderFixtures: {
			commandId: "rendered-experiments",
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
				id: "declared-registry",
				task: "17.1 add disposable/promoted experiment metadata",
				reason:
					"The input is a committed declaration validated against its own schema by the same json-schema module the other four registries use, it is the only one in the tree, and every declared thing is declared once: an id twice, a directory claimed twice, or an id that is live and retired at the same time all leave the lifecycle with two states at once.",
				commandIds: ["experiment-guard", "experiment-mutations"],
			},
			{
				id: "exception-surface-lock",
				task: "17.1 preserve Moon, dead-code, manifest, typecheck, universe and CI strictness",
				reason:
					"An experiment cannot weaken a guard by existing; it weakens one by adding an exception, and all seven exception surfaces in this repository are short committed lists. They are declared at their measured values and asserted rather than edited, the include half is locked beside the exclude half, and a disabling override counts as a negation because it is one with better manners.",
				commandIds: ["surface-lock", "experiment-guard"],
			},
			{
				id: "derived-scope-floor",
				task: "17.1 keep the guard non-vacuous over an empty workspace",
				reason:
					"The anchor is the count of exception surfaces INSPECTED rather than experiments found, because apps/ and libs/ hold a .gitkeep here and in every rendered project; the registry and the tree must also agree in both directions, so a directory nobody declared and a declaration whose directory is gone are two different refusals and a deletion cannot shrink the sweep quietly.",
				commandIds: ["mode-reconciliation", "surface-lock"],
			},
			{
				id: "containment",
				task: "17.1 keep experiments inside the workspace globs",
				reason:
					"A quarantine directory is refused precisely because it works: outside the globs the code is invisible to moon, to the workspace manifest and to the typechecker at once, which is dead code by construction. Inside them a directory inherits four tasks automatically, and the three capability-reserved names are refused by the ownership pattern that reserves them.",
				commandIds: ["containment", "manifest-registration"],
			},
			{
				id: "graph-and-universe",
				task: "17.1 preserve Moon graph and universe strictness",
				reason:
					"Every declared experiment carries a package manifest and a generated moon dependency block, and the universe registry is read as DATA with a named absence notice because it is gated on a capability that defaults to false and the module that owns it is gated on the same one; a declared universe id nobody declares is this guard's refusal while belonging to no universe stays a notice.",
				commandIds: ["moon-registration", "universe-reconciliation"],
			},
			{
				id: "promotion-artifacts",
				task: "17.2 prove promotion adds ownership, graph, universe, tests and documentation",
				reason:
					"Promotion is a checklist of registrations rather than a ceremony, so all five are declared and each is refused by name when it is missing; the test requirement is not redundant with the CI wrapper because that wrapper absorbs an empty match by design, which makes a promoted experiment with no tests green forever in a project that has no other tests.",
				commandIds: ["promotion-artifacts", "promotion-fixture"],
			},
			{
				id: "retirement-residue",
				task: "17.2 prove removal removes dependencies and registration",
				reason:
					"A removal is a statement about something that is gone, so the retired record is permanent and turns the deleted id, directory and package name into forbidden tokens across the tracked tree; the scan is the union of declared aliases and never a widened pattern over the id, because a short id turned into a pattern matches half the tree and the rule gets switched off.",
				commandIds: ["retirement-residue", "removal-fixture"],
			},
			{
				id: "findings-outlive-the-code",
				task: "17.3 record reusable findings separately",
				reason:
					"The only clause of the scenario describing something that survives is the findings artefact, so it must exist, be under a declared findings root, and NOT be inside the directory that was deleted — a findings file in the spike's own folder dies with the spike, which is what actually happens; a waiver with a reason is the honest alternative and is refused when it lifts nothing.",
				commandIds: ["findings", "removal-fixture"],
			},
			{
				id: "core-not-capability",
				task: "17.1 ship the guard wherever the directories it governs ship",
				reason:
					"This is the first guard in the program with no capability fence: the four files are present in all three renders, the package script is in all three manifests, the step is unfenced in all three workflows, the guard returns a real verdict inside each with all seven surfaces inspected, and the anti-residue scan reports nothing about any of it because there is no signature to match.",
				commandIds: ["rendered-experiments", "ci-guard", "live-gate"],
			},
			{
				id: "executed-lifecycles",
				task: "17.2 add removal and promotion fixtures",
				reason:
					"Both lifecycles are driven in sequence over real Git-backed trees rather than as isolated mutations, because the retirement scan and the universe leg both ask the index a question and the index abstains when there is no repository; each leftover registration is named one at a time and each refusal disappears as its cleanup lands.",
				commandIds: ["removal-fixture", "promotion-fixture"],
			},
			{
				id: "rollback",
				task: "17.3 document rollback and evidence",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 10D predecessor, that tree carries none of the four paths this stage adds while the implementation tree carries all of them, and nothing about the stage lives outside the tree so the revert is order-independent and costs no container rebuild in either direction.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-10e-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload, no advertised port. Stage 8B's entry existed because
			// its switch lived outside the tree; this stage has no such switch.
			outsideTheTree: [],
			// False, and it is the decision that made it false rather than luck.
			// `scripts/worktree/contract.toml` names `.devcontainer` — the whole
			// directory — as a definition fingerprint input, so Stage 10B paid a
			// rebuild for a comment-only edit to a file the image never reads. This
			// stage touches nothing under it, and it also declines the one edit it
			// was most tempted to make: `.husky/pre-commit` is not a fingerprint
			// input, so a hook rule would have cost no rebuild either — it is refused
			// because both hooks already belong to the worktree contract.
			containerRebuildRequired: false,
			scope:
				"Revert the experiment lifecycle registry and its schema, the guard and its entrypoint, the experiments:check package script, the one unfenced step in the required lane, the four ownership copy rules, the validate.ts wiring, the unfenced AGENTS.md section, the documentation, and this record as one Stage 10E bundle. Nothing here is gated, which makes the revert simpler than its four predecessors rather than harder: there is no capability to un-declare, no signature to withdraw, no packageRules entry to remove and no residue token to retire, so the reverted tree differs from the predecessor in nothing at all. Nothing about this stage lives outside the tree either: there is no repository variable, no branch-protection change and no operator step, so the revert is order-independent. Adopting or reverting it costs no container rebuild in either direction: nothing under .devcontainer/ is touched and neither is .husky/, so the definition fingerprint is unchanged. bun.lock, template-parameters.toml, every fixture, the seven exception surfaces themselves and scripts/worktree/** are untouched in both directions, and apps/ and libs/ stay empty either way.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageTenEEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 10E evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 10E evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-experiments") {
		console.log(
			JSON.stringify(
				await probeRenderExperiments({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageTenERollback({
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
void [renderWorkspacePath, rollbackWorkspacePath];
