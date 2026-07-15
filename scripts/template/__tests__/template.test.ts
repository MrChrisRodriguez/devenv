import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	activeRuntimePathChanges,
	validateStageZeroEvidenceValue,
} from "../evidence";
import { validateJsonSchema } from "../json-schema";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	parseToml,
	resolveFixtureParameters,
	validateFixtureDefinition,
	validateTemplateParameters,
} from "../parameters";
import {
	loadTemplateOwnership,
	renderFixture,
	scanDisabledResidue,
} from "../render-fixture";
import { validateAll } from "../validate";

const ROOT = resolve(import.meta.dir, "../../..");

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(resolve(tmpdir(), "devenv-stage0-"));
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

describe("template parameter registry", () => {
	test("validates the registry, schema JSON, and all fixture definitions", async () => {
		const report = await validateAll(ROOT);
		expect(report.status).toBe("pass");
		expect(report.fixtures.map(({ name, status }) => [name, status])).toEqual([
			["minimal", "pass"],
			["cloud", "pass"],
			["full", "pass"],
		]);
		expect(
			await Bun.file(resolve(ROOT, "template-parameters.schema.json")).json(),
		).toBeObject();
	});

	test("rejects registry values through the committed JSON Schema", async () => {
		const parsed = (await parseToml(
			resolve(ROOT, "template-parameters.toml"),
		)) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "template-parameters.schema.json"),
		).json()) as Record<string, unknown>;
		const invalid = structuredClone(parsed) as {
			project: Record<string, unknown>;
			container: Record<string, unknown>;
		};
		delete invalid.project["slug"];
		invalid.container["supported_architectures"] = ["arm64", "arm64"];
		const errors = validateJsonSchema(invalid, schema);
		expect(errors).toContain("$.project.slug is required");
		expect(errors).toContain(
			"$.container.supported_architectures must contain unique items",
		);
	});

	test("authoritative parameter loading cannot bypass JSON Schema validation", async () => {
		const temporary = await temporaryDirectory();
		try {
			const source = await Bun.file(
				resolve(ROOT, "template-parameters.toml"),
			).text();
			await Bun.write(
				resolve(temporary, "template-parameters.toml"),
				source.replace(
					'proto_manifest = ".prototools"',
					'proto_manifest = "../../attacker.toml"',
				),
			);
			await Bun.write(
				resolve(temporary, "template-parameters.schema.json"),
				Bun.file(resolve(ROOT, "template-parameters.schema.json")),
			);
			await expect(loadTemplateParameters(temporary)).rejects.toThrow(
				'$.toolchain.proto_manifest must equal ".prototools"',
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("rejects unknown fields, unsafe paths, and capability dependency drift", async () => {
		const parsed = (await parseToml(
			resolve(ROOT, "template-parameters.toml"),
		)) as Record<string, unknown>;
		const unsafe = structuredClone(parsed) as {
			paths: Record<string, unknown>;
			ci: Record<string, unknown>;
		};
		unsafe.paths["generated_state"] = "../escape";
		unsafe.paths["common_secrets"] = "../../etc/passwd\nBAD";
		unsafe.ci["unrecognized"] = true;
		expect(() => validateTemplateParameters(unsafe)).toThrow("ci.unrecognized");
		expect(() => validateTemplateParameters(unsafe)).toThrow(
			"contained relative path",
		);
		expect(() => validateTemplateParameters(unsafe)).toThrow(
			"normalized contained home path",
		);

		const parameters = await loadTemplateParameters(ROOT);
		const fixture = (await parseToml(
			resolve(ROOT, "fixtures/template/full.toml"),
		)) as {
			capabilities: Record<string, boolean>;
		};
		fixture.capabilities["moon"] = false;
		expect(() => validateFixtureDefinition(fixture, parameters)).toThrow(
			"moon_affected_selection requires moon",
		);
	});

	test("rejects duplicate and cyclic service definitions", async () => {
		const parsed = (await parseToml(
			resolve(ROOT, "template-parameters.toml"),
		)) as Record<string, unknown>;
		const mutation = structuredClone(parsed) as Record<string, unknown>;
		mutation["services"] = [
			{
				name: "one",
				kind: "backend",
				base_port: 5100,
				depends_on: ["two", "two"],
				health_path: "/health",
				health_expectation: "http-2xx",
				profiles: ["minimal"],
			},
			{
				name: "two",
				kind: "backend",
				base_port: 5200,
				depends_on: ["one"],
				health_path: "/health",
				health_expectation: "http-2xx",
				profiles: ["minimal"],
			},
		];
		expect(() => validateTemplateParameters(mutation)).toThrow(
			"cannot contain duplicates",
		);
		expect(() => validateTemplateParameters(mutation)).toThrow(
			"dependency cycle",
		);
	});

	test("rejects service dependencies unavailable in a dependent profile", async () => {
		const parsed = (await parseToml(
			resolve(ROOT, "template-parameters.toml"),
		)) as Record<string, unknown>;
		const mutation = structuredClone(parsed) as Record<string, unknown>;
		mutation["services"] = [
			{
				name: "web",
				kind: "frontend",
				base_port: 5100,
				depends_on: ["api"],
				health_path: "/",
				health_expectation: "http-2xx-html",
				profiles: ["minimal"],
			},
			{
				name: "api",
				kind: "backend",
				base_port: 5200,
				depends_on: [],
				health_path: "/health",
				health_expectation: "json-status-ok",
				profiles: ["full"],
			},
		];
		expect(() => validateTemplateParameters(mutation)).toThrow(
			"dependency api is unavailable in profile minimal",
		);
	});

	test("rejects a fixture whose embedded identity differs from its filename", async () => {
		const temporary = await temporaryDirectory();
		try {
			await mkdir(resolve(temporary, "fixtures/template"), { recursive: true });
			const source = await Bun.file(
				resolve(ROOT, "fixtures/template/minimal.toml"),
			).text();
			await Bun.write(
				resolve(temporary, "fixtures/template/minimal.toml"),
				source.replace('name = "minimal"', 'name = "full"'),
			);
			const parameters = await loadTemplateParameters(ROOT);
			await expect(
				loadFixtureDefinition(temporary, "minimal", parameters),
			).rejects.toThrow("fixture minimal declares mismatched name full");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("stage zero evidence", () => {
	test("validates the measured record and rejects vacuous mutations", async () => {
		const evidence = (await Bun.file(
			resolve(ROOT, "evidence/stage-0-baseline.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-0-baseline.schema.json"),
		).json()) as Record<string, unknown>;
		expect(validateStageZeroEvidenceValue(evidence, schema)).toEqual([]);

		const missingMeasurement = structuredClone(evidence);
		delete (missingMeasurement["measurements"] as Record<string, unknown>)[
			"cleanImageBuild"
		];
		expect(
			validateStageZeroEvidenceValue(missingMeasurement, schema),
		).toContain("schema: $.measurements.cleanImageBuild is required");

		const emptyEnvironment = structuredClone(evidence);
		(emptyEnvironment["environment"] as Record<string, unknown>)["tools"] = [];
		const errors = validateStageZeroEvidenceValue(emptyEnvironment, schema);
		expect(errors).toContain(
			"schema: $.environment.tools must contain at least 10 items",
		);
		expect(errors).toContain("semantic: missing tool bun");

		const emptyLatency = structuredClone(evidence);
		(
			(emptyLatency["measurements"] as Record<string, unknown>)[
				"failedLifecycleExecLatency"
			] as Record<string, unknown>
		)["value"] = {};
		expect(validateStageZeroEvidenceValue(emptyLatency, schema)).toContain(
			"semantic: failed-lifecycle latency samples are vacuous",
		);
		expect(
			activeRuntimePathChanges([
				"scripts/template/evidence.ts",
				".devcontainer/Dockerfile",
				".prototools",
			]),
		).toEqual([".devcontainer/Dockerfile", ".prototools"]);
	});
});

describe("deterministic fixture renderer", () => {
	test("renders minimal twice with identical manifests and no disabled residue", async () => {
		const temporary = await temporaryDirectory();
		try {
			const first = await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: resolve(temporary, "first"),
			});
			const second = await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: resolve(temporary, "second"),
			});
			expect(first.manifest).toEqual(second.manifest);
			expect(first.residue.status).toBe("pass");
			expect(first.residue.scannedFiles).toBeGreaterThan(0);
			expect(first.residue.scannedDisabledCapabilities).toBeGreaterThan(0);

			const output = resolve(temporary, "first");
			expect(
				await Bun.file(resolve(output, "tsconfig.worker.base.json")).exists(),
			).toBe(false);
			expect(
				await Bun.file(resolve(output, "tsconfig.start.base.json")).exists(),
			).toBe(false);
			expect(
				await Bun.file(
					resolve(output, "tsconfig.stagehand.base.json"),
				).exists(),
			).toBe(false);
			const devcontainer = await Bun.file(
				resolve(output, ".devcontainer/devcontainer.json"),
			).json();
			expect(devcontainer.forwardPorts).toEqual([3000, 4000, 8080]);
			expect(
				devcontainer.customizations.vscode.extensions.includes(
					"cloudflare.vscode-cloudflare-workers",
				),
			).toBe(false);
			const packageJson = await Bun.file(
				resolve(output, "package.json"),
			).json();
			expect(packageJson.name).toBe("fixture-minimal");
			expect(
				Object.keys(packageJson.scripts).some((name) =>
					name.startsWith("template:"),
				),
			).toBe(false);
			const workflow = await Bun.file(
				resolve(output, ".github/workflows/ci.yml"),
			).text();
			expect(workflow).not.toContain("template-only:");
			expect(workflow).not.toContain("template:validate");
			const generatedScripts = packageJson.scripts as Record<string, string>;
			for (const match of workflow.matchAll(/\bbun run ([a-z0-9:_-]+)/g)) {
				expect(generatedScripts[match[1] ?? ""]).toBeString();
			}
			for (const path of [
				".cursor/mcp.json",
				".claude/settings.json",
				".devcontainer/on-create/setup-claude.sh",
				".devcontainer/secrets.example",
				".devcontainer/devcontainer.json",
			]) {
				expect(
					(await Bun.file(resolve(output, path)).text()).toLowerCase(),
				).not.toContain("context7");
			}
			const tsconfig = await Bun.file(
				resolve(output, "tsconfig.base.json"),
			).json();
			expect(tsconfig.compilerOptions.paths["@fixture-minimal/*"]).toEqual([
				"libs/*/src",
			]);
			expect(tsconfig.compilerOptions.paths["@confiador/*"]).toBeUndefined();
			const link = resolve(
				output,
				".cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc",
			);
			expect((await lstat(link)).isSymbolicLink()).toBe(true);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("renders cloud and full profiles with only their selected artifacts", async () => {
		const temporary = await temporaryDirectory();
		try {
			await renderFixture({
				root: ROOT,
				fixtureName: "cloud",
				output: resolve(temporary, "cloud"),
			});
			await renderFixture({
				root: ROOT,
				fixtureName: "full",
				output: resolve(temporary, "full"),
			});
			const cloudDevcontainer = await Bun.file(
				resolve(temporary, "cloud/.devcontainer/devcontainer.json"),
			).json();
			expect(cloudDevcontainer.forwardPorts).toContain(8787);
			expect(
				await Bun.file(
					resolve(temporary, "cloud/tsconfig.worker.base.json"),
				).exists(),
			).toBe(true);
			expect(
				await Bun.file(
					resolve(temporary, "cloud/tsconfig.stagehand.base.json"),
				).exists(),
			).toBe(false);
			const cloudPackage = await Bun.file(
				resolve(temporary, "cloud/package.json"),
			).json();
			expect(
				cloudPackage.workspaces.catalog["@fission-ai/openspec"],
			).toBeUndefined();
			expect(
				cloudPackage.devDependencies["@fission-ai/openspec"],
			).toBeUndefined();
			expect(
				await Bun.file(
					resolve(temporary, "cloud/openspec/config.yaml"),
				).exists(),
			).toBe(false);
			for (const file of [
				"tsconfig.worker.base.json",
				"tsconfig.stagehand.base.json",
				"tsconfig.start.base.json",
			]) {
				expect(await Bun.file(resolve(temporary, "full", file)).exists()).toBe(
					true,
				);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("known-bad capability residue is detected and named", async () => {
		const temporary = await temporaryDirectory();
		try {
			const output = resolve(temporary, "minimal");
			await renderFixture({ root: ROOT, fixtureName: "minimal", output });
			await Bun.write(resolve(output, "wrangler.toml"), 'name = "known-bad"\n');
			const parameters = await loadTemplateParameters(ROOT);
			const fixture = await loadFixtureDefinition(ROOT, "minimal", parameters);
			const resolved = resolveFixtureParameters(parameters, fixture);
			const ownership = await loadTemplateOwnership(ROOT);
			const report = await scanDisabledResidue(output, resolved, ownership);
			expect(report.status).toBe("fail");
			expect(report.findings).toContainEqual({
				capability: "cloudflare_workers",
				path: "wrangler.toml",
				signature: "wrangler.toml",
				kind: "path",
			});
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("full fixture still rejects global source identity residue", async () => {
		const temporary = await temporaryDirectory();
		try {
			const output = resolve(temporary, "full");
			await renderFixture({ root: ROOT, fixtureName: "full", output });
			await Bun.write(resolve(output, "source-residue.txt"), "trading-games\n");
			const parameters = await loadTemplateParameters(ROOT);
			const fixture = await loadFixtureDefinition(ROOT, "full", parameters);
			const resolved = resolveFixtureParameters(parameters, fixture);
			const ownership = await loadTemplateOwnership(ROOT);
			const report = await scanDisabledResidue(output, resolved, ownership);
			expect(report.status).toBe("fail");
			expect(report.findings).toContainEqual({
				capability: "global",
				path: "source-residue.txt",
				signature: "trading-games",
				kind: "token",
			});
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("invalid fixture input fails before creating output", async () => {
		const temporary = await temporaryDirectory();
		try {
			const output = resolve(temporary, "not-written");
			await expect(
				renderFixture({ root: ROOT, fixtureName: "unknown", output }),
			).rejects.toThrow("unknown fixture");
			expect(await Bun.file(output).exists()).toBe(false);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses output paths that contain tracked template sources", async () => {
		await expect(
			renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: resolve(ROOT, "scripts"),
				force: true,
			}),
		).rejects.toThrow("contains tracked template sources");
		expect(
			await Bun.file(resolve(ROOT, "scripts/template/parameters.ts")).exists(),
		).toBe(true);
	});

	test("canonicalizes output aliases before protecting tracked sources", async () => {
		const temporary = await temporaryDirectory();
		try {
			const alias = resolve(temporary, "template-alias");
			await symlink(ROOT, alias, "dir");
			await expect(
				renderFixture({
					root: ROOT,
					fixtureName: "minimal",
					output: resolve(alias, "scripts"),
					force: true,
				}),
			).rejects.toThrow("contains tracked template sources");
			expect(
				await Bun.file(
					resolve(ROOT, "scripts/template/parameters.ts"),
				).exists(),
			).toBe(true);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("ownership and generated paths", () => {
	test("every recorded generator source and local generator exists", async () => {
		const inventory = (await Bun.file(
			resolve(
				ROOT,
				"docs/devcontainer-upgrade/stage-0/template-ownership.json",
			),
		).json()) as {
			generatedDestinations: Array<{ source: string; generator: string }>;
		};
		expect(inventory.generatedDestinations.length).toBeGreaterThan(0);
		for (const destination of inventory.generatedDestinations) {
			const sourcePath = destination.source.split("#")[0];
			if (sourcePath?.startsWith(".")) {
				expect(await exists(resolve(ROOT, sourcePath))).toBe(true);
			}
			if (destination.generator.startsWith(".")) {
				expect(await exists(resolve(ROOT, destination.generator))).toBe(true);
			}
		}

		const generators = new Set(
			inventory.generatedDestinations.map(({ generator }) => generator),
		);
		const onCreate = await Bun.file(
			resolve(ROOT, ".devcontainer/on-create.sh"),
		).text();
		const invoked = new Set(
			[
				...onCreate.matchAll(
					/\/workspace\/(\.devcontainer\/(?:on-create\/setup-[a-z0-9-]+|scripts\/sync-extensions-json)\.sh)/g,
				),
			].flatMap((match) => (match[1] ? [match[1]] : [])),
		);
		const devcontainerSource = await Bun.file(
			resolve(ROOT, ".devcontainer/devcontainer.json"),
		).text();
		for (const match of devcontainerSource.matchAll(
			/(\.devcontainer\/host\/[a-z0-9-]+\.sh)/g,
		)) {
			if (match[1]) invoked.add(match[1]);
		}
		for (const generator of invoked)
			expect(generators.has(generator)).toBe(true);
	});

	test("legacy initializer still produces a committed downstream project", async () => {
		const temporary = await temporaryDirectory();
		try {
			const checkout = resolve(temporary, "checkout");
			await Bun.$`mkdir -p ${checkout}`.quiet();
			await Bun.$`git -C ${ROOT} checkout-index --all --prefix=${`${checkout}/`}`.quiet();
			await Bun.$`git -C ${checkout} init --quiet`.quiet();
			await Bun.$`git -C ${checkout} config user.name "Stage Zero Fixture"`.quiet();
			await Bun.$`git -C ${checkout} config user.email stage-zero@example.invalid`.quiet();
			await Bun.$`git -C ${checkout} add .`.quiet();
			await Bun.$`git -C ${checkout} commit --quiet -m "template source"`.quiet();
			await Bun.$`git -C ${checkout} remote add origin https://example.invalid/template.git`.quiet();
			const process = Bun.spawnSync(["bash", "init-new-project.sh"], {
				cwd: checkout,
				env: {
					...Bun.env,
					GIT_AUTHOR_NAME: "Stage Zero Fixture",
					GIT_AUTHOR_EMAIL: "stage-zero@example.invalid",
					GIT_COMMITTER_NAME: "Stage Zero Fixture",
					GIT_COMMITTER_EMAIL: "stage-zero@example.invalid",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			if (process.exitCode !== 0) {
				throw new Error(new TextDecoder().decode(process.stderr));
			}
			expect(await Bun.file(resolve(checkout, "README.md")).exists()).toBe(
				true,
			);
			expect(
				await Bun.file(resolve(checkout, "README.template.md")).exists(),
			).toBe(false);
			expect(
				await Bun.file(resolve(checkout, "init-new-project.sh")).exists(),
			).toBe(false);
			expect(await Bun.file(resolve(checkout, "graphify-out")).exists()).toBe(
				false,
			);
			const templateReference = await Bun.file(
				resolve(checkout, ".template-ref"),
			).text();
			expect(templateReference).toContain(
				"url=https://example.invalid/template.git",
			);
			expect(templateReference).toMatch(/ref=[0-9a-f]{40}/);
			expect(
				(
					await Bun.$`git -C ${checkout} status --porcelain`.quiet().text()
				).trim(),
			).toBe("");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
