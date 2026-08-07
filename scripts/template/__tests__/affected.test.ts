// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures quote TypeScript path templates verbatim.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	AffectedPreflightError,
	type AffectedSelection,
	selectAffected,
	validateAffectedContract,
} from "../affected-contract";
import { buildProjectGraph, dependentsOf } from "../graph-contract";

const ROOT = resolve(import.meta.dir, "../../..");

interface ProjectFixture {
	source: string;
	packageName?: string;
	dependencies?: Record<string, string>;
	dependsOn?: string[];
	files?: Record<string, string>;
}

/**
 * A synthetic multi-project workspace that is also a real Git repository.
 *
 * Both halves are required. The selector answers questions about a project
 * graph, so the only honest fixture is a directory tree; and it answers them by
 * running `git merge-base` and `git diff`, so the only honest fixture is one
 * with real commits in it. This repository's own graph is `{root}` alone, which
 * makes every closure trivially the whole set — a fixture built on it would
 * pass with the reverse-reachability walk deleted.
 */
async function workspace(options: {
	projects: ProjectFixture[];
	universes?: Array<{ id: string; projects: string[] }>;
}): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-affected-"));
	await mkdir(resolve(root, ".moon"), { recursive: true });
	await Bun.write(
		resolve(root, ".moon/workspace.yml"),
		[
			"projects:",
			"  globs:",
			"    - 'apps/*'",
			"    - 'libs/*'",
			"  sources:",
			"    root: '.'",
			"vcs:",
			"  defaultBranch: 'main'",
			"",
		].join("\n"),
	);
	await Bun.write(
		resolve(root, "tsconfig.base.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					paths: { "@synthetic/*": ["${configDir}/../../libs/*/src"] },
				},
			},
			null,
			"\t",
		)}\n`,
	);
	await Bun.write(
		resolve(root, "package.json"),
		`${JSON.stringify({ name: "synthetic" }, null, "\t")}\n`,
	);
	await Bun.write(resolve(root, "moon.yml"), "# root\n");
	for (const project of options.projects) {
		const directory = resolve(root, project.source);
		await mkdir(directory, { recursive: true });
		if (project.packageName !== undefined)
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
		const dependsOn = project.dependsOn ?? [];
		await Bun.write(
			resolve(directory, "moon.yml"),
			dependsOn.length > 0
				? `dependsOn:\n${dependsOn.map((id) => `  - '${id}'\n`).join("")}`
				: "# no derived dependency\n",
		);
		for (const [path, contents] of Object.entries(project.files ?? {})) {
			const target = resolve(directory, path);
			await mkdir(resolve(target, ".."), { recursive: true });
			await Bun.write(target, contents);
		}
	}
	const universes = options.universes ?? [
		{
			id: "ci",
			projects: [
				"root",
				...options.projects.map(
					(project) => project.source.split("/").at(-1) ?? "",
				),
			].sort(),
		},
	];
	await Bun.write(
		resolve(root, "ci-matrix-universes.json"),
		`${JSON.stringify({ schemaVersion: 1, universes }, null, "\t")}\n`,
	);
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "selector@example.test");
	git(root, "config", "user.name", "selector");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	return root;
}

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: { PATH: process.env["PATH"] ?? "", HOME: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	return result.stdout.toString().trim();
}

async function commitChange(
	root: string,
	files: Record<string, string>,
	message = "change",
): Promise<string> {
	for (const [path, contents] of Object.entries(files)) {
		const target = resolve(root, path);
		await mkdir(resolve(target, ".."), { recursive: true });
		await Bun.write(target, contents);
	}
	git(root, "add", "-A");
	git(root, "commit", "-qm", message);
	return git(root, "rev-parse", "HEAD");
}

/** The three-project shape every selection case is asserted against. */
async function chain(): Promise<string> {
	return await workspace({
		projects: [
			{
				source: "libs/base",
				packageName: "@synthetic/base",
				files: { "src/index.ts": "export const base = 1;\n" },
			},
			{
				source: "libs/ui",
				packageName: "@synthetic/ui",
				dependencies: { "@synthetic/base": "workspace:*" },
				dependsOn: ["base"],
				files: {
					"src/index.ts": "import '@synthetic/base';\nexport const ui = 1;\n",
				},
			},
			{
				source: "apps/web",
				packageName: "@synthetic/web",
				dependencies: { "@synthetic/ui": "workspace:*" },
				dependsOn: ["ui"],
				files: {
					"src/index.ts": "import '@synthetic/ui';\nexport const web = 1;\n",
				},
			},
			{
				source: "apps/admin",
				packageName: "@synthetic/admin",
				files: { "src/index.ts": "export const admin = 1;\n" },
			},
		],
	});
}

function selection(
	root: string,
	overrides: Partial<Parameters<typeof selectAffected>[0]> = {},
): Promise<AffectedSelection> {
	return selectAffected({
		root,
		mode: "moon",
		eventName: "pull_request",
		baseSha: git(root, "rev-parse", "HEAD~1"),
		headSha: git(root, "rev-parse", "HEAD"),
		...overrides,
	});
}

describe("affected selection", () => {
	test("walks the graph backwards, cycle-safe, and keeps the seeds", async () => {
		const root = await chain();
		try {
			const graph = await buildProjectGraph(root);
			// A change to the deepest library reaches everything above it.
			expect(dependentsOf(graph, ["base"])).toEqual(["base", "ui", "web"]);
			// ... and a leaf reaches only itself.
			expect(dependentsOf(graph, ["web"])).toEqual(["web"]);
			expect(dependentsOf(graph, [])).toEqual([]);
			// A cycle terminates instead of recursing forever: the graph contract
			// reports the cycle elsewhere, and a selector that overflowed the stack
			// would fail the gate with a trace rather than an answer.
			const cyclic = {
				projects: [],
				edges: [
					{ from: "a", to: "b", reason: "manifest" as const, evidence: "x" },
					{ from: "b", to: "a", reason: "manifest" as const, evidence: "y" },
				],
				errors: [],
			};
			expect(dependentsOf(cyclic, ["a"])).toEqual(["a", "b"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("narrows a leaf change to the leaf", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 2;\n",
			});
			const result = await selection(root);
			expect(result.mode).toBe("narrow");
			expect(result.reason).toBe("affected");
			expect(result.universes["ci"]).toEqual(["web"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fans a deep library change out to every dependent", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"libs/base/src/index.ts": "export const base = 2;\n",
			});
			const result = await selection(root);
			expect(result.mode).toBe("narrow");
			// Transitive, not direct: `web` depends on `ui` depends on `base`.
			expect(result.universes["ci"]).toEqual(["base", "ui", "web"]);
			// `admin` depends on nothing that changed, and `root` owns no changed
			// file, so neither is in the closure. That is the whole point.
			expect(result.universes["ci"]).not.toContain("admin");
			expect(result.universes["ci"]).not.toContain("root");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("selects nothing for a documentation-only change", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"docs/guide.md": "# guide\n",
				"apps/web/README.md": "# web\n",
				"openspec/specs/thing.md": "# thing\n",
			});
			const result = await selection(root);
			// An EMPTY narrow selection, not FULL: this is the only outcome that
			// proves the capability does anything at all.
			expect(result.mode).toBe("narrow");
			expect(result.universes["ci"]).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("widens to full for a global input, including a root rule file", async () => {
		for (const [path, contents] of [
			[
				"package.json",
				`${JSON.stringify({ name: "synthetic", version: "2" }, null, "\t")}\n`,
			],
			["AGENTS.md", "# agents\n"],
			[".github/workflows/ci.yml", "name: CI\n"],
			// The catch-all that matters most: a top-level file type nothing has
			// enumerated. It falls to the repository-wide project, and a selector
			// that seeded it would say "a brand-new root config affects the root
			// project only" — the exact silent skip this rule exists to prevent.
			["some-new-root-file.conf", "x = 1\n"],
			["evidence/whatever.json", "{}\n"],
		] as const) {
			const root = await chain();
			try {
				await commitChange(root, { [path]: contents });
				const result = await selection(root);
				expect([path, result.mode, result.reason]).toEqual([
					path,
					"full",
					"global-input",
				]);
				expect(result.universes["ci"]).toEqual([
					"admin",
					"base",
					"root",
					"ui",
					"web",
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("widens to full for every event that carries no usable base", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 3;\n",
			});
			// The narrow control: the same tree, the same diff, one event apart.
			expect((await selection(root)).mode).toBe("narrow");
			for (const eventName of [
				"push",
				"schedule",
				"workflow_dispatch",
				"deployment",
				"release",
				"",
				"an_event_nobody_has_written_yet",
			]) {
				const result = await selection(root, { eventName });
				expect([eventName, result.mode, result.reason]).toEqual([
					eventName,
					"full",
					"event-not-selectable",
				]);
			}
			// `merge_group` is in the table even though this repository runs no
			// merge queue: an event handled but not triggered is unreachable, while
			// an event triggered but not handled is silently wrong.
			expect((await selection(root, { eventName: "merge_group" })).mode).toBe(
				"narrow",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("widens to full for every spelling of a mode that is not moon", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 4;\n",
			});
			for (const mode of ["full", "", "Moonlight", "off", "true", undefined]) {
				const result = await selection(root, { mode });
				expect([mode, result.mode, result.reason]).toEqual([
					mode,
					"full",
					"mode-not-selecting",
				]);
			}
			// ... and every spelling that IS moon still selects.
			for (const mode of ["moon", "MOON", " moon ", "Moon"]) {
				expect([mode, (await selection(root, { mode })).mode]).toEqual([
					mode,
					"narrow",
				]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("widens to full when either endpoint is not a commit this clone has", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 5;\n",
			});
			const absent = "0".repeat(40);
			for (const [overrides, reason] of [
				[{ baseSha: "" }, "base-sha-malformed"],
				[{ baseSha: "main" }, "base-sha-malformed"],
				[{ baseSha: "abc123" }, "base-sha-malformed"],
				[{ baseSha: "A".repeat(40) }, "base-sha-malformed"],
				[{ baseSha: absent }, "base-sha-unknown"],
				[{ headSha: "" }, "head-sha-malformed"],
				[{ headSha: absent }, "head-sha-unknown"],
			] as const) {
				const result = await selection(root, overrides);
				expect([reason, result.mode, result.reason]).toEqual([
					reason,
					"full",
					reason,
				]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("widens to full when the diff finds nothing", async () => {
		const root = await chain();
		try {
			const head = git(root, "rev-parse", "HEAD");
			// A base equal to the head is a successful diff with no output, which is
			// exactly what a wrong base looks like too.
			const result = await selectAffected({
				root,
				mode: "moon",
				eventName: "pull_request",
				baseSha: head,
				headSha: head,
			});
			expect([result.mode, result.reason]).toEqual([
				"full",
				"no-changed-files",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("diffs a stacked pull request from its own merge base", async () => {
		const root = await chain();
		try {
			const branchPoint = git(root, "rev-parse", "HEAD");
			// The base branch moves on after the branch point, touching a global
			// input. A two-dot diff against the base TIP would see that file and
			// widen to FULL; the merge base must make it invisible.
			await commitChange(
				root,
				{
					"package.json": `${JSON.stringify({ name: "synthetic", version: "9" }, null, "\t")}\n`,
				},
				"base moves on",
			);
			const baseTip = git(root, "rev-parse", "HEAD");
			git(root, "checkout", "-q", "-b", "feature", branchPoint);
			await commitChange(
				root,
				{
					"apps/web/src/index.ts":
						"import '@synthetic/ui';\nexport const web = 6;\n",
				},
				"feature work",
			);
			const head = git(root, "rev-parse", "HEAD");

			const result = await selectAffected({
				root,
				mode: "moon",
				eventName: "pull_request",
				baseSha: baseTip,
				headSha: head,
			});
			expect(result.mode).toBe("narrow");
			expect(result.universes["ci"]).toEqual(["web"]);
			expect(result.annotations[0]).toBe(`merge base ${branchPoint}`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("counts a rename against both the old and the new owner", async () => {
		const root = await chain();
		try {
			git(root, "mv", "apps/admin/src/index.ts", "apps/web/src/moved.ts");
			git(root, "commit", "-qm", "move a file between projects");
			const result = await selection(root);
			expect(result.mode).toBe("narrow");
			// Without `--no-renames` git reports one rename entry and the project
			// the file LEFT would never be rebuilt.
			expect(result.universes["ci"]).toEqual(["admin", "web"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("intersects each universe independently", async () => {
		const root = await workspace({
			projects: [
				{
					source: "apps/web",
					packageName: "@synthetic/web",
					files: { "src/index.ts": "export const web = 1;\n" },
				},
				{
					source: "apps/admin",
					packageName: "@synthetic/admin",
					files: { "src/index.ts": "export const admin = 1;\n" },
				},
			],
			universes: [
				{ id: "apps", projects: ["admin", "web"] },
				{ id: "tooling", projects: ["root"] },
			],
		});
		try {
			await commitChange(root, {
				"apps/web/src/index.ts": "export const web = 2;\n",
			});
			const result = await selection(root);
			expect(result.universes).toEqual({ apps: ["web"], tooling: [] });
			// ... and a widening fills every universe, never only the first.
			const full = await selection(root, { mode: "full" });
			expect(full.universes).toEqual({
				apps: ["admin", "web"],
				tooling: ["root"],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails CLOSED on an unusable universe registry", async () => {
		// The one ambiguity this selector cannot fail open on. Without the
		// registry it does not know the FULL set, so "emit full" would emit
		// EMPTY — every project skipped on the sole required gate, reported
		// green. Fail-closed-SAFE, never fail-closed-SILENT.
		for (const [label, contents] of [
			["missing", undefined],
			["not json", "{"],
			["not an object", "[]"],
			[
				"wrong schema version",
				`${JSON.stringify({ schemaVersion: 2, universes: [{ id: "ci", projects: ["root"] }] })}\n`,
			],
			[
				"no universe",
				`${JSON.stringify({ schemaVersion: 1, universes: [] })}\n`,
			],
			[
				"an unknown project",
				`${JSON.stringify({ schemaVersion: 1, universes: [{ id: "ci", projects: ["ghost"] }] })}\n`,
			],
			[
				"a project in no universe",
				`${JSON.stringify({ schemaVersion: 1, universes: [{ id: "ci", projects: ["root"] }] })}\n`,
			],
		] as const) {
			const root = await chain();
			try {
				const path = resolve(root, "ci-matrix-universes.json");
				if (contents === undefined) await rm(path);
				else await Bun.write(path, contents);
				await commitChange(root, {
					"apps/web/src/index.ts":
						"import '@synthetic/ui';\nexport const web = 7;\n",
				});
				let thrown: unknown;
				try {
					await selection(root);
				} catch (error) {
					thrown = error;
				}
				expect([label, thrown instanceof AffectedPreflightError]).toEqual([
					label,
					true,
				]);
				// The preflight runs BEFORE the mode check, so even the rollback
				// switch cannot turn a broken registry into a silent full run.
				let alsoThrown: unknown;
				try {
					await selection(root, { mode: "full" });
				} catch (error) {
					alsoThrown = error;
				}
				expect([label, alsoThrown instanceof AffectedPreflightError]).toEqual([
					label,
					true,
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	}, 60_000);
});

describe("affected selection contract", () => {
	test("passes the real tree", async () => {
		expect(await validateAffectedContract(ROOT)).toEqual([]);
	});
});
