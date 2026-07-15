import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function run(command: string[], cwd: string): CommandResult {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function required(command: string[], cwd: string): string {
	const result = run(command, cwd);
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
		required(["git", "merge", "--no-ff", "--no-edit", headSha], checkout);
		const mergeSha = required(["git", "rev-parse", "HEAD"], checkout);
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
