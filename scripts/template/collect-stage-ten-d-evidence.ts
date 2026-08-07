// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	BUILD_TOOL_PEER_RANGE,
	CLOUDFLARE_FAMILY,
	DECLARED_MODE,
	DEV_SERVER,
	EXPECTED_OBSERVATIONS,
	expectedStageTenDCommands,
	FORBIDDEN_TYPE_ENTRY,
	HARNESS_BIND_PORT,
	HARNESS_LISTENERS,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	MUTATION_LEGS,
	REPAIRED_TSCONFIG,
	renderWorkspacePath,
	rollbackWorkspacePath,
	SSR_MODE,
	STAGE_TEN_C_MERGE_SHA,
	STAGE_TEN_D_COMMAND_IDS,
	STAGE_TEN_D_FIXTURES,
	STALE_INCLUDE_DIAGNOSTIC,
	type StageTenDCommandId,
	TYPECHECK_DIAGNOSTIC,
	validateStageTenDEvidenceValue,
} from "./stage-ten-d-evidence";
import {
	GATED_PATHS,
	GUARD_SCRIPT,
	validateStartContract,
} from "./start-contract";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-10d-start.json");
const SCHEMA_PATH = resolve(ROOT, "evidence/stage-10d-start.schema.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const START_GUARD_SCRIPT = GUARD_SCRIPT;
const FAMILY_GUARD_SCRIPT = "toolchain:check";
const CI_GUARD_SCRIPT = "ci:check";
const REGISTRY_PATH = "start-surface.json";
const START_MUTATION_TEST = "scripts/template/__tests__/start.test.ts";
const CORE_TOOLCHAIN_MODULE = "scripts/template/toolchain.ts";

// The signature tokens whose absence from a disabled render is the fact the
// gating exists for. Assembled from parts for the usual reason — this collector
// scans a tree that contains this collector — and the bare word this capability
// is named for is deliberately not among them: it opens every capability fence
// in the repository, so a bare-word token would fail every render of every
// profile.
const START_TOKENS = [["@tan", "stack/"].join(""), START_GUARD_SCRIPT];

// The marker that says the rendered CORE toolchain guard still carries the
// coupled build-tool family legs. It sits inside a `cloudflare_workers` fence,
// so it must survive into the render where THIS capability is off and that one
// is on — which is the assertion that proves the family is core rather than
// gated.
const BUILD_TOOL_FAMILY_MARKER = "Cloudflare plugin peer range";

// The application surface at the implementation boundary. The capture is only
// meaningful when the tree it ran against is identical to the reviewed
// boundary, so every input the record describes is compared.
const CONTRACT_INPUTS = [
	".github/workflows/ci.yml",
	"bun.lock",
	"biome.jsonc",
	"start-surface.json",
	"start-surface.schema.json",
	"tsconfig.base.json",
	"tsconfig.start.base.json",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"package.json",
	"proxy-routes.json",
	"scripts/template/start-contract.ts",
	"scripts/template/validate-start.ts",
	"scripts/template/toolchain.ts",
	"scripts/template/__tests__/start.test.ts",
	"scripts/template/__tests__/toolchain.test.ts",
	"scripts/template/__tests__/fixtures/start-workspaces.ts",
	"scripts/template/__tests__/fixtures/start-ssr-harness.ts",
];

// The Stage 10D evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-ten-d-evidence.ts",
	"scripts/template/collect-stage-ten-d-evidence.ts",
	"scripts/template/__tests__/stage-ten-d-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-10d-start.json",
	"evidence/stage-10d-start.schema.json",
	"evidence/stage-10d-start-run/",
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
	id: StageTenDCommandId;
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

function usage(): string {
	return [
		"usage:",
		"  bun scripts/template/collect-stage-ten-d-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-ten-d-evidence.ts probe-render-start --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-ten-d-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs on the HOST. Like the three contract stages before it this one",
		"owns no container-only binary: the guard is a standalone script over node:,",
		"Bun and the catalog-pinned compiler, and the only external tools are git,",
		"gh, python3 and shasum.",
		"",
		"No credential is needed, wanted or accepted, and nothing here opens a socket",
		"to anything but loopback.",
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
	id: StageTenDCommandId,
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
			`Stage 10D command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 10D capture requires a clean feature tree:\n${dirty.join("\n")}`,
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
			throw new Error(`Stage 10D capture needs ${binary} on PATH (${hint})`);
}

function assertTemporary(workspace: string): string {
	const path = resolve(workspace);
	if (!path.startsWith("/tmp/") || path.length < 12)
		throw new Error(`Refusing to work outside /tmp: ${path}`);
	return path;
}

/**
 * What each fixture actually received, measured rather than asserted.
 *
 * Four halves no committed test can seal on its own: that a project WITHOUT the
 * capability carries no trace of either signature token anywhere in its tree,
 * that a project WITH it gets a guard returning a real verdict over the render
 * rather than a greeting, that the Stage 0 shared TypeScript base travels with
 * the surface in both directions, and — the one that proves the split — that
 * the CORE coupled pin family survives into the render where this capability is
 * OFF and the capability it depends on is ON.
 */
export async function probeRenderStart(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_TEN_D_FIXTURES) {
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
				START_GUARD_SCRIPT,
				FAMILY_GUARD_SCRIPT,
				CI_GUARD_SCRIPT,
			].filter((name) => typeof manifest.scripts[name] === "string");
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			// The residue sweep, done here rather than trusted: `scanDisabledResidue`
			// exempts `fixture-manifest.json` by design — it is the render's own
			// report and names every capability it omitted — so the count below
			// excludes it and covers every actual project file.
			let startTokenFiles = 0;
			for await (const entry of new Bun.Glob("**/*").scan({
				cwd: output,
				dot: true,
				onlyFiles: true,
			})) {
				if (entry === "fixture-manifest.json") continue;
				const content = await Bun.file(resolve(output, entry))
					.text()
					.catch(() => "");
				if (START_TOKENS.some((token) => content.includes(token)))
					startTokenFiles += 1;
			}
			const guardPresent = await Bun.file(
				resolve(output, "scripts/template/validate-start.ts"),
			).exists();
			const core = await Bun.file(resolve(output, CORE_TOOLCHAIN_MODULE))
				.text()
				.catch(() => "");
			fixtures.push({
				name: declared.name,
				capabilityEnabled: declared.capabilityEnabled,
				cloudflareEnabled: declared.cloudflareEnabled,
				gatedPaths: gatedPaths.sort(),
				packageScripts: packageScripts.sort(),
				startStepPresent: workflow.includes(`bun run ${START_GUARD_SCRIPT}`),
				guardPresent,
				repairedTsconfigPresent: await Bun.file(
					resolve(output, REPAIRED_TSCONFIG),
				).exists(),
				startTokenFiles,
				startErrors: guardPresent ? await validateStartContract(output) : [],
				buildToolFamilyPresent: core.includes(BUILD_TOOL_FAMILY_MARKER),
				residueFindings: rendered.residue.findings,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageTenDRollback(options: {
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
	// The asymmetric half. Stage 0 created the shared TypeScript base and this
	// stage REPAIRS it, so a revert restores the broken version rather than
	// deleting the file — which is why the base is not in `addedPaths` and why
	// the reverted content is checked for the entry it used to carry.
	const revertedBase = execute(
		["git", "show", `${proof.revertedTree}:${REPAIRED_TSCONFIG}`],
		root,
	);
	const implementedBase = execute(
		["git", "show", `${proof.implementationSha}:${REPAIRED_TSCONFIG}`],
		root,
	);
	if (revertedBase.exitCode !== 0 || implementedBase.exitCode !== 0)
		throw new Error(`${REPAIRED_TSCONFIG} is missing from one of the trees`);
	if (!revertedBase.stdout.includes(FORBIDDEN_TYPE_ENTRY))
		throw new Error(
			`The reverted ${REPAIRED_TSCONFIG} does not carry the entry this stage removed`,
		);
	if (implementedBase.stdout.includes(FORBIDDEN_TYPE_ENTRY))
		throw new Error(
			`The implementation ${REPAIRED_TSCONFIG} still carries the forbidden entry`,
		);
	return {
		...proof,
		addedPaths: [...ADDED_PATHS],
		addedPathsRemoved: true,
		repairedTsconfigRestored: true,
	};
}

async function capture(options: {
	implementation: string;
	gateRun: number;
}): Promise<void> {
	assertToolingIsPresent();
	const baseSha = gitSha(STAGE_TEN_C_MERGE_SHA);
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
			"The application surface changed after the implementation boundary; recapture at the new boundary",
		);
	// The one thing that would have cost a container rebuild, measured rather
	// than promised. Counted here and sealed, so the record carries the number
	// instead of the claim.
	const devcontainerFilesChanged = checked([
		"git",
		"diff",
		"--name-only",
		baseSha,
		implementationSha,
		"--",
		".devcontainer",
	])
		.stdout.split("\n")
		.filter(Boolean).length;
	if (devcontainerFilesChanged !== 0)
		throw new Error(
			"Stage 10D must not touch .devcontainer; the definition fingerprint would change",
		);
	// The lockfile did not move either, which is what makes the coupled family a
	// RULE rather than a pin.
	const lockfileChanged =
		execute([
			"git",
			"diff",
			"--quiet",
			baseSha,
			implementationSha,
			"--",
			"bun.lock",
		]).exitCode !== 0;
	if (lockfileChanged)
		throw new Error(
			"Stage 10D must not change bun.lock; the family rule exists so that a pin is unnecessary",
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
	const runId = `stage10d-${now
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
	const expected = expectedStageTenDCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageTenDCommandId, Execution>();
	for (const id of STAGE_TEN_D_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageTenDCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageTenDCommandId) => executions.get(id)?.stderr ?? "";
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

	const renders = jsonObject(stdout("rendered-start"), "rendered-start");
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const evidence = {
		schemaVersion: 1,
		stage: "stage-10d-start",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			declaredMode: DECLARED_MODE,
			devServer: DEV_SERVER,
			ssrMode: SSR_MODE,
			repairedTsconfig: REPAIRED_TSCONFIG,
			forbiddenTypes: [FORBIDDEN_TYPE_ENTRY],
			cloudflareFamily: { ...CLOUDFLARE_FAMILY },
			buildToolPeerRange: BUILD_TOOL_PEER_RANGE,
			lockfileChanged: false,
			// The DECLARED bind, not the ephemeral value the kernel handed back. An
			// ephemeral number is a fact about one run on one machine and is evidence
			// of nothing; "every listener asked for port zero" is the property that
			// keeps two worktrees from colliding, and it is checkable against the
			// committed fixture.
			harnessBindPort: HARNESS_BIND_PORT,
			harnessListeners: HARNESS_LISTENERS,
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
		},
		repository: {
			nameWithOwner,
			workflowFile: WORKFLOW_PATH,
			gateJobId: "ci-gate",
			gateContext,
			gateNeeds,
			startGuardScript: START_GUARD_SCRIPT,
			familyGuardScript: FAMILY_GUARD_SCRIPT,
			ciGuardScript: CI_GUARD_SCRIPT,
			registryFile: REGISTRY_PATH,
			capability: "tanstack_start",
			// The first capability in this template with declared dependencies, and
			// the reason this stage had to write the import rule down.
			capabilityDependencies: ["cloudflare_workers", "vite_websocket_proxy"],
			// The number that keeps every other sealed record intact. Stage 8A added
			// a job and turned a green historical capture into a reported
			// fabrication; this stage adds a fenced STEP and nothing else.
			addedJobs: 0,
			// The one thing that would have cost every downstream developer a
			// container rebuild, counted rather than promised.
			devcontainerFilesChanged,
		},
		commands: records,
		guards: {
			start: {
				commandId: "start-guard",
				command: `bun run ${START_GUARD_SCRIPT}`,
				summary: lastLine(stdout("start-guard")),
			},
			family: {
				commandId: "family-guard",
				command: `bun run ${FAMILY_GUARD_SCRIPT}`,
				summary: lastLine(stdout("family-guard")),
			},
			ci: {
				commandId: "ci-guard",
				command: `bun run ${CI_GUARD_SCRIPT}`,
				summary: lastLine(stdout("ci-guard")),
			},
		},
		suites: [
			{
				commandId: "start-mutations",
				testFile: START_MUTATION_TEST,
				...counts(stderr("start-mutations")),
			},
			...Object.entries(MUTATION_LEGS).map(([commandId, leg]) => ({
				commandId,
				testFile: leg.testFile,
				...counts(stderr(commandId as StageTenDCommandId)),
			})),
		],
		typecheckProof: {
			commandId: "tsconfig-typecheck",
			forbiddenEntry: FORBIDDEN_TYPE_ENTRY,
			mutationDiagnostic: TYPECHECK_DIAGNOSTIC,
			staleIncludeDiagnostic: STALE_INCLUDE_DIAGNOSTIC,
			passCount: counts(stderr("tsconfig-typecheck")).passCount,
		},
		renderFixtures: {
			commandId: "rendered-start",
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
				task: "16.1 declare the TanStack Start application surface",
				reason:
					"The input is a committed declaration rather than a query over an empty tree, and its declared mode is reconciled with the derived state in both directions before any leg runs: a generated route tree at any depth, a framework-scope dependency in any manifest section, a source file that CALLS one of the two entry helpers, or a project that extends the shared base all fail a registry still saying skeleton, and a registry declaring a surface the tree does not carry fails too.",
				commandIds: ["start-guard", "start-mutations"],
			},
			{
				id: "strict-typescript-base",
				task: "16.1 generate the strict shared Start TypeScript base without baseUrl or nonexistent globals",
				reason:
					"The base now extends the repository base instead of restating a weaker set beside it, its unresolvable type entry is gone and declared forbidden, and the stale include entry is dropped; the proof is the catalog-pinned compiler run for real over a synthetic project that genuinely extends it, because a build-based proof would have been green against the broken file — esbuild ignores types entirely.",
				commandIds: ["tsconfig-typecheck", "tsconfig-mutations"],
			},
			{
				id: "cloudflare-pin-family",
				task: "16.1 align Cloudflare Vite/runtime pins as one family",
				reason:
					"The build tool joins the coupled family as a lock-resolution singleton, its resolution is reconciled against the plugin's OWN declared peer range read out of the lockfile, and a floating spec for it or any of its plugins in a workspace manifest is refused; the rules are core and fenced on the capability this one depends on, so they hold in the render where Cloudflare is on and this capability is off.",
				commandIds: ["family-guard", "family-mutations", "rendered-start"],
			},
			{
				id: "server-render-policy",
				task: "16.2 smoke one SSR read in the generated fixture",
				reason:
					"Buffered is the declared default because this worker runtime's backpressure and abort behaviour under a stream is unproven, and streaming is a waivable refusal rather than an impossibility; the methods are exactly the two reads, an unsupported method takes a 405 that names them, and the cache directive is asserted on every response class rather than only on the success path.",
				commandIds: ["ssr-policy", "ssr-read-through-proxy"],
			},
			{
				id: "worker-configuration",
				task: "16.2 build in the generated fixture",
				reason:
					"The service binding allowlist is closed because a narrow binding set is what makes a leak between two services structurally impossible, the Node compatibility flag is required because the server bundle fails at module evaluation without it, the generated subdomain and preview origins are pinned off, and a hand-written assets block is refused because the plugin synthesizes that block itself.",
				commandIds: ["worker-config", "start-guard"],
			},
			{
				id: "built-artifact",
				task: "16.2 build and verify the artifact the deploy ships",
				reason:
					"The generated worker configuration is checked against the declaration rather than against the source it came from, because the two are different files and only one reaches production: the declared entry module and asset directory, service bindings that equal the declaration rather than subset it, empty forbidden binding families, and a harness-only variable as a hard failure.",
				commandIds: ["built-artifact", "start-guard"],
			},
			{
				id: "asset-namespace",
				task: "16.2 typecheck and build one application surface without namespace drift",
				reason:
					"Rewriting document URLs to a different public prefix does not move the physical directory the asset binding serves, which made every rewritten URL 404 in the built worker while the development server stayed green; the public prefix, the router basepath and the emitted asset directory are three spellings of one decision and drift between any two is refused by name.",
				commandIds: ["namespace-drift", "router-options"],
			},
			{
				id: "route-tree",
				task: "16.3 add config/build/graph mutations over the generated route tree",
				reason:
					"The route tree is governed as a committed artefact rather than a regenerable one: tracked, absent from the ignore file, and excluded from the formatter and the linter and the assist alike, because the generator's raw style fails a lint pass over a freshly built tree that a checked-in copy passes; whether it is current is deliberately not a rule and the README says why.",
				commandIds: ["route-tree", "start-mutations"],
			},
			{
				id: "declared-dependency",
				task: "16.1 declare the surface behind a capability with declared dependencies",
				reason:
					"This is the first capability in the template with declared dependencies, so the import rule had to be written down: a gated module may import core or same-capability modules only, and a declared dependency earns the right to READ a dependency's committed registry file with a named notice when it is absent, because the guarantee that both travel together expires at generation and a static import would turn a diagnostic into a module-load crash.",
				commandIds: ["proxy-reconciliation", "start-guard"],
			},
			{
				id: "executed-read-and-mutation",
				task: "16.2 smoke one SSR read plus one browser mutation through the intended proxy",
				reason:
					"Two loopback listeners make the apex proxy the single browser-visible origin production actually serves, a document read increments the server-side render counter by exactly one read before teardown, and a same-origin mutation reaches the upstream with every identity-override header stripped while the render counter does not move again — which is the zero-refetch property that makes a server render read mean something.",
				commandIds: [
					"ssr-read-through-proxy",
					"browser-mutation-through-proxy",
					"start-mutations",
				],
			},
			{
				id: "capability-isolation",
				task: "16.3 validate enabled and disabled fixtures",
				reason:
					"Each fixture is rendered and inspected for the four gated paths, the shared TypeScript base, the package script and the fenced step, every project file of every render is swept for both signature tokens, the guard returns a real verdict where the capability is on, and the core pin family is shown present in the render where Cloudflare is on and this capability is off.",
				commandIds: ["rendered-start", "live-gate"],
			},
			{
				id: "rollback",
				task: "16.3 record rollback and evidence",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 10C predecessor, that tree carries none of the four paths this stage adds while the implementation tree carries all of them, and the shared TypeScript base — which this stage repairs rather than creates — is shown restored to the version carrying the entry that made the compiler fail.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-10d-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload, no advertised port. Stage 8B's entry existed because
			// its switch lived outside the tree; this stage has no such switch.
			outsideTheTree: [],
			// False, and it is the decision that made it false rather than luck.
			// `scripts/worktree/contract.toml` names `.devcontainer` — the whole
			// directory — as a definition fingerprint input, so Stage 10B paid a
			// rebuild for a comment-only edit to a file the image never reads. This
			// stage adds no advertised port, and the reason is stronger than the
			// previous one: the port this stack's worker runs on is already
			// advertised under the capability this one depends on.
			containerRebuildRequired: false,
			scope:
				"Revert the application surface registry and its schema, the guard and its entrypoint, the start:check package script, the one fenced step in the required lane, the ownership wiring, the widened capability signature, the core Cloudflare build-tool family legs in scripts/template/toolchain.ts, the repair to tsconfig.start.base.json, the fenced AGENTS.md block, the documentation, and this record as one Stage 10D bundle. One half is asymmetric and the record proves it separately: the shared TypeScript base is a Stage 0 artefact this stage REPAIRS, so reverting restores the version whose types entry named a subpath the router package does not export — a file the compiler refuses and nothing in this repository compiles. Nothing about this stage lives outside the tree: there is no repository variable, no branch-protection change and no operator step, so the revert is order-independent. Adopting or reverting it costs no container rebuild in either direction: nothing under .devcontainer/ is touched, no advertised port is added because the port this stack's worker runs on is already advertised under the capability this one depends on, and the definition fingerprint is unchanged. bun.lock, template-parameters.toml, every fixture and scripts/worktree/** are untouched in both directions, and apps/ and libs/ stay empty either way.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageTenDEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 10D evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 10D evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-start") {
		console.log(
			JSON.stringify(
				await probeRenderStart({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageTenDRollback({
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
