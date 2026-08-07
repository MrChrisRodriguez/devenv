// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateGateContext } from "./ci-contract";
import { probeRollback } from "./collect-stage-two-evidence";
import {
	GATED_PATHS,
	GUARD_SCRIPT,
	isViteConfig,
	RESERVED_CONFIG_PATH,
	validateProxyContract,
} from "./proxy-contract";
import { renderFixture } from "./render-fixture";
import {
	ADDED_PATHS,
	DECLARED_MODE,
	EXPECTED_OBSERVATIONS,
	expectedStageTenCCommands,
	HARNESS_BIND_PORT,
	HARNESS_LISTENERS,
	LOG_ROOT as LOG_ROOT_RELATIVE,
	MUTATION_LEGS,
	PUBLISHED_CONTAINER_PORT,
	renderWorkspacePath,
	rollbackWorkspacePath,
	STAGE_TEN_B_MERGE_SHA,
	STAGE_TEN_C_COMMAND_IDS,
	STAGE_TEN_C_FIXTURES,
	type StageTenCCommandId,
	validateStageTenCEvidenceValue,
} from "./stage-ten-c-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = resolve(ROOT, LOG_ROOT_RELATIVE);
const EVIDENCE_PATH = resolve(ROOT, "evidence/stage-10c-proxy.json");
const SCHEMA_PATH = resolve(ROOT, "evidence/stage-10c-proxy.schema.json");
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const PROXY_GUARD_SCRIPT = GUARD_SCRIPT;
const CI_GUARD_SCRIPT = "ci:check";
const WORKTREE_GUARD_SCRIPT = "worktree:check";
const REGISTRY_PATH = "proxy-routes.json";
const PROXY_MUTATION_TEST = "scripts/template/__tests__/proxy.test.ts";

// The signature tokens whose absence from a disabled render is the fact the
// gating exists for. The formatted code shape is assembled from parts for the
// usual reason — this collector scans a tree that contains this collector — and
// it is the one Stage 0 reserved, which is exactly why it is fit for a plain
// substring sweep and unfit as the guard's own mechanism.
const PROXY_TOKENS = [["ws:", " true"].join(""), PROXY_GUARD_SCRIPT];

// The development-server surface at the implementation boundary. The capture is
// only meaningful when the tree it ran against is identical to the reviewed
// boundary, so every input the record describes is compared.
const CONTRACT_INPUTS = [
	".github/workflows/ci.yml",
	"proxy-routes.json",
	"proxy-routes.schema.json",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"package.json",
	"scripts/template/proxy-contract.ts",
	"scripts/template/validate-proxy.ts",
	"scripts/template/__tests__/proxy.test.ts",
	"scripts/template/__tests__/fixtures/proxy-route-workspaces.ts",
	"scripts/template/__tests__/fixtures/websocket-harness.ts",
	"scripts/worktree/contract.toml",
];

// The Stage 10C evidence tooling and its output land in the same commit as the
// record, so they are the only paths allowed to be uncommitted at capture time.
const CAPTURE_PATHS = [
	"scripts/template/stage-ten-c-evidence.ts",
	"scripts/template/collect-stage-ten-c-evidence.ts",
	"scripts/template/__tests__/stage-ten-c-evidence.test.ts",
	"scripts/template/validate.ts",
	"evidence/stage-10c-proxy.json",
	"evidence/stage-10c-proxy.schema.json",
	"evidence/stage-10c-proxy-run/",
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
	id: StageTenCCommandId;
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
		"  bun scripts/template/collect-stage-ten-c-evidence.ts capture \\",
		"    --implementation <sha> --gate-run <id>",
		"  bun scripts/template/collect-stage-ten-c-evidence.ts probe-render-proxy --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-ten-c-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
		"",
		"Capture runs on the HOST. Like the two contract stages before it this one",
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
	id: StageTenCCommandId,
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
			`Stage 10C command ${id} failed (${execution.exitCode}); see ${stderrPath}\n${execution.stderr.slice(-4000)}`,
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
			`Stage 10C capture requires a clean feature tree:\n${dirty.join("\n")}`,
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
			throw new Error(`Stage 10C capture needs ${binary} on PATH (${hint})`);
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
 * Three halves no committed test can seal on its own: that a project WITHOUT
 * the capability carries no trace of either signature token anywhere in its
 * tree, that a project WITH it gets a guard returning a real verdict over the
 * render rather than a greeting, and that NO render — enabled or not — carries
 * a build-tool configuration at any depth, because a reservation is where an
 * artifact would live and not a promise to create one.
 */
export async function probeRenderProxy(options: {
	workspace: string;
	root?: string;
}): Promise<Record<string, unknown>> {
	const root = resolve(options.root ?? ROOT);
	const workspace = assertTemporary(options.workspace);
	await rm(workspace, { recursive: true, force: true });
	await mkdir(workspace, { recursive: true });
	const fixtures: Array<Record<string, unknown>> = [];
	try {
		for (const declared of STAGE_TEN_C_FIXTURES) {
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
				PROXY_GUARD_SCRIPT,
				CI_GUARD_SCRIPT,
				WORKTREE_GUARD_SCRIPT,
			].filter((name) => typeof manifest.scripts[name] === "string");
			const workflow = await Bun.file(resolve(output, WORKFLOW_PATH)).text();
			// The residue sweep, done here rather than trusted: `scanDisabledResidue`
			// exempts `fixture-manifest.json` by design — it is the render's own
			// report and names every capability it omitted — so the count below
			// excludes it and covers every actual project file.
			let proxyTokenFiles = 0;
			let viteConfigFiles = 0;
			for await (const entry of new Bun.Glob("**/*").scan({
				cwd: output,
				dot: true,
				onlyFiles: true,
			})) {
				if (isViteConfig(entry)) viteConfigFiles += 1;
				if (entry === "fixture-manifest.json") continue;
				const content = await Bun.file(resolve(output, entry))
					.text()
					.catch(() => "");
				if (PROXY_TOKENS.some((token) => content.includes(token)))
					proxyTokenFiles += 1;
			}
			const guardPresent = await Bun.file(
				resolve(output, "scripts/template/validate-proxy.ts"),
			).exists();
			fixtures.push({
				name: declared.name,
				capabilityEnabled: declared.capabilityEnabled,
				gatedPaths: gatedPaths.sort(),
				packageScripts: packageScripts.sort(),
				proxyStepPresent: workflow.includes(`bun run ${PROXY_GUARD_SCRIPT}`),
				guardPresent,
				proxyTokenFiles,
				proxyErrors: guardPresent ? await validateProxyContract(output) : [],
				reservedConfigPresent: await Bun.file(
					resolve(output, RESERVED_CONFIG_PATH),
				).exists(),
				viteConfigFiles,
				residueFindings: rendered.residue.findings,
			});
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	return { fixtures };
}

export async function probeStageTenCRollback(options: {
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
	const baseSha = gitSha(STAGE_TEN_B_MERGE_SHA);
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
			"The development server surface changed after the implementation boundary; recapture at the new boundary",
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
			"Stage 10C must not touch .devcontainer; the definition fingerprint would change",
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
	const runId = `stage10c-${now
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
	const expected = expectedStageTenCCommands(context);

	await rm(LOG_ROOT, { recursive: true, force: true });
	await rm(EVIDENCE_PATH, { force: true });
	await mkdir(LOG_ROOT, { recursive: true });

	const records: CapturedCommand[] = [];
	const executions = new Map<StageTenCCommandId, Execution>();
	for (const id of STAGE_TEN_C_COMMAND_IDS) {
		const captured = await captureCommand(id, expected[id], runId);
		records.push(captured.record);
		executions.set(id, captured.execution);
	}

	const stdout = (id: StageTenCCommandId) => executions.get(id)?.stdout ?? "";
	const stderr = (id: StageTenCCommandId) => executions.get(id)?.stderr ?? "";
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

	const renders = jsonObject(stdout("rendered-proxy"), "rendered-proxy");
	const rollbackProof = jsonObject(stdout("rollback-proof"), "rollback-proof");

	const gateValues = keyValues(stdout("live-gate"));
	const document = jsonObject(gateValues["runJson"] ?? "", "live-gate");
	const runJobs = (document["jobs"] ?? []) as Array<Record<string, unknown>>;
	const gateJob = runJobs.find((job) => job["name"] === gateContext);

	const evidence = {
		schemaVersion: 1,
		stage: "stage-10c-proxy",
		capturedAt: new Date().toISOString(),
		run: { id: runId, logRoot: LOG_ROOT_RELATIVE },
		source: {
			baseSha,
			implementationSha,
			treeClean: true,
			declaredMode: DECLARED_MODE,
			reservedConfigPath: RESERVED_CONFIG_PATH,
			publishedContainerPort: PUBLISHED_CONTAINER_PORT,
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
			proxyGuardScript: PROXY_GUARD_SCRIPT,
			ciGuardScript: CI_GUARD_SCRIPT,
			worktreeGuardScript: WORKTREE_GUARD_SCRIPT,
			registryFile: REGISTRY_PATH,
			capability: "vite_websocket_proxy",
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
			proxy: {
				commandId: "proxy-guard",
				command: `bun run ${PROXY_GUARD_SCRIPT}`,
				summary: lastLine(stdout("proxy-guard")),
			},
			ci: {
				commandId: "ci-guard",
				command: `bun run ${CI_GUARD_SCRIPT}`,
				summary: lastLine(stdout("ci-guard")),
			},
			worktree: {
				commandId: "worktree-guard",
				command: `bun run ${WORKTREE_GUARD_SCRIPT}`,
				summary: lastLine(stdout("worktree-guard")),
			},
		},
		suites: [
			{
				commandId: "proxy-mutations",
				testFile: PROXY_MUTATION_TEST,
				...counts(stderr("proxy-mutations")),
			},
			...Object.entries(MUTATION_LEGS).map(([commandId, leg]) => ({
				commandId,
				testFile: leg.testFile,
				...counts(stderr(commandId as StageTenCCommandId)),
			})),
		],
		renderFixtures: {
			commandId: "rendered-proxy",
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
				task: "15.1 generate enabled development and preview proxy routes in aligned object form",
				reason:
					"The input is a committed declaration rather than a query over an empty tree, and its declared mode is reconciled with the derived state in both directions before any leg runs: a tree that grows a build-tool configuration at any depth, a direct build-tool dependency or a source file carrying a proxy table while the registry still says skeleton fails by name, and a registry that declares a surface the tree does not carry fails too.",
				commandIds: ["proxy-guard", "proxy-mutations"],
			},
			{
				id: "forwarding-routes",
				task: "15.1 aligned object form with ws: true on every forwarding route",
				reason:
					"Every proxy entry must be an object literal, must state ws, changeOrigin and secure explicitly, and must target a declared loopback upstream; a string shorthand is refused quoting the reference's own sentence that a string target never proxies WS, and a route carrying both a path rewrite and a forwarded upgrade is refused with the named upstream casualty that discovered it.",
				commandIds: ["route-shape", "proxy-guard"],
			},
			{
				id: "config-identity",
				task: "15.1 generate the configuration this registry governs",
				reason:
					"Before a byte is parsed the declared configuration must be an ordinary in-tree file with exactly one hard link, not a symlink, canonicalizing to the path the registry named, because a guard that reads a symlink or a hardlinked twin validates a file it does not own; then one effective default export so a commented-out decoy never counts, and an object literal.",
				commandIds: ["config-identity", "proxy-guard"],
			},
			{
				id: "dev-preview-alignment",
				task: "15.1 aligned development and preview route tables",
				reason:
					"The registry declares one shared table so alignment is a property of the declaration, and the guard additionally compares the configuration's two proxy objects entry by entry: a route in one and not the other, a target that differs between them, and an upgrade forwarded for one server and not the other are three separate refusals because they are three separate mistakes.",
				commandIds: ["dev-preview-alignment", "proxy-mutations"],
			},
			{
				id: "reachability",
				task: "15.1 generate a development server the published container port reaches",
				reason:
					"strictPort is pinned because without it the server silently takes the next free port and the container publish maps to nothing, the bind must be wide because a server on the container's loopback is unreachable through a published port, and exactly one process binds the published port: this server or a fronting service the worktree runtime contract actually declares.",
				commandIds: ["reachability", "worktree-guard"],
			},
			{
				id: "host-validation",
				task: "15.2 non-vacuous structural proxy policy tests",
				reason:
					"A WebSocket handshake is not subject to CORS, so a cross-site page can open an authenticated socket unless the server checks the host itself; allowedHosts true, a wildcard, an empty entry and the literal all are all refused, the loopback family and the friendly domain suffix are both required, and the executed harness shows an attacker host refused while an allowed one opens.",
				commandIds: ["host-validation", "websocket-handshake"],
			},
			{
				id: "hot-reload-policy",
				task: "15.2 real HMR handshake tests",
				reason:
					"Two browser-visible origins are published at once, so a pinned client port is a single number that can match at most one of them and silently breaks the other; the override and the asset origin are pinned null, a client port equal to the published container port earns its own refusal, and the handshake is executed through a published port boundary rather than argued.",
				commandIds: ["hmr-policy", "hmr-handshake"],
			},
			{
				id: "generated-config",
				task: "15.1 generate the enabled development and preview proxy configuration",
				reason:
					"The renderer makes three properties structural rather than checked — object form with ws on every route, one table for both servers, and no import at all — and the drift leg pins the generated bytes exactly, which is what catches a route removed rather than malformed: the file still parses, every entry is object form, and the two tables still agree.",
				commandIds: ["renderer-drift", "proxy-guard"],
			},
			{
				id: "executed-handshake",
				task: "15.2 real HTTP/WebSocket handshake tests with string-shorthand and missing-ws mutations",
				reason:
					"A structural guard can be perfect about a proxy that never forwards a byte, so a real client opens a socket through a declared route and gets its frame echoed, the same route with the upgrade dropped never opens while its HTTP half stays green, and the shorthand and rewriting mutations are refused before any socket exists.",
				commandIds: [
					"http-through-proxy",
					"websocket-handshake",
					"proxy-mutations",
				],
			},
			{
				id: "capability-isolation",
				task: "15.3 validate generated enabled/disabled fixtures",
				reason:
					"Each fixture is rendered and inspected for the four gated paths, the package script and the fenced step, every project file of every render is swept for both signature tokens, the reserved configuration path is shown absent in all three, no render carries a build-tool configuration at any depth, and the guard returns a real verdict where the capability is on.",
				commandIds: ["rendered-proxy", "live-gate"],
			},
			{
				id: "rollback",
				task: "15.3 record rollback and evidence",
				reason:
					"A synthetic merge followed by git revert -m 1 produces a tree identical to the Stage 10B predecessor, and that tree is shown to carry none of the four paths this stage adds while the implementation tree carries all of them; nothing about this stage lives outside the tree and nothing under .devcontainer changed.",
				commandIds: ["rollback-proof"],
			},
		],
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-10c-pr-merge-commit>"],
			// Nothing: no repository variable, no branch-protection change, no
			// container payload, no advertised port. Stage 8B's entry existed because
			// its switch lived outside the tree; this stage has no such switch.
			outsideTheTree: [],
			// False, and it is the decision that made it false rather than luck.
			// `scripts/worktree/contract.toml` names `.devcontainer` — the whole
			// directory — as a definition fingerprint input, so the previous stage
			// paid a rebuild for a comment-only edit to a file the image never reads.
			// This stage adds no advertised port and touches nothing under that
			// directory, and the record carries the measured file count rather than
			// the promise.
			containerRebuildRequired: false,
			scope:
				"Revert the proxy route registry and its schema, the development server and proxy guard and its entrypoint, the proxy:check package script, the one fenced step in the required lane, the ownership wiring, the widened capability signature, the fenced AGENTS.md block, the documentation, and this record as one Stage 10C bundle. Nothing about this stage lives outside the tree: there is no repository variable, no branch-protection change and no operator step, so the revert is order-independent — unlike Stage 7, whose recorded outsideTheTree list was also empty but whose branch-protection change made its rollback order-dependent in fact. Adopting or reverting it costs no container rebuild in either direction: nothing under .devcontainer/ is touched, no advertised port is added, and the definition fingerprint is unchanged, which is the deliberate difference from Stage 10B and the reason the evidence commit precedes the documentation commit here. bun.lock, template-parameters.toml, every fixture and scripts/worktree/** are untouched in both directions, and vite.config.ts stays reserved and absent either way.",
			proof: rollbackProof,
		},
	};

	const schema = (await Bun.file(SCHEMA_PATH).json()) as Record<
		string,
		unknown
	>;
	const errors = await validateStageTenCEvidenceValue(evidence, schema, ROOT);
	if (errors.length > 0)
		throw new Error(
			`Stage 10C evidence validation failed:\n- ${errors.join("\n- ")}`,
		);
	await Bun.write(EVIDENCE_PATH, `${JSON.stringify(evidence, null, "\t")}\n`);
	console.log(`Stage 10C evidence written to ${EVIDENCE_PATH}`);
}

if (import.meta.main) {
	const [subcommand, ...args] = process.argv.slice(2);
	const options = parseOptions(args);
	if (subcommand === "capture") {
		await capture({
			implementation: required(options, "--implementation"),
			gateRun: Number(required(options, "--gate-run")),
		});
	} else if (subcommand === "probe-render-proxy") {
		console.log(
			JSON.stringify(
				await probeRenderProxy({
					workspace: required(options, "--workspace"),
				}),
			),
		);
	} else if (subcommand === "probe-rollback") {
		console.log(
			JSON.stringify(
				await probeStageTenCRollback({
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
