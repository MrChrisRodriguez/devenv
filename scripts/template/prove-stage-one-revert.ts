import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const SYNTHETIC_MERGE_SUBJECT = "Stage 1 synthetic merge proof";
const SYNTHETIC_IDENTITY = "Stage 1 Evidence <stage1-evidence@example.invalid>";

export function syntheticMergeMetadata(
	baseSha: string,
	headSha: string,
	treeSha: string,
): {
	sha: string;
	tree: string;
	parents: [string, string];
} {
	const content = [
		`tree ${treeSha}`,
		`parent ${baseSha}`,
		`parent ${headSha}`,
		`author ${SYNTHETIC_IDENTITY} 0 +0000`,
		`committer ${SYNTHETIC_IDENTITY} 0 +0000`,
		"",
		SYNTHETIC_MERGE_SUBJECT,
		"",
	].join("\n");
	const encoded = new TextEncoder().encode(content);
	const header = new TextEncoder().encode(`commit ${encoded.byteLength}\0`);
	const object = new Uint8Array(header.byteLength + encoded.byteLength);
	object.set(header);
	object.set(encoded, header.byteLength);
	return {
		sha: new Bun.CryptoHasher("sha1").update(object).digest("hex"),
		tree: treeSha,
		parents: [baseSha, headSha],
	};
}

function run(
	command: string[],
	cwd: string,
	env?: Record<string, string>,
): CommandResult {
	const result =
		env === undefined
			? Bun.spawnSync({
					cmd: command,
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				})
			: Bun.spawnSync({
					cmd: command,
					cwd,
					env: { ...process.env, ...env },
					stdout: "pipe",
					stderr: "pipe",
				});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function required(
	command: string[],
	cwd: string,
	env?: Record<string, string>,
): string {
	const result = run(command, cwd, env);
	if (result.exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function prove(): Promise<void> {
	const root = resolve(argument("--root") ?? resolve(import.meta.dir, "../.."));
	const evidence = (await Bun.file(
		resolve(root, "evidence/stage-1-toolchain.json"),
	).json()) as { source: { baseSha: string } };
	const baseSha = argument("--base") ?? evidence.source.baseSha;
	const headSha =
		argument("--head") ?? required(["git", "rev-parse", "HEAD"], root);
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-stage1-revert-"));
	const checkout = resolve(temporary, "repo");
	const observations: string[] = [];
	let imageName: string | undefined;
	try {
		required(
			["git", "clone", "--quiet", "--no-hardlinks", root, checkout],
			root,
		);
		required(["git", "config", "user.name", "Stage 1 Evidence"], checkout);
		required(
			["git", "config", "user.email", "stage1-evidence@example.invalid"],
			checkout,
		);
		required(["git", "checkout", "--quiet", "--detach", baseSha], checkout);
		const headTree = required(
			["git", "rev-parse", `${headSha}^{tree}`],
			checkout,
		);
		const merge = syntheticMergeMetadata(baseSha, headSha, headTree);
		const mergeSha = required(
			[
				"git",
				"commit-tree",
				headTree,
				"-p",
				baseSha,
				"-p",
				headSha,
				"-m",
				SYNTHETIC_MERGE_SUBJECT,
			],
			checkout,
			{
				GIT_AUTHOR_NAME: "Stage 1 Evidence",
				GIT_AUTHOR_EMAIL: "stage1-evidence@example.invalid",
				GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
				GIT_COMMITTER_NAME: "Stage 1 Evidence",
				GIT_COMMITTER_EMAIL: "stage1-evidence@example.invalid",
				GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
			},
		);
		if (mergeSha !== merge.sha)
			throw new Error("Synthetic merge metadata is not deterministic");
		required(["git", "checkout", "--quiet", "--detach", mergeSha], checkout);
		required(["git", "revert", "-m", "1", "--no-edit", mergeSha], checkout);
		const revertedTree = required(
			["git", "rev-parse", "HEAD^{tree}"],
			checkout,
		);
		const predecessorTree = required(
			["git", "rev-parse", `${baseSha}^{tree}`],
			checkout,
		);
		if (revertedTree !== predecessorTree)
			throw new Error(
				"Synthetic merge revert did not restore predecessor tree",
			);

		const proto = Bun.TOML.parse(
			await Bun.file(resolve(checkout, ".prototools")).text(),
		) as Record<string, unknown>;
		const devcontainer = (await Bun.file(
			resolve(checkout, ".devcontainer/devcontainer.json"),
		).json()) as { features?: Record<string, unknown> };
		const nodeFeatures = Object.keys(devcontainer.features ?? {}).filter(
			(feature) => feature.endsWith("/node:1"),
		);
		if (proto["bun"] !== "1.3.4")
			throw new Error("Predecessor Bun authority was not restored");
		if (proto["node"] !== undefined)
			throw new Error("Predecessor unexpectedly leaves Node selected in Proto");
		if (nodeFeatures.length !== 1)
			throw new Error("Predecessor Node feature authority was not restored");

		observations.push(
			`headSha=${headSha}`,
			`predecessorSha=${baseSha}`,
			`syntheticMergeSha=${mergeSha}`,
			`syntheticMergeTree=${merge.tree}`,
			`syntheticMergeParents=${merge.parents.join(",")}`,
			"revertExitCode=0",
			`predecessorTree=${predecessorTree}`,
			`revertedTree=${revertedTree}`,
			"treeMatchesPredecessor=true",
			"predecessorBun=1.3.4",
			"predecessorProtoNodeSelected=false",
			`predecessorNodeFeature=${nodeFeatures[0]}`,
		);

		if (process.argv.includes("--image")) {
			imageName = `devenv-stage1-revert-proof-${process.pid}`;
			required(
				[
					"devcontainer",
					"build",
					"--workspace-folder",
					checkout,
					"--no-lockfile",
					"--image-name",
					imageName,
				],
				checkout,
			);
			const health = required(
				[
					"docker",
					"run",
					"--rm",
					"--entrypoint",
					"bash",
					imageName,
					"-lc",
					"printf 'nodePath=%s\\n' \"$(command -v node)\"; printf 'nodeVersion=%s\\n' \"$(node --version)\"; test ! -e /home/vscode/.proto/shims/node; printf 'protoNodeShim=absent\\n'",
				],
				checkout,
			);
			observations.push("imageBuildExitCode=0", ...health.split("\n"));
			const cleanup = run(["docker", "image", "rm", imageName], checkout);
			if (cleanup.exitCode !== 0)
				throw new Error(`Could not remove proof image ${imageName}`);
			imageName = undefined;
			observations.push("imageCleanupExitCode=0");
		}

		console.log(observations.join("\n"));
	} finally {
		if (imageName) run(["docker", "image", "rm", "--force", imageName], root);
		await rm(temporary, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await prove();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
