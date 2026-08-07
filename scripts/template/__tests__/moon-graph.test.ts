// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures quote TypeScript path templates verbatim.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	planGeneratedConfigs,
	spliceGeneratedBlock,
	writeGeneratedConfigs,
} from "../generate-graph";
import {
	buildProjectGraph,
	classifyPath,
	compareDeclaredEdges,
	importSpecifiers,
	MOON_QUERY_ARGV,
	validateUniverseRegistry,
} from "../graph-contract";
import { renderFixture } from "../render-fixture";
import { reconcileWithMoon, validateGraphContract } from "../validate-graph";

const ROOT = resolve(import.meta.dir, "../../..");

interface ProjectFixture {
	/** Source directory, relative to the workspace root. */
	source: string;
	packageName?: string;
	dependencies?: Record<string, string>;
	/** Extra files, keyed by path relative to the project's source. */
	files?: Record<string, string>;
	/** moon.yml contents. Omit for a project with no committed config. */
	config?: string;
}

/**
 * Build a synthetic moon workspace on disk.
 *
 * The graph builder answers questions about a directory tree, so the only
 * honest fixture is a directory tree. Nothing here runs moon: the whole point
 * of the independent builder is that it reaches the same answer without it.
 */
async function workspace(options: {
	globs?: string[];
	sources?: Record<string, string>;
	defaultBranch?: string;
	aliasPrefix?: string;
	projects: ProjectFixture[];
}): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-graph-"));
	const globs = options.globs ?? ["apps/*", "libs/*"];
	const lines = [
		"projects:",
		"  globs:",
		...globs.map((glob) => `    - '${glob}'`),
	];
	const sources = options.sources ?? { root: "." };
	if (Object.keys(sources).length > 0) {
		lines.push("  sources:");
		for (const [id, source] of Object.entries(sources))
			lines.push(`    ${id}: '${source}'`);
	}
	lines.push("vcs:", `  defaultBranch: '${options.defaultBranch ?? "main"}'`);
	await mkdir(resolve(root, ".moon"), { recursive: true });
	await Bun.write(
		resolve(root, ".moon/workspace.yml"),
		`${lines.join("\n")}\n`,
	);
	await Bun.write(
		resolve(root, "tsconfig.base.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					paths: {
						[`${options.aliasPrefix ?? "@synthetic"}/*`]: [
							"${configDir}/../../libs/*/src",
						],
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);
	for (const project of options.projects) {
		const directory = resolve(root, project.source);
		await mkdir(directory, { recursive: true });
		if (project.packageName !== undefined) {
			await Bun.write(
				resolve(directory, "package.json"),
				`${JSON.stringify(
					{
						name: project.packageName,
						...(project.dependencies
							? { dependencies: project.dependencies }
							: {}),
					},
					null,
					"\t",
				)}\n`,
			);
		}
		if (project.config !== undefined)
			await Bun.write(resolve(directory, "moon.yml"), project.config);
		for (const [path, contents] of Object.entries(project.files ?? {})) {
			const target = resolve(directory, path);
			await mkdir(resolve(target, ".."), { recursive: true });
			await Bun.write(target, contents);
		}
	}
	return root;
}

function edgeKeys(edges: Array<{ from: string; to: string }>): string[] {
	return [...new Set(edges.map((edge) => `${edge.from}->${edge.to}`))].sort();
}

describe("moon project graph", () => {
	test("pins the verified moon query invocation", () => {
		// moon 2.3.5 rejects `--json` on this subcommand ("unexpected argument
		// '--json' found", exit 2) because the whole `query` family emits JSON by
		// definition. A guard that kept the flag would fail every run.
		expect([...MOON_QUERY_ARGV]).toEqual(["query", "projects"]);
	});

	test("derives a leaf project's edge from its manifest", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ui": "workspace:*" },
				},
			],
		});
		try {
			const graph = await buildProjectGraph(root);
			expect(graph.projects.map((project) => project.id).sort()).toEqual([
				"root",
				"ui",
				"web",
			]);
			expect(edgeKeys(graph.edges)).toEqual(["web->ui"]);
			expect(graph.defaultBranch).toBe("main");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fans one project out to every dependency it names", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{ source: "libs/data", packageName: "@synthetic/data" },
				{ source: "libs/auth", packageName: "@synthetic/auth" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: {
						"@synthetic/ui": "workspace:*",
						"@synthetic/data": "workspace:*",
					},
					files: {
						"src/index.ts": "import { session } from '@synthetic/auth';\n",
					},
				},
			],
		});
		try {
			const graph = await buildProjectGraph(root);
			expect(edgeKeys(graph.edges)).toEqual([
				"web->auth",
				"web->data",
				"web->ui",
			]);
			// The auth edge exists in the code and not in the manifest, which is a
			// distinct defect from a missing moon.yml entry and is named as such.
			expect(compareDeclaredEdges(graph)).toContain(
				"graph: web imports @synthetic/auth from auth without declaring it in package.json",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps the deepest transitive edge without inventing a shortcut", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/base", packageName: "@synthetic/base" },
				{
					source: "libs/middle",
					packageName: "@synthetic/middle",
					dependencies: { "@synthetic/base": "workspace:*" },
				},
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/middle": "workspace:*" },
				},
			],
		});
		try {
			const graph = await buildProjectGraph(root);
			// `web` reaches `base` only through `middle`. A direct web->base edge
			// here would be a dependency nobody declared.
			expect(edgeKeys(graph.edges)).toEqual(["middle->base", "web->middle"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("resolves the library path alias to the project it names", async () => {
		const root = await workspace({
			aliasPrefix: "@aliased",
			projects: [
				{ source: "libs/ui", packageName: "@aliased/ui" },
				{
					source: "apps/web",
					packageName: "@aliased/web",
					dependencies: { "@aliased/ui": "workspace:*" },
					files: {
						"src/index.ts": "import { Button } from '@aliased/ui/button';\n",
					},
				},
			],
		});
		try {
			const graph = await buildProjectGraph(root);
			expect(edgeKeys(graph.edges)).toEqual(["web->ui"]);
			expect(
				graph.edges.some(
					(edge) => edge.reason === "import" && edge.to === "ui",
				),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("attributes each file to the deepest project that contains it", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ui": "workspace:*" },
					files: { "src/index.ts": "import '@synthetic/ui';\n" },
				},
			],
		});
		try {
			const graph = await buildProjectGraph(root);
			// The root project's source is the whole repository. Without
			// deepest-wins attribution, apps/web's import would also become the
			// root project's dependency.
			expect(edgeKeys(graph.edges)).toEqual(["web->ui"]);
			expect(classifyPath("apps/web/src/index.ts", graph.projects)).toEqual({
				scope: "project",
				project: "web",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reads no edge out of a commented-out import", () => {
		// The other half of a non-vacuous scan: text that merely looks like an
		// import must create nothing, or the generator declares dependencies the
		// code does not have and the oracle then demands them forever.
		expect(
			importSpecifiers(
				[
					"// import { old } from '@synthetic/removed';",
					"/* import { older } from '@synthetic/ancient'; */",
					"const url = 'https://example.com/import-from-nowhere';",
					"import { live } from '@synthetic/kept';",
				].join("\n"),
			),
		).toEqual(["@synthetic/kept"]);
	});

	test("names an unknown project rather than skipping it", async () => {
		const root = await workspace({
			projects: [
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ghost": "workspace:*" },
					config: "dependsOn:\n  - 'phantom'\n",
				},
			],
		});
		try {
			const errors = compareDeclaredEdges(await buildProjectGraph(root));
			expect(errors).toContain(
				"graph: web declares a workspace dependency on @synthetic/ghost, which is not a project",
			);
			expect(errors).toContain(
				"graph: web declares a dependency on phantom, which is not a project",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a default branch that disagrees with the template parameter", async () => {
		const root = await workspace({ defaultBranch: "master", projects: [] });
		try {
			await Bun.write(
				resolve(root, "template-parameters.toml"),
				'[project]\ndefault_branch = "main"\n',
			);
			expect(await buildProjectGraph(root)).toHaveProperty("errors");
			expect((await buildProjectGraph(root)).errors).toContain(
				"graph: .moon/workspace.yml vcs.defaultBranch master differs from template-parameters.toml project.default_branch main",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("moon project config generator", () => {
	test("writes a sorted dependsOn and preserves hand-written keys", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{ source: "libs/data", packageName: "@synthetic/data" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: {
						"@synthetic/ui": "workspace:*",
						"@synthetic/data": "workspace:*",
					},
					config: "language: 'typescript'\ntags:\n  - 'app'\n",
				},
			],
		});
		try {
			expect(await writeGeneratedConfigs(root)).toContain("apps/web/moon.yml");
			const written = await Bun.file(resolve(root, "apps/web/moon.yml")).text();
			expect(written).toContain("dependsOn:\n  - 'data'\n  - 'ui'");
			expect(written).toContain("language: 'typescript'");
			expect(written).toContain("- 'app'");
			// The generated file has to be YAML, not merely text with a list in it.
			const parsed = Bun.YAML.parse(written) as Record<string, unknown>;
			expect(parsed["dependsOn"]).toEqual(["data", "ui"]);
			expect(parsed["language"]).toBe("typescript");
			// A second run over its own output changes nothing.
			expect(await writeGeneratedConfigs(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("states nothing it cannot justify for a project with no dependency", async () => {
		const root = await workspace({
			projects: [{ source: "libs/ui", packageName: "@synthetic/ui" }],
		});
		try {
			await writeGeneratedConfigs(root);
			const written = await Bun.file(resolve(root, "libs/ui/moon.yml")).text();
			// The header names the key it owns; what must be absent is the key
			// itself, so the assertion is over the YAML rather than over the prose.
			expect(written).not.toMatch(/^dependsOn:/m);
			expect(Bun.YAML.parse(written)).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("detects drift in both directions and names the repair", async () => {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ui": "workspace:*" },
				},
			],
		});
		try {
			expect((await planGeneratedConfigs(root)).drift).toEqual([
				"graph: apps/web/moon.yml: generated moon.yml is stale — run bun run graph:generate",
				"graph: libs/ui/moon.yml: generated moon.yml is stale — run bun run graph:generate",
			]);
			await writeGeneratedConfigs(root);
			expect((await planGeneratedConfigs(root)).drift).toEqual([]);

			// A hand-edited generated block is drift, not a customization.
			const path = resolve(root, "apps/web/moon.yml");
			const current = await Bun.file(path).text();
			await Bun.write(path, current.replace("  - 'ui'\n", ""));
			expect((await planGeneratedConfigs(root)).drift).toEqual([
				"graph: apps/web/moon.yml: generated moon.yml is stale — run bun run graph:generate",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses an unbalanced generated block instead of guessing", () => {
		expect(() =>
			spliceGeneratedBlock(
				"# graph:generated:start\nlanguage: 'ts'\n",
				"block",
			),
		).toThrow("unbalanced");
	});

	test("leaves the root project's hand-written config alone", async () => {
		// The root moon.yml carries the inherited-task exclusion that keeps
		// `moon run :lint` from linting the repository once per project. It is
		// core configuration, so the generator states no opinion about it.
		const plan = await planGeneratedConfigs(ROOT);
		expect(plan.graph.projects.map((project) => project.id)).toEqual(["root"]);
		expect(plan.configs).toEqual([]);
		expect(plan.drift).toEqual([]);
		expect(compareDeclaredEdges(plan.graph)).toEqual([]);
	});
});

describe("ci matrix universe registry", () => {
	const PATH = "ci-matrix-universes.json";

	async function registryFixture(
		contents: unknown,
		options: { projects?: ProjectFixture[]; write?: boolean } = {},
	): Promise<string> {
		const root = await workspace({
			projects: options.projects ?? [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
			],
		});
		if (options.write !== false)
			await Bun.write(
				resolve(root, PATH),
				`${JSON.stringify(contents, null, "\t")}\n`,
			);
		return root;
	}

	async function verdicts(root: string): Promise<string[]> {
		return await validateUniverseRegistry(root, await buildProjectGraph(root));
	}

	test("accepts a total, single-universe registry", async () => {
		const root = await registryFixture({
			schemaVersion: 1,
			universes: [{ id: "ci", projects: ["root", "ui"] }],
		});
		try {
			expect(await verdicts(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects every way the registry can be wrong", async () => {
		// One matrix, run against the committed validator rather than a
		// paraphrase of it. Each case is a distinct defect with a distinct
		// repair, so each gets a distinct verdict.
		const cases: Array<[string, unknown, string, boolean?]> = [
			[
				"absent",
				undefined,
				"graph: ci-matrix-universes.json is missing",
				false,
			],
			[
				"wrong schema version",
				{
					schemaVersion: 2,
					universes: [{ id: "ci", projects: ["root", "ui"] }],
				},
				"graph: ci-matrix-universes.json must declare schemaVersion 1",
			],
			[
				"no universe at all",
				{ schemaVersion: 1, universes: [] },
				"graph: ci-matrix-universes.json must declare at least one universe",
			],
			[
				"a universe id that is not kebab-case",
				{
					schemaVersion: 1,
					universes: [{ id: "CI Lane", projects: ["root"] }],
				},
				'graph: ci-matrix-universes.json universe id "CI Lane" must be kebab-case',
			],
			[
				"a duplicated universe id",
				{
					schemaVersion: 1,
					universes: [
						{ id: "ci", projects: ["root"] },
						{ id: "ci", projects: ["ui"] },
					],
				},
				"graph: ci-matrix-universes.json declares the universe id ci more than once",
			],
			[
				"an empty universe",
				{
					schemaVersion: 1,
					universes: [
						{ id: "ci", projects: ["root", "ui"] },
						{ id: "extra", projects: [] },
					],
				},
				"graph: ci-matrix-universes.json universe extra must list at least one project",
			],
			[
				"a project that does not exist",
				{
					schemaVersion: 1,
					universes: [{ id: "ci", projects: ["root", "ui", "ghost"] }],
				},
				"graph: ci-matrix-universes.json universe ci lists ghost, which is not a project",
			],
			[
				"a project claimed twice",
				{
					schemaVersion: 1,
					universes: [
						{ id: "ci", projects: ["root", "ui"] },
						{ id: "extra", projects: ["ui"] },
					],
				},
				"graph: ci-matrix-universes.json lists the project ui more than once",
			],
			[
				"a project no universe claims",
				{ schemaVersion: 1, universes: [{ id: "ci", projects: ["root"] }] },
				"graph: the project ui belongs to no universe in ci-matrix-universes.json",
			],
		];
		for (const [label, contents, expected, write] of cases) {
			const root = await registryFixture(contents, {
				...(write === false ? { write: false } : {}),
			});
			try {
				expect([label, await verdicts(root)]).toEqual([
					label,
					expect.arrayContaining([expected]),
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("rejects a registry that is not JSON", async () => {
		const root = await registryFixture(undefined, { write: false });
		try {
			await Bun.write(resolve(root, PATH), "{ not json\n");
			expect(await verdicts(root)).toEqual([
				"graph: ci-matrix-universes.json must parse as JSON",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a second tracked registry", async () => {
		const root = await registryFixture({
			schemaVersion: 1,
			universes: [{ id: "ci", projects: ["root", "ui"] }],
		});
		try {
			// The sole-registry rule is answered out of the Git index, so the
			// fixture has to be a repository for the question to mean anything.
			for (const args of [
				["init", "-q", "-b", "main"],
				["add", "-A"],
			]) {
				Bun.spawnSync(["git", "-C", root, ...args], {
					env: { PATH: process.env["PATH"] ?? "", HOME: root },
				});
			}
			expect(await verdicts(root)).toEqual([]);
			await Bun.write(resolve(root, "ci-matrix-universes.backup.json"), "{}\n");
			Bun.spawnSync(["git", "-C", root, "add", "-A"], {
				env: { PATH: process.env["PATH"] ?? "", HOME: root },
			});
			expect(await verdicts(root)).toContain(
				"graph: ci-matrix-universes.backup.json is a second matrix universe registry; ci-matrix-universes.json is the only one",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("accepts the committed registry against the committed graph", async () => {
		expect(
			await validateUniverseRegistry(ROOT, await buildProjectGraph(ROOT)),
		).toEqual([]);
	});
});

describe("live moon reconciliation", () => {
	const FAKE_MOON = resolve(import.meta.dir, "fixtures/fake-moon.ts");

	// MOON_BIN takes a path to an executable, so the fixture is reached through a
	// two-line wrapper rather than by committing an executable TypeScript file.
	// The wrapper also proves the pinned argv end to end: fake-moon exits 2 on
	// anything other than `query projects`.
	async function fakeMoonBinary(root: string, mode: string): Promise<string> {
		const path = resolve(root, "fake-moon");
		await Bun.write(
			path,
			`#!/usr/bin/env bash\nexport FAKE_MOON_MODE=${mode}\nexec ${process.execPath} ${FAKE_MOON} "$@"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

	async function reconcile(mode: string): Promise<string[]> {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ui": "workspace:*" },
				},
			],
		});
		const previous = process.env["MOON_BIN"];
		try {
			process.env["MOON_BIN"] = await fakeMoonBinary(root, mode);
			return await reconcileWithMoon(root, await buildProjectGraph(root));
		} finally {
			if (previous === undefined) delete process.env["MOON_BIN"];
			else process.env["MOON_BIN"] = previous;
			await rm(root, { recursive: true, force: true });
		}
	}

	test("agrees with a healthy graph", async () => {
		expect(await reconcile("healthy")).toEqual([]);
	});

	test("fails closed on every abnormal query outcome", async () => {
		// Each of these has told the guard NOTHING about the graph. Treating any
		// of them as "no drift found" is how a live oracle becomes a step that
		// always passes — worse than absent, because CI then claims the graph
		// was verified.
		for (const [mode, expected] of [
			["failure", "exited 1"],
			["silent", "produced no output"],
			["not-json", "did not produce JSON"],
			["unexpected-shape", "reported a project in an unexpected shape"],
		] as const) {
			const errors = await reconcile(mode);
			expect([mode, errors.length]).toEqual([mode, 1]);
			expect([mode, errors[0]]).toEqual([
				mode,
				expect.stringContaining(expected),
			]);
		}
	});

	test("names each way moon and the committed graph can disagree", async () => {
		expect(await reconcile("extra-project")).toEqual([
			"graph: moon reports the project ghost, which the committed graph does not declare",
		]);
		expect(await reconcile("missing-project")).toEqual([
			"graph: moon does not report the project ui, which the committed graph declares",
		]);
		expect(await reconcile("unknown-edge")).toEqual([
			"graph: moon reports the edge web -> root, which nothing in the manifests or sources justifies",
		]);
		expect(await reconcile("missing-edge")).toEqual([
			"graph: moon does not report the derived edge web -> ui",
		]);
	});

	test("passes the committed tree with the live leg disabled", async () => {
		// The host has neither moon nor proto, so the hermetic leg is the one
		// that has to hold here — and it has to hold on the real tree, not only
		// on synthetic fixtures.
		expect(await validateGraphContract(ROOT)).toEqual([]);
	});
});

describe("graph contract mutations", () => {
	// A workspace the whole contract accepts, so every mutation below starts
	// from silence: `web` depends on `ui` through its manifest, both project
	// configs are generated, and the registry claims all three projects.
	async function healthyWorkspace(): Promise<string> {
		const root = await workspace({
			projects: [
				{ source: "libs/ui", packageName: "@synthetic/ui" },
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					dependencies: { "@synthetic/ui": "workspace:*" },
					files: { "src/index.ts": "import '@synthetic/ui';\n" },
				},
			],
		});
		await writeGeneratedConfigs(root);
		await Bun.write(
			resolve(root, "ci-matrix-universes.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					universes: [{ id: "ci", projects: ["root", "ui", "web"] }],
				},
				null,
				"\t",
			)}\n`,
		);
		return root;
	}

	// The house shape, applied to the graph contract: change one file, demand
	// the named verdict, put it back, and demand silence again. The restore leg
	// is what proves the verdict came from the mutation rather than from
	// something the fixture was already carrying.
	async function mutate(
		root: string,
		path: string,
		transform: (source: string) => string,
		expected: string,
	): Promise<void> {
		const target = resolve(root, path);
		const original = await Bun.file(target).text();
		const changed = transform(original);
		if (changed === original)
			throw new Error(`Mutation did not change ${path}`);
		await Bun.write(target, changed);
		expect([path, await validateGraphContract(root)]).toEqual([
			path,
			expect.arrayContaining([expected]),
		]);
		await Bun.write(target, original);
		expect([path, await validateGraphContract(root)]).toEqual([path, []]);
	}

	// The other half of a non-vacuous scan: an edit that merely looks like the
	// forbidden one has to be accepted, or the rule is a substring search
	// wearing a contract's clothes.
	async function tolerate(
		root: string,
		path: string,
		transform: (source: string) => string,
	): Promise<void> {
		const target = resolve(root, path);
		const original = await Bun.file(target).text();
		const changed = transform(original);
		if (changed === original)
			throw new Error(`Mutation did not change ${path}`);
		await Bun.write(target, changed);
		expect([path, await validateGraphContract(root)]).toEqual([path, []]);
		await Bun.write(target, original);
	}

	test("names every way the committed graph can drift", async () => {
		const root = await healthyWorkspace();
		try {
			expect(await validateGraphContract(root)).toEqual([]);

			// A hand-edited generated block is drift, not a customization.
			await mutate(
				root,
				"apps/web/moon.yml",
				(source) => source.replace("  - 'ui'\n", ""),
				"graph: apps/web/moon.yml: generated moon.yml is stale — run bun run graph:generate",
			);
			// A dependency the manifest drops but the config still claims.
			await mutate(
				root,
				"apps/web/package.json",
				(source) =>
					source.replace(
						'"@synthetic/ui": "workspace:*"',
						'"left-pad": "1.3.0"',
					),
				"graph: web imports @synthetic/ui from ui without declaring it in package.json",
			);
			// A project the registry forgets is a project no lane ever builds.
			await mutate(
				root,
				"ci-matrix-universes.json",
				(source) => source.replace(',\n\t\t\t\t"web"', ""),
				"graph: the project web belongs to no universe in ci-matrix-universes.json",
			);
			// A default branch that disagrees with the one branch protection
			// gates would make every later affected query diff against nothing.
			await mutate(
				root,
				".moon/workspace.yml",
				(source) =>
					source.replace("defaultBranch: 'main'", "defaultBranch: ''"),
				"graph: .moon/workspace.yml must declare vcs.defaultBranch",
			);

			// ... and the edits that only look like those. A commented-out import
			// creates no edge, and a hand-written key outside the generated block
			// survives untouched.
			await tolerate(
				root,
				"apps/web/src/index.ts",
				(source) =>
					`// import '@synthetic/ghost';\n/* import '@synthetic/other'; */\n${source}`,
			);
			await tolerate(
				root,
				"apps/web/moon.yml",
				(source) => `${source}\ntags:\n  - 'app'\nlanguage: 'typescript'\n`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("classifies a change by who owns it", async () => {
		const root = await healthyWorkspace();
		try {
			const { projects } = await buildProjectGraph(root);
			// Global: changing any of these changes what EVERY project builds or
			// how every project is checked, so the honest answer is "everything".
			for (const path of [
				".prototools",
				"package.json",
				"bun.lock",
				"tsconfig.base.json",
				".moon/workspace.yml",
				".github/workflows/ci.yml",
				"ci-matrix-universes.json",
				"scripts/ci/run-tests.sh",
			])
				expect([path, classifyPath(path, projects)]).toEqual([
					path,
					{ scope: "global" },
				]);

			// Documentation changes no build output — including under a directory
			// the global list would otherwise claim, and inside a project.
			for (const path of [
				"README.md",
				"docs/devcontainer-upgrade/stage-8a/README.md",
				"openspec/specs/whatever.md",
				".github/PULL_REQUEST_TEMPLATE.md",
				"apps/web/README.md",
			])
				expect([path, classifyPath(path, projects)]).toEqual([
					path,
					{ scope: "docs" },
				]);

			// Project-scoped, attributed to the deepest owner.
			expect(classifyPath("apps/web/src/index.ts", projects)).toEqual({
				scope: "project",
				project: "web",
			});
			expect(classifyPath("libs/ui/src/button.ts", projects)).toEqual({
				scope: "project",
				project: "ui",
			});
			// Anything the root project contains and no rule claims falls to the
			// root project rather than to nobody.
			expect(classifyPath("evidence/stage-7-ci.json", projects)).toEqual({
				scope: "project",
				project: "root",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("accepts the rendered full fixture on its own terms", async () => {
		// The guard ships downstream, so it has to hold over a rendered project
		// rather than only over the tree it was written in: different slug,
		// different path alias, no template-parameters.toml, and no Git index for
		// the sole-registry scan to read.
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-graph-render-"));
		try {
			const output = resolve(temporary, "full");
			await renderFixture({ root: ROOT, fixtureName: "full", output });
			expect(await validateGraphContract(output)).toEqual([]);
			const graph = await buildProjectGraph(output);
			expect(graph.projects.map((project) => project.id)).toEqual(["root"]);
			expect(graph.defaultBranch).toBe("main");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);
});
