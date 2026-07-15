// biome-ignore-all lint/complexity/useLiteralKeys: Mutation fixtures use strict JSON records.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { validateToolchainContract } from "../toolchain";
import {
	validateStageOneEvidence,
	validateStageOneEvidenceValue,
} from "../toolchain-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

const CONTRACT_FILES = [
	".prototools",
	"package.json",
	"bun.lock",
	"template-parameters.toml",
	".devcontainer/configs/.shell_common",
	".devcontainer/devcontainer-lock.json",
	".devcontainer/devcontainer.json",
	".devcontainer/on-create/setup-common.sh",
	".devcontainer/on-create/setup-proto.sh",
	".devcontainer/proto-checksums.txt",
	".github/workflows/ci.yml",
	"scripts/template/tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.lib.base.json",
	"tsconfig.next.base.json",
	"tsconfig.stagehand.base.json",
	"tsconfig.start.base.json",
	"tsconfig.worker.base.json",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-toolchain-"));
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	return temporary;
}

async function mutate(
	root: string,
	path: string,
	transform: (source: string) => string,
	expected: string,
): Promise<void> {
	const target = resolve(root, path);
	const original = await Bun.file(target).text();
	const changed = transform(original);
	if (changed === original) throw new Error(`Mutation did not change ${path}`);
	await Bun.write(target, changed);
	expect(await validateToolchainContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateToolchainContract(root)).toEqual([]);
}

describe("repository toolchain contract", () => {
	test("validates non-vacuous Stage 1 evidence", async () => {
		expect(await validateStageOneEvidence(ROOT)).toEqual([]);
		const value = await Bun.file(
			resolve(ROOT, "evidence/stage-1-toolchain.json"),
		).json();
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-1-toolchain.schema.json"),
		).json()) as Record<string, unknown>;
		const changed = structuredClone(value) as Record<string, unknown>;
		const proofs = changed["mutationProof"] as Array<Record<string, unknown>>;
		proofs.splice(
			proofs.findIndex((proof) => proof["name"] === "catalog-floating"),
			1,
		);
		expect(validateStageOneEvidenceValue(changed, schema)).toContain(
			"semantic: missing mutation proof catalog-floating",
		);
		const fabricated = structuredClone(value) as Record<string, unknown>;
		const fabricatedProofs = fabricated["mutationProof"] as Array<
			Record<string, unknown>
		>;
		const floating = fabricatedProofs.find(
			(proof) => proof["name"] === "catalog-floating",
		);
		if (!floating) throw new Error("catalog-floating proof fixture is missing");
		floating["expected"] = "fabricated; mutation never executed";
		expect(validateStageOneEvidenceValue(fabricated, schema)).toContain(
			"semantic: mutation proof catalog-floating expectation drifted",
		);
		const future = structuredClone(value) as Record<string, unknown>;
		future["capturedAt"] = "2035-01-01T00:00:00Z";
		expect(validateStageOneEvidenceValue(future, schema)).toContain(
			"semantic: Stage 1 evidence capture time is in the future",
		);
		const attachedVolume = structuredClone(value) as Record<string, unknown>;
		const rollback = attachedVolume["rollback"] as Record<string, unknown>;
		const runtimeCleanup = rollback["runtimeCleanup"] as string[][];
		rollback["runtimeCleanup"] = runtimeCleanup.filter(
			(command) => command[0] !== "docker" || command[1] !== "rm",
		);
		expect(validateStageOneEvidenceValue(attachedVolume, schema)).toContain(
			"semantic: Stage 1 rollback must stop and remove its container before deleting the Proto volume",
		);
	});

	test("passes the real tree and rejects known-bad authority mutations", async () => {
		expect(await validateToolchainContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateToolchainContract(temporary)).toEqual([]);

			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"@biomejs/biome": "2.4.16"',
						'"@biomejs/biome": "latest"',
					),
				"catalog: @biomejs/biome must use an exact version",
			);
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"@biomejs/biome": "catalog:"',
						'"@biomejs/biome": "2.4.16"',
					),
				"catalog: root consumer @biomejs/biome must use catalog:",
			);
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace('"wrangler": "4.107.0"', '"wrangler": "4.108.0"'),
				"lock: wrangler does not resolve to catalog 4.108.0",
			);
			await mutate(
				temporary,
				".prototools",
				(source) =>
					source.replace("786005a6ef2371ae1c7893610d065ac5612d61a9", "main"),
				"proto: plugin direnv must use an immutable commit URL",
			);
			await mutate(
				temporary,
				"bun.lock",
				(source) =>
					source.replace(
						'"packages": {',
						'"packages": {\n    "synthetic/wrangler": ["wrangler@4.108.0", "", {}],',
					),
				"lock: wrangler must resolve exactly once, found 2 entries (4.107.0, 4.108.0)",
			);
			await mutate(
				temporary,
				"bun.lock",
				(source) =>
					source.replace(
						'"packages": {',
						'"packages": {\n    "synthetic/wrangler-same": ["wrangler@4.107.0", "", {}],',
					),
				"lock: wrangler must resolve exactly once, found 2 entries (4.107.0)",
			);
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"devDependencies": {',
						'"devDependencies": {\n    "synthetic-floating-cli": "latest",',
					),
				"catalog: package.json devDependencies.synthetic-floating-cli is not catalog-owned",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source.replace("bun-version: '1.3.13'", "bun-version: '1.3.14'"),
				"proto: .github/workflows/ci.yml Bun 1.3.14 differs from .prototools",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer-lock.json",
				(source) => source.replace("sha256:cb0c4d3c", "sha256:ab0c4d3c"),
				"features: ghcr.io/devcontainers/features/common-utils:2 resolved reference and integrity differ",
			);
			await mutate(
				temporary,
				".devcontainer/proto-checksums.txt",
				(source) => source.replace(/^[0-9a-f]{64}/, "invalid"),
				"proto: checksum architectures drift from template parameters",
			);
			await mutate(
				temporary,
				"tsconfig.base.json",
				(source) =>
					source.replace(
						'"compilerOptions": {',
						'"compilerOptions": {\n\t\t"baseUrl": ".",',
					),
				"typescript: tsconfig.base.json reintroduces baseUrl",
			);
			await mutate(
				temporary,
				"tsconfig.base.json",
				(source) =>
					source.replace(
						`\${configDir}/../../libs/*/src`,
						"/workspace/libs/*/src",
					),
				"typescript: tsconfig.base.json contains an absolute path alias",
			);
			await mutate(
				temporary,
				".devcontainer/configs/.shell_common",
				(source) =>
					source.replace(
						"/workspace/node_modules/.bin:$HOME/.local/bin:$HOME/.proto/shims",
						"$HOME/.proto/shims:/workspace/node_modules/.bin:$HOME/.local/bin",
					),
				"path: .shell_common resolves Proto before workspace binaries",
			);

			const nestedLock = resolve(temporary, "apps/example/bun.lock");
			await mkdir(dirname(nestedLock), { recursive: true });
			await Bun.write(nestedLock, "{}\n");
			expect(await validateToolchainContract(temporary)).toContain(
				"lock: secondary package lock apps/example/bun.lock is forbidden",
			);
			await rm(nestedLock);
			expect(await validateToolchainContract(temporary)).toEqual([]);

			const skeleton = resolve(temporary, "scripts/templates/game-skeleton");
			await mkdir(skeleton, { recursive: true });
			await Bun.write(
				resolve(skeleton, "package.json"),
				'{"name":"game-skeleton","devDependencies":{"zod":"latest"}}\n',
			);
			await Bun.write(
				resolve(skeleton, "tsconfig.json"),
				'{"compilerOptions":{"baseUrl":"."}}\n',
			);
			await Bun.write(resolve(skeleton, "bun.lock"), "{}\n");
			const skeletonErrors = await validateToolchainContract(temporary);
			expect(skeletonErrors).toContain(
				"catalog: scripts/templates/game-skeleton/package.json devDependencies.zod bypasses catalog:",
			);
			expect(skeletonErrors).toContain(
				"typescript: scripts/templates/game-skeleton/tsconfig.json reintroduces baseUrl",
			);
			expect(skeletonErrors).toContain(
				"lock: secondary package lock scripts/templates/game-skeleton/bun.lock is forbidden",
			);
			await rm(skeleton, { recursive: true });
			expect(await validateToolchainContract(temporary)).toEqual([]);

			const packageManifest = resolve(temporary, "package.json");
			const originalPackage = await Bun.file(packageManifest).text();
			await Bun.write(
				packageManifest,
				originalPackage.replace(
					'"scripts": {',
					'"peerDependencies": {"better-auth": "^1.6.0"},\n  "scripts": {',
				),
			);
			expect(await validateToolchainContract(temporary)).toEqual([]);
			await Bun.write(packageManifest, originalPackage);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("checksum verifier fails closed before archive extraction", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-proto-hash-"));
		try {
			const archive = resolve(temporary, "archive.tar.xz");
			const payload = "deterministic Stage 1 checksum fixture\n";
			await Bun.write(archive, payload);
			const checksum = new Bun.CryptoHasher("sha256")
				.update(payload)
				.digest("hex");
			const installer = resolve(ROOT, ".devcontainer/install-proto.sh");
			const valid = Bun.spawnSync([
				"bash",
				installer,
				"--verify-only",
				archive,
				checksum,
			]);
			const invalid = Bun.spawnSync([
				"bash",
				installer,
				"--verify-only",
				archive,
				"0".repeat(64),
			]);
			expect(valid.exitCode).toBe(0);
			expect(invalid.exitCode).not.toBe(0);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("Proto health check rejects incomplete and accepts complete installations", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-proto-health-"));
		try {
			const bin = resolve(temporary, "bin");
			await mkdir(bin, { recursive: true });
			const proto = resolve(bin, "proto");
			const shim = resolve(bin, "proto-shim");
			await Bun.write(proto, "#!/usr/bin/env bash\necho 'proto 0.55.4'\n");
			await Bun.write(shim, "#!/usr/bin/env bash\nexit 0\n");
			await Bun.$`chmod +x ${proto} ${shim}`;
			const installer = resolve(ROOT, ".devcontainer/install-proto.sh");
			expect(
				Bun.spawnSync([
					"bash",
					installer,
					"--health-check",
					temporary,
					"0.55.4",
				]).exitCode,
			).toBe(0);
			await rm(shim);
			expect(
				Bun.spawnSync([
					"bash",
					installer,
					"--health-check",
					temporary,
					"0.55.4",
				]).exitCode,
			).not.toBe(0);
			const setup = await Bun.file(
				resolve(ROOT, ".devcontainer/on-create/setup-proto.sh"),
			).text();
			expect(setup).toContain("/workspace/.devcontainer/install-proto.sh");
			expect(setup).not.toContain("if ! command -v proto");
			const openspec = await Bun.file(
				resolve(ROOT, ".devcontainer/on-create/setup-openspec.sh"),
			).text();
			expect(openspec).toContain("--force || return 1");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
