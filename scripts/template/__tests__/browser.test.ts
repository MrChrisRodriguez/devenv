// biome-ignore-all lint/complexity/useLiteralKeys: Mutation fixtures use dynamic keys.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { validateBrowserContract } from "../browser-contract";
import { renderFixture } from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");
const CONTRACT_FILES = [
	"package.json",
	"bun.lock",
	"template-parameters.toml",
	".devcontainer/Dockerfile",
	".devcontainer/devcontainer.json",
	"scripts/browser-preflight.ts",
	"scripts/template/browser-contract.ts",
	"scripts/template/validate-browser.ts",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), "devenv-browser-contract-"),
	);
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
	expect(await validateBrowserContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateBrowserContract(root)).toEqual([]);
}

describe("browser runtime contract", () => {
	test("passes the source tree and rejects pin, payload, library, and preflight drift", async () => {
		expect(await validateBrowserContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateBrowserContract(temporary)).toEqual([]);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace(
						"ARG PLAYWRIGHT_VERSION=1.59.1",
						"ARG PLAYWRIGHT_VERSION=1.59.2",
					),
				"browser: Docker pin must equal the package catalog pin",
			);
			await mutate(
				temporary,
				"bun.lock",
				(source) =>
					source.replace("playwright-core@1.59.1", "playwright-core@1.59.2"),
				"browser: playwright-core must resolve once at 1.59.1 (found 1.59.2)",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace(
						"-name ffmpeg -o -name ffmpeg-linux",
						"-name media-tool -o -name media-tool-linux",
					),
				"browser: image payload does not verify baked FFmpeg",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) => source.replace("\n\t\tlibnss3 \\", ""),
				"browser: runtime stage omits libnss3",
			);
			await mutate(
				temporary,
				"scripts/browser-preflight.ts",
				(source) =>
					source.replace("await browser.close();", "await Promise.resolve();"),
				"browser: preflight omits browser close",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("renders browser implementation and wiring only for the selected capability", async () => {
		const temporary = await mkdtemp(
			resolve(tmpdir(), "devenv-browser-render-"),
		);
		try {
			const minimal = resolve(temporary, "minimal");
			const full = resolve(temporary, "full");
			await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: minimal,
			});
			await renderFixture({ root: ROOT, fixtureName: "full", output: full });

			const minimalPackage = await Bun.file(
				resolve(minimal, "package.json"),
			).json();
			expect(minimalPackage.scripts["browser:check"]).toBeUndefined();
			expect(minimalPackage.scripts["browser:preflight"]).toBeUndefined();
			for (const path of [
				"scripts/browser-preflight.ts",
				"scripts/template/browser-contract.ts",
				"scripts/template/validate-browser.ts",
			]) {
				expect(await Bun.file(resolve(minimal, path)).exists()).toBe(false);
				expect(await Bun.file(resolve(full, path)).exists()).toBe(true);
			}
			const minimalWorkflow = await Bun.file(
				resolve(minimal, ".github/workflows/ci.yml"),
			).text();
			expect(minimalWorkflow).not.toContain("browser:check");
			expect(minimalWorkflow).not.toContain("devenv-browser-ci");
			const fullWorkflow = await Bun.file(
				resolve(full, ".github/workflows/ci.yml"),
			).text();
			expect(fullWorkflow).toContain("bun run browser:check");
			expect(fullWorkflow).toContain("bun run browser:preflight");
			const fullDevcontainer = await Bun.file(
				resolve(full, ".devcontainer/devcontainer.json"),
			).json();
			expect(fullDevcontainer.build.target).toBe("development_browser");
			expect(fullDevcontainer.postCreateCommand.join(" ")).toContain(
				"bun run browser:preflight",
			);
			await copyFile(resolve(ROOT, "bun.lock"), resolve(full, "bun.lock"));
			expect(await validateBrowserContract(full)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("rejects unsupported preflight arguments before launching", () => {
		const process = Bun.spawnSync(
			["bun", "scripts/browser-preflight.ts", "--known-bad"],
			{
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(process.exitCode).toBe(2);
		expect(process.stderr.toString()).toContain(
			"Usage: bun scripts/browser-preflight.ts [--quiet]",
		);
	});
});
