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

export const STAGE_TEN_A_COMMAND_IDS = [
	// The two guards this stage touches: the one it adds, and the core workflow
	// contract it extends with the delivery rule.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log. The aggregate is covered by the required CI lane,
	// which runs it, and by the committed evidence suite.
	"forms-guard",
	"ci-guard",
	// The whole refusal matrix, and then each leg on its own. The legs are not a
	// decomposition for tidiness: a suite-wide green says the file passed, and
	// what this record has to be able to say is that THIS rule was exercised.
	"forms-mutations",
	"browser-safety-matrix",
	"drift-gate",
	"evolution-gate",
	"parallel-types",
	"authz-seam",
	"form-bindings",
	// The probe that answers a question no committed test can seal: what each
	// fixture actually received.
	"rendered-forms",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageTenACommandId = (typeof STAGE_TEN_A_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-10a-api-contract-run";
const COLLECTOR = "scripts/template/collect-stage-ten-a-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CAPABILITY = "rhf_zod";
const FORMS_GUARD_SCRIPT = "forms:check";
const CI_GUARD_SCRIPT = "ci:check";
const FORMS_MUTATION_TEST = "scripts/template/__tests__/forms.test.ts";
const CI_MUTATION_TEST = "scripts/template/__tests__/ci.test.ts";
const REGISTRY_PATH = "api-contract.json";

// The declared tree state. It is sealed rather than read back out of the
// registry at validation time, because "the guard agreed with the registry" is
// a different claim from "the registry still says what it said when this
// evidence was captured" — and this record is making the second one.
export const DECLARED_MODE = "skeleton";

// The Stage 9 merge on main, which is this stage's predecessor and the tree the
// rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_NINE_MERGE_SHA = "f92960e51c3dc3056bbf2c89b860d5f6f5c672b4";

// The paths this stage adds and this capability owns. A revert has to take
// every one of them back out, which is the additive half of the rollback proof:
// the reverted tree carries none of them and the implementation tree carries all
// of them. The list is exactly the gated set, because those are the four files
// whose presence a project's capability decides.
export const ADDED_PATHS = [
	"api-contract.json",
	"api-contract.schema.json",
	"scripts/template/forms-contract.ts",
	"scripts/template/validate-forms.ts",
] as const;

// The reserved package root Stage 0 pre-declared for this capability. Nothing
// creates it, and the record says so on purpose: a reservation is where the
// artifact WOULD live, not a promise to create one.
export const RESERVED_SCHEMA_ROOT = "libs/forms";

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"forms-guard": ["bun", "run", FORMS_GUARD_SCRIPT],
	"ci-guard": ["bun", "run", CI_GUARD_SCRIPT],
} as const;

export const VALIDATION_LOG_NAMES = Object.keys(REQUIRED_VALIDATIONS).flatMap(
	(id) => [`${id}.stdout`, `${id}.stderr`],
);

/**
 * Each leg of the refusal matrix, and the test-name filter that runs it alone.
 *
 * A suite-wide green says the file passed. What a record has to be able to say
 * is that a NAMED rule was exercised, so each leg is captured as its own
 * command with its own log — and the filter is the test's own name, which means
 * a renamed or deleted test makes the capture fail rather than quietly cover
 * nothing.
 */
export const MUTATION_LEGS = {
	"browser-safety-matrix": "browser safe",
	"drift-gate": "generated artifacts that drift",
	"evolution-gate": "contract evolution that is not additive",
	"parallel-types": "second set of response types",
	"authz-seam": "inline authorization outside the declared policy seam",
	"form-bindings": "registers every form",
} as const;

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are the sentences the guard prints when it refuses, and the record may
 * claim the contract surface is guarded only while every one of them is still
 * asserted by a committed test. A suite that lost a case would otherwise keep
 * passing and keep being cited.
 */
export const REQUIRED_MUTATIONS = [
	// Mode reconciliation, both directions.
	"declares skeleton mode but libs/forms/src/index.ts lives under the reserved schema package root",
	"declares skeleton mode but apps/api/src/schemas.ts imports the shared schema library",
	"declares skeleton mode but apps/web/src/form.tsx binds a form resolver",
	"declares skeleton mode but libs/client/src/generated.ts opens with a generated-artifact banner",
	"declares active mode but no tracked file carries a shared schema surface",
	"declares skeleton mode but declares a contract surface",
	// Sole declarations, and the A11 refusal.
	"is a second api contract registry",
	"is a second validator for POST /orders",
	// Wiring.
	"package script forms:check must run scripts/template/validate-forms.ts",
	"must sit inside a rhf_zod capability fence",
	"step must not be conditional",
	// Ownership.
	"must be gated by the capability",
	"must leave the absent inventory",
	// Browser safety.
	"which resolves outside the schema package forms",
	"which the schema package forms does not allow",
	"contains no file to scan",
	"imports the shared schema library outside a declared schema package",
	// Drift and evolution.
	"is a stale generated artifact",
	"must open with its declared generated-artifact banner",
	"must exempt the generated",
	"strict-parses the response body of POST /orders 201",
	"removes the field POST /orders#201.note",
	"removes the operation GET /orders/{id}",
	"newly requires POST /orders#request.note",
	"narrows POST /orders#request.total from number to string",
	// Parallel response types, one per category.
	"INLINE_RESPONSE_SHAPE",
	"APP_LOCAL_RESPONSE_TYPE",
	"NON_CONTRACT_RESPONSE_TYPE",
	"WRONG_CONTRACT_RESPONSE_TYPE",
	"declares no operation; the parallel-type ban would cover nothing",
	// Inline authorization.
	"answers a caller-role branch with a refusal",
	"redeclares the seam denial message",
	"declares no denial message; the inline-authorization ban would derive an empty set",
	// Forms and server parsers.
	"binds a form resolver and is not declared in",
	"binds the field noet, which OrderForm does not declare",
	"declares no import of a shared schema package",
	"must answer a malformed body distinctly from a schema rejection",
	"declares no clientMapping; a server rejection nothing renders is a silent failure",
	"must set a root-level error for an issue that maps to no field",
	// Anti-vacuity.
	"the browser-safety scan read no file at all",
] as const;

// The core delivery rule this stage adds to the workflow contract. It is a
// negative requirement — no delivery job exists here — so the only place it can
// be observed is the mutation suite that adds one.
export const REQUIRED_CI_MUTATIONS = [
	"delivers and must depend on ci",
	"delivers from a workflow that declares no ci job to gate it",
] as const;

// The two committed suites this record cites, and the file each one is. A
// coverage claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "forms-mutations", testFile: FORMS_MUTATION_TEST },
	...Object.keys(MUTATION_LEGS).map((commandId) => ({
		commandId,
		testFile: FORMS_MUTATION_TEST,
	})),
] as const;

/**
 * What the one live cycle must be observed to show.
 *
 * STANDING DECISION — do NOT retarget this at a later run. The sealed run is a
 * fact about the tree at `implementationSha`: it is the capture that says the
 * required gate went green with this stage's new step in the lane. Pointing it
 * at a newer, greener run because the old one aged out of the log retention
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

export type StageTenAObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

export const STAGE_TEN_A_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_TEN_A_COVERAGE_IDS = [
	"declared-surface",
	"browser-safety",
	"generated-drift",
	"deployment-skew",
	"parallel-types",
	"inline-authorization",
	"forms-and-parsers",
	"delivery-gating",
	"capability-isolation",
	"rollback",
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
export function expectedStageTenACommands(
	value: JsonRecord,
): Record<StageTenACommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const live = recordAt(value, "live");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const gate = String(repository["gateContext"] ?? "");
	const legs = Object.fromEntries(
		Object.entries(MUTATION_LEGS).map(([id, pattern]) => [
			id,
			["bun", "test", FORMS_MUTATION_TEST, "-t", pattern],
		]),
	) as Record<keyof typeof MUTATION_LEGS, string[]>;
	return {
		"forms-guard": [...REQUIRED_VALIDATIONS["forms-guard"]],
		"ci-guard": [...REQUIRED_VALIDATIONS["ci-guard"]],
		"forms-mutations": ["bun", "test", FORMS_MUTATION_TEST],
		...legs,
		"rendered-forms": [
			"bun",
			COLLECTOR,
			"probe-render-forms",
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

/**
 * The step this stage adds to the required lane, read from the committed
 * workflow rather than restated, together with the fence it sits inside.
 *
 * Both facts matter and they are different failures. An unfenced step ships the
 * invocation into every project that disabled the capability; a step with an
 * `if:` is a step a selection can turn off; and a step in another job is a step
 * whose cost scales with the graph.
 */
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

/** The capability fence a line of the committed workflow sits inside. */
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

export async function validateStageTenAEvidenceValue(
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
	const expected = expectedStageTenACommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_TEN_A_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 10A command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 10A command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTenACommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 10A capture command is expected to pass. The refusals are
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
		if (!logs.has(name))
			errors.push(`repository: validation log ${name} is not bound`);
	}

	// Ancestry. Evidence-only commits may follow the implementation boundary, but
	// it has to stay reachable from HEAD, which is what forbids rebasing or
	// amending the branch after a capture.
	const baseSha = String(source["baseSha"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	if (baseSha !== STAGE_NINE_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 9 merge");
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

	// The declared tree state, bound to the committed registry. A record that
	// sealed `skeleton` while the registry has since gone `active` is describing
	// a repository that no longer exists.
	const registry = parseJson(
		await Bun.file(resolve(root, REGISTRY_PATH))
			.text()
			.catch(() => ""),
	);
	if (source["declaredMode"] !== DECLARED_MODE)
		errors.push("semantic: the sealed declared mode drifted");
	if (registry["mode"] !== DECLARED_MODE)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares ${DECLARED_MODE} mode`,
		);
	// The reserved package root is gated and empty, and both halves are the
	// point: gated so the first downstream project to use it is governed, empty
	// because a reservation is not a promise to create anything.
	if (git(root, ["ls-files", `${RESERVED_SCHEMA_ROOT}/`]).stdout.trim() !== "")
		errors.push(
			`repository: ${RESERVED_SCHEMA_ROOT} is reserved and must stay empty in the template`,
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
		repository["formsGuardScript"] !== FORMS_GUARD_SCRIPT ||
		repository["ciGuardScript"] !== CI_GUARD_SCRIPT ||
		repository["registryFile"] !== REGISTRY_PATH ||
		context === undefined ||
		repository["gateContext"] !== context ||
		sealedNeeds.some((need) => !declaredNeeds.includes(need)) ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// The new step is in the required lane, is unconditional, and is fenced —
	// and this stage added no JOB, which is the assertion that keeps every other
	// sealed record's run shape intact.
	const steps = requiredLaneSteps(workflow);
	const step = steps.find((entry) =>
		entry.run.includes(`bun run ${FORMS_GUARD_SCRIPT}`),
	);
	if (!step || step.conditional)
		errors.push(
			`semantic: ${FORMS_GUARD_SCRIPT} is not an unconditional step of the required lane`,
		);
	if (fenceAround(workflow, `bun run ${FORMS_GUARD_SCRIPT}`) !== CAPABILITY)
		errors.push(
			`semantic: the ${FORMS_GUARD_SCRIPT} step is not fenced on ${CAPABILITY}`,
		);
	if (repository["addedJobs"] !== 0 || declaredNeeds.includes("forms"))
		errors.push("semantic: Stage 10A must add no job to the required lane");

	// The refusal matrix. A record may claim the contract surface is guarded only
	// while every recorded diagnostic is still asserted by a committed test.
	const mutationSource = await Bun.file(resolve(root, FORMS_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(
				`repository: ${FORMS_MUTATION_TEST} no longer asserts ${verdict}`,
			);
	}
	const ciMutationSource = await Bun.file(resolve(root, CI_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_CI_MUTATIONS) {
		if (!ciMutationSource.includes(verdict))
			errors.push(
				`repository: ${CI_MUTATION_TEST} no longer asserts ${verdict}`,
			);
	}

	// The suites, and the counts they reported. A suite with zero passing tests
	// is a citation of nothing, and a leg filter that matched nothing is worse:
	// it is a green run over an empty set.
	const guards = recordAt(value, "guards");
	const suites = arrayAt(value, "suites").filter(isRecord);
	if (
		!sameValue(
			suites.map((entry) => entry["commandId"]),
			EXPECTED_MUTATION_TESTS.map((entry) => entry.commandId),
		)
	)
		errors.push("semantic: Stage 10A suite set drifted");
	for (const declared of EXPECTED_MUTATION_TESTS) {
		const entry = suites.find(
			(candidate) => candidate["commandId"] === declared.commandId,
		);
		if (
			!entry ||
			entry["testFile"] !== declared.testFile ||
			Number(entry["passCount"] ?? 0) < 1 ||
			entry["failCount"] !== 0
		)
			errors.push(`semantic: mutation suite ${declared.commandId} drifted`);
	}
	for (const [key, id, script] of [
		["forms", "forms-guard", FORMS_GUARD_SCRIPT],
		["ci", "ci-guard", CI_GUARD_SCRIPT],
	] as const) {
		const entry = recordAt(guards, key);
		if (
			entry["commandId"] !== id ||
			entry["command"] !== `bun run ${script}` ||
			String(entry["summary"] ?? "").length < 20 ||
			!log(id, "stdout").includes(String(entry["summary"] ?? " "))
		)
			errors.push(`semantic: guard ${key} evidence drifted`);
	}

	// Capability isolation, per fixture.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-forms" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_TEN_A_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-forms", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 10A render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_TEN_A_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			(enabled ? !sameValue(gated, [...ADDED_PATHS]) : gated.length !== 0) ||
			scripts.includes(FORMS_GUARD_SCRIPT) !== enabled ||
			fixture["formsStepPresent"] !== enabled ||
			// The three-character residue token, over every project file of the
			// render — the single fact that shaped this whole stage. Both
			// directions are asserted: exactly zero where the capability is off,
			// and more than zero where it is on, because a render that enabled the
			// family and still carried no mention of it would mean the family was
			// stripped from the project that asked for it.
			(enabled
				? Number(fixture["schemaLibraryTokenFiles"] ?? 0) < 1
				: fixture["schemaLibraryTokenFiles"] !== 0) ||
			// The guard runs over the render and returns a real verdict where the
			// capability is on, and is not there at all where it is off.
			(enabled
				? arrayAt(fixture, "formsErrors").length !== 0
				: fixture["guardPresent"] !== false) ||
			arrayAt(fixture, "residueFindings").length > 0 ||
			// The generated-output exemption is CORE: every project receives it,
			// whatever else it disables, because a rule that only arrived with the
			// first artifact is a rule that artifact ships without.
			fixture["biomeGeneratedOverride"] !== true
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} contract evidence drifted`,
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
			[...STAGE_TEN_A_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 10A coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_TEN_A_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-10a-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable,
		// no branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild") ||
		!String(rollback["scope"] ?? "").includes("order-independent")
	)
		errors.push("semantic: Stage 10A rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 10A rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageTenAEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-10a-api-contract.json");
	const schemaPath = resolve(
		root,
		"evidence/stage-10a-api-contract.schema.json",
	);
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-10a-api-contract.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return [
			"repository: evidence/stage-10a-api-contract.schema.json is missing",
		];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-10a-api-contract.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageTenAEvidenceValue(value, schema, root);
}
