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
import { validateJsonSchema } from "./json-schema";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_TEN_D_COMMAND_IDS = [
	// The three guards this stage touches: the one it adds, the CORE toolchain
	// guard whose coupled family it extends, and the workflow contract whose
	// required lane now carries a fenced step.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log.
	"start-guard",
	"family-guard",
	"ci-guard",
	// The whole refusal matrix, and then each leg on its own. The legs are not a
	// decomposition for tidiness: a suite-wide green says the file passed, and
	// what this record has to be able to say is that THIS rule was exercised.
	"start-mutations",
	"tsconfig-mutations",
	"family-mutations",
	"ssr-policy",
	"worker-config",
	"built-artifact",
	"namespace-drift",
	"route-tree",
	"router-options",
	"proxy-reconciliation",
	// The executed halves. The typecheck leg runs the REAL compiler over a
	// synthetic project that genuinely extends the repaired base, because the
	// defect this stage repairs is invisible to a build and to a reader of the
	// JSON alike: `types` is a list only the typechecker reads.
	"tsconfig-typecheck",
	// ... and the server render and the browser mutation, driven over one origin
	// through the declared proxy route table.
	"ssr-read-through-proxy",
	"browser-mutation-through-proxy",
	// The probe that answers a question no committed test can seal: what each
	// fixture actually received.
	"rendered-start",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageTenDCommandId = (typeof STAGE_TEN_D_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-10d-start-run";
const COLLECTOR = "scripts/template/collect-stage-ten-d-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CAPABILITY = "tanstack_start";
const START_GUARD_SCRIPT = "start:check";
const FAMILY_GUARD_SCRIPT = "toolchain:check";
const CI_GUARD_SCRIPT = "ci:check";
const START_MUTATION_TEST = "scripts/template/__tests__/start.test.ts";
const FAMILY_MUTATION_TEST = "scripts/template/__tests__/toolchain.test.ts";
const HARNESS_FIXTURE =
	"scripts/template/__tests__/fixtures/start-ssr-harness.ts";
const REGISTRY_PATH = "start-surface.json";
const LOCK_PATH = "bun.lock";

// The declared tree state. It is sealed rather than read back out of the
// registry at validation time, because "the guard agreed with the registry" is
// a different claim from "the registry still says what it said when this
// evidence was captured" — and this record is making the second one.
export const DECLARED_MODE = "skeleton";

// The two policy decisions this stage exists to make explicit, sealed so a
// later flip has to move the record with it.
export const DEV_SERVER = "wrangler";
export const SSR_MODE = "buffered";

// The shared TypeScript base this stage repairs, and the entry it carried since
// Stage 0. The entry names a subpath the router package does not export, so the
// compiler fails on it with TS2688 — and nothing ever reported it, because the
// build ignores `types` entirely and no project in this repository extends the
// file. It is sealed as FORBIDDEN rather than merely removed, because removing
// it fixes this file and leaves the class open.
export const REPAIRED_TSCONFIG = "tsconfig.start.base.json";
export const REPOSITORY_TSCONFIG_BASE = "tsconfig.base.json";
export const FORBIDDEN_TYPE_ENTRY = "@tanstack/react-router/globals";
export const TYPECHECK_DIAGNOSTIC = "TS2688";
export const STALE_INCLUDE_DIAGNOSTIC = "TS18003";

// The Stage 10C merge on main, which is this stage's predecessor and the tree
// the rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_TEN_C_MERGE_SHA = "4859e086be715206c7a83ec089b7475d40a274e3";

// The paths this stage adds and this capability owns. A revert has to take
// every one of them back out, which is the additive half of the rollback proof:
// the reverted tree carries none of them and the implementation tree carries
// all of them.
//
// `tsconfig.start.base.json` is deliberately NOT here: Stage 0 created and
// gated it, this stage REPAIRS it, and a revert restores the broken version
// rather than deleting the file.
export const ADDED_PATHS = [
	"start-surface.json",
	"start-surface.schema.json",
	"scripts/template/start-contract.ts",
	"scripts/template/validate-start.ts",
] as const;

/**
 * The coupled Cloudflare family, with the resolutions measured at capture time.
 *
 * Five members already existed. `vite` is the one this stage adds, and the
 * reason it had to be added is that `@cloudflare/vite-plugin` IS the plugin the
 * requirement names, whose whole job is to be loaded by a build tool nothing
 * governed. The peer range is the PLUGIN'S OWN declared range, read out of the
 * lock rather than typed here, so the rule cannot go stale against an upgrade.
 */
export const CLOUDFLARE_FAMILY = {
	"@cloudflare/vite-plugin": "1.43.0",
	"@cloudflare/vitest-pool-workers": "0.18.0",
	wrangler: "4.107.0",
	miniflare: "4.20260701.0",
	workerd: "1.20260701.1",
	vite: "8.1.4",
} as const;

export const BUILD_TOOL_PEER_RANGE = "^6.1.0 || ^7.0.0 || ^8.0.0";

// Every listener the executed harness binds, and the port every one of them
// asks for. Recorded as the DECLARED bind rather than the ephemeral value the
// kernel happened to hand back: the ephemeral number is a fact about one run on
// one machine and is not evidence of anything, while "every listener asked for
// an ephemeral port" is the property that keeps two worktrees from colliding.
export const HARNESS_BIND_PORT = 0;
export const HARNESS_LISTENERS = 2;

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"start-guard": ["bun", "run", START_GUARD_SCRIPT],
	"family-guard": ["bun", "run", FAMILY_GUARD_SCRIPT],
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
 *
 * One leg points at a DIFFERENT suite, and that difference is the shape of this
 * stage: the Cloudflare pin family is a CORE rule under a `cloudflare_workers`
 * fence, not a gated one, so it is exercised by the core toolchain suite and
 * must hold in a render where this capability is off and that one is on.
 */
export const MUTATION_LEGS = {
	"tsconfig-typecheck": {
		testFile: START_MUTATION_TEST,
		pattern: "the shared TypeScript base, compiled for real",
	},
	"tsconfig-mutations": {
		testFile: START_MUTATION_TEST,
		pattern: "the shared TypeScript base, as a declaration",
	},
	"family-mutations": {
		testFile: FAMILY_MUTATION_TEST,
		pattern: "the Cloudflare family governs the build tool it is loaded by",
	},
	"ssr-policy": {
		testFile: START_MUTATION_TEST,
		pattern: "the server render policy is a declared matrix",
	},
	"worker-config": {
		testFile: START_MUTATION_TEST,
		pattern: "the hand-written worker configuration is reconciled",
	},
	"built-artifact": {
		testFile: START_MUTATION_TEST,
		pattern: "the built worker configuration is the only portable proof",
	},
	"namespace-drift": {
		testFile: START_MUTATION_TEST,
		pattern: "the asset namespace is one decision spelled three ways",
	},
	"route-tree": {
		testFile: START_MUTATION_TEST,
		pattern: "the generated route tree is governed as a committed artefact",
	},
	"router-options": {
		testFile: START_MUTATION_TEST,
		pattern: "the router options are decisions rather than defaults",
	},
	"proxy-reconciliation": {
		testFile: START_MUTATION_TEST,
		pattern: "the declared capability dependency",
	},
	"ssr-read-through-proxy": {
		testFile: START_MUTATION_TEST,
		pattern: "a document read through the declared proxy is exactly one",
	},
	"browser-mutation-through-proxy": {
		testFile: START_MUTATION_TEST,
		pattern: "a browser mutation shares the origin, is stripped",
	},
} as const;

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are LITERAL FRAGMENTS rather than whole sentences, and that is not
 * laziness: almost every refusal this guard produces is assembled with template
 * interpolation, so the complete sentence never appears anywhere in the suite's
 * source and sealing it would bind the record to a string no file contains. The
 * previous stage's collector caught exactly that before it wrote anything, and
 * this record keeps the same self-validation for the same reason.
 */
export const REQUIRED_MUTATIONS = [
	// Mode reconciliation, one case per derived shape, both directions.
	"declares skeleton mode but apps/platform-start/src/nested/",
	"is a generated route tree, and its presence is what marks this project as carrying an application of this stack",
	"declares skeleton mode but apps/platform-start/package.json depends on",
	"extends ${TSCONFIG_PATH}, so the shared base is compiled by something",
	"declares skeleton mode but declares 1 applications",
	"declares active mode but declares no application",
	"declares active mode but no tracked file carries a generated route tree",
	"a rule with no input has answered nothing",
	// Sole declarations.
	"is a second application surface registry",
	"is claimed by both platform and second",
	// Wiring and ownership.
	"package script start:check must run scripts/template/validate-start.ts",
	"must sit inside a tanstack_start capability fence",
	"step must not be conditional",
	"must be gated by the capability",
	"must be a declared capability signature",
	"must leave the advertisedOnly inventory",
	"must leave the absent inventory",
	"package rule must strip the start:check script",
	"template ownership must cover scripts/template/start-contract.ts",
	// The declared capability dependency, read as data and never imported.
	"is absent, so the development proxy route table was declared elsewhere and not reconciled",
	"is absent, so the declared proxy route platform was declared and not reconciled",
	"declares the proxy route platform, which",
	"is refused in every tsconfig by toolchain:check",
	// The development runtime.
	"declares a bundler development server; the built worker under the pinned command-line tool is the declared runtime",
	"carries a development server waiver that lifts nothing; a stale exemption widens itself",
	// The shared TypeScript base — the executed proof and the declaration.
	"error TS2688",
	"@tanstack/react-router/globals",
	"error TS18003",
	"must extend tsconfig.base.json; a base that restates a weaker option set",
	"must set strict to true",
	"must resolve modules as bundler",
	"must declare jsx",
	"which no declared application produces; an include entry that can never match",
	"must be an independent ordinary in-tree file with exactly one hard link",
	"which does not resolve; the build never reads this list and only the typechecker does",
	"declares the forbidden type entry",
	"no module resolver is available under",
	// The server render policy.
	"declares a streamed server render; the buffered render is the declared default",
	"carries a streaming waiver that lifts nothing; a stale exemption widens itself",
	"a document is a read, and HEAD is answered with GET semantics minus the body",
	"a document route that answers anything but 405 has told the caller the wrong thing",
	"these payloads are per-user and must never be shared-cached, on every response class alike",
	// The worker configuration.
	"omits the compatibility flag ${COMPATIBILITY_FLAG}; this stack's server bundle requires it",
	"must declare workers_dev as false",
	"must declare preview_urls as false",
	"hand-writes an assets block; the plugin synthesizes it into the generated configuration",
	"which ${REGISTRY_PATH} does not declare; the allowlist is closed",
	"declares the forbidden binding kind kv_namespaces",
	// The built artefact.
	"ships the forbidden binding kind d1_databases in a deploy artefact",
	"ships the harness-only variable START_E2E_READ_ORACLE in a deploy artefact",
	"is absent, so the built worker configuration of platform was declared and not reconciled",
	// Namespace, route tree and router.
	"the public prefix and the router basepath are two spellings of one decision",
	"rewriting document URLs does not move the directory the asset binding serves",
	"is ignored by .gitignore; this route tree is governed as a committed artefact",
	"is not excluded from the formatter and the linter in biome.jsonc",
	"declares no default error component; without one the router installs NO catch boundary",
	"enables router-wide preloading; only source-audited high-frequency link sites should speculate",
	// Non-vacuity, and the compiler that must be a named failure rather than a
	// skipped leg.
	"the TypeScript compiler API is unavailable; run bun install before start:check",
] as const;

/**
 * The CORE family refusals, which live in a different suite for a reason the
 * record has to state: they are fenced on the capability this one DEPENDS ON.
 */
export const REQUIRED_FAMILY_MUTATIONS = [
	"lock: vite must resolve exactly once, found 2 entries (8.1.4, 8.1.5)",
	"lock: build tool 9.0.0 is outside the Cloudflare plugin peer range ^6.1.0 || ^7.0.0 || ^8.0.0",
	"lock: the Cloudflare plugin declares no build tool peer range to reconcile",
	"the build tool and its plugins move with the Cloudflare family or not at all",
] as const;

// The committed suites this record cites, and the file each one is. A coverage
// claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "start-mutations", testFile: START_MUTATION_TEST },
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
 * anything and the selection is FULL by construction. This stage has a second,
 * independent reason — `tsconfig*.json` is a `GLOBAL_PATTERNS` entry, and this
 * stage edits one.
 */
export const EXPECTED_OBSERVATIONS = [
	{
		id: "live-gate",
		conclusion: "success",
		event: "pull_request",
		heavyLaneRan: true,
	},
] as const;

export type StageTenDObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

export const STAGE_TEN_D_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false, cloudflareEnabled: false },
	// The fixture that proves the split: Cloudflare ON, this capability OFF. The
	// coupled pin family must hold there, and none of this stage's gated surface
	// may appear.
	{ name: "cloud", capabilityEnabled: false, cloudflareEnabled: true },
	{ name: "full", capabilityEnabled: true, cloudflareEnabled: true },
] as const;

export const STAGE_TEN_D_COVERAGE_IDS = [
	"declared-surface",
	"strict-typescript-base",
	"cloudflare-pin-family",
	"server-render-policy",
	"worker-configuration",
	"built-artifact",
	"asset-namespace",
	"route-tree",
	"declared-dependency",
	"executed-read-and-mutation",
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
export function expectedStageTenDCommands(
	value: JsonRecord,
): Record<StageTenDCommandId, string[]> {
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
		"start-guard": [...REQUIRED_VALIDATIONS["start-guard"]],
		"family-guard": [...REQUIRED_VALIDATIONS["family-guard"]],
		"ci-guard": [...REQUIRED_VALIDATIONS["ci-guard"]],
		"start-mutations": ["bun", "test", START_MUTATION_TEST],
		...legs,
		"rendered-start": [
			"bun",
			COLLECTOR,
			"probe-render-start",
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

function parseJsonc(value: string): JsonRecord {
	try {
		const parsed = Bun.JSONC.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
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

/** Every resolution of one package in the lock, matched the way the guard does. */
function lockResolutions(lock: string, packageName: string): string[] {
	const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [...lock.matchAll(new RegExp(`\\["${escaped}@([^"\\s]+)"`, "g"))].map(
		(match) => match[1] ?? "",
	);
}

export async function validateStageTenDEvidenceValue(
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
	const expected = expectedStageTenDCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_TEN_D_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 10D command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 10D command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTenDCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 10D capture command is expected to pass. The refusals are
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
	if (baseSha !== STAGE_TEN_C_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 10C merge");
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

	// The declared surface, bound to the committed registry. `skeleton` with no
	// application is the whole claim: this template ships the guard and the
	// policy and no application for them to govern.
	const registry = parseJson(
		await Bun.file(resolve(root, REGISTRY_PATH))
			.text()
			.catch(() => ""),
	);
	if (
		source["declaredMode"] !== DECLARED_MODE ||
		registry["mode"] !== DECLARED_MODE ||
		!sameValue(registry["apps"], [])
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares ${DECLARED_MODE} mode with no application`,
		);
	if (
		source["devServer"] !== DEV_SERVER ||
		registry["devServer"] !== DEV_SERVER ||
		registry["viteDevWaiver"] !== null
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares the ${DEV_SERVER} development runtime without a waiver`,
		);
	const ssr = isRecord(registry["ssr"]) ? registry["ssr"] : {};
	if (
		source["ssrMode"] !== SSR_MODE ||
		ssr["mode"] !== SSR_MODE ||
		ssr["streamingWaiver"] !== null
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares a ${SSR_MODE} server render without a waiver`,
		);

	// The repair. The reserved entry is gone from the base, the base extends the
	// repository base, and the entry is declared FORBIDDEN rather than merely
	// removed — because removing it fixes this file and leaves the class open.
	// Parsed rather than searched, because this file carries comments explaining
	// what was removed and a substring sweep would find the removed thing in the
	// sentence that says it is gone.
	const repaired = parseJsonc(
		await Bun.file(resolve(root, REPAIRED_TSCONFIG))
			.text()
			.catch(() => ""),
	);
	const repairedOptions = recordAt(repaired, "compilerOptions");
	if (
		source["repairedTsconfig"] !== REPAIRED_TSCONFIG ||
		repaired["extends"] !== `./${REPOSITORY_TSCONFIG_BASE}` ||
		!sameValue(repairedOptions["types"], []) ||
		(Array.isArray(repaired["include"]) &&
			repaired["include"].includes("app.config.ts"))
	)
		errors.push(
			`repository: ${REPAIRED_TSCONFIG} is not the repaired strict base this record sealed`,
		);
	if (
		!sameValue(arrayAt(source, "forbiddenTypes"), [FORBIDDEN_TYPE_ENTRY]) ||
		!sameValue(registry["forbiddenTypes"], [FORBIDDEN_TYPE_ENTRY]) ||
		!sameValue(registry["types"], [])
	)
		errors.push(
			`semantic: ${FORBIDDEN_TYPE_ENTRY} is no longer declared forbidden`,
		);

	// The Cloudflare family, with the resolutions this record measured. `vite` is
	// the member this stage adds, and the whole point is that it must resolve
	// exactly once and satisfy the PLUGIN'S OWN declared range.
	const lock = await Bun.file(resolve(root, LOCK_PATH))
		.text()
		.catch(() => "");
	const sealedFamily = recordAt(source, "cloudflareFamily");
	for (const [name, version] of Object.entries(CLOUDFLARE_FAMILY)) {
		const resolutions = lockResolutions(lock, name);
		if (
			sealedFamily[name] !== version ||
			resolutions.length !== 1 ||
			resolutions[0] !== version
		)
			errors.push(
				`repository: ${LOCK_PATH} no longer resolves ${name} exactly once at ${version}`,
			);
	}
	if (
		source["buildToolPeerRange"] !== BUILD_TOOL_PEER_RANGE ||
		!lock.includes(`"vite": "${BUILD_TOOL_PEER_RANGE}"`)
	)
		errors.push(
			"semantic: the sealed build tool peer range is not the plugin's declared one",
		);
	// The lockfile did not move, which is what makes the family rule a RULE
	// rather than a pin. Four consecutive stages now.
	if (
		source["lockfileChanged"] !== false ||
		git(root, ["diff", "--quiet", baseSha, implementationSha, "--", LOCK_PATH])
			.exitCode !== 0
	)
		errors.push("semantic: Stage 10D changed the lockfile");

	// The harness binds ephemeral ports, and the record seals the DECLARED bind
	// rather than the number one run happened to receive.
	const harness = await Bun.file(resolve(root, HARNESS_FIXTURE))
		.text()
		.catch(() => "");
	const binds = harness.split("hostname: LOOPBACK,").length - 1;
	const ephemeral = harness.split(`port: ${HARNESS_BIND_PORT},`).length - 1;
	if (
		source["harnessBindPort"] !== HARNESS_BIND_PORT ||
		source["harnessListeners"] !== HARNESS_LISTENERS ||
		binds !== HARNESS_LISTENERS ||
		ephemeral !== HARNESS_LISTENERS
	)
		errors.push(
			`semantic: ${HARNESS_FIXTURE} no longer binds ${HARNESS_LISTENERS} loopback listeners on an ephemeral port`,
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
		repository["startGuardScript"] !== START_GUARD_SCRIPT ||
		repository["familyGuardScript"] !== FAMILY_GUARD_SCRIPT ||
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
		entry.run.includes(`bun run ${START_GUARD_SCRIPT}`),
	);
	if (!step || step.conditional)
		errors.push(
			`semantic: ${START_GUARD_SCRIPT} is not an unconditional step of the required lane`,
		);
	if (fenceAround(workflow, `bun run ${START_GUARD_SCRIPT}`) !== CAPABILITY)
		errors.push(
			`semantic: the ${START_GUARD_SCRIPT} step is not fenced on ${CAPABILITY}`,
		);
	if (repository["addedJobs"] !== 0 || declaredNeeds.includes("start"))
		errors.push("semantic: Stage 10D must add no job to the required lane");
	// The one thing that would have cost a container rebuild, asserted rather
	// than promised: not a byte under `.devcontainer/` differs between the
	// predecessor and the boundary.
	if (
		repository["devcontainerFilesChanged"] !== 0 ||
		git(root, [
			"diff",
			"--quiet",
			baseSha,
			implementationSha,
			"--",
			".devcontainer",
		]).exitCode !== 0
	)
		errors.push(
			"semantic: Stage 10D changed a definition fingerprint input under .devcontainer",
		);

	// The refusal matrix. A record may claim this surface is guarded only while
	// every recorded diagnostic is still asserted by a committed test — and the
	// fragments are literal because the sentences themselves are interpolated.
	const mutationSource = await Bun.file(resolve(root, START_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(
				`repository: ${START_MUTATION_TEST} no longer asserts ${verdict}`,
			);
	}
	const familySource = await Bun.file(resolve(root, FAMILY_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_FAMILY_MUTATIONS) {
		if (!familySource.includes(verdict))
			errors.push(
				`repository: ${FAMILY_MUTATION_TEST} no longer asserts ${verdict}`,
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
		errors.push("semantic: Stage 10D suite set drifted");
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
		["start", "start-guard", START_GUARD_SCRIPT],
		["family", "family-guard", FAMILY_GUARD_SCRIPT],
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
	// The executed compiler proofs, bound to the log the leg wrote rather than
	// asserted about. TS2688 is the defect this stage repairs and TS18003 is the
	// one a stale include entry would produce; both are observed by a suite that
	// passes BY observing them, so the leg's own output is where they appear.
	const typecheckLog = `${log("tsconfig-typecheck", "stdout")}${log("tsconfig-typecheck", "stderr")}`;
	const typecheck = recordAt(value, "typecheckProof");
	if (
		typecheck["commandId"] !== "tsconfig-typecheck" ||
		typecheck["forbiddenEntry"] !== FORBIDDEN_TYPE_ENTRY ||
		typecheck["mutationDiagnostic"] !== TYPECHECK_DIAGNOSTIC ||
		typecheck["staleIncludeDiagnostic"] !== STALE_INCLUDE_DIAGNOSTIC ||
		Number(typecheck["passCount"] ?? 0) < 2 ||
		!typecheckLog.includes("0 fail")
	)
		errors.push("semantic: Stage 10D typecheck proof drifted");

	// Capability isolation, per fixture.
	const renders = recordAt(value, "renderFixtures");
	const fixtures = arrayAt(renders, "fixtures").filter(isRecord);
	if (
		renders["commandId"] !== "rendered-start" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_TEN_D_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-start", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 10D render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_TEN_D_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			// Sorted on both sides: the probe reports what it found in path order,
			// and this capability's four paths do not happen to be declared in it.
			(enabled
				? !sameValue(gated, [...ADDED_PATHS].sort())
				: gated.length !== 0) ||
			scripts.includes(START_GUARD_SCRIPT) !== enabled ||
			fixture["startStepPresent"] !== enabled ||
			// The shared base is a Stage 0 reservation gated on this capability, so
			// it travels with the surface in both directions.
			fixture["repairedTsconfigPresent"] !== enabled ||
			// The signature tokens, over every project file of the render. Both
			// directions are asserted: exactly zero where the capability is off, and
			// more than zero where it is on, because a render that enabled the
			// capability and still carried no mention of it would mean the surface
			// was stripped from the project that asked for it.
			(enabled
				? Number(fixture["startTokenFiles"] ?? 0) < 1
				: fixture["startTokenFiles"] !== 0) ||
			// The guard runs over the render and returns a real verdict where the
			// capability is on, and is not there at all where it is off.
			(enabled
				? arrayAt(fixture, "startErrors").length !== 0
				: fixture["guardPresent"] !== false) ||
			arrayAt(fixture, "residueFindings").length > 0 ||
			// The CORE half, and the reason it is core: the coupled pin family is
			// fenced on the capability this one DEPENDS ON, so it must be present in
			// the render where Cloudflare is on and this capability is off, and gone
			// where Cloudflare is off.
			fixture["cloudflareEnabled"] !== declared.cloudflareEnabled ||
			fixture["buildToolFamilyPresent"] !== declared.cloudflareEnabled
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} start evidence drifted`,
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
			// The heavy lane ran: a code change cannot be narrowed away here, and
			// this stage edits a global pattern besides.
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
			[...STAGE_TEN_D_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 10D coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_TEN_D_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-10d-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable, no
		// branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild") ||
		!String(rollback["scope"] ?? "").includes("order-independent")
	)
		errors.push("semantic: Stage 10D rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		proof["repairedTsconfigRestored"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 10D rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageTenDEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-10d-start.json");
	const schemaPath = resolve(root, "evidence/stage-10d-start.schema.json");
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-10d-start.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return ["repository: evidence/stage-10d-start.schema.json is missing"];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-10d-start.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageTenDEvidenceValue(value, schema, root);
}
