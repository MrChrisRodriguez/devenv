// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures quote TypeScript path templates verbatim.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
} from "../graph-contract";

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
