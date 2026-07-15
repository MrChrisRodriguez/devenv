import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";

const REQUIRED_TOOLS = [
	"bun",
	"caddy",
	"devcontainer",
	"devpod",
	"docker",
	"gh",
	"graphify",
	"hyperfine",
	"moon",
	"proto",
] as const;

const REQUIRED_VALIDATIONS = [
	["bun", "run", "template:validate"],
	["bun", "run", "template:test"],
	["bun", "run", "template:typecheck"],
	["bun", "run", "template:fixtures", "tmp/stage0-fixtures-final"],
	["bunx", "biome", "check", "--no-errors-on-unmatched", "."],
] as const;

const REQUIRED_MUTATIONS = [
	"authoritative-schema-loader",
	"capability-dependency",
	"disabled-capability-residue",
	"disabled-package-residue",
	"evidence-record-antivacuity",
	"fixture-identity",
	"generated-destination-exhaustiveness",
	"generated-workflow-scripts",
	"global-source-residue",
	"invalid-fixture-atomicity",
	"legacy-initializer",
	"canonical-output-alias",
	"protected-output",
	"runtime-diff-guard",
	"schema-required-and-unique",
	"service-graph",
	"unknown-field",
	"unsafe-paths",
] as const;

const REQUIRED_LOGS = [
	"clean-build.log",
	"clean-build.time",
	"command-latency.json",
	"docker-restart.log",
	"docker-restart.time",
	"resource-footprint.json",
	"restart-ready.log",
	"restart-ready.time",
	"up-one.log",
	"up-one.time",
	"up-two.log",
	"up-two.time",
	"warm-build.log",
	"warm-build.time",
] as const;

const OBSERVATIONAL_BASELINE_PATHS = [
	"CHANGES.md",
	"openspec/changes/portable-devcontainer-upgrade/",
] as const;

const ACTIVE_RUNTIME_PATHS = [".devcontainer/", ".prototools"] as const;

export function activeRuntimePathChanges(paths: string[]): string[] {
	return paths
		.filter((path) =>
			ACTIVE_RUNTIME_PATHS.some(
				(runtimePath) => path === runtimePath || path.startsWith(runtimePath),
			),
		)
		.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

function arrayAt(value: Record<string, unknown>, key: string): unknown[] {
	const entry = value[key];
	return Array.isArray(entry) ? entry : [];
}

function names(entries: unknown[], key: string): string[] {
	return entries.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry[key] !== "string") return [];
		return [entry[key]];
	});
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const duplicate = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicate.add(value);
		seen.add(value);
	}
	return [...duplicate].sort();
}

function commandKey(command: readonly string[]): string {
	return JSON.stringify(command);
}

function numberAt(value: Record<string, unknown>, key: string): number | null {
	const entry = value[key];
	return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
}

export function validateStageZeroEvidenceValue(
	value: unknown,
	schema: Record<string, unknown>,
): string[] {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;

	const environment = recordAt(value, "environment");
	const toolNames = names(arrayAt(environment, "tools"), "name");
	for (const tool of REQUIRED_TOOLS) {
		if (!toolNames.includes(tool))
			errors.push(`semantic: missing tool ${tool}`);
	}
	for (const tool of duplicates(toolNames))
		errors.push(`semantic: duplicate tool ${tool}`);

	const validations = arrayAt(value, "validation");
	const validationCommands = new Set(
		validations.flatMap((entry) => {
			if (!isRecord(entry) || !Array.isArray(entry["command"])) return [];
			if (!entry["command"].every((part) => typeof part === "string"))
				return [];
			return [commandKey(entry["command"] as string[])];
		}),
	);
	for (const validation of validations) {
		if (
			isRecord(validation) &&
			(validation["status"] !== "pass" || validation["exitCode"] !== 0)
		)
			errors.push("semantic: committed validation result is not passing");
	}
	for (const command of REQUIRED_VALIDATIONS) {
		if (!validationCommands.has(commandKey(command)))
			errors.push(`semantic: missing validation ${command.join(" ")}`);
	}

	const mutationNames = names(arrayAt(value, "mutationProof"), "name");
	for (const mutation of REQUIRED_MUTATIONS) {
		if (!mutationNames.includes(mutation))
			errors.push(`semantic: missing mutation proof ${mutation}`);
	}
	for (const mutation of duplicates(mutationNames))
		errors.push(`semantic: duplicate mutation proof ${mutation}`);

	const logNames = names(arrayAt(value, "logs"), "name");
	for (const log of REQUIRED_LOGS) {
		if (!logNames.includes(log))
			errors.push(`semantic: missing log digest ${log}`);
	}
	for (const log of duplicates(logNames))
		errors.push(`semantic: duplicate log digest ${log}`);

	const inventory = recordAt(value, "inventory");
	const controlledRun = recordAt(inventory, "controlledRun");
	const runLabel = controlledRun["runLabel"];
	if (
		typeof runLabel !== "string" ||
		!runLabel.startsWith("com.devenv.evidence.run=")
	)
		errors.push("semantic: controlled run label is not evidence-scoped");
	const containerIds = controlledRun["containerIds"];
	if (
		Array.isArray(containerIds) &&
		new Set(containerIds).size !== containerIds.length
	)
		errors.push("semantic: controlled container IDs are not unique");

	const measurements = recordAt(value, "measurements");
	const cleanBuild = recordAt(measurements, "cleanImageBuild");
	const warmBuild = recordAt(measurements, "warmImageBuild");
	const cleanSeconds = numberAt(cleanBuild, "value");
	const warmSeconds = numberAt(warmBuild, "value");
	if (
		cleanSeconds === null ||
		warmSeconds === null ||
		cleanSeconds <= 0 ||
		warmSeconds <= 0 ||
		warmSeconds > cleanSeconds
	)
		errors.push("semantic: clean/warm image build timings are inconsistent");

	const diagnostic = recordAt(measurements, "failedLifecycleExecLatency");
	const latency = recordAt(diagnostic, "value");
	const samples = latency["samples"];
	const sampleCount = numberAt(latency, "sampleCount");
	const warmupCount = numberAt(latency, "warmupCount");
	if (
		!Array.isArray(samples) ||
		!samples.every(
			(sample) => typeof sample === "number" && Number.isFinite(sample),
		) ||
		samples.length === 0 ||
		sampleCount !== samples.length ||
		warmupCount === null ||
		warmupCount < 1
	)
		errors.push("semantic: failed-lifecycle latency samples are vacuous");
	else {
		const sorted = [...samples].sort((left, right) => left - right);
		const percentile = (fraction: number): number =>
			sorted[Math.floor((sorted.length - 1) * fraction)] ?? Number.NaN;
		if (
			numberAt(latency, "minimum") !== sorted[0] ||
			numberAt(latency, "p50") !== percentile(0.5) ||
			numberAt(latency, "p95") !== percentile(0.95) ||
			numberAt(latency, "maximum") !== sorted.at(-1)
		)
			errors.push("semantic: failed-lifecycle latency statistics drifted");
	}

	const growthMeasurement = recordAt(measurements, "secondWorktreeGrowth");
	const growth = recordAt(growthMeasurement, "value");
	const growthParts = [
		numberAt(growth, "newImageBytes"),
		numberAt(growth, "containerRwBytes"),
		numberAt(growth, "volumeBytesRounded"),
		numberAt(growth, "checkoutGrowthBytes"),
	];
	const growthTotal = numberAt(growth, "totalBytesRounded");
	if (
		growthParts.some((part) => part === null || part < 0) ||
		growthTotal === null ||
		growthParts.reduce<number>((total, part) => total + (part ?? 0), 0) !==
			growthTotal
	)
		errors.push("semantic: second-worktree growth total is inconsistent");

	const cleanup = recordAt(value, "cleanup");
	if (cleanup["rawLogsDeleted"] !== true)
		errors.push("semantic: raw evidence logs were not deleted");
	if (cleanup["dockerPruneUsed"] !== false)
		errors.push("semantic: Docker prune must not be used for evidence cleanup");

	return errors.sort();
}

function git(
	root: string,
	args: string[],
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
	};
}

export async function validateStageZeroEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-0-baseline.json");
	const schemaPath = resolve(root, "evidence/stage-0-baseline.schema.json");
	const value = (await Bun.file(evidencePath).json()) as unknown;
	const schema = (await Bun.file(schemaPath).json()) as Record<string, unknown>;
	const errors = validateStageZeroEvidenceValue(value, schema);
	if (errors.length > 0 || !isRecord(value)) return errors;

	const source = recordAt(value, "source");
	const baseSha = source["baseSha"];
	const preMigrationSha = source["preMigrationSha"];
	const implementationSha = source["implementationSha"];
	if (
		typeof baseSha !== "string" ||
		typeof preMigrationSha !== "string" ||
		typeof implementationSha !== "string"
	)
		return [...errors, "semantic: source commit SHAs are unavailable"];

	for (const [name, sha] of [
		["base", baseSha],
		["pre-migration", preMigrationSha],
		["implementation", implementationSha],
	] as const) {
		if (git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0)
			errors.push(`repository: ${name} commit ${sha} is unavailable`);
	}
	if (
		git(root, ["merge-base", "--is-ancestor", preMigrationSha, baseSha])
			.exitCode !== 0
	)
		errors.push("repository: pre-migration commit is not an ancestor of base");
	if (
		git(root, ["merge-base", "--is-ancestor", implementationSha, "HEAD"])
			.exitCode !== 0
	)
		errors.push("repository: implementation commit is not an ancestor of HEAD");
	const implementationParent = git(root, [
		"rev-parse",
		`${implementationSha}^`,
	]);
	if (
		implementationParent.exitCode !== 0 ||
		implementationParent.stdout !== baseSha
	)
		errors.push(
			"repository: implementation commit is not based directly on base",
		);

	const baselineDiff = git(root, [
		"diff",
		"--name-only",
		preMigrationSha,
		baseSha,
	]);
	if (baselineDiff.exitCode !== 0)
		errors.push(
			"repository: observational baseline diff could not be inspected",
		);
	else {
		for (const path of baselineDiff.stdout.split("\n").filter(Boolean)) {
			if (
				!OBSERVATIONAL_BASELINE_PATHS.some(
					(allowed) => path === allowed || path.startsWith(allowed),
				)
			)
				errors.push(
					`repository: pre-migration-to-base diff changes runtime path ${path}`,
				);
		}
	}
	const implementationDiff = git(root, [
		"diff",
		"--name-only",
		baseSha,
		"HEAD",
	]);
	if (implementationDiff.exitCode !== 0)
		errors.push("repository: Stage 0 runtime diff could not be inspected");
	else {
		for (const path of activeRuntimePathChanges(
			implementationDiff.stdout.split("\n").filter(Boolean),
		))
			errors.push(`repository: Stage 0 changes active runtime path ${path}`);
	}

	return errors.sort();
}
