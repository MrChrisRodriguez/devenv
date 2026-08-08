// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The wrapper mutations
// quote shell parameter expansions verbatim.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	archiveEntryName,
	assessArchive,
	enumerateOpenspecRoots,
	inspectOpenspec,
	shellCode,
	validateOpenspecContract,
	validateWrapperPolicy,
} from "../openspec-contract";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	resolveFixtureParameters,
} from "../parameters";
import {
	loadTemplateOwnership,
	renderFixture,
	scanDisabledResidue,
} from "../render-fixture";
import { validateOpenspec } from "../validate-openspec";
import {
	type FakeOpenspecMode,
	fakeOpenspecCli,
} from "./fixtures/fake-openspec";

const ROOT = resolve(import.meta.dir, "../../..");

const PROPOSAL = [
	"# Probe",
	"",
	"## Why",
	"",
	"A synthetic change that exists only so the guard has something real to walk.",
	"",
	"## What Changes",
	"",
	"- **probe-cap:** one requirement",
	"",
].join("\n");

function deltaSpec(requirement: string, capability = "probe-cap"): string {
	return [
		`# ${capability}`,
		"",
		"## ADDED Requirements",
		"",
		`### Requirement: ${requirement}`,
		"",
		"The system SHALL probe.",
		"",
		"#### Scenario: Probing",
		"",
		"- **WHEN** probed",
		"- **THEN** it answers",
		"",
	].join("\n");
}

function mainSpec(requirement: string): string {
	return [
		"# probe-cap",
		"",
		"## Requirements",
		"",
		`### Requirement: ${requirement}`,
		"",
		"The system SHALL probe.",
		"",
		"#### Scenario: Probing",
		"",
		"- **WHEN** probed",
		"- **THEN** it answers",
		"",
	].join("\n");
}

interface ChangeFixture {
	name: string;
	remaining?: number;
	complete?: number;
	requirement?: string;
	/** The delta spec's capability. Two changes may not both own one. */
	capability?: string;
	omit?: string[];
}

interface RootFixture {
	/** Directory that CONTAINS the `openspec` directory, relative to the root. */
	at?: string;
	changes?: ChangeFixture[];
	archived?: Array<{ entry: string; requirement?: string }>;
	specs?: Record<string, string>;
}

function tasks(complete: number, remaining: number): string {
	const lines = ["## 1. Work", ""];
	for (let index = 0; index < complete; index += 1)
		lines.push(`- [x] 1.${index + 1} Done`);
	for (let index = 0; index < remaining; index += 1)
		lines.push(`- [ ] 2.${index + 1} Pending`);
	lines.push("");
	return lines.join("\n");
}

async function writeRoot(root: string, fixture: RootFixture): Promise<void> {
	const base = resolve(root, fixture.at ?? ".", "openspec");
	await mkdir(base, { recursive: true });
	await Bun.write(resolve(base, "config.yaml"), "schema: spec-driven\n");
	for (const change of fixture.changes ?? []) {
		const directory = resolve(base, "changes", change.name);
		await mkdir(directory, { recursive: true });
		const omit = new Set(change.omit ?? []);
		if (!omit.has(".openspec.yaml"))
			await Bun.write(
				resolve(directory, ".openspec.yaml"),
				"schema: spec-driven\ncreated: 2026-01-01\n",
			);
		if (!omit.has("proposal.md"))
			await Bun.write(resolve(directory, "proposal.md"), PROPOSAL);
		if (!omit.has("tasks.md"))
			await Bun.write(
				resolve(directory, "tasks.md"),
				tasks(change.complete ?? 1, change.remaining ?? 1),
			);
		if (change.requirement) {
			const capability = change.capability ?? "probe-cap";
			await mkdir(resolve(directory, "specs", capability), { recursive: true });
			await Bun.write(
				resolve(directory, "specs", capability, "spec.md"),
				deltaSpec(change.requirement, capability),
			);
		}
	}
	for (const archived of fixture.archived ?? []) {
		const directory = resolve(base, "changes/archive", archived.entry);
		await mkdir(directory, { recursive: true });
		await Bun.write(
			resolve(directory, ".openspec.yaml"),
			"schema: spec-driven\ncreated: 2026-01-01\n",
		);
		await Bun.write(resolve(directory, "proposal.md"), PROPOSAL);
		await Bun.write(resolve(directory, "tasks.md"), tasks(1, 0));
		if (archived.requirement) {
			await mkdir(resolve(directory, "specs/probe-cap"), { recursive: true });
			await Bun.write(
				resolve(directory, "specs/probe-cap/spec.md"),
				deltaSpec(archived.requirement),
			);
		}
	}
	for (const [capability, requirement] of Object.entries(fixture.specs ?? {})) {
		await mkdir(resolve(base, "specs", capability), { recursive: true });
		await Bun.write(
			resolve(base, "specs", capability, "spec.md"),
			mainSpec(requirement),
		);
	}
}

function git(root: string, ...args: string[]): number {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		env: { PATH: process.env["PATH"] ?? "", HOME: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode ?? 1;
}

/**
 * A synthetic repository the guard can walk for real.
 *
 * It is a Git repository because the enumeration cross-checks every root
 * against the index, and it carries the guard's own wiring — the two script
 * paths and the package script — because the contract asserts that something
 * actually runs it. A fixture missing those would fail for the wrong reason.
 */
async function repository(fixtures: RootFixture[] = []): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-openspec-"));
	await mkdir(resolve(root, "scripts/template"), { recursive: true });
	for (const path of [
		"scripts/template/openspec-contract.ts",
		"scripts/template/validate-openspec.ts",
	])
		await Bun.write(resolve(root, path), "export const placeholder = 1;\n");
	await Bun.write(
		resolve(root, "package.json"),
		`${JSON.stringify(
			{
				name: "synthetic",
				workspaces: { catalog: { "@fission-ai/openspec": "0.19.0" } },
				scripts: {
					"openspec:check": "bun scripts/template/validate-openspec.ts",
				},
			},
			null,
			"\t",
		)}\n`,
	);
	for (const fixture of fixtures) await writeRoot(root, fixture);
	git(root, "init", "--quiet");
	git(root, "add", "-A");
	return root;
}

async function withRepository(
	fixtures: RootFixture[],
	body: (root: string) => Promise<void>,
): Promise<void> {
	const root = await repository(fixtures);
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function withFakeCli(
	root: string,
	mode: FakeOpenspecMode,
	body: () => Promise<void>,
): Promise<void> {
	const previous = process.env["OPENSPEC_BIN"];
	process.env["OPENSPEC_BIN"] = await fakeOpenspecCli(root, mode);
	try {
		await body();
	} finally {
		if (previous === undefined) delete process.env["OPENSPEC_BIN"];
		else process.env["OPENSPEC_BIN"] = previous;
	}
}

interface WrapperHarness {
	root: string;
	origin: string;
	home: string;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const GIT_IDENTITY = [
	"-c",
	"user.email=archive@example.invalid",
	"-c",
	"user.name=Archive Fixture",
	"-c",
	"commit.gpgsign=false",
];

function gitOrThrow(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", root, ...GIT_IDENTITY, ...args], {
		env: { PATH: process.env["PATH"] ?? "", HOME: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	return result.stdout.toString();
}

/**
 * A synthetic clone with a real bare origin, and the real wrapper inside it.
 *
 * Both halves are load bearing. Every precondition the wrapper checks is a
 * question about Git — branch, cleanliness, whether `origin/<default>` exists,
 * and whether HEAD is exactly it — so the only honest fixture is a repository
 * with a remote. No container is involved anywhere: `OPENSPEC_BRIDGE=""` is the
 * declared "run in place" value, and every case below refuses before a single
 * bridged call would have been made.
 */
async function wrapperHarness(
	options: {
		changes?: ChangeFixture[];
		/** Which CLI the wrapper finds. `"real"` is the pinned repository binary. */
		cli?: FakeOpenspecMode | "real";
	} = {},
): Promise<WrapperHarness> {
	const changes = options.changes ?? [
		{ name: "probe-one", complete: 2, remaining: 0 },
	];
	const base = await mkdtemp(resolve(tmpdir(), "devenv-archive-"));
	const root = resolve(base, "clone");
	const origin = resolve(base, "origin.git");
	await mkdir(root, { recursive: true });
	await mkdir(resolve(root, "scripts/openspec"), { recursive: true });
	await mkdir(resolve(root, "scripts/template"), { recursive: true });
	await mkdir(resolve(root, ".moon"), { recursive: true });
	await Bun.write(
		resolve(root, ".moon/workspace.yml"),
		[
			"projects:",
			"  sources:",
			"    root: '.'",
			"vcs:",
			"  defaultBranch: 'main'",
			"",
		].join("\n"),
	);
	await Bun.write(resolve(root, ".gitignore"), "node_modules/\n");
	await Bun.write(
		resolve(root, "scripts/openspec/archive.sh"),
		Bun.file(resolve(ROOT, "scripts/openspec/archive.sh")),
	);
	await chmod(resolve(root, "scripts/openspec/archive.sh"), 0o755);
	// The real guard, not a stand-in: the wrapper re-runs `openspec:check` on the
	// archived tree before it commits, and a fixture that faked that step would
	// prove nothing about the one validation that gates the commit.
	for (const name of ["openspec-contract.ts", "validate-openspec.ts"]) {
		await Bun.write(
			resolve(root, "scripts/template", name),
			Bun.file(resolve(ROOT, "scripts/template", name)),
		);
	}
	await Bun.write(
		resolve(root, "package.json"),
		`${JSON.stringify(
			{
				name: "synthetic",
				workspaces: { catalog: { "@fission-ai/openspec": "0.19.0" } },
				scripts: {
					"openspec:check": "bun scripts/template/validate-openspec.ts",
				},
			},
			null,
			"\t",
		)}\n`,
	);
	await writeRoot(root, { changes });
	if (options.cli === "real") {
		// A shim rather than a copied binary: it has to live inside this fixture's
		// own node_modules, because the guard refuses a CLI anywhere else.
		const shim = resolve(root, "node_modules/.bin/openspec");
		await mkdir(resolve(root, "node_modules/.bin"), { recursive: true });
		await Bun.write(
			shim,
			`#!/usr/bin/env bash\nexec node ${resolve(ROOT, "node_modules/@fission-ai/openspec/bin/openspec.js")} "$@"\n`,
		);
		await chmod(shim, 0o755);
	} else if (options.cli) {
		await fakeOpenspecCli(root, options.cli);
	}
	Bun.spawnSync(
		["git", "init", "--quiet", "--bare", "--initial-branch=main", origin],
		{
			env: { PATH: process.env["PATH"] ?? "", HOME: base },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	gitOrThrow(root, "init", "--quiet", "--initial-branch=main");
	gitOrThrow(root, "add", "-A");
	gitOrThrow(root, "commit", "--quiet", "--no-verify", "-m", "chore: fixture");
	gitOrThrow(root, "config", "user.email", "archive@example.invalid");
	gitOrThrow(root, "config", "user.name", "Archive Fixture");
	gitOrThrow(root, "remote", "add", "origin", origin);
	gitOrThrow(root, "push", "--quiet", "-u", "origin", "main");
	return { root, origin, home: base };
}

/**
 * Every outcome the wrapper documents, and the exit code that reports it.
 *
 * The list is the point rather than the individual cases: a refusal that has a
 * documented code and no test is a refusal nobody has seen happen, and a code
 * the suite triggers but the usage block does not mention is a number an
 * operator has to guess at. The final test in this file closes both directions.
 */
const REFUSAL_MATRIX: ReadonlyArray<{ code: number; meaning: string }> = [
	{ code: 0, meaning: "archived (or, with --dry-run, reported)" },
	{ code: 2, meaning: "unsupported argument" },
	{
		code: 3,
		meaning:
			"wrong environment: a Codex Cloud task or inside the development container",
	},
	{ code: 4, meaning: "this checkout's container is not ready" },
	{ code: 5, meaning: "a git precondition refused the run" },
	{ code: 6, meaning: "the change selection is ambiguous or unknown" },
	{ code: 7, meaning: "the change still has remaining tasks" },
	{ code: 8, meaning: "the archive destination is already occupied" },
	{ code: 9, meaning: "the archive did not verify and was rolled back" },
	{ code: 10, meaning: "the push was refused" },
	{ code: 11, meaning: "the push did not verify against the remote" },
];

const OBSERVED_EXIT_CODES = new Set<number>();

function runWrapper(
	harness: WrapperHarness,
	args: string[] = ["--dry-run"],
	overrides: Record<string, string> = {},
): RunResult {
	const result = Bun.spawnSync(
		["bash", resolve(harness.root, "scripts/openspec/archive.sh"), ...args],
		{
			cwd: harness.root,
			// A deliberately narrow environment: the wrapper branches on
			// CODEX_CLOUD and DEVCONTAINER, so inheriting the ambient environment
			// would make these tests pass or fail depending on where they run.
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: harness.home,
				LANG: "C",
				OPENSPEC_BRIDGE: "",
				...overrides,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const exitCode = result.exitCode ?? 1;
	OBSERVED_EXIT_CODES.add(exitCode);
	return {
		exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

/** Every tracked and untracked path plus HEAD, so "nothing changed" is checkable. */
function treeState(root: string): string {
	const listing = Bun.spawnSync(
		["git", "-C", root, "status", "--porcelain", "--untracked-files=all"],
		{ env: { PATH: process.env["PATH"] ?? "", HOME: root }, stdout: "pipe" },
	).stdout.toString();
	const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
		env: { PATH: process.env["PATH"] ?? "", HOME: root },
		stdout: "pipe",
	}).stdout.toString();
	const files = Bun.spawnSync(
		["find", resolve(root, "openspec"), "-type", "f"],
		{ stdout: "pipe" },
	).stdout.toString();
	return `${listing}\n${head}\n${files.split("\n").sort().join("\n")}`;
}

async function withWrapper(
	body: (harness: WrapperHarness) => Promise<void>,
	options: {
		changes?: ChangeFixture[];
		cli?: FakeOpenspecMode | "real";
	} = {},
): Promise<void> {
	const harness = await wrapperHarness(options);
	try {
		await body(harness);
	} finally {
		await rm(harness.home, { recursive: true, force: true });
	}
}

/** The change this program is implementing, named once for the assertion below. */
const CHANGE_NAME = "portable-devcontainer-upgrade";

describe("openspec lifecycle contract", () => {
	test("this repository passes both legs against the pinned CLI", async () => {
		const result = await validateOpenspec(ROOT);
		expect(result.errors).toEqual([]);
		expect(result.inspection.roots).toHaveLength(1);
		expect(result.inspection.roots[0]?.directory).toBe("openspec");
		expect(result.inspection.roots[0]?.tracked).toBe(true);
		// The one change appears EXACTLY ONCE across active and archived, and the
		// assertion has that shape for a reason worth writing down. Asserting it
		// is active fails on `main` the moment the post-merge archive lands;
		// asserting it is archived fails inside the pull request that has not
		// merged yet. Neither form survives its own lifecycle. Counting it once
		// across both lists is green before the archive and after it, and it is
		// strictly stronger than either: it also catches the both-active-and-
		// archived state, which `inspectOpenspec` already refuses, so the test
		// and the guard now agree instead of overlapping.
		//
		// What it still protects is the property Stage 9 wrote the original for:
		// a guard run must never be the thing that archives the change, and a
		// change that vanished from both lists is a deletion rather than an
		// archive.
		const root = result.inspection.roots[0];
		const appearances = [
			...(root?.changes ?? []).map((change) => change.name),
			...(root?.archived ?? []).map((change) => change.name),
		].filter((name) => name === CHANGE_NAME);
		expect(appearances).toEqual([CHANGE_NAME]);
	}, 60_000);

	test("the hermetic leg alone is enough for template:validate", async () => {
		const result = await validateOpenspec(ROOT, { cli: false });
		expect(result.errors).toEqual([]);
	});

	test("a tree with no root fails rather than validating nothing", async () => {
		await withRepository([], async (root) => {
			const errors = await validateOpenspecContract(root);
			expect(errors).toContain(
				"openspec: no openspec/config.yaml exists; the lifecycle guard has nothing to validate",
			);
		});
	});

	test("a rendered fixture under tmp/ is not a phantom root", async () => {
		await withRepository(
			[{ changes: [{ name: "probe-one" }] }],
			async (root) => {
				await mkdir(resolve(root, "tmp/generated-fixtures/minimal/openspec"), {
					recursive: true,
				});
				await Bun.write(
					resolve(root, "tmp/generated-fixtures/minimal/openspec/config.yaml"),
					"schema: spec-driven\n",
				);
				expect(
					enumerateOpenspecRoots(root).map((entry) => entry.directory),
				).toEqual(["openspec"]);
				expect(await validateOpenspecContract(root)).toEqual([]);
			},
		);
	});

	test("a second root is enumerated and validated on its own cwd", async () => {
		await withRepository(
			[
				{ changes: [{ name: "probe-one" }] },
				{ at: "packages/sub", changes: [{ name: "probe-two" }] },
			],
			async (root) => {
				git(root, "add", "-A");
				const roots = enumerateOpenspecRoots(root);
				expect(roots.map((entry) => entry.directory)).toEqual([
					"openspec",
					"packages/sub/openspec",
				]);
				expect(roots.map((entry) => entry.workingDirectory)).toEqual([
					".",
					"packages/sub",
				]);
				expect(await validateOpenspecContract(root)).toEqual([]);
				await withFakeCli(root, "faithful", async () => {
					const result = await validateOpenspec(root);
					expect(result.errors).toEqual([]);
				});
			},
		);
	});

	test("an untracked root is named rather than silently accepted", async () => {
		await withRepository(
			[{ changes: [{ name: "probe-one" }] }],
			async (root) => {
				await writeRoot(root, {
					at: "packages/sub",
					changes: [{ name: "two" }],
				});
				const errors = await validateOpenspecContract(root);
				expect(errors).toContain(
					"openspec: packages/sub/openspec/config.yaml is not tracked by git",
				);
			},
		);
	});

	test("a change missing a required artifact is named per file", async () => {
		await withRepository(
			[{ changes: [{ name: "probe-one", omit: ["proposal.md", "tasks.md"] }] }],
			async (root) => {
				const errors = await validateOpenspecContract(root);
				expect(errors).toContain(
					"openspec: openspec/changes/probe-one is missing proposal.md",
				);
				expect(errors).toContain(
					"openspec: openspec/changes/probe-one is missing tasks.md",
				);
			},
		);
	});

	test("a completed change is a notice, never a failure", async () => {
		await withRepository(
			[{ changes: [{ name: "probe-one", complete: 3, remaining: 0 }] }],
			async (root) => {
				const inspection = await inspectOpenspec(root);
				expect(inspection.errors).toEqual([]);
				expect(inspection.notices).toEqual([
					"openspec: openspec/changes/probe-one has no remaining tasks; archive it with `bash scripts/openspec/archive.sh --change probe-one`",
				]);
				expect(await validateOpenspecContract(root)).toEqual([]);
			},
		);
	});

	describe("archive hygiene", () => {
		test("rejects an entry that is not <YYYY-MM-DD>-<change>", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [{ entry: "probe-two" }],
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: openspec/changes/archive/probe-two must be named <YYYY-MM-DD>-<change>",
					);
				},
			);
		});

		test("rejects an archive date that has not happened in UTC", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [{ entry: "2999-01-01-probe-two" }],
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: openspec/changes/archive/2999-01-01-probe-two carries the unusable archive date 2999-01-01",
					);
				},
			);
		});

		test("rejects an impossible calendar date", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [{ entry: "2026-02-31-probe-two" }],
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: openspec/changes/archive/2026-02-31-probe-two carries the unusable archive date 2026-02-31",
					);
				},
			);
		});

		test("rejects a change that is both active and archived", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [{ entry: "2026-01-02-probe-one" }],
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: probe-one is both an active change and archived at openspec/changes/archive/2026-01-02-probe-one",
					);
				},
			);
		});

		test("rejects an archive nested inside the archive", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await mkdir(resolve(root, "openspec/changes/archive/archive"), {
						recursive: true,
					});
					await Bun.write(
						resolve(root, "openspec/changes/archive/archive/.keep"),
						"",
					);
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: openspec/changes/archive/archive nests an archive inside the archive",
					);
				},
			);
		});

		test("rejects an empty archive entry", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await mkdir(
						resolve(root, "openspec/changes/archive/2026-01-02-probe-two"),
						{ recursive: true },
					);
					expect(await validateOpenspecContract(root)).toContain(
						"openspec: openspec/changes/archive/2026-01-02-probe-two is an empty archive entry",
					);
				},
			);
		});

		test("rejects an archived ADDED requirement that never reached the main specs", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [
							{
								entry: "2026-01-02-probe-two",
								requirement: "Probe Requirement",
							},
						],
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toContain(
						'openspec: openspec/changes/archive/2026-01-02-probe-two archived the ADDED requirement "Probe Requirement" that never reached openspec/specs/probe-cap/spec.md',
					);
				},
			);
		});

		test("accepts an archived requirement the main specs carry", async () => {
			await withRepository(
				[
					{
						changes: [{ name: "probe-one" }],
						archived: [
							{
								entry: "2026-01-02-probe-two",
								requirement: "Probe Requirement",
							},
						],
						specs: { "probe-cap": "Probe Requirement" },
					},
				],
				async (root) => {
					expect(await validateOpenspecContract(root)).toEqual([]);
				},
			);
		});
	});

	describe("anti-vacuity against a lying CLI", () => {
		test("a CLI that validates nothing fails the root", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "zero-items", async () => {
						const result = await validateOpenspec(root);
						expect(result.errors).toContain(
							"openspec: the CLI does not report the validated item probe-one, which openspec contains",
						);
						expect(result.errors).toContain(
							"openspec: `openspec validate --all` in . counted 0 items where openspec declares 1",
						);
					});
				},
			);
		});

		test("a root with nothing in it is a failure, not a pass", async () => {
			await withRepository([{}], async (root) => {
				await withFakeCli(root, "faithful", async () => {
					const result = await validateOpenspec(root);
					expect(result.errors).toContain(
						"openspec: openspec declares no change and no spec; the guard would validate nothing",
					);
				});
			});
		});

		test("an item the tree does not contain is named", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "phantom-item", async () => {
						const result = await validateOpenspec(root);
						expect(result.errors).toContain(
							"openspec: the CLI reports the validated item a-change-nobody-wrote in ., which openspec does not contain",
						);
					});
				},
			);
		});

		test("a CLI whose version is not the pin is refused", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "wrong-version", async () => {
						const result = await validateOpenspec(root);
						expect(
							result.errors.some((error) =>
								error.includes(
									"reports 0.18.0, but this repository pins 0.19.0",
								),
							),
						).toBe(true);
					});
				},
			);
		});

		test("a binary outside this repository's node_modules is not a pin", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					const outside = await mkdtemp(
						resolve(tmpdir(), "devenv-openspec-bin-"),
					);
					const previous = process.env["OPENSPEC_BIN"];
					process.env["OPENSPEC_BIN"] = await fakeOpenspecCli(
						outside,
						"faithful",
					);
					try {
						const result = await validateOpenspec(root);
						expect(
							result.errors.some((error) =>
								error.includes("a global CLI is not a pin"),
							),
						).toBe(true);
					} finally {
						if (previous === undefined) delete process.env["OPENSPEC_BIN"];
						else process.env["OPENSPEC_BIN"] = previous;
						await rm(outside, { recursive: true, force: true });
					}
				},
			);
		});

		test("output that is not JSON is a failure, never an empty answer", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "malformed", async () => {
						const result = await validateOpenspec(root);
						expect(result.errors).toContain(
							"openspec: `openspec list --json` in . did not produce JSON",
						);
					});
				},
			);
		});

		test("a non-zero exit is a failure with the CLI's own last line", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "nonzero", async () => {
						const result = await validateOpenspec(root);
						expect(result.errors).toContain(
							"openspec: `openspec list --json` in . exited 1: boom",
						);
					});
				},
			);
		});

		test("a prompt that waits for an answer terminates instead of hanging", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					await withFakeCli(root, "prompt-hang", async () => {
						const result = await validateOpenspec(root);
						expect(
							result.errors.some((error) =>
								error.includes("aborted: no change selected"),
							),
						).toBe(true);
					});
				},
			);
		}, 30_000);

		test("a missing CLI is named with the command that installs it", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					const previous = process.env["OPENSPEC_BIN"];
					delete process.env["OPENSPEC_BIN"];
					try {
						const result = await validateOpenspec(root);
						expect(
							result.errors.some((error) =>
								error.includes("run `bun install`"),
							),
						).toBe(true);
					} finally {
						if (previous !== undefined) process.env["OPENSPEC_BIN"] = previous;
					}
				},
			);
		});
	});

	describe("the archive wrapper refuses before it touches anything", () => {
		// Every case asserts two things: the exact refusal, and that the tree is
		// byte-for-byte what it was. A guard that refuses AFTER moving a directory
		// has not refused — it has failed halfway.
		async function refuses(
			harness: WrapperHarness,
			args: string[],
			overrides: Record<string, string>,
			exitCode: number,
			fragment: string,
		): Promise<void> {
			const before = treeState(harness.root);
			const result = runWrapper(harness, args, overrides);
			expect(result.stderr).toContain(fragment);
			expect(result.exitCode).toBe(exitCode);
			expect(treeState(harness.root)).toBe(before);
		}

		test("an unsupported argument prints usage and runs nothing", async () => {
			await withWrapper(async (harness) => {
				await refuses(harness, ["--force"], {}, 2, "Usage:");
			});
		});

		test("a Codex Cloud task is refused before any git work", async () => {
			await withWrapper(async (harness) => {
				await refuses(
					harness,
					["--dry-run"],
					{ CODEX_CLOUD: "true" },
					3,
					"a Codex Cloud task must not archive",
				);
			});
		});

		test("running inside the development container is refused", async () => {
			await withWrapper(async (harness) => {
				await refuses(
					harness,
					["--dry-run"],
					{ DEVCONTAINER: "true" },
					3,
					"run this on the host, not inside the development container",
				);
			});
		});

		test("a container that is not ready refuses instead of stranding an archive", async () => {
			await withWrapper(async (harness) => {
				// The bridge's own exit 7. A `--require-ready` hook refuses the same
				// way, which is exactly why the wrapper preflights: without this
				// check the archive would be applied and then fail at `git commit`.
				const bridge = resolve(harness.root, "not-ready.sh");
				await Bun.write(bridge, "#!/usr/bin/env bash\nexit 7\n");
				await chmod(bridge, 0o755);
				await refuses(
					harness,
					["--dry-run"],
					{ OPENSPEC_BRIDGE: `bash ${bridge}` },
					4,
					"container is not ready; run bash scripts/worktree/up.sh",
				);
			});
		});

		test("a feature branch is refused by name", async () => {
			await withWrapper(async (harness) => {
				gitOrThrow(harness.root, "checkout", "--quiet", "-b", "feat/probe");
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"archive runs on main only; this checkout is on feat/probe",
				);
			});
		});

		test("a modified tracked file is refused", async () => {
			await withWrapper(async (harness) => {
				await Bun.write(
					resolve(harness.root, "openspec/changes/probe-one/proposal.md"),
					`${PROPOSAL}\nedited\n`,
				);
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"the working tree is not clean",
				);
			});
		});

		test("an untracked file is refused", async () => {
			await withWrapper(async (harness) => {
				await Bun.write(resolve(harness.root, "stray.txt"), "stray\n");
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"the working tree is not clean",
				);
			});
		});

		test("a dirty graphify-out names both ways out", async () => {
			await withWrapper(async (harness) => {
				await mkdir(resolve(harness.root, "graphify-out"), { recursive: true });
				await Bun.write(
					resolve(harness.root, "graphify-out/graph.json"),
					"{}\n",
				);
				const result = runWrapper(harness);
				expect(result.exitCode).toBe(5);
				expect(result.stderr).toContain("git restore graphify-out");
				expect(result.stderr).toContain("git stash");
			});
		});

		test("a missing origin ref is refused", async () => {
			await withWrapper(async (harness) => {
				gitOrThrow(harness.root, "remote", "remove", "origin");
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"origin/main does not exist in this clone",
				);
			});
		});

		test("a stale checkout is refused and told how to catch up", async () => {
			await withWrapper(async (harness) => {
				const other = resolve(harness.home, "other");
				gitOrThrow(harness.home, "clone", "--quiet", harness.origin, other);
				await Bun.write(resolve(other, "advance.txt"), "advance\n");
				gitOrThrow(other, "add", "-A");
				gitOrThrow(
					other,
					"commit",
					"--quiet",
					"--no-verify",
					"-m",
					"chore: advance",
				);
				gitOrThrow(other, "push", "--quiet", "origin", "main");
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"HEAD is behind origin/main; run `git pull --ff-only`",
				);
			});
		});

		test("an unpushed local commit is refused", async () => {
			await withWrapper(async (harness) => {
				await Bun.write(resolve(harness.root, "local.txt"), "local\n");
				gitOrThrow(harness.root, "add", "-A");
				gitOrThrow(
					harness.root,
					"commit",
					"--quiet",
					"--no-verify",
					"-m",
					"chore: local",
				);
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"HEAD is ahead of origin/main",
				);
			});
		});

		test("a diverged checkout is refused", async () => {
			await withWrapper(async (harness) => {
				const other = resolve(harness.home, "other");
				gitOrThrow(harness.home, "clone", "--quiet", harness.origin, other);
				await Bun.write(resolve(other, "remote.txt"), "remote\n");
				gitOrThrow(other, "add", "-A");
				gitOrThrow(
					other,
					"commit",
					"--quiet",
					"--no-verify",
					"-m",
					"chore: remote",
				);
				gitOrThrow(other, "push", "--quiet", "origin", "main");
				await Bun.write(resolve(harness.root, "local.txt"), "local\n");
				gitOrThrow(harness.root, "add", "-A");
				gitOrThrow(
					harness.root,
					"commit",
					"--quiet",
					"--no-verify",
					"-m",
					"chore: local",
				);
				await refuses(
					harness,
					["--dry-run"],
					{},
					5,
					"HEAD and origin/main have diverged",
				);
			});
		});

		test("more than one active change demands an explicit selection", async () => {
			await withWrapper(
				async (harness) => {
					const result = runWrapper(harness);
					expect(result.exitCode).toBe(6);
					expect(result.stderr).toContain(
						"pass --change <name> to say which one",
					);
					expect(result.stderr).toContain("openspec -> probe-one");
					expect(result.stderr).toContain("openspec -> probe-two");
				},
				{
					changes: [
						{ name: "probe-one", complete: 1, remaining: 0 },
						{ name: "probe-two", complete: 1, remaining: 0 },
					],
				},
			);
		});

		test("an unknown change name is refused and the real ones are listed", async () => {
			await withWrapper(async (harness) => {
				await refuses(
					harness,
					["--change", "not-a-change", "--dry-run"],
					{},
					6,
					"no active change named not-a-change",
				);
			});
		});

		test("an unknown --root is refused", async () => {
			await withWrapper(async (harness) => {
				await refuses(
					harness,
					["--root", "packages/nope", "--dry-run"],
					{},
					6,
					"is not an OpenSpec root in this checkout",
				);
			});
		});
	});

	describe("the archive wrapper publishes only after it has verified", () => {
		function originHead(harness: WrapperHarness): string {
			return gitOrThrow(harness.origin, "rev-parse", "refs/heads/main").trim();
		}

		test("a complete change is archived, validated, committed and pushed", async () => {
			await withWrapper(
				async (harness) => {
					const before = originHead(harness);
					const result = runWrapper(harness, []);
					expect(result.stderr).not.toContain("restoring");
					expect(result.exitCode).toBe(0);
					const date = new Date().toISOString().slice(0, 10);
					const destination = resolve(
						harness.root,
						`openspec/changes/archive/${date}-probe-one`,
					);
					expect(
						await Bun.file(resolve(destination, "proposal.md")).exists(),
					).toBe(true);
					expect(
						await Bun.file(
							resolve(harness.root, "openspec/changes/probe-one/proposal.md"),
						).exists(),
					).toBe(false);
					// The delta spec reached the main specs, which is the half of an
					// archive that is not a directory move.
					expect(
						await Bun.file(
							resolve(harness.root, "openspec/specs/probe-cap/spec.md"),
						).text(),
					).toContain("### Requirement: Probe Requirement");
					expect(
						gitOrThrow(harness.root, "log", "-1", "--format=%s").trim(),
					).toBe("chore(openspec): archive probe-one");
					// Only the OpenSpec root is in the commit.
					const changed = gitOrThrow(
						harness.root,
						"show",
						"--name-only",
						"--format=",
						"HEAD",
					)
						.split("\n")
						.filter(Boolean);
					expect(changed.length).toBeGreaterThan(0);
					for (const path of changed)
						expect(path.startsWith("openspec/")).toBe(true);
					expect(originHead(harness)).not.toBe(before);
					expect(originHead(harness)).toBe(
						gitOrThrow(harness.root, "rev-parse", "HEAD").trim(),
					);
					expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
				},
				{
					cli: "faithful",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a dry run reports and never reaches the write or the readback", async () => {
			await withWrapper(
				async (harness) => {
					const before = originHead(harness);
					const result = runWrapper(harness, ["--dry-run"]);
					expect(result.exitCode).toBe(0);
					expect(result.stdout).toContain("--dry-run, nothing was changed");
					// Zero network mutations and zero readbacks: the dry run exits
					// before the archive, so neither the push nor the query that
					// verifies it is ever reached, and the remote is untouched.
					expect(result.stderr).not.toContain("did not verify");
					expect(originHead(harness)).toBe(before);
					expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
					expect(
						await Bun.file(
							resolve(harness.root, "openspec/changes/probe-one/proposal.md"),
						).exists(),
					).toBe(true);
				},
				{
					cli: "faithful",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a push the remote did not keep is refused rather than reported", async () => {
			await withWrapper(
				async (harness) => {
					// A remote that accepts the pack and then holds something else.
					// The pusher sees a zero exit status either way, which is exactly
					// why a zero exit status is not the claim the wrapper makes.
					const hook = resolve(harness.origin, "hooks/post-receive");
					await mkdir(dirname(hook), { recursive: true });
					await Bun.write(
						hook,
						"#!/usr/bin/env bash\ngit update-ref refs/heads/main refs/heads/main^\n",
					);
					await chmod(hook, 0o755);
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(11);
					expect(result.stderr).toContain(
						"the archive push did not verify against the remote",
					);
					// The self-healing menu, in the same shape the rejection arm
					// already prints: the commit is kept and every way out is named.
					expect(result.stderr).toContain("is kept locally. Choose one:");
					expect(result.stderr).toContain(
						"discard it:           git reset --hard origin/main",
					);
					const head = gitOrThrow(harness.root, "rev-parse", "HEAD").trim();
					expect(originHead(harness)).not.toBe(head);
				},
				{
					cli: "faithful",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a second run refuses on the occupied destination", async () => {
			await withWrapper(
				async (harness) => {
					expect(runWrapper(harness, []).exitCode).toBe(0);
					// Re-create the change exactly as it was. The CLI would happily
					// rewrite the main specs and then report the duplicate with exit 0.
					await writeRoot(harness.root, {
						changes: [
							{
								name: "probe-one",
								complete: 2,
								remaining: 0,
								requirement: "Probe Requirement",
							},
						],
					});
					gitOrThrow(harness.root, "add", "-A");
					gitOrThrow(
						harness.root,
						"commit",
						"--quiet",
						"--no-verify",
						"-m",
						"chore: restore",
					);
					gitOrThrow(harness.root, "push", "--quiet", "origin", "main");
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(8);
					expect(result.stderr).toContain(
						"already exists; the CLI would rewrite the main specs and archive nothing",
					);
					expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
				},
				{
					cli: "faithful",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a CLI that exits 0 without moving anything is caught by the post-state", async () => {
			await withWrapper(
				async (harness) => {
					const head = gitOrThrow(harness.root, "rev-parse", "HEAD").trim();
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(9);
					expect(result.stderr).toContain("the CLI exited 0 but");
					expect(result.stderr).toContain(
						"is still there; nothing was archived",
					);
					expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
					expect(gitOrThrow(harness.root, "rev-parse", "HEAD").trim()).toBe(
						head,
					);
					expect(originHead(harness)).toBe(head);
				},
				{ cli: "archive-noop" },
			);
		}, 60_000);

		test("an archive that writes outside the root is refused and rolled back", async () => {
			await withWrapper(
				async (harness) => {
					const head = gitOrThrow(harness.root, "rev-parse", "HEAD").trim();
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(9);
					expect(result.stderr).toContain(
						"the archive touched stray-from-archive.txt, which is outside openspec",
					);
					expect(gitOrThrow(harness.root, "rev-parse", "HEAD").trim()).toBe(
						head,
					);
				},
				{ cli: "archive-strays" },
			);
		}, 60_000);

		test("a validation failure restores the root and commits nothing", async () => {
			await withWrapper(
				async (harness) => {
					const head = gitOrThrow(harness.root, "rev-parse", "HEAD").trim();
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(9);
					expect(result.stderr).toContain(
						"openspec:check failed on the archived tree",
					);
					expect(result.stderr).toContain("restoring openspec to HEAD");
					expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
					expect(gitOrThrow(harness.root, "rev-parse", "HEAD").trim()).toBe(
						head,
					);
					expect(originHead(harness)).toBe(head);
					// The change is back where it was, undamaged.
					expect(
						await Bun.file(
							resolve(harness.root, "openspec/changes/probe-one/proposal.md"),
						).exists(),
					).toBe(true);
				},
				{
					cli: "archive-drops-specs",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a change whose commit subject would not fit is refused before the CLI runs", async () => {
			const name = `probe-${"x".repeat(60)}`;
			await withWrapper(
				async (harness) => {
					const before = treeState(harness.root);
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(6);
					expect(result.stderr).toContain("commitlint caps the header at 72");
					expect(treeState(harness.root)).toBe(before);
				},
				{ cli: "faithful", changes: [{ name, complete: 1, remaining: 0 }] },
			);
		}, 60_000);

		test("an incomplete change is refused with the CLI's own count", async () => {
			await withWrapper(
				async (harness) => {
					const before = treeState(harness.root);
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(7);
					expect(result.stderr).toContain(
						"probe-one still has 3 remaining task(s)",
					);
					expect(treeState(harness.root)).toBe(before);
				},
				{
					cli: "faithful",
					changes: [{ name: "probe-one", complete: 1, remaining: 3 }],
				},
			);
		}, 60_000);

		test("a container-absolute change directory is the same directory", async () => {
			// The defect this case exists for was live, not hypothetical. The
			// wrapper runs on the host and bridges only the CLI call, so the CLI
			// answers from inside the container — where this repository is mounted
			// at /workspace — and the post-check compared that against a host path.
			// Archiving this repository's own change refused with "the CLI reported
			// the change directory /workspace/openspec/changes/…" and had to be run
			// with OPENSPEC_BRIDGE="" to get past a statement that was true.
			await withWrapper(
				async (harness) => {
					const result = runWrapper(harness, ["--dry-run"]);
					expect(result.exitCode).toBe(0);
					expect(result.stdout).toContain("--dry-run, nothing was changed");
					expect(result.stderr).not.toContain("change directory");
				},
				{
					cli: "bridge-change-dir",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a different change directory is still refused, mount point or not", async () => {
			// The other half, and the reason the case above is not an acceptance of
			// everything: the same container-absolute shape, a different change. The
			// tail is what the comparison is made of, so a prefix nobody can resolve
			// buys an answer nothing.
			await withWrapper(
				async (harness) => {
					const before = treeState(harness.root);
					const result = runWrapper(harness, ["--dry-run"]);
					expect(result.exitCode).toBe(7);
					expect(result.stderr).toContain(
						"the CLI reported the change directory /workspace/openspec/changes/probe-one-elsewhere, which does not resolve to openspec/changes/probe-one in the tree the CLI ran in",
					);
					expect(treeState(harness.root)).toBe(before);
				},
				{
					cli: "foreign-change-dir",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);

		test("a rejected push keeps the commit and prints every way out", async () => {
			await withWrapper(
				async (harness) => {
					// Branch protection, locally: the remote refuses the update. The
					// commit must survive, because throwing it away would lose the
					// archive the operator just validated.
					const hook = resolve(harness.origin, "hooks/pre-receive");
					await mkdir(resolve(harness.origin, "hooks"), { recursive: true });
					await Bun.write(
						hook,
						"#!/usr/bin/env bash\necho 'protected branch' >&2\nexit 1\n",
					);
					await chmod(hook, 0o755);
					const before = originHead(harness);
					const result = runWrapper(harness, []);
					expect(result.exitCode).toBe(10);
					expect(result.stderr).toContain("the push was rejected");
					expect(result.stderr).toContain("push it as an administrator");
					expect(result.stderr).toContain(
						"git switch -c chore/archive-probe-one",
					);
					expect(result.stderr).toContain("git reset --hard origin/main");
					expect(
						gitOrThrow(harness.root, "log", "-1", "--format=%s").trim(),
					).toBe("chore(openspec): archive probe-one");
					expect(originHead(harness)).toBe(before);
					// The next run refuses on HEAD != origin/main, which is what makes
					// the recovery self-healing rather than a note nobody reads.
					const second = runWrapper(harness, ["--dry-run"]);
					expect(second.exitCode).toBe(5);
					expect(second.stderr).toContain("HEAD is ahead of origin/main");
				},
				{
					cli: "faithful",
					changes: [
						{
							name: "probe-one",
							complete: 2,
							remaining: 0,
							requirement: "Probe Requirement",
						},
					],
				},
			);
		}, 60_000);
	});

	describe("archive assessment", () => {
		test("computes the destination in UTC, as the CLI does", () => {
			const now = new Date("2026-08-07T03:15:00.000Z");
			expect(archiveEntryName("probe-one", now)).toBe("2026-08-07-probe-one");
		});

		test("reports the delta specs, the destination, and what is unapplied", async () => {
			await withRepository(
				[
					{
						changes: [
							{
								name: "probe-one",
								complete: 2,
								remaining: 0,
								requirement: "Probe Requirement",
							},
						],
					},
				],
				async (root) => {
					const now = new Date("2026-08-07T03:15:00.000Z");
					const assessment = assessArchive(root, "openspec", "probe-one", now);
					expect(assessment.errors).toEqual([]);
					expect(assessment.deltaCapabilities).toEqual(["probe-cap"]);
					expect(assessment.skipSpecs).toBe(false);
					expect(assessment.remainingTasks).toBe(0);
					expect(assessment.destination).toBe(
						"openspec/changes/archive/2026-08-07-probe-one",
					);
					expect(assessment.destinationExists).toBe(false);
					expect(assessment.unappliedRequirements).toEqual([
						{ capability: "probe-cap", requirement: "Probe Requirement" },
					]);
				},
			);
		});

		test("a change with no delta specs is the only case --skip-specs is correct for", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one", complete: 1, remaining: 0 }] }],
				async (root) => {
					const assessment = assessArchive(root, "openspec", "probe-one");
					expect(assessment.deltaCapabilities).toEqual([]);
					expect(assessment.skipSpecs).toBe(true);
				},
			);
		});

		test("an occupied destination is visible before anything is written", async () => {
			const now = new Date("2026-08-07T03:15:00.000Z");
			await withRepository(
				[
					{
						changes: [{ name: "probe-one", complete: 1, remaining: 0 }],
						archived: [{ entry: "2026-08-07-probe-one" }],
					},
				],
				async (root) => {
					const assessment = assessArchive(root, "openspec", "probe-one", now);
					expect(assessment.destinationExists).toBe(true);
				},
			);
		});

		test("an unknown change is refused by name", async () => {
			await withRepository(
				[{ changes: [{ name: "probe-one" }] }],
				async (root) => {
					const assessment = assessArchive(root, "openspec", "nope");
					expect(assessment.errors).toEqual([
						"openspec: nope is not an active change in openspec",
					]);
				},
			);
		});
	});
});

describe("one disposable lifecycle, end to end", () => {
	// The real change in this repository — portable-devcontainer-upgrade — must
	// stay ACTIVE until Stage 11. Nothing here touches it: the whole lifecycle
	// runs in a throwaway clone with its own bare origin, driven by the same
	// pinned CLI through a shim inside that clone's own node_modules.
	test("a merged, complete change is archived, synced, committed and pushed", async () => {
		await withWrapper(
			async (harness) => {
				const originHead = (): string =>
					gitOrThrow(harness.origin, "rev-parse", "refs/heads/main").trim();
				const beforePush = originHead();

				const result = runWrapper(harness, [
					"--change",
					"disposable-archive-probe",
				]);
				expect(result.stderr).not.toContain("restoring");
				expect(result.exitCode).toBe(0);

				const date = new Date().toISOString().slice(0, 10);
				const archived = resolve(
					harness.root,
					`openspec/changes/archive/${date}-disposable-archive-probe`,
				);
				expect(await Bun.file(resolve(archived, "proposal.md")).exists()).toBe(
					true,
				);
				expect(await Bun.file(resolve(archived, "tasks.md")).exists()).toBe(
					true,
				);
				expect(
					await Bun.file(resolve(archived, ".openspec.yaml")).exists(),
				).toBe(true);

				// The half of an archive that is not a directory move: the delta spec's
				// ADDED requirement has to have reached the main specs.
				const mainSpec = await Bun.file(
					resolve(harness.root, "openspec/specs/probe-cap/spec.md"),
				).text();
				expect(mainSpec).toContain("### Requirement: Disposable Probe");

				// The second change is untouched, which is the property that makes this
				// safe to run against a tree with work in flight.
				expect(
					await Bun.file(
						resolve(harness.root, "openspec/changes/still-open/tasks.md"),
					).text(),
				).toBe(
					await Bun.file(
						resolve(harness.root, "openspec/changes/still-open/tasks.md"),
					).text(),
				);
				expect(
					await Bun.file(
						resolve(harness.root, "openspec/changes/still-open/proposal.md"),
					).exists(),
				).toBe(true);

				expect(
					gitOrThrow(harness.root, "log", "-1", "--format=%s").trim(),
				).toBe("chore(openspec): archive disposable-archive-probe");
				expect(originHead()).not.toBe(beforePush);
				expect(originHead()).toBe(
					gitOrThrow(harness.root, "rev-parse", "HEAD").trim(),
				);
				expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");

				// A second run over a re-created change refuses on the destination the
				// first one occupied, before the CLI can rewrite the main specs.
				await writeRoot(harness.root, {
					changes: [
						{
							name: "disposable-archive-probe",
							complete: 2,
							remaining: 0,
							requirement: "Disposable Probe",
						},
					],
				});
				gitOrThrow(harness.root, "add", "-A");
				gitOrThrow(
					harness.root,
					"commit",
					"--quiet",
					"--no-verify",
					"-m",
					"chore: restore the probe",
				);
				gitOrThrow(harness.root, "push", "--quiet", "origin", "main");
				const second = runWrapper(harness, [
					"--change",
					"disposable-archive-probe",
				]);
				expect(second.exitCode).toBe(8);
				expect(second.stderr).toContain(
					`openspec/changes/archive/${date}-disposable-archive-probe already exists`,
				);
				expect(gitOrThrow(harness.root, "status", "--porcelain")).toBe("");
			},
			{
				cli: "real",
				changes: [
					{
						name: "disposable-archive-probe",
						complete: 3,
						remaining: 0,
						requirement: "Disposable Probe",
					},
					{
						name: "still-open",
						complete: 1,
						remaining: 2,
						requirement: "Still Open",
						capability: "still-open-cap",
					},
				],
			},
		);
	}, 120_000);

	test("this repository's own change survived the disposable lifecycle", async () => {
		// The standing constraint, stated as an assertion rather than as care: a
		// probe's lifecycle must never touch this repository's own change.
		//
		// It counts the change ONCE across active and archived, which is the same
		// shape the aggregate leg above uses and for the same reason. Asserting it
		// is active fails on `main` the moment the post-merge archive lands;
		// asserting it is archived fails inside the pull request that has not
		// merged yet. Counting it once is green before the archive and after it,
		// and it still catches the two failures this case exists for — a change
		// the probe deleted, and the both-active-and-archived state.
		const inspection = await inspectOpenspec(ROOT);
		const root = inspection.roots[0];
		const appearances = [
			...(root?.changes ?? []).map((change) => change.name),
			...(root?.archived ?? []).map((change) => change.name),
		].filter((name) => name === "portable-devcontainer-upgrade");
		expect(appearances).toEqual(["portable-devcontainer-upgrade"]);
	});
});

describe("the wrapper's refusal matrix is complete in both directions", () => {
	// Declaration order matters here: this test reads what the cases above
	// observed. Run the file, not a filtered subset.
	test("every documented exit code is documented and exercised", async () => {
		const usage = await Bun.file(
			resolve(ROOT, "scripts/openspec/archive.sh"),
		).text();
		for (const entry of REFUSAL_MATRIX)
			expect(usage).toContain(`${entry.code} ${entry.meaning}`);
		expect(OBSERVED_EXIT_CODES.size).toBeGreaterThan(0);
		expect([...OBSERVED_EXIT_CODES].sort((a, b) => a - b)).toEqual(
			REFUSAL_MATRIX.map((entry) => entry.code).sort((a, b) => a - b),
		);
	});
});

describe("rendered fixtures carry the lifecycle only where it is enabled", () => {
	const OPENSPEC_SURFACE = [
		"openspec/config.yaml",
		"scripts/openspec/archive.sh",
		"scripts/template/openspec-contract.ts",
		"scripts/template/validate-openspec.ts",
		"scripts/template/agent-rules/archive-delegation.md",
		".claude/commands/opsx/archive.md",
		".claude/skills/openspec-archive-change/SKILL.md",
	];

	test("minimal receives the whole surface and cloud receives none of it", async () => {
		const temporary = await mkdtemp(
			resolve(tmpdir(), "devenv-openspec-render-"),
		);
		try {
			for (const fixtureName of ["minimal", "cloud"]) {
				await renderFixture({
					root: ROOT,
					fixtureName,
					output: resolve(temporary, fixtureName),
				});
			}
			const minimal = resolve(temporary, "minimal");
			const cloud = resolve(temporary, "cloud");
			for (const path of OPENSPEC_SURFACE) {
				expect(
					`minimal:${path}:${await Bun.file(resolve(minimal, path)).exists()}`,
				).toBe(`minimal:${path}:true`);
				expect(
					`cloud:${path}:${await Bun.file(resolve(cloud, path)).exists()}`,
				).toBe(`cloud:${path}:false`);
			}

			// The fenced step and the package script have to move together: the
			// render test that walks `bun run <script>` in a workflow would
			// otherwise pass while the rendered project had no such script.
			const minimalPackage = await Bun.file(
				resolve(minimal, "package.json"),
			).json();
			const cloudPackage = await Bun.file(
				resolve(cloud, "package.json"),
			).json();
			expect(minimalPackage.scripts["openspec:check"]).toBe(
				"bun scripts/template/validate-openspec.ts",
			);
			expect(cloudPackage.scripts["openspec:check"]).toBeUndefined();
			// `rules:check` is core and belongs to every project.
			for (const rendered of [minimalPackage, cloudPackage]) {
				expect(rendered.scripts["rules:check"]).toBe(
					"bun scripts/template/validate-agent-rules.ts",
				);
				expect(rendered.scripts["rules:sync"]).toBe(
					"bun scripts/template/sync-agent-rules.ts",
				);
			}
			const minimalCi = await Bun.file(
				resolve(minimal, ".github/workflows/ci.yml"),
			).text();
			const cloudCi = await Bun.file(
				resolve(cloud, ".github/workflows/ci.yml"),
			).text();
			expect(minimalCi).toContain("bun run openspec:check");
			expect(cloudCi).not.toContain("openspec:check");
			for (const workflow of [minimalCi, cloudCi])
				expect(workflow).toContain("bun run rules:check");

			// The cloud fixture's agent rule files lose the canonical block and its
			// mirrors together, which is what lets `rules:check` stay ungated.
			for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
				expect(
					`${file}:${(await Bun.file(resolve(cloud, file)).text()).includes("OpenSpec Lifecycle Ownership")}`,
				).toBe(`${file}:false`);
				expect(
					`${file}:${(await Bun.file(resolve(minimal, file)).text()).includes("OpenSpec Lifecycle Ownership")}`,
				).toBe(`${file}:true`);
			}

			// A10: the graphify mirror blocks are fenced now, so a project without
			// graphify carries none of their prose in any agent rule file. The
			// remaining `Graphify` mentions in the image-ownership rules are a
			// separate surface whose capability signature is deferred to Stage 11.
			for (const file of [
				"AGENTS.md",
				"CLAUDE.md",
				"GEMINI.md",
				".claude/CLAUDE.md",
			]) {
				const source = await Bun.file(resolve(minimal, file)).text();
				for (const token of [
					"graphify query",
					"graphify update",
					"graphify-out/",
					'invoke the Skill tool with `skill: "graphify"`',
				])
					expect(`${file}:${token}:${source.includes(token)}`).toBe(
						`${file}:${token}:false`,
					);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);

	test("a leaked wrapper in the cloud render is named by the residue scan", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-openspec-leak-"));
		try {
			const output = resolve(temporary, "cloud");
			await renderFixture({ root: ROOT, fixtureName: "cloud", output });
			await mkdir(resolve(output, "scripts/openspec"), { recursive: true });
			await Bun.write(
				resolve(output, "scripts/openspec/archive.sh"),
				"#!/usr/bin/env bash\nexit 0\n",
			);
			const parameters = await loadTemplateParameters(ROOT);
			const fixture = await loadFixtureDefinition(ROOT, "cloud", parameters);
			const resolved = resolveFixtureParameters(parameters, fixture);
			const ownership = await loadTemplateOwnership(ROOT);
			const report = await scanDisabledResidue(output, resolved, ownership);
			expect(report.status).toBe("fail");
			expect(report.findings).toContainEqual({
				capability: "openspec",
				path: "scripts/openspec/archive.sh",
				signature: "scripts/openspec/**",
				kind: "path",
			});
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("the readback is ordered, bound and never superseded", () => {
	/**
	 * A directory carrying only what `validateWrapperPolicy` reads.
	 *
	 * The rules under test are statements about the wrapper's own text — where
	 * the readback sits relative to the push, whether its result is bound, and
	 * whether that binding is ever overwritten — so a fixture that needed a
	 * remote would be testing something else.
	 */
	async function wrapperOnly(
		transform: (source: string) => string,
	): Promise<string> {
		const root = await mkdtemp(resolve(tmpdir(), "devenv-readback-"));
		await mkdir(resolve(root, "scripts/openspec"), { recursive: true });
		const source = await Bun.file(
			resolve(ROOT, "scripts/openspec/archive.sh"),
		).text();
		const changed = transform(source);
		// A mutation that silently stopped matching would pass as a green run of
		// the unmutated file, which is the one outcome this whole block exists to
		// make impossible.
		if (changed === source)
			throw new Error("Mutation did not change scripts/openspec/archive.sh");
		await Bun.write(resolve(root, "scripts/openspec/archive.sh"), changed);
		await Bun.write(
			resolve(root, "package.json"),
			`${JSON.stringify({ name: "synthetic", scripts: {} }, null, "\t")}\n`,
		);
		return root;
	}

	async function withWrapperOnly(
		transform: (source: string) => string,
		body: (root: string) => Promise<void>,
	): Promise<void> {
		const root = await wrapperOnly(transform);
		try {
			await body(root);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}

	const READBACK_LINE =
		'REMOTE_AFTER="$(git ls-remote --exit-code origin "refs/heads/$DEFAULT_BRANCH" 2>/dev/null | awk \'{ print $1 }\' || true)"\n';

	test("the committed wrapper satisfies every readback rule", async () => {
		expect(await validateWrapperPolicy(ROOT)).toEqual([]);
	});

	test("a readback that precedes the push establishes nothing about it", async () => {
		await withWrapperOnly(
			(source) =>
				source
					.replace(READBACK_LINE, "")
					.replace("# ── 9. Push ", `${READBACK_LINE}# ── 9. Push `),
			async (root) => {
				expect(await validateWrapperPolicy(root)).toContain(
					"openspec: scripts/openspec/archive.sh reads the remote back before it pushes; a query that precedes the write establishes nothing about it",
				);
			},
		);
	});

	test("a commented-out readback is not a readback", async () => {
		await withWrapperOnly(
			(source) => source.replace(READBACK_LINE, `# ${READBACK_LINE}`),
			async (root) => {
				expect(await validateWrapperPolicy(root)).toContain(
					"openspec: scripts/openspec/archive.sh must read the remote back with `git ls-remote --exit-code origin` after it pushes",
				);
			},
		);
	});

	test("a readback assigned and then overwritten is refused by name", async () => {
		await withWrapperOnly(
			(source) =>
				source.replace(
					READBACK_LINE,
					`${READBACK_LINE}REMOTE_AFTER="$ARCHIVE_COMMIT"\n`,
				),
			async (root) => {
				expect(await validateWrapperPolicy(root)).toContain(
					"openspec: scripts/openspec/archive.sh assigns REMOTE_AFTER 2 times; a superseded readback compares a value the remote never produced",
				);
			},
		);
	});

	test("a readback nobody binds is a query nobody asked", async () => {
		await withWrapperOnly(
			(source) =>
				source.replace(
					READBACK_LINE,
					'git ls-remote --exit-code origin "refs/heads/$DEFAULT_BRANCH" >/dev/null\nREMOTE_AFTER="$ARCHIVE_COMMIT"\n',
				),
			async (root) => {
				expect(await validateWrapperPolicy(root)).toContain(
					"openspec: scripts/openspec/archive.sh runs the readback without binding its result; a query nobody compares is a query nobody asked",
				);
			},
		);
	});

	test("a quoted # survives the comment stripper", () => {
		// The wrapper carries `${#COMMIT_SUBJECT}` inside a double-quoted message.
		// A stripper that cut at the first `#` would delete the rest of that line
		// and change what every ordering index above means.
		const stripped = shellCode(
			'die "the subject \\"$S\\" is ${#S} characters" 6 # explain\nkeep=1\n',
		);
		expect(stripped).toContain("${#S} characters");
		expect(stripped).not.toContain("explain");
		expect(stripped).toContain("keep=1");
	});
});
