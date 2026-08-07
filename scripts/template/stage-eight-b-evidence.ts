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

export const STAGE_EIGHT_B_COMMAND_IDS = [
	"affected-guard",
	"affected-mutations",
	"ci-guard",
	"workflow-policy-mutations",
	// The three commands that need the real toolchain, and the reason this
	// capture runs inside the devcontainer: moon is image-owned, and the host has
	// neither moon nor proto.
	"moon-toolchain",
	"moon-affected-query",
	"selector-live",
	"rendered-affected",
	// The three live cycles. They are the only things in this record that this
	// repository cannot fabricate, and the third is the only one that proves the
	// capability does anything at all.
	"live-gate-full",
	"live-gate-moon",
	"live-gate-docs",
	"rollback-proof",
] as const;

export type StageEightBCommandId = (typeof STAGE_EIGHT_B_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-8b-affected-selection-run";
const COLLECTOR = "scripts/template/collect-stage-eight-b-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const SELECTOR_JOB_ID = "affected";
const PROJECT_JOB_ID = "project";
const CAPABILITY = "moon_affected_selection";
const MUTATION_TEST = "scripts/template/__tests__/affected.test.ts";

// The Stage 8A merge on main, which is this stage's predecessor and the tree the
// rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_EIGHT_A_MERGE_SHA =
	"70b3690ec038088db03b66c57e5d4d3e72710f0b";

// The paths this stage adds. A revert has to take every one of them back out,
// which is the additive half of the rollback proof: the reverted tree carries
// none of them and the implementation tree carries all of them.
export const ADDED_PATHS = [
	"scripts/ci/affected-matrices.sh",
	"scripts/template/affected-contract.ts",
	"scripts/template/select-affected.ts",
	"scripts/template/validate-affected.ts",
] as const;

// The three fixtures and what each one must show. `minimal` and `cloud` disable
// the capability, so the whole selection surface has to be absent from them —
// but the two JOBS are core, because fencing them would leave such a project
// with no lint, no compiler and no suite at all.
export const STAGE_EIGHT_B_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_EIGHT_B_COVERAGE_IDS = [
	"derived-selection",
	"fail-open",
	"fail-closed",
	"moon-reconciliation",
	"capability-isolation",
	"heavy-lane-gating",
	"mode-switch",
	"rollback",
] as const;

// The verdicts the committed mutation suite has to be able to produce. A record
// may claim the selection contract is guarded only while every one of these
// strings is still asserted by a committed test — a suite that lost a case would
// otherwise keep passing and keep being cited.
export const REQUIRED_MUTATIONS = [
	"affected: .github/workflows/ci.yml defaults MOON_AFFECTED_MODE to moon, which is not the recorded full",
	"affected: .github/workflows/ci.yml must default MOON_AFFECTED_MODE to a quoted literal",
	"affected: .github/workflows/ci.yml declares the mode but runs no selector",
	"affected: package script affected:check must expose the dedicated selection guard",
	"affected: package script affected:select must expose the committed selector",
	"affected: a workflow must run affected:check",
	"affected: template ownership must cover scripts/template/select-affected.ts",
	"affected: scripts/ci/affected-matrices.sh must be gated by the capability",
] as const;

/**
 * What each live cycle must be observed to show.
 *
 * The three are one argument. The first proves the shadow phase exists while the
 * variable is unset; the second proves the flip is live and that a code change
 * still runs everything; the third is the only one that proves the capability
 * DOES anything — an empty matrix, a skipped heavy lane, and a green gate.
 *
 * `reason` is sealed as the code the selector actually emitted, not as an
 * aspiration. In this repository every code change is FULL by construction: the
 * only project is the root, whose source is the whole repository, and a change
 * it owns cannot exclude anything.
 */
export const EXPECTED_OBSERVATIONS = [
	{
		id: "live-gate-full",
		mode: "full",
		reason: "mode-not-selecting",
		shadowNarration: true,
		heavyLaneRan: true,
	},
	{
		id: "live-gate-moon",
		mode: "full",
		reason: "global-input",
		shadowNarration: false,
		heavyLaneRan: true,
	},
	{
		id: "live-gate-docs",
		mode: "narrow",
		reason: "affected",
		shadowNarration: false,
		heavyLaneRan: false,
	},
] as const;

export type StageEightBObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

// Compact one-line JSON, so a whole run description can travel as one recorded
// value in a key=value log.
const COMPACT_JSON =
	'python3 -c \'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))\'';

const RUN_FIELDS =
	"conclusion,createdAt,databaseId,event,headBranch,headSha,jobs,status,url,workflowName";

export function moonWorkspacePath(runId: string): string {
	return `/tmp/devenv-${runId}-moon`;
}

export function selectorWorkspacePath(runId: string): string {
	return `/tmp/devenv-${runId}-selector`;
}

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

/**
 * One live run reduced to what every assertion below needs.
 *
 * Two logs are read, not one. The gate's log carries the verdict; the SELECTOR's
 * log carries the sentence that says which selection was made and whether the
 * shadow narration was printed — and a record that only sealed the gate could
 * not tell a narrow cycle from a full one.
 */
function liveGateProbe(
	repository: string,
	runId: number,
	gateContext: string,
	selectorContext: string,
): string {
	const jobIdOf =
		'python3 -c \'import json,sys; jobs=[job["databaseId"] for job in json.load(sys.stdin)["jobs"] if job["name"] == sys.argv[1]]; print(jobs[0] if jobs else "")\'';
	return [
		"set -euo pipefail",
		`run="$(gh run view ${runId} --repo ${repository} --json ${RUN_FIELDS})"`,
		`printf 'runJson=%s\\n' "$(printf '%s' "$run" | ${COMPACT_JSON})"`,
		`gate="$(printf '%s' "$run" | ${jobIdOf} ${JSON.stringify(gateContext)})"`,
		"printf 'gateJobId=%s\\n' \"$gate\"",
		`log="$(gh run view --repo ${repository} --job "$gate" --log)"`,
		"printf 'gateLogSha256=%s\\n' \"$(printf '%s' \"$log\" | shasum -a 256 | awk '{ print $1 }')\"",
		"printf 'upstreamResults=%s\\n' \"$(printf '%s\\n' \"$log\" | sed -n 's/.*upstream results: //p' | head -n 1)\"",
		"printf 'gateGreenLines=%s\\n' \"$(printf '%s\\n' \"$log\" | grep -c 'Every required job passed or was skipped' || true)\"",
		`selector="$(printf '%s' "$run" | ${jobIdOf} ${JSON.stringify(selectorContext)})"`,
		"printf 'selectorJobId=%s\\n' \"$selector\"",
		`selectorLog="$(gh run view --repo ${repository} --job "$selector" --log)"`,
		"printf 'selectorLogSha256=%s\\n' \"$(printf '%s' \"$selectorLog\" | shasum -a 256 | awk '{ print $1 }')\"",
		"printf 'selectionLine=%s\\n' \"$(printf '%s\\n' \"$selectorLog\" | sed -n 's/.*\\(selection: [a-z]* ([a-z-]*)\\).*/\\1/p' | head -n 1)\"",
		"printf 'shadowLines=%s\\n' \"$(printf '%s\\n' \"$selectorLog\" | grep -c 'would have selected' || true)\"",
		"printf 'universeLine=%s\\n' \"$(printf '%s\\n' \"$selectorLog\" | sed -n 's/.*\\(ci = \\[[^]]*\\]\\).*/\\1/p' | head -n 1)\"",
	].join("\n");
}

/**
 * The exact command every recorded id must have run, derived from the record's
 * own context. A record cannot describe a command it did not issue, and it
 * cannot quietly widen one either.
 */
export function expectedStageEightBCommands(
	value: JsonRecord,
): Record<StageEightBCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const selection = recordAt(value, "selection");
	const live = recordAt(value, "live");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const gate = String(repository["gateContext"] ?? "");
	const selector = String(repository["selectorJobName"] ?? "");
	const argv = arrayAt(selection, "queryArgv").map(String);
	const cycle = (id: StageEightBObservationId): string[] => [
		"bash",
		"-c",
		liveGateProbe(
			name,
			Number(recordAt(recordAt(live, id), "run")["runId"] ?? 0),
			gate,
			selector,
		),
	];
	return {
		"affected-guard": ["bun", "run", "affected:check"],
		"affected-mutations": ["bun", "test", MUTATION_TEST],
		"ci-guard": ["bun", "run", "ci:check"],
		"workflow-policy-mutations": [
			"bun",
			"test",
			"scripts/template/__tests__/ci.test.ts",
		],
		"moon-toolchain": ["bash", "-c", moonToolchainProbe()],
		"moon-affected-query": [
			"bun",
			COLLECTOR,
			"probe-moon-affected",
			"--argv",
			argv.join(" "),
			"--workspace",
			moonWorkspacePath(runId),
		],
		"selector-live": [
			"bun",
			COLLECTOR,
			"probe-selector",
			"--workspace",
			selectorWorkspacePath(runId),
		],
		"rendered-affected": [
			"bun",
			COLLECTOR,
			"probe-render-affected",
			"--workspace",
			renderWorkspacePath(runId),
		],
		"live-gate-full": cycle("live-gate-full"),
		"live-gate-moon": cycle("live-gate-moon"),
		"live-gate-docs": cycle("live-gate-docs"),
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

// A job's DISPLAY name, which is what a run reports and therefore the only name
// the live evidence can be matched on.
function jobName(source: string, id: string): string | undefined {
	try {
		const value = Bun.YAML.parse(source) as JsonRecord;
		const job = recordAt(recordAt(value, "jobs"), id);
		return typeof job["name"] === "string" ? job["name"] : undefined;
	} catch {
		return undefined;
	}
}

function gateNeeds(source: string): string[] {
	try {
		const value = Bun.YAML.parse(source) as JsonRecord;
		const gate = recordAt(recordAt(value, "jobs"), DEFAULT_AGGREGATE_GATE_NAME);
		const needs = gate["needs"];
		if (typeof needs === "string") return [needs];
		return Array.isArray(needs)
			? needs.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

export async function validateStageEightBEvidenceValue(
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
	const expected = expectedStageEightBCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_EIGHT_B_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 8B command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 8B command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageEightBCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 8B command is expected to pass. There is no refusal in this
		// stage's capture, so a non-zero exit is a failed capture rather than a
		// proof — the refusals are proved by the mutation suite instead.
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
	if (baseSha !== STAGE_EIGHT_A_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 8A merge");
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
		repository["selectorJobId"] !== SELECTOR_JOB_ID ||
		repository["projectJobId"] !== PROJECT_JOB_ID ||
		repository["capability"] !== CAPABILITY ||
		context === undefined ||
		repository["gateContext"] !== context ||
		repository["selectorJobName"] !== jobName(workflow, SELECTOR_JOB_ID) ||
		repository["projectJobName"] !== jobName(workflow, PROJECT_JOB_ID) ||
		typeof repository["selectorJobName"] !== "string" ||
		typeof repository["projectJobName"] !== "string" ||
		!sealedNeeds.includes(SELECTOR_JOB_ID) ||
		!sealedNeeds.includes(PROJECT_JOB_ID) ||
		sealedNeeds.some((need) => !declaredNeeds.includes(need)) ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// The switch. The record seals the variable NAME and the in-tree default it
	// falls back to, and both have to be what the committed workflow says — the
	// value itself lives outside the tree by design, which is the whole reason
	// the rollback section below has a non-empty outsideTheTree.
	const modeVariable = String(repository["modeVariable"] ?? "");
	const initialMode = String(repository["initialMode"] ?? "");
	if (
		modeVariable === "" ||
		!workflow.includes(`${modeVariable}: `) ||
		!workflow.includes(`vars.${modeVariable} || '${initialMode}'`)
	)
		errors.push("semantic: recorded mode switch is not the committed one");

	// The mutation suite that backs every "this is guarded" claim in the coverage
	// map. A committed test that lost a case would otherwise keep passing and
	// keep being cited.
	const mutationSource = await Bun.file(resolve(root, MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(`repository: ${MUTATION_TEST} no longer asserts ${verdict}`);
	}

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
		errors.push("semantic: Stage 8B toolchain evidence drifted");

	// The affected query itself, against the real moon in a SYNTHETIC
	// multi-project workspace — this repository's graph is the root alone, so
	// `--downstream deep` is unobservable here and a capture over it would prove
	// nothing about the flag it pins.
	const selection = recordAt(value, "selection");
	const query = values("moon-affected-query");
	const argv = arrayAt(selection, "queryArgv").map(String);
	if (
		selection["commandId"] !== "moon-affected-query" ||
		argv.length === 0 ||
		argv[0] !== "query" ||
		!argv.includes("--affected") ||
		!argv.includes("deep") ||
		// The pinned argv is only pinned if the recorded invocation used it.
		!sameValue(expected["moon-affected-query"][4], argv.join(" ")) ||
		selection["leafProjects"] !== query["leafProjects"] ||
		selection["deepProjects"] !== query["deepProjects"] ||
		selection["emptyStdinProjects"] !== query["emptyStdinProjects"] ||
		selection["emptyStdinDirtyProjects"] !== query["emptyStdinDirtyProjects"] ||
		selection["jsonFlagExitCode"] !== Number(query["jsonFlagExitCode"] ?? -1) ||
		// A leaf reaches itself; the deepest library reaches its dependents. If
		// those were the same answer the flag would be doing nothing.
		String(selection["leafProjects"]) === String(selection["deepProjects"]) ||
		// The empty-stdin hazard, sealed in both directions: silence over a clean
		// tree, and the working tree's own edit over a dirty one. That is why the
		// selector guards on the file count instead of trusting the exit code.
		String(selection["emptyStdinProjects"]) !== "" ||
		String(selection["emptyStdinDirtyProjects"]) === "" ||
		// `--json` does not exist in moon 2.x's query family.
		selection["jsonFlagExitCode"] === 0
	)
		errors.push("semantic: Stage 8B moon affected-query evidence drifted");

	// The committed selector, end to end against that same real moon.
	const selector = recordAt(value, "selector");
	const selectorCases = arrayAt(selector, "cases").filter(isRecord);
	if (
		selector["commandId"] !== "selector-live" ||
		!sameValue(
			selector["cases"],
			parseJson(log("selector-live", "stdout"))["cases"],
		) ||
		selectorCases.length < 5
	)
		errors.push("semantic: Stage 8B selector evidence drifted");
	const byName = new Map(
		selectorCases.map((entry) => [String(entry["name"]), entry]),
	);
	for (const [name, mode, reason] of [
		["leaf", "narrow", "affected"],
		["deep", "narrow", "affected"],
		["docs", "narrow", "affected"],
		["global", "full", "global-input"],
		["mode-off", "full", "mode-not-selecting"],
	] as const) {
		const entry = byName.get(name);
		if (
			entry === undefined ||
			entry["mode"] !== mode ||
			entry["reason"] !== reason
		)
			errors.push(`semantic: selector case ${name} drifted`);
	}
	// The three that carry the argument. A leaf must not drag its siblings in, a
	// deep library must drag its dependents in, and documentation must select
	// NOTHING while still being a narrow answer rather than a full one.
	if (
		!sameValue(byName.get("leaf")?.["selected"], ["web"]) ||
		!sameValue(byName.get("deep")?.["selected"], ["base", "ui", "web"]) ||
		!sameValue(byName.get("docs")?.["selected"], []) ||
		byName.get("leaf")?.["moonConsulted"] !== true ||
		byName.get("deep")?.["moonConsulted"] !== true ||
		// Documentation never reaches moon: an empty file list would make it
		// answer from the working tree instead.
		byName.get("docs")?.["moonConsulted"] !== false
	)
		errors.push("semantic: Stage 8B selector evidence drifted");

	// Capability isolation, per fixture. A project without the capability
	// receives none of the four gated paths, neither package script, and no
	// mention of the mode variable — while still receiving both JOBS, because a
	// project whose heavy lane was fenced away would have no suite at all.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-affected" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_EIGHT_B_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-affected", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 8B render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_EIGHT_B_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const jobs = arrayAt(fixture, "jobs").map(String);
		const needs = arrayAt(fixture, "gateNeeds").map(String);
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			gated.length > 0 !== enabled ||
			(enabled && gated.length !== ADDED_PATHS.length) ||
			scripts.includes("affected:check") !== enabled ||
			scripts.includes("affected:select") !== enabled ||
			fixture["modeTokenPresent"] !== enabled ||
			fixture["selectorStepPresent"] !== enabled ||
			// Both jobs are CORE. This is the assertion that would fail if anyone
			// "tidied" the fences and left a project with no heavy lane.
			!jobs.includes(SELECTOR_JOB_ID) ||
			!jobs.includes(PROJECT_JOB_ID) ||
			!needs.includes(SELECTOR_JOB_ID) ||
			!needs.includes(PROJECT_JOB_ID) ||
			fixture["heavyLanePresent"] !== true ||
			arrayAt(fixture, "workflowErrors").length > 0 ||
			arrayAt(fixture, "contractErrors").length > 0 ||
			needs.length < 2
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} selection evidence drifted`,
			);
	}

	// The three live cycles.
	const live = recordAt(value, "live");
	for (const observation of EXPECTED_OBSERVATIONS) {
		const cycle = recordAt(live, observation.id);
		const gate = recordAt(cycle, "run");
		const gateValues = values(observation.id);
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
		const heavy = others.filter((job) =>
			job.name.startsWith(String(repository["projectJobName"])),
		);
		const upstream = String(gateValues["upstreamResults"] ?? "").split(",");
		if (
			cycle["commandId"] !== observation.id ||
			cycle["mode"] !== observation.mode ||
			cycle["reason"] !== observation.reason ||
			gate["runId"] !== document["databaseId"] ||
			gate["headSha"] !== document["headSha"] ||
			gate["event"] !== document["event"] ||
			gate["event"] !== "pull_request" ||
			gate["conclusion"] !== "success" ||
			document["conclusion"] !== "success" ||
			document["workflowName"] !== "CI" ||
			gate["gateConclusion"] !== gateJob?.conclusion ||
			gate["gateConclusion"] !== "success" ||
			gate["gateJobId"] !== Number(gateValues["gateJobId"] ?? -1) ||
			gate["gateLogSha256"] !== gateValues["gateLogSha256"] ||
			gate["selectorLogSha256"] !== gateValues["selectorLogSha256"] ||
			gate["upstreamResults"] !== gateValues["upstreamResults"] ||
			!sameValue(gate["jobs"], others) ||
			Number(gateValues["gateGreenLines"] ?? 0) < 1 ||
			// Every upstream lane either passed or was deliberately skipped, and
			// there is one result per sealed dependency.
			upstream.length !== sealedNeeds.length ||
			upstream.some((result) => result !== "success" && result !== "skipped") ||
			// The selection this cycle actually made, quoted from the selector's
			// own log rather than restated.
			cycle["selectionLine"] !== gateValues["selectionLine"] ||
			cycle["selectionLine"] !==
				`selection: ${observation.mode} (${observation.reason})` ||
			cycle["universeLine"] !== gateValues["universeLine"] ||
			// The shadow narration: present exactly while the mode variable is what
			// held the answer back, and absent once it is flipped.
			Number(gateValues["shadowLines"] ?? 0) > 0 !==
				observation.shadowNarration ||
			cycle["shadowNarration"] !== observation.shadowNarration ||
			// The heavy lane: it ran on a code change and was SKIPPED on the
			// documentation-only cycle. That skip is the only thing in this record
			// that proves the capability does anything at all.
			cycle["heavyLaneRan"] !== observation.heavyLaneRan ||
			heavy.length === 0 ||
			heavy.some((job) => job.conclusion === "failure") ||
			heavy.every((job) => job.conclusion === "success") !==
				observation.heavyLaneRan ||
			(!observation.heavyLaneRan &&
				heavy.some((job) => job.conclusion !== "skipped")) ||
			// ... and an empty matrix is what caused it.
			(observation.heavyLaneRan
				? cycle["universeLine"] === "ci = []"
				: cycle["universeLine"] !== "ci = []")
		)
			errors.push(`semantic: live ${observation.id} evidence drifted`);
	}
	// The first two cycles ran against the reviewed boundary itself; the third
	// could not, because a documentation-only diff needs a commit the boundary
	// does not contain. It is a stacked pull request whose BASE is the boundary,
	// which is the same shape the selector is designed for.
	const fullRun = recordAt(recordAt(live, "live-gate-full"), "run");
	const moonRun = recordAt(recordAt(live, "live-gate-moon"), "run");
	const docsRun = recordAt(recordAt(live, "live-gate-docs"), "run");
	if (
		fullRun["headSha"] !== implementationSha ||
		moonRun["headSha"] !== implementationSha ||
		docsRun["headSha"] === implementationSha ||
		docsRun["baseSha"] !== implementationSha ||
		// The flip is a repository-variable change and nothing else: the two
		// cycles that bracket it ran against the same tree.
		fullRun["headSha"] !== moonRun["headSha"] ||
		fullRun["runId"] === moonRun["runId"]
	)
		errors.push("semantic: the live cycles did not bracket the mode flip");

	// The coverage map, kept honest: a category is backed by commands in this
	// record or it is not in the map at all.
	const coverage = arrayAt(value, "coverage").filter(isRecord);
	if (
		!sameValue(
			coverage.map((entry) => entry["id"]),
			[...STAGE_EIGHT_B_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 8B coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_EIGHT_B_COMMAND_IDS as readonly string[]).includes(id),
			)
		)
			errors.push(`semantic: coverage ${entry["id"]} is not reasoned`);
	}

	const rollback = recordAt(value, "rollback");
	const outside = arrayAt(rollback, "outsideTheTree").map(String);
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-8b-pr-merge-commit>",
		]) ||
		// Unlike every stage before it, this one has something outside the tree.
		// A revert that leaves the variable set is harmless the moment the surface
		// is gone and live again the moment the stage is re-applied, so the order
		// is part of the record rather than part of the prose.
		outside.length !== 1 ||
		!outside[0]?.includes(modeVariable) ||
		!String(rollback["scope"] ?? "").includes(
			"flip or delete the repository variable",
		) ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild")
	)
		errors.push("semantic: Stage 8B rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 8B rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageEightBEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(
		root,
		"evidence/stage-8b-affected-selection.json",
	);
	const schemaPath = resolve(
		root,
		"evidence/stage-8b-affected-selection.schema.json",
	);
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-8b-affected-selection.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return [
			"repository: evidence/stage-8b-affected-selection.schema.json is missing",
		];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return [
			"repository: evidence/stage-8b-affected-selection.json is not JSON",
		];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageEightBEvidenceValue(value, schema, root);
}
