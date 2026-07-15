// biome-ignore-all lint/complexity/useLiteralKeys: Strict JSON records require bracket access.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";
import { syntheticMergeMetadata } from "./prove-stage-one-revert";
import { resolvedVersions } from "./toolchain";

const REQUIRED_MUTATIONS = [
	"catalog-floating",
	"catalog-bypass",
	"coupled-family-drift",
	"second-resolution",
	"mutable-proto-plugin",
	"feature-lock-drift",
	"proto-checksum-format",
	"proto-checksum-mismatch",
	"typescript-baseurl",
	"typescript-absolute-alias",
	"workspace-path-priority",
	"secondary-lockfile",
	"disabled-family-omission",
	"composite-action-bun-pin",
] as const;

const EXPECTED_MUTATIONS: Record<(typeof REQUIRED_MUTATIONS)[number], string> =
	{
		"catalog-floating": "Reject a latest catalog selector",
		"catalog-bypass": "Reject a direct version for a catalog-owned consumer",
		"coupled-family-drift":
			"Reject a Cloudflare catalog pin that differs from the lock",
		"second-resolution": "Reject a second runtime-sensitive lock resolution",
		"mutable-proto-plugin": "Reject a mutable Proto plugin branch",
		"feature-lock-drift":
			"Reject differing feature resolution and integrity digests",
		"proto-checksum-format": "Reject malformed architecture checksum metadata",
		"proto-checksum-mismatch":
			"Reject a valid-looking checksum that does not match the archive",
		"typescript-baseurl": "Reject an active TypeScript baseUrl",
		"typescript-absolute-alias": "Reject an absolute TypeScript path target",
		"workspace-path-priority":
			"Reject Proto resolution before workspace-local binaries",
		"secondary-lockfile": "Reject a nested workspace package lock",
		"disabled-family-omission":
			"Omit disabled package authorities and consumers from rendered fixtures",
		"composite-action-bun-pin":
			"Reject an unpinned setup-bun action in local composite metadata",
	};

const EXPECTED_OBSERVATIONS: Record<
	(typeof REQUIRED_MUTATIONS)[number],
	string
> = {
	"catalog-floating": "catalog: @biomejs/biome must use an exact version",
	"catalog-bypass": "catalog: root consumer @biomejs/biome must use catalog:",
	"coupled-family-drift": "lock: wrangler does not resolve to catalog 4.108.0",
	"second-resolution":
		"lock: wrangler must resolve exactly once, found 2 entries (4.107.0, 4.108.0)",
	"mutable-proto-plugin":
		"proto: plugin direnv must use an immutable commit URL",
	"feature-lock-drift":
		"features: ghcr.io/devcontainers/features/common-utils:2 resolved reference and integrity differ",
	"proto-checksum-format":
		"proto: checksum architectures drift from template parameters",
	"proto-checksum-mismatch":
		"invalid checksum fixture exited nonzero in verify-only mode",
	"typescript-baseurl": "typescript: tsconfig.base.json reintroduces baseUrl",
	"typescript-absolute-alias":
		"typescript: tsconfig.base.json contains an absolute path alias",
	"workspace-path-priority":
		"path: .shell_common resolves Proto before workspace binaries",
	"secondary-lockfile":
		"lock: secondary package lock tests/e2e/bun.lock is forbidden",
	"disabled-family-omission":
		"minimal fixture guard and artifact scan contain no disabled family residue",
	"composite-action-bun-pin":
		"proto: .github/actions/bootstrap/action.yml setup-bun omits bun-version",
};

const EXPECTED_MUTATION_TESTS: Record<
	(typeof REQUIRED_MUTATIONS)[number],
	string
> = Object.fromEntries(
	REQUIRED_MUTATIONS.map((name) => [
		name,
		name === "disabled-family-omission"
			? "scripts/template/__tests__/template.test.ts"
			: "scripts/template/__tests__/toolchain.test.ts",
	]),
) as Record<(typeof REQUIRED_MUTATIONS)[number], string>;

const REQUIRED_VALIDATIONS = [
	["bun", "install", "--frozen-lockfile"],
	["bun", "run", "toolchain:check"],
	["bun", "run", "template:validate"],
	["bun", "run", "template:test"],
	["bun", "run", "template:typecheck"],
	["bun", "run", "template:fixtures", "tmp/stage1-fixtures"],
	["bunx", "biome", "check", "--no-errors-on-unmatched", "."],
] as const;

const REQUIRED_MUTATION_RUN = [
	"bun",
	"test",
	"scripts/template/__tests__/toolchain.test.ts",
	"scripts/template/__tests__/template.test.ts",
	"-t",
	"passes the real tree and rejects known-bad authority mutations|checksum verifier fails closed before archive extraction|renders minimal twice with identical manifests and no disabled residue",
] as const;

const LOG_ROOT = "evidence/stage-1-toolchain-run";

const VALIDATION_LOG_NAMES = new Map<string, string>([
	[commandKey(["bun", "install", "--frozen-lockfile"]), "install"],
	[commandKey(["bun", "run", "toolchain:check"]), "toolchain"],
	[commandKey(["bun", "run", "template:validate"]), "validate"],
	[commandKey(["bun", "run", "template:test"]), "test"],
	[commandKey(["bun", "run", "template:typecheck"]), "typecheck"],
	[
		commandKey(["bun", "run", "template:fixtures", "tmp/stage1-fixtures"]),
		"fixtures",
	],
	[
		commandKey(["bunx", "biome", "check", "--no-errors-on-unmatched", "."]),
		"biome",
	],
]);

const REQUIRED_ROLLBACK_COMMAND = [
	"git",
	"revert",
	"-m",
	"1",
	"<stage-1-pr-merge-commit>",
] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
	const entry = value[key];
	return Array.isArray(entry) ? entry : [];
}

function names(entries: unknown[]): string[] {
	return entries.flatMap((entry) =>
		isRecord(entry) && typeof entry["name"] === "string" ? [entry["name"]] : [],
	);
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

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
			.map(([key, entry]) => [key, canonicalValue(entry)]),
	);
}

function sameValue(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(canonicalValue(left)) ===
		JSON.stringify(canonicalValue(right))
	);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
	return sameValue(Object.keys(value).sort(), [...expected].sort());
}

function sha256(value: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function valueSha256(value: unknown): string {
	return sha256(
		new TextEncoder().encode(JSON.stringify(canonicalValue(value))),
	);
}

function git(root: string, args: string[]): number {
	return Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode;
}

function gitOutput(
	root: string,
	args: string[],
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
	};
}

async function validateBoundLogs(
	root: string,
	entry: JsonRecord,
	name: string,
	errors: string[],
): Promise<string> {
	const contents: string[] = [];
	for (const stream of ["stdout", "stderr"] as const) {
		const pathKey = `${stream}Path`;
		const digestKey = `${stream}Sha256`;
		const expectedPath = `${LOG_ROOT}/${name}.${stream}`;
		if (entry[pathKey] !== expectedPath) {
			errors.push(`repository: ${name} ${stream} log path drifted`);
			continue;
		}
		const file = Bun.file(resolve(root, expectedPath));
		if (!(await file.exists())) {
			errors.push(`repository: ${name} ${stream} log is unavailable`);
			continue;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (entry[digestKey] !== sha256(bytes))
			errors.push(`repository: ${name} ${stream} log digest drifted`);
		contents.push(new TextDecoder().decode(bytes));
	}
	return contents.join("\n");
}

export function validateStageOneEvidenceValue(
	value: unknown,
	schema: JsonRecord,
): string[] {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;
	const run = recordAt(value, "run");
	const runId = run["id"];
	const mutationResult = recordAt(run, "mutationResult");
	if (
		!Array.isArray(mutationResult["command"]) ||
		commandKey(mutationResult["command"] as string[]) !==
			commandKey(REQUIRED_MUTATION_RUN)
	)
		errors.push("semantic: mutation result command drifted");
	if (mutationResult["runId"] !== runId)
		errors.push("semantic: mutation result belongs to another run");

	const mutationNames = names(arrayAt(value, "mutationProof"));
	for (const mutation of REQUIRED_MUTATIONS) {
		if (!mutationNames.includes(mutation))
			errors.push(`semantic: missing mutation proof ${mutation}`);
	}
	for (const mutation of duplicates(mutationNames))
		errors.push(`semantic: duplicate mutation proof ${mutation}`);
	for (const entry of arrayAt(value, "mutationProof")) {
		if (!isRecord(entry) || typeof entry["name"] !== "string") continue;
		const name = entry["name"] as (typeof REQUIRED_MUTATIONS)[number];
		if (
			name in EXPECTED_MUTATIONS &&
			entry["expected"] !== EXPECTED_MUTATIONS[name]
		)
			errors.push(`semantic: mutation proof ${name} expectation drifted`);
		if (
			name in EXPECTED_OBSERVATIONS &&
			entry["observed"] !== EXPECTED_OBSERVATIONS[name]
		)
			errors.push(`semantic: mutation proof ${name} observation drifted`);
		if (
			name in EXPECTED_MUTATION_TESTS &&
			entry["test"] !== EXPECTED_MUTATION_TESTS[name]
		)
			errors.push(`semantic: mutation proof ${name} test path drifted`);
		if (entry["runId"] !== runId)
			errors.push(`semantic: mutation proof ${name} belongs to another run`);
	}

	const validationCommands = arrayAt(value, "validation").flatMap((entry) => {
		if (!isRecord(entry) || !Array.isArray(entry["command"])) return [];
		if (!entry["command"].every((part) => typeof part === "string")) return [];
		return [commandKey(entry["command"] as string[])];
	});
	const requiredValidationCommands = REQUIRED_VALIDATIONS.map(commandKey);
	if (
		!sameValue(
			[...validationCommands].sort(),
			[...requiredValidationCommands].sort(),
		)
	)
		errors.push("semantic: validation command set drifted");
	const validationCommandSet = new Set(validationCommands);
	for (const command of REQUIRED_VALIDATIONS) {
		if (!validationCommandSet.has(commandKey(command)))
			errors.push(`semantic: missing validation ${command.join(" ")}`);
	}
	for (const entry of arrayAt(value, "validation")) {
		if (!isRecord(entry)) continue;
		if (entry["runId"] !== runId)
			errors.push("semantic: validation result belongs to another run");
		const startedAt = entry["startedAt"];
		const completedAt = entry["completedAt"];
		if (
			typeof startedAt === "string" &&
			typeof completedAt === "string" &&
			Date.parse(startedAt) > Date.parse(completedAt)
		)
			errors.push("semantic: validation result completed before it started");
	}

	const rollbackCommand = recordAt(value, "rollback")["command"];
	if (
		!Array.isArray(rollbackCommand) ||
		commandKey(rollbackCommand as string[]) !==
			commandKey(REQUIRED_ROLLBACK_COMMAND)
	)
		errors.push(
			"semantic: Stage 1 rollback must select merge mainline parent 1",
		);
	const runtimeCleanup = recordAt(value, "rollback")["runtimeCleanup"];
	const cleanupCommands = Array.isArray(runtimeCleanup)
		? runtimeCleanup.flatMap((command) =>
				Array.isArray(command) &&
				command.every((part) => typeof part === "string")
					? [commandKey(command as string[])]
					: [],
			)
		: [];
	const stopIndex = cleanupCommands.findIndex((command) =>
		command.includes('["devpod","stop","."'),
	);
	const containerRemovalIndex = cleanupCommands.findIndex((command) =>
		command.includes('["docker","rm"'),
	);
	const volumeRemovalIndex = cleanupCommands.findIndex((command) =>
		command.includes('["docker","volume","rm"'),
	);
	const recreateIndex = cleanupCommands.findIndex((command) =>
		command.includes('["devpod","up",".","--recreate"'),
	);
	if (volumeRemovalIndex === -1)
		errors.push("semantic: Stage 1 rollback omits scoped Proto volume removal");
	if (recreateIndex === -1)
		errors.push("semantic: Stage 1 rollback omits devcontainer recreation");
	if (
		stopIndex === -1 ||
		containerRemovalIndex === -1 ||
		volumeRemovalIndex === -1 ||
		stopIndex >= containerRemovalIndex ||
		containerRemovalIndex >= volumeRemovalIndex
	)
		errors.push(
			"semantic: Stage 1 rollback must stop and remove its container before deleting the Proto volume",
		);
	const rollbackProof = recordAt(recordAt(value, "rollback"), "proof");
	if (rollbackProof["runId"] !== runId)
		errors.push("semantic: rollback proof belongs to another run");
	if (rollbackProof["predecessorSha"] !== recordAt(value, "source")["baseSha"])
		errors.push("semantic: rollback proof targets another predecessor");
	if (
		!sameValue(rollbackProof["syntheticMergeParents"], [
			recordAt(value, "source")["baseSha"],
			recordAt(value, "source")["implementationSha"],
		])
	)
		errors.push(
			"semantic: synthetic merge parents drifted from source boundary",
		);
	if (rollbackProof["predecessorTree"] !== rollbackProof["revertedTree"])
		errors.push("semantic: rollback proof did not restore predecessor tree");

	const capturedAt = value["capturedAt"];
	if (
		typeof capturedAt === "string" &&
		Date.parse(capturedAt) > Date.now() + 5 * 60 * 1000
	)
		errors.push("semantic: Stage 1 evidence capture time is in the future");
	if (typeof capturedAt === "string") {
		const completedTimes = [
			mutationResult["completedAt"],
			...arrayAt(value, "validation").flatMap((entry) =>
				isRecord(entry) ? [entry["completedAt"]] : [],
			),
		].filter((entry): entry is string => typeof entry === "string");
		if (
			completedTimes.some(
				(completedAt) => Date.parse(capturedAt) < Date.parse(completedAt),
			)
		)
			errors.push("semantic: Stage 1 evidence predates its command results");
	}

	return [...new Set(errors)].sort();
}

export async function validateStageOneEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const evidencePath = resolve(root, "evidence/stage-1-toolchain.json");
	const schemaPath = resolve(root, "evidence/stage-1-toolchain.schema.json");
	const value = (await Bun.file(evidencePath).json()) as unknown;
	const schema = (await Bun.file(schemaPath).json()) as JsonRecord;
	const errors = validateStageOneEvidenceValue(value, schema);
	if (!isRecord(value)) return errors;

	const run = recordAt(value, "run");
	const resultsReference = recordAt(run, "results");
	const resultsPath = resultsReference["path"];
	let results: JsonRecord = {};
	if (resultsPath !== "evidence/stage-1-toolchain-results.json")
		errors.push("repository: Stage 1 results artifact path is incorrect");
	else {
		const resultFile = Bun.file(resolve(root, resultsPath));
		if (!(await resultFile.exists()))
			errors.push("repository: Stage 1 results artifact is unavailable");
		else {
			const bytes = new Uint8Array(await resultFile.arrayBuffer());
			if (resultsReference["sha256"] !== sha256(bytes))
				errors.push("repository: Stage 1 results artifact digest drifted");
			const parsed = (await resultFile.json()) as unknown;
			if (!isRecord(parsed))
				errors.push("repository: Stage 1 results artifact is malformed");
			else results = parsed;
		}
	}
	if (results["runId"] !== run["id"])
		errors.push("repository: Stage 1 results artifact belongs to another run");
	if (
		!hasExactKeys(results, [
			"schemaVersion",
			"runId",
			"mutationProof",
			"mutationProofSha256",
			"mutationResult",
			"validation",
			"validationSha256",
			"rollbackProof",
			"rollbackProofSha256",
		])
	)
		errors.push("repository: Stage 1 results artifact shape drifted");
	if (results["schemaVersion"] !== 1)
		errors.push("repository: Stage 1 results artifact schema version drifted");
	for (const digestKey of [
		"mutationProofSha256",
		"validationSha256",
		"rollbackProofSha256",
	]) {
		if (
			typeof results[digestKey] !== "string" ||
			!/^[0-9a-f]{64}$/.test(results[digestKey])
		)
			errors.push(`repository: Stage 1 results ${digestKey} is malformed`);
	}
	if (
		!sameValue(results["mutationProof"], value["mutationProof"]) ||
		results["mutationProofSha256"] !== valueSha256(value["mutationProof"])
	)
		errors.push("repository: mutation proof differs from captured results");
	if (!sameValue(results["mutationResult"], run["mutationResult"]))
		errors.push("repository: mutation result differs from captured results");
	if (
		!sameValue(results["validation"], value["validation"]) ||
		results["validationSha256"] !== valueSha256(value["validation"])
	)
		errors.push("repository: validation results differ from captured results");
	if (
		!sameValue(
			results["rollbackProof"],
			recordAt(value, "rollback")["proof"],
		) ||
		results["rollbackProofSha256"] !==
			valueSha256(recordAt(value, "rollback")["proof"])
	)
		errors.push("repository: rollback proof differs from captured results");

	const mutationLog = await validateBoundLogs(
		root,
		recordAt(run, "mutationResult"),
		"mutation",
		errors,
	);
	for (const entry of arrayAt(value, "mutationProof")) {
		if (
			isRecord(entry) &&
			typeof entry["name"] === "string" &&
			typeof entry["observed"] === "string" &&
			!mutationLog.includes(entry["observed"])
		)
			errors.push(
				`repository: mutation proof ${entry["name"]} is absent from captured output`,
			);
	}
	for (const entry of arrayAt(value, "validation")) {
		if (!isRecord(entry) || !Array.isArray(entry["command"])) continue;
		const name = VALIDATION_LOG_NAMES.get(
			commandKey(entry["command"] as string[]),
		);
		if (name) await validateBoundLogs(root, entry, name, errors);
	}
	const rollbackProofRecord = recordAt(recordAt(value, "rollback"), "proof");
	const rollbackLog = await validateBoundLogs(
		root,
		rollbackProofRecord,
		"rollback",
		errors,
	);
	for (const observation of arrayAt(rollbackProofRecord, "observations")) {
		if (typeof observation === "string" && !rollbackLog.includes(observation))
			errors.push(
				`repository: rollback observation is absent from captured output: ${observation}`,
			);
	}
	for (const required of [
		`headSha=${String(recordAt(value, "source")["implementationSha"] ?? "")}`,
		`predecessorSha=${String(recordAt(value, "source")["baseSha"] ?? "")}`,
		`syntheticMergeSha=${String(rollbackProofRecord["syntheticMergeSha"] ?? "")}`,
		`syntheticMergeTree=${String(rollbackProofRecord["syntheticMergeTree"] ?? "")}`,
		`syntheticMergeParents=${arrayAt(rollbackProofRecord, "syntheticMergeParents").join(",")}`,
		"revertExitCode=0",
		"treeMatchesPredecessor=true",
		"predecessorBun=1.3.4",
		"predecessorProtoNodeSelected=false",
		"predecessorNodeFeature=ghcr.io/devcontainers/features/node:1",
		"imageBuildExitCode=0",
		`nodePath=${String(rollbackProofRecord["nodePath"] ?? "")}`,
		`nodeVersion=${String(rollbackProofRecord["nodeVersion"] ?? "")}`,
		"protoNodeShim=absent",
		"imageCleanupExitCode=0",
	]) {
		if (!rollbackLog.includes(required))
			errors.push(`repository: rollback captured output omits ${required}`);
	}

	const packageValue = (await Bun.file(
		resolve(root, "package.json"),
	).json()) as JsonRecord;
	const catalog = recordAt(recordAt(packageValue, "workspaces"), "catalog");
	const evidenceCatalog = recordAt(recordAt(value, "catalog"), "packages");
	if (!sameValue(evidenceCatalog, catalog))
		errors.push("repository: evidence catalog differs from package.json");
	if (
		recordAt(value, "catalog")["packageCount"] !== Object.keys(catalog).length
	)
		errors.push("repository: evidence catalog count is inconsistent");

	const protoValue = Bun.TOML.parse(
		await Bun.file(resolve(root, ".prototools")).text(),
	) as JsonRecord;
	const selectedTools = Object.fromEntries(
		Object.entries(protoValue).filter(
			([name, version]) =>
				name !== "plugins" &&
				name !== "settings" &&
				typeof version === "string",
		),
	);
	const protoEvidence = recordAt(value, "proto");
	if (!sameValue(recordAt(protoEvidence, "selectedTools"), selectedTools))
		errors.push("repository: evidence Proto tools differ from .prototools");
	if (protoEvidence["version"] !== protoValue["proto"])
		errors.push("repository: evidence Proto version differs from .prototools");
	const pluginCommits = [
		...new Set(
			Object.values(recordAt(protoValue, "plugins")).flatMap((locator) => {
				if (typeof locator !== "string") return [];
				const match = /\/([0-9a-f]{40})\//.exec(locator);
				return match?.[1] ? [match[1]] : [];
			}),
		),
	].sort();
	const evidencePluginCommits = Array.isArray(protoEvidence["pluginCommits"])
		? [...protoEvidence["pluginCommits"]].sort()
		: [];
	if (!sameValue(evidencePluginCommits, pluginCommits))
		errors.push(
			"repository: evidence Proto plugin commits differ from .prototools",
		);

	const checksumText = await Bun.file(
		resolve(root, ".devcontainer/proto-checksums.txt"),
	).text();
	const checksumMap: JsonRecord = {};
	for (const line of checksumText.trim().split("\n")) {
		const match = /^([0-9a-f]{64}) {2}proto_cli-(x86_64|aarch64)-/.exec(line);
		if (match?.[1] && match[2])
			checksumMap[match[2] === "x86_64" ? "amd64" : "arm64"] = match[1];
	}
	if (!sameValue(recordAt(protoEvidence, "checksums"), checksumMap))
		errors.push(
			"repository: evidence Proto checksums differ from checksum metadata",
		);

	const lockText = await Bun.file(resolve(root, "bun.lock")).text();
	const locked = (packageName: string): string =>
		resolvedVersions(lockText, packageName)[0] ?? "";
	const coupledFamilies = {
		cloudflare: {
			wrangler: catalog["wrangler"],
			vitePlugin: catalog["@cloudflare/vite-plugin"],
			vitestPool: catalog["@cloudflare/vitest-pool-workers"],
			miniflare: locked("miniflare"),
			workerd: locked("workerd"),
		},
		betterAuth: {
			package: catalog["better-auth"],
			core: locked("@better-auth/core"),
		},
		forms: {
			zod: catalog["zod"],
			reactHookForm: catalog["react-hook-form"],
			resolvers: catalog["@hookform/resolvers"],
		},
		playwright: {
			test: catalog["@playwright/test"],
			runtime: locked("playwright"),
			core: locked("playwright-core"),
		},
	};
	if (!sameValue(recordAt(value, "coupledFamilies"), coupledFamilies))
		errors.push(
			"repository: evidence coupled families differ from catalog/lock",
		);

	const locks = recordAt(value, "locks");
	for (const [name, expectedPath] of [
		["package", "bun.lock"],
		["features", ".devcontainer/devcontainer-lock.json"],
		["protoChecksums", ".devcontainer/proto-checksums.txt"],
	] as const) {
		const lock = recordAt(locks, name);
		if (lock["path"] !== expectedPath)
			errors.push(`repository: evidence ${name} lock path is incorrect`);
		else {
			const bytes = new Uint8Array(
				await Bun.file(resolve(root, expectedPath)).arrayBuffer(),
			);
			if (lock["sha256"] !== sha256(bytes))
				errors.push(`repository: evidence ${name} lock digest drifted`);
		}
	}
	const featureLock = (await Bun.file(
		resolve(root, ".devcontainer/devcontainer-lock.json"),
	).json()) as JsonRecord;
	if (
		recordAt(locks, "features")["count"] !==
		Object.keys(recordAt(featureLock, "features")).length
	)
		errors.push("repository: evidence feature lock count is inconsistent");

	const baseSha = recordAt(value, "source")["baseSha"];
	const implementationSha = recordAt(value, "source")["implementationSha"];
	if (typeof baseSha !== "string")
		errors.push("repository: Stage 1 base commit is unavailable");
	else {
		if (git(root, ["cat-file", "-e", `${baseSha}^{commit}`]) !== 0)
			errors.push(`repository: Stage 1 base commit ${baseSha} is unavailable`);
		if (git(root, ["merge-base", "--is-ancestor", baseSha, "HEAD"]) !== 0)
			errors.push("repository: Stage 1 base commit is not an ancestor of HEAD");
	}
	if (implementationSha !== undefined) {
		if (typeof implementationSha !== "string")
			errors.push("repository: Stage 1 implementation commit is unavailable");
		else {
			if (git(root, ["cat-file", "-e", `${implementationSha}^{commit}`]) !== 0)
				errors.push(
					`repository: Stage 1 implementation commit ${implementationSha} is unavailable`,
				);
			if (
				typeof baseSha === "string" &&
				git(root, [
					"merge-base",
					"--is-ancestor",
					baseSha,
					implementationSha,
				]) !== 0
			)
				errors.push(
					"repository: Stage 1 base is not an ancestor of implementation",
				);
			if (
				git(root, [
					"merge-base",
					"--is-ancestor",
					implementationSha,
					"HEAD",
				]) !== 0
			)
				errors.push(
					"repository: Stage 1 implementation is not an ancestor of HEAD",
				);
			if (typeof baseSha === "string") {
				const predecessorTree = gitOutput(root, [
					"rev-parse",
					`${baseSha}^{tree}`,
				]);
				const implementationTree = gitOutput(root, [
					"rev-parse",
					`${implementationSha}^{tree}`,
				]);
				if (predecessorTree.exitCode !== 0 || implementationTree.exitCode !== 0)
					errors.push(
						"repository: Stage 1 rollback trees could not be inspected",
					);
				else {
					if (
						rollbackProofRecord["predecessorTree"] !== predecessorTree.stdout ||
						rollbackProofRecord["revertedTree"] !== predecessorTree.stdout
					)
						errors.push(
							"repository: rollback proof tree differs from actual predecessor tree",
						);
					const merge = syntheticMergeMetadata(
						baseSha,
						implementationSha,
						implementationTree.stdout,
					);
					if (rollbackProofRecord["syntheticMergeTree"] !== merge.tree)
						errors.push(
							"repository: synthetic merge tree differs from implementation tree",
						);
					if (
						!sameValue(
							rollbackProofRecord["syntheticMergeParents"],
							merge.parents,
						)
					)
						errors.push(
							"repository: synthetic merge parents differ from source boundary",
						);
					if (rollbackProofRecord["syntheticMergeSha"] !== merge.sha)
						errors.push(
							"repository: synthetic merge commit does not match deterministic metadata",
						);
				}
			}
			const boundaryDiff = gitOutput(root, [
				"diff",
				"--name-only",
				implementationSha,
				"HEAD",
			]);
			if (boundaryDiff.exitCode !== 0)
				errors.push(
					"repository: Stage 1 evidence boundary could not be inspected",
				);
			else {
				for (const path of boundaryDiff.stdout.split("\n").filter(Boolean)) {
					if (
						path !== "evidence/stage-1-toolchain.json" &&
						path !== "evidence/stage-1-toolchain-results.json" &&
						!path.startsWith("evidence/stage-1-toolchain-run/")
					)
						errors.push(
							`repository: post-implementation boundary changes non-evidence path ${path}`,
						);
				}
			}
		}
	}
	if (recordAt(value, "source")["featureTreeClean"] === true) {
		const status = gitOutput(root, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--",
			".",
			":(exclude)graphify-out/**",
		]);
		if (status.exitCode !== 0 || status.stdout !== "")
			errors.push("repository: non-Graphify feature tree is not clean");
	}

	return [...new Set(errors)].sort();
}
