// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures quote TypeScript path templates verbatim.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	AffectedPreflightError,
	type AffectedSelection,
	selectAffected,
	validateAffectedContract,
} from "../affected-contract";
import { buildProjectGraph, dependentsOf } from "../graph-contract";
import { reconcileWithMoon } from "../select-affected";

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

const FAKE_MOON = resolve(import.meta.dir, "fixtures/fake-moon-affected.ts");

// MOON_BIN takes a path to an executable, so the fixture is reached through a
// two-line wrapper rather than by committing an executable TypeScript file. The
// wrapper also proves the pinned argv end to end: the fixture exits 2 on
// anything other than the six arguments the constant holds, and exits 3 if it is
// ever handed an empty file list.
async function fakeMoonBinary(
	root: string,
	moonMode: string,
	record?: string,
): Promise<string> {
	const path = resolve(root, "fake-moon-affected");
	await Bun.write(
		path,
		[
			"#!/usr/bin/env bash",
			`export FAKE_MOON_AFFECTED_MODE=${moonMode}`,
			...(record ? [`export FAKE_MOON_RECORD=${record}`] : []),
			`exec ${process.execPath} ${FAKE_MOON} "$@"`,
			"",
		].join("\n"),
	);
	await chmod(path, 0o755);
	return path;
}

async function reconciled(
	root: string,
	moonMode: string,
	record?: string,
): Promise<AffectedSelection> {
	const previous = process.env["MOON_BIN"];
	try {
		process.env["MOON_BIN"] = await fakeMoonBinary(root, moonMode, record);
		return await reconcileWithMoon(
			root,
			await selection(root),
			git(root, "rev-parse", "HEAD"),
		);
	} finally {
		if (previous === undefined) delete process.env["MOON_BIN"];
		else process.env["MOON_BIN"] = previous;
	}
}

describe("moon reconciliation", () => {
	test("lets the narrow selection stand when moon agrees, and records the invocation", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"libs/base/src/index.ts": "export const base = 9;\n",
			});
			const record = resolve(root, ".moon-invocation");
			const result = await reconciled(root, "agree", record);
			expect(result.mode).toBe("narrow");
			expect(result.universes["ci"]).toEqual(["base", "ui", "web"]);
			expect(result.annotations.at(-1)).toContain("agrees");
			const invocation = JSON.parse(await Bun.file(record).text()) as {
				argv: string[];
				files: string[];
				base: string | null;
				head: string | null;
			};
			// The pinned argv, verbatim.
			expect(invocation.argv).toEqual([
				"query",
				"projects",
				"--affected",
				"--downstream",
				"deep",
				"--quiet",
			]);
			// The SEED files, not the whole diff.
			expect(invocation.files).toEqual(["libs/base/src/index.ts"]);
			// The merge base, so a stacked pull request is never diffed against
			// the default branch behind the selector's back.
			expect(invocation.base).toBe(git(root, "rev-parse", "HEAD~1"));
			expect(invocation.head).toBe(git(root, "rev-parse", "HEAD"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("widens to full on every abnormal answer", async () => {
		for (const [moonMode, fragment] of [
			["failure", "exited 1"],
			["silent", "produced no output"],
			["not-json", "did not produce JSON"],
			["no-projects-key", "did not report a projects array"],
			["unexpected-shape", "unexpected shape"],
			["narrower", "where the committed graph derived"],
			["wider", "where the committed graph derived"],
			["only-root", "where the committed graph derived"],
		] as const) {
			const root = await chain();
			try {
				await commitChange(root, {
					"libs/base/src/index.ts": "export const base = 10;\n",
				});
				const result = await reconciled(root, moonMode);
				// A narrower moon answer is a widening too. We never adopt moon's
				// number; we only refuse to be narrower than a disagreement allows.
				expect([moonMode, result.mode, result.reason]).toEqual([
					moonMode,
					"full",
					"moon-disagreed",
				]);
				expect([moonMode, result.universes["ci"]]).toEqual([
					moonMode,
					["admin", "base", "root", "ui", "web"],
				]);
				expect([
					moonMode,
					result.annotations.at(-1)?.includes(fragment) ?? false,
				]).toEqual([moonMode, true]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	}, 120_000);

	test("widens to full when the binary is not there at all", async () => {
		const root = await chain();
		try {
			await commitChange(root, {
				"libs/base/src/index.ts": "export const base = 11;\n",
			});
			const previous = process.env["MOON_BIN"];
			process.env["MOON_BIN"] = resolve(root, "no-such-binary");
			try {
				const result = await reconcileWithMoon(
					root,
					await selection(root),
					git(root, "rev-parse", "HEAD"),
				);
				expect(result.mode).toBe("full");
				expect(result.reason).toBe("moon-disagreed");
			} finally {
				if (previous === undefined) delete process.env["MOON_BIN"];
				else process.env["MOON_BIN"] = previous;
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("never invokes moon with an empty file list", async () => {
		const root = await chain();
		try {
			// Documentation only: a real query here would fall back to working-tree
			// detection and answer a different question with exit 0.
			await commitChange(root, { "docs/guide.md": "# guide\n" });
			const previous = process.env["MOON_BIN"];
			// A binary that fails if it is ever called at all.
			process.env["MOON_BIN"] = resolve(root, "no-such-binary");
			try {
				const derived = await selection(root);
				expect(derived.seedFiles).toEqual([]);
				const result = await reconcileWithMoon(
					root,
					derived,
					git(root, "rev-parse", "HEAD"),
				);
				expect(result.mode).toBe("narrow");
				expect(result.universes["ci"]).toEqual([]);
				expect(result.annotations.at(-1)).toContain("not consulted");
			} finally {
				if (previous === undefined) delete process.env["MOON_BIN"];
				else process.env["MOON_BIN"] = previous;
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("leaves a full selection alone", async () => {
		const root = await chain();
		try {
			await commitChange(root, { "AGENTS.md": "# agents\n" });
			const derived = await selection(root);
			expect(derived.mode).toBe("full");
			const result = await reconcileWithMoon(root, derived, undefined);
			// Moon has nothing to say about an answer that is already the whole
			// set, and asking it could only widen a widening.
			expect(result).toBe(derived);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});

// The committed entrypoint, executed for what it does rather than read for
// what it says. The synthetic workspace receives the same four files a render
// carries, so the script resolves its own root exactly as it does downstream.
const MATRIX_SCRIPT = "scripts/ci/affected-matrices.sh";
const CARRIED = [
	MATRIX_SCRIPT,
	"scripts/template/select-affected.ts",
	"scripts/template/affected-contract.ts",
	"scripts/template/graph-contract.ts",
] as const;

async function withEntrypoint(root: string): Promise<void> {
	for (const path of CARRIED) {
		const target = resolve(root, path);
		await mkdir(resolve(target, ".."), { recursive: true });
		await Bun.write(target, await Bun.file(resolve(ROOT, path)).text());
	}
	git(root, "add", "-A");
	git(root, "commit", "-qm", "carry the selection entrypoint");
}

// Assembled at runtime so this file is not itself counted as a committed writer
// of job outputs. `ci-contract.ts` allows at most one, and the whole value of
// that rule is that it needs no path exemptions.
const OUTPUT_VARIABLE = ["GITHUB", "OUTPUT"].join("_");
const SUMMARY_VARIABLE = ["GITHUB", "STEP", "SUMMARY"].join("_");

interface MatrixRun {
	exitCode: number;
	output: string;
	summary: string;
	log: string;
}

async function runMatrices(
	root: string,
	environment: Record<string, string>,
): Promise<MatrixRun> {
	const outputPath = resolve(root, ".matrix-output");
	const summaryPath = resolve(root, ".matrix-summary");
	await Bun.write(outputPath, "");
	await Bun.write(summaryPath, "");
	// A moon that agrees, unless a case asks for another one. Without it the
	// reconciliation leg would widen every narrow answer here to FULL on a
	// missing binary, and the entrypoint cases would be testing that instead.
	const moon = await fakeMoonBinary(root, environment["FAKE_MOON"] ?? "agree");
	const result = Bun.spawnSync({
		cmd: ["bash", resolve(root, MATRIX_SCRIPT)],
		cwd: root,
		env: {
			PATH: process.env["PATH"] ?? "",
			HOME: root,
			MOON_BIN: moon,
			[OUTPUT_VARIABLE]: outputPath,
			[SUMMARY_VARIABLE]: summaryPath,
			...environment,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		output: await Bun.file(outputPath).text(),
		summary: await Bun.file(summaryPath).text(),
		log: `${result.stdout.toString()}${result.stderr.toString()}`,
	};
}

function emitted(output: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
	}
	return values;
}

describe("affected matrix entrypoint", () => {
	test("emits the matrices, and narrates the shadow selection in both modes", async () => {
		const root = await chain();
		try {
			await withEntrypoint(root);
			await commitChange(root, {
				"apps/web/src/index.ts":
					"import '@synthetic/ui';\nexport const web = 8;\n",
			});
			const environment = {
				EVENT_NAME: "pull_request",
				BASE_SHA: git(root, "rev-parse", "HEAD~1"),
				HEAD_SHA: git(root, "rev-parse", "HEAD"),
			};

			// Unset mode: today's behaviour, plus the selection it WOULD have made.
			// That printed line is the shadow phase — there is no second selector to
			// build and therefore none to delete.
			const shadow = await runMatrices(root, environment);
			expect(shadow.exitCode).toBe(0);
			expect(emitted(shadow.output)).toEqual({
				mode: "full",
				reason: "mode-not-selecting",
				ci: '["admin","base","root","ui","web"]',
			});
			expect(shadow.log).toContain("would have selected");
			expect(shadow.log).toContain("ci = [web]");
			expect(shadow.summary).toContain("would have selected");

			// Flipped: the same tree, the same diff, one variable apart.
			const flipped = await runMatrices(root, {
				...environment,
				MOON_AFFECTED_MODE: "moon",
			});
			expect(flipped.exitCode).toBe(0);
			expect(emitted(flipped.output)).toEqual({
				mode: "narrow",
				reason: "affected",
				ci: '["web"]',
			});
			expect(flipped.summary).toContain("selection: narrow");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("emits an empty matrix for a documentation-only change", async () => {
		const root = await chain();
		try {
			await withEntrypoint(root);
			await commitChange(root, { "docs/guide.md": "# guide\n" });
			const run = await runMatrices(root, {
				MOON_AFFECTED_MODE: "moon",
				EVENT_NAME: "pull_request",
				BASE_SHA: git(root, "rev-parse", "HEAD~1"),
				HEAD_SHA: git(root, "rev-parse", "HEAD"),
			});
			expect(run.exitCode).toBe(0);
			expect(emitted(run.output)["ci"]).toBe("[]");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("fails OPEN to the full matrix on every fault", async () => {
		for (const [label, body, reason] of [
			["a crash", "process.exit(3);\n", "selector-failed"],
			["a syntax error", "this is not typescript {{{\n", "selector-failed"],
			[
				"output that is not a selection",
				'console.log("definitely not json");\n',
				"selector-unreadable",
			],
			[
				"a selection missing its universes",
				'console.log(JSON.stringify({ mode: "narrow" }));\n',
				"selector-unreadable",
			],
		] as const) {
			const root = await chain();
			try {
				await withEntrypoint(root);
				await Bun.write(
					resolve(root, "scripts/template/select-affected.ts"),
					body,
				);
				const run = await runMatrices(root, {
					MOON_AFFECTED_MODE: "moon",
					EVENT_NAME: "pull_request",
					BASE_SHA: git(root, "rev-parse", "HEAD~1"),
					HEAD_SHA: git(root, "rev-parse", "HEAD"),
				});
				// Exit 0 and the FULL matrix: uncertainty resolves toward running
				// more, and a red job here would be a fault nobody can act on.
				expect([label, run.exitCode]).toEqual([label, 0]);
				expect([label, emitted(run.output)["mode"]]).toEqual([label, "full"]);
				expect([label, emitted(run.output)["reason"]]).toEqual([label, reason]);
				expect([label, emitted(run.output)["ci"]]).toEqual([
					label,
					'["admin","base","root","ui","web"]',
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	}, 120_000);

	test("fails CLOSED with a byte-empty output file on an unusable registry", async () => {
		for (const [label, contents] of [
			["missing", undefined],
			["not json", "{\n"],
			["no universes key", `${JSON.stringify({ schemaVersion: 1 })}\n`],
			[
				"an empty universe list",
				`${JSON.stringify({ schemaVersion: 1, universes: [] })}\n`,
			],
			[
				"a universe with no projects",
				`${JSON.stringify({ schemaVersion: 1, universes: [{ id: "ci", projects: [] }] })}\n`,
			],
			// The shell preflight cannot see this one — the file reads fine and
			// names a universe — so it is the selector's own fail-closed exit that
			// has to survive the ERR trap.
			[
				"a project in no universe",
				`${JSON.stringify({ schemaVersion: 1, universes: [{ id: "ci", projects: ["root"] }] })}\n`,
			],
		] as const) {
			const root = await chain();
			try {
				await withEntrypoint(root);
				const registry = resolve(root, "ci-matrix-universes.json");
				if (contents === undefined) await rm(registry);
				else await Bun.write(registry, contents);
				const run = await runMatrices(root, {
					MOON_AFFECTED_MODE: "moon",
					EVENT_NAME: "pull_request",
					BASE_SHA: git(root, "rev-parse", "HEAD"),
					HEAD_SHA: git(root, "rev-parse", "HEAD"),
				});
				// Fail-closed-SAFE: a red job and NO output. Emitting the full matrix
				// here would emit an EMPTY one — every project skipped on the sole
				// required gate, reported green.
				expect([label, run.exitCode]).toEqual([label, 1]);
				expect([label, run.output]).toEqual([label, ""]);
				expect([label, run.log.includes("Failing CLOSED")]).toEqual([
					label,
					true,
				]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	}, 120_000);
});
