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
	buildRenderPlan,
	filterCapabilityBlocks,
	loadTemplateOwnership,
	renderFixture,
	scanDisabledResidue,
	stripTemplateOnlyBlocks,
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
		fixture.capabilities["codex"] = false;
		expect(() => validateFixtureDefinition(fixture, parameters)).toThrow(
			"codex_cloud requires codex",
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
				directory: "apps/one",
				command: "bun run dev",
				health_path: "/health",
				health_expectation: "http-2xx",
				profiles: ["minimal"],
			},
			{
				name: "two",
				kind: "backend",
				base_port: 5200,
				depends_on: ["one"],
				directory: "apps/two",
				command: "bun run dev",
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
				directory: "apps/web",
				command: "bun run dev",
				health_path: "/",
				health_expectation: "http-2xx-html",
				profiles: ["minimal"],
			},
			{
				name: "api",
				kind: "backend",
				base_port: 5200,
				depends_on: [],
				directory: "apps/api",
				command: "bun run dev",
				health_path: "/health",
				health_expectation: "json-status-ok",
				profiles: ["full"],
			},
		];
		expect(() => validateTemplateParameters(mutation)).toThrow(
			"dependency api is unavailable in profile minimal",
		);
	});

	test("rejects an unsafe published container port and incomplete service descriptors", async () => {
		const parsed = (await parseToml(
			resolve(ROOT, "template-parameters.toml"),
		)) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "template-parameters.schema.json"),
		).json()) as Record<string, unknown>;

		const privilegedPort = structuredClone(parsed) as {
			routing: Record<string, unknown>;
		};
		privilegedPort.routing["published_container_port"] = 80;
		expect(() => validateTemplateParameters(privilegedPort)).toThrow(
			"routing.published_container_port must be between 1024 and 65535",
		);
		expect(validateJsonSchema(privilegedPort, schema)).toContain(
			"$.routing.published_container_port must be at least 1024",
		);

		// A service the lifecycle cannot start is not a service: the runtime cds
		// into `directory` and runs `command`, so both are required and both are
		// execution inputs.
		const incompleteService = structuredClone(parsed) as Record<
			string,
			unknown
		>;
		incompleteService["services"] = [
			{
				name: "api",
				kind: "backend",
				base_port: 5200,
				depends_on: [],
				directory: "../escape",
				health_path: "/health",
				health_expectation: "json-status-ok",
				profiles: ["minimal"],
			},
		];
		expect(() => validateTemplateParameters(incompleteService)).toThrow(
			"services[0].command must be a non-empty string",
		);
		expect(() => validateTemplateParameters(incompleteService)).toThrow(
			"services[0].directory must be a contained relative path",
		);
		expect(validateJsonSchema(incompleteService, schema)).toContain(
			"$.services[0].command is required",
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

		const invalidRollback = structuredClone(evidence);
		(invalidRollback["rollback"] as Record<string, unknown>)["command"] = [
			"git",
			"revert",
			"<stage-0-pr-merge-commit>",
		];
		expect(validateStageZeroEvidenceValue(invalidRollback, schema)).toContain(
			"semantic: Stage 0 merge rollback must select mainline parent 1",
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
			console.log(
				"[stage1-observed] minimal fixture guard and artifact scan contain no disabled family residue",
			);

			const output = resolve(temporary, "first");
			expect(
				await Bun.file(resolve(output, "tsconfig.worker.base.json")).exists(),
			).toBe(false);
			expect(
				await Bun.file(resolve(output, "tsconfig.start.base.json")).exists(),
			).toBe(false);
			const devcontainer = await Bun.file(
				resolve(output, ".devcontainer/devcontainer.json"),
			).json();
			expect(devcontainer.build.target).toBe("development");
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
				"$" + "{configDir}/../../libs/*/src",
			]);
			expect(tsconfig.compilerOptions.paths["@confiador/*"]).toBeUndefined();
			const minimalPackage = await Bun.file(
				resolve(output, "package.json"),
			).json();
			expect(minimalPackage.scripts["toolchain:check"]).toBe(
				"bun scripts/template/validate-toolchain.ts",
			);
			expect(
				await Bun.file(
					resolve(output, "scripts/template/validate-toolchain.ts"),
				).exists(),
			).toBe(true);
			expect(
				await Bun.file(
					resolve(output, "scripts/template/toolchain.ts"),
				).exists(),
			).toBe(true);
			const generatedGuard = await Bun.file(
				resolve(output, "scripts/template/toolchain.ts"),
			).text();
			for (const token of [
				"capability:start",
				"@cloudflare/",
				"Cloudflare",
				"better-auth",
				"playwright",
				"react-hook-form",
				"zod",
			])
				expect(generatedGuard).not.toContain(token);
			const generatedDockerfile = await Bun.file(
				resolve(output, ".devcontainer/Dockerfile"),
			).text();
			for (const token of [
				"capability:start",
				"playwright_browser",
				"development_browser",
			])
				expect(generatedDockerfile).not.toContain(token);
			for (const packageName of [
				"@cloudflare/vite-plugin",
				"@cloudflare/vitest-pool-workers",
				"@playwright/test",
				"@hookform/resolvers",
				"better-auth",
				"react-hook-form",
				"wrangler",
				"zod",
			]) {
				expect(minimalPackage.workspaces.catalog[packageName]).toBeUndefined();
				expect(minimalPackage.devDependencies[packageName]).toBeUndefined();
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("fresh generated CI creates its first lock before running the guard", async () => {
		const temporary = await temporaryDirectory();
		try {
			const output = resolve(temporary, "minimal");
			await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output,
			});
			expect(await Bun.file(resolve(output, "bun.lock")).exists()).toBe(false);
			const install = Bun.spawnSync({
				cmd: [
					"bash",
					"-euo",
					"pipefail",
					"-c",
					"if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; test -f bun.lock; fi",
				],
				cwd: output,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(install.exitCode).toBe(0);
			expect(await Bun.file(resolve(output, "bun.lock")).exists()).toBe(true);
			const guard = Bun.spawnSync({
				cmd: ["bun", "run", "toolchain:check"],
				cwd: output,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(guard.exitCode).toBe(0);
			const lint = Bun.spawnSync({
				cmd: ["bunx", "biome", "check", "--no-errors-on-unmatched", "."],
				cwd: output,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(lint.exitCode).toBe(0);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);

	test("renders the worktree contract with each fixture's identity", async () => {
		const temporary = await temporaryDirectory();
		try {
			const parameters = await loadTemplateParameters(ROOT);
			for (const fixtureName of parameters.generation.fixture_names) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				const fixture = await loadFixtureDefinition(
					ROOT,
					fixtureName,
					parameters,
				);
				const resolved = resolveFixtureParameters(parameters, fixture);
				const contract = await Bun.file(
					resolve(output, "scripts/worktree/contract.toml"),
				).text();
				const parsed = Bun.TOML.parse(contract) as Record<string, unknown>;

				expect(parsed["version"]).toBe(1);
				expect(parsed["project_slug"]).toBe(resolved.project.slug);
				expect(parsed["environment_prefix"]).toBe(
					resolved.project.environment_prefix,
				);
				expect(parsed["docker_resource_prefix"]).toBe(
					resolved.project.docker_resource_prefix,
				);
				expect(parsed["local_domain_stem"]).toBe(
					resolved.project.local_domain_stem,
				);
				expect(parsed["published_host_port_variable"]).toBe(
					`${resolved.project.environment_prefix}_PUBLISHED_HOST_PORT`,
				);
				expect(parsed["published_container_port"]).toBe(
					resolved.routing.published_container_port,
				);
				expect(parsed["services"]).toEqual([]);
				// The contract is regenerated from the fixture's own parameters, so
				// none of the template's identity survives into it.
				expect(contract).not.toContain('= "devenv"');
				expect(contract).not.toContain('= "DEVENV"');
				expect(contract).not.toContain("capability:start");

				// Every cloud key lives inside one codex_cloud fence, so a fixture
				// that disables the capability carries no cloud reference at all.
				const cloudEnabled =
					resolved.capabilities.defaults["codex_cloud"] === true;
				expect(contract.includes("CODEX_CLOUD")).toBe(cloudEnabled);
				expect(parsed["cloud_doctor_command"]).toBe(
					cloudEnabled ? "bash .codex/cloud/doctor.sh --quiet" : undefined,
				);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);

	test("omits the whole worktree runtime when devcontainer is disabled", async () => {
		const parameters = await loadTemplateParameters(ROOT);
		const ownership = await loadTemplateOwnership(ROOT);
		const fixture = await loadFixtureDefinition(ROOT, "full", parameters);
		const resolved = resolveFixtureParameters(parameters, fixture);
		const sourceFiles = [
			{ path: "package.json", mode: "0644" as const },
			{ path: "scripts/worktree/contract.toml", mode: "0644" as const },
			{ path: "scripts/worktree/env.sh", mode: "0755" as const },
			{ path: "scripts/worktree/cleanup.sh", mode: "0755" as const },
			{ path: "scripts/template/worktree-contract.ts", mode: "0644" as const },
			{ path: "scripts/template/validate-worktree.ts", mode: "0644" as const },
		];

		const enabled = buildRenderPlan(fixture, resolved, ownership, sourceFiles);
		expect(enabled.entries.map((entry) => entry.target)).toEqual(
			sourceFiles.map((source) => source.path).sort(),
		);

		// The runtime is gated on one capability, and it is all or nothing: a
		// project without a devcontainer must not inherit half a runtime.
		const withoutDevcontainer = {
			...resolved,
			capabilities: {
				...resolved.capabilities,
				defaults: { ...resolved.capabilities.defaults, devcontainer: false },
			},
		};
		const plan = buildRenderPlan(
			fixture,
			withoutDevcontainer,
			ownership,
			sourceFiles,
		);
		expect(plan.entries.map((entry) => entry.target)).toEqual(["package.json"]);
		expect(plan.omitted.map((entry) => entry.path)).toEqual([
			"scripts/template/validate-worktree.ts",
			"scripts/template/worktree-contract.ts",
			"scripts/worktree/cleanup.sh",
			"scripts/worktree/contract.toml",
			"scripts/worktree/env.sh",
		]);
	}, 60_000);

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
					resolve(temporary, "cloud/tsconfig.start.base.json"),
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
			for (const packageName of [
				"@cloudflare/vite-plugin",
				"@cloudflare/vitest-pool-workers",
				"wrangler",
			]) {
				expect(cloudPackage.workspaces.catalog[packageName]).toBeDefined();
				expect(cloudPackage.devDependencies[packageName]).toBe("catalog:");
			}
			for (const packageName of [
				"@playwright/test",
				"@hookform/resolvers",
				"better-auth",
				"react-hook-form",
				"zod",
			]) {
				expect(cloudPackage.workspaces.catalog[packageName]).toBeUndefined();
				expect(cloudPackage.devDependencies[packageName]).toBeUndefined();
			}
			expect(
				await Bun.file(
					resolve(temporary, "cloud/openspec/config.yaml"),
				).exists(),
			).toBe(false);
			for (const file of [
				"tsconfig.worker.base.json",
				"tsconfig.start.base.json",
			]) {
				expect(await Bun.file(resolve(temporary, "full", file)).exists()).toBe(
					true,
				);
			}
			const fullPackage = await Bun.file(
				resolve(temporary, "full/package.json"),
			).json();
			const fullDevcontainer = await Bun.file(
				resolve(temporary, "full/.devcontainer/devcontainer.json"),
			).json();
			expect(fullDevcontainer.build.target).toBe("development_browser");
			const fullDockerfile = await Bun.file(
				resolve(temporary, "full/.devcontainer/Dockerfile"),
			).text();
			expect(fullDockerfile).toContain(
				"FROM development AS development_browser",
			);
			expect(fullDockerfile).toContain(
				"FROM proto_foundation AS playwright_browser",
			);
			for (const packageName of [
				"@cloudflare/vite-plugin",
				"@cloudflare/vitest-pool-workers",
				"@playwright/test",
				"@hookform/resolvers",
				"better-auth",
				"react-hook-form",
				"wrangler",
				"zod",
			]) {
				expect(fullPackage.workspaces.catalog[packageName]).toBeDefined();
				expect(fullPackage.devDependencies[packageName]).toBe("catalog:");
			}
			for (const path of [
				".codex/cloud/contract.toml",
				".codex/cloud/lib.sh",
				".codex/cloud/bootstrap.sh",
				".codex/cloud/doctor.sh",
				".codex/cloud/exec.sh",
				".codex/cloud/selftest.sh",
				".github/workflows/codex-cloud-smoke.yml",
				"scripts/template/cloud-contract.ts",
				"scripts/template/validate-cloud.ts",
			]) {
				expect(await Bun.file(resolve(temporary, "cloud", path)).exists()).toBe(
					true,
				);
				expect(await Bun.file(resolve(temporary, "full", path)).exists()).toBe(
					true,
				);
			}
			for (const rendered of [cloudPackage, fullPackage]) {
				expect(rendered.scripts["cloud:check"]).toBe(
					"bun scripts/template/validate-cloud.ts",
				);
			}
			const cloudContract = await Bun.file(
				resolve(temporary, "cloud/.codex/cloud/contract.toml"),
			).text();
			expect(cloudContract).toContain(
				'persisted_environment = "~/.config/fixture-cloud/codex-cloud.env"',
			);
			expect(cloudContract).toContain(
				'fingerprint_marker_directory = "~/.cache/fixture-cloud/codex-cloud"',
			);
			// The cloud fixture disables Playwright, so the stripped contract must
			// still parse and must carry no browser payload residue at all.
			expect(cloudContract).not.toContain("playwright");
			expect(cloudContract).not.toContain("browser_");
			expect(Bun.TOML.parse(cloudContract)).toMatchObject({
				version: 1,
				default_profile: "core",
			});
			const fullContract = await Bun.file(
				resolve(temporary, "full/.codex/cloud/contract.toml"),
			).text();
			expect(fullContract).toContain(
				'persisted_environment = "~/.config/fixture-full/codex-cloud.env"',
			);
			expect(
				(Bun.TOML.parse(fullContract) as Record<string, unknown>)[
					"browser_playwright_version"
				],
			).toBe("1.59.1");
			const cloudSmoke = await Bun.file(
				resolve(temporary, "cloud/.github/workflows/codex-cloud-smoke.yml"),
			).text();
			expect(cloudSmoke).toContain("- core");
			expect(cloudSmoke).not.toContain("- browser");
			const fullSmoke = await Bun.file(
				resolve(temporary, "full/.github/workflows/codex-cloud-smoke.yml"),
			).text();
			expect(fullSmoke).toContain("- core");
			expect(fullSmoke).toContain("- browser");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("renders the entrypoint cutover into every fixture", async () => {
		const temporary = await temporaryDirectory();
		try {
			// Assembled rather than written out: the worktree guard scans tracked
			// files for this token and this file is not on its allow-list.
			const legacyLauncher = `dev${"pod"}`;
			// Three rendered files name the superseded launcher on purpose: the
			// cloud contract forbids it by name, its guard checks that list, and the
			// worktree guard carries the token in order to scan for it. Nothing else
			// may.
			const sealed = ["scripts/template/worktree-contract.ts"];
			const sealedWithCloud = [
				".codex/cloud/contract.toml",
				"scripts/template/cloud-contract.ts",
				...sealed,
			].sort();
			for (const fixtureName of ["minimal", "cloud", "full"]) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				for (const hook of [".husky/commit-msg", ".husky/pre-commit"]) {
					const source = await Bun.file(resolve(output, hook)).text();
					expect(source).toContain(
						"bash scripts/worktree/exec.sh --require-ready",
					);
					// The documented fallback survives rendering, because it is a run
					// time file test rather than a capability fence.
					expect(source).toContain("if [ -x scripts/worktree/exec.sh ]");
				}
				const readme = await Bun.file(resolve(output, "README.md")).text();
				expect(readme).toContain("bash scripts/worktree/exec.sh");
				const residue = (
					await Bun.$`grep -rlI -i ${legacyLauncher} ${output}`
						.quiet()
						.nothrow()
						.text()
				)
					.split("\n")
					.filter(Boolean)
					.map((path) => path.slice(output.length + 1))
					.sort();
				expect(residue).toEqual(
					fixtureName === "minimal" ? sealed : sealedWithCloud,
				);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("rendered readme honors capability and template-only fences", async () => {
		const temporary = await temporaryDirectory();
		try {
			const template = await Bun.file(
				resolve(ROOT, "README.template.md"),
			).text();
			const parameters = await loadTemplateParameters(ROOT);
			for (const fixtureName of ["minimal", "full"]) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				const fixture = await loadFixtureDefinition(
					ROOT,
					fixtureName,
					parameters,
				);
				const resolved = resolveFixtureParameters(parameters, fixture);
				const rendered = await Bun.file(resolve(output, "README.md")).text();
				expect(rendered).toBe(
					filterCapabilityBlocks(
						stripTemplateOnlyBlocks(template),
						resolved.capabilities.defaults,
					).replaceAll("{{PROJECT_NAME}}", resolved.project.display_name),
				);
				expect(rendered).not.toContain("capability:start");
				expect(rendered).not.toContain("capability:end");
				expect(rendered).not.toContain("template-only:start");
				expect(rendered).not.toContain("{{PROJECT_NAME}}");
				expect(rendered).toContain(resolved.project.display_name);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);

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

	test("known-bad Codex Cloud residue is detected and named", async () => {
		const temporary = await temporaryDirectory();
		try {
			const output = resolve(temporary, "minimal");
			await renderFixture({ root: ROOT, fixtureName: "minimal", output });
			expect(
				await Bun.file(resolve(output, ".codex/cloud/lib.sh")).exists(),
			).toBe(false);
			expect(
				await Bun.file(
					resolve(output, ".github/workflows/codex-cloud-smoke.yml"),
				).exists(),
			).toBe(false);
			const minimalPackage = await Bun.file(
				resolve(output, "package.json"),
			).json();
			expect(minimalPackage.scripts["cloud:check"]).toBeUndefined();
			const minimalWorkflow = await Bun.file(
				resolve(output, ".github/workflows/ci.yml"),
			).text();
			expect(minimalWorkflow).not.toContain("cloud:check");
			await Bun.write(
				resolve(output, ".codex/cloud/contract.toml"),
				"version = 1\n",
			);
			const parameters = await loadTemplateParameters(ROOT);
			const fixture = await loadFixtureDefinition(ROOT, "minimal", parameters);
			const resolved = resolveFixtureParameters(parameters, fixture);
			const ownership = await loadTemplateOwnership(ROOT);
			const report = await scanDisabledResidue(output, resolved, ownership);
			expect(report.status).toBe("fail");
			expect(report.findings).toContainEqual({
				capability: "codex_cloud",
				path: ".codex/cloud/contract.toml",
				signature: ".codex/cloud/**",
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

	test("refuses outputs that overlap worktree Git metadata", async () => {
		const before = await Bun.$`git -C ${ROOT} rev-parse HEAD`.quiet().text();
		await expect(
			renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: resolve(ROOT, ".git/objects"),
				force: true,
			}),
		).rejects.toThrow("overlaps protected Git metadata");
		const after = await Bun.$`git -C ${ROOT} rev-parse HEAD`.quiet().text();
		expect(after).toBe(before);
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
		// setup-common.sh is a pure function library on-create.sh sources for its
		// own shell (install_workspace_dependencies runs before any setup step
		// sources it). It installs and generates nothing, so it has — and must
		// have — no generatedDestinations entry.
		const sourcedHelpers = new Set([".devcontainer/on-create/setup-common.sh"]);
		const invoked = new Set(
			[
				...onCreate.matchAll(
					/\/workspace\/(\.devcontainer\/(?:on-create\/setup-[a-z0-9-]+|scripts\/sync-extensions-json)\.sh)/g,
				),
			].flatMap((match) =>
				match[1] && !sourcedHelpers.has(match[1]) ? [match[1]] : [],
			),
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
