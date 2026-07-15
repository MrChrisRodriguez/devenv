// biome-ignore-all lint/complexity/useLiteralKeys: Evidence fields intentionally match the strict JSON schema.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	classifyBuildStages,
	expectedStageTwoCommands,
	isRecord,
	type JsonRecord,
	STAGE_TWO_COMMAND_IDS,
	STAGE_TWO_SYNTHETIC_DATE,
	STAGE_TWO_SYNTHETIC_EMAIL,
	STAGE_TWO_SYNTHETIC_MERGE_SUBJECT,
	STAGE_TWO_SYNTHETIC_NAME,
	type StageTwoCommandId,
	sha256,
	syntheticStageTwoMergeMetadata,
	validateBoundStageTwoLogs,
	validateProtoPartitions,
	validateStageTwoEvidenceValue,
} from "./image-evidence";

const ROOT = resolve(import.meta.dir, "../..");
const LOG_ROOT = "evidence/stage-2-image-run";
const EVIDENCE_PATH = "evidence/stage-2-image.json";
const STAGE_ZERO_BASELINE_PATH = "evidence/stage-0-baseline.json";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const STAGE_TWO_BASE_SHA = "4367bad6e2cb49e4c969a61b892634347ed0bf24";
export const STAGE_TWO_IMPLEMENTATION_SHA =
	"aade3151cc8559ff59860d0b427f74361b8dffcb";

type Command = string[];

interface Execution {
	command: Command;
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CapturedCommand {
	id: StageTwoCommandId;
	command: Command;
	runId: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	stdoutPath: string;
	stderrPath: string;
	stdoutSha256: string;
	stderrSha256: string;
	exitCode: 0;
	status: "pass";
}

interface StaleProbe {
	commandId: "stale-image-refusal";
	mutation: "shadow-workspace-shell-env-tools-overrides-and-edit-definition";
	originalDefinitionFingerprint: string;
	mutatedDefinitionFingerprint: string;
	shadowBunPath: "/workspace/node_modules/.bin/bun";
	shadowBashPath: "/workspace/node_modules/.bin/bash";
	shadowUtilityPaths: string[];
	trustedRepoMount: "/trusted";
	overrideMarkerPath: "/workspace/contract-marker-override";
	environmentOverrides: {
		DEVCONTAINER_REPO_ROOT: "/trusted";
		DEVCONTAINER_IMAGE_CONTRACT_DIR: "/workspace/contract-marker-override";
		BASH_ENV: "/workspace/preverify-bash-env.sh";
		"BASH_FUNC_source%%": "() { /bin/echo PREVERIFY_EXPORTED_SOURCE_EXECUTED >&2; }";
	};
	preVerificationShadowExecution: false;
	preVerificationBashEnvExecution: false;
	preVerificationExportedFunctionExecution: false;
	containerExitCode: number;
	refused: true;
	diagnostic: string;
}

interface PartitionProbe {
	commandId: "partition-mutation";
	mutation: "drop-foundation-uv";
	rejected: true;
	diagnostic: string;
}

interface StorageProbe {
	commandId: "second-worktree-storage";
	primaryContainerId: string;
	secondContainerId: string;
	primaryImageId: string;
	secondImageId: string;
	primaryContainerWritableBytes: number;
	secondContainerWritableBytes: number;
	secondCheckoutBytes: number;
	volumeBytes: number;
	observedBytes: number;
	stageZeroBaselineBytes: number;
	imageProtoBytes: number;
	protoVolumeCount: 0;
	protoMountCount: 0;
	operations: Command[];
}

interface RollbackProbe {
	commandId: "rollback-proof";
	predecessorSha: string;
	implementationSha: string;
	syntheticMergeSha: string;
	syntheticMergeTree: string;
	syntheticMergeParents: string[];
	predecessorTree: string;
	revertedTree: string;
	treeMatchesPredecessor: true;
	operations: Command[];
}

interface ShellProbe {
	bunPath: string;
	protoPath: string;
	path: string;
}

function usage(): string {
	return [
		"usage:",
		"  bun scripts/template/collect-stage-two-evidence.ts capture --base <sha> --implementation <sha> --alternate-codex-version <version>",
		"  bun scripts/template/collect-stage-two-evidence.ts probe-stale --image <tag> --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-two-evidence.ts probe-partition --root <path> --mutation drop-foundation-uv",
		"  bun scripts/template/collect-stage-two-evidence.ts probe-storage --image <tag> --run-id <id> --implementation <sha> --workspace </tmp/path>",
		"  bun scripts/template/collect-stage-two-evidence.ts probe-rollback --base <sha> --implementation <sha> --workspace </tmp/path>",
	].join("\n");
}

function options(arguments_: string[]): Map<string, string> {
	const parsed = new Map<string, string>();
	for (let index = 0; index < arguments_.length; index += 2) {
		const key = arguments_[index];
		const value = arguments_[index + 1];
		if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
			throw new Error(usage());
		if (parsed.has(key)) throw new Error(`Duplicate option ${key}`);
		parsed.set(key, value);
	}
	return parsed;
}

function required(parsed: Map<string, string>, key: string): string {
	const value = parsed.get(key);
	if (!value) throw new Error(`Missing ${key}\n${usage()}`);
	return value;
}

function assertOnlyOptions(
	parsed: Map<string, string>,
	allowed: string[],
): void {
	for (const key of parsed.keys())
		if (!allowed.includes(key))
			throw new Error(`Unknown option ${key}\n${usage()}`);
}

function execute(
	command: Command,
	cwd: string,
	environment?: Record<string, string>,
): Execution {
	const base = {
		cmd: command,
		cwd,
		stdout: "pipe" as const,
		stderr: "pipe" as const,
	};
	const result = environment
		? Bun.spawnSync({ ...base, env: { ...process.env, ...environment } })
		: Bun.spawnSync(base);
	return {
		command,
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function checked(
	command: Command,
	cwd: string,
	environment?: Record<string, string>,
): Execution {
	const result = execute(command, cwd, environment);
	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${result.exitCode}): ${JSON.stringify(command)}\n${result.stderr || result.stdout}`,
		);
	}
	return result;
}

function fullGitSha(root: string, revision: string): string {
	const sha = checked(
		["git", "rev-parse", "--verify", `${revision}^{commit}`],
		root,
	).stdout.trim();
	if (!GIT_SHA.test(sha)) throw new Error(`Invalid Git commit ${revision}`);
	return sha;
}

function temporaryWorkspace(path: string): string {
	const absolute = resolve(path);
	const allowedRoots = [resolve(tmpdir()), resolve("/tmp")];
	const safe = allowedRoots.some((temporaryRoot) => {
		const candidate = relative(temporaryRoot, absolute);
		if (!candidate || isAbsolute(candidate) || candidate === "..") return false;
		if (candidate.startsWith(`..${sep}`)) return false;
		return candidate.split(sep)[0]?.startsWith("devenv-stage2-") === true;
	});
	if (!safe)
		throw new Error(`Refusing non-Stage-2 temporary workspace: ${absolute}`);
	return absolute;
}

async function removeWorktree(root: string, workspace: string): Promise<void> {
	execute(["git", "worktree", "remove", "--force", workspace], root);
	await rm(workspace, { recursive: true, force: true });
}

async function addWorktree(
	root: string,
	workspace: string,
	revision: string,
	operations?: Command[],
): Promise<void> {
	await removeWorktree(root, workspace);
	await mkdir(dirname(workspace), { recursive: true });
	const command = ["git", "worktree", "add", "--detach", workspace, revision];
	checked(command, root);
	operations?.push(command);
}

function parseInteger(value: string, label: string): number {
	if (!/^\d+$/.test(value.trim()))
		throw new Error(`${label} is not an integer: ${value}`);
	const parsed = Number(value.trim());
	if (!Number.isSafeInteger(parsed))
		throw new Error(`${label} exceeds integer range`);
	return parsed;
}

function jsonObject<T>(text: string, label: string): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} did not emit JSON: ${String(error)}`);
	}
	if (!isRecord(value)) throw new Error(`${label} did not emit a JSON object`);
	return value as T;
}

export async function probeStale(options_: {
	image: string;
	workspace: string;
	root?: string;
}): Promise<StaleProbe> {
	const root = resolve(options_.root ?? process.cwd());
	const workspace = temporaryWorkspace(options_.workspace);
	await addWorktree(root, workspace, "HEAD");
	try {
		const fingerprintScript = resolve(
			workspace,
			".devcontainer/devcontainer-fingerprint.sh",
		);
		const fingerprint = (): string =>
			checked(["bash", fingerprintScript, workspace], root, {
				DEVCONTAINER_FINGERPRINT_BUN: process.execPath,
			}).stdout.trim();
		const originalDefinitionFingerprint = fingerprint();
		const definitionPath = resolve(
			workspace,
			".devcontainer/devcontainer.json",
		);
		await Bun.write(
			definitionPath,
			`${await Bun.file(definitionPath).text()}\n`,
		);
		const mutatedDefinitionFingerprint = fingerprint();
		if (originalDefinitionFingerprint === mutatedDefinitionFingerprint)
			throw new Error("Definition mutation did not change the fingerprint");
		const overrideMarkerDirectory = resolve(
			workspace,
			"contract-marker-override",
		);
		await mkdir(overrideMarkerDirectory, { recursive: true });
		await Bun.write(
			resolve(overrideMarkerDirectory, "prototools.sha256"),
			`${sha256(new Uint8Array(await Bun.file(resolve(workspace, ".prototools")).arrayBuffer()))}\n`,
		);
		await Bun.write(
			resolve(overrideMarkerDirectory, "definition.sha256"),
			`${originalDefinitionFingerprint}\n`,
		);
		await Bun.write(
			resolve(workspace, "preverify-bash-env.sh"),
			"/bin/echo PREVERIFY_BASH_ENV_EXECUTED >&2\n",
		);
		const shadowTools = ["bun", "bash", "readlink", "sha256sum", "awk", "tr"];
		const shadowUtilityPaths = shadowTools
			.filter((tool) => !["bun", "bash"].includes(tool))
			.map((tool) => `/workspace/node_modules/.bin/${tool}`);
		for (const tool of shadowTools) {
			const shadowTool = resolve(workspace, `node_modules/.bin/${tool}`);
			await mkdir(dirname(shadowTool), { recursive: true });
			await Bun.write(
				shadowTool,
				"#!/bin/sh\nprintf 'PREVERIFY_TOOL_EXECUTED:%s\\n' \"$0\" >&2\n/usr/bin/cat /usr/local/share/devenv-image/definition.sha256\n",
			);
			await chmod(shadowTool, 0o755);
		}
		const command = [
			"docker",
			"run",
			"--rm",
			"--mount",
			`type=bind,src=${workspace},dst=/workspace,readonly`,
			"--mount",
			`type=bind,src=${root},dst=/trusted,readonly`,
			"--env",
			"DEVCONTAINER_REPO_ROOT=/trusted",
			"--env",
			"DEVCONTAINER_IMAGE_CONTRACT_DIR=/workspace/contract-marker-override",
			"--env",
			"BASH_ENV=/workspace/preverify-bash-env.sh",
			"--env",
			"BASH_FUNC_source%%=() { /bin/echo PREVERIFY_EXPORTED_SOURCE_EXECUTED >&2; }",
			"--workdir",
			"/workspace",
			options_.image,
			"/usr/bin/env",
			"-u",
			"BASH_ENV",
			"-u",
			"ENV",
			"/bin/bash",
			"-p",
			"/workspace/.devcontainer/on-create.sh",
		];
		const result = execute(command, root);
		const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
		if (result.exitCode === 0)
			throw new Error(
				"Stale definition with shadowed tools and poisoned verifier overrides was accepted by the image",
			);
		if (
			!diagnostic.includes("definition differs") ||
			!diagnostic.includes("Rebuild/recreate")
		)
			throw new Error(`Stale refusal diagnostic drifted:\n${diagnostic}`);
		if (diagnostic.includes("PREVERIFY_TOOL_EXECUTED"))
			throw new Error(
				`Workspace PATH tool executed before stale-image refusal:\n${diagnostic}`,
			);
		if (diagnostic.includes("PREVERIFY_BASH_ENV_EXECUTED"))
			throw new Error(
				`BASH_ENV executed before stale-image refusal:\n${diagnostic}`,
			);
		if (diagnostic.includes("PREVERIFY_EXPORTED_SOURCE_EXECUTED"))
			throw new Error(
				`Exported shell function executed before stale-image refusal:\n${diagnostic}`,
			);
		return {
			commandId: "stale-image-refusal",
			mutation:
				"shadow-workspace-shell-env-tools-overrides-and-edit-definition",
			originalDefinitionFingerprint,
			mutatedDefinitionFingerprint,
			shadowBunPath: "/workspace/node_modules/.bin/bun",
			shadowBashPath: "/workspace/node_modules/.bin/bash",
			shadowUtilityPaths,
			trustedRepoMount: "/trusted",
			overrideMarkerPath: "/workspace/contract-marker-override",
			environmentOverrides: {
				DEVCONTAINER_REPO_ROOT: "/trusted",
				DEVCONTAINER_IMAGE_CONTRACT_DIR: "/workspace/contract-marker-override",
				BASH_ENV: "/workspace/preverify-bash-env.sh",
				"BASH_FUNC_source%%":
					"() { /bin/echo PREVERIFY_EXPORTED_SOURCE_EXECUTED >&2; }",
			},
			preVerificationShadowExecution: false,
			preVerificationBashEnvExecution: false,
			preVerificationExportedFunctionExecution: false,
			containerExitCode: result.exitCode,
			refused: true,
			diagnostic,
		};
	} finally {
		await removeWorktree(root, workspace);
	}
}

export async function probePartition(options_: {
	root: string;
	mutation: string;
}): Promise<PartitionProbe> {
	if (options_.mutation !== "drop-foundation-uv")
		throw new Error(`Unsupported partition mutation ${options_.mutation}`);
	const sourceRoot = resolve(options_.root);
	const baseline = await validateProtoPartitions(sourceRoot);
	if (baseline.length > 0)
		throw new Error(
			`Cannot mutate an invalid Proto partition:\n${baseline.join("\n")}`,
		);
	const temporary = await mkdtemp(
		resolve(tmpdir(), "devenv-stage2-partition-"),
	);
	try {
		await mkdir(resolve(temporary, ".devcontainer"), { recursive: true });
		for (const path of [
			".prototools",
			".devcontainer/prototools.foundation",
			".devcontainer/prototools.auxiliary",
		]) {
			await Bun.write(
				resolve(temporary, path),
				await Bun.file(resolve(sourceRoot, path)).arrayBuffer(),
			);
		}
		const foundationPath = resolve(
			temporary,
			".devcontainer/prototools.foundation",
		);
		const foundation = await Bun.file(foundationPath).text();
		const mutated = foundation.replace(/^uv\s*=\s*"[^"]+"\s*\n/m, "");
		if (mutated === foundation)
			throw new Error("Foundation mutation did not remove the uv tool");
		await Bun.write(foundationPath, mutated);
		const errors = await validateProtoPartitions(temporary);
		const diagnostic =
			errors.find((error) => error.includes("root tool uv is missing")) ?? "";
		if (!diagnostic)
			throw new Error(
				`Partition mutation was not rejected correctly:\n${errors.join("\n")}`,
			);
		return {
			commandId: "partition-mutation",
			mutation: "drop-foundation-uv",
			rejected: true,
			diagnostic,
		};
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

function stageZeroStorageBaseline(root: string): Promise<number> {
	return Bun.file(resolve(root, STAGE_ZERO_BASELINE_PATH))
		.json()
		.then((value: unknown) => {
			if (!isRecord(value))
				throw new Error("Stage 0 evidence is not an object");
			const measurements = value["measurements"];
			const growth = isRecord(measurements)
				? measurements["secondWorktreeGrowth"]
				: undefined;
			const result = isRecord(growth) ? growth["value"] : undefined;
			const bytes = isRecord(result) ? result["totalBytesRounded"] : undefined;
			if (
				typeof bytes !== "number" ||
				!Number.isSafeInteger(bytes) ||
				bytes < 1
			)
				throw new Error("Stage 0 second-worktree byte baseline is unavailable");
			return bytes;
		});
}

interface DockerMount {
	Type?: unknown;
	Name?: unknown;
	Destination?: unknown;
}

interface DockerContainerInspect {
	Id?: unknown;
	Image?: unknown;
	SizeRw?: unknown;
	Mounts?: unknown;
}

function inspectedContainer(text: string): DockerContainerInspect {
	const parsed = JSON.parse(text) as unknown;
	if (!Array.isArray(parsed) || !isRecord(parsed[0]))
		throw new Error("docker inspect did not return one container record");
	return parsed[0] as DockerContainerInspect;
}

export async function probeStorage(options_: {
	image: string;
	runId: string;
	implementation: string;
	workspace: string;
	root?: string;
}): Promise<StorageProbe> {
	const root = resolve(options_.root ?? process.cwd());
	const workspace = temporaryWorkspace(options_.workspace);
	const implementation = fullGitSha(root, options_.implementation);
	const operations: Command[] = [];
	let primaryContainerId = "";
	let secondContainerId = "";
	let evidence: Omit<StorageProbe, "operations"> | undefined;
	await addWorktree(root, workspace, implementation, operations);
	try {
		const imageInspect = [
			"docker",
			"image",
			"inspect",
			"--format",
			"{{.Id}}",
			options_.image,
		];
		const imageId = checked(imageInspect, root).stdout.trim();
		operations.push(imageInspect);
		if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
			throw new Error(`Image identity is malformed: ${imageId}`);

		const protoSizeCommand = [
			"docker",
			"run",
			"--rm",
			"--label",
			`com.devenv.evidence.run=${options_.runId}`,
			options_.image,
			"sh",
			"-c",
			"du -sk /home/vscode/.proto | cut -f1",
		];
		const imageProtoBytes =
			parseInteger(checked(protoSizeCommand, root).stdout, "image Proto KiB") *
			1024;
		operations.push(protoSizeCommand);

		const create = (slot: "primary" | "second", source: string): string => {
			const command = [
				"docker",
				"create",
				"--label",
				`com.devenv.evidence.run=${options_.runId}`,
				"--label",
				`com.devenv.evidence.slot=${slot}`,
				"--mount",
				`type=bind,src=${source},dst=/workspace,readonly`,
				options_.image,
				"sleep",
				"infinity",
			];
			const id = checked(command, root).stdout.trim();
			operations.push(command);
			if (!/^[0-9a-f]{64}$/.test(id))
				throw new Error(`Docker returned a malformed ${slot} container ID`);
			return id;
		};
		primaryContainerId = create("primary", root);
		secondContainerId = create("second", workspace);
		for (const id of [primaryContainerId, secondContainerId]) {
			const command = ["docker", "start", id];
			checked(command, root);
			operations.push(command);
		}

		const inspect = (id: string): DockerContainerInspect => {
			const command = ["docker", "inspect", "--size", id];
			const value = inspectedContainer(checked(command, root).stdout);
			operations.push(command);
			return value;
		};
		const primary = inspect(primaryContainerId);
		const second = inspect(secondContainerId);
		const mounts = [primary, second].flatMap((container) =>
			Array.isArray(container.Mounts)
				? (container.Mounts.filter(isRecord) as DockerMount[])
				: [],
		);
		const protoMounts = mounts.filter(
			(mount) => mount.Destination === "/home/vscode/.proto",
		);
		const protoVolumes = protoMounts.filter((mount) => mount.Type === "volume");
		const allVolumes = mounts.filter((mount) => mount.Type === "volume");
		if (allVolumes.length > 0)
			throw new Error(
				`Storage probe created unexpected volumes: ${allVolumes.map((mount) => String(mount.Name ?? "unnamed")).join(", ")}`,
			);

		const checkoutCommand = ["du", "-sk", workspace];
		const secondCheckoutBytes =
			parseInteger(
				checked(checkoutCommand, root).stdout.split(/\s+/)[0] ?? "",
				"second checkout KiB",
			) * 1024;
		operations.push(checkoutCommand);
		const primaryWritable = Number(primary.SizeRw);
		const secondWritable = Number(second.SizeRw);
		if (!Number.isSafeInteger(primaryWritable) || primaryWritable < 0)
			throw new Error("Primary container writable size is unavailable");
		if (!Number.isSafeInteger(secondWritable) || secondWritable < 0)
			throw new Error("Second container writable size is unavailable");
		if (primary.Image !== imageId || second.Image !== imageId)
			throw new Error("Storage containers do not share the measured image");
		if (protoVolumes.length !== 0 || protoMounts.length !== 0)
			throw new Error("Storage probe observed mutable Proto mounts");

		const volumeBytes = 0;
		const stageZeroBaselineBytes = await stageZeroStorageBaseline(root);
		const observedBytes = secondWritable + secondCheckoutBytes + volumeBytes;
		if (observedBytes > stageZeroBaselineBytes)
			throw new Error(
				`Second-worktree storage ${observedBytes} exceeds Stage 0 ${stageZeroBaselineBytes}`,
			);
		if (secondWritable >= imageProtoBytes)
			throw new Error(
				"Second container appears to copy image-owned Proto storage",
			);

		evidence = {
			commandId: "second-worktree-storage",
			primaryContainerId,
			secondContainerId,
			primaryImageId: String(primary.Image),
			secondImageId: String(second.Image),
			primaryContainerWritableBytes: primaryWritable,
			secondContainerWritableBytes: secondWritable,
			secondCheckoutBytes,
			volumeBytes,
			observedBytes,
			stageZeroBaselineBytes,
			imageProtoBytes,
			protoVolumeCount: 0,
			protoMountCount: 0,
		};
	} finally {
		const containers = [primaryContainerId, secondContainerId].filter(Boolean);
		if (containers.length > 0) {
			const cleanup = ["docker", "rm", "-f", ...containers];
			execute(cleanup, root);
			operations.push(cleanup);
		}
		await removeWorktree(root, workspace);
		operations.push(["git", "worktree", "remove", "--force", workspace]);
	}
	if (!evidence)
		throw new Error("Storage probe completed without measurements");
	return { ...evidence, operations };
}

export async function probeRollback(options_: {
	base: string;
	implementation: string;
	workspace: string;
	root?: string;
}): Promise<RollbackProbe> {
	const root = resolve(options_.root ?? process.cwd());
	const workspace = temporaryWorkspace(options_.workspace);
	const predecessorSha = fullGitSha(root, options_.base);
	const implementationSha = fullGitSha(root, options_.implementation);
	if (
		execute(
			["git", "merge-base", "--is-ancestor", predecessorSha, implementationSha],
			root,
		).exitCode !== 0
	)
		throw new Error(
			"Rollback predecessor is not an ancestor of implementation",
		);
	const operations: Command[] = [];
	const predecessorTree = checked(
		["git", "rev-parse", `${predecessorSha}^{tree}`],
		root,
	).stdout.trim();
	const implementationTree = checked(
		["git", "rev-parse", `${implementationSha}^{tree}`],
		root,
	).stdout.trim();
	operations.push(
		["git", "rev-parse", `${predecessorSha}^{tree}`],
		["git", "rev-parse", `${implementationSha}^{tree}`],
	);
	await addWorktree(root, workspace, predecessorSha, operations);
	try {
		const identity = {
			GIT_AUTHOR_NAME: STAGE_TWO_SYNTHETIC_NAME,
			GIT_AUTHOR_EMAIL: STAGE_TWO_SYNTHETIC_EMAIL,
			GIT_AUTHOR_DATE: STAGE_TWO_SYNTHETIC_DATE,
			GIT_COMMITTER_NAME: STAGE_TWO_SYNTHETIC_NAME,
			GIT_COMMITTER_EMAIL: STAGE_TWO_SYNTHETIC_EMAIL,
			GIT_COMMITTER_DATE: STAGE_TWO_SYNTHETIC_DATE,
		};
		const mergeCommand = [
			"git",
			"commit-tree",
			implementationTree,
			"-p",
			predecessorSha,
			"-p",
			implementationSha,
			"-m",
			STAGE_TWO_SYNTHETIC_MERGE_SUBJECT,
		];
		const syntheticMergeSha = checked(
			mergeCommand,
			root,
			identity,
		).stdout.trim();
		operations.push(mergeCommand);
		if (!GIT_SHA.test(syntheticMergeSha))
			throw new Error("Synthetic merge did not produce a commit SHA");
		const expectedMerge = syntheticStageTwoMergeMetadata(
			predecessorSha,
			implementationSha,
			implementationTree,
		);
		if (syntheticMergeSha !== expectedMerge.sha)
			throw new Error("Synthetic merge metadata is not deterministic");
		const syntheticMergeTree = checked(
			["git", "rev-parse", `${syntheticMergeSha}^{tree}`],
			root,
		).stdout.trim();
		const syntheticMergeParents = checked(
			["git", "show", "-s", "--format=%P", syntheticMergeSha],
			root,
		)
			.stdout.trim()
			.split(/\s+/);
		operations.push(
			["git", "rev-parse", `${syntheticMergeSha}^{tree}`],
			["git", "show", "-s", "--format=%P", syntheticMergeSha],
		);
		if (
			syntheticMergeParents[0] !== predecessorSha ||
			syntheticMergeParents[1] !== implementationSha
		)
			throw new Error("Synthetic merge parent order drifted");

		const checkoutCommand = ["git", "checkout", "--detach", syntheticMergeSha];
		checked(checkoutCommand, workspace);
		operations.push(checkoutCommand);
		const revertCommand = [
			"git",
			"revert",
			"--no-edit",
			"-m",
			"1",
			syntheticMergeSha,
		];
		checked(revertCommand, workspace, identity);
		operations.push(revertCommand);
		const revertedTreeCommand = ["git", "rev-parse", "HEAD^{tree}"];
		const revertedTree = checked(revertedTreeCommand, workspace).stdout.trim();
		operations.push(revertedTreeCommand);
		if (revertedTree !== predecessorTree)
			throw new Error(
				`Rollback tree ${revertedTree} differs from predecessor ${predecessorTree}`,
			);
		return {
			commandId: "rollback-proof",
			predecessorSha,
			implementationSha,
			syntheticMergeSha,
			syntheticMergeTree,
			syntheticMergeParents,
			predecessorTree,
			revertedTree,
			treeMatchesPredecessor: true,
			operations,
		};
	} finally {
		await removeWorktree(root, workspace);
	}
}

export function parseShellProbe(output: string): ShellProbe {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const bunPath = lines.find(
		(line) => line.startsWith("/") && line.endsWith("/bun"),
	);
	const protoPath = lines.find(
		(line) => line.startsWith("/") && line.endsWith("/proto"),
	);
	const path = lines.find(
		(line) =>
			line.includes(":") && line.includes("/workspace/node_modules/.bin"),
	);
	if (!bunPath || !protoPath || !path)
		throw new Error(`Shell probe output is incomplete:\n${output}`);
	return { bunPath, protoPath, path };
}

export function collectionCommands(
	seed: JsonRecord,
): Record<StageTwoCommandId, string[]> {
	return expectedStageTwoCommands(seed);
}

async function captureCommand(
	root: string,
	runId: string,
	id: StageTwoCommandId,
	command: Command,
): Promise<CapturedCommand> {
	const stdoutPath = `${LOG_ROOT}/${id}.stdout`;
	const stderrPath = `${LOG_ROOT}/${id}.stderr`;
	const stdoutFile = Bun.file(resolve(root, stdoutPath));
	const stderrFile = Bun.file(resolve(root, stderrPath));
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const process_ = Bun.spawn({
		cmd: command,
		cwd: root,
		stdout: stdoutFile,
		stderr: stderrFile,
	});
	const exitCode = await process_.exited;
	const durationMs = Math.max(1, Math.round(performance.now() - started));
	const completedAt = new Date().toISOString();
	const stdoutBytes = new Uint8Array(await stdoutFile.arrayBuffer());
	const stderrBytes = new Uint8Array(await stderrFile.arrayBuffer());
	if (exitCode !== 0)
		throw new Error(
			`${id} failed with exit ${exitCode}; inspect ${stdoutPath} and ${stderrPath}`,
		);
	return {
		id,
		command,
		runId,
		startedAt,
		completedAt,
		durationMs,
		stdoutPath,
		stderrPath,
		stdoutSha256: sha256(stdoutBytes),
		stderrSha256: sha256(stderrBytes),
		exitCode: 0,
		status: "pass",
	};
}

function activeStatusPaths(root: string): string[] {
	const output = checked(
		["git", "status", "--porcelain=v1", "--untracked-files=all"],
		root,
	).stdout;
	return output
		.split("\n")
		.filter(Boolean)
		.filter((line) => {
			const path = line.slice(3);
			return (
				!path.startsWith("graphify-out/") && !path.startsWith(`${LOG_ROOT}/`)
			);
		});
}

function runId(): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "z")
		.replace("T", "t");
	const suffix = sha256(
		`${timestamp}:${process.pid}:${crypto.randomUUID()}`,
	).slice(0, 8);
	return `stage2-${timestamp}-${suffix}`;
}

function nativeArchitecture(): "amd64" | "arm64" {
	if (process.arch === "x64") return "amd64";
	if (process.arch === "arm64") return "arm64";
	throw new Error(`Unsupported native architecture ${process.arch}`);
}

function commandResult(
	commands: CapturedCommand[],
	id: StageTwoCommandId,
): CapturedCommand {
	const found = commands.find((entry) => entry.id === id);
	if (!found) throw new Error(`Missing captured command ${id}`);
	return found;
}

async function commandOutput(
	root: string,
	id: StageTwoCommandId,
): Promise<string> {
	const [stdout, stderr] = await Promise.all([
		Bun.file(resolve(root, LOG_ROOT, `${id}.stdout`)).text(),
		Bun.file(resolve(root, LOG_ROOT, `${id}.stderr`)).text(),
	]);
	return `${stdout}\n${stderr}`;
}

function marker(output: string, name: "definition" | "manifest"): string {
	const match = new RegExp(`(?:^|\\n)${name}=([0-9a-f]{64})(?:\\n|$)`).exec(
		output,
	);
	if (!match?.[1]) throw new Error(`Image contract omitted ${name} marker`);
	return match[1];
}

async function collect(parsed: Map<string, string>): Promise<void> {
	assertOnlyOptions(parsed, [
		"--base",
		"--implementation",
		"--alternate-codex-version",
	]);
	const root = ROOT;
	const baseSha = fullGitSha(root, required(parsed, "--base"));
	const implementationSha = fullGitSha(
		root,
		required(parsed, "--implementation"),
	);
	if (baseSha === implementationSha)
		throw new Error("Stage 2 base and implementation must differ");
	if (baseSha !== STAGE_TWO_BASE_SHA)
		throw new Error(`Stage 2 evidence base must be ${STAGE_TWO_BASE_SHA}`);
	if (implementationSha !== STAGE_TWO_IMPLEMENTATION_SHA)
		throw new Error(
			`Stage 2 evidence implementation must be ${STAGE_TWO_IMPLEMENTATION_SHA}`,
		);
	const alternateCodexVersion = required(parsed, "--alternate-codex-version");
	if (!EXACT_VERSION.test(alternateCodexVersion))
		throw new Error("Alternate Codex version must be exact");
	const head = fullGitSha(root, "HEAD");
	checked(
		["git", "merge-base", "--is-ancestor", baseSha, implementationSha],
		root,
	);
	checked(
		["git", "merge-base", "--is-ancestor", implementationSha, head],
		root,
	);
	const runtimeDrift = execute(
		[
			"git",
			"diff",
			"--quiet",
			implementationSha,
			head,
			"--",
			".dockerignore",
			".prototools",
			".devcontainer",
		],
		root,
	);
	if (runtimeDrift.exitCode !== 0)
		throw new Error(
			"Runtime image inputs changed after the declared Stage 2 implementation boundary",
		);
	const dirty = activeStatusPaths(root);
	if (dirty.length > 0)
		throw new Error(
			`Evidence capture requires a clean feature tree:\n${dirty.join("\n")}`,
		);

	const id = runId();
	const temporaryRoot = `/tmp/devenv-stage2-${id}`;
	const imageTag = `devenv-stage2-${id}`;
	const architecture = nativeArchitecture();
	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const codexVersion = /^ARG CODEX_VERSION=(\S+)$/m.exec(dockerfile)?.[1] ?? "";
	if (!EXACT_VERSION.test(codexVersion))
		throw new Error("Dockerfile Codex version is not exact");
	if (codexVersion === alternateCodexVersion)
		throw new Error("Alternate Codex version must differ from the image pin");

	for (const name of [
		"stale-workspace",
		"second-worktree",
		"rollback-worktree",
	])
		await removeWorktree(root, resolve(temporaryRoot, name));
	await rm(temporaryRoot, { recursive: true, force: true });
	await rm(resolve(root, LOG_ROOT), { recursive: true, force: true });
	await mkdir(resolve(root, LOG_ROOT), { recursive: true });

	const seed: JsonRecord = {
		run: {
			id,
			temporaryRoot,
			nativeArchitecture: architecture,
			logRoot: LOG_ROOT,
		},
		source: { baseSha, implementationSha, featureTreeClean: true },
		image: { tag: imageTag, alternateCodexVersion },
	};
	const expected = collectionCommands(seed);
	const commands: CapturedCommand[] = [];
	for (const commandId of STAGE_TWO_COMMAND_IDS) {
		console.error(`[stage2-evidence] running ${commandId}`);
		commands.push(
			await captureCommand(root, id, commandId, expected[commandId]),
		);
	}

	const definitionFingerprint = (
		await commandOutput(root, "definition-fingerprint")
	).trim();
	if (!SHA256.test(definitionFingerprint))
		throw new Error("Definition fingerprint command did not emit one SHA-256");
	const imageId = (await commandOutput(root, "image-inspect")).trim();
	if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
		throw new Error("Image inspect did not emit one image identity");
	const contractOutput = await commandOutput(root, "image-contract");
	const definitionMarker = marker(contractOutput, "definition");
	const protoManifestMarker = marker(contractOutput, "manifest");
	const protoManifestSha256 = sha256(
		new Uint8Array(await Bun.file(resolve(root, ".prototools")).arrayBuffer()),
	);
	const clean = commandResult(commands, "clean-build");
	const warm = commandResult(commands, "warm-build");
	const warmOutput = await commandOutput(root, "warm-build");
	const invalidation = classifyBuildStages(
		await commandOutput(root, "layer-invalidation"),
	);
	const architectureStages = {
		amd64: classifyBuildStages(await commandOutput(root, "architecture-amd64")),
		arm64: classifyBuildStages(await commandOutput(root, "architecture-arm64")),
	};
	const staleImageRefusal = jsonObject<StaleProbe>(
		await commandOutput(root, "stale-image-refusal"),
		"stale-image-refusal",
	);
	const partitionMutation = jsonObject<PartitionProbe>(
		await commandOutput(root, "partition-mutation"),
		"partition-mutation",
	);
	const secondWorktreeStorage = jsonObject<StorageProbe>(
		await commandOutput(root, "second-worktree-storage"),
		"second-worktree-storage",
	);
	const rollbackProof = jsonObject<RollbackProbe>(
		await commandOutput(root, "rollback-proof"),
		"rollback-proof",
	);
	const shellCases = [
		["bash", "login", "shell-bash-login"],
		["bash", "non-login", "shell-bash-non-login"],
		["zsh", "login", "shell-zsh-login"],
		["zsh", "non-login", "shell-zsh-non-login"],
	] as const;
	const shellPaths = [];
	for (const [shell, mode, commandId_] of shellCases) {
		const parsedShell = parseShellProbe(await commandOutput(root, commandId_));
		shellPaths.push({ shell, mode, commandId: commandId_, ...parsedShell });
	}

	const evidence: JsonRecord = {
		schemaVersion: 1,
		stage: "stage-2-image-architecture",
		capturedAt: new Date().toISOString(),
		run: seed["run"],
		source: seed["source"],
		image: {
			tag: imageTag,
			imageId,
			definitionFingerprint,
			definitionMarker,
			protoManifestSha256,
			protoManifestMarker,
			codexVersion,
			alternateCodexVersion,
		},
		commands,
		builds: {
			clean: {
				commandId: "clean-build",
				durationMs: clean.durationMs,
				cachedSteps:
					(await commandOutput(root, "clean-build")).match(/\bCACHED\b/g)
						?.length ?? 0,
				noCache: true,
			},
			warm: {
				commandId: "warm-build",
				durationMs: warm.durationMs,
				cachedSteps: warmOutput.match(/\bCACHED\b/g)?.length ?? 0,
				noCache: false,
			},
		},
		layerInvalidation: {
			commandId: "layer-invalidation",
			changedOwner: "CODEX_VERSION",
			...invalidation,
		},
		architectures: [
			{
				architecture: "amd64",
				commandId: "architecture-amd64",
				status: "pass",
				rebuiltStages: architectureStages.amd64.rebuiltStages,
			},
			{
				architecture: "arm64",
				commandId: "architecture-arm64",
				status: "pass",
				rebuiltStages: architectureStages.arm64.rebuiltStages,
			},
		],
		staleImageRefusal,
		partitionMutation,
		shellPaths,
		secondWorktreeStorage,
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-2-pr-merge-commit>"],
			runtimeCleanup: [
				[
					"docker",
					"ps",
					"-aq",
					"--filter",
					`label=com.devenv.evidence.run=${id}`,
				],
				["docker", "rm", "-f", "<run-labeled-container-ids>"],
				[
					"docker",
					"volume",
					"ls",
					"-q",
					"--filter",
					`label=com.devenv.evidence.run=${id}`,
				],
				["docker", "volume", "rm", "<run-labeled-volume-names>"],
				["docker", "image", "rm", imageTag],
				[
					"git",
					"worktree",
					"remove",
					"--force",
					"<stage-2-temporary-worktrees>",
				],
			],
			scope:
				"Revert the atomic Stage 2 merge and remove only resources selected by the captured run label and image tag.",
			proof: rollbackProof,
		},
	};
	const schema = (await Bun.file(
		resolve(root, "evidence/stage-2-image.schema.json"),
	).json()) as JsonRecord;
	const errors = validateStageTwoEvidenceValue(evidence, schema);
	errors.push(...(await validateBoundStageTwoLogs(root, evidence)));
	if (errors.length > 0)
		throw new Error(
			`Captured Stage 2 evidence is invalid:\n${errors.join("\n")}`,
		);
	await Bun.write(
		resolve(root, EVIDENCE_PATH),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(`Captured ${commands.length} Stage 2 commands for ${id}`);
	console.log(EVIDENCE_PATH);
}

async function main(): Promise<void> {
	const [subcommand, ...arguments_] = Bun.argv.slice(2);
	const parsed = options(arguments_);
	switch (subcommand) {
		case "capture":
			await collect(parsed);
			break;
		case "probe-stale":
			assertOnlyOptions(parsed, ["--image", "--workspace"]);
			console.log(
				JSON.stringify(
					await probeStale({
						image: required(parsed, "--image"),
						workspace: required(parsed, "--workspace"),
					}),
					null,
					2,
				),
			);
			break;
		case "probe-partition":
			assertOnlyOptions(parsed, ["--root", "--mutation"]);
			console.log(
				JSON.stringify(
					await probePartition({
						root: required(parsed, "--root"),
						mutation: required(parsed, "--mutation"),
					}),
					null,
					2,
				),
			);
			break;
		case "probe-storage":
			assertOnlyOptions(parsed, [
				"--image",
				"--run-id",
				"--implementation",
				"--workspace",
			]);
			console.log(
				JSON.stringify(
					await probeStorage({
						image: required(parsed, "--image"),
						runId: required(parsed, "--run-id"),
						implementation: required(parsed, "--implementation"),
						workspace: required(parsed, "--workspace"),
					}),
					null,
					2,
				),
			);
			break;
		case "probe-rollback":
			assertOnlyOptions(parsed, ["--base", "--implementation", "--workspace"]);
			console.log(
				JSON.stringify(
					await probeRollback({
						base: required(parsed, "--base"),
						implementation: required(parsed, "--implementation"),
						workspace: required(parsed, "--workspace"),
					}),
					null,
					2,
				),
			);
			break;
		default:
			throw new Error(usage());
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
