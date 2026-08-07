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

export const STAGE_TEN_C_COMMAND_IDS = [
	// The three guards this stage touches: the one it adds, the workflow contract
	// whose required lane now carries a fenced step, and the worktree runtime
	// contract the registry reconciles its published port and friendly domain
	// against.
	//
	// `template:validate` is deliberately NOT here. It aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates: run before the record exists it fails, and run after it can
	// never seal its own log.
	"proxy-guard",
	"ci-guard",
	"worktree-guard",
	// The whole refusal matrix, and then each leg on its own. The legs are not a
	// decomposition for tidiness: a suite-wide green says the file passed, and
	// what this record has to be able to say is that THIS rule was exercised.
	"proxy-mutations",
	"config-identity",
	"route-shape",
	"dev-preview-alignment",
	"reachability",
	"host-validation",
	"hmr-policy",
	"renderer-drift",
	// The executed half. A structural guard can be perfect about a proxy that
	// never forwards a byte, which is the whole reason this stage exists, so the
	// handshakes are RUN rather than asserted about.
	"http-through-proxy",
	"websocket-handshake",
	"hmr-handshake",
	// The probe that answers a question no committed test can seal: what each
	// fixture actually received.
	"rendered-proxy",
	// The one thing in this record this repository cannot fabricate.
	"live-gate",
	"rollback-proof",
] as const;

export type StageTenCCommandId = (typeof STAGE_TEN_C_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-10c-proxy-run";
const COLLECTOR = "scripts/template/collect-stage-ten-c-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CAPABILITY = "vite_websocket_proxy";
const PROXY_GUARD_SCRIPT = "proxy:check";
const CI_GUARD_SCRIPT = "ci:check";
const WORKTREE_GUARD_SCRIPT = "worktree:check";
const PROXY_MUTATION_TEST = "scripts/template/__tests__/proxy.test.ts";
const HARNESS_FIXTURE =
	"scripts/template/__tests__/fixtures/websocket-harness.ts";
const REGISTRY_PATH = "proxy-routes.json";
const WORKTREE_CONTRACT_PATH = "scripts/worktree/contract.toml";

// The declared tree state. It is sealed rather than read back out of the
// registry at validation time, because "the guard agreed with the registry" is
// a different claim from "the registry still says what it said when this
// evidence was captured" — and this record is making the second one.
export const DECLARED_MODE = "skeleton";

// The single port that crosses the container boundary, and the reason this
// stage adds none. Sealed here and reconciled with both the registry and the
// worktree runtime contract, because the whole reachability argument rests on
// there being exactly one.
export const PUBLISHED_CONTAINER_PORT = 8080;

// The Stage 10B merge on main, which is this stage's predecessor and the tree
// the rollback proof reverts back to. Sealed rather than resolved so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_TEN_B_MERGE_SHA = "99acb85e9a41c447f836a76339d80992efb8be54";

// The paths this stage adds and this capability owns. A revert has to take
// every one of them back out, which is the additive half of the rollback proof:
// the reverted tree carries none of them and the implementation tree carries
// all of them.
export const ADDED_PATHS = [
	"proxy-routes.json",
	"proxy-routes.schema.json",
	"scripts/template/proxy-contract.ts",
	"scripts/template/validate-proxy.ts",
] as const;

// The configuration path Stage 0 pre-declared for this capability. Nothing
// creates it, and the record says so on purpose: a reservation is where the
// artifact WOULD live, not a promise to create one — the template ships no
// application, so a committed configuration would declare routes to nothing.
export const RESERVED_CONFIG_PATH = "vite.config.ts";

// Every listener the executed harness binds, and the port every one of them
// asks for. Recorded as the DECLARED bind rather than the ephemeral value the
// kernel happened to hand back: the ephemeral number is a fact about one run on
// one machine and is not evidence of anything, while "every listener asked for
// an ephemeral port" is the property that keeps two worktrees from colliding.
export const HARNESS_BIND_PORT = 0;
export const HARNESS_LISTENERS = 3;

// The validations whose exact argv the record pins, and the log basenames they
// write. A guard cited by the coverage map has to have been RUN, with the
// command the package script actually exposes.
export const REQUIRED_VALIDATIONS = {
	"proxy-guard": ["bun", "run", PROXY_GUARD_SCRIPT],
	"ci-guard": ["bun", "run", CI_GUARD_SCRIPT],
	"worktree-guard": ["bun", "run", WORKTREE_GUARD_SCRIPT],
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
 * Every leg points at the same suite, and that is not an oversight: unlike the
 * previous stage this one adds no core rule at all, so there is no unfenced
 * behaviour for a core suite to exercise. The README says why in as many words.
 */
export const MUTATION_LEGS = {
	"config-identity": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "configuration identity and shape",
	},
	"route-shape": { testFile: PROXY_MUTATION_TEST, pattern: "route shape" },
	"dev-preview-alignment": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "dev and preview alignment",
	},
	reachability: { testFile: PROXY_MUTATION_TEST, pattern: "reachability" },
	"host-validation": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "host validation",
	},
	"hmr-policy": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "hot reload and asset origin policy",
	},
	"renderer-drift": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "the renderer and its drift leg",
	},
	"http-through-proxy": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "http and a real socket both reach the upstream",
	},
	"websocket-handshake": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "an executed websocket handshake",
	},
	"hmr-handshake": {
		testFile: PROXY_MUTATION_TEST,
		pattern: "an executed hot reload handshake",
	},
} as const;

/**
 * The refusal matrix, as the diagnostics a committed test must still assert.
 *
 * These are the sentences the guard prints when it refuses, and the record may
 * claim the development-server surface is guarded only while every one of them
 * is still asserted by a committed test. A suite that lost a case would
 * otherwise keep passing and keep being cited.
 */
export const REQUIRED_MUTATIONS = [
	// Mode reconciliation, one case per derived shape, both directions.
	"is a build-tool configuration file, and its presence is what marks this project as having a development server",
	"declares skeleton mode but apps/web/vite.config.mts is a build-tool configuration file",
	"declares skeleton mode but apps/web/src/config.ts declares a development or preview proxy table",
	"declares skeleton mode but package.json pins the build tool as a direct dependency",
	"declares skeleton mode but declares a server, a preview server or a route",
	"declares active mode but no tracked file carries a build-tool configuration or a proxy table",
	"declares active mode but leaves the development or preview server null",
	"declares active mode but declares no route",
	// Sole declarations.
	"is a second proxy route registry",
	"is a second route named api",
	"is declared as both api and socket",
	// Wiring and ownership.
	"package script proxy:check must run scripts/template/validate-proxy.ts",
	"must sit inside a vite_websocket_proxy capability fence",
	"step must not be conditional",
	"must be gated by the capability",
	"must be a declared capability signature",
	"must leave the absent inventory",
	// The worktree reconciliation, and the notice that says it could not happen.
	"declares the published container port 8081 and",
	"is absent, so the published port 8080 and the friendly domain",
	// Configuration identity, ported refusal by refusal.
	"must be an independent ordinary in-tree file with exactly one hard link",
	"must not contain an export = assignment",
	"must contain exactly one effective default export",
	"exported configuration must be an object literal",
	"must have exactly one unaliased runtime named import from the build tool",
	// Route shape — the heart of the stage.
	"is a string shorthand; a string target never proxies a WebSocket upgrade",
	"does not declare ws; a route that never states whether it forwards the upgrade has not decided",
	"does not declare changeOrigin",
	"does not declare secure",
	"rewrites its path and forwards the upgrade; path rewriting and WebSocket upgrade forwarding do not compose",
	"is not loopback; a proxy target that names another host is an unintended external call",
	"binds the wildcard address, which is not an address a client connects to",
	"carries a path, a query or a fragment; a proxy target is an origin",
	"which no declared upstream binds",
	"which no declared route targets",
	"targets a socket scheme and does not forward the upgrade",
	"disables certificate verification against an https target",
	// Alignment.
	"a surface that disappears in preview is a surface nobody tested",
	"forwards the upgrade for one server and not the other",
	// Host validation.
	"is a wildcard; an allowlist that can match a host nobody enumerated is a disabled defense",
	"disables the host check entirely",
	"the loopback family and the friendly domain are both browser-visible and both must be listed",
	"that is a disabled Cross-Site WebSocket Hijacking defense, not a convenience",
	// Reachability.
	"does not pin strictPort; a server that silently takes the next free port maps the published port to nothing",
	"a server bound to the container's loopback is unreachable through the published port",
	"declares no fronting service; nothing binds the published container port",
	"declares the fronting service caddy, which",
	"exactly one process binds that port",
	// The HMR and asset-origin policy.
	"pins the asset origin",
	"pins the reload client port",
	"which is an internal port no browser ever dials",
	"disables hot module replacement while the capability that exists to make it work is enabled",
	// The renderer and its drift leg.
	"edit the registry and re-render rather than the generated file",
	// The runtime policy.
	"that combination was measured to accept the upgrade and never flush a byte back",
	"carries a runtime waiver that lifts nothing; a stale exemption widens itself",
	// Non-vacuity.
	"a rule with no input has answered nothing",
	"the TypeScript compiler API is unavailable",
] as const;

// The three committed suites this record cites, and the file each one is. A
// coverage claim naming a suite that does not exist is a claim about nothing.
export const EXPECTED_MUTATION_TESTS = [
	{ commandId: "proxy-mutations", testFile: PROXY_MUTATION_TEST },
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

export type StageTenCObservationId =
	(typeof EXPECTED_OBSERVATIONS)[number]["id"];

export const STAGE_TEN_C_FIXTURES = [
	{ name: "minimal", capabilityEnabled: false },
	{ name: "cloud", capabilityEnabled: false },
	{ name: "full", capabilityEnabled: true },
] as const;

export const STAGE_TEN_C_COVERAGE_IDS = [
	"declared-surface",
	"forwarding-routes",
	"config-identity",
	"dev-preview-alignment",
	"reachability",
	"host-validation",
	"hot-reload-policy",
	"generated-config",
	"executed-handshake",
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
export function expectedStageTenCCommands(
	value: JsonRecord,
): Record<StageTenCCommandId, string[]> {
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
		"proxy-guard": [...REQUIRED_VALIDATIONS["proxy-guard"]],
		"ci-guard": [...REQUIRED_VALIDATIONS["ci-guard"]],
		"worktree-guard": [...REQUIRED_VALIDATIONS["worktree-guard"]],
		"proxy-mutations": ["bun", "test", PROXY_MUTATION_TEST],
		...legs,
		"rendered-proxy": [
			"bun",
			COLLECTOR,
			"probe-render-proxy",
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

/** One scalar out of the worktree runtime contract, without a TOML parser. */
function tomlScalar(source: string, key: string): string | undefined {
	const match = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(source);
	const raw = match?.[1];
	if (raw === undefined) return undefined;
	return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

export async function validateStageTenCEvidenceValue(
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
	const expected = expectedStageTenCCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_TEN_C_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 10C command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 10C command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTenCCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 10C capture command is expected to pass. The refusals are
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
	if (baseSha !== STAGE_TEN_B_MERGE_SHA)
		errors.push("semantic: the sealed predecessor is not the Stage 10B merge");
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

	// The declared tree state, bound to the committed registry. `skeleton` with a
	// null server, a null preview server and no route is the whole claim: this
	// template ships the guard and the renderer and no configuration for them to
	// govern, because it ships no application either.
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
		registry["server"] !== null ||
		registry["preview"] !== null ||
		!sameValue(registry["routes"], []) ||
		!sameValue(registry["upstreams"], [])
	)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer declares an empty development server surface`,
		);
	if (registry["configPath"] !== RESERVED_CONFIG_PATH)
		errors.push(
			`repository: ${REGISTRY_PATH} no longer names ${RESERVED_CONFIG_PATH}`,
		);
	// The reserved configuration path is gated and absent, and both halves are the
	// point: gated so the first downstream project to write one is governed,
	// absent because a reservation is not a promise to create anything.
	if (git(root, ["ls-files", RESERVED_CONFIG_PATH]).stdout.trim() !== "")
		errors.push(
			`repository: ${RESERVED_CONFIG_PATH} is reserved and must stay absent in the template`,
		);

	// The published port, reconciled three ways: the sealed number, the registry
	// that declares it, and the worktree runtime contract that owns it. The whole
	// reachability argument rests on there being exactly one such port.
	const worktreeContract = await Bun.file(resolve(root, WORKTREE_CONTRACT_PATH))
		.text()
		.catch(() => "");
	if (
		source["publishedContainerPort"] !== PUBLISHED_CONTAINER_PORT ||
		registry["publishedContainerPort"] !== PUBLISHED_CONTAINER_PORT ||
		Number(tomlScalar(worktreeContract, "published_container_port") ?? -1) !==
			PUBLISHED_CONTAINER_PORT
	)
		errors.push(
			"semantic: the published container port is not the one every authority declares",
		);
	if (
		registry["friendlyDomainPattern"] !==
		tomlScalar(worktreeContract, "friendly_domain_pattern")
	)
		errors.push(
			`semantic: ${REGISTRY_PATH} and ${WORKTREE_CONTRACT_PATH} disagree about the friendly domain`,
		);

	// The harness binds ephemeral ports, and the record seals the DECLARED bind
	// rather than the number one run happened to receive. An ephemeral value is a
	// fact about one machine and is evidence of nothing; "every listener asked for
	// port zero" is the property that keeps two worktrees from colliding, and it
	// is checkable against the committed fixture.
	const harness = await Bun.file(resolve(root, HARNESS_FIXTURE))
		.text()
		.catch(() => "");
	const binds = harness.split('hostname: "127.0.0.1",').length - 1;
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
		repository["proxyGuardScript"] !== PROXY_GUARD_SCRIPT ||
		repository["ciGuardScript"] !== CI_GUARD_SCRIPT ||
		repository["worktreeGuardScript"] !== WORKTREE_GUARD_SCRIPT ||
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
		entry.run.includes(`bun run ${PROXY_GUARD_SCRIPT}`),
	);
	if (!step || step.conditional)
		errors.push(
			`semantic: ${PROXY_GUARD_SCRIPT} is not an unconditional step of the required lane`,
		);
	if (fenceAround(workflow, `bun run ${PROXY_GUARD_SCRIPT}`) !== CAPABILITY)
		errors.push(
			`semantic: the ${PROXY_GUARD_SCRIPT} step is not fenced on ${CAPABILITY}`,
		);
	if (repository["addedJobs"] !== 0 || declaredNeeds.includes("proxy"))
		errors.push("semantic: Stage 10C must add no job to the required lane");
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
			"semantic: Stage 10C changed a definition fingerprint input under .devcontainer",
		);

	// The refusal matrix. A record may claim the development-server surface is
	// guarded only while every recorded diagnostic is still asserted by a
	// committed test.
	const mutationSource = await Bun.file(resolve(root, PROXY_MUTATION_TEST))
		.text()
		.catch(() => "");
	for (const verdict of REQUIRED_MUTATIONS) {
		if (!mutationSource.includes(verdict))
			errors.push(
				`repository: ${PROXY_MUTATION_TEST} no longer asserts ${verdict}`,
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
		errors.push("semantic: Stage 10C suite set drifted");
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
		["proxy", "proxy-guard", PROXY_GUARD_SCRIPT],
		["ci", "ci-guard", CI_GUARD_SCRIPT],
		["worktree", "worktree-guard", WORKTREE_GUARD_SCRIPT],
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
		renders["commandId"] !== "rendered-proxy" ||
		!sameValue(
			fixtures.map((entry) => entry["name"]),
			STAGE_TEN_C_FIXTURES.map((entry) => entry.name),
		) ||
		!sameValue(
			renders["fixtures"],
			parseJson(log("rendered-proxy", "stdout"))["fixtures"],
		)
	)
		errors.push("semantic: Stage 10C render evidence drifted");
	for (const fixture of fixtures) {
		const declared = STAGE_TEN_C_FIXTURES.find(
			(entry) => entry.name === fixture["name"],
		);
		if (!declared) continue;
		const enabled = declared.capabilityEnabled;
		const gated = arrayAt(fixture, "gatedPaths").map(String);
		const scripts = arrayAt(fixture, "packageScripts").map(String);
		if (
			fixture["capabilityEnabled"] !== enabled ||
			(enabled ? !sameValue(gated, [...ADDED_PATHS]) : gated.length !== 0) ||
			scripts.includes(PROXY_GUARD_SCRIPT) !== enabled ||
			fixture["proxyStepPresent"] !== enabled ||
			// The signature tokens, over every project file of the render. Both
			// directions are asserted: exactly zero where the capability is off, and
			// more than zero where it is on, because a render that enabled the
			// capability and still carried no mention of it would mean the surface
			// was stripped from the project that asked for it.
			(enabled
				? Number(fixture["proxyTokenFiles"] ?? 0) < 1
				: fixture["proxyTokenFiles"] !== 0) ||
			// The guard runs over the render and returns a real verdict where the
			// capability is on, and is not there at all where it is off.
			(enabled
				? arrayAt(fixture, "proxyErrors").length !== 0
				: fixture["guardPresent"] !== false) ||
			arrayAt(fixture, "residueFindings").length > 0 ||
			// The reserved configuration path is absent from EVERY render, enabled or
			// not: gating it is a claim about where an artifact would live, not a
			// promise to create one — and this template has no application for one to
			// belong to.
			fixture["reservedConfigPresent"] !== false ||
			// No render carries a build-tool configuration at ANY depth. The Stage 0
			// reservation is an exact filename, so the widened glob is what makes this
			// a claim about the tree rather than about one path.
			fixture["viteConfigFiles"] !== 0
		)
			errors.push(
				`semantic: rendered ${fixture["name"]} proxy evidence drifted`,
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
			[...STAGE_TEN_C_COVERAGE_IDS],
		)
	)
		errors.push("semantic: Stage 10C coverage map drifted");
	for (const entry of coverage) {
		const entryCommands = arrayAt(entry, "commandIds").map(String);
		if (
			entryCommands.length === 0 ||
			String(entry["reason"]).length < 40 ||
			entryCommands.some(
				(id) => !(STAGE_TEN_C_COMMAND_IDS as readonly string[]).includes(id),
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
			"<stage-10c-pr-merge-commit>",
		]) ||
		// Nothing about this stage lives outside the tree: there is no variable, no
		// branch-protection change, and no container payload.
		arrayAt(rollback, "outsideTheTree").length !== 0 ||
		rollback["containerRebuildRequired"] !== false ||
		!String(rollback["scope"] ?? "").includes("no container rebuild") ||
		!String(rollback["scope"] ?? "").includes("order-independent")
	)
		errors.push("semantic: Stage 10C rollback is not complete");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== baseSha ||
		proof["implementationSha"] !== implementationSha ||
		proof["treeMatchesPredecessor"] !== true ||
		proof["addedPathsRemoved"] !== true ||
		!sameValue(proof["addedPaths"], [...ADDED_PATHS])
	)
		errors.push("semantic: Stage 10C rollback proof drifted");
	try {
		if (!sameValue(proof, JSON.parse(log("rollback-proof", "stdout") || "{}")))
			errors.push("repository: rollback proof differs from its bound log");
	} catch {
		errors.push("repository: rollback proof log is not JSON");
	}

	return errors;
}

export async function validateStageTenCEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-10c-proxy.json");
	const schemaPath = resolve(root, "evidence/stage-10c-proxy.schema.json");
	if (!(await Bun.file(evidencePath).exists()))
		return ["repository: evidence/stage-10c-proxy.json is missing"];
	if (!(await Bun.file(schemaPath).exists()))
		return ["repository: evidence/stage-10c-proxy.schema.json is missing"];
	let value: unknown;
	try {
		value = await Bun.file(evidencePath).json();
	} catch {
		return ["repository: evidence/stage-10c-proxy.json is not JSON"];
	}
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	return await validateStageTenCEvidenceValue(value, schema, root);
}
