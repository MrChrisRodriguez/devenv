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

export const STAGE_TEN_B_COMMAND_IDS = [
	// The three guards this stage touches: the one it adds, the core workflow
	// contract it extends with the credential rules, and the lifecycle guard it
	// extends with the readback ordering rule.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log.
	"telemetry-guard",
	"ci-guard",
	"openspec-guard",
	// The whole refusal matrix, and then each leg on its own. The legs are not a
	// decomposition for tidiness: a suite-wide green says the file passed, and
	// what this record has to be able to say is that THIS rule was exercised.
	"telemetry-mutations",
	"surface-confinement",
	"truth-table",
	"scrub-policy",
	"credential-literals",
	"allowlist-matrix",
	// The dynamic half: the table executed against a loopback recorder, the
	// outage, and the final-state readback.
	"outage-and-final-state",
	// The two legs that live in core suites, because the rules they exercise are
	// core and may not name a capability token.
	"workflow-secret-rules",
	"archive-readback",
	// The probe that answers a question no committed test can seal: what each
	// fixture actually received.
	"rendered-telemetry",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageTenBCommandId = (typeof STAGE_TEN_B_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-10b-telemetry-run";
const COLLECTOR = "scripts/template/collect-stage-ten-b-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CAPABILITY = "sentry";
const TELEMETRY_GUARD_SCRIPT = "telemetry:check";
const CI_GUARD_SCRIPT = "ci:check";
const OPENSPEC_GUARD_SCRIPT = "openspec:check";
const TELEMETRY_MUTATION_TEST = "scripts/template/__tests__/telemetry.test.ts";
const CI_MUTATION_TEST = "scripts/template/__tests__/ci.test.ts";
const OPENSPEC_MUTATION_TEST = "scripts/template/__tests__/openspec.test.ts";
const REGISTRY_PATH = "external-writes.json";
const ARCHIVE_WRAPPER = "scripts/openspec/archive.sh";

// The declared tree state. It is sealed rather than read back out of the
// registry at validation time, because "the guard agreed with the registry" is
// a different claim from "the registry still says what it said when this
// evidence was captured" — and this record is making the second one.
export const DECLARED_MODE = "skeleton";

// The Stage 10A merge on main, which is this stage's predecessor and the tree
// the rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_TEN_A_MERGE_SHA = "cdc90904b14f697ce2cc6eca2a6057b4512a4c93";

// The paths this stage adds and this capability owns. A revert has to take
// every one of them back out, which is the additive half of the rollback proof:
// the reverted tree carries none of them and the implementation tree carries
// all of them.
export const ADDED_PATHS = [
	"external-writes.json",
	"external-writes.schema.json",
	"scripts/template/telemetry-contract.ts",
	"scripts/template/validate-telemetry.ts",
] as const;

// The reserved configuration root Stage 0 pre-declared for this capability.
// Nothing creates it, and the record says so on purpose: a reservation is where
// the artifact WOULD live, not a promise to create one — and the reference
// implementation has no directory by this name at all.
export const RESERVED_TELEMETRY_ROOT = "libs/observability";

// The one remote write this repository performs, and the module that governs
// it. The record binds both because the registry's single `governedElsewhere`
// entry is what stops the write-shape scan from being a scan with nothing to
// find.
export const GOVERNED_WRITE = {
	path: ARCHIVE_WRAPPER,
	authority: "scripts/template/openspec-contract.ts",
} as const;

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"telemetry-guard": ["bun", "run", TELEMETRY_GUARD_SCRIPT],
	"ci-guard": ["bun", "run", CI_GUARD_SCRIPT],
	"openspec-guard": ["bun", "run", OPENSPEC_GUARD_SCRIPT],
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
 *
 * Two of the legs point at CORE suites. The workflow credential rules and the
 * archive readback are unfenced rules that must hold in every render, so they
 * may not be exercised from a suite that names a capability token — the same
 * split the guards themselves take.
 */
export const MUTATION_LEGS = {
	"surface-confinement": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "telemetry SDK confinement",
	},
	"truth-table": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "the upload truth table",
	},
	"scrub-policy": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "scrubbing policy",
	},
	"credential-literals": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "credential literals",
	},
	"allowlist-matrix": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "the host allowlist",
	},
	"outage-and-final-state": {
		testFile: TELEMETRY_MUTATION_TEST,
		pattern: "truth table, executed",
	},
	"workflow-secret-rules": {
		testFile: CI_MUTATION_TEST,
		pattern: "known-bad ci mutations",
	},
	"archive-readback": {
		testFile: OPENSPEC_MUTATION_TEST,
		pattern: "readback",
	},
} as const;

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are the sentences the guard prints when it refuses, and the record may
 * claim the external-write surface is guarded only while every one of them is
 * still asserted by a committed test. A suite that lost a case would otherwise
 * keep passing and keep being cited.
 */
export const REQUIRED_MUTATIONS = [
	// Mode reconciliation, one case per derived shape, both directions.
	"declares skeleton mode but libs/observability/src/index.ts lives under the reserved telemetry configuration root",
	"declares skeleton mode but apps/web/src/telemetry.ts imports the telemetry SDK",
	"declares skeleton mode but apps/web/src/boot.ts calls the telemetry SDK initializer",
	"declares skeleton mode but scripts/deploy.sh performs the remote write git-push",
	"declares active mode but declares no telemetry configuration and no external write",
	"declares skeleton mode but declares a telemetry or write surface",
	// Sole declarations, and delegated authority in both directions.
	"is a second external write registry",
	"is both a declared write and governed elsewhere; one file has one authority",
	"is exempted as governed elsewhere but performs no remote write; a stale exemption widens itself",
	"an authority that never reads the file it governs governs nothing",
	// Wiring.
	"package script telemetry:check must run scripts/template/validate-telemetry.ts",
	"must sit inside a sentry capability fence",
	"step must not be conditional",
	// Ownership.
	"must be gated by the capability",
	"must leave the absent inventory",
	// SDK confinement, one per ported refusal.
	"imports the telemetry SDK outside a declared configuration module",
	"calls the telemetry SDK initializer outside a declared configuration module",
	"reaches the telemetry SDK's structured logger or metrics namespace outside a declared configuration module",
	"binds a telemetry user identity; the SDK's user binding attaches an identity to every report and is banned everywhere",
	// The truth table.
	"an upload gated on one half is gated on nothing",
	"does not dominate; the gate is intent times credential",
	"a build that silently skips the upload is a build nobody notices",
	"an upload that can reach the server bundle is a refusal",
	// Declared writes.
	"never reads the intent --confirm-push; a credential is not an authorization",
	"declares the credential DEPLOY_ACCESS_TOKEN and never reads it",
	"verifies with its own write command; verification is a separate command, never a flag on the write",
	"declares a verify command that is itself a remote write",
	"an unread final state is an unasserted one",
	"is declared as the write deploy but performs no remote write",
	// Credential literals and the scrubbing policy.
	"carries a committed ingest DSN literal",
	"assigns a long opaque value to a credential-named binding",
	"declares no beforeSend hook; a payload nothing scrubs is a payload nothing checked",
	"must pin sendDefaultPii to false",
	"imports the telemetry SDK; the scrubber is shared by every tier and must stay pure",
	"a declared scrubber nothing routes through scrubs nothing",
	"reads like a credential; a value that ships inside a bundle may not be named as a secret",
	"is the upload credential and is not named as one",
	// The host allowlist.
	"is a wildcard; an allowlist that can match a host nobody enumerated is a denylist wearing an allowlist's name",
	"carries a path, a query or a fragment; an allowlist entry is an origin",
	"does not list; every write's hosts are a subset of the declared union",
	"is not a same-origin path; a tunnel that names a host is a second ingest endpoint",
	"declares a write and no allowed host; an empty allowlist is not a narrow one",
	// The executed table, and the anti-vacuity the recorder needs.
	"the recorder itself is not vacuous",
	"observes 0, 0, 0 and N requests across the four states",
	"refuses a host the allowlist does not carry before any socket opens",
	"treats the remote being down as a warning and never a failure",
	"asserts the final remote state and fails when it is wrong",
] as const;

// The core workflow rules this stage adds. They are negative requirements — no
// workflow here references the credential context — so the only place they can
// be observed is the mutation suite that adds one. They live in the core suite
// because the rules are core: a capability token in `ci-contract.ts` would ship
// into every project that disabled the capability.
export const REQUIRED_CI_MUTATIONS = [
	"must not interpolate a credential into a shell body",
	"must not expose a credential in a workflow-level env block",
	"must not expose a credential in a job-level env block",
	"passes a credential to an unconditional step; credential presence alone must not authorize a write",
	"must not declare a pull_request_target trigger",
] as const;

// The readback rules this stage adds to the lifecycle guard, and the live
// refusal the wrapper now has. `archive.sh` is Stage 9's file: nothing was
// renamed or removed, and these sentences are additions.
export const REQUIRED_OPENSPEC_MUTATIONS = [
	"must read the remote back with `git ls-remote --exit-code origin` after it pushes",
	"reads the remote back before it pushes; a query that precedes the write establishes nothing about it",
	"a superseded readback compares a value the remote never produced",
	"runs the readback without binding its result; a query nobody compares is a query nobody asked",
	"the archive push did not verify against the remote",
	"a dry run reports and never reaches the write or the readback",
] as const;

// The three committed suites this record cites, and the file each one is. A
// coverage claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "telemetry-mutations", testFile: TELEMETRY_MUTATION_TEST },
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

export type StageTenBObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

export const STAGE_TEN_B_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_TEN_B_COVERAGE_IDS = [
	"declared-surface",
	"intent-and-credentials",
	"surface-confinement",
	"credential-hygiene",
	"host-allowlist",
	"workflow-credentials",
	"final-state-readback",
	"outage-tolerance",
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
export function expectedStageTenBCommands(
	value: JsonRecord,
): Record<StageTenBCommandId, string[]> {
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
		"telemetry-guard": [...REQUIRED_VALIDATIONS["telemetry-guard"]],
		"ci-guard": [...REQUIRED_VALIDATIONS["ci-guard"]],
		"openspec-guard": [...REQUIRED_VALIDATIONS["openspec-guard"]],
		"telemetry-mutations": ["bun", "test", TELEMETRY_MUTATION_TEST],
		...legs,
		"rendered-telemetry": [
			"bun",
			COLLECTOR,
			"probe-render-telemetry",
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

export async function validateStageTenBEvidenceValue(
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
	const expected = expectedStageTenBCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_TEN_B_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 10B command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 10B command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTenBCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 10B capture command is expected to pass. The refusals are
		// proved by the mutation suites, which pass BY observing them — so a
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

	// No captured log may carry a telemetry credential. The collector redacts
	// them from the environment it hands every command, and this is the assertion
	// that the redaction was in force for the capture this record seals: a proof
	// that leaks the thing it is proving safe is worse than no proof.
	for (const [name, text] of logs) {
		if (/\bSENTRY_[A-Z0-9_]*\s*=\s*\S/.test(text))
			errors.push(`repository: log ${name} carries a telemetry credential`);
	}

	// Ancestry. Evidence-only and documentation commits may follow the
	// implementation boundary, but it has to stay reachable from HEAD, which is
	// what forbids rebasing or amending the branch after a capture.
	const baseSha = String(source["baseSha"] ?? "");
	const implementationSha = String(source["implementationSha"] ?? "");
	if (baseSha !== STAGE_TEN_A_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 10A merge");
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

	// The declared tree state, bound to the committed registry, plus the single
	// delegated authority the whole write-shape scan stands on.
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
	if (
		!sameValue(registry["governedElsewhere"], [
			{ path: GOVERNED_WRITE.path, authority: GOVERNED_WRITE.authority },
		])
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer delegates ${GOVERNED_WRITE.path} to ${GOVERNED_WRITE.authority}`,
		);
	if (!sameValue(registry["writes"], []) || registry["telemetry"] !== null)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares an empty telemetry and write surface`,
		);
	// The reserved configuration root is gated and empty, and both halves are the
	// point: gated so the first downstream project to use it is governed, empty
	// because a reservation is not a promise to create anything.
	if (
		git(root, ["ls-files", `${RESERVED_TELEMETRY_ROOT}/`]).stdout.trim() !== ""
	)
		errors.push(
			`repository: ${RESERVED_TELEMETRY_ROOT} is reserved and must stay empty in the template`,
		);
	// The readback lives in the wrapper and after the push. The lifecycle guard
	// owns the ordering rule; the record binds the fact that the wrapper still
	// carries it, because a revert of this stage that missed it would leave a
	// rule with nothing to check.
	const wrapper = await Bun.file(resolve(root, ARCHIVE_WRAPPER))
		.text()
		.catch(() => "");
	if (
		!wrapper.includes("git ls-remote --exit-code origin") ||
		wrapper.indexOf("git ls-remote --exit-code origin") <
			wrapper.search(/git\s+push\s+--quiet\s+origin/)
	)
		errors.push(
			`repository: ${ARCHIVE_WRAPPER} no longer reads the remote back after it pushes`,
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
	// a true historical capture into a reported fabrication. Losing a sealed lane
	// is still rejected.
	const sealedNeeds = arrayAt(repository, "gateNeeds").map(String);
	if (
		repository["workflowFile"] !== WORKFLOW_PATH ||
		repository["gateJobId"] !== DEFAULT_AGGREGATE_GATE_NAME ||
		repository["capability"] !== CAPABILITY ||
		repository["telemetryGuardScript"] !== TELEMETRY_GUARD_SCRIPT ||
		repository["ciGuardScript"] !== CI_GUARD_SCRIPT ||
		repository["openspecGuardScript"] !== OPENSPEC_GUARD_SCRIPT ||
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
		entry.run.includes(`bun run ${TELEMETRY_GUARD_SCRIPT}`),
	);
	if (!step || step.conditional)
		errors.push(
			`semantic: ${TELEMETRY_GUARD_SCRIPT} is not an unconditional step of the required lane`,
		);
	if (fenceAround(workflow, `bun run ${TELEMETRY_GUARD_SCRIPT}`) !== CAPABILITY)
		errors.push(
			`semantic: the ${TELEMETRY_GUARD_SCRIPT} step is not fenced on ${CAPABILITY}`,
		);
	if (repository["addedJobs"] !== 0 || declaredNeeds.includes("telemetry"))
		errors.push("semantic: Stage 10B must add no job to the required lane");
	// The credential context appears nowhere in any committed workflow. That is
	// the state the four core rules were written to preserve, and a record that
	// cited them while the tree had already grown one would be citing a rule
	// nothing had exercised against reality.
	if (repository["workflowSecretReferences"] !== 0)
		errors.push(
			"semantic: a committed workflow now references the credential context",
		);

	// The refusal matrix, across all three suites. A record may claim the
	// external-write surface is guarded only while every recorded diagnostic is
	// still asserted by a committed test.
	for (const [file, verdicts] of [
		[TELEMETRY_MUTATION_TEST, REQUIRED_MUTATIONS],
		[CI_MUTATION_TEST, REQUIRED_CI_MUTATIONS],
		[OPENSPEC_MUTATION_TEST, REQUIRED_OPENSPEC_MUTATIONS],
	] as const) {
		const text = await Bun.file(resolve(root, file))
			.text()
			.catch(() => "");
		for (const verdict of verdicts) {
			if (!text.includes(verdict))
				errors.push(`repository: ${file} no longer asserts ${verdict}`);
		}
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
		errors.push("semantic: Stage 10B suite set drifted");
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
		["telemetry", "telemetry-guard", TELEMETRY_GUARD_SCRIPT],
		["ci", "ci-guard", CI_GUARD_SCRIPT],
		["openspec", "openspec-guard", OPENSPEC_GUARD_SCRIPT],
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
		renders["commandId"] !== "rendered-telemetry" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_TEN_B_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-telemetry", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 10B render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_TEN_B_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			(enabled ? !sameValue(gated, [...ADDED_PATHS]) : gated.length !== 0) ||
			scripts.includes(TELEMETRY_GUARD_SCRIPT) !== enabled ||
			fixture["telemetryStepPresent"] !== enabled ||
			// The signature tokens, over every project file of the render. Both
			// directions are asserted: exactly zero where the capability is off, and
			// more than zero where it is on, because a render that enabled the
			// capability and still carried no mention of it would mean the surface
			// was stripped from the project that asked for it.
			(enabled
				? Number(fixture["telemetryTokenFiles"] ?? 0) < 1
				: fixture["telemetryTokenFiles"] !== 0) ||
			// The guard runs over the render and returns a real verdict where the
			// capability is on, and is not there at all where it is off.
			(enabled
				? arrayAt(fixture, "telemetryErrors").length !== 0
				: fixture["guardPresent"] !== false) ||
			arrayAt(fixture, "residueFindings").length > 0 ||
			// The reserved configuration root is empty in EVERY render, enabled or
			// not: gating it is a claim about where an artifact would live, not a
			// promise to create one.
			fixture["reservedRootFiles"] !== 0 ||
			// The four core workflow credential rules ship to every project,
			// whatever it disables — the renderer has no inverse fence, so a rule
			// that arrived with a capability would be a rule the projects without it
			// never receive.
			fixture["workflowGuardPresent"] !== true
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} telemetry evidence drifted`,
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
			[...STAGE_TEN_B_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 10B coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_TEN_B_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-10b-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable, no
		// branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== true ||
		!String(rollback["scope"] ?? "").includes("one container rebuild") ||
		!String(rollback["scope"] ?? "").includes("order-independent")
	)
		errors.push("semantic: Stage 10B rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 10B rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageTenBEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-10b-telemetry.json");
	const schemaPath = resolve(root, "evidence/stage-10b-telemetry.schema.json");
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-10b-telemetry.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return ["repository: evidence/stage-10b-telemetry.schema.json is missing"];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-10b-telemetry.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageTenBEvidenceValue(value, schema, root);
}
