// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	DECLARED_MODE,
	EXPECTED_OBSERVATIONS,
	expectedStageTenBCommands,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	MUTATION_LEGS,
	RESERVED_TELEMETRY_ROOT,
	renderWorkspacePath,
	rollbackWorkspacePath,
	STAGE_TEN_A_MERGE_SHA,
	STAGE_TEN_B_COMMAND_IDS,
	STAGE_TEN_B_FIXTURES,
	type StageTenBCommandId,
	validateStageTenBEvidenceValue,
} from "./stage-ten-b-evidence";
import {
	GATED_PATHS,
	NEEDLES,
	validateTelemetryContract,
} from "./telemetry-contract";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-10b-telemetry.json");
const SCHEMA_PATH = resolve(ROOT, "evidence/stage-10b-telemetry.schema.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_DIRECTORY = ".github/workflows";
const TELEMETRY_GUARD_SCRIPT = "telemetry:check";
const CI_GUARD_SCRIPT = "ci:check";
const OPENSPEC_GUARD_SCRIPT = "openspec:check";
const REGISTRY_PATH = "external-writes.json";
const TELEMETRY_MUTATION_TEST = "scripts/template/__tests__/telemetry.test.ts";

// One sentence from the CORE workflow contract, used to establish that the four
// credential rules reached a render that disabled the capability. The renderer
// has no inverse fence, so a rule that arrived with a capability would be a rule
// the projects without it never receive — and this is the measurement that says
// it did not.
const CORE_WORKFLOW_RULE =
	"must not expose a credential in a workflow-level env block";

// The signature tokens whose absence from a disabled render is the fact the
// gating exists for. The SDK scope is taken from the guard rather than spelled
// here, for the same reason the guard assembles it: this collector scans a tree
// that contains this collector.
const TELEMETRY_TOKENS = [NEEDLES.scope, TELEMETRY_GUARD_SCRIPT];

// The telemetry-credential variables the collector removes from the environment
// it hands every captured command.
//
// `SENTRY_*` is the vendor family the spec names; the second pattern catches a
// project that renamed the family and kept the shape. Nothing in this stage
// needs a credential, so removing them costs the capture nothing and closes the
// one path by which a real token could reach a committed log.
const REDACTED_ENVIRONMENT = [
	/^SENTRY_/i,
	/TELEMETRY_[A-Z0-9_]*(TOKEN|SECRET|KEY|DSN)/i,
];

// The external-write surface at the implementation boundary. The capture is only
// meaningful when the tree it ran against is identical to the reviewed
// boundary, so every input the record describes is compared.
const CONTRACT_INPUTS = [
	".github/workflows/ci.yml",
	"external-writes.json",
	"external-writes.schema.json",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"package.json",
	"scripts/openspec/archive.sh",
	"scripts/template/ci-contract.ts",
	"scripts/template/openspec-contract.ts",
	"scripts/template/telemetry-contract.ts",
	"scripts/template/validate-telemetry.ts",
	"scripts/template/__tests__/ci.test.ts",
	"scripts/template/__tests__/openspec.test.ts",
	"scripts/template/__tests__/telemetry.test.ts",
	"scripts/template/__tests__/fixtures/external-write-workspaces.ts",
	"scripts/template/__tests__/fixtures/request-recorder.ts",
];

// The Stage 10B evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-ten-b-evidence.ts",
	"scripts/template/collect-stage-ten-b-evidence.ts",
	"scripts/template/__tests__/stage-ten-b-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-10b-telemetry.json",
	"evidence/stage-10b-telemetry.schema.json",
	"evidence/stage-10b-telemetry-run/",
	"graphify-out",
	"node_modules",
	"tmp",
];

interface Execution {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageTenBCommandId;
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

/**
 * The environment every captured command receives, and the names of what was
 * taken out of it.
 *
 * Only the NAMES are returned. A record that leaked the credential it exists to
 * prove unnecessary would be worse than no record at all, and "we removed
 * SENTRY_AUTH_TOKEN" is the whole claim — its value is not evidence of
 * anything.
 */
export function redactEnvironment(source: Record<string, string | undefined>): {
	environment: Record<string, string>;
	redactedKeys: string[];
} {
	const environment: Record<string, string> = {};
	const redactedKeys: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (REDACTED_ENVIRONMENT.some((pattern) => pattern.test(key))) {
			redactedKeys.push(key);
			continue;
		}
		environment[key] = value;
	}
	return { environment, redactedKeys: redactedKeys.sort() };
}

const REDACTED = redactEnvironment(process.env as Record<string, string>);

function usage(): string {
	return [
		"usage:",
		"  bun scripts/template/collect-stage-ten-b-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-ten-b-evidence.ts probe-render-telemetry --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-ten-b-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs on the HOST. Unlike the moon and OpenSpec stages this one owns",
		"no container-only binary: the guard is a standalone script over node:, Bun",
		"and the catalog-pinned compiler, and the only external tools are git and gh.",
		"",
		"No credential is needed, wanted or accepted. Every SENTRY_* variable is",
		"removed from the environment each captured command receives.",
	].join("\n");
}

function parseOptions(args: string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
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
		env: REDACTED.environment,
		stdin: "ignore",
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

function gitSha(revision: string, cwd = ROOT): string {
	const sha = checked(
		["git", "rev-parse", "--verify", `${revision}^{commit}`],
		cwd,
	).stdout.trim();
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
	id: StageTenBCommandId,
	command: string[],
	runId: string,
): Promise<{ record: CapturedCommand; execution: Execution }> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	console.log(`  ${id} …`);
	const execution = execute(command);
	const completed = Date.now();
	const stdoutPath = `${LOG_ROOT_RELATIVE}/${id}.stdout`;
	const stderrPath = `${LOG_ROOT_RELATIVE}/${id}.stderr`;
	await Bun.write(resolve(ROOT, stdoutPath), execution.stdout);
	await Bun.write(resolve(ROOT, stderrPath), execution.stderr);
	if (execution.exitCode !== 0)
		throw new Error(
			`Stage 10B command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
		);
	console.log(`  ${id} passed in ${Math.round((completed - started) / 1000)}s`);
	const { sha256 } = await import("./stage-four-evidence");
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
			`Stage 10B capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsPresent(): void {
	// The host, deliberately. Every other stage that captured inside the
	// container did so because it owned a binary the host does not have. This
	// stage owns none: the guard is a standalone script over node:, Bun and the
	// catalog-pinned compiler, so a container hop would add a moving part and
	// prove nothing.
	for (const [binary, hint] of [
		["git", "install git"],
		["gh", "gh auth login"],
		["python3", "install python3"],
		["shasum", "install perl"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 10B capture needs ${binary} on PATH (${hint})`);
}

function assertTemporary(workspace: string): string {
	const path = resolve(workspace);
	if (!path.startsWith("/tmp/") || path.length < 12)
		throw new Error(`Refusing to work outside /tmp: ${path}`);
	return path;
}

/** Every committed workflow's reference count for the credential context. */
function workflowSecretReferences(root: string): number {
	let total = 0;
	let names: string[];
	try {
		names = readdirSync(resolve(root, WORKFLOW_DIRECTORY));
	} catch {
		return 0;
	}
	for (const name of names) {
		if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
		const text = readFileSync(resolve(root, WORKFLOW_DIRECTORY, name), "utf8");
		// The executable half only: a comment explaining why the credential
		// context is banned is not a reference to it.
		total += text
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.filter((line) => /\bsecrets\./.test(line)).length;
	}
	return total;
}

/**
 * What each fixture actually received, measured rather than asserted.
 *
 * Three halves no committed test can seal on its own: that a project WITHOUT
 * the capability carries no trace of either signature token anywhere in its
 * tree, that a project WITH it gets a guard returning a real verdict over the
 * render rather than a greeting, and that the CORE workflow credential rules
 * reached every render whether the capability was on or off.
 */
export async function probeRenderTelemetry(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_TEN_B_FIXTURES) {
			const output = resolve(workspace, declared.name);
			const rendered = await renderFixture({
				root,
				fixtureName: declared.name,
				output,
			});
			const gatedPaths: string[] = [];
			for (const path of GATED_PATHS) {
				if (await Bun.file(resolve(output, path)).exists())
					gatedPaths.push(path);
			}
			const manifest = (await Bun.file(
				resolve(output, "package.json"),
			).json()) as { scripts: Record<string, string> };
			const packageScripts = [
				TELEMETRY_GUARD_SCRIPT,
				CI_GUARD_SCRIPT,
				OPENSPEC_GUARD_SCRIPT,
			].filter((name) => typeof manifest.scripts[name] === "string");
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			// The residue sweep, done here rather than trusted: `scanDisabledResidue`
			// exempts `fixture-manifest.json` by design — it is the render's own
			// report and names every capability it omitted — so the count below
			// excludes it and covers every actual project file.
			let telemetryTokenFiles = 0;
			let reservedRootFiles = 0;
			for await (const entry of new Bun.Glob("**/*").scan({
				cwd: output,
				dot: true,
				onlyFiles: true,
			})) {
				if (entry.startsWith(`${RESERVED_TELEMETRY_ROOT}/`))
					reservedRootFiles += 1;
				if (entry === "fixture-manifest.json") continue;
				const content = await Bun.file(resolve(output, entry))
					.text()
					.catch(() => "");
				if (TELEMETRY_TOKENS.some((token) => content.includes(token)))
					telemetryTokenFiles += 1;
			}
			const guardPresent = await Bun.file(
				resolve(output, "scripts/template/validate-telemetry.ts"),
			).exists();
			const workflowGuard = await Bun.file(
				resolve(output, "scripts/template/ci-contract.ts"),
			)
				.text()
				.catch(() => "");
			fixtures.push({
				name: declared.name,
				capabilityEnabled: declared.capabilityEnabled,
				gatedPaths: gatedPaths.sort(),
				packageScripts: packageScripts.sort(),
				telemetryStepPresent: workflow.includes(
					`bun run ${TELEMETRY_GUARD_SCRIPT}`,
				),
				guardPresent,
				telemetryTokenFiles,
				telemetryErrors: guardPresent
					? await validateTelemetryContract(output)
					: [],
				reservedRootFiles,
				workflowGuardPresent: workflowGuard.includes(CORE_WORKFLOW_RULE),
				residueFindings: rendered.residue.findings,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageTenBRollback(options: {
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
	gateRun: number;
}): Promise<void> {
	assertToolingIsPresent();
	const baseSha = gitSha(STAGE_TEN_A_MERGE_SHA);
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
			...CONTRACT_INPUTS,
		]).exitCode !== 0
	)
		throw new Error(
			"The external-write surface changed after the implementation boundary; recapture at the new boundary",
		);

	const workflow = await Bun.file(resolve(ROOT, WORKFLOW_PATH)).text();
	const gateContext = aggregateGateContext(workflow);
	if (!gateContext)
		throw new Error("The committed workflow declares no aggregate gate name");
	const jobs = (Bun.YAML.parse(workflow) as Record<string, unknown>)[
		"jobs"
	] as Record<string, Record<string, unknown>>;
	const gateNeeds = (jobs["ci-gate"]?.["needs"] as string[]) ?? [];
	const nameWithOwner = checked([
		"gh",
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]).stdout.trim();

	const now = new Date();
	const runId = `stage10b-${now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.toLowerCase()}-${implementationSha.slice(0, 8)}`;
	const context = {
		run: { id: runId },
		source: { baseSha, implementationSha },
		repository: { nameWithOwner, gateContext },
		live: { "live-gate": { run: { runId: options.gateRun } } },
	};
	const expected = expectedStageTenBCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageTenBCommandId, Execution>();
	for (const id of STAGE_TEN_B_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageTenBCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageTenBCommandId) => executions.get(id)?.stderr ?? "";
	const lastLine = (text: string) =>
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1) ?? "";
	const counts = (text: string) => ({
		passCount: Number(/ (\d+) pass/.exec(text)?.[1] ?? -1),
		failCount: Number(/ (\d+) fail/.exec(text)?.[1] ?? -1),
	});

	const renders = jsonObject(
		stdout("rendered-telemetry"),
		"rendered-telemetry",
	);
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const evidence = {
		schemaVersion: 1,
		stage: "stage-10b-telemetry",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			declaredMode: DECLARED_MODE,
			reservedTelemetryRoot: RESERVED_TELEMETRY_ROOT,
			typescriptCatalogPin: (
				(await Bun.file(resolve(ROOT, "package.json")).json()) as {
					workspaces: { catalog: Record<string, string> };
				}
			).workspaces.catalog["typescript"],
		},
		host: {
			os: uname("-s").toLowerCase(),
			architecture: uname("-m"),
			kernel: uname("-r"),
			// The host, on purpose. This stage owns no container-only binary, so a
			// container hop would be a moving part that proves nothing.
			insideDevcontainer: process.env["DEVCONTAINER"] === "true",
			bunVersion: checked(["bun", "--version"]).stdout.trim(),
			gitVersion: /\d+\.\d+\.\d+/.exec(
				checked(["git", "--version"]).stdout,
			)?.[0] as string,
			ghVersion: /\d+\.\d+\.\d+/.exec(
				checked(["gh", "--version"]).stdout,
			)?.[0] as string,
			// Names only. Empty is the expected and correct outcome on a host that
			// has no telemetry credential at all, which is every host that should be
			// running this capture.
			redactedEnvironmentKeys: REDACTED.redactedKeys,
		},
		repository: {
			nameWithOwner,
			workflowFile: WORKFLOW_PATH,
			gateJobId: "ci-gate",
			gateContext,
			gateNeeds,
			telemetryGuardScript: TELEMETRY_GUARD_SCRIPT,
			ciGuardScript: CI_GUARD_SCRIPT,
			openspecGuardScript: OPENSPEC_GUARD_SCRIPT,
			registryFile: REGISTRY_PATH,
			capability: "sentry",
			// The number that keeps every other sealed record intact. Stage 8A added
			// a job and turned a green historical capture into a reported
			// fabrication; this stage adds a fenced STEP and nothing else.
			addedJobs: 0,
			// The state the four core credential rules were written to preserve.
			workflowSecretReferences: workflowSecretReferences(ROOT),
		},
		commands: records,
		guards: {
			telemetry: {
				commandId: "telemetry-guard",
				command: `bun run ${TELEMETRY_GUARD_SCRIPT}`,
				summary: lastLine(stdout("telemetry-guard")),
			},
			ci: {
				commandId: "ci-guard",
				command: `bun run ${CI_GUARD_SCRIPT}`,
				summary: lastLine(stdout("ci-guard")),
			},
			openspec: {
				commandId: "openspec-guard",
				command: `bun run ${OPENSPEC_GUARD_SCRIPT}`,
				summary: lastLine(stdout("openspec-guard")),
			},
		},
		suites: [
			{
				commandId: "telemetry-mutations",
				testFile: TELEMETRY_MUTATION_TEST,
				...counts(stderr("telemetry-mutations")),
			},
			...Object.entries(MUTATION_LEGS).map(([commandId, leg]) => ({
				commandId,
				testFile: leg.testFile,
				...counts(stderr(commandId as StageTenBCommandId)),
			})),
		],
		renderFixtures: {
			commandId: "rendered-telemetry",
			fixtures: renders["fixtures"],
		},
		live: {
			"live-gate": {
				commandId: "live-gate",
				heavyLaneRan: EXPECTED_OBSERVATIONS[0].heavyLaneRan,
				run: {
					runId: document["databaseId"],
					url: document["url"],
					event: document["event"],
					headBranch: document["headBranch"],
					headSha: document["headSha"],
					conclusion: document["conclusion"],
					gateJobId: Number(gateValues["gateJobId"]),
					gateConclusion: String(gateJob?.["conclusion"] ?? ""),
					gateLogSha256: gateValues["gateLogSha256"],
					upstreamResults: gateValues["upstreamResults"] ?? "",
					jobs: runJobs
						.filter((job) => job["name"] !== gateContext)
						.map((job) => ({
							name: String(job["name"]),
							conclusion: String(job["conclusion"]),
						})),
				},
			},
		},
		coverage: [
			{
				id: "declared-surface",
				task: "14.2 require explicit intent plus credentials for every generated external write",
				reason:
					"The input is a committed declaration rather than a query over an empty tree, and its declared mode is reconciled with the derived state in both directions before any leg runs: a tree that grows a reserved-root file, an SDK import, an initializer call or an undeclared write shape while the registry still says skeleton fails by name, and a registry that declares a surface the tree does not carry fails too.",
				commandIds: ["telemetry-guard", "telemetry-mutations"],
			},
			{
				id: "intent-and-credentials",
				task: "14.1 quiet-none, warn/disabled-partial, and enabled-both release/token semantics",
				reason:
					"The truth table is asserted statically as an AST projection — something must read both halves, no use of the credential may sit in a branch the intent does not dominate, the partial state must warn from a branch that reads both — and then executed against a loopback recorder in all four states, observing zero requests until both halves are set.",
				commandIds: ["truth-table", "outage-and-final-state"],
			},
			{
				id: "surface-confinement",
				task: "14.1 capability-gated centralized Sentry configuration",
				reason:
					"Centralized means an allowlist derived from the registry rather than a list of the call sites somebody already found: the SDK import, the initializer and the structured-logger and metrics namespaces are legal only inside a declared configuration module, and the user binding is refused everywhere because its whole purpose is to attach an identity to a report that leaves the building.",
				commandIds: ["surface-confinement", "telemetry-guard"],
			},
			{
				id: "credential-hygiene",
				task: "14.1 centralized configuration and 14.4 secrets registry",
				reason:
					"No credential is a committed literal, and the scan is proved by planting one and removing it in a finally; the declared scrubber imports no SDK so both tiers can share it, every configuration module binds a beforeSend hook and pins sendDefaultPii false, and the non-secrecy rule runs in both directions because the ingest DSN is public and the upload token is not.",
				commandIds: ["credential-literals", "scrub-policy"],
			},
			{
				id: "host-allowlist",
				task: "14.3 allowlist tests",
				reason:
					"Exact origins with no wildcard, no path, no query and no fragment, every write's hosts a subset of the declared union, and a declared tunnel a same-origin path; the executed matrix then shows a non-allowlisted host refused before any socket opens, with the recorder's request count as the proof rather than the response.",
				commandIds: ["allowlist-matrix", "outage-and-final-state"],
			},
			{
				id: "workflow-credentials",
				task: "14.2 explicit intent plus credentials on every deployment path",
				reason:
					"Four core rules that must hold in every render and therefore name no capability token: no credential interpolated into a shell body, none in a workflow-level or job-level env block, an if: required on any step that receives one, and no pull_request_target trigger at all because it runs with the base repository's secrets against a head a fork controls.",
				commandIds: ["ci-guard", "workflow-secret-rules"],
			},
			{
				id: "final-state-readback",
				task: "14.2 query/assert the final remote state after intentional writes",
				reason:
					"The one remote write this repository performs now reads the remote back with git ls-remote after pushing and refuses on a mismatch with its own exit code; the ordering, the binding and the single-assignment rules are guarded, a post-receive hook proves the refusal live, and the executed verifier shows a wrong final state reported as UNVERIFIED.",
				commandIds: [
					"openspec-guard",
					"archive-readback",
					"outage-and-final-state",
				],
			},
			{
				id: "outage-tolerance",
				task: "14.3 outage tests",
				reason:
					"A stopped recorder is what an outage looks like from the caller's side, and the upload warns and exits zero rather than failing the build: telemetry that could redden a deploy would be the tail wagging the dog, and the same reasoning is why the reference silences its own upload plugin's error handler.",
				commandIds: ["outage-and-final-state", "telemetry-mutations"],
			},
			{
				id: "capability-isolation",
				task: "14.4 validate generated enabled/disabled fixtures",
				reason:
					"Each fixture is rendered and inspected for the four gated paths, the package script and the fenced step, every project file of every render is swept for both signature tokens, the reserved configuration root is shown empty in all three, and the core workflow credential rules are shown to have reached the renders that disabled the capability.",
				commandIds: ["rendered-telemetry", "live-gate"],
			},
			{
				id: "rollback",
				task: "14.4 record rollback and evidence",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 10A predecessor, and that tree is shown to carry none of the four paths this stage adds while the implementation tree carries all of them; nothing about this stage lives outside the tree.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-10b-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload. Stage 8B's entry existed because its switch lived
			// outside the tree; this stage has no such switch.
			outsideTheTree: [],
			// True, and worth naming: this stage adds no package, no image layer
			// and no tool, but `scripts/worktree/contract.toml` lists `.devcontainer`
			// — the whole directory — as a definition fingerprint input, and the
			// Dockerfile bakes that directory in as a definition stamp. So the
			// fenced block added to `.devcontainer/secrets.example` invalidates
			// that layer even though nothing the build reads changed.
			containerRebuildRequired: true,
			scope:
				"Revert the external write registry and its schema, the telemetry guard and its entrypoint, the four core credential rules in the workflow contract, the readback in the OpenSpec archive wrapper and its ordering rule in the lifecycle guard, the telemetry:check package script, the one fenced step in the required lane, the ownership wiring, the fenced secrets.example and AGENTS.md blocks, the documentation, and this record as one Stage 10B bundle. Nothing about this stage lives outside the tree: there is no repository variable, no branch-protection change and no operator step, so the revert is order-independent — unlike Stage 7, whose recorded outsideTheTree list was also empty but whose branch-protection change made its rollback order-dependent in fact. Adopting or reverting it costs exactly one container rebuild, in both directions: the fenced block in .devcontainer/secrets.example is a comment-only change to a file the image never reads, but scripts/worktree/contract.toml names the whole .devcontainer directory as a definition fingerprint input and the Dockerfile bakes that directory in as a definition stamp, so the stamp layer is invalidated either way. Run bash scripts/worktree/up.sh once after adopting and once after reverting. libs/observability stays reserved and empty either way, and .codex/cloud/contract.toml is untouched in both directions.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageTenBEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 10B evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 10B evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-telemetry") {
		console.log(
			JSON.stringify(
				await probeRenderTelemetry({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageTenBRollback({
					base: required(options, "--base"),
					implementation: required(options, "--implementation"),
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else {
		console.error(usage());
		process.exit(2);
	}
}

// Referenced so the sealed workspace-path helpers stay bound to the collector
// that uses them; the capture builds its commands from the same functions the
// validator derives them with.
void [renderWorkspacePath, rollbackWorkspacePath];
