// biome-ignore-all lint/complexity/useLiteralKeys: Strict JSON records require bracket access.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";
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
	};

const REQUIRED_VALIDATIONS = [
	["bun", "install", "--frozen-lockfile"],
	["bun", "run", "toolchain:check"],
	["bun", "run", "template:validate"],
	["bun", "run", "template:test"],
	["bun", "run", "template:typecheck"],
	["bun", "run", "template:fixtures", "tmp/stage1-fixtures"],
	["bunx", "biome", "check", "--no-errors-on-unmatched", "."],
] as const;

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

function sameValue(left: unknown, right: unknown): boolean {
	const stable = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(stable);
		if (!isRecord(value)) return value;
		return Object.fromEntries(
			Object.entries(value)
				.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
				.map(([key, entry]) => [key, stable(entry)]),
		);
	};
	return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function sha256(value: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
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

export function validateStageOneEvidenceValue(
	value: unknown,
	schema: JsonRecord,
): string[] {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;

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
	}

	const validationCommands = new Set(
		arrayAt(value, "validation").flatMap((entry) => {
			if (!isRecord(entry) || !Array.isArray(entry["command"])) return [];
			if (!entry["command"].every((part) => typeof part === "string"))
				return [];
			return [commandKey(entry["command"] as string[])];
		}),
	);
	for (const command of REQUIRED_VALIDATIONS) {
		if (!validationCommands.has(commandKey(command)))
			errors.push(`semantic: missing validation ${command.join(" ")}`);
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
		? new Set(
				runtimeCleanup.flatMap((command) =>
					Array.isArray(command) &&
					command.every((part) => typeof part === "string")
						? [commandKey(command as string[])]
						: [],
				),
			)
		: new Set<string>();
	if (
		![...cleanupCommands].some((command) =>
			command.includes('["docker","volume","rm"'),
		)
	)
		errors.push("semantic: Stage 1 rollback omits scoped Proto volume removal");
	if (
		![...cleanupCommands].some((command) =>
			command.includes('["devpod","up",".","--recreate"'),
		)
	)
		errors.push("semantic: Stage 1 rollback omits devcontainer recreation");

	const capturedAt = value["capturedAt"];
	if (
		typeof capturedAt === "string" &&
		Date.parse(capturedAt) > Date.now() + 5 * 60 * 1000
	)
		errors.push("semantic: Stage 1 evidence capture time is in the future");

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
						path !== "evidence/stage-1-toolchain.schema.json"
					)
						errors.push(
							`repository: post-implementation boundary changes non-evidence path ${path}`,
						);
				}
			}
		}
	}
	if (
		recordAt(value, "source")["featureTreeClean"] === true &&
		git(root, [
			"diff",
			"--quiet",
			"HEAD",
			"--",
			".",
			":(exclude)graphify-out/**",
		]) !== 0
	)
		errors.push("repository: non-Graphify feature tree is not clean");

	return [...new Set(errors)].sort();
}
