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

export const STAGE_NINE_COMMAND_IDS = [
	// The two guards this stage adds.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log. The aggregate is covered by the required CI lane,
	// which runs it, and by the committed evidence suite.
	"openspec-guard",
	"rules-guard",
	// The mutation suites. `archive-refusals` is the whole refusal matrix and
	// `vendor-artifact-regeneration` is the generated-artifact drift suite.
	"archive-refusals",
	"vendor-artifact-regeneration",
	// The two probes that answer questions no committed test can seal: what one
	// real lifecycle actually did, and what each fixture actually received.
	"disposable-lifecycle",
	"rendered-fixture-artifacts",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageNineCommandId = (typeof STAGE_NINE_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-9-openspec-run";
const COLLECTOR = "scripts/template/collect-stage-nine-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CAPABILITY = "openspec";
const ARCHIVE_WRAPPER = "scripts/openspec/archive.sh";
const OPENSPEC_GUARD_SCRIPT = "openspec:check";
const RULES_GUARD_SCRIPT = "rules:check";
const OPENSPEC_MUTATION_TEST = "scripts/template/__tests__/openspec.test.ts";
const AGENT_RULES_MUTATION_TEST =
	"scripts/template/__tests__/agent-rules.test.ts";

// The Stage 8B merge on main, which is this stage's predecessor and the tree the
// rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_EIGHT_B_MERGE_SHA =
	"e4c6cfcee92b3cd4ced47b6641afb728430bf66b";

// The paths this stage adds. A revert has to take every one of them back out,
// which is the additive half of the rollback proof: the reverted tree carries
// none of them and the implementation tree carries all of them.
export const ADDED_PATHS = [
	"scripts/openspec/archive.sh",
	"scripts/template/agent-rules-contract.ts",
	"scripts/template/agent-rules/archive-delegation.md",
	"scripts/template/openspec-contract.ts",
	"scripts/template/sync-agent-rules.ts",
	"scripts/template/validate-agent-rules.ts",
	"scripts/template/validate-openspec.ts",
] as const;

// The openspec-gated subset of this stage's paths: what a project WITHOUT the
// capability must receive none of. The three cross-agent rule modules are
// deliberately absent from this list — they are core, because every project has
// agent rule files whatever else it disables.
export const GATED_PATHS = [
	"openspec/config.yaml",
	"scripts/openspec/archive.sh",
	"scripts/template/agent-rules/archive-delegation.md",
	"scripts/template/openspec-contract.ts",
	"scripts/template/validate-openspec.ts",
] as const;

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"openspec-guard": ["bun", "run", OPENSPEC_GUARD_SCRIPT],
	"rules-guard": ["bun", "run", RULES_GUARD_SCRIPT],
} as const;

export const VALIDATION_LOG_NAMES = Object.keys(REQUIRED_VALIDATIONS).flatMap(
	(id) => [`${id}.stdout`, `${id}.stderr`],
);

// The fourteen generated Claude artifacts and the two whose body this
// repository replaces. Sealed here so a record cannot claim the vendor surface
// is owned while the surface has quietly changed shape.
export const GENERATED_ARTIFACT_COUNT = 14;
export const REPLACED_ARTIFACTS = [
	".claude/commands/opsx/archive.md",
	".claude/skills/openspec-archive-change/SKILL.md",
] as const;

// The vendor archive procedure, assembled so this module is not itself a match
// for the scan it describes.
export const FORBIDDEN_VENDOR_PROCEDURE = ["mv", "openspec/changes"].join(" ");

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are the sentences the wrapper prints when it refuses, and the record may
 * claim the archive path is guarded only while every one of them is still
 * asserted by a committed test. A suite that lost a case would otherwise keep
 * passing and keep being cited.
 */
export const REQUIRED_MUTATIONS = [
	"a Codex Cloud task must not archive",
	"run this on the host, not inside the development container",
	"container is not ready; run bash scripts/worktree/up.sh",
	"archive runs on main only; this checkout is on feat/probe",
	"the working tree is not clean",
	"git restore graphify-out",
	"origin/main does not exist in this clone",
	"HEAD is behind origin/main; run `git pull --ff-only`",
	"HEAD is ahead of origin/main",
	"HEAD and origin/main have diverged",
	"pass --change <name> to say which one",
	"no active change named not-a-change",
	"is not an OpenSpec root in this checkout",
	"the CLI exited 0 but",
	"is still there; nothing was archived",
	"which is outside openspec",
	"openspec:check failed on the archived tree",
	"commitlint caps the header at 72",
	"the push was rejected",
	"already exists; the CLI would rewrite the main specs and archive nothing",
] as const;

// The two committed suites this record cites, and the file each one is. A
// coverage claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "archive-refusals", testFile: OPENSPEC_MUTATION_TEST },
	{
		commandId: "vendor-artifact-regeneration",
		testFile: AGENT_RULES_MUTATION_TEST,
	},
] as const;

/**
 * What the one live cycle must be observed to show.
 *
 * STANDING DECISION — do NOT retarget this at a later run. The sealed run is a
 * fact about the tree at `implementationSha`: it is the capture that says the
 * required gate went green with this stage's two new steps in the lane. Pointing
 * it at a newer, greener run because the old one aged out of the log retention
 * would replace an observation with an assertion, and the record would then be
 * describing a run nobody looked at. If the capture must be redone, redo it
 * against the same boundary or move the boundary deliberately.
 *
 * `heavyLaneRan` is true because the affected selector is live in `moon` mode
 * and every commit in this stage changes code: the only project here is the
 * root, whose source is the whole repository, so a code change cannot exclude
 * anything and the selection is FULL by construction.
 */
export const EXPECTED_OBSERVATIONS = [
	{
		id: "live-gate",
		conclusion: "success",
		event: "pull_request",
		heavyLaneRan: true,
	},
] as const;

export type StageNineObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

export const STAGE_NINE_FIXTURES = [
	{ name: "minimal", capabilityEnabled: true },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_NINE_COVERAGE_IDS = [
	"multi-root-validation",
	"anti-vacuity",
	"archive-refusals",
	"archive-publication",
	"canonical-rules",
	"generated-artifacts",
	"capability-isolation",
	"rollback",
] as const;

// Compact one-line JSON, so a whole run description can travel as one recorded
// value in a key=value log.
const COMPACT_JSON =
	'python3 -c \'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True, separators=(",", ":")))\'';

const RUN_FIELDS =
	"conclusion,createdAt,databaseId,event,headBranch,headSha,jobs,status,url,workflowName";

export function lifecycleWorkspacePath(runId: string): string {
	return `/tmp/devenv-${runId}-lifecycle`;
}

export function renderWorkspacePath(runId: string): string {
	return `/tmp/devenv-${runId}-render`;
}

// The shared rollback prober only accepts a temporary workspace whose first path
// segment names its own stage, so this one keeps that prefix.
export function rollbackWorkspacePath(runId: string): string {
	return `/tmp/devenv-stage2-${runId}-rollback`;
}

/**
 * One live run reduced to what the assertions below need.
 *
 * The gate's log carries the verdict AND the joined upstream results, which is
 * what lets the record check that every sealed dependency reported rather than
 * that the gate merely said it was happy.
 */
function liveGateProbe(
	repository: string,
	runId: number,
	gateContext: string,
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
	].join("\n");
}

/**
 * The exact command every recorded id must have run, derived from the record's
 * own context. A record cannot describe a command it did not issue, and it
 * cannot quietly widen one either.
 */
export function expectedStageNineCommands(
	value: JsonRecord,
): Record<StageNineCommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const live = recordAt(value, "live");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const gate = String(repository["gateContext"] ?? "");
	return {
		"openspec-guard": [...REQUIRED_VALIDATIONS["openspec-guard"]],
		"rules-guard": [...REQUIRED_VALIDATIONS["rules-guard"]],
		"archive-refusals": ["bun", "test", OPENSPEC_MUTATION_TEST],
		"vendor-artifact-regeneration": ["bun", "test", AGENT_RULES_MUTATION_TEST],
		"disposable-lifecycle": [
			"bun",
			COLLECTOR,
			"probe-lifecycle",
			"--workspace",
			lifecycleWorkspacePath(runId),
		],
		"rendered-fixture-artifacts": [
			"bun",
			COLLECTOR,
			"probe-render-openspec",
			"--workspace",
			renderWorkspacePath(runId),
		],
		"live-gate": [
			"bash",
			"-c",
			liveGateProbe(
				name,
				Number(recordAt(recordAt(live, "live-gate"), "run")["runId"] ?? 0),
				gate,
			),
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

// The steps this stage adds to the required lane, read from the committed
// workflow rather than restated. `openspec:check` is fenced and `rules:check` is
// not, and both are unconditional — a step with an `if:` is a step a selection
// can turn off.
function requiredLaneSteps(source: string): Array<{
	run: string;
	conditional: boolean;
}> {
	try {
		const value = Bun.YAML.parse(source) as JsonRecord;
		const job = recordAt(recordAt(value, "jobs"), "ci");
		return arrayAt(job, "steps")
			.filter(isRecord)
			.filter((step) => typeof step["run"] === "string")
			.map((step) => ({
				run: String(step["run"]),
				conditional: step["if"] !== undefined,
			}));
	} catch {
		return [];
	}
}

export async function validateStageNineEvidenceValue(
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
	const expected = expectedStageNineCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_NINE_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 9 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 9 command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageNineCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 9 capture command is expected to pass. The refusals are
		// proved by the mutation suite, which passes BY observing them — so a
		// non-zero exit here is a failed capture rather than a proof.
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
	// Every declared validation log has to be one of the logs this record bound.
	for (const name of VALIDATION_LOG_NAMES) {
		if (!logs.has(name.replace(/\.(stdout|stderr)$/, ".$1")))
			errors.push(`repository: validation log ${name} is not bound`);
	}

	// Ancestry. Evidence-only commits may follow the implementation boundary, but
	// it has to stay reachable from HEAD, which is what forbids rebasing or
	// amending the branch after a capture.
	const baseSha = String(source["baseSha"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	if (baseSha !== STAGE_EIGHT_B_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 8B merge");
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
		repository["capability"] !== CAPABILITY ||
		repository["archiveWrapper"] !== ARCHIVE_WRAPPER ||
		repository["openspecGuardScript"] !== OPENSPEC_GUARD_SCRIPT ||
		repository["rulesGuardScript"] !== RULES_GUARD_SCRIPT ||
		context === undefined ||
		repository["gateContext"] !== context ||
		sealedNeeds.some((need) => !declaredNeeds.includes(need)) ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// Both new steps are in the required lane and neither is conditional. This is
	// the assertion that would fail if anyone moved `openspec:check` into a lane
	// a selection can narrow — `openspec/**` classifies as documentation, so such
	// a step would be skipped by exactly the pull requests that change a change.
	const steps = requiredLaneSteps(workflow);
	for (const script of [OPENSPEC_GUARD_SCRIPT, RULES_GUARD_SCRIPT]) {
		const step = steps.find((entry) => entry.run.includes(`bun run ${script}`));
		if (!step || step.conditional)
			errors.push(
				`semantic: ${script} is not an unconditional step of the required lane`,
			);
	}

	// The refusal matrix. A record may claim the archive path is guarded only
	// while every recorded diagnostic is still asserted by a committed test.
	const mutationSource = await Bun.file(resolve(root, OPENSPEC_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(
				`repository: ${OPENSPEC_MUTATION_TEST} no longer asserts ${verdict}`,
			);
	}

	// The two suites, and the counts they reported. A suite with zero passing
	// tests is a citation of nothing.
	const guards = recordAt(value, "guards");
	for (const declared of EXPECTED_MUTATION_TESTS) {
		const entry = Object.values(guards)
			.filter(isRecord)
			.find((candidate) => candidate["commandId"] === declared.commandId);
		if (
			!entry ||
			entry["testFile"] !== declared.testFile ||
			Number(entry["passCount"] ?? 0) < 1 ||
			entry["failCount"] !== 0
		)
			errors.push(`semantic: mutation suite ${declared.commandId} drifted`);
	}
	for (const [key, id, script] of [
		["openspec", "openspec-guard", OPENSPEC_GUARD_SCRIPT],
		["rules", "rules-guard", RULES_GUARD_SCRIPT],
	] as const) {
		const entry = recordAt(guards, key);
		if (
			entry["commandId"] !== id ||
			entry["command"] !== `bun run ${script}` ||
			String(entry["summary"] ?? "").length < 20 ||
			!log(id, "stdout").includes(String(entry["summary"] ?? " "))
		)
			errors.push(`semantic: guard ${key} evidence drifted`);
	}

	// The generated Claude artifacts. The record seals the shape of the surface;
	// the tree has to still match it, including the two whose body this
	// repository replaced and the vendor procedure that must appear nowhere.
	const artifacts = recordAt(value, "vendorArtifacts");
	const artifactPaths = arrayAt(artifacts, "artifacts").map(String);
	if (
		artifacts["commandId"] !== "vendor-artifact-regeneration" ||
		artifactPaths.length !== GENERATED_ARTIFACT_COUNT ||
		!sameValue(artifacts["replaced"], [...REPLACED_ARTIFACTS])
	)
		errors.push("semantic: Stage 9 generated-artifact evidence drifted");
	for (const path of artifactPaths) {
		const content = await Bun.file(resolve(root, path))
			.text()
			.catch(() => "");
		if (!content.includes(`bun run ${"rules:sync"}`))
			errors.push(`repository: ${path} lost its regeneration header`);
		if (content.includes(FORBIDDEN_VENDOR_PROCEDURE))
			errors.push(`repository: ${path} restored the vendor archive procedure`);
	}
	for (const path of REPLACED_ARTIFACTS) {
		const content = await Bun.file(resolve(root, path))
			.text()
			.catch(() => "");
		if (!content.includes(`bash ${ARCHIVE_WRAPPER} --change`))
			errors.push(`repository: ${path} no longer delegates to the wrapper`);
	}

	// One real lifecycle, in a throwaway clone with its own bare origin. The two
	// halves that matter are that the delta spec reached the MAIN specs and that
	// the second, unfinished change was not touched.
	const lifecycle = recordAt(value, "lifecycle");
	if (
		lifecycle["commandId"] !== "disposable-lifecycle" ||
		!sameValue(
			lifecycle["result"],
			parseJson(log("disposable-lifecycle", "stdout"))["result"],
		)
	)
		errors.push("semantic: Stage 9 lifecycle evidence drifted");
	const result = recordAt(lifecycle, "result");
	if (
		result["archiveExitCode"] !== 0 ||
		result["activeDirectoryRemoved"] !== true ||
		result["archiveEntryPresent"] !== true ||
		result["mainSpecRequirementApplied"] !== true ||
		result["secondChangeUntouched"] !== true ||
		result["commitSubject"] !==
			`chore(openspec): archive ${String(result["change"] ?? "")}` ||
		result["originAdvanced"] !== true ||
		result["stagedOutsideRoot"] !== 0 ||
		// The second run is the duplicate-destination refusal, which is the one
		// the CLI reports as a success.
		result["secondRunExitCode"] !== 8 ||
		result["secondRunTouchedTree"] !== false ||
		// And the real change in THIS repository was never a participant.
		result["templateChangeStillActive"] !== true
	)
		errors.push("semantic: Stage 9 lifecycle proof is not complete");

	// Capability isolation, per fixture.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-fixture-artifacts" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_NINE_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-fixture-artifacts", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 9 render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_NINE_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			gated.length > 0 !== enabled ||
			(enabled && !sameValue(gated, [...GATED_PATHS])) ||
			scripts.includes(OPENSPEC_GUARD_SCRIPT) !== enabled ||
			// The canonical-rules surface is CORE: every project gets both scripts
			// and the ungated step, whatever else it disables.
			!scripts.includes(RULES_GUARD_SCRIPT) ||
			!scripts.includes("rules:sync") ||
			fixture["openspecStepPresent"] !== enabled ||
			fixture["rulesStepPresent"] !== true ||
			fixture["generatedArtifactCount"] !==
				(enabled ? GENERATED_ARTIFACT_COUNT : 0) ||
			fixture["lifecycleProsePresent"] !== enabled ||
			// The mirrors lose the canonical block and their generated regions
			// together, which is what lets `rules:check` stay ungated.
			arrayAt(fixture, "ruleErrors").length > 0 ||
			arrayAt(fixture, "residueFindings").length > 0
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} lifecycle evidence drifted`,
			);
	}

	// The live cycle.
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
		const upstream = String(gateValues["upstreamResults"] ?? "").split(",");
		if (
			cycle["commandId"] !== observation.id ||
			gate["runId"] !== document["databaseId"] ||
			gate["headSha"] !== document["headSha"] ||
			// The capture is a fact about the reviewed boundary and nothing else.
			gate["headSha"] !== implementationSha ||
			gate["event"] !== document["event"] ||
			gate["event"] !== observation.event ||
			gate["conclusion"] !== observation.conclusion ||
			document["conclusion"] !== observation.conclusion ||
			document["workflowName"] !== "CI" ||
			gate["gateConclusion"] !== gateJob?.conclusion ||
			gate["gateConclusion"] !== "success" ||
			gate["gateJobId"] !== Number(gateValues["gateJobId"] ?? -1) ||
			gate["gateLogSha256"] !== gateValues["gateLogSha256"] ||
			gate["upstreamResults"] !== gateValues["upstreamResults"] ||
			!sameValue(gate["jobs"], others) ||
			Number(gateValues["gateGreenLines"] ?? 0) < 1 ||
			// One result per sealed dependency, and every one of them either
			// passed or was deliberately skipped.
			upstream.length !== sealedNeeds.length ||
			upstream.some((result) => result !== "success" && result !== "skipped") ||
			// The heavy lane ran: a code change cannot be narrowed away here.
			cycle["heavyLaneRan"] !== observation.heavyLaneRan ||
			others.filter((job) => job.conclusion === "success").length !==
				others.length
		)
			errors.push(`semantic: live ${observation.id} evidence drifted`);
	}

	// The coverage map, kept honest: a category is backed by commands in this
	// record or it is not in the map at all.
	const coverage = arrayAt(value, "coverage").filter(isRecord);
	if (
		!sameValue(
			coverage.map((entry) => entry["id"]),
			[...STAGE_NINE_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 9 coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_NINE_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-9-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable,
		// no branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild") ||
		!String(rollback["scope"] ?? "").includes("stays ACTIVE")
	)
		errors.push("semantic: Stage 9 rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 9 rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageNineEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-9-openspec.json");
	const schemaPath = resolve(root, "evidence/stage-9-openspec.schema.json");
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-9-openspec.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return ["repository: evidence/stage-9-openspec.schema.json is missing"];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-9-openspec.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageNineEvidenceValue(value, schema, root);
}
