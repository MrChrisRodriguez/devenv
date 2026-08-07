// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	archiveEntryName,
	assessArchive,
	enumerateOpenspecRoots,
	inspectOpenspec,
	validateOpenspecContract,
} from "../openspec-contract";
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

function deltaSpec(requirement: string): string {
	return [
		"# probe-cap",
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
			await mkdir(resolve(directory, "specs/probe-cap"), { recursive: true });
			await Bun.write(
				resolve(directory, "specs/probe-cap/spec.md"),
				deltaSpec(change.requirement),
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
	changes: ChangeFixture[] = [{ name: "probe-one", complete: 2, remaining: 0 }],
): Promise<WrapperHarness> {
	const base = await mkdtemp(resolve(tmpdir(), "devenv-archive-"));
	const root = resolve(base, "clone");
	const origin = resolve(base, "origin.git");
	await mkdir(root, { recursive: true });
	await mkdir(resolve(root, "scripts/openspec"), { recursive: true });
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
	await Bun.write(
		resolve(root, "scripts/openspec/archive.sh"),
		Bun.file(resolve(ROOT, "scripts/openspec/archive.sh")),
	);
	await chmod(resolve(root, "scripts/openspec/archive.sh"), 0o755);
	await writeRoot(root, { changes });
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
	gitOrThrow(root, "remote", "add", "origin", origin);
	gitOrThrow(root, "push", "--quiet", "-u", "origin", "main");
	return { root, origin, home: base };
}

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
	return {
		exitCode: result.exitCode ?? 1,
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
	changes?: ChangeFixture[],
): Promise<void> {
	const harness = await wrapperHarness(changes);
	try {
		await body(harness);
	} finally {
		await rm(harness.home, { recursive: true, force: true });
	}
}

describe("openspec lifecycle contract", () => {
	test("this repository passes both legs against the pinned CLI", async () => {
		const result = await validateOpenspec(ROOT);
		expect(result.errors).toEqual([]);
		expect(result.inspection.roots).toHaveLength(1);
		expect(result.inspection.roots[0]?.directory).toBe("openspec");
		expect(result.inspection.roots[0]?.tracked).toBe(true);
		// The one active change stays active through Stage 11. A guard run must
		// never be the thing that archives it.
		expect(
			result.inspection.roots[0]?.changes.map((change) => change.name),
		).toEqual(["portable-devcontainer-upgrade"]);
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
				[
					{ name: "probe-one", complete: 1, remaining: 0 },
					{ name: "probe-two", complete: 1, remaining: 0 },
				],
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
