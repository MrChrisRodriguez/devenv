// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutations intentionally address schema keys.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	collectionCommands,
	parseShellProbe,
	probePartition,
	probeRollback,
	STAGE_TWO_BASE_SHA,
	STAGE_TWO_IMPLEMENTATION_SHA,
} from "../collect-stage-two-evidence";
import {
	classifyBuildStages,
	type JsonRecord,
	STAGE_TWO_COMMAND_IDS,
	sha256,
	syntheticStageTwoMergeMetadata,
	validateBoundStageTwoLogs,
	validateStageTwoEvidence,
	validateStageTwoEvidenceValue,
} from "../image-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const SHA = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function validEvidence(): JsonRecord {
	const id = "stage2-20260715t000000z-deadbeef";
	const baseSha = "1".repeat(40);
	const implementationSha = "2".repeat(40);
	const temporaryRoot = `/tmp/devenv-stage2-${id}`;
	const seed: JsonRecord = {
		run: {
			id,
			temporaryRoot,
			nativeArchitecture: "arm64",
			logRoot: "evidence/stage-2-image-run",
		},
		source: { baseSha, implementationSha, featureTreeClean: true },
		image: {
			tag: `devenv-stage2-${id}`,
			alternateCodexVersion: "0.144.3",
		},
	};
	const commands = collectionCommands(seed);
	return {
		schemaVersion: 1,
		stage: "stage-2-image-architecture",
		capturedAt: "2026-07-15T00:00:03.000Z",
		run: seed["run"],
		source: seed["source"],
		image: {
			tag: `devenv-stage2-${id}`,
			imageId: IMAGE_ID,
			definitionFingerprint: "3".repeat(64),
			definitionMarker: "3".repeat(64),
			protoManifestSha256: "4".repeat(64),
			protoManifestMarker: "4".repeat(64),
			codexVersion: "0.144.4",
			alternateCodexVersion: "0.144.3",
		},
		commands: STAGE_TWO_COMMAND_IDS.map((commandId) => {
			const durationMs =
				commandId === "clean-build"
					? 2000
					: commandId === "warm-build"
						? 500
						: 100;
			return {
				id: commandId,
				command: commands[commandId],
				runId: id,
				startedAt: "2026-07-15T00:00:00.000Z",
				completedAt: new Date(
					Date.parse("2026-07-15T00:00:00.000Z") + durationMs,
				).toISOString(),
				durationMs,
				stdoutPath: `evidence/stage-2-image-run/${commandId}.stdout`,
				stderrPath: `evidence/stage-2-image-run/${commandId}.stderr`,
				stdoutSha256: SHA,
				stderrSha256: SHA,
				exitCode: 0,
				status: "pass",
			};
		}),
		builds: {
			clean: {
				commandId: "clean-build",
				durationMs: 2000,
				cachedSteps: 0,
				noCache: true,
			},
			warm: {
				commandId: "warm-build",
				durationMs: 500,
				cachedSteps: 12,
				noCache: false,
			},
		},
		layerInvalidation: {
			commandId: "layer-invalidation",
			changedOwner: "CODEX_VERSION",
			cachedStages: [
				"stable_base",
				"proto_foundation",
				"proto_auxiliary",
				"graphify_payload",
			],
			rebuiltStages: ["codex_payload", "development"],
		},
		architectures: [
			{
				architecture: "amd64",
				commandId: "architecture-amd64",
				status: "pass",
				rebuiltStages: [
					"stable_base",
					"proto_foundation",
					"claude_payload",
					"development",
				],
			},
			{
				architecture: "arm64",
				commandId: "architecture-arm64",
				status: "pass",
				rebuiltStages: [
					"stable_base",
					"proto_foundation",
					"claude_payload",
					"development",
				],
			},
		],
		staleImageRefusal: {
			commandId: "stale-image-refusal",
			mutation: "shadow-workspace-bun-and-edit-definition",
			originalDefinitionFingerprint: "5".repeat(64),
			mutatedDefinitionFingerprint: "6".repeat(64),
			shadowBunPath: "/workspace/node_modules/.bin/bun",
			containerExitCode: 1,
			refused: true,
			diagnostic:
				"ERROR: .prototools differs from the manifest. Rebuild/recreate the devcontainer.",
		},
		partitionMutation: {
			commandId: "partition-mutation",
			mutation: "drop-foundation-uv",
			rejected: true,
			diagnostic: "partition: root tool uv is missing from derived manifests",
		},
		shellPaths: [
			["bash", "login", "shell-bash-login"],
			["bash", "non-login", "shell-bash-non-login"],
			["zsh", "login", "shell-zsh-login"],
			["zsh", "non-login", "shell-zsh-non-login"],
		].map(([shell, mode, commandId]) => ({
			shell,
			mode,
			commandId,
			bunPath: "/home/vscode/.proto/shims/bun",
			protoPath: "/home/vscode/.proto/bin/proto",
			path: "/workspace/node_modules/.bin:/home/vscode/.proto/shims:/home/vscode/.proto/bin:/home/vscode/.local/bin:/usr/bin",
		})),
		secondWorktreeStorage: {
			commandId: "second-worktree-storage",
			primaryContainerId: "7".repeat(64),
			secondContainerId: "8".repeat(64),
			primaryImageId: IMAGE_ID,
			secondImageId: IMAGE_ID,
			primaryContainerWritableBytes: 4096,
			secondContainerWritableBytes: 4096,
			secondCheckoutBytes: 8192,
			volumeBytes: 0,
			observedBytes: 12288,
			stageZeroBaselineBytes: 96111608,
			imageProtoBytes: 1048576,
			protoVolumeCount: 0,
			protoMountCount: 0,
			operations: Array.from({ length: 6 }, () => ["docker", "inspect"]),
		},
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
				["docker", "image", "rm", `devenv-stage2-${id}`],
			],
			scope: "Revert the complete Stage 2 image ownership bundle atomically.",
			proof: {
				commandId: "rollback-proof",
				predecessorSha: baseSha,
				implementationSha,
				syntheticMergeSha: "9".repeat(40),
				syntheticMergeTree: "a".repeat(40),
				syntheticMergeParents: [baseSha, implementationSha],
				predecessorTree: "b".repeat(40),
				revertedTree: "b".repeat(40),
				treeMatchesPredecessor: true,
				operations: Array.from({ length: 5 }, () => [
					"git",
					"rev-parse",
					"HEAD",
				]),
			},
		},
	};
}

function git(root: string, command: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", ...command],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Stage Two Test",
			GIT_AUTHOR_EMAIL: "stage-two-test@example.invalid",
			GIT_COMMITTER_NAME: "Stage Two Test",
			GIT_COMMITTER_EMAIL: "stage-two-test@example.invalid",
		},
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

describe("Stage 2 image evidence", () => {
	test("rejects fabricated committed metrics and rollback metadata", async () => {
		const path = resolve(
			await mkdtemp(resolve(tmpdir(), "devenv-stage2-false-evidence-")),
			"evidence.json",
		);
		try {
			const original = (await Bun.file(
				resolve(ROOT, "evidence/stage-2-image.json"),
			).json()) as JsonRecord;
			const validateMutation = async (
				mutate: (evidence: JsonRecord) => void,
			): Promise<string[]> => {
				const evidence = structuredClone(original);
				mutate(evidence);
				await Bun.write(path, `${JSON.stringify(evidence, null, 2)}\n`);
				return validateStageTwoEvidence(ROOT, path);
			};

			expect(
				await validateMutation((evidence) => {
					(evidence["secondWorktreeStorage"] as JsonRecord)["observedBytes"] =
						0;
				}),
			).toContain(
				"semantic: second-worktree storage arithmetic is inconsistent",
			);

			expect(
				await validateMutation((evidence) => {
					const warm = (evidence["builds"] as JsonRecord)["warm"] as JsonRecord;
					warm["cachedSteps"] = 999_999;
				}),
			).toContain(
				"repository: warm-build cache count differs from its bound log",
			);

			expect(
				await validateMutation((evidence) => {
					const proof = (evidence["rollback"] as JsonRecord)[
						"proof"
					] as JsonRecord;
					proof["syntheticMergeSha"] = "0".repeat(40);
					proof["syntheticMergeParents"] = [
						proof["implementationSha"],
						proof["predecessorSha"],
					];
				}),
			).toContain(
				"repository: Stage 2 synthetic merge commit metadata drifted",
			);
		} finally {
			await rm(resolve(path, ".."), { recursive: true, force: true });
		}
	});

	test("binds multiline probe diagnostics through their JSON value", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "devenv-stage2-bound-log-"));
		try {
			const evidence = validEvidence();
			const stale = evidence["staleImageRefusal"] as JsonRecord;
			stale["diagnostic"] = "first diagnostic line\nsecond diagnostic line";
			const stdout = `${JSON.stringify(stale, null, 2)}\n`;
			const stderr = "";
			await Bun.write(resolve(root, "stale.stdout"), stdout);
			await Bun.write(resolve(root, "stale.stderr"), stderr);
			const command = (evidence["commands"] as JsonRecord[]).find(
				(entry) => entry["id"] === "stale-image-refusal",
			);
			expect(command).toBeDefined();
			if (!command) throw new Error("missing stale command fixture");
			command["stdoutPath"] = "stale.stdout";
			command["stderrPath"] = "stale.stderr";
			command["stdoutSha256"] = sha256(stdout);
			command["stderrSha256"] = sha256(stderr);
			evidence["commands"] = [command];

			const validErrors = await validateBoundStageTwoLogs(root, evidence);
			expect(validErrors).not.toContain(
				"repository: stale-image evidence differs from its bound log",
			);

			stale["diagnostic"] = "another diagnostic";
			expect(await validateBoundStageTwoLogs(root, evidence)).toContain(
				"repository: stale-image evidence differs from its bound log",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("accepts the complete command-bound semantic record and rejects material mutations", async () => {
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-2-image.schema.json"),
		).json()) as JsonRecord;
		const evidence = validEvidence();
		expect(validateStageTwoEvidenceValue(evidence, schema)).toEqual([]);

		const missing = structuredClone(evidence);
		(missing["commands"] as unknown[]).pop();
		expect(validateStageTwoEvidenceValue(missing, schema)).toContain(
			"semantic: missing command result rollback-proof",
		);

		const mutableStorage = structuredClone(evidence);
		(mutableStorage["secondWorktreeStorage"] as JsonRecord)[
			"protoVolumeCount"
		] = 1;
		expect(validateStageTwoEvidenceValue(mutableStorage, schema)).toContain(
			"semantic: second worktree retained mutable Proto storage",
		);
		const falseStorage = structuredClone(evidence);
		(falseStorage["secondWorktreeStorage"] as JsonRecord)["observedBytes"] = 0;
		expect(validateStageTwoEvidenceValue(falseStorage, schema)).toContain(
			"semantic: second-worktree storage arithmetic is inconsistent",
		);

		const cachedAssembly = structuredClone(evidence);
		(cachedAssembly["layerInvalidation"] as JsonRecord)["rebuiltStages"] = [
			"codex_payload",
		];
		expect(validateStageTwoEvidenceValue(cachedAssembly, schema)).toContain(
			"semantic: Codex pin mutation did not isolate codex_payload invalidation",
		);
		const cachedArchitecture = structuredClone(evidence);
		((cachedArchitecture["architectures"] as JsonRecord[])[0] as JsonRecord)[
			"rebuiltStages"
		] = [];
		expect(validateStageTwoEvidenceValue(cachedArchitecture, schema)).toContain(
			"semantic: architecture amd64 did not execute stable_base",
		);
	});

	test("derives all sixteen collector commands from the validator authority", () => {
		expect(STAGE_TWO_BASE_SHA).toBe("4367bad6e2cb49e4c969a61b892634347ed0bf24");
		expect(STAGE_TWO_IMPLEMENTATION_SHA).toBe(
			"672701c1029a702b6a6e819608298c725ce8cdf5",
		);
		const evidence = validEvidence();
		const commands = collectionCommands(evidence);
		expect(Object.keys(commands).sort()).toEqual(
			[...STAGE_TWO_COMMAND_IDS].sort(),
		);
		expect(commands["stale-image-refusal"].slice(0, 3)).toEqual([
			"bun",
			"scripts/template/collect-stage-two-evidence.ts",
			"probe-stale",
		]);
		expect(commands["layer-invalidation"]).toContain("codex_payload");
		expect(commands["layer-invalidation"]).toContain("development");
		expect(commands["rollback-proof"]).toContain("probe-rollback");
	});

	test("parses real BuildKit stage and shell observations without estimates", () => {
		const statuses = classifyBuildStages(`
#7 [stable_base 2/5] RUN apt-get update
#7 CACHED
#14 [proto_foundation 3/3] RUN proto install
#14 CACHED
#16 [proto_auxiliary 2/2] RUN proto install
#16 CACHED
#22 [graphify_payload 1/1] RUN uv tool install
#22 CACHED
#18 [codex_payload 1/1] RUN bun install
#18 DONE 12.3s
`);
		expect(statuses.cachedStages).toEqual([
			"graphify_payload",
			"proto_auxiliary",
			"proto_foundation",
			"stable_base",
		]);
		expect(statuses.rebuiltStages).toEqual(["codex_payload"]);
		expect(
			parseShellProbe(
				"/home/vscode/.proto/shims/bun\n/home/vscode/.proto/bin/proto\n/workspace/node_modules/.bin:/home/vscode/.proto/shims:/home/vscode/.proto/bin:/usr/bin\n",
			),
		).toEqual({
			bunPath: "/home/vscode/.proto/shims/bun",
			protoPath: "/home/vscode/.proto/bin/proto",
			path: "/workspace/node_modules/.bin:/home/vscode/.proto/shims:/home/vscode/.proto/bin:/usr/bin",
		});
	});

	test("performs the real foundation partition mutation", async () => {
		const result = await probePartition({
			root: ROOT,
			mutation: "drop-foundation-uv",
		});
		expect(result.rejected).toBe(true);
		expect(result.diagnostic).toContain(
			"root tool uv is missing from derived manifests",
		);
	});

	test("proves a real synthetic merge mainline rollback", async () => {
		const repository = await mkdtemp(
			resolve(tmpdir(), "devenv-stage2-rollback-repository-"),
		);
		const workspace = await mkdtemp(
			resolve(tmpdir(), "devenv-stage2-rollback-worktree-"),
		);
		try {
			git(repository, ["init", "--quiet"]);
			await Bun.write(resolve(repository, "contract.txt"), "base\n");
			git(repository, ["add", "contract.txt"]);
			git(repository, ["commit", "--quiet", "-m", "base"]);
			const base = git(repository, ["rev-parse", "HEAD"]);
			await Bun.write(resolve(repository, "contract.txt"), "implementation\n");
			git(repository, ["commit", "--quiet", "-am", "implementation"]);
			const implementation = git(repository, ["rev-parse", "HEAD"]);
			const proof = await probeRollback({
				root: repository,
				base,
				implementation,
				workspace,
			});
			const expectedMerge = syntheticStageTwoMergeMetadata(
				base,
				implementation,
				git(repository, ["rev-parse", `${implementation}^{tree}`]),
			);
			expect(proof.syntheticMergeParents).toEqual([base, implementation]);
			expect(proof.syntheticMergeSha).toBe(expectedMerge.sha);
			expect(proof.revertedTree).toBe(proof.predecessorTree);
			expect(proof.treeMatchesPredecessor).toBe(true);
		} finally {
			await rm(repository, { recursive: true, force: true });
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
