// biome-ignore-all lint/complexity/useLiteralKeys: Evidence records intentionally use strict JSON keys.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";

export type JsonRecord = Record<string, unknown>;

export interface BuildStageStatus {
	cachedStages: string[];
	rebuiltStages: string[];
}

export const STAGE_TWO_COMMAND_IDS = [
	"clean-build",
	"warm-build",
	"definition-fingerprint",
	"image-inspect",
	"image-contract",
	"layer-invalidation",
	"architecture-amd64",
	"architecture-arm64",
	"stale-image-refusal",
	"partition-mutation",
	"shell-bash-login",
	"shell-bash-non-login",
	"shell-zsh-login",
	"shell-zsh-non-login",
	"second-worktree-storage",
	"rollback-proof",
] as const;

export type StageTwoCommandId = (typeof STAGE_TWO_COMMAND_IDS)[number];

const SHELL_CASES = [
	["bash", "login", "shell-bash-login", "-lc"],
	["bash", "non-login", "shell-bash-non-login", "-c"],
	["zsh", "login", "shell-zsh-login", "-lc"],
	["zsh", "non-login", "shell-zsh-non-login", "-c"],
] as const;

const ARCHITECTURES = ["amd64", "arm64"] as const;
const LOG_ROOT = "evidence/stage-2-image-run";
const COLLECTOR = "scripts/template/collect-stage-two-evidence.ts";
const SHELL_PROBE = 'command -v bun; command -v proto; printf "%s\\n" "$PATH"';
const ROLLBACK_COMMAND = [
	"git",
	"revert",
	"-m",
	"1",
	"<stage-2-pr-merge-commit>",
] as const;
export const STAGE_TWO_SYNTHETIC_MERGE_SUBJECT = "Stage 2 synthetic merge";
export const STAGE_TWO_SYNTHETIC_NAME = "Stage Two Evidence";
export const STAGE_TWO_SYNTHETIC_EMAIL = "stage-two-evidence@example.invalid";
export const STAGE_TWO_SYNTHETIC_DATE = "1970-01-01T00:00:00Z";

export function isRecord(value: unknown): value is JsonRecord {
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

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalValue(entry)]),
	);
}

function sameValue(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(canonicalValue(left)) ===
		JSON.stringify(canonicalValue(right))
	);
}

function names(entries: unknown[], key: string): string[] {
	return entries.flatMap((entry) =>
		isRecord(entry) && typeof entry[key] === "string"
			? [entry[key] as string]
			: [],
	);
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const found = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) found.add(value);
		seen.add(value);
	}
	return [...found].sort();
}

export function sha256(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function syntheticStageTwoMergeMetadata(
	baseSha: string,
	implementationSha: string,
	implementationTree: string,
): { sha: string; tree: string; parents: [string, string] } {
	const identity = `${STAGE_TWO_SYNTHETIC_NAME} <${STAGE_TWO_SYNTHETIC_EMAIL}>`;
	const content = [
		`tree ${implementationTree}`,
		`parent ${baseSha}`,
		`parent ${implementationSha}`,
		`author ${identity} 0 +0000`,
		`committer ${identity} 0 +0000`,
		"",
		STAGE_TWO_SYNTHETIC_MERGE_SUBJECT,
		"",
	].join("\n");
	const body = new TextEncoder().encode(content);
	const header = new TextEncoder().encode(`commit ${body.byteLength}\0`);
	const object = new Uint8Array(header.byteLength + body.byteLength);
	object.set(header);
	object.set(body, header.byteLength);
	return {
		sha: new Bun.CryptoHasher("sha1").update(object).digest("hex"),
		tree: implementationTree,
		parents: [baseSha, implementationSha],
	};
}

export function classifyBuildStages(output: string): BuildStageStatus {
	const stepStages = new Map<string, string>();
	const statuses = new Map<string, "cached" | "rebuilt">();
	for (const line of output.split("\n")) {
		const instruction =
			/^#(\d+) \[([a-z][a-z0-9_]*) \d+\/\d+\] (?:RUN|COPY|WORKDIR)\b/.exec(
				line,
			);
		if (instruction?.[1] && instruction[2])
			stepStages.set(instruction[1], instruction[2]);
		const completion = /^#(\d+) (CACHED|DONE)\b/.exec(line);
		if (!completion?.[1] || !completion[2]) continue;
		const stage = stepStages.get(completion[1]);
		if (!stage) continue;
		if (completion[2] === "CACHED") {
			if (!statuses.has(stage)) statuses.set(stage, "cached");
		} else statuses.set(stage, "rebuilt");
	}
	return {
		cachedStages: [...statuses]
			.filter(([, status]) => status === "cached")
			.map(([stage]) => stage)
			.sort(),
		rebuiltStages: [...statuses]
			.filter(([, status]) => status === "rebuilt")
			.map(([stage]) => stage)
			.sort(),
	};
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
	return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

function exactVersion(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
	);
}

function requiredContext(value: JsonRecord): {
	runId: string;
	temporaryRoot: string;
	nativeArchitecture: string;
	imageTag: string;
	baseSha: string;
	implementationSha: string;
	alternateCodexVersion: string;
} {
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const image = recordAt(value, "image");
	return {
		runId: String(run["id"] ?? ""),
		temporaryRoot: String(run["temporaryRoot"] ?? ""),
		nativeArchitecture: String(run["nativeArchitecture"] ?? ""),
		imageTag: String(image["tag"] ?? ""),
		baseSha: String(source["baseSha"] ?? ""),
		implementationSha: String(source["implementationSha"] ?? ""),
		alternateCodexVersion: String(image["alternateCodexVersion"] ?? ""),
	};
}

export function expectedStageTwoCommands(
	value: JsonRecord,
): Record<StageTwoCommandId, string[]> {
	const context = requiredContext(value);
	const build = (extra: string[]): string[] => [
		"docker",
		"buildx",
		"build",
		"--file",
		".devcontainer/Dockerfile",
		"--platform",
		`linux/${context.nativeArchitecture}`,
		"--target",
		"development",
		"--tag",
		context.imageTag,
		"--progress",
		"plain",
		...extra,
		".",
	];
	const commands = {
		"clean-build": build(["--load", "--no-cache"]),
		"warm-build": build(["--load"]),
		"definition-fingerprint": [
			"bash",
			".devcontainer/devcontainer-fingerprint.sh",
			".",
		],
		"image-inspect": [
			"docker",
			"image",
			"inspect",
			"--format",
			"{{.Id}}",
			context.imageTag,
		],
		"image-contract": [
			"docker",
			"run",
			"--rm",
			context.imageTag,
			"bash",
			"-lc",
			'printf "definition=%s\\n" "$(cat /usr/local/share/devenv-image/definition.sha256)"; printf "manifest=%s\\n" "$(cat /usr/local/share/devenv-image/prototools.sha256)"',
		],
		"layer-invalidation": [
			"docker",
			"buildx",
			"build",
			"--file",
			".devcontainer/Dockerfile",
			"--platform",
			`linux/${context.nativeArchitecture}`,
			"--target",
			"development",
			"--build-arg",
			`CODEX_VERSION=${context.alternateCodexVersion}`,
			"--no-cache-filter",
			"codex_payload",
			"--no-cache-filter",
			"development",
			"--progress",
			"plain",
			"--output",
			"type=cacheonly",
			".",
		],
		"architecture-amd64": [
			"docker",
			"buildx",
			"build",
			"--file",
			".devcontainer/Dockerfile",
			"--platform",
			"linux/amd64",
			"--target",
			"development",
			"--no-cache",
			"--progress",
			"plain",
			"--output",
			"type=cacheonly",
			".",
		],
		"architecture-arm64": [
			"docker",
			"buildx",
			"build",
			"--file",
			".devcontainer/Dockerfile",
			"--platform",
			"linux/arm64",
			"--target",
			"development",
			"--no-cache",
			"--progress",
			"plain",
			"--output",
			"type=cacheonly",
			".",
		],
		"stale-image-refusal": [
			"bun",
			COLLECTOR,
			"probe-stale",
			"--image",
			context.imageTag,
			"--workspace",
			`${context.temporaryRoot}/stale-workspace`,
		],
		"partition-mutation": [
			"bun",
			COLLECTOR,
			"probe-partition",
			"--root",
			".",
			"--mutation",
			"drop-foundation-uv",
		],
		"shell-bash-login": [
			"docker",
			"run",
			"--rm",
			context.imageTag,
			"bash",
			"-lc",
			SHELL_PROBE,
		],
		"shell-bash-non-login": [
			"docker",
			"run",
			"--rm",
			context.imageTag,
			"bash",
			"-c",
			SHELL_PROBE,
		],
		"shell-zsh-login": [
			"docker",
			"run",
			"--rm",
			context.imageTag,
			"zsh",
			"-lc",
			SHELL_PROBE,
		],
		"shell-zsh-non-login": [
			"docker",
			"run",
			"--rm",
			context.imageTag,
			"zsh",
			"-c",
			SHELL_PROBE,
		],
		"second-worktree-storage": [
			"bun",
			COLLECTOR,
			"probe-storage",
			"--image",
			context.imageTag,
			"--run-id",
			context.runId,
			"--implementation",
			context.implementationSha,
			"--workspace",
			`${context.temporaryRoot}/second-worktree`,
		],
		"rollback-proof": [
			"bun",
			COLLECTOR,
			"probe-rollback",
			"--base",
			context.baseSha,
			"--implementation",
			context.implementationSha,
			"--workspace",
			`${context.temporaryRoot}/rollback-worktree`,
		],
	} satisfies Record<StageTwoCommandId, string[]>;
	return commands;
}

export function validateStageTwoEvidenceValue(
	value: unknown,
	schema: JsonRecord,
): string[] {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const image = recordAt(value, "image");
	const runId = run["id"];
	const expectedCommands = expectedStageTwoCommands(value);
	const commandEntries = arrayAt(value, "commands");
	const commandIds = names(commandEntries, "id");
	const commandById = new Map(
		commandEntries.flatMap((entry) =>
			isRecord(entry) && typeof entry["id"] === "string"
				? [[entry["id"] as string, entry] as const]
				: [],
		),
	);

	if (!sameValue([...commandIds].sort(), [...STAGE_TWO_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 2 command set drifted");
	for (const duplicate of duplicates(commandIds))
		errors.push(`semantic: duplicate command result ${duplicate}`);
	for (const id of STAGE_TWO_COMMAND_IDS) {
		if (!commandIds.includes(id))
			errors.push(`semantic: missing command result ${id}`);
	}
	for (const entry of commandEntries) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageTwoCommandId;
		if (
			id in expectedCommands &&
			!sameValue(entry["command"], expectedCommands[id])
		)
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== runId)
			errors.push(`semantic: command ${id} belongs to another run`);
		if (entry["exitCode"] !== 0 || entry["status"] !== "pass")
			errors.push(`semantic: command ${id} did not pass`);
		if (
			typeof entry["startedAt"] === "string" &&
			typeof entry["completedAt"] === "string" &&
			Number.isFinite(Date.parse(entry["startedAt"] as string)) &&
			Number.isFinite(Date.parse(entry["completedAt"] as string))
		) {
			const wallDuration =
				Date.parse(entry["completedAt"] as string) -
				Date.parse(entry["startedAt"] as string);
			if (wallDuration < 0)
				errors.push(`semantic: command ${id} completed before it started`);
			if (
				typeof entry["durationMs"] === "number" &&
				Math.abs(entry["durationMs"] - wallDuration) > 2_000
			)
				errors.push(
					`semantic: command ${id} duration differs from its timestamps`,
				);
		}
		for (const stream of ["stdout", "stderr"] as const) {
			if (entry[`${stream}Path`] !== `${LOG_ROOT}/${id}.${stream}`)
				errors.push(`semantic: command ${id} ${stream} path drifted`);
		}
	}

	if (source["baseSha"] === source["implementationSha"])
		errors.push("semantic: Stage 2 base and implementation SHAs are identical");
	if (image["tag"] !== `devenv-stage2-${String(runId ?? "")}`)
		errors.push("semantic: Stage 2 image tag is not run-scoped");
	if (
		!exactVersion(image["codexVersion"]) ||
		!exactVersion(image["alternateCodexVersion"])
	)
		errors.push("semantic: layer invalidation pins must be exact versions");
	else if (image["codexVersion"] === image["alternateCodexVersion"])
		errors.push("semantic: layer invalidation did not change the Codex pin");
	if (image["definitionFingerprint"] !== image["definitionMarker"])
		errors.push(
			"semantic: image definition marker differs from the reviewed definition",
		);
	if (image["protoManifestSha256"] !== image["protoManifestMarker"])
		errors.push(
			"semantic: image Proto marker differs from the reviewed manifest",
		);

	const builds = recordAt(value, "builds");
	const clean = recordAt(builds, "clean");
	const warm = recordAt(builds, "warm");
	if (clean["durationMs"] !== commandById.get("clean-build")?.["durationMs"])
		errors.push(
			"semantic: clean build duration differs from its command result",
		);
	if (warm["durationMs"] !== commandById.get("warm-build")?.["durationMs"])
		errors.push(
			"semantic: warm build duration differs from its command result",
		);
	if (clean["commandId"] !== "clean-build" || clean["noCache"] !== true)
		errors.push("semantic: clean build is not bound to --no-cache");
	if (
		warm["commandId"] !== "warm-build" ||
		Number(warm["cachedSteps"] ?? 0) < 1
	)
		errors.push("semantic: warm build has no observed cache reuse");
	if (
		Number(warm["durationMs"] ?? Infinity) > Number(clean["durationMs"] ?? -1)
	)
		errors.push("semantic: warm build is slower than the clean build");

	const invalidation = recordAt(value, "layerInvalidation");
	const cachedStages = Array.isArray(invalidation["cachedStages"])
		? (invalidation["cachedStages"] as unknown[])
		: [];
	const rebuiltStages = Array.isArray(invalidation["rebuiltStages"])
		? (invalidation["rebuiltStages"] as unknown[])
		: [];
	for (const stage of [
		"stable_base",
		"proto_foundation",
		"proto_auxiliary",
		"graphify_payload",
	])
		if (!cachedStages.includes(stage))
			errors.push(`semantic: layer invalidation did not preserve ${stage}`);
	if (
		!rebuiltStages.includes("codex_payload") ||
		cachedStages.includes("codex_payload") ||
		!rebuiltStages.includes("development") ||
		cachedStages.includes("development")
	)
		errors.push(
			"semantic: Codex pin mutation did not isolate codex_payload invalidation",
		);

	const architectureEntries = arrayAt(value, "architectures");
	const architectureNames = names(architectureEntries, "architecture");
	if (!sameValue([...architectureNames].sort(), [...ARCHITECTURES].sort()))
		errors.push("semantic: supported architecture evidence is incomplete");
	for (const architecture of architectureEntries) {
		if (
			!isRecord(architecture) ||
			typeof architecture["architecture"] !== "string"
		)
			continue;
		const name = architecture["architecture"];
		if (
			architecture["commandId"] !== `architecture-${name}` ||
			architecture["status"] !== "pass"
		)
			errors.push(
				`semantic: architecture ${name} is not bound to its successful build`,
			);
		const rebuilt = arrayAt(architecture, "rebuiltStages");
		for (const stage of [
			"stable_base",
			"proto_foundation",
			"claude_payload",
			"development",
		])
			if (!rebuilt.includes(stage))
				errors.push(`semantic: architecture ${name} did not execute ${stage}`);
	}

	const stale = recordAt(value, "staleImageRefusal");
	if (
		stale["commandId"] !== "stale-image-refusal" ||
		stale["refused"] !== true ||
		Number(stale["containerExitCode"] ?? 0) === 0
	)
		errors.push("semantic: stale image refusal was not observed");
	if (
		stale["mutation"] !==
			"shadow-workspace-contract-tools-and-edit-definition" ||
		stale["shadowBunPath"] !== "/workspace/node_modules/.bin/bun" ||
		stale["shadowBashPath"] !== "/workspace/node_modules/.bin/bash" ||
		!sameValue(stale["shadowUtilityPaths"], [
			"/workspace/node_modules/.bin/readlink",
			"/workspace/node_modules/.bin/sha256sum",
			"/workspace/node_modules/.bin/awk",
			"/workspace/node_modules/.bin/tr",
		])
	)
		errors.push("semantic: stale image shadow-Bun mutation drifted");
	if (
		stale["originalDefinitionFingerprint"] ===
		stale["mutatedDefinitionFingerprint"]
	)
		errors.push("semantic: stale image mutation did not change the definition");
	if (!String(stale["diagnostic"] ?? "").includes("Rebuild/recreate"))
		errors.push(
			"semantic: stale image refusal omits rebuild/recreate guidance",
		);

	const partition = recordAt(value, "partitionMutation");
	if (
		partition["commandId"] !== "partition-mutation" ||
		partition["mutation"] !== "drop-foundation-uv" ||
		partition["rejected"] !== true
	)
		errors.push("semantic: Proto partition mutation was not rejected");
	if (
		!String(partition["diagnostic"] ?? "").includes("root tool uv is missing")
	)
		errors.push("semantic: Proto partition mutation diagnostic drifted");

	const shellEntries = arrayAt(value, "shellPaths");
	const shellCaseNames = shellEntries.flatMap((entry) =>
		isRecord(entry)
			? [`${String(entry["shell"])}:${String(entry["mode"])}`]
			: [],
	);
	const expectedShellNames = SHELL_CASES.map(
		([shell, mode]) => `${shell}:${mode}`,
	);
	if (!sameValue([...shellCaseNames].sort(), [...expectedShellNames].sort()))
		errors.push("semantic: login/non-login shell matrix is incomplete");
	for (const entry of shellEntries) {
		if (!isRecord(entry)) continue;
		const shellCase = SHELL_CASES.find(
			([shell, mode]) => shell === entry["shell"] && mode === entry["mode"],
		);
		if (shellCase && entry["commandId"] !== shellCase[2])
			errors.push(
				`semantic: shell ${shellCase[0]} ${shellCase[1]} command binding drifted`,
			);
		if (!String(entry["bunPath"] ?? "").startsWith("/home/vscode/.proto/"))
			errors.push("semantic: shell resolved Bun outside image-owned Proto");
		if (!String(entry["protoPath"] ?? "").startsWith("/home/vscode/.proto/"))
			errors.push("semantic: shell resolved Proto outside image-owned Proto");
		const path = String(entry["path"] ?? "").split(":");
		if (
			path[0] !== "/workspace/node_modules/.bin" ||
			path[1] !== "/home/vscode/.proto/shims" ||
			path[2] !== "/home/vscode/.proto/bin"
		)
			errors.push("semantic: shell PATH ownership order drifted");
	}

	const storage = recordAt(value, "secondWorktreeStorage");
	if (storage["commandId"] !== "second-worktree-storage")
		errors.push("semantic: second-worktree storage command binding drifted");
	if (storage["primaryContainerId"] === storage["secondContainerId"])
		errors.push("semantic: storage proof reused one container identity");
	if (
		storage["primaryImageId"] !== image["imageId"] ||
		storage["secondImageId"] !== image["imageId"]
	)
		errors.push("semantic: second worktree did not share the measured image");
	if (storage["protoVolumeCount"] !== 0 || storage["protoMountCount"] !== 0)
		errors.push("semantic: second worktree retained mutable Proto storage");
	if (
		Number(storage["observedBytes"] ?? Infinity) >
		Number(storage["stageZeroBaselineBytes"] ?? -1)
	)
		errors.push("semantic: second-worktree storage regressed from Stage 0");
	if (
		Number(storage["observedBytes"] ?? -1) !==
		Number(storage["secondContainerWritableBytes"] ?? 0) +
			Number(storage["secondCheckoutBytes"] ?? 0) +
			Number(storage["volumeBytes"] ?? 0)
	)
		errors.push("semantic: second-worktree storage arithmetic is inconsistent");
	if (
		Number(storage["secondContainerWritableBytes"] ?? Infinity) >=
		Number(storage["imageProtoBytes"] ?? 0)
	)
		errors.push(
			"semantic: second container appears to copy the image-owned Proto payload",
		);
	if (arrayAt(storage, "operations").length < 6)
		errors.push("semantic: second-worktree storage operations are vacuous");

	const rollback = recordAt(value, "rollback");
	if (!sameValue(rollback["command"], ROLLBACK_COMMAND))
		errors.push(
			"semantic: Stage 2 rollback must select merge mainline parent 1",
		);
	const cleanup = arrayAt(rollback, "runtimeCleanup");
	if (cleanup.length < 4)
		errors.push("semantic: Stage 2 rollback cleanup is incomplete");
	if (JSON.stringify(cleanup).includes("prune"))
		errors.push("semantic: Stage 2 rollback must not use global Docker prune");
	if (
		!JSON.stringify(cleanup).includes(
			`com.devenv.evidence.run=${String(runId ?? "")}`,
		)
	)
		errors.push("semantic: Stage 2 rollback cleanup is not run-scoped");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["treeMatchesPredecessor"] !== true
	)
		errors.push("semantic: Stage 2 rollback proof is incomplete");
	if (
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"]
	)
		errors.push(
			"semantic: Stage 2 rollback proof targets another source boundary",
		);
	if (proof["predecessorTree"] !== proof["revertedTree"])
		errors.push(
			"semantic: Stage 2 rollback did not restore the predecessor tree",
		);
	if (arrayAt(proof, "operations").length < 5)
		errors.push("semantic: Stage 2 rollback operations are vacuous");

	const capturedAt = value["capturedAt"];
	if (typeof capturedAt === "string") {
		if (Date.parse(capturedAt) > Date.now() + 5 * 60 * 1000)
			errors.push("semantic: Stage 2 evidence capture time is in the future");
		for (const entry of commandEntries) {
			if (
				isRecord(entry) &&
				typeof entry["completedAt"] === "string" &&
				Date.parse(capturedAt) < Date.parse(entry["completedAt"] as string)
			)
				errors.push("semantic: Stage 2 evidence predates its command results");
		}
	}

	return [...new Set(errors)].sort();
}

export async function validateBoundStageTwoLogs(
	root: string,
	value: unknown,
): Promise<string[]> {
	if (!isRecord(value))
		return ["repository: Stage 2 evidence is not an object"];
	const errors: string[] = [];
	const contents = new Map<string, string>();
	for (const entry of arrayAt(value, "commands")) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		for (const stream of ["stdout", "stderr"] as const) {
			const path = entry[`${stream}Path`];
			if (typeof path !== "string") continue;
			const file = Bun.file(resolve(root, path));
			if (!(await file.exists())) {
				errors.push(`repository: ${entry["id"]} ${stream} log is unavailable`);
				continue;
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (entry[`${stream}Sha256`] !== sha256(bytes))
				errors.push(`repository: ${entry["id"]} ${stream} log digest drifted`);
			contents.set(`${entry["id"]}:${stream}`, new TextDecoder().decode(bytes));
		}
	}
	const combined = (id: string): string =>
		`${contents.get(`${id}:stdout`) ?? ""}\n${contents.get(`${id}:stderr`) ?? ""}`;
	const boundProbeRecord = (id: string): JsonRecord => {
		try {
			const parsed = JSON.parse(contents.get(`${id}:stdout`) ?? "");
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	};
	const image = recordAt(value, "image");
	if (combined("image-inspect").trim() !== String(image["imageId"] ?? ""))
		errors.push("repository: image identity is absent from its bound log");
	for (const [label, field] of [
		["definition", "definitionMarker"],
		["manifest", "protoManifestMarker"],
	] as const) {
		if (
			!combined("image-contract").includes(
				`${label}=${String(image[field] ?? "")}`,
			)
		)
			errors.push(
				`repository: image ${label} marker is absent from its bound log`,
			);
	}
	if (!combined("warm-build").includes("CACHED"))
		errors.push("repository: warm build log contains no cache hit");
	const commands = new Map(
		arrayAt(value, "commands").flatMap((entry) =>
			isRecord(entry) && typeof entry["id"] === "string"
				? [[entry["id"] as string, entry] as const]
				: [],
		),
	);
	for (const id of ["clean-build", "warm-build"] as const) {
		const build = recordAt(
			recordAt(value, "builds"),
			id.split("-")[0] as "clean" | "warm",
		);
		const cachedSteps = combined(id).match(/\bCACHED\b/g)?.length ?? 0;
		if (build["cachedSteps"] !== cachedSteps)
			errors.push(`repository: ${id} cache count differs from its bound log`);
		if (build["durationMs"] !== commands.get(id)?.["durationMs"])
			errors.push(`repository: ${id} duration differs from its command result`);
	}
	const stale = recordAt(value, "staleImageRefusal");
	if (!sameValue(boundProbeRecord("stale-image-refusal"), stale))
		errors.push("repository: stale-image evidence differs from its bound log");
	const partition = recordAt(value, "partitionMutation");
	if (!sameValue(boundProbeRecord("partition-mutation"), partition))
		errors.push("repository: partition evidence differs from its bound log");
	for (const shell of arrayAt(value, "shellPaths")) {
		if (!isRecord(shell) || typeof shell["commandId"] !== "string") continue;
		const output = combined(shell["commandId"] as string);
		for (const field of ["bunPath", "protoPath", "path"])
			if (!output.includes(String(shell[field] ?? "")))
				errors.push(
					`repository: shell ${shell["commandId"]} ${field} is absent from its bound log`,
				);
	}
	for (const [id, evidenceKey] of [
		["second-worktree-storage", "secondWorktreeStorage"],
		["rollback-proof", "proof"],
	] as const) {
		const target =
			evidenceKey === "proof"
				? recordAt(recordAt(value, "rollback"), "proof")
				: recordAt(value, evidenceKey);
		if (!sameValue(boundProbeRecord(id), target))
			errors.push(`repository: ${id} evidence differs from its bound log`);
	}
	for (const architecture of arrayAt(value, "architectures")) {
		if (
			!isRecord(architecture) ||
			typeof architecture["commandId"] !== "string"
		)
			continue;
		const observed = classifyBuildStages(combined(architecture["commandId"]));
		if (!sameValue(observed.rebuiltStages, architecture["rebuiltStages"]))
			errors.push(
				`repository: ${architecture["commandId"]} rebuilt stages differ from its bound log`,
			);
	}
	return [...new Set(errors)].sort();
}

export async function validateStageTwoEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = "evidence/stage-2-image.json",
): Promise<string[]> {
	const file = Bun.file(resolve(root, evidencePath));
	if (!(await file.exists()))
		return [`repository: ${evidencePath} is unavailable`];
	const value = (await file.json()) as unknown;
	const schema = (await Bun.file(
		resolve(root, "evidence/stage-2-image.schema.json"),
	).json()) as JsonRecord;
	const errors = validateStageTwoEvidenceValue(value, schema);
	errors.push(...(await validateBoundStageTwoLogs(root, value)));
	if (!isRecord(value)) return [...new Set(errors)].sort();
	const source = recordAt(value, "source");
	const baseSha = source["baseSha"];
	const implementationSha = source["implementationSha"];
	for (const [label, sha] of [
		["base", baseSha],
		["implementation", implementationSha],
	] as const) {
		if (
			typeof sha !== "string" ||
			gitOutput(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 2 ${label} commit is unavailable`);
	}
	if (
		typeof baseSha === "string" &&
		typeof implementationSha === "string" &&
		gitOutput(root, ["merge-base", "--is-ancestor", baseSha, implementationSha])
			.exitCode !== 0
	)
		errors.push(
			"repository: Stage 2 base is not an ancestor of implementation",
		);
	if (
		typeof implementationSha === "string" &&
		gitOutput(root, ["merge-base", "--is-ancestor", implementationSha, "HEAD"])
			.exitCode !== 0
	)
		errors.push(
			"repository: Stage 2 implementation is not an ancestor of HEAD",
		);
	if (typeof implementationSha === "string") {
		const manifest = Bun.spawnSync({
			cmd: ["git", "show", `${implementationSha}:.prototools`],
			cwd: root,
			stdout: "pipe",
			stderr: "ignore",
		});
		if (manifest.exitCode !== 0)
			errors.push("repository: Stage 2 implementation manifest is unavailable");
		else if (
			recordAt(value, "image")["protoManifestSha256"] !==
			sha256(new Uint8Array(manifest.stdout))
		)
			errors.push(
				"repository: image Proto digest differs from the implementation manifest",
			);
	}
	if (typeof baseSha === "string" && typeof implementationSha === "string") {
		const predecessorTree = gitOutput(root, ["rev-parse", `${baseSha}^{tree}`]);
		const implementationTree = gitOutput(root, [
			"rev-parse",
			`${implementationSha}^{tree}`,
		]);
		const proof = recordAt(recordAt(value, "rollback"), "proof");
		if (predecessorTree.exitCode !== 0 || implementationTree.exitCode !== 0)
			errors.push("repository: Stage 2 rollback trees could not be inspected");
		else {
			const merge = syntheticStageTwoMergeMetadata(
				baseSha,
				implementationSha,
				implementationTree.stdout,
			);
			if (
				proof["predecessorTree"] !== predecessorTree.stdout ||
				proof["revertedTree"] !== predecessorTree.stdout
			)
				errors.push(
					"repository: Stage 2 rollback tree differs from the actual predecessor",
				);
			if (proof["syntheticMergeTree"] !== merge.tree)
				errors.push(
					"repository: Stage 2 synthetic merge tree differs from implementation",
				);
			if (!sameValue(proof["syntheticMergeParents"], merge.parents))
				errors.push(
					"repository: Stage 2 synthetic merge parents differ from source boundary",
				);
			if (proof["syntheticMergeSha"] !== merge.sha)
				errors.push(
					"repository: Stage 2 synthetic merge commit metadata drifted",
				);
		}
	}
	const baselineFile = Bun.file(
		resolve(root, "evidence/stage-0-baseline.json"),
	);
	if (await baselineFile.exists()) {
		const baseline = (await baselineFile.json()) as unknown;
		const measurements = isRecord(baseline)
			? recordAt(baseline, "measurements")
			: {};
		const growth = recordAt(measurements, "secondWorktreeGrowth");
		const baselineValue = growth["value"];
		const expectedBytes = isRecord(baselineValue)
			? baselineValue["totalBytesRounded"]
			: undefined;
		if (
			recordAt(value, "secondWorktreeStorage")["stageZeroBaselineBytes"] !==
			expectedBytes
		)
			errors.push(
				"repository: Stage 2 storage baseline differs from Stage 0 evidence",
			);
	} else errors.push("repository: Stage 0 baseline is unavailable");
	return [...new Set(errors)].sort();
}

function manifestEntries(value: JsonRecord): {
	tools: Map<string, string>;
	plugins: Map<string, string>;
} {
	const tools = new Map<string, string>();
	for (const [name, entry] of Object.entries(value)) {
		if (name === "settings" || name === "plugins") continue;
		if (typeof entry === "string") tools.set(name, entry);
	}
	const plugins = new Map<string, string>();
	for (const [name, entry] of Object.entries(recordAt(value, "plugins")))
		if (typeof entry === "string") plugins.set(name, entry);
	return { tools, plugins };
}

export function validateProtoPartitionValues(
	rootValue: JsonRecord,
	foundationValue: JsonRecord,
	auxiliaryValue: JsonRecord,
): string[] {
	const errors: string[] = [];
	const root = manifestEntries(rootValue);
	const partitions = [
		["foundation", manifestEntries(foundationValue)],
		["auxiliary", manifestEntries(auxiliaryValue)],
	] as const;
	if (root.tools.size === 0)
		errors.push("partition: root manifest has no selected tools");
	for (const [name, entries] of partitions)
		if (entries.tools.size === 0)
			errors.push(`partition: ${name} manifest has no selected tools`);
	for (const [kind, rootEntries] of [
		["tool", root.tools],
		["plugin", root.plugins],
	] as const) {
		for (const [name, expected] of rootEntries) {
			const matches = partitions.flatMap(([partition, entries]) => {
				const found =
					kind === "tool" ? entries.tools.get(name) : entries.plugins.get(name);
				return found === undefined ? [] : [{ partition, value: found }];
			});
			if (matches.length === 0)
				errors.push(
					`partition: root ${kind} ${name} is missing from derived manifests`,
				);
			else if (matches.length > 1)
				errors.push(
					`partition: root ${kind} ${name} is duplicated across derived manifests`,
				);
			else if (matches[0]?.value !== expected)
				errors.push(
					`partition: root ${kind} ${name} diverges in ${matches[0]?.partition}`,
				);
		}
		for (const [partition, entries] of partitions) {
			const selected = kind === "tool" ? entries.tools : entries.plugins;
			for (const name of selected.keys())
				if (!rootEntries.has(name))
					errors.push(`partition: ${partition} contains extra ${kind} ${name}`);
		}
	}
	for (const [partition, entries] of partitions)
		for (const plugin of entries.plugins.keys())
			if (!entries.tools.has(plugin))
				errors.push(
					`partition: ${partition} plugin ${plugin} is separated from its tool`,
				);
	return [...new Set(errors)].sort();
}

export async function validateProtoPartitions(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const [rootText, foundationText, auxiliaryText] = await Promise.all([
		Bun.file(resolve(root, ".prototools")).text(),
		Bun.file(resolve(root, ".devcontainer/prototools.foundation")).text(),
		Bun.file(resolve(root, ".devcontainer/prototools.auxiliary")).text(),
	]);
	return validateProtoPartitionValues(
		Bun.TOML.parse(rootText) as JsonRecord,
		Bun.TOML.parse(foundationText) as JsonRecord,
		Bun.TOML.parse(auxiliaryText) as JsonRecord,
	);
}
