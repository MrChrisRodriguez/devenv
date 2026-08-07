// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext, validateWorkflowGraph } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { MOON_QUERY_ARGV } from "./graph-contract";
import { loadTemplateParameters } from "./parameters";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	expectedStageEightACommands,
	STAGE_EIGHT_A_COMMAND_IDS,
	STAGE_EIGHT_A_FIXTURES,
	type StageEightACommandId,
	validateStageEightAEvidenceValue,
} from "./stage-eight-a-evidence";
import { validateGraphContract } from "./validate-graph";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-8a-moon-graph-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-8a-moon-graph.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_DIRECTORY = ".github/workflows";
const REGISTRY_PATH = "ci-matrix-universes.json";
const GRAPH_JOB_ID = "moon-graph";

// The merge-base of the Stage 8A branch with origin/main, which is the Stage 7
// merge. The rollback proof reverts back to exactly this tree, and that tree
// carries no project graph, no registry, and no moon action.
const BASE_SHA = "149e6f64d08711074c8ef1191a07799677c8719f";

// The graph surface. The capture is only meaningful when the tree it ran against
// is identical to the reviewed implementation boundary.
const GRAPH_INPUTS = [
	".moon",
	"moon.yml",
	REGISTRY_PATH,
	".github",
	"scripts/template/graph-contract.ts",
	"scripts/template/generate-graph.ts",
	"scripts/template/validate-graph.ts",
	"package.json",
	".prototools",
];

// The Stage 8A evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-eight-a-evidence.ts",
	"scripts/template/collect-stage-eight-a-evidence.ts",
	"scripts/template/__tests__/stage-eight-a-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-8a-moon-graph.json",
	"evidence/stage-8a-moon-graph.schema.json",
	"evidence/stage-8a-moon-graph-run/",
	"graphify-out",
	"node_modules",
];

// The guard modules a project WITHOUT the capability must not receive. They are
// listed by path because their absence is the claim, and an absent file cannot
// name itself.
const GUARD_PATHS = [
	"scripts/template/graph-contract.ts",
	"scripts/template/generate-graph.ts",
	"scripts/template/validate-graph.ts",
	".github/actions/setup-moon/action.yml",
];

interface Execution {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageEightACommandId;
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
		"  bun scripts/template/collect-stage-eight-a-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-eight-a-evidence.ts probe-render-graph --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-eight-a-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs INSIDE the devcontainer: moon is image-owned and the host has",
		"neither moon nor proto.",
		"  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-a-evidence.ts capture …",
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

async function captureCommand(
	id: StageEightACommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-8a-moon-graph-run/${id}.stdout`;
	const stderrPath = `evidence/stage-8a-moon-graph-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	if (execution.exitCode !== 0)
		throw new Error(
			`Stage 8A command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 8A capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsInsideTheContainer(): void {
	// moon is image-owned. A capture attempted on the host would either fail on
	// the missing binary or, worse, find some other moon and seal a version this
	// repository never pins.
	if (process.env["DEVCONTAINER"] !== "true")
		throw new Error(
			"Stage 8A evidence must be captured inside the devcontainer:\n  bash scripts/worktree/exec.sh bun scripts/template/collect-stage-eight-a-evidence.ts capture …",
		);
	for (const [binary, hint] of [
		["moon", "rebuild the devcontainer image"],
		["jq", "rebuild the devcontainer image"],
		["gh", "gh auth login"],
		["python3", "rebuild the devcontainer image"],
		["shasum", "rebuild the devcontainer image"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 8A capture needs ${binary} on PATH (${hint})`);
}

/**
 * Render every fixture and report what each one received.
 *
 * The claim is about files a renderer produced, not about the template's own
 * fenced source: a capability whose fence is wrong looks perfectly correct in
 * the template and only becomes visible after rendering.
 */
export async function probeRenderGraph(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = resolve(options.workspace);
	if (!workspace.startsWith("/tmp/") || workspace.length < 12)
		throw new Error(`Refusing to render outside /tmp: ${workspace}`);
	await rm(workspace, { recursive: true, force: true });
	const parameters = await loadTemplateParameters(root);
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_EIGHT_A_FIXTURES) {
			const name = declared.name;
			if (!parameters.generation.fixture_names.includes(name))
				throw new Error(`Fixture ${name} is not declared`);
			const output = resolve(workspace, name);
			await renderFixture({ root, fixtureName: name, output, force: true });
			const workflowErrors: string[] = [];
			// The rendered tree is not a repository, so the workflow list comes from
			// the directory the renderer wrote rather than from an index.
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
			const guardPaths: string[] = [];
			for (const path of GUARD_PATHS)
				if (await Bun.file(resolve(output, path)).exists())
					guardPaths.push(path);
			// The hermetic leg has to hold over a RENDERED project, not only over
			// the tree it was written in: different slug, different path alias, no
			// template-parameters.toml, no Git index.
			const oracleErrors = declared.capabilityEnabled
				? await validateGraphContract(output)
				: [];
			fixtures.push({
				name,
				capabilityEnabled: declared.capabilityEnabled,
				registryPresent: await Bun.file(
					resolve(output, REGISTRY_PATH),
				).exists(),
				guardPaths,
				packageScripts: Object.keys(packageJson.scripts ?? {})
					.filter((script) => script.startsWith("graph:"))
					.sort(),
				jobs: Object.keys(jobs).sort(),
				gateNeeds: Array.isArray(needs) ? needs.map(String) : [],
				gateContext: aggregateGateContext(source) ?? "",
				workflowErrors,
				oracleErrors,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { schemaVersion: 1, fixtures };
}

// This stage adds a project graph, a registry, a composite action, three guard
// modules, and a gating job. The rollback proof is the shared tree-identity
// probe plus the claim that matters for the additions — the reverted tree
// carries none of them and the implementation tree carries all of them.
export async function probeGraphRollback(options: {
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
	const baseSha = gitSha(BASE_SHA);
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
			...GRAPH_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The graph surface changed after the Stage 8A implementation boundary",
		);
	if (execute(["git", "diff", "--quiet", "--", ...GRAPH_INPUTS]).exitCode !== 0)
		throw new Error("The graph surface has uncommitted changes");

	const workflow = await Bun.file(resolve(ROOT, WORKFLOW_PATH)).text();
	const gateContext = aggregateGateContext(workflow);
	if (!gateContext)
		throw new Error("The committed workflow declares no aggregate gate name");
	const jobs = (Bun.YAML.parse(workflow) as Record<string, unknown>)[
		"jobs"
	] as Record<string, Record<string, unknown>>;
	const gateNeeds = (jobs["ci-gate"]?.["needs"] as string[]) ?? [];
	const graphJobName = String(jobs[GRAPH_JOB_ID]?.["name"] ?? "");
	if (!graphJobName)
		throw new Error(`The committed workflow declares no ${GRAPH_JOB_ID} job`);
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
	const runId = `stage8a-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		repository: { nameWithOwner, gateContext },
		graph: { queryArgv: [...MOON_QUERY_ARGV] },
		live: { gate: { runId: options.gateRun } },
	};
	const expected = expectedStageEightACommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageEightACommandId, Execution>();
	for (const id of STAGE_EIGHT_A_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageEightACommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageEightACommandId) => executions.get(id)?.stderr ?? "";
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
	const query = keyValues(stdout("moon-query"));
	const queryDocument = jsonObject(query["queryJson"] ?? "", "moon-query");
	const queryProjects = (queryDocument["projects"] ?? []) as Array<
		Record<string, unknown>
	>;
	const registry = (await Bun.file(resolve(ROOT, REGISTRY_PATH)).json()) as {
		universes: Array<{ id: string; projects: string[] }>;
	};
	const graph = jsonObject(stdout("rendered-graph"), "rendered-graph");
	const gateValues = keyValues(stdout("live-gate"));
	const gateDocument = jsonObject(gateValues["runJson"] ?? "", "live-gate run");
	const gateJobs = (gateDocument["jobs"] ?? []) as Array<
		Record<string, unknown>
	>;
	const gateJob = gateJobs.find((job) => job["name"] === gateContext);
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const evidence = {
		schemaVersion: 1,
		stage: "stage-8a-moon-graph",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: "evidence/stage-8a-moon-graph-run" },
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
			graphJobId: GRAPH_JOB_ID,
			graphJobName,
			registryPath: REGISTRY_PATH,
			capability: "moon_affected_selection",
		},
		commands: records,
		guards: {
			graph: {
				commandId: "graph-guard",
				command: "bun run graph:check",
				summary: lastLine(stdout("graph-guard")),
			},
			graphMutations: {
				commandId: "graph-mutations",
				testFile: "scripts/template/__tests__/moon-graph.test.ts",
				...counts(stderr("graph-mutations")),
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
		graph: {
			commandId: "moon-query",
			queryArgv: [...MOON_QUERY_ARGV],
			projects: queryProjects
				.map((project) => ({
					id: String(project["id"] ?? ""),
					source: String(project["source"] ?? ""),
				}))
				.sort((left, right) => left.id.localeCompare(right.id)),
			edges: (query["edges"] ?? "")
				.split(",")
				.filter(Boolean)
				.map((edge) => {
					const [from, to] = edge.split("->");
					return { from: from ?? "", to: to ?? "" };
				}),
			oracleCommandId: "live-graph-oracle",
			oracleSummary: lastLine(stdout("live-graph-oracle")),
		},
		registry: {
			path: REGISTRY_PATH,
			universes: registry.universes.map((universe) => ({
				id: universe.id,
				projects: [...universe.projects].sort(),
			})),
		},
		renderFixtures: {
			commandId: "rendered-graph",
			fixtures: graph["fixtures"],
		},
		live: {
			gate: {
				commandId: "live-gate",
				runId: gateDocument["databaseId"],
				url: gateDocument["url"],
				event: gateDocument["event"],
				headBranch: gateDocument["headBranch"],
				headSha: gateDocument["headSha"],
				conclusion: gateDocument["conclusion"],
				gateJobId: Number(gateValues["gateJobId"]),
				gateConclusion: String(gateJob?.["conclusion"] ?? ""),
				gateLogSha256: gateValues["gateLogSha256"],
				upstreamResults: gateValues["upstreamResults"] ?? "",
				jobs: gateJobs
					.filter((job) => job["name"] !== gateContext)
					.map((job) => ({
						name: String(job["name"]),
						conclusion: String(job["conclusion"]),
					})),
			},
		},
		coverage: [
			{
				id: "graph-derivation",
				task: "10.1 project graph derived from manifests and imports",
				reason:
					"The graph is rebuilt from the workspace declaration, the package manifests and the source imports without running moon, and the fixtures drive a leaf edge, a fan-out, a deepest transitive chain, a path-alias import, deepest-owner attribution, and a commented-out import that must create no edge at all.",
				commandIds: ["graph-guard", "graph-mutations"],
			},
			{
				id: "generated-config-drift",
				task: "10.1 generated project configs",
				reason:
					"The generator is dry-run against every committed project config and any difference is a failure, with fixtures covering a hand-edited generated block, a project with no derived dependency, and a hand-written key outside the generated markers that must survive regeneration.",
				commandIds: ["graph-guard", "graph-mutations"],
			},
			{
				id: "universe-registry",
				task: "10.2 sole CI matrix universe registry",
				reason:
					"The registry is validated against the sealed graph so every project belongs to exactly one universe, and the corruption matrix covers absence, a parse failure, a wrong schema version, a non-kebab id, a duplicated id, an empty universe, an unknown member, a project claimed twice, a project claimed by nobody, and a second tracked registry file.",
				commandIds: ["graph-guard", "graph-mutations"],
			},
			{
				id: "live-moon-reconciliation",
				task: "10.3 live oracle against moon itself",
				reason:
					"The pinned invocation is issued against the real moon inside the devcontainer and reconciled with the independently derived graph, and every abnormal outcome — non-zero exit, silence, non-JSON, an unexpected shape, an extra project, a missing project, an unjustified edge and a missing edge — is driven through a committed stand-in binary.",
				commandIds: ["moon-toolchain", "moon-query", "live-graph-oracle"],
			},
			{
				id: "capability-isolation",
				task: "10.2 capability fencing of the whole surface",
				reason:
					"Each fixture is rendered and inspected for the registry, the guard modules, the composite action, the package scripts and the gating job, so a project without moon_affected_selection is shown to receive none of them while a project with it receives all of them and still passes the hermetic oracle.",
				commandIds: ["rendered-graph"],
			},
			{
				id: "required-lane-gating",
				task: "10.3 the required lane depends on the oracle",
				reason:
					"The workflow contract rejects an unpinned moon action, a missing version assertion, an input on the moon action, a direct third-party install, and a gate that does not depend on the graph job, and a real run shows the four-job gate reporting green at the reviewed boundary.",
				commandIds: ["ci-guard", "workflow-policy-mutations", "live-gate"],
			},
			{
				id: "rollback",
				task: "10.5 rollback",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the predecessor, and that tree is shown to carry none of the six paths this stage adds while the implementation tree carries all of them.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-8a-pr-merge-commit>"],
			// Nothing in this stage lives outside the tree. Branch protection is
			// unchanged: the required context is still the aggregate gate's display
			// name, and the graph job reaches it through `needs` rather than by
			// becoming a second required check.
			outsideTheTree: [],
			containerRebuildRequired: false,
			scope:
				"Revert the workspace and root project configuration, the package.json workspaces edit, the matrix universe registry, the three graph guard modules and their package scripts, the setup-moon composite action, the fenced ci step, the moon-graph job and its gate dependency, the workflow contract rules, the ownership wiring, the documentation, and this record as one Stage 8A bundle. Nothing under .devcontainer/** changed, so adopting or reverting this stage costs no container rebuild. Branch protection needs no operator step: the required context is unchanged, because the graph job reaches the gate through needs instead of becoming a second required check.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(
		resolve(ROOT, "evidence/stage-8a-moon-graph.schema.json"),
	).json()) as Record<string, unknown>;
	const errors = await validateStageEightAEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 8A evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 8A evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-graph") {
		console.log(
			JSON.stringify(
				await probeRenderGraph({ workspace: required(options, "--workspace") }),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeGraphRollback({
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
