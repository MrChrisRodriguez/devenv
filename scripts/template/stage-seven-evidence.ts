// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
// The guard's own answer to "what is the required status check called?". The
// record derives the context from the committed workflow through this function
// rather than restating it, so a renamed gate job invalidates the evidence.
import {
	aggregateGateContext,
	DEFAULT_AGGREGATE_GATE_NAME,
} from "./ci-contract";
import { validateJsonSchema } from "./json-schema";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_SEVEN_COMMAND_IDS = [
	"ci-guard",
	"workflow-policy-mutations",
	"gate-semantics",
	"rendered-workflow-graph",
	// The four commands that read something this repository cannot fabricate: a
	// real run on GitHub's runners, and the branch protection that consumes it.
	"live-gate-green",
	"live-gate-red",
	"live-gate-draft",
	"branch-protection",
	"rollback-proof",
] as const;

export type StageSevenCommandId = (typeof STAGE_SEVEN_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-7-ci-run";
const COLLECTOR = "scripts/template/collect-stage-seven-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const GATE_SCRIPT = "scripts/ci/aggregate-gate.sh";

// The seven mutation categories task 9.5 names, plus the one portion of the
// readiness category that this repository has nothing to apply it to. Declaring
// that portion not-applicable in the record is the honest alternative to a
// coverage claim no command backs.
export const STAGE_SEVEN_COVERAGE_IDS = [
	"setup-input-and-context",
	"trigger-forms",
	"aggregate-dependency-and-results",
	"semantic-readiness-and-liveness",
	"service-readiness-probes",
	"runtime-ownership",
	"compiler-coverage",
	"network-isolation",
] as const;

// The gate's whole decision table, driven against the committed script rather
// than against a description of it. `draft` is the raw string a workflow puts in
// the environment, so the empty value is a push and not a missing case.
export const GATE_CASES = [
	{
		name: "push-every-job-succeeded",
		results: "success,success,success",
		draft: "",
		exitCode: 0,
	},
	{
		name: "ready-success-and-skipped",
		results: "success,skipped",
		draft: "false",
		exitCode: 0,
	},
	{
		name: "ready-one-job-failed",
		results: "failure,success,success",
		draft: "false",
		exitCode: 1,
	},
	{
		name: "ready-one-job-cancelled",
		results: "success,cancelled",
		draft: "false",
		exitCode: 1,
	},
	{
		name: "ready-one-result-empty",
		results: "success,,success",
		draft: "false",
		exitCode: 1,
	},
	{ name: "ready-no-results-at-all", results: "", draft: "false", exitCode: 1 },
	{
		name: "draft-every-job-skipped",
		results: "skipped,skipped,skipped",
		draft: "true",
		exitCode: 1,
	},
] as const;

// Everything this stage adds to the tree. A revert has to take all of it back
// out, which is the additive half of the rollback proof. Branch protection is
// deliberately absent: it is not in the tree, which is exactly why the record
// carries a separate removal command for it.
export const ADDED_PATHS = [
	".github/actions/setup-bun/action.yml",
	"scripts/ci/aggregate-gate.sh",
	"scripts/ci/bun-install-retry.sh",
	"scripts/ci/run-tests.sh",
	"scripts/ci/run-typecheck.sh",
	"scripts/template/__tests__/ci.test.ts",
	"scripts/template/ci-contract.ts",
	"scripts/template/validate-ci.ts",
	"tsconfig.json",
] as const;

// The one line of the negative control. The branch that carried it is deleted by
// the time anybody reads this, so the record has to say what it was.
export const NEGATIVE_CONTROL_LINES = [
	"- name: Deliberate gate negative control",
	"run: exit 1",
] as const;

// Compact one-line JSON, so a whole run description can travel as one recorded
// value in a key=value log.
const COMPACT_JSON =
	'python3 -c \'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))\'';

const RUN_FIELDS =
	"conclusion,createdAt,databaseId,event,headBranch,headSha,jobs,status,url,workflowName";

export function renderWorkspacePath(runId: string): string {
	return `/tmp/devenv-${runId}-render`;
}

// The shared rollback prober only accepts a temporary workspace whose first path
// segment names its own stage, so this one keeps that prefix.
export function rollbackWorkspacePath(runId: string): string {
	return `/tmp/devenv-stage2-${runId}-rollback`;
}

// The gate's decision table, executed. Every case runs the committed script with
// nothing but the two environment values a workflow would give it, and the
// recorded exit code is the script's own.
function gateSemanticsProbe(): string {
	const lines = [
		// Not `set -e`: the failing verdicts are the subject here, not an accident.
		"set -uo pipefail",
	];
	for (const gateCase of GATE_CASES) {
		lines.push(
			"status=0",
			`RESULTS=${JSON.stringify(gateCase.results)} DRAFT=${JSON.stringify(gateCase.draft)} \\`,
			`\tbash ${GATE_SCRIPT} >/dev/null 2>&1 || status=$?`,
			`printf 'case-${gateCase.name}=%s\\n' "$status"`,
		);
	}
	lines.push(
		// The two messages a developer actually sees, captured verbatim.
		`draft_message="$(RESULTS='skipped,skipped' DRAFT=true bash ${GATE_SCRIPT} 2>&1 1>/dev/null || true)"`,
		"printf 'draftMessage=%s\\n' \"$draft_message\"",
		`green_output="$(RESULTS='success,success,success' DRAFT=false bash ${GATE_SCRIPT} 2>/dev/null || true)"`,
		"printf 'greenOutput=%s\\n' \"$(printf '%s' \"$green_output\" | tr '\\n' '|')\"",
		"exit 0",
	);
	return lines.join("\n");
}

// One real run on GitHub's runners, read back through the same CLI a reviewer
// would use. Nothing here is asserted: the run description, the gate job's own
// log digest, the results string the gate was handed, and the verdict it printed
// are all read out of the service and sealed.
function liveRunProbe(
	repository: string,
	runId: number,
	gateContext: string,
): string[] {
	return [
		"set -euo pipefail",
		`run="$(gh run view ${runId} --repo ${repository} --json ${RUN_FIELDS})"`,
		`printf 'runJson=%s\\n' "$(printf '%s' "$run" | ${COMPACT_JSON})"`,
		`gate="$(printf '%s' "$run" | python3 -c 'import json,sys; print([job["databaseId"] for job in json.load(sys.stdin)["jobs"] if job["name"] == sys.argv[1]][0])' ${JSON.stringify(gateContext)})"`,
		"printf 'gateJobId=%s\\n' \"$gate\"",
		`log="$(gh run view --repo ${repository} --job "$gate" --log)"`,
		"printf 'gateLogSha256=%s\\n' \"$(printf '%s' \"$log\" | shasum -a 256 | awk '{ print $1 }')\"",
		"printf 'upstreamResults=%s\\n' \"$(printf '%s\\n' \"$log\" | sed -n 's/.*upstream results: //p' | head -n 1)\"",
		"printf 'gateVerdict=%s\\n' \"$(printf '%s\\n' \"$log\" | sed -n 's/.*##\\[error\\]//p' | head -n 1)\"",
		"printf 'gateGreenLines=%s\\n' \"$(printf '%s\\n' \"$log\" | grep -c 'Every required job passed or was skipped' || true)\"",
	];
}

// The negative control's own diff, read out of Git while the throwaway commit is
// still reachable. The branch is deleted immediately afterwards, so this is the
// only place the injected failure survives.
function negativeControlProbe(
	repository: string,
	runId: number,
	gateContext: string,
	implementationSha: string,
	negativeSha: string,
): string {
	return [
		...liveRunProbe(repository, runId, gateContext),
		`printf 'injectedFiles=%s\\n' "$(git diff --name-only ${implementationSha} ${negativeSha} | tr '\\n' ' ')"`,
		`printf 'injectedNumstat=%s\\n' "$(git diff --numstat ${implementationSha} ${negativeSha} | tr '\\t' ' ' | tr '\\n' '|')"`,
		`printf 'injectedLines=%s\\n' "$(git diff ${implementationSha} ${negativeSha} | grep '^+[^+]' | sed 's/^+[[:space:]]*//' | grep . | tr '\\n' '|')"`,
	].join("\n");
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	return isRecord(value[key]) ? (value[key] as JsonRecord) : {};
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
	return Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function keyValues(value: string): JsonRecord {
	return Object.fromEntries(
		value.split("\n").flatMap((line) => {
			const match = /^([A-Za-z][A-Za-z0-9-]*)=(.*)$/.exec(line);
			return match?.[1] ? [[match[1], match[2] ?? ""]] : [];
		}),
	);
}

function parseJson(value: unknown): JsonRecord {
	try {
		const parsed = JSON.parse(String(value ?? ""));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

// One run description reduced to what every assertion below needs.
interface LiveRun {
	conclusion: string;
	event: string;
	headBranch: string;
	headSha: string;
	workflowName: string;
	databaseId: unknown;
	jobs: Array<{ name: string; conclusion: string }>;
}

function liveRun(value: unknown): LiveRun {
	const document = parseJson(value);
	const jobs = Array.isArray(document["jobs"]) ? document["jobs"] : [];
	return {
		conclusion: String(document["conclusion"] ?? ""),
		event: String(document["event"] ?? ""),
		headBranch: String(document["headBranch"] ?? ""),
		headSha: String(document["headSha"] ?? ""),
		workflowName: String(document["workflowName"] ?? ""),
		databaseId: document["databaseId"],
		jobs: jobs.flatMap((entry) =>
			isRecord(entry)
				? [
						{
							name: String(entry["name"] ?? ""),
							conclusion: String(entry["conclusion"] ?? ""),
						},
					]
				: [],
		),
	};
}

export function expectedStageSevenCommands(
	value: JsonRecord,
): Record<StageSevenCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const live = recordAt(value, "live");
	const green = recordAt(live, "green");
	const red = recordAt(live, "red");
	const draft = recordAt(live, "draft");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const context = String(repository["gateContext"] ?? "");
	const branch = String(repository["protectedBranch"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	return {
		"ci-guard": ["bun", "run", "ci:check"],
		"workflow-policy-mutations": [
			"bun",
			"test",
			"scripts/template/__tests__/ci.test.ts",
		],
		"gate-semantics": ["bash", "-c", gateSemanticsProbe()],
		"rendered-workflow-graph": [
			"bun",
			COLLECTOR,
			"probe-render-graph",
			"--workspace",
			renderWorkspacePath(runId),
		],
		"live-gate-green": [
			"bash",
			"-c",
			liveRunProbe(name, Number(green["runId"] ?? 0), context).join("\n"),
		],
		"live-gate-red": [
			"bash",
			"-c",
			negativeControlProbe(
				name,
				Number(red["runId"] ?? 0),
				context,
				implementationSha,
				String(red["headSha"] ?? ""),
			),
		],
		"live-gate-draft": [
			"bash",
			"-c",
			liveRunProbe(name, Number(draft["runId"] ?? 0), context).join("\n"),
		],
		"branch-protection": [
			"gh",
			"api",
			`repos/${name}/branches/${branch}/protection`,
		],
		"rollback-proof": [
			"bun",
			COLLECTOR,
			"probe-rollback",
			"--base",
			String(source["baseSha"] ?? ""),
			"--implementation",
			implementationSha,
			"--workspace",
			rollbackWorkspacePath(runId),
		],
	};
}

function git(
	root: string,
	args: string[],
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

// The gate's dependency list, read out of the committed workflow. It is the
// bridge between the sealed live runs and the file this repository ships: a run
// that reported three upstream results is only evidence for a gate that depends
// on three jobs.
function gateNeeds(source: string): string[] {
	try {
		const value = Bun.YAML.parse(source) as JsonRecord;
		const jobs = recordAt(value, "jobs");
		const gate = recordAt(jobs, DEFAULT_AGGREGATE_GATE_NAME);
		const needs = gate["needs"];
		if (typeof needs === "string") return [needs];
		return Array.isArray(needs)
			? needs.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

export async function validateStageSevenEvidenceValue(
	value: unknown,
	schema: JsonRecord,
	root: string,
): Promise<string[]> {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const expected = expectedStageSevenCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string"
			? [entry["id"] as string]
			: [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_SEVEN_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 7 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 7 command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageSevenCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 7 command observes; none of them is a refusal, so a non-zero
		// exit anywhere in this record is a capture that did not finish.
		if (entry["exitCode"] !== 0 || entry["status"] !== "pass")
			errors.push(`semantic: command ${id} did not pass`);
		for (const stream of ["stdout", "stderr"] as const) {
			const path = `${LOG_ROOT}/${id}.${stream}`;
			if (entry[`${stream}Path`] !== path)
				errors.push(`semantic: command ${id} ${stream} path drifted`);
			const file = Bun.file(resolve(root, path));
			if (!(await file.exists()))
				errors.push(`repository: command ${id} ${stream} log is missing`);
			else {
				const bytes = await file.bytes();
				logs.set(`${id}.${stream}`, new TextDecoder().decode(bytes));
				if (entry[`${stream}Sha256`] !== sha256(bytes))
					errors.push(`repository: command ${id} ${stream} digest drifted`);
			}
		}
	}
	const log = (id: string, stream: "stdout" | "stderr"): string =>
		logs.get(`${id}.${stream}`) ?? "";
	const values = (id: string): JsonRecord => keyValues(log(id, "stdout"));

	// The committed workflow is the only live thing this validator is allowed to
	// read, and it is read as a file in the tree rather than as a property of the
	// machine: no `gh`, no network, no runner, and no comparison between a sealed
	// absolute path and wherever this checkout happens to be.
	const workflow = await Bun.file(resolve(root, WORKFLOW_PATH))
		.text()
		.catch(() => "");
	const context = aggregateGateContext(workflow);
	const needs = gateNeeds(workflow);
	// The jobs this record is evidence ABOUT. Every run-shape check below is
	// anchored on this list rather than on the committed workflow's current one,
	// because the two answer different questions. What the sealed runs prove is
	// "every job that existed when they ran reported into the gate", and that
	// stays true forever. Whether the gate is complete TODAY is a live question,
	// and it already has an owner: the workflow contract requires the gate to
	// depend on every job in the file, and fails the build when it does not.
	//
	// Re-resolving the shape against the current workflow instead made this
	// record fail the moment a later stage added a job — a green historical
	// capture reported as fabrication, with the only repair being to re-run
	// three live workflows for a claim nothing had falsified. It is the same
	// mistake the Stage 5A validator made against an absolute host path, fixed
	// the same way: assert the property that made the capture meaningful.
	const sealedNeeds = arrayAt(repository, "gateNeeds").filter(
		(entry): entry is string => typeof entry === "string",
	);
	// A sealed need that the gate no longer declares means the record describes
	// a lane that has been renamed or removed, and its runs are evidence for a
	// workflow this repository no longer ships. Growth is legal; loss is not.
	const droppedNeeds = sealedNeeds.filter((need) => !needs.includes(need));
	if (
		repository["workflowFile"] !== WORKFLOW_PATH ||
		repository["gateJobId"] !== DEFAULT_AGGREGATE_GATE_NAME ||
		context === undefined ||
		repository["gateContext"] !== context ||
		sealedNeeds.length !== arrayAt(repository, "gateNeeds").length ||
		droppedNeeds.length > 0 ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// The two hermetic guards, bound to what they actually printed.
	const guards = recordAt(value, "guards");
	const contract = recordAt(guards, "contract");
	const mutations = recordAt(guards, "mutations");
	const mutationLog = log("workflow-policy-mutations", "stderr");
	const passes = / (\d+) pass/.exec(mutationLog);
	const failures = / (\d+) fail/.exec(mutationLog);
	if (
		contract["commandId"] !== "ci-guard" ||
		!log("ci-guard", "stdout").includes(String(contract["summary"] ?? " ")) ||
		!String(contract["summary"] ?? "").includes("aggregate gate membership") ||
		mutations["commandId"] !== "workflow-policy-mutations" ||
		mutations["testFile"] !== "scripts/template/__tests__/ci.test.ts" ||
		mutations["passCount"] !== Number(passes?.[1] ?? -1) ||
		mutations["failCount"] !== Number(failures?.[1] ?? -1) ||
		mutations["failCount"] !== 0 ||
		Number(mutations["passCount"] ?? 0) < 12
	)
		errors.push("semantic: workflow guard evidence drifted");

	// The gate's decision table, case by case, against the exit codes the
	// committed script produced.
	const semantics = recordAt(value, "gateSemantics");
	const observed = values("gate-semantics");
	const cases = arrayAt(semantics, "cases").filter(isRecord);
	if (
		semantics["commandId"] !== "gate-semantics" ||
		semantics["script"] !== GATE_SCRIPT ||
		cases.length !== GATE_CASES.length ||
		semantics["draftMessage"] !== observed["draftMessage"] ||
		!String(semantics["draftMessage"] ?? "").includes("draft") ||
		!String(semantics["draftMessage"] ?? "").includes("Mark it ready") ||
		semantics["greenOutput"] !== observed["greenOutput"] ||
		!String(semantics["greenOutput"] ?? "").includes(
			"Every required job passed or was skipped",
		)
	)
		errors.push("semantic: gate decision table drifted");
	for (const [index, expectedCase] of GATE_CASES.entries()) {
		const sealed = cases[index] ?? {};
		const key = `case-${expectedCase.name}`;
		if (
			sealed["name"] !== expectedCase.name ||
			sealed["results"] !== expectedCase.results ||
			sealed["draft"] !== expectedCase.draft ||
			sealed["expectedExitCode"] !== expectedCase.exitCode ||
			sealed["observedExitCode"] !== expectedCase.exitCode ||
			observed[key] !== String(expectedCase.exitCode)
		)
			errors.push(`semantic: gate case ${expectedCase.name} drifted`);
	}

	// Every rendered project's gate depends on jobs that project actually has.
	const graph = recordAt(value, "renderGraph");
	const rendered = parseJson(log("rendered-workflow-graph", "stdout"));
	const fixtures = arrayAt(graph, "fixtures").filter(isRecord);
	if (
		graph["commandId"] !== "rendered-workflow-graph" ||
		!sameValue(graph["fixtures"], rendered["fixtures"]) ||
		fixtures.length < 3 ||
		fixtures.some(
			(fixture) =>
				!sameValue(fixture["errors"], []) ||
				arrayAt(fixture, "gateNeeds").length === 0 ||
				!arrayAt(fixture, "jobs").includes(DEFAULT_AGGREGATE_GATE_NAME),
		)
	)
		errors.push("semantic: rendered workflow graph evidence drifted");
	const minimal = fixtures.find((fixture) => fixture["name"] === "minimal");
	const full = fixtures.find((fixture) => fixture["name"] === "full");
	if (
		!minimal ||
		!full ||
		arrayAt(minimal, "jobs").includes("browser") ||
		arrayAt(minimal, "gateNeeds").includes("browser") ||
		!arrayAt(full, "jobs").includes("browser") ||
		!arrayAt(full, "gateNeeds").includes("browser") ||
		// A gate whose whole dependency list was fenced away would report success
		// on a run in which nothing happened.
		arrayAt(minimal, "gateNeeds").length === 0
	)
		errors.push("semantic: rendered workflow graph evidence drifted");

	// The three real runs. Each one is read back out of its own sealed
	// description, never restated.
	const live = recordAt(value, "live");
	const name = String(repository["nameWithOwner"] ?? "");
	for (const key of ["green", "red", "draft"] as const) {
		const sealed = recordAt(live, key);
		const commandId = `live-gate-${key}`;
		const captured = values(commandId);
		const observedRun = liveRun(captured["runJson"]);
		const gate = observedRun.jobs.find((job) => job.name === context);
		const others = observedRun.jobs.filter((job) => job.name !== context);
		if (
			sealed["commandId"] !== commandId ||
			sealed["runId"] !== observedRun.databaseId ||
			sealed["headSha"] !== observedRun.headSha ||
			sealed["headBranch"] !== observedRun.headBranch ||
			sealed["event"] !== observedRun.event ||
			sealed["conclusion"] !== observedRun.conclusion ||
			observedRun.workflowName !== "CI" ||
			sealed["gateConclusion"] !== gate?.conclusion ||
			sealed["gateJobId"] !== Number(captured["gateJobId"] ?? -1) ||
			sealed["gateLogSha256"] !== captured["gateLogSha256"] ||
			sealed["upstreamResults"] !== captured["upstreamResults"] ||
			sealed["gateVerdict"] !== captured["gateVerdict"] ||
			!sameValue(
				sealed["jobs"],
				others.map((job) => ({
					name: job.name,
					conclusion: job.conclusion,
				})),
			) ||
			// Every job the gate depended on WHEN THIS RAN reported into it. The
			// count comes from the record's own gateNeeds, so the claim stays a
			// claim about that run; a record whose runs disagree with its own
			// sealed dependency list is still rejected here.
			others.length !== sealedNeeds.length
		)
			errors.push(`semantic: live ${key} run evidence drifted`);
	}

	const green = recordAt(live, "green");
	const greenValues = values("live-gate-green");
	const greenRun = liveRun(greenValues["runJson"]);
	if (
		green["conclusion"] !== "success" ||
		green["gateConclusion"] !== "success" ||
		greenRun.jobs.some((job) => job.conclusion !== "success") ||
		green["headSha"] !== source["implementationSha"] ||
		green["upstreamResults"] !== sealedNeeds.map(() => "success").join(",") ||
		green["gateVerdict"] !== "" ||
		Number(greenValues["gateGreenLines"] ?? 0) < 1
	)
		errors.push("semantic: live green run evidence drifted");

	// The negative control: one job failed, every other job passed, and the gate
	// went red because of it. The branch is gone, so the record carries the
	// injected diff and the log is the only surviving copy of it.
	const red = recordAt(live, "red");
	const redValues = values("live-gate-red");
	const redRun = liveRun(redValues["runJson"]);
	const redFailures = redRun.jobs.filter(
		(job) => job.conclusion === "failure" && job.name !== context,
	);
	const redSuccesses = redRun.jobs.filter(
		(job) => job.conclusion === "success",
	);
	if (
		red["conclusion"] !== "failure" ||
		red["gateConclusion"] !== "failure" ||
		redFailures.length !== 1 ||
		red["failedJob"] !== redFailures[0]?.name ||
		redSuccesses.length !== sealedNeeds.length - 1 ||
		red["headBranch"] !== repository["negativeBranch"] ||
		red["branchDeleted"] !== true ||
		red["headSha"] === source["implementationSha"] ||
		!String(red["upstreamResults"] ?? "").includes("failure") ||
		!String(red["gateVerdict"] ?? "").includes("A required job did not pass") ||
		red["injectedFiles"] !== redValues["injectedFiles"] ||
		String(red["injectedFiles"] ?? "").trim() !== WORKFLOW_PATH ||
		red["injectedNumstat"] !== redValues["injectedNumstat"] ||
		red["injectedLines"] !== redValues["injectedLines"] ||
		!sameValue(
			String(red["injectedLines"] ?? "")
				.split("|")
				.filter(Boolean),
			[...NEGATIVE_CONTROL_LINES],
		)
	)
		errors.push("semantic: live red run evidence drifted");

	// The draft lane: every gating job skipped, and the gate red anyway. Without
	// this the `ready_for_review` trigger would be decorative — a draft whose
	// required check was green could merge the instant it was marked ready.
	const draft = recordAt(live, "draft");
	const draftValues = values("live-gate-draft");
	const draftRun = liveRun(draftValues["runJson"]);
	if (
		draft["conclusion"] !== "failure" ||
		draft["gateConclusion"] !== "failure" ||
		draft["event"] !== "pull_request" ||
		draft["isDraft"] !== true ||
		draft["pullRequestClosed"] !== true ||
		typeof draft["pullRequest"] !== "number" ||
		draftRun.jobs.some(
			(job) => job.name !== context && job.conclusion !== "skipped",
		) ||
		// The gate never got as far as reading results: it refused on the draft.
		draft["upstreamResults"] !== "" ||
		!String(draft["gateVerdict"] ?? "").includes("draft") ||
		!String(draft["gateVerdict"] ?? "").includes("Mark it ready for review") ||
		// The verdict a developer read on a real draft pull request is the message
		// the committed script emits, minus the `::error::` workflow command the
		// runner consumes turning it into an annotation. Binding the two is what
		// makes the hermetic decision table evidence about the live gate rather
		// than about a script that happens to live next to it.
		semantics["draftMessage"] !== `::error::${draft["gateVerdict"]}`
	)
		errors.push("semantic: live draft run evidence drifted");

	// Branch protection: outside the tree, so it is proved by reading it back and
	// recorded together with the command that removes it again.
	const protection = recordAt(value, "branchProtection");
	const observedProtection = parseJson(log("branch-protection", "stdout"));
	const checks = recordAt(observedProtection, "required_status_checks");
	const admins = recordAt(observedProtection, "enforce_admins");
	if (
		protection["commandId"] !== "branch-protection" ||
		protection["branch"] !== repository["protectedBranch"] ||
		!sameValue(protection["contexts"], checks["contexts"]) ||
		!sameValue(protection["contexts"], [context]) ||
		protection["strict"] !== checks["strict"] ||
		protection["strict"] !== true ||
		protection["enforceAdmins"] !== admins["enabled"] ||
		protection["enforceAdmins"] !== false ||
		protection["requiredPullRequestReviews"] !== false ||
		observedProtection["required_pull_request_reviews"] !== undefined ||
		protection["restrictions"] !== false ||
		observedProtection["restrictions"] !== undefined ||
		!sameValue(protection["applyCommand"], [
			"gh",
			"api",
			"-X",
			"PUT",
			`repos/${name}/branches/${repository["protectedBranch"]}/protection`,
		]) ||
		!sameValue(protection["removeCommand"], [
			"gh",
			"api",
			"-X",
			"DELETE",
			`repos/${name}/branches/${repository["protectedBranch"]}/protection`,
		])
	)
		errors.push("semantic: branch protection evidence drifted");

	// The mutation-category map, kept honest: a category is either backed by a
	// command in this record or declared not-applicable with a reason.
	const coverage = arrayAt(value, "coverage").filter(isRecord);
	if (
		!sameValue(
			coverage.map((entry) => entry["id"]),
			[...STAGE_SEVEN_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 7 coverage map drifted");
	let notApplicable = 0;
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds");
		if (entry["status"] === "not-applicable") {
			notApplicable += 1;
			if (entryCommands.length !== 0 || String(entry["reason"]).length < 40)
				errors.push(`semantic: coverage ${entry["id"]} is not reasoned`);
		} else if (
			entryCommands.length === 0 ||
			entryCommands.some(
				(commandId) =>
					!STAGE_SEVEN_COMMAND_IDS.includes(commandId as StageSevenCommandId),
			)
		)
			errors.push(`semantic: coverage ${entry["id"]} names no proving command`);
	}
	if (notApplicable !== 1)
		errors.push("semantic: Stage 7 coverage map drifted");

	// This stage adds files and rewrites workflows, so the revert is one bundle.
	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-7-pr-merge-commit>",
		]) ||
		!sameValue(rollback["outsideTheTree"], [
			[
				"gh",
				"api",
				"-X",
				"DELETE",
				`repos/${name}/branches/${repository["protectedBranch"]}/protection`,
			],
		]) ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("branch protection") ||
		!String(rollback["scope"] ?? "").includes("no container rebuild")
	)
		errors.push("semantic: Stage 7 rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 7 rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	// Re-derived from Git objects the record names, so a reviewer never has to
	// trust the probe: the reverted tree is the predecessor tree, and in that tree
	// none of the files this stage adds exists.
	const revertedTree = String(proof["revertedTree"] ?? "");
	for (const path of ADDED_PATHS) {
		const restored = git(root, ["cat-file", "-e", `${revertedTree}:${path}`]);
		const current = git(root, [
			"cat-file",
			"-e",
			`${String(source["implementationSha"] ?? "")}:${path}`,
		]);
		if (restored.exitCode === 0 || current.exitCode !== 0)
			errors.push(`repository: ${path} does not prove the additive boundary`);
	}

	for (const [label, sha] of [
		["base", source["baseSha"]],
		["implementation", source["implementationSha"]],
	] as const)
		if (
			typeof sha !== "string" ||
			git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 7 ${label} commit is missing`);
	if (
		typeof source["baseSha"] === "string" &&
		typeof source["implementationSha"] === "string" &&
		git(root, [
			"merge-base",
			"--is-ancestor",
			source["baseSha"] as string,
			source["implementationSha"] as string,
		]).exitCode !== 0
	)
		errors.push(
			"repository: Stage 7 base is not an ancestor of implementation",
		);
	if (
		typeof source["implementationSha"] === "string" &&
		git(root, [
			"merge-base",
			"--is-ancestor",
			source["implementationSha"] as string,
			"HEAD",
		]).exitCode !== 0
	)
		errors.push(
			"repository: Stage 7 implementation is not an ancestor of HEAD",
		);
	return errors;
}

export async function validateStageSevenEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-7-ci.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-7-ci.schema.json"),
		).json()) as JsonRecord;
		return validateStageSevenEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
