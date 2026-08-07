// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Sealed diagnostics are literal fragments of interpolated assertions.
import { resolve } from "node:path";
// The guard's own answer to "what is the required status check called?". The
// record derives the context from the committed workflow through this function
// rather than restating it, so a renamed gate job invalidates the evidence.
import {
	aggregateGateContext,
	DEFAULT_AGGREGATE_GATE_NAME,
} from "./ci-contract";
import {
	CORE_PATHS,
	type ExperimentRegistry,
	inspectSurfaces,
	SURFACE_COUNT,
} from "./experiment-contract";
import { validateJsonSchema } from "./json-schema";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_TEN_E_COMMAND_IDS = [
	// The two guards this stage touches: the one it adds, and the workflow
	// contract whose required lane now carries one more UNFENCED step.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log.
	"experiment-guard",
	"ci-guard",
	// The whole refusal matrix, and then each leg on its own. The legs are not a
	// decomposition for tidiness: a suite-wide green says the file passed, and
	// what this record has to be able to say is that THIS rule was exercised.
	"experiment-mutations",
	"mode-reconciliation",
	"surface-lock",
	"containment",
	"manifest-registration",
	"moon-registration",
	"universe-reconciliation",
	"promotion-artifacts",
	"retirement-residue",
	"findings",
	// The two executed lifecycles, each driven in sequence over a real
	// Git-backed tree rather than as isolated mutations.
	"removal-fixture",
	"promotion-fixture",
	// The probe that answers a question no committed test can seal: what each
	// fixture actually received — and here it is the INVERSE of every previous
	// stage's question, because this surface is core and must be in all three.
	"rendered-experiments",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageTenECommandId = (typeof STAGE_TEN_E_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-10e-experiments-run";
const COLLECTOR = "scripts/template/collect-stage-ten-e-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const EXPERIMENT_GUARD_SCRIPT = "experiments:check";
const CI_GUARD_SCRIPT = "ci:check";
const EXPERIMENT_MUTATION_TEST =
	"scripts/template/__tests__/experiment.test.ts";
const REGISTRY_PATH = "experiments.json";
const LOCK_PATH = "bun.lock";

// The declared tree state. It is sealed rather than read back out of the
// registry at validation time, because "the guard agreed with the registry" is
// a different claim from "the registry still says what it said when this
// evidence was captured" — and this record is making the second one.
export const DECLARED_MODE = "skeleton";

// The anti-vacuity anchor, sealed as a number. `apps/` and `libs/` hold a
// `.gitkeep` in this repository and in every rendered project, so a record that
// sealed the count of EXPERIMENTS would seal zero and prove nothing. Seven is
// the count of exception SURFACES the guard inspects, and zero is a hard
// failure rather than a pass.
export const SEALED_SURFACE_COUNT = SURFACE_COUNT;

// The Stage 10D merge on main, which is this stage's predecessor and the tree
// the rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_TEN_D_MERGE_SHA = "40f597aa83e44333c6b119b05ebe217fc9ea0b21";

// The four paths this stage adds. A revert has to take every one of them back
// out, which is the additive half of the rollback proof. Unlike every stage
// since 10A these are NOT gated paths: they ship in all three renders, which is
// the fact `rendered-experiments` measures.
export const ADDED_PATHS = [...CORE_PATHS] as readonly string[];

// The three directories a capability's ownership pattern already reserves,
// sealed by DIRECTORY and PATTERN rather than by capability name. One of the
// three capabilities has its own name as a residue token, this record's inputs
// travel with the registry, and a path signature is matched by a file's
// location while a token signature is matched by its contents.
export const RESERVED_DIRECTORIES = [
	{ directory: "libs/auth", ownershipPattern: "libs/auth/**" },
	{ directory: "libs/forms", ownershipPattern: "libs/forms/**" },
	{
		directory: "libs/observability",
		ownershipPattern: "libs/observability/**",
	},
] as const;

/**
 * The seven exception surfaces at the values this record measured.
 *
 * This is the deliverable of the stage, not the experiment list. With
 * `experiments: []` the guard's whole value is that these seven committed lists
 * are locked to a declaration, so the record seals the declaration and the
 * validator reconciles it with the registry AND with the tree.
 */
export const SEALED_POLICY = {
	workspaceGlobs: ["apps/*", "libs/*"],
	projectGlobs: ["apps/*", "libs/*"],
	typecheckProject: "tsconfig.json",
	typecheckIncludes: ["apps/**/*.ts", "libs/**/*.ts", "scripts/**/*.ts"],
	typecheckExcludes: [
		"dist",
		"graphify-out",
		"node_modules",
		"scripts/template",
		"tmp",
	],
	formatterConfig: "biome.jsonc",
	formatterNegations: ["**/worker-configuration.d.ts", "graphify-out"],
	formatterOverrides: ["**/generated/**", "**/openapi/**"],
	ignoreFile: ".gitignore",
	toleratedIgnorePatterns: [
		"**/build/",
		"**/coverage/",
		"**/dist/",
		"**/out/",
		"**/tmp/",
	],
	universeRegistryPath: "ci-matrix-universes.json",
	workflowRoot: ".github/workflows",
	toleratedWorkflowFailures: [],
	reservedDirectories: RESERVED_DIRECTORIES,
	findingsRoots: ["CHANGES.md", "docs/", "openspec/changes/archive/"],
	retirementAllowList: [
		"CHANGES.md",
		"docs/devcontainer-upgrade/",
		"evidence/",
		"experiments.json",
		"graphify-out/",
		"openspec/",
		"scripts/template/experiment-contract.ts",
	],
} as const;

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"experiment-guard": ["bun", "run", EXPERIMENT_GUARD_SCRIPT],
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
	"mode-reconciliation": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "reconciles the declared mode with the derived one in both",
	},
	"surface-lock": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "the seven strictness exception surfaces",
	},
	containment: {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "an experiment outside the workspace globs is refused",
	},
	"manifest-registration": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "a declared experiment must be a package and a moon project",
	},
	"moon-registration": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "a hand-written moon.yml with no generated block is refused",
	},
	"universe-reconciliation": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "universe membership is a notice, and a declared universe id",
	},
	"promotion-artifacts": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "each of the five promotion artefacts is refused when it is",
	},
	"retirement-residue": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "the retirement residue scan",
	},
	findings: {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "a retired experiment must name findings or waive them",
	},
	"removal-fixture": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "a spike is created, deleted, and cleaned up one registration",
	},
	"promotion-fixture": {
		testFile: EXPERIMENT_MUTATION_TEST,
		pattern: "a spike is created disposable, promoted, and completed one",
	},
} as const;

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are LITERAL FRAGMENTS rather than whole sentences, and that is not
 * laziness: almost every refusal this guard produces names an experiment id AND
 * a surface path, so it is assembled with template interpolation and the
 * complete sentence never appears anywhere in the suite's source. Sealing the
 * whole sentence would bind the record to a string no file contains. The
 * previous two stages' collectors caught exactly that before writing anything,
 * and this record keeps the same self-validation for the same reason.
 */
export const REQUIRED_MUTATIONS = [
	// Mode reconciliation, in both directions. The second one is the half a
	// deletion produces, and it is the half that is easy to leave out.
	"does not declare; an undeclared experiment is one nothing governs",
	"which holds no tracked file; move the record to the retired list rather than deleting it",
	"mode but the tree state derived from the workspace globs is active",
	"declares skeleton mode but declares",
	"declares active mode but declares no experiment",
	// Sole declarations.
	"is a second experiment lifecycle registry",
	"is declared twice",
	"is declared as live and as retired at the same time",
	"is claimed by both spike-alpha and spike-beta",
	// Wiring, and the four negatives that keep this surface CORE.
	"must run scripts/template/validate-experiment.ts",
	"must not sit inside the openspec capability fence; this surface is core and ships in every render",
	"step must not be conditional",
	"in the required lane",
	"template ownership must copy ",
	"must not be a gated artifact; this surface ships in every render",
	" script; the render would keep the workflow step that calls it",
	"must not be a graphify capability signature path",
	// The rule that came out of a measurement rather than a plan: a core file
	// that merely MENTIONS another capability's token fails every render.
	"must not contain the playwright signature token playwright; this file ships to every render, including the ones that disable it",
	"which no artifact rule or capability signature declares",
	// The seven exception surfaces.
	"a drift here is a decision somebody makes in a commit, not a side effect of a directory appearing",
	"must keep the repository itself as the project named root, so the graph is never empty",
	"excludes inherited moon tasks; only the root moon.yml may, because its directory is the whole repository",
	"which removes a workspace directory from the typechecker",
	"from the formatter and the linter, and it names a workspace directory",
	"which names a workspace directory; an ignored directory is invisible to every guard at once",
	"and nothing there tolerates a failure; a stale exemption widens itself",
	"an experiment may not skip a required step by naming itself",
	// The CI leg cross-references rather than duplicating.
	"is refused by ci:check, which owns that sentence; this guard adds only the experiment-specific half",
	// Containment, registration and the graph.
	"which is not one level under apps or libs; code outside the workspace globs is invisible to every guard at once",
	"which the ownership pattern libs/forms/** already reserves",
	"so it is a directory in the workspace rather than a package in it",
	"run graph:generate so the project joins the graph",
	"carries no generated dependency block; run graph:generate rather than writing dependsOn by hand",
	"whether its contents are stale is a comparison scripts/template/graph-contract.ts already owns",
	// The universe leg: a notice where another module owns the sentence, a
	// refusal where nobody does.
	"belongs to no universe in ",
	"which is a refusal scripts/template/graph-contract.ts already owns",
	"was declared and not reconciled against a CI universe",
	"which does not list the project ",
	"does not declare",
	// Promotion.
	"is promoted and declares no promotion block; promotion adds ownership, a graph entry, universe membership, tests and documentation, and each of them is named",
	"which does not cover ",
	"the CI test wrapper absorbs an empty match by design, so nothing else would ever say so",
	"which is under none of ",
	"which does not exist",
	// Retirement and findings.
	"is retired but ",
	"the scan is the union of declared spellings and never a pattern over the id",
	"which the retired record for ",
	"is retired with no findings artefact and no waiver; the record and the findings die together or not at all",
	"a findings file inside the directory dies with it",
	"and also waives them; a waiver lifts a requirement it is not standing beside",
	// Non-vacuity, and the abstention that is never a pass.
	"a rule with no input has answered nothing",
	"is not a Git repository, so the enumeration fell back to a directory walk",
] as const;

// The committed suites this record cites, and the file each one is. A coverage
// claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "experiment-mutations", testFile: EXPERIMENT_MUTATION_TEST },
	...Object.entries(MUTATION_LEGS).map(([commandId, leg]) => ({
		commandId,
		testFile: leg.testFile,
	})),
] as const;

/**
 * What the one live cycle must be observed to show.
 *
 * STANDING DECISION — do NOT retarget this at a later run. The sealed run is a
 * fact about the tree at `implementationSha`: it is the capture that says the
 * required gate went green with this stage's new step in the lane. Pointing it
 * at a newer, greener run because the old one aged out of the log retention
 * would replace an observation with an assertion.
 *
 * `heavyLaneRan` is true because the affected selector is live in `moon` mode
 * and the only project here is the root, whose source is the whole repository,
 * so a code change cannot exclude anything. This stage has a second, independent
 * reason: `package.json`, `.github/**` and `scripts/**` are all `GLOBAL_PATTERNS`
 * entries and this stage edits all three.
 */
export const EXPECTED_OBSERVATIONS = [
	{
		id: "live-gate",
		conclusion: "success",
		event: "pull_request",
		heavyLaneRan: true,
	},
] as const;

export type StageTenEObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

// Every fixture, and the assertion that is the INVERSE of every stage since
// 10A: this surface is core, so `capabilityEnabled` is not a field here at all
// and all four paths must be present in all three renders.
export const STAGE_TEN_E_FIXTURES = ["minimal", "cloud", "full"] as const;

export const STAGE_TEN_E_COVERAGE_IDS = [
	"declared-registry",
	"exception-surface-lock",
	"derived-scope-floor",
	"containment",
	"graph-and-universe",
	"promotion-artifacts",
	"retirement-residue",
	"findings-outlive-the-code",
	"core-not-capability",
	"executed-lifecycles",
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
export function expectedStageTenECommands(
	value: JsonRecord,
): Record<StageTenECommandId, string[]> {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const live = recordAt(value, "live");
	const runId = String(run["id"] ?? "");
	const name = String(repository["nameWithOwner"] ?? "");
	const gate = String(repository["gateContext"] ?? "");
	const legs = Object.fromEntries(
		Object.entries(MUTATION_LEGS).map(([id, leg]) => [
			id,
			["bun", "test", leg.testFile, "-t", leg.pattern],
		]),
	) as Record<keyof typeof MUTATION_LEGS, string[]>;
	return {
		"experiment-guard": [...REQUIRED_VALIDATIONS["experiment-guard"]],
		"ci-guard": [...REQUIRED_VALIDATIONS["ci-guard"]],
		"experiment-mutations": ["bun", "test", EXPERIMENT_MUTATION_TEST],
		...legs,
		"rendered-experiments": [
			"bun",
			COLLECTOR,
			"probe-render-experiments",
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

/** The steps of the required lane, read from the committed workflow. */
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

export async function validateStageTenEEvidenceValue(
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
	const expected = expectedStageTenECommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_TEN_E_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 10E command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 10E command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTenECommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 10E capture command is expected to pass. The refusals are
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
	for (const name of VALIDATION_LOG_NAMES) {
		if (!logs.has(name))
			errors.push(`repository: validation log ${name} is not bound`);
	}

	// Ancestry. Evidence-only and documentation commits may follow the
	// implementation boundary, but it has to stay reachable from HEAD, which is
	// what forbids rebasing or amending the branch after a capture.
	const baseSha = String(source["baseSha"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	if (baseSha !== STAGE_TEN_D_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 10D merge");
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

	// The declared registry, bound to the committed file. `skeleton` with no
	// experiment and no retired record is the whole claim: this template ships
	// the guard and the policy and nothing for them to govern, and the policy is
	// the deliverable.
	const registryValue = parseJson(
		await Bun.file(resolve(root, REGISTRY_PATH))
			.text()
			.catch(() => ""),
	);
	if (
		source["declaredMode"] !== DECLARED_MODE ||
		registryValue["mode"] !== DECLARED_MODE ||
		!sameValue(registryValue["experiments"], []) ||
		!sameValue(registryValue["retired"], [])
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares ${DECLARED_MODE} mode with no experiment and no retired record`,
		);
	// The seven surfaces, sealed AND reconciled. Sealing the policy alone would
	// prove somebody typed it; running the guard's own inspection over the tree
	// is what proves the tree still matches it.
	if (
		!sameValue(source["policy"], SEALED_POLICY) ||
		!sameValue(registryValue["policy"], SEALED_POLICY)
	)
		errors.push(
			"semantic: the sealed exception-surface policy is not the committed one",
		);
	if (
		!sameValue(source["reservedDirectories"], RESERVED_DIRECTORIES) ||
		!sameValue(
			recordAt(registryValue, "policy")["reservedDirectories"],
			RESERVED_DIRECTORIES,
		)
	)
		errors.push("semantic: the sealed reserved directories drifted");
	const surfaces = recordAt(value, "surfaces");
	if (
		surfaces["scanned"] !== SEALED_SURFACE_COUNT ||
		source["surfaceCount"] !== SEALED_SURFACE_COUNT
	)
		errors.push(
			`semantic: the sealed surface count is not ${SEALED_SURFACE_COUNT}`,
		);
	if (Object.keys(registryValue).length > 0) {
		const inspection = await inspectSurfaces(
			root,
			registryValue as unknown as ExperimentRegistry,
		);
		if (
			inspection.scanned !== SEALED_SURFACE_COUNT ||
			inspection.errors.length !== 0 ||
			!sameValue(
				arrayAt(surfaces, "inspected").map(String),
				inspection.inspections.map((entry) => entry.surface),
			)
		)
			errors.push(
				"repository: the seven exception surfaces no longer inspect clean",
			);
	}

	// The lockfile did not move, which is the fifth consecutive stage. Sealed as
	// BYTES rather than as a boolean, because "changed" hides the size of what
	// changed and zero is the only number this stage is allowed to report.
	const lockBytes = git(root, [
		"diff",
		"--numstat",
		baseSha,
		implementationSha,
		"--",
		LOCK_PATH,
	]).stdout.trim();
	if (source["lockfileBytesChanged"] !== 0 || lockBytes !== "")
		errors.push("semantic: Stage 10E changed the lockfile");
	// `apps/` and `libs/` stay empty, which is what keeps the guard's own subject
	// matter out of the template.
	if (
		source["workspaceDirectoriesAdded"] !== 0 ||
		git(root, [
			"diff",
			"--quiet",
			baseSha,
			implementationSha,
			"--",
			"apps",
			"libs",
		]).exitCode !== 0
	)
		errors.push("semantic: Stage 10E added a workspace directory");

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
	// a true historical capture into a reported fabrication. Losing a sealed lane
	// is still rejected.
	const sealedNeeds = arrayAt(repository, "gateNeeds").map(String);
	if (
		repository["workflowFile"] !== WORKFLOW_PATH ||
		repository["gateJobId"] !== DEFAULT_AGGREGATE_GATE_NAME ||
		repository["experimentGuardScript"] !== EXPERIMENT_GUARD_SCRIPT ||
		repository["ciGuardScript"] !== CI_GUARD_SCRIPT ||
		repository["registryFile"] !== REGISTRY_PATH ||
		// The decision this whole stage turns on, sealed as a value rather than
		// left implicit in the absence of a field.
		repository["capability"] !== null ||
		context === undefined ||
		repository["gateContext"] !== context ||
		sealedNeeds.some((need) => !declaredNeeds.includes(need)) ||
		sealedNeeds.length < 2
	)
		errors.push("semantic: recorded gate identity is not the committed one");

	// The new step is in the required lane, is unconditional, and is UNFENCED —
	// which is the inverse of every stage since 10A and the mechanical form of
	// this stage's central decision. And this stage added no JOB, which is the
	// assertion that keeps every other sealed record's run shape intact.
	const steps = requiredLaneSteps(workflow);
	const step = steps.find((entry) =>
		entry.run.includes(`bun run ${EXPERIMENT_GUARD_SCRIPT}`),
	);
	if (!step || step.conditional)
		errors.push(
			`semantic: ${EXPERIMENT_GUARD_SCRIPT} is not an unconditional step of the required lane`,
		);
	if (fenceAround(workflow, `bun run ${EXPERIMENT_GUARD_SCRIPT}`) !== undefined)
		errors.push(
			`semantic: the ${EXPERIMENT_GUARD_SCRIPT} step must sit inside no capability fence`,
		);
	if (repository["addedJobs"] !== 0 || declaredNeeds.includes("experiments"))
		errors.push("semantic: Stage 10E must add no job to the required lane");
	// The one thing that would have cost a container rebuild, asserted rather
	// than promised: not a byte under `.devcontainer/` differs between the
	// predecessor and the boundary. `.husky/` travels with it because it is the
	// surface this stage was most tempted to edit and deliberately did not.
	if (
		repository["devcontainerFilesChanged"] !== 0 ||
		repository["huskyFilesChanged"] !== 0 ||
		git(root, [
			"diff",
			"--quiet",
			baseSha,
			implementationSha,
			"--",
			".devcontainer",
			".husky",
		]).exitCode !== 0
	)
		errors.push(
			"semantic: Stage 10E changed a definition fingerprint input under .devcontainer or a git hook",
		);

	// The refusal matrix. A record may claim this surface is guarded only while
	// every recorded diagnostic is still asserted by a committed test — and the
	// fragments are literal because the sentences themselves are interpolated.
	const mutationSource = await Bun.file(resolve(root, EXPERIMENT_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(
				`repository: ${EXPERIMENT_MUTATION_TEST} no longer asserts ${verdict}`,
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
		errors.push("semantic: Stage 10E suite set drifted");
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
		["experiment", "experiment-guard", EXPERIMENT_GUARD_SCRIPT],
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

	// Core, not capability — measured per fixture and in the INVERSE direction of
	// every stage since 10A. The four files must be in all three renders, the
	// script must be in all three manifests, the step must be in all three
	// workflows, the guard must return a real verdict inside each, and the
	// residue scan must report nothing about any of them, which is automatic
	// because there is no signature to match.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-experiments" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			[...STAGE_TEN_E_FIXTURES],
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-experiments", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 10E render evidence drifted");
	for (const fixture of fixtures) {
		if (
			!sameValue(arrayAt(fixture, "corePaths").map(String), [...ADDED_PATHS]) ||
			fixture["guardScriptPresent"] !== true ||
			fixture["guardStepPresent"] !== true ||
			fixture["guardStepFenced"] !== false ||
			arrayAt(fixture, "experimentErrors").length !== 0 ||
			fixture["surfacesScanned"] !== SEALED_SURFACE_COUNT ||
			arrayAt(fixture, "residueFindings").length > 0 ||
			// There is no signature, so there is nothing to find. The assertion
			// exists so a future stage that DOES gate this surface has a failing
			// test to notice rather than a silent behaviour change.
			arrayAt(fixture, "coreResidueFindings").length !== 0
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} experiment evidence drifted`,
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
			// One result per sealed dependency, and every one of them either passed
			// or was deliberately skipped.
			upstream.length !== sealedNeeds.length ||
			upstream.some((result) => result !== "success" && result !== "skipped") ||
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
			[...STAGE_TEN_E_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 10E coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_TEN_E_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-10e-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable, no
		// branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild") ||
		!String(rollback["scope"] ?? "").includes("order-independent")
	)
		errors.push("semantic: Stage 10E rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["revertedTree"] !== proof["predecessorTree"] ||
		// `-m 1` reverts the FIRST parent, and the first parent has to be the
		// predecessor. Reverting the other one produces a tree that looks
		// plausible and is not the predecessor's, so the parents are checked in
		// order rather than as a set.
		!sameValue(proof["syntheticMergeParents"], [baseSha, implementationSha]) ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 10E rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageTenEEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-10e-experiments.json");
	const schemaPath = resolve(
		root,
		"evidence/stage-10e-experiments.schema.json",
	);
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-10e-experiments.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return [
			"repository: evidence/stage-10e-experiments.schema.json is missing",
		];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-10e-experiments.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageTenEEvidenceValue(value, schema, root);
}
