// biome-ignore-all lint/complexity/useLiteralKeys: Mutation fixtures use dynamic keys.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	selectArchitectureChecksums,
	validateImageContract,
} from "../image-contract";
import { renderFixture } from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");

const CONTRACT_FILES = [
	".dockerignore",
	".prototools",
	"package.json",
	"renovate.json",
	"template-parameters.toml",
	".devcontainer/Dockerfile",
	".devcontainer/devcontainer-fingerprint.sh",
	".devcontainer/devcontainer-lock.json",
	".devcontainer/devcontainer.json",
	".devcontainer/prototools.auxiliary",
	".devcontainer/prototools.foundation",
	".devcontainer/on-create.sh",
	".devcontainer/on-create/setup-ccstatusline.sh",
	".devcontainer/on-create/setup-claude.sh",
	".devcontainer/on-create/setup-codex.sh",
	".devcontainer/on-create/setup-gemini.sh",
	".devcontainer/on-create/setup-graphify.sh",
	".devcontainer/on-create/setup-proto.sh",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-image-contract-"));
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
	const errors = await validateImageContract(root);
	expect(errors).toContain(expected);
	console.log(`[stage2-observed] ${expected}`);
	await Bun.write(target, original);
	expect(await validateImageContract(root)).toEqual([]);
}

describe("devcontainer image contract", () => {
	test("passes the real tree and rejects known-bad image mutations", async () => {
		expect(await validateImageContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateImageContract(temporary)).toEqual([]);
			await mutate(
				temporary,
				".devcontainer/prototools.auxiliary",
				(source) => `bun = "1.3.13"\n${source}`,
				"image: Proto partition duplicates tools.bun",
			);
			await mutate(
				temporary,
				".devcontainer/prototools.foundation",
				(source) => source.replace('python = "3.14.2"\n', ""),
				"image: Proto partition tool union differs from .prototools",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replaceAll(
						"DELTA_SHA256_ARM64=937781aa",
						"DELTA_SHA256_ARM64=invalid_",
					),
				"image: delta arm64 checksum is missing or malformed",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace(
						`releases/download/v\${RTK_VERSION}`,
						"releases/latest/download",
					),
				"image: Dockerfile contains a mutable download source",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replaceAll(
						"/etc/profile.d/devenv-path.sh",
						"/tmp/known-bad-path.sh",
					),
				"image: login shells omit the image-owned tool PATH",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) => `${source}\nproto use\n`,
				"image: setup-proto mutates the image-owned toolchain",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) => source.replace("DEVCONTAINER_FINGERPRINT_BUN=", ""),
				"image: setup-proto omits DEVCONTAINER_FINGERPRINT_BUN",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) => source.replace('"/bin/bash"', '"bash"'),
				"image: onCreateCommand must use absolute system Bash",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace(
						'"mounts": [',
						`"mounts": [\n\t\t"source=proto-home-\${devcontainerId},target=/home/vscode/.proto,type=volume",`,
					),
				"image: active devcontainer must not mount Proto storage",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("selects independently pinned checksum branches", async () => {
		const source = await Bun.file(
			resolve(ROOT, ".devcontainer/Dockerfile"),
		).text();
		const amd64 = selectArchitectureChecksums(source, "amd64");
		const arm64 = selectArchitectureChecksums(source, "arm64");
		for (const owner of ["delta", "rtk", "claude"]) {
			expect(amd64[owner]).toMatch(/^[0-9a-f]{64}$/);
			expect(arm64[owner]).toMatch(/^[0-9a-f]{64}$/);
			expect(amd64[owner]).not.toBe(arm64[owner]);
		}
		console.log(
			"[stage2-observed] amd64 and arm64 checksum branches are complete and independently selected",
		);
	});

	test("fingerprint is deterministic and changes with a definition input", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-fingerprint-"));
		try {
			for (const path of [
				".dockerignore",
				".prototools",
				".devcontainer/devcontainer-fingerprint.sh",
				".devcontainer/devcontainer.json",
			]) {
				const destination = resolve(temporary, path);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(resolve(ROOT, path), destination);
			}
			const script = resolve(
				temporary,
				".devcontainer/devcontainer-fingerprint.sh",
			);
			const fingerprint = (): string => {
				const result = Bun.spawnSync(["bash", script, temporary]);
				expect(result.exitCode).toBe(0);
				return result.stdout.toString().trim();
			};
			const first = fingerprint();
			expect(first).toMatch(/^[0-9a-f]{64}$/);
			expect(fingerprint()).toBe(first);
			await Bun.write(
				resolve(temporary, ".devcontainer/devcontainer.json"),
				'{"knownBad":true}\n',
			);
			expect(fingerprint()).not.toBe(first);
			console.log(
				"[stage2-observed] complete definition fingerprint is deterministic and detects mutation",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("rendered minimal and full images match capability selection", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-image-render-"));
		try {
			const minimal = resolve(temporary, "minimal");
			const full = resolve(temporary, "full");
			await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: minimal,
			});
			await renderFixture({ root: ROOT, fixtureName: "full", output: full });
			expect(await validateImageContract(minimal)).toEqual([]);
			expect(await validateImageContract(full)).toEqual([]);
			const minimalDockerfile = await Bun.file(
				resolve(minimal, ".devcontainer/Dockerfile"),
			).text();
			expect(minimalDockerfile).not.toContain("playwright_browser");
			const fullDockerfile = await Bun.file(
				resolve(full, ".devcontainer/Dockerfile"),
			).text();
			expect(fullDockerfile).toContain("development_browser");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
