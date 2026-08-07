// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import { GATED_PATHS, validateFormsContract } from "./forms-contract";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	DECLARED_MODE,
	EXPECTED_OBSERVATIONS,
	expectedStageTenACommands,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	MUTATION_LEGS,
	renderWorkspacePath,
	rollbackWorkspacePath,
	STAGE_NINE_MERGE_SHA,
	STAGE_TEN_A_COMMAND_IDS,
	STAGE_TEN_A_FIXTURES,
	type StageTenACommandId,
	validateStageTenAEvidenceValue,
} from "./stage-ten-a-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-10a-api-contract.json");
const SCHEMA_PATH = resolve(
	ROOT,
	"evidence/stage-10a-api-contract.schema.json",
);
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const FORMS_GUARD_SCRIPT = "forms:check";
const CI_GUARD_SCRIPT = "ci:check";
const REGISTRY_PATH = "api-contract.json";
const FORMS_MUTATION_TEST = "scripts/template/__tests__/forms.test.ts";

// The three signature tokens whose absence from a disabled render is the single
// fact that shaped this stage. Assembled from parts so this collector is not
// itself a match for the scan it performs.
const SCHEMA_LIBRARY_TOKENS = [
	"zo" + "d",
	"react-hook" + "-form",
	"@hookform" + "/resolvers",
];

// The contract surface at the implementation boundary. The capture is only
// meaningful when the tree it ran against is identical to the reviewed
// boundary, so every input the record describes is compared.
const CONTRACT_INPUTS = [
	".github/workflows/ci.yml",
	"api-contract.json",
	"api-contract.schema.json",
	"biome.jsonc",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"package.json",
	"scripts/template/ci-contract.ts",
	"scripts/template/forms-contract.ts",
	"scripts/template/json-schema.ts",
	"scripts/template/validate-forms.ts",
	"scripts/template/__tests__/ci.test.ts",
	"scripts/template/__tests__/forms.test.ts",
	"scripts/template/__tests__/fixtures/api-contract-workspaces.ts",
];

// The Stage 10A evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-ten-a-evidence.ts",
	"scripts/template/collect-stage-ten-a-evidence.ts",
	"scripts/template/__tests__/stage-ten-a-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-10a-api-contract.json",
	"evidence/stage-10a-api-contract.schema.json",
	"evidence/stage-10a-api-contract-run/",
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
	id: StageTenACommandId;
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
		"  bun scripts/template/collect-stage-ten-a-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-ten-a-evidence.ts probe-render-forms --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-ten-a-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs on the HOST. Unlike the moon and OpenSpec stages this one owns",
		"no container-only binary: the guard is a standalone script over node:, Bun",
		"and the catalog-pinned compiler, and the only external tools are git and gh.",
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

function execute(
	command: string[],
	cwd = ROOT,
	environment?: Record<string, string>,
): Execution {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		...(environment ? { env: environment } : {}),
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

function checked(
	command: string[],
	cwd = ROOT,
	environment?: Record<string, string>,
): Execution {
	const result = execute(command, cwd, environment);
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
	id: StageTenACommandId,
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
			`Stage 10A command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 10A capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);
}

function assertToolingIsPresent(): void {
	// The host, deliberately. Every other stage that captured inside the
	// container did so because it owned a binary the host does not have — a
	// pinned CLI, a toolchain installer, an image. This stage owns none: the
	// guard is a standalone script over node:, Bun and the catalog-pinned
	// compiler, so a container hop would add a moving part and prove nothing.
	for (const [binary, hint] of [
		["git", "install git"],
		["gh", "gh auth login"],
		["python3", "install python3"],
		["shasum", "install perl"],
	] as const)
		if (Bun.which(binary) === null)
			throw new Error(`Stage 10A capture needs ${binary} on PATH (${hint})`);
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
 * The two halves are the ones no committed test can seal on its own: that a
 * project WITHOUT the capability carries no trace of the three-character
 * residue token anywhere in its tree, and that a project WITH it gets a guard
 * that returns a real verdict over the render rather than a greeting.
 */
export async function probeRenderForms(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_TEN_A_FIXTURES) {
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
			const packageScripts = [FORMS_GUARD_SCRIPT, CI_GUARD_SCRIPT].filter(
				(name) => typeof manifest.scripts[name] === "string",
			);
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			// The residue sweep, done here rather than trusted: `scanDisabledResidue`
			// exempts `fixture-manifest.json` by design — it is the render's own
			// report and names every capability it omitted — so the count below
			// excludes it and covers every actual project file.
			let schemaLibraryTokenFiles = 0;
			for await (const entry of new Bun.Glob("**/*").scan({
				cwd: output,
				dot: true,
				onlyFiles: true,
			})) {
				if (entry === "fixture-manifest.json") continue;
				const content = await Bun.file(resolve(output, entry))
					.text()
					.catch(() => "");
				if (SCHEMA_LIBRARY_TOKENS.some((token) => content.includes(token)))
					schemaLibraryTokenFiles += 1;
			}
			const guardPresent = await Bun.file(
				resolve(output, "scripts/template/validate-forms.ts"),
			).exists();
			const biome = await Bun.file(resolve(output, "biome.jsonc")).text();
			fixtures.push({
				name: declared.name,
				capabilityEnabled: declared.capabilityEnabled,
				gatedPaths: gatedPaths.sort(),
				packageScripts: packageScripts.sort(),
				formsStepPresent: workflow.includes(`bun run ${FORMS_GUARD_SCRIPT}`),
				guardPresent,
				schemaLibraryTokenFiles,
				formsErrors: guardPresent ? await validateFormsContract(output) : [],
				biomeGeneratedOverride:
					biome.includes('"**/generated/**"') && biome.includes('"assist"'),
				residueFindings: rendered.residue.findings,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageTenARollback(options: {
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
	const baseSha = gitSha(STAGE_NINE_MERGE_SHA);
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
			"The contract surface changed after the implementation boundary; recapture at the new boundary",
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
	const runId = `stage10a-${now
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
	const expected = expectedStageTenACommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageTenACommandId, Execution>();
	for (const id of STAGE_TEN_A_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageTenACommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageTenACommandId) => executions.get(id)?.stderr ?? "";
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

	const renders = jsonObject(stdout("rendered-forms"), "rendered-forms");
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const evidence = {
		schemaVersion: 1,
		stage: "stage-10a-api-contract",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			declaredMode: DECLARED_MODE,
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
			formsGuardScript: FORMS_GUARD_SCRIPT,
			ciGuardScript: CI_GUARD_SCRIPT,
			registryFile: REGISTRY_PATH,
			capability: "rhf_zod",
			// The number that keeps every other sealed record intact. Stage 8A added
			// a job and turned a green historical capture into a reported
			// fabrication; this stage adds a fenced STEP and nothing else.
			addedJobs: 0,
		},
		commands: records,
		guards: {
			forms: {
				commandId: "forms-guard",
				command: `bun run ${FORMS_GUARD_SCRIPT}`,
				summary: lastLine(stdout("forms-guard")),
			},
			ci: {
				commandId: "ci-guard",
				command: `bun run ${CI_GUARD_SCRIPT}`,
				summary: lastLine(stdout("ci-guard")),
			},
		},
		suites: [
			{
				commandId: "forms-mutations",
				testFile: FORMS_MUTATION_TEST,
				...counts(stderr("forms-mutations")),
			},
			...Object.keys(MUTATION_LEGS).map((commandId) => ({
				commandId,
				testFile: FORMS_MUTATION_TEST,
				...counts(stderr(commandId as StageTenACommandId)),
			})),
		],
		renderFixtures: {
			commandId: "rendered-forms",
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
				task: "13.1 capability-gated browser-safe shared request schemas and types",
				reason:
					"The input is a committed declaration rather than a query over an empty tree, and its declared mode is reconciled with the derived state in both directions before any leg runs: a tree that grows one of the four surface shapes while the registry still says skeleton fails by name, and a registry that declares a surface the tree does not carry fails too.",
				commandIds: ["forms-guard", "forms-mutations"],
			},
			{
				id: "browser-safety",
				task: "13.1 browser-safe shared request schemas",
				reason:
					"A declared schema package is scanned with an allowlist rather than a denylist, over every specifier spelling the AST carries, and a relative path that resolves outside the package root is refused; zero files under a declared root is a distinct failure and a module outside every declared package that reaches for the schema library is refused wherever it lives.",
				commandIds: ["browser-safety-matrix", "forms-guard"],
			},
			{
				id: "generated-drift",
				task: "13.2 generate response types and block handwritten parallel ones",
				reason:
					"The declared generator is executed, the post-state is read before any restore, the tree is put back on every exit path, and a byte difference in a declared artifact is refused by name; every generated client must open with its declared banner and the linter, formatter and assist actions are required to be off for it.",
				commandIds: ["drift-gate", "forms-mutations"],
			},
			{
				id: "deployment-skew",
				task: "13.3 deployment-skew and OpenAPI drift on every deployment path",
				reason:
					"Skew is proved as an additive-only evolution gate against the merge base plus a lenient wire contract, using a two-version fixture: the additive change is accepted, every field the old client reads is still present, and a removed field, a removed operation, a newly required field or a changed type is refused unless the registry stages it.",
				commandIds: ["evolution-gate", "forms-mutations"],
			},
			{
				id: "parallel-types",
				task: "13.2 block handwritten parallel response types",
				reason:
					"All four reference categories are refused at call sites whose covered routes are derived from the artifact's own paths, one hop of path resolution deep, across the wrapper type argument, the cast and the annotation; an artifact declaring no operation is itself a failure so the ban can never cover nothing.",
				commandIds: ["parallel-types", "forms-mutations"],
			},
			{
				id: "inline-authorization",
				task: "13.2 block inline authorization outside the policy seam",
				reason:
					"The banned denial messages are read from the declared seam module rather than written into the guard, a branch that reads a caller role bit and answers with a refusal is refused in both arms of a ternary, resolution stops at a seam call, and with no seam declared nothing at all may decide.",
				commandIds: ["authz-seam", "forms-mutations"],
			},
			{
				id: "forms-and-parsers",
				task: "13.1 RHF catalog family, server parsing, visible business rejection",
				reason:
					"Every module that binds a resolver must be registered with an empty exemption set, bound fields must exist in the declared schema, and a declared parser must import the shared schema, answer with the declared envelope, separate a malformed body from a schema rejection and declare the client mapping that makes the rejection visible.",
				commandIds: ["form-bindings", "forms-mutations"],
			},
			{
				id: "delivery-gating",
				task: "13.3 make contract drift block every deployment path",
				reason:
					"The guard is one unconditional fenced step in the required lane and this stage adds no job at all, while the core workflow contract now refuses any job that delivers without reaching the contract-guard job through needs, including a delivery job in a workflow that declares no contract job to gate it.",
				commandIds: ["ci-guard", "live-gate"],
			},
			{
				id: "capability-isolation",
				task: "13.4 validate generated enabled and disabled fixtures",
				reason:
					"Each fixture is rendered and inspected for the four gated paths, the package script and the fenced step, every project file of every render is swept for the three signature tokens, and the guard is run over the enabled render for a real verdict while the disabled ones are shown not to carry it at all.",
				commandIds: ["rendered-forms", "live-gate"],
			},
			{
				id: "rollback",
				task: "13.4 record rollback and evidence",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 9 predecessor, and that tree is shown to carry none of the four paths this stage adds while the implementation tree carries all of them; nothing about this stage lives outside the tree.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-10a-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload. Stage 8B's entry existed because its switch lived
			// outside the tree; this stage has no such switch.
			outsideTheTree: [],
			containerRebuildRequired: false,
			scope:
				"Revert the api contract registry and its schema, the shared schema and API contract guard and its entrypoint, the core json-schema module's copy ownership, the delivery rule in the workflow contract, the generated-output exemption in biome.jsonc, the forms:check package script, the one fenced step in the required lane, the ownership wiring, the documentation, and this record as one Stage 10A bundle. Nothing about this stage lives outside the tree: there is no repository variable, no branch-protection change and no operator step, so the revert is order-independent — unlike Stage 7, whose recorded outsideTheTree list was also empty but whose branch-protection change made its rollback order-dependent in fact. Nothing under .devcontainer/** changed, so adopting or reverting it costs no container rebuild. libs/forms stays reserved and empty either way.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageTenAEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 10A evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 10A evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-forms") {
		console.log(
			JSON.stringify(
				await probeRenderForms({ workspace: required(options, "--workspace") }),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageTenARollback({
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
