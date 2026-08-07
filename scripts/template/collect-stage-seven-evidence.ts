// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext, validateWorkflowGraph } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { loadTemplateParameters } from "./parameters";
import { renderFixture } from "./render-fixture";
import { sha256 } from "./stage-four-evidence";
import {
	ADDED_PATHS,
	expectedStageSevenCommands,
	GATE_CASES,
	STAGE_SEVEN_COMMAND_IDS,
	type StageSevenCommandId,
	validateStageSevenEvidenceValue,
} from "./stage-seven-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, "evidence/stage-7-ci-run");
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-7-ci.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_DIRECTORY = ".github/workflows";
// The merge-base of the Stage 7 branch with origin/main, which is the last Stage
// 6 commit. The rollback proof reverts back to exactly this tree, and that tree
// carries no composite action, no gate, and no workflow guard.
const BASE_SHA = "75343aed70b712e3a6368cd059d13784a8c8e2f3";

// The CI surface. The capture is only meaningful when the tree it ran against is
// identical to the reviewed implementation boundary.
const CI_INPUTS = [
	".github",
	"scripts/ci",
	"scripts/template/ci-contract.ts",
	"scripts/template/validate-ci.ts",
	"tsconfig.json",
	"package.json",
	".prototools",
];

// The Stage 7 evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-seven-evidence.ts",
	"scripts/template/collect-stage-seven-evidence.ts",
	"scripts/template/__tests__/stage-seven-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-7-ci.json",
	"evidence/stage-7-ci.schema.json",
	"evidence/stage-7-ci-run/",
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
	id: StageSevenCommandId;
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
		"  bun scripts/template/collect-stage-seven-evidence.ts capture \\",
		"    --implementation <sha> --green-run <id> --red-run <id> \\",
		"    --red-sha <sha> --red-branch <ref> --draft-run <id> --draft-pr <number>",
		"  bun scripts/template/collect-stage-seven-evidence.ts probe-render-graph --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-seven-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
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
	id: StageSevenCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `evidence/stage-7-ci-run/${id}.stdout`;
	const stderrPath = `evidence/stage-7-ci-run/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	if (execution.exitCode !== 0)
		throw new Error(
			`Stage 7 command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
		);
	console.log(`  ${id} passed in ${Math.round((completed - started) / 1000)}s`);
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
			`Stage 7 capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertHostTooling(): void {
	for (const [binary, hint] of [
		["gh", "brew install gh, then gh auth login"],
		["git", "install git"],
		["python3", "macOS: xcode-select --install"],
		["shasum", "install perl's shasum or coreutils"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 7 capture needs ${binary} on PATH (${hint})`);
}

// Every rendered project's gate has to depend on jobs that project actually has.
// The check runs against files a renderer produced rather than against the
// template's own fenced source, because fencing a `needs` entry into emptiness
// is a defect that only exists after rendering.
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
		for (const name of parameters.generation.fixture_names) {
			const output = resolve(workspace, name);
			await renderFixture({ root, fixtureName: name, output, force: true });
			const errors: string[] = [];
			const workflows: string[] = [];
			// The rendered tree is not a repository, so the workflow list comes from
			// the directory the renderer wrote rather than from an index.
			const entries = (await readdir(resolve(output, WORKFLOW_DIRECTORY)))
				.filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
				.sort();
			for (const entry of entries) {
				const path = `${WORKFLOW_DIRECTORY}/${entry}`;
				workflows.push(path);
				const source = await Bun.file(resolve(output, path)).text();
				errors.push(...validateWorkflowGraph(source, path));
			}
			const source = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			const value = Bun.YAML.parse(source) as Record<string, unknown>;
			const jobs = (value["jobs"] ?? {}) as Record<
				string,
				Record<string, unknown>
			>;
			const gateId = "ci-gate";
			const needs = jobs[gateId]?.["needs"];
			fixtures.push({
				name,
				workflows,
				jobs: Object.keys(jobs).sort(),
				gateContext: aggregateGateContext(source) ?? "",
				gateNeeds: Array.isArray(needs) ? needs.map(String) : [],
				errors,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { schemaVersion: 1, fixtures };
}

// This stage rewrites both workflows and adds a guard, an action, and three
// shell helpers. The rollback proof is therefore the shared tree-identity probe
// plus the claim that matters for the additions — the reverted tree carries none
// of them, and the implementation tree carries all of them.
export async function probeCiRollback(options: {
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
	greenRun: number;
	redRun: number;
	redSha: string;
	redBranch: string;
	draftRun: number;
	draftPullRequest: number;
}) {
	const os = uname("-s").toLowerCase();
	if (os !== "darwin" && os !== "linux")
		throw new Error("Stage 7 evidence must be captured on macOS or Linux");
	assertHostTooling();
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
			...CI_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The CI surface changed after the Stage 7 implementation boundary",
		);
	if (execute(["git", "diff", "--quiet", "--", ...CI_INPUTS]).exitCode !== 0)
		throw new Error("The CI surface has uncommitted changes");

	const workflow = await Bun.file(resolve(ROOT, WORKFLOW_PATH)).text();
	const gateContext = aggregateGateContext(workflow);
	if (!gateContext)
		throw new Error("The committed workflow declares no aggregate gate name");
	const gateJob = (
		(Bun.YAML.parse(workflow) as Record<string, unknown>)["jobs"] as Record<
			string,
			Record<string, unknown>
		>
	)["ci-gate"];
	const gateNeeds = (gateJob?.["needs"] as string[]) ?? [];
	const nameWithOwner = checked([
		"gh",
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]).stdout.trim();
	const protectedBranch = checked([
		"gh",
		"repo",
		"view",
		"--json",
		"defaultBranchRef",
		"--jq",
		".defaultBranchRef.name",
	]).stdout.trim();

	const now = new Date();
	const runId = `stage7-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		repository: { nameWithOwner, protectedBranch, gateContext },
		live: {
			green: { runId: options.greenRun },
			red: { runId: options.redRun, headSha: options.redSha },
			draft: { runId: options.draftRun },
		},
	};
	const expected = expectedStageSevenCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageSevenCommandId, Execution>();
	for (const id of STAGE_SEVEN_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageSevenCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageSevenCommandId) => executions.get(id)?.stderr ?? "";
	const guardSummary = stdout("ci-guard")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const mutationLog = stderr("workflow-policy-mutations");
	const passCount = Number(/ (\d+) pass/.exec(mutationLog)?.[1] ?? -1);
	const failCount = Number(/ (\d+) fail/.exec(mutationLog)?.[1] ?? -1);
	const semanticsValues = keyValues(stdout("gate-semantics"));
	const graph = jsonObject(
		stdout("rendered-workflow-graph"),
		"rendered-workflow-graph",
	);
	const protection = jsonObject(
		stdout("branch-protection"),
		"branch-protection",
	);
	const checks = (protection["required_status_checks"] ?? {}) as Record<
		string,
		unknown
	>;
	const admins = (protection["enforce_admins"] ?? {}) as Record<
		string,
		unknown
	>;

	const liveSection = (
		key: "green" | "red" | "draft",
	): Record<string, unknown> => {
		const commandId = `live-gate-${key}` as StageSevenCommandId;
		const captured = keyValues(stdout(commandId));
		const document = jsonObject(captured["runJson"] ?? "", `${commandId} run`);
		const jobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
		const gate = jobs.find((job) => job["name"] === gateContext);
		return {
			commandId,
			runId: document["databaseId"],
			url: document["url"],
			event: document["event"],
			headBranch: document["headBranch"],
			headSha: document["headSha"],
			conclusion: document["conclusion"],
			gateJobId: Number(captured["gateJobId"]),
			gateConclusion: String(gate?.["conclusion"] ?? ""),
			gateLogSha256: captured["gateLogSha256"],
			upstreamResults: captured["upstreamResults"] ?? "",
			gateVerdict: captured["gateVerdict"] ?? "",
			jobs: jobs
				.filter((job) => job["name"] !== gateContext)
				.map((job) => ({
					name: String(job["name"]),
					conclusion: String(job["conclusion"]),
				})),
		};
	};

	const redValues = keyValues(stdout("live-gate-red"));
	const redJobs = (
		(jsonObject(redValues["runJson"] ?? "", "live-gate-red run")["jobs"] ??
			[]) as Array<Record<string, unknown>>
	).filter(
		(job) => job["conclusion"] === "failure" && job["name"] !== gateContext,
	);

	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");
	const protectionPath = `repos/${nameWithOwner}/branches/${protectedBranch}/protection`;

	const evidence = {
		schemaVersion: 1,
		stage: "stage-7-ci-bootstrap",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: "evidence/stage-7-ci-run" },
		source: { baseSha, implementationSha, treeClean: true },
		host: {
			os,
			architecture: uname("-m"),
			kernel: uname("-r"),
			ghVersion: /\d+\.\d+\.\d+/.exec(
				checked(["gh", "--version"]).stdout,
			)?.[0] as string,
		},
		repository: {
			nameWithOwner,
			protectedBranch,
			workflowFile: WORKFLOW_PATH,
			gateJobId: "ci-gate",
			gateContext,
			gateNeeds,
			negativeBranch: options.redBranch,
		},
		commands: records,
		guards: {
			contract: {
				commandId: "ci-guard",
				command: "bun run ci:check",
				summary: guardSummary,
			},
			mutations: {
				commandId: "workflow-policy-mutations",
				testFile: "scripts/template/__tests__/ci.test.ts",
				passCount,
				failCount,
			},
		},
		gateSemantics: {
			commandId: "gate-semantics",
			script: "scripts/ci/aggregate-gate.sh",
			draftMessage: semanticsValues["draftMessage"],
			greenOutput: semanticsValues["greenOutput"],
			cases: GATE_CASES.map((gateCase) => ({
				name: gateCase.name,
				results: gateCase.results,
				draft: gateCase.draft,
				expectedExitCode: gateCase.exitCode,
				observedExitCode: Number(semanticsValues[`case-${gateCase.name}`]),
			})),
		},
		renderGraph: {
			commandId: "rendered-workflow-graph",
			fixtures: graph["fixtures"],
		},
		live: {
			green: liveSection("green"),
			red: {
				...liveSection("red"),
				failedJob: String(redJobs[0]?.["name"] ?? ""),
				branchDeleted: true,
				injectedFiles: redValues["injectedFiles"],
				injectedNumstat: redValues["injectedNumstat"],
				injectedLines: redValues["injectedLines"],
			},
			draft: {
				...liveSection("draft"),
				isDraft: true,
				pullRequest: options.draftPullRequest,
				pullRequestClosed: true,
			},
		},
		branchProtection: {
			commandId: "branch-protection",
			branch: protectedBranch,
			contexts: checks["contexts"],
			strict: checks["strict"],
			enforceAdmins: (admins["enabled"] ?? null) as boolean,
			requiredPullRequestReviews:
				protection["required_pull_request_reviews"] !== undefined,
			restrictions: protection["restrictions"] !== undefined,
			applyCommand: ["gh", "api", "-X", "PUT", protectionPath],
			removeCommand: ["gh", "api", "-X", "DELETE", protectionPath],
		},
		coverage: [
			{
				id: "setup-input-and-context",
				task: "setup input and context",
				status: "proven",
				reason:
					"The composite action's required input, its empty-value refusal, its runtime assertion against .prototools, and the rejection of every runner context in action metadata are each driven by a mutation that has to be rejected and a lookalike that has to be accepted.",
				commandIds: ["ci-guard", "workflow-policy-mutations"],
			},
			{
				id: "trigger-forms",
				task: "trigger forms",
				status: "proven",
				reason:
					"Every form of a pull_request base-branch filter, a missing ready_for_review activity, a missing draft/ready concurrency lane, and a missing cancel-in-progress is mutated into the committed workflows and rejected.",
				commandIds: ["ci-guard", "workflow-policy-mutations"],
			},
			{
				id: "aggregate-dependency-and-results",
				task: "aggregate dependency and results",
				status: "proven",
				reason:
					"Removing a needs entry, removing always(), and removing the join over needs results are each rejected, and the whole results decision table is executed against the committed gate script rather than described.",
				commandIds: [
					"ci-guard",
					"workflow-policy-mutations",
					"gate-semantics",
					"rendered-workflow-graph",
					"live-gate-green",
					"live-gate-red",
					"live-gate-draft",
				],
			},
			{
				id: "semantic-readiness-and-liveness",
				task: "semantic readiness and liveness",
				status: "proven",
				reason:
					"A fixed sleep and a hand-rolled retry loop in a workflow body are rejected, and the committed install wrapper is executed against a deliberately hanging command to show it bounds each attempt, caps the attempt count, and surfaces the timeout exit code instead of masking it.",
				commandIds: ["ci-guard", "workflow-policy-mutations"],
			},
			{
				id: "service-readiness-probes",
				task: "semantic readiness and liveness (service-readiness portion)",
				status: "not-applicable",
				reason:
					"No job in either workflow boots a service, so there is no readiness or liveness probe in CI to mutate. The probe-based readiness this repository does own belongs to scripts/worktree/ and is guarded by the Stage 5 and Stage 6 records; claiming it here would be counting the same proof twice.",
				commandIds: [],
			},
			{
				id: "runtime-ownership",
				task: "runtime ownership",
				status: "proven",
				reason:
					"A setup-node step, an npm, npx, pnpm, yarn, or corepack invocation, and a fetch-depth on any job outside the declared history-owning list are each rejected, while bunx and the declared owner are accepted.",
				commandIds: ["ci-guard", "workflow-policy-mutations"],
			},
			{
				id: "compiler-coverage",
				task: "compiler coverage",
				status: "proven",
				reason:
					"A tracked TypeScript file that falls outside every committed tsconfig include is rejected, and the workflow is required to run a typecheck for each project, so a file the compiler never sees cannot be added silently.",
				commandIds: ["ci-guard", "workflow-policy-mutations"],
			},
			{
				id: "network-isolation",
				task: "network isolation",
				status: "proven",
				reason:
					"Any MOON_REMOTE_ variable anywhere under .github, a gate that depends on the real-network smoke workflow, a Bun dependency cache path, and a networked bootstrap in the required lane are each rejected, and the live green run shows the gate deciding from the hermetic lanes alone.",
				commandIds: [
					"ci-guard",
					"workflow-policy-mutations",
					"live-gate-green",
				],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-7-pr-merge-commit>"],
			outsideTheTree: [["gh", "api", "-X", "DELETE", protectionPath]],
			containerRebuildRequired: false,
			scope:
				"Revert the composite action, the three CI helper scripts, the root tsconfig.json, the workflow guard and its entrypoint, both workflow rewrites, the toolchain and cloud contract retargets, the ownership and Renovate wiring, the documentation, and this record as one Stage 7 bundle. Nothing under .devcontainer/** changed, so adopting or reverting this stage costs no container rebuild. One thing the revert cannot undo: branch protection lives on the forge and not in the tree, so removing the required status check is a separate operator step run with the recorded removeCommand, and it has to happen before the revert lands or every later pull request blocks on a context no workflow produces any more.",
			proof: rollbackProof,
		},
	};
	const schema = (await Bun.file(
		resolve(ROOT, "evidence/stage-7-ci.schema.json"),
	).json()) as Record<string, unknown>;
	const errors = await validateStageSevenEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 7 evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Captured ${records.length} Stage 7 commands in ${runId}.`);
}

if (import.meta.main) {
	const [action, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	const only = (allowed: string[]) => {
		for (const key of options.keys())
			if (!allowed.includes(key))
				throw new Error(`Unknown option ${key}\n${usage()}`);
	};
	if (action === "capture") {
		only([
			"--implementation",
			"--green-run",
			"--red-run",
			"--red-sha",
			"--red-branch",
			"--draft-run",
			"--draft-pr",
		]);
		await capture({
			implementation: required(options, "--implementation"),
			greenRun: Number(required(options, "--green-run")),
			redRun: Number(required(options, "--red-run")),
			redSha: required(options, "--red-sha"),
			redBranch: required(options, "--red-branch"),
			draftRun: Number(required(options, "--draft-run")),
			draftPullRequest: Number(required(options, "--draft-pr")),
		});
	} else if (action === "probe-render-graph") {
		only(["--workspace"]);
		console.log(
			JSON.stringify(
				await probeRenderGraph({ workspace: required(options, "--workspace") }),
				null,
				2,
			),
		);
	} else if (action === "probe-rollback") {
		only(["--base", "--implementation", "--workspace"]);
		console.log(
			JSON.stringify(
				await probeCiRollback({
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
