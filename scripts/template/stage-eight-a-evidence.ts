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

export const STAGE_EIGHT_A_COMMAND_IDS = [
	"graph-guard",
	"graph-mutations",
	"ci-guard",
	"workflow-policy-mutations",
	// The three commands that need the real toolchain, and are the reason this
	// capture runs inside the devcontainer: moon is image-owned, and the host
	// has neither moon nor proto.
	"moon-toolchain",
	"moon-query",
	"live-graph-oracle",
	"rendered-graph",
	// The one command that reads something this repository cannot fabricate: a
	// real run on GitHub's runners.
	"live-gate",
	"rollback-proof",
] as const;

export type StageEightACommandId = (typeof STAGE_EIGHT_A_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-8a-moon-graph-run";
const COLLECTOR = "scripts/template/collect-stage-eight-a-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const REGISTRY_PATH = "ci-matrix-universes.json";
const GRAPH_JOB_ID = "moon-graph";
const CAPABILITY = "moon_affected_selection";

// The paths this stage adds. A revert has to take every one of them back out,
// which is the additive half of the rollback proof: the reverted tree carries
// none of them and the implementation tree carries all of them.
export const ADDED_PATHS = [
	"moon.yml",
	REGISTRY_PATH,
	".github/actions/setup-moon/action.yml",
	"scripts/template/graph-contract.ts",
	"scripts/template/generate-graph.ts",
	"scripts/template/validate-graph.ts",
] as const;

// The three fixtures and what each one must show. `minimal` and `cloud` disable
// the capability, so the whole Stage 8A surface has to be absent from them —
// which is the claim the pre-declared residue signature makes checkable.
export const STAGE_EIGHT_A_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_EIGHT_A_COVERAGE_IDS = [
	"graph-derivation",
	"generated-config-drift",
	"universe-registry",
	"live-moon-reconciliation",
	"capability-isolation",
	"required-lane-gating",
	"rollback",
] as const;

// Compact one-line JSON, so a whole moon query or run description can travel as
// one recorded value in a key=value log.
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

// The toolchain the live legs actually ran against, read from the binary and
// from the manifest in the same breath. Recording both is what lets the
// validator bind them to each other instead of to whatever this checkout's
// .prototools happens to say years from now.
function moonToolchainProbe(): string {
	return [
		"set -euo pipefail",
		"printf 'moonVersion=%s\\n' \"$(moon --version | awk '{ print $2 }')\"",
		'printf \'prototoolsMoon=%s\\n\' "$(sed -n \'s/^moon = "\\([^"]*\\)"[[:space:]]*$/\\1/p\' .prototools | head -n 1)"',
		"printf 'bunVersion=%s\\n' \"$(bun --version)\"",
	].join("\n");
}

// The live project graph, straight out of moon, reduced to the three facts the
// record compares: the ids, where each one lives, and the edges between them.
// The invocation is built from the argv the contract pins, so a record can only
// exist for the command the guard actually issues.
export function moonQueryProbe(argv: readonly string[]): string {
	// `dependencies` is absent rather than empty for a project with no edges, so
	// the fallback is what keeps a dependency-free graph from being an error.
	const projectFilter =
		'[.projects[] | "\\(.id)=\\(.source)"] | sort | join(",")';
	const edgeFilter =
		'[.projects[] as $p | ($p.dependencies // [])[] | "\\($p.id)->\\(.id)"] | sort | join(",")';
	return [
		"set -euo pipefail",
		`query="$(moon ${argv.join(" ")})"`,
		`printf 'queryJson=%s\\n' "$(printf '%s' "$query" | ${COMPACT_JSON})"`,
		`printf 'projects=%s\\n' "$(printf '%s' "$query" | jq -r '${projectFilter}')"`,
		`printf 'edges=%s\\n' "$(printf '%s' "$query" | jq -r '${edgeFilter}')"`,
	].join("\n");
}

// One run description reduced to what every assertion below needs.
function liveGateProbe(
	repository: string,
	runId: number,
	gateContext: string,
): string {
	return [
		"set -euo pipefail",
		`run="$(gh run view ${runId} --repo ${repository} --json ${RUN_FIELDS})"`,
		`printf 'runJson=%s\\n' "$(printf '%s' "$run" | ${COMPACT_JSON})"`,
		`gate="$(printf '%s' "$run" | python3 -c 'import json,sys; print([job["databaseId"] for job in json.load(sys.stdin)["jobs"] if job["name"] == sys.argv[1]][0])' ${JSON.stringify(gateContext)})"`,
		"printf 'gateJobId=%s\\n' \"$gate\"",
		`log="$(gh run view --repo ${repository} --job "$gate" --log)"`,
		"printf 'gateLogSha256=%s\\n' \"$(printf '%s' \"$log\" | shasum -a 256 | awk '{ print $1 }')\"",
		"printf 'upstreamResults=%s\\n' \"$(printf '%s\\n' \"$log\" | sed -n 's/.*upstream results: //p' | head -n 1)\"",
		"printf 'gateGreenLines=%s\\n' \"$(printf '%s\\n' \"$log\" | grep -c 'Every required job passed or was skipped' || true)\"",
	].join("\n");
}

/**
 * The exact command every recorded id must have run, derived from the record's
 * own context. A record cannot describe a command it did not issue, and it
 * cannot quietly widen one either.
 */
export function expectedStageEightACommands(
	value: JsonRecord,
): Record<StageEightACommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const graph = recordAt(value, "graph");
	const live = recordAt(value, "live");
	const gate = recordAt(live, "gate");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const context = String(repository["gateContext"] ?? "");
	const argv = arrayAt(graph, "queryArgv").map(String);
	return {
		"graph-guard": ["bun", "run", "graph:check"],
		"graph-mutations": [
			"bun",
			"test",
			"scripts/template/__tests__/moon-graph.test.ts",
		],
		"ci-guard": ["bun", "run", "ci:check"],
		"workflow-policy-mutations": [
			"bun",
			"test",
			"scripts/template/__tests__/ci.test.ts",
		],
		"moon-toolchain": ["bash", "-c", moonToolchainProbe()],
		"moon-query": ["bash", "-c", moonQueryProbe(argv)],
		"live-graph-oracle": ["bun", "run", "graph:check", "--query"],
		"rendered-graph": [
			"bun",
			COLLECTOR,
			"probe-render-graph",
			"--workspace",
			renderWorkspacePath(runId),
		],
		"live-gate": [
			"bash",
			"-c",
			liveGateProbe(name, Number(gate["runId"] ?? 0), context),
		],
		"rollback-proof": [
			"bun",
			COLLECTOR,
			"probe-rollback",
			"--base",
			String(source["baseSha"] ?? ""),
			"--implementation",
			String(source["implementationSha"] ?? ""),
			"--workspace",
			rollbackWorkspacePath(runId),
		],
	};
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

// The graph job's DISPLAY name, which is what a run reports and therefore the
// only name the live evidence can be matched on.
function graphJobName(source: string): string | undefined {
	try {
		const value = Bun.YAML.parse(source) as JsonRecord;
		const job = recordAt(recordAt(value, "jobs"), GRAPH_JOB_ID);
		return typeof job["name"] === "string" ? job["name"] : undefined;
	} catch {
		return undefined;
	}
}

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

export async function validateStageEightAEvidenceValue(
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
	const expected = expectedStageEightACommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_EIGHT_A_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 8A command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 8A command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageEightACommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 8A command is expected to pass. There is no refusal in this
		// stage, so a non-zero exit is a failed capture rather than a proof.
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

	// Ancestry. Evidence-only commits may follow the implementation boundary, but
	// it has to stay reachable from HEAD, which is what forbids rebasing or
	// amending the branch after a capture.
	const baseSha = String(source["baseSha"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	if (
		git(root, ["merge-base", "--is-ancestor", baseSha, implementationSha])
			.exitCode !== 0
	)
		errors.push(
			"repository: the base commit is not an ancestor of the boundary",
		);
	if (
		git(root, ["merge-base", "--is-ancestor", implementationSha, "HEAD"])
			.exitCode !== 0
	)
		errors.push(
			"repository: the implementation boundary is not an ancestor of HEAD",
		);

	// The committed workflow is the only live thing this validator reads, and it
	// is read as a file in the tree rather than as a property of the machine.
	const workflow = await Bun.file(resolve(root, WORKFLOW_PATH))
		.text()
		.catch(() => "");
	const context = aggregateGateContext(workflow);
	const declaredNeeds = gateNeeds(workflow);
	// Anchored on the record's own list, for the reason Stage 7 had to be
	// repaired for: what a sealed run proves is a fact about the gate it ran
	// against, and re-resolving it against a workflow that has since grown turns
	// a true historical capture into a reported fabrication. Whether the gate is
	// complete TODAY belongs to the workflow contract, which requires it to
	// depend on every job in its file. Losing a sealed lane is still rejected.
	const sealedNeeds = arrayAt(repository, "gateNeeds").map(String);
	if (
		repository["workflowFile"] !== WORKFLOW_PATH ||
		repository["gateJobId"] !== DEFAULT_AGGREGATE_GATE_NAME ||
		repository["graphJobId"] !== GRAPH_JOB_ID ||
		repository["registryPath"] !== REGISTRY_PATH ||
		repository["capability"] !== CAPABILITY ||
		context === undefined ||
		repository["gateContext"] !== context ||
		repository["graphJobName"] !== graphJobName(workflow) ||
		typeof repository["graphJobName"] !== "string" ||
		!sealedNeeds.includes(GRAPH_JOB_ID) ||
		sealedNeeds.some((need) => !declaredNeeds.includes(need)) ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// The toolchain, bound to itself: the version the binary reported, the pin
	// the manifest carried at capture time, and the version the record claims are
	// one value or the record is describing a run it did not observe.
	const host = recordAt(value, "host");
	const toolchain = values("moon-toolchain");
	if (
		host["moonVersion"] !== toolchain["moonVersion"] ||
		source["prototoolsMoon"] !== toolchain["prototoolsMoon"] ||
		host["moonVersion"] !== source["prototoolsMoon"] ||
		host["bunVersion"] !== toolchain["bunVersion"] ||
		host["insideDevcontainer"] !== true
	)
		errors.push("semantic: Stage 8A toolchain evidence drifted");

	// The graph itself. `projects` and `edges` are compared against what moon
	// printed, not against what this checkout would derive today.
	const graph = recordAt(value, "graph");
	const query = values("moon-query");
	const argv = arrayAt(graph, "queryArgv").map(String);
	const projects = arrayAt(graph, "projects").flatMap((entry) =>
		isRecord(entry) ? [`${entry["id"]}=${entry["source"]}`] : [],
	);
	const edges = arrayAt(graph, "edges").flatMap((entry) =>
		isRecord(entry) ? [`${entry["from"]}->${entry["to"]}`] : [],
	);
	if (
		graph["commandId"] !== "moon-query" ||
		graph["oracleCommandId"] !== "live-graph-oracle" ||
		argv.length === 0 ||
		argv[0] !== "query" ||
		// The pinned argv is only pinned if the recorded invocation used it.
		!String(expected["moon-query"][2] ?? "").includes(
			`moon ${argv.join(" ")}`,
		) ||
		projects.sort().join(",") !== String(query["projects"] ?? "") ||
		edges.sort().join(",") !== String(query["edges"] ?? "") ||
		projects.length === 0 ||
		// The live leg's own summary, quoted from the log it came out of.
		!log("live-graph-oracle", "stdout").includes(
			String(graph["oracleSummary"] ?? " "),
		) ||
		!String(graph["oracleSummary"] ?? "").includes(
			"moon's own view of the graph",
		)
	)
		errors.push("semantic: Stage 8A graph evidence drifted");
	// The query has to have been the shape the guard expects, not merely exit
	// zero: an empty or reshaped payload is the failure the oracle fails closed
	// on, and a record must not be able to claim it passed one.
	const queryDocument = parseJson(query["queryJson"]);
	const queryProjects = Array.isArray(queryDocument["projects"])
		? queryDocument["projects"]
		: [];
	if (queryProjects.length !== arrayAt(graph, "projects").length)
		errors.push("semantic: Stage 8A graph evidence drifted");

	// The registry, checked against the graph the same record seals: every
	// project in exactly one universe, which is the whole rule.
	const registry = recordAt(value, "registry");
	const universes = arrayAt(registry, "universes").filter(isRecord);
	const membership = new Map<string, number>();
	for (const universe of universes)
		for (const project of arrayAt(universe, "projects").map(String))
			membership.set(project, (membership.get(project) ?? 0) + 1);
	const graphIds = arrayAt(graph, "projects").flatMap((entry) =>
		isRecord(entry) ? [String(entry["id"])] : [],
	);
	if (
		registry["path"] !== REGISTRY_PATH ||
		universes.length === 0 ||
		graphIds.some((id) => membership.get(id) !== 1) ||
		[...membership.keys()].some((id) => !graphIds.includes(id))
	)
		errors.push("semantic: Stage 8A universe registry evidence drifted");

	// Capability isolation, per fixture. A project without the capability
	// receives no registry, no guard, no package script, and no gating job — and
	// a project with it receives all four.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-graph" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_EIGHT_A_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-graph", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 8A render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_EIGHT_A_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const jobs = arrayAt(fixture, "jobs").map(String);
		const needs = arrayAt(fixture, "gateNeeds").map(String);
		const guards = arrayAt(fixture, "guardPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			fixture["registryPresent"] !== enabled ||
			jobs.includes(GRAPH_JOB_ID) !== enabled ||
			needs.includes(GRAPH_JOB_ID) !== enabled ||
			guards.length > 0 !== enabled ||
			scripts.includes("graph:check") !== enabled ||
			arrayAt(fixture, "workflowErrors").length > 0 ||
			// Every render's gate keeps at least one dependency: fencing a needs
			// list into emptiness produces a gate that reports success on a run in
			// which nothing happened.
			needs.length < 2
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} graph evidence drifted`,
			);
	}

	// The live run. A green four-job gate at the reviewed boundary is the only
	// thing in this record that says the graph oracle can gate at all.
	const live = recordAt(value, "live");
	const gate = recordAt(live, "gate");
	const gateValues = values("live-gate");
	const document = parseJson(gateValues["runJson"]);
	const runJobs = (
		Array.isArray(document["jobs"]) ? document["jobs"] : []
	).flatMap((entry) =>
		isRecord(entry)
			? [
					{
						name: String(entry["name"] ?? ""),
						conclusion: String(entry["conclusion"] ?? ""),
					},
				]
			: [],
	);
	const others = runJobs.filter((job) => job.name !== context);
	const gateJob = runJobs.find((job) => job.name === context);
	if (
		gate["commandId"] !== "live-gate" ||
		gate["runId"] !== document["databaseId"] ||
		gate["headSha"] !== document["headSha"] ||
		gate["headSha"] !== implementationSha ||
		gate["event"] !== document["event"] ||
		gate["conclusion"] !== "success" ||
		document["conclusion"] !== "success" ||
		document["workflowName"] !== "CI" ||
		gate["gateConclusion"] !== gateJob?.conclusion ||
		gate["gateConclusion"] !== "success" ||
		gate["gateJobId"] !== Number(gateValues["gateJobId"] ?? -1) ||
		gate["gateLogSha256"] !== gateValues["gateLogSha256"] ||
		gate["upstreamResults"] !== gateValues["upstreamResults"] ||
		gate["upstreamResults"] !== sealedNeeds.map(() => "success").join(",") ||
		others.some((job) => job.conclusion !== "success") ||
		// The graph oracle is not merely present in the file: it reported into
		// this run, by its display name.
		!others.some((job) => job.name === repository["graphJobName"]) ||
		!sameValue(gate["jobs"], others) ||
		others.length !== sealedNeeds.length ||
		Number(gateValues["gateGreenLines"] ?? 0) < 1
	)
		errors.push("semantic: live gate run evidence drifted");

	// The coverage map, kept honest: a category is backed by commands in this
	// record or it is not in the map at all.
	const coverage = arrayAt(value, "coverage").filter(isRecord);
	if (
		!sameValue(
			coverage.map((entry) => entry["id"]),
			[...STAGE_EIGHT_A_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 8A coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_EIGHT_A_COMMAND_IDS as readonly string[]).includes(id),
			)
		)
			errors.push(`semantic: coverage ${entry["id"]} is not reasoned`);
	}

	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-8a-pr-merge-commit>",
		]) ||
		!sameValue(rollback["outsideTheTree"], []) ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild")
	)
		errors.push("semantic: Stage 8A rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 8A rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageEightAEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-8a-moon-graph.json");
	const schemaPath = resolve(root, "evidence/stage-8a-moon-graph.schema.json");
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-8a-moon-graph.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return ["repository: evidence/stage-8a-moon-graph.schema.json is missing"];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-8a-moon-graph.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageEightAEvidenceValue(value, schema, root);
}
