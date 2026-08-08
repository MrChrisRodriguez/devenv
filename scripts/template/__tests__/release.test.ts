import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadTemplateParameters } from "../parameters";
import {
	ACCEPTANCE_ITEMS,
	BUDGET_FAMILIES,
	classifyGoldenDrift,
	declaredFixtures,
	declaredPorts,
	forbiddenIdentifierTokens,
	GOLDEN_ROOT,
	type GoldenFile,
	GUARD_SCRIPT,
	inspectReleaseContract,
	type ReleaseRegistry,
	readReleaseRegistry,
	reconcileDecision,
	SCAN_IDS,
	type ScanSurface,
	SYNC_SCRIPT,
	scanSurface,
	shellCaseExcludes,
	skillDirectories,
	TEMPLATE_ONLY_PATHS,
	templateOnlyBlockOf,
	validateAcceptance,
	validateAgentSections,
	validateBudgets,
	validateCapabilityInventory,
	validateDeferrals,
	validateGoldens,
	validateOwnership,
	validateReleaseContract,
	validateScans,
	validateSignals,
	validateSoleDeclarations,
	validateSyncBoundary,
	validateTopLevelWorkspaces,
	validateVersionAuthorities,
	validateWiring,
} from "../release-contract";
import { renderFixture } from "../render-fixture";
import {
	COMMITTED,
	MANIFEST_PATH,
	OWNERSHIP_PATH,
	ROOT,
	registryWith,
	releaseWorkspace,
	VALIDATOR_PATH,
	WORKFLOW_PATH,
	withMutatedFile,
	writeFiles,
} from "./fixtures/release-workspaces";

/** A wiring or ownership file edited inside a synthetic workspace. */
async function inWorkspace(
	path: string,
	transform: (source: string) => string,
	leg: (root: string) => Promise<string[]>,
	expected: string,
): Promise<void> {
	const root = await releaseWorkspace();
	try {
		expect(await leg(root)).toEqual([]);
		const target = resolve(root, path);
		const original = await Bun.file(target).text();
		const changed = transform(original);
		if (changed === original)
			throw new Error(`Mutation did not change ${path}`);
		await Bun.write(target, changed);
		expect(await leg(root)).toContain(expected);
		await Bun.write(target, original);
		expect(await leg(root)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The needles, read from the definitions exactly as the guard reads them. */
const SCAN_CONTEXT = {
	identifierTokens: forbiddenIdentifierTokens(
		await Bun.file(resolve(ROOT, "scripts/template/render-fixture.ts")).text(),
	),
	ports: declaredPorts(await loadTemplateParameters(ROOT)),
};

/**
 * This tree's own HEAD, which is the one commit the signal cases can rely on
 * NOT being contained by v1.0.0 — every tree they run in descends from the tag.
 */
const HEAD_SHA = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"])
	.stdout.toString()
	.trim();

describe("the release gate registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateReleaseContract(ROOT)).toEqual([]);
		const { registry, errors } = await readReleaseRegistry(ROOT);
		expect(errors).toEqual([]);
		expect(registry?.schemaVersion).toBe(1);
		// The pull request that introduced this file shipped `candidate`; the
		// runbook's post-merge step flipped it once v1.0.0 existed. Both halves
		// of that transition are asserted below, so this line pins the state the
		// tree is actually in rather than the one it was born in.
		expect(registry?.decision).toBe("released");
		expect(registry?.release.plannedTag).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(registry?.release.changeName).toBe("portable-devcontainer-upgrade");
		expect(registry?.goldens.regenerateWith).toBe(`bun run ${SYNC_SCRIPT}`);
	}, 60_000);

	test("declares a golden for every fixture and pins a non-empty file count", async () => {
		const registry = COMMITTED;
		const fixtures = declaredFixtures(ROOT);
		// Anti-vacuity, in the place it is easiest to lose. A release gate over
		// zero fixtures, or over goldens that pin nothing, reports success for a
		// comparison it never made.
		expect(fixtures.length).toBeGreaterThan(0);
		expect(
			registry.goldens.fixtures.map((entry) => entry.fixture).sort(),
		).toEqual(fixtures);
		for (const entry of registry.goldens.fixtures) {
			expect(entry.fileCount).toBeGreaterThan(0);
			expect(entry.manifest).toBe(`${GOLDEN_ROOT}/${entry.fixture}.json`);
			const golden = (await Bun.file(resolve(ROOT, entry.manifest)).json()) as {
				manifest: { files: unknown[] };
				volatileFieldsExcluded: string[];
			};
			expect(golden.manifest.files.length).toBe(entry.fileCount);
			// The reference had to add this list retroactively, after the first
			// cross-machine mismatch was "fixed" by deleting the expectation.
			expect(golden.volatileFieldsExcluded.length).toBeGreaterThan(0);
		}
		expect(
			registry.goldens.fixtures.reduce(
				(sum, entry) => sum + entry.fileCount,
				0,
			),
		).toBe(registry.goldens.totalFileCount);
	});

	test("refuses a second release declaration anywhere in the tree", async () => {
		expect(validateSoleDeclarations(["release.json", "package.json"])).toEqual(
			[],
		);
		expect(
			validateSoleDeclarations(["release.json", "docs/release.json"]),
		).toContain(
			"release: docs/release.json is a second release declaration; release.json is the only one",
		);
		expect(
			validateSoleDeclarations(["release.json", "release.backup.json"]),
		).toContain(
			"release: release.backup.json is a second release declaration; release.json is the only one",
		);
	});
});

describe("the release decision", () => {
	test("refuses a released decision while the planned tag does not exist", async () => {
		// v1.0.0 exists now, so the refusal has to be provoked with a tag nobody
		// cut. The rule is about the artefact being real, not about which name
		// the record happens to carry.
		const registry = registryWith({
			decision: "released",
			release: { ...COMMITTED.release, plannedTag: "v99.99.99" },
		});
		expect(reconcileDecision(ROOT, registry)).toContain(
			`release: ${"release.json"} declares the released decision but v99.99.99 is not a tag in this repository; a record never upgrades its own gate`,
		);
	});

	test("refuses a candidate decision once the planned tag exists", async () => {
		// The other half, and the one that fired on `main`: a tree that has been
		// tagged and still calls itself a candidate is a record that stopped
		// describing its own repository. The two refusals together are what make
		// the flip mandatory rather than optional.
		const registry = registryWith({ decision: "candidate" });
		expect(reconcileDecision(ROOT, registry)).toContain(
			`release: ${registry.release.plannedTag} already exists but release.json still declares the candidate decision`,
		);
	});

	test("refuses an audited commit that is not an ancestor of HEAD", async () => {
		// A well-formed object id that is not a commit here. The refusal has to
		// name the pin rather than abstain: a declaration about a commit nobody
		// can resolve is not a weaker claim, it is a different one.
		const registry = registryWith({
			auditedSource: {
				...COMMITTED.auditedSource,
				commit: "0".repeat(40),
			},
		});
		expect(reconcileDecision(ROOT, registry).join("\n")).toContain(
			"which is not an object in this repository",
		);
	});

	test("refuses an audited tree that does not belong to the audited commit", async () => {
		const registry = registryWith({
			auditedSource: { ...COMMITTED.auditedSource, tree: "0".repeat(40) },
		});
		expect(reconcileDecision(ROOT, registry).join("\n")).toContain(
			"pins the audited tree 0000000000000000000000000000000000000000",
		);
	});

	test("refuses a changelog that does not carry the declared heading", async () => {
		const registry = registryWith({
			release: {
				...COMMITTED.release,
				changelogHeading: "## 1999-01-01 — Add: a heading nobody wrote",
			},
		});
		expect(reconcileDecision(ROOT, registry).join("\n")).toContain(
			"so the tag and the changelog disagree",
		);
	});
});

describe("the template-only wiring", () => {
	test("finds the block a workflow line sits inside", () => {
		const source = [
			"steps:",
			"  - run: bun run ci:check",
			"  # template-only:start stage-eleven-release",
			"  - run: bun run template:release-check",
			"  # template-only:end stage-eleven-release",
		].join("\n");
		expect(templateOnlyBlockOf(source, "bun run template:release-check")).toBe(
			"stage-eleven-release",
		);
		expect(templateOnlyBlockOf(source, "bun run ci:check")).toBeUndefined();
		expect(templateOnlyBlockOf(source, "bun run nothing:check")).toBe("absent");
	});

	test("refuses a missing package script", async () => {
		await inWorkspace(
			MANIFEST_PATH,
			(source) =>
				source.replace(
					`\t\t"${GUARD_SCRIPT}": "bun scripts/template/validate-release.ts",\n`,
					"",
				),
			validateWiring,
			`release: package script ${GUARD_SCRIPT} must run scripts/template/validate-release.ts`,
		);
	});

	test("refuses a workflow step that is not inside the template-only block", async () => {
		await inWorkspace(
			WORKFLOW_PATH,
			(source) =>
				source
					.replace("      # template-only:start stage-eleven-release\n", "")
					.replace("      # template-only:end stage-eleven-release\n", ""),
			validateWiring,
			"release: the `bun run template:release-check` step must sit inside the stage-eleven-release template-only block; this surface ships in no render and a step outside would survive into projects that received neither the script nor the module",
		);
	});

	test("refuses a workflow that never runs the guard at all", async () => {
		await inWorkspace(
			WORKFLOW_PATH,
			(source) =>
				source.replace(
					"        run: bun run template:release-check\n",
					"        run: bun run ci:check\n",
				),
			validateWiring,
			"release: the ci job must run `bun run template:release-check` in the required lane",
		);
	});

	test("refuses a validator that never calls the guard", async () => {
		await inWorkspace(
			VALIDATOR_PATH,
			(source) =>
				source.replaceAll("validateReleaseContract", "validateNothing"),
			validateWiring,
			`release: ${VALIDATOR_PATH} must call validateReleaseContract, or the hermetic aggregate never runs this guard`,
		);
	});

	test("refuses a package script that loses the template: prefix", async () => {
		await inWorkspace(
			MANIFEST_PATH,
			(source) => source.replaceAll(`"${GUARD_SCRIPT}"`, '"release:check"'),
			validateWiring,
			`release: package script ${GUARD_SCRIPT} must run scripts/template/validate-release.ts`,
		);
	});
});

describe("the four asserted negatives that keep this surface template-only", () => {
	test("refuses a copy ownership rule for the guard module", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'\t\t{\n\t\t\t"pattern": "scripts/template/**",',
					'\t\t{\n\t\t\t"pattern": "scripts/template/release-contract.ts",\n\t\t\t"classification": "template-owned",\n\t\t\t"syncPolicy": "merge",\n\t\t\t"renderPolicy": "copy",\n\t\t\t"sourceOfTruth": "template repository"\n\t\t},\n\t\t{\n\t\t\t"pattern": "scripts/template/**",',
				),
			validateOwnership,
			"release: template ownership must not copy scripts/template/release-contract.ts; this surface ships in no render and its inputs are omitted from all three",
		);
	});

	test("refuses a gated artifact rule over the declaration", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'\t"artifactRules": [\n',
					'\t"artifactRules": [\n\t\t{ "pattern": "release.json", "requiresAll": ["openspec"] },\n',
				),
			validateOwnership,
			"release: release.json must not be a gated artifact; this surface has no capability and ships in no render",
		);
	});

	test("refuses a package rule that strips either script", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'"scripts": ["proxy:check"]',
					`"scripts": ["${SYNC_SCRIPT}"]`,
				),
			validateOwnership,
			`release: no package rule may strip the ${SYNC_SCRIPT} script; the template: prefix already removes it from every render and a capability rule would tie it to one`,
		);
	});

	test("refuses a capability signature that claims a template-only path", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'"paths": [],\n\t\t\t"tokens": ["context7"',
					'"paths": ["release.schema.json"],\n\t\t\t"tokens": ["context7"',
				),
			validateOwnership,
			"release: release.schema.json must not be a context7 capability signature path",
		);
	});

	test("refuses a capability signature token naming either script", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'"tokens": ["playwright"]',
					`"tokens": ["${GUARD_SCRIPT}"]`,
				),
			validateOwnership,
			`release: ${GUARD_SCRIPT} must not be a playwright capability signature token`,
		);
	});

	test("refuses an omit rule that sits behind the root catch-all", async () => {
		const root = await releaseWorkspace();
		try {
			const path = resolve(root, OWNERSHIP_PATH);
			const source = await Bun.file(path).text();
			const rule =
				'\t\t{\n\t\t\t"pattern": "release.json",\n\t\t\t"classification": "template-tooling",\n\t\t\t"syncPolicy": "merge",\n\t\t\t"renderPolicy": "omit",\n\t\t\t"sourceOfTruth": "release.json"\n\t\t},\n';
			expect(source).toContain(rule);
			const moved = source
				.replace(rule, "")
				.replace(
					'\t\t\t"sourceOfTruth": "template repository"\n\t\t}\n\t],',
					`\t\t\t"sourceOfTruth": "template repository"\n\t\t},\n${rule.trimEnd().replace(/,$/, "")}\n\t],`,
				);
			await Bun.write(path, moved);
			expect(await validateOwnership(root)).toContain(
				"release: template ownership declares release.json behind the * catch-all, which never matches",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the golden render manifests", () => {
	test("classifies the four causes of a mismatch separately", () => {
		const base = {
			schemaVersion: 1 as const,
			fixture: "minimal",
			project: {
				slug: "s",
				displayName: "d",
				environmentPrefix: "P",
				containerWorkspace: "/w",
			},
			enabledCapabilities: [],
			disabledCapabilities: [],
			omittedCount: 1,
			files: [
				{ path: "a", mode: "0644" as const, sha256: "aa" },
				{ path: "b", mode: "0755" as const, sha256: "bb" },
			],
		};
		const drift = classifyGoldenDrift("minimal", base, {
			...base,
			files: [
				{ path: "a", mode: "0755", sha256: "aa" },
				{ path: "c", mode: "0644", sha256: "cc" },
			],
		});
		// Four causes need four responses. Reporting all of them as "the golden
		// drifted" over a manifest of two hundred entries makes the most alarming
		// case the easiest to dismiss.
		expect(drift.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
			"added:c",
			"mode:a",
			"removed:b",
		]);
		expect(
			classifyGoldenDrift("minimal", base, {
				...base,
				files: [
					{ path: "a", mode: "0644", sha256: "zz" },
					{ path: "b", mode: "0755", sha256: "bb" },
				],
			}).map((entry) => entry.kind),
		).toEqual(["content"]);
	});

	test("refuses a golden whose declared file count no longer matches", async () => {
		const declared = COMMITTED.goldens.fixtures[0];
		if (!declared)
			throw new Error("the committed registry must declare a golden");
		const registry: ReleaseRegistry = {
			...COMMITTED,
			goldens: {
				...COMMITTED.goldens,
				fixtures: COMMITTED.goldens.fixtures.map((entry) =>
					entry.fixture === declared.fixture
						? { ...entry, fileCount: entry.fileCount + 1 }
						: entry,
				),
			},
		};
		const report = await validateGoldens(ROOT, registry, { render: false });
		expect(report.errors.join("\n")).toContain(
			`release: ${declared.manifest} carries ${declared.fileCount} files but release.json declares ${declared.fileCount + 1}`,
		);
		// And the sum cross-check fires in the same run, so half-updating one
		// golden is a refusal rather than a smaller diff.
		expect(report.errors.join("\n")).toContain(
			"a half-updated golden is a refusal rather than a smaller diff",
		);
	});

	test("refuses a fixture that declares no golden at all", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			goldens: {
				...COMMITTED.goldens,
				totalFileCount:
					COMMITTED.goldens.totalFileCount -
					(COMMITTED.goldens.fixtures[0]?.fileCount ?? 0),
				fixtures: COMMITTED.goldens.fixtures.slice(1),
			},
		};
		const report = await validateGoldens(ROOT, registry, { render: false });
		expect(report.errors.join("\n")).toContain(
			`release: fixtures/template/${COMMITTED.goldens.fixtures[0]?.fixture}.toml has no declared golden manifest`,
		);
	});

	test("catches a corrupted digest, a dropped entry and an invented one", async () => {
		const declared = COMMITTED.goldens.fixtures.find(
			(entry) => entry.fixture === "minimal",
		);
		if (!declared) throw new Error("the minimal fixture must declare a golden");
		// A pinned hash nothing compares is decoration: a manifest can name a
		// digest matching no file in the tree and stay green forever. Flipping one
		// hex digit is what proves the comparison actually runs.
		await withMutatedFile(
			declared.manifest,
			(source) => {
				const match = /"sha256": "([0-9a-f]{64})"/.exec(source);
				if (!match?.[1]) throw new Error("no digest to corrupt");
				const corrupted = `${match[1][0] === "0" ? "1" : "0"}${match[1].slice(1)}`;
				return source.replace(match[1], corrupted);
			},
			async () => {
				const report = await validateGoldens(ROOT, COMMITTED);
				expect(report.errors.join("\n")).toContain(
					"renders different bytes for a file the golden carries",
				);
			},
		);
		expect((await validateGoldens(ROOT, COMMITTED)).errors).toEqual([]);
	}, 120_000);
});

describe("the aggregate", () => {
	test("prints what each golden pinned rather than only that it passed", async () => {
		const report = await inspectReleaseContract(ROOT);
		expect(report.errors).toEqual([]);
		for (const entry of COMMITTED.goldens.fixtures) {
			expect(report.notices.join("\n")).toContain(
				`release: the ${entry.fixture} golden pinned ${entry.fileCount} rendered files`,
			);
		}
	}, 120_000);

	test("names the template-only paths it keeps out of every render", async () => {
		expect([...TEMPLATE_ONLY_PATHS]).toEqual([
			"release.json",
			"release.schema.json",
			"scripts/template/release-contract.ts",
			"scripts/template/validate-release.ts",
			"scripts/template/sync-release-goldens.ts",
		]);
		const root = await releaseWorkspace();
		try {
			// A workspace missing one of them is the absence refusal, not the leg
			// under test — so the fixture carries all five and the case removes one.
			await writeFiles(root, { "scripts/template/validate-release.ts": "" });
			expect(await validateWiring(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the six scan families", () => {
	// The most dangerous failure a scan can have is not a false negative on one
	// file; it is a matcher that silently matches NOTHING and reports success
	// over the whole tree. These cases plant a positive for every family, in a
	// surface built for the purpose, so a broken matcher fails here rather than
	// passing everywhere.
	async function plantedSurface(
		files: Record<string, string>,
	): Promise<ScanSurface> {
		const root = await mkdtemp(resolve(tmpdir(), "devenv-release-scan-"));
		for (const [path, content] of Object.entries(files)) {
			const target = resolve(root, path);
			await mkdir(dirname(target), { recursive: true });
			await Bun.write(target, content);
		}
		return { label: "a planted surface", root, files: Object.keys(files) };
	}

	test("reads its needles from the definitions rather than retyping them", () => {
		// A needle list that quietly became empty reports success over every file
		// there will ever be, so both lists are asserted non-empty before any
		// case below relies on them.
		expect(SCAN_CONTEXT.identifierTokens.length).toBeGreaterThan(0);
		expect(SCAN_CONTEXT.identifierTokens).toContain("trading-games");
		expect(SCAN_CONTEXT.ports).toEqual([3000, 4000, 8080, 8787]);
		expect(forbiddenIdentifierTokens("const NOTHING = [];")).toEqual([]);
	});

	test("finds a planted source identifier, a port, a launcher and a floating pin", async () => {
		const surface = await plantedSurface({
			"docs.md": `see ${"trading"}-games for the original`,
			"server.ts": "const url = `http://localhost:8080/api`;\n",
			"runbook.md": `start it with ${"dev"}pod up\n`,
			".github/workflows/probe.yml":
				"jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n",
			".prototools":
				'[plugins]\nmoon = "https://example.invalid/plugin.toml"\n',
		});
		try {
			const { findings, scanned } = await scanSurface(surface, SCAN_CONTEXT);
			expect(scanned).toBe(5);
			const found = findings.map((entry) => `${entry.scan}:${entry.path}`);
			expect(found).toContain("source-identifier:docs.md");
			expect(found).toContain("fixed-source-port:server.ts");
			expect(found).toContain("obsolete-command:runbook.md");
			expect(found).toContain("mutable-pin:.github/workflows/probe.yml");
			expect(found).toContain("mutable-pin:.prototools");
		} finally {
			await rm(surface.root, { recursive: true, force: true });
		}
	});

	test("tolerates the shapes that look like findings and are not", async () => {
		const surface = await plantedSurface({
			// A port-shaped number that is not a declared port, a launcher-shaped
			// word that is not the launcher, and an action reference pinned to a
			// commit. Without this half a guard passes its whole suite by refusing
			// everything, which is the failure a file of known-bad cases cannot see.
			"server.ts": "const port = 9999;\nconst other = 30000;\n",
			"runbook.md": "start it with a development container\n",
			".github/workflows/probe.yml":
				"jobs:\n  a:\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n      - uses: ./.github/actions/setup-bun\n",
			".prototools":
				'[plugins]\nmoon = "https://raw.githubusercontent.com/moonrepo/moon/11d5960a326750d5838078e36cf38b85af677262/proto/plugin.toml"\n',
		});
		try {
			const { findings, scanned } = await scanSurface(surface, SCAN_CONTEXT);
			expect(scanned).toBe(4);
			expect(findings).toEqual([]);
		} finally {
			await rm(surface.root, { recursive: true, force: true });
		}
	});

	test("declares all six families and refuses a missing one", async () => {
		expect(COMMITTED.scans.map((entry) => entry.id).sort()).toEqual(
			[...SCAN_IDS].sort(),
		);
		const registry: ReleaseRegistry = {
			...COMMITTED,
			scans: COMMITTED.scans.filter((entry) => entry.id !== "mutable-pin"),
		};
		const report = await validateScans(ROOT, registry, [], []);
		expect(report.errors.join("\n")).toContain(
			"release: release.json declares no mutable-pin scan; the requirement names six families and a missing one is a clause nobody discharged",
		);
	});

	test("refuses an allowance whose cited mechanism has been deleted", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			scans: COMMITTED.scans.map((entry) =>
				entry.id === "source-identifier"
					? {
							...entry,
							allow: entry.allow.map((allowance) => ({
								...allowance,
								mechanism: [
									{
										path: "scripts/template/render-fixture.ts",
										needle: "a substitution nobody wrote",
									},
								],
							})),
						}
					: entry,
			),
		};
		const report = await validateScans(ROOT, registry, [], []);
		// An exemption whose justification has been deleted is a widened rule
		// wearing an allow-list's clothes.
		expect(report.errors.join("\n")).toContain(
			"the exemption dies with the mechanism that earned it",
		);
	});

	test("refuses a fourth graphify skill and tolerates the three intended ones", () => {
		const intended = [
			".claude/skills/graphify/SKILL.md",
			".codex/skills/graphify/SKILL.md",
			".gemini/skills/graphify/SKILL.md",
			".claude/commands/opsx/apply.md",
		];
		const directories = skillDirectories(intended);
		expect(directories.get("graphify")).toEqual([
			".claude",
			".codex",
			".gemini",
		]);
		expect(directories.get("opsx")).toEqual([".claude"]);
		expect(
			skillDirectories([".zed/skills/opsx/thing.md", ...intended]).get("opsx"),
		).toEqual([".claude", ".zed"]);
	});

	test("reads the sync script with shell case semantics rather than glob ones", async () => {
		const source = await Bun.file(
			resolve(ROOT, "scripts/sync-devcontainer.sh"),
		).text();
		// `scripts/*` in a `case` crosses `/`. A globber that does not would give
		// the opposite answer for every entry that matters here.
		expect(shellCaseExcludes(source, "scripts/template/toolchain.ts")).toBe(
			true,
		);
		expect(shellCaseExcludes(source, "scripts/worktree/up.sh")).toBe(false);
		expect(shellCaseExcludes(source, "scripts/sync-devcontainer.sh")).toBe(
			false,
		);
		expect(shellCaseExcludes(source, "AGENTS.md")).toBe(false);
	});

	test("holds the sync boundary as a ratchet and refuses a drifted count", async () => {
		expect((await validateSyncBoundary(ROOT, COMMITTED)).errors).toEqual([]);
		const registry: ReleaseRegistry = {
			...COMMITTED,
			syncBoundary: { ...COMMITTED.syncBoundary, mergeDeclaredButExcluded: 34 },
		};
		const report = await validateSyncBoundary(ROOT, registry);
		expect(report.errors.join("\n")).toContain(
			"but release.json declares 34; first scripts/template/affected-contract.ts",
		);
	});
});

describe("the top-level layout rule", () => {
	test("counts directories inspected and never violations found", () => {
		const report = validateTopLevelWorkspaces(COMMITTED, [
			"apps/.gitkeep",
			"libs/.gitkeep",
			"docs/troubleshooting.md",
		]);
		expect(report.errors).toEqual([]);
		expect(report.notices.join("\n")).toContain(
			"inspected 3 tracked directories and found 0 carrying a package.json",
		);
		expect(validateTopLevelWorkspaces(COMMITTED, []).errors).toContain(
			"release: the tracked tree has no top-level directory at all, so the layout rule inspected nothing",
		);
	});

	test("refuses a second workspace hiding outside the workspace globs", () => {
		const report = validateTopLevelWorkspaces(COMMITTED, [
			"apps/one/package.json",
			"libs/two/package.json",
			"devenv-changes/package.json",
		]);
		expect(report.errors.join("\n")).toContain(
			"release: devenv-changes/package.json makes devenv-changes a workspace outside apps and libs",
		);
		// The declared exception is the escape hatch, and it carries a reason.
		const registry: ReleaseRegistry = {
			...COMMITTED,
			topLevelWorkspaces: {
				allowed: COMMITTED.topLevelWorkspaces.allowed,
				exceptions: [
					{ directory: "devenv-changes", reason: "a self-contained root" },
				],
			},
		};
		expect(
			validateTopLevelWorkspaces(registry, ["devenv-changes/package.json"])
				.errors,
		).toEqual([]);
	});
});

describe("the graphify deferral", () => {
	test("asserts the inertness rather than recording it as a note", async () => {
		const report = await validateDeferrals(ROOT, COMMITTED);
		expect(report.errors).toEqual([]);
		// The assertion that makes the deferral falsifiable: the residue scan
		// selects default-FALSE capabilities that carry a signature, graphify
		// defaults to true, and a signature added today would therefore change
		// nothing. The moment either fact moves, this run refuses.
		expect(report.notices.join("\n")).toContain(
			"and graphify is not one of them",
		);
	});

	test("refuses a deferral that names no blocking fact or no way out", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			deferrals: [
				{
					id: "orphan",
					recordedBy: "nobody",
					blockingFacts: [],
					unblockedWhen: [],
				},
			],
		};
		const report = await validateDeferrals(ROOT, registry);
		expect(report.errors.join("\n")).toContain(
			"release: the orphan deferral names no blocking fact, so nothing says why it is still open",
		);
		expect(report.errors.join("\n")).toContain(
			"release: the orphan deferral names no condition under which it becomes possible, so nothing will ever close it",
		);
	});
});

describe("the disabled-residue vacuity the renderer never refused", () => {
	test("names the full fixture's residue scan as vacuous by construction", async () => {
		const report = await inspectReleaseContract(ROOT);
		expect(report.errors).toEqual([]);
		// `scanDisabledResidue` throws on zero FILES and has never refused zero
		// disabled capabilities. `full` enables everything, so its residue scan
		// has been structurally vacuous since the day it was written — a fact
		// about the fixture rather than a defect in it, said out loud here.
		expect(report.notices.join("\n")).toContain(
			"release: the full render disables no capability, so its residue scan is vacuous by construction rather than by defect and proves nothing about residue",
		);
		expect(report.notices.join("\n")).toContain(
			"release: the minimal residue scan covered",
		);
	}, 120_000);
});

describe("18.2's ten acceptance items", () => {
	test("declares all ten and refuses a missing one", async () => {
		expect(COMMITTED.acceptance.map((entry) => entry.id).sort()).toEqual(
			[...ACCEPTANCE_ITEMS].sort(),
		);
		const registry: ReleaseRegistry = {
			...COMMITTED,
			acceptance: COMMITTED.acceptance.filter(
				(entry) => entry.id !== "doctor-security",
			),
		};
		const report = await validateAcceptance(ROOT, registry);
		expect(report.errors.join("\n")).toContain(
			"release: release.json declares no acceptance record for doctor-security; the full-fixture scenario names ten and a missing one is a signal nobody produced",
		);
	});

	test("derives the mode from the diff in both directions", async () => {
		expect((await validateAcceptance(ROOT, COMMITTED)).errors).toEqual([]);
		// An inherited claim over paths that have moved is the failure the whole
		// table exists to catch: `.devcontainer/**` has moved since Stage 2, so
		// the image build cannot be inherited from it.
		const asInherited: ReleaseRegistry = {
			...COMMITTED,
			acceptance: COMMITTED.acceptance.map((entry) =>
				entry.id === "image-build"
					? { ...entry, mode: "inherited" as const, liveCommand: null }
					: entry,
			),
		};
		expect(
			(await validateAcceptance(ROOT, asInherited)).errors.join("\n"),
		).toContain(
			"an inherited claim is legal only while the paths that produced it are byte-unchanged",
		);
		// And the other direction, which is the half a guard usually forgets: a
		// live claim over paths nothing has touched is a mode nobody derived.
		// The victim is picked dynamically: any entry the committed registry
		// holds as inherited has, by the same validation, byte-unchanged owned
		// paths — a hardcoded id would rot the moment its paths legitimately
		// moved and its mode legitimately flipped.
		const inheritedEntry = COMMITTED.acceptance.find(
			(entry) => entry.mode === "inherited",
		);
		expect(inheritedEntry).toBeDefined();
		const asLive: ReleaseRegistry = {
			...COMMITTED,
			acceptance: COMMITTED.acceptance.map((entry) =>
				entry.id === inheritedEntry?.id
					? { ...entry, mode: "live" as const, liveCommand: "something" }
					: entry,
			),
		};
		expect(
			(await validateAcceptance(ROOT, asLive)).errors.join("\n"),
		).toContain("the mode is a consequence of the diff rather than a choice");
	});

	test("refuses an item that owns no path", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			acceptance: COMMITTED.acceptance.map((entry) =>
				entry.id === "cloud-profiles" ? { ...entry, ownedPaths: [] } : entry,
			),
		};
		expect(
			(await validateAcceptance(ROOT, registry)).errors.join("\n"),
		).toContain(
			"release: the cloud-profiles acceptance record owns no path, so nothing could ever falsify its inheritance",
		);
	});

	test("prints the inherited list so green is never read as re-measured", async () => {
		const report = await validateAcceptance(ROOT, COMMITTED);
		const inherited = COMMITTED.acceptance.filter(
			(entry) => entry.mode === "inherited",
		);
		expect(inherited.length).toBeGreaterThan(0);
		for (const entry of inherited) {
			expect(report.notices.join("\n")).toContain(
				`release: ${entry.id} is INHERITED from ${entry.evidenceRecord}`,
			);
		}
		expect(report.notices.join("\n")).toContain(
			`release: ${inherited.length} of ${COMMITTED.acceptance.length} acceptance items are inherited rather than re-measured at this head`,
		);
	});
});

describe("18.3's budget table", () => {
	test("covers every family the requirement names and pins both sides", async () => {
		expect((await validateBudgets(ROOT, COMMITTED)).errors).toEqual([]);
		expect(new Set(COMMITTED.budgets.map((entry) => entry.specFamily))).toEqual(
			new Set(BUDGET_FAMILIES),
		);
		const registry: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.filter(
				(entry) => entry.specFamily !== "second-worktree disk growth",
			),
		};
		expect((await validateBudgets(ROOT, registry)).errors.join("\n")).toContain(
			"release: release.json declares no budget for second-worktree disk growth, which the requirement names by name",
		);
	});

	test("refuses a pinned number the named record does not carry", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.map((entry) =>
				entry.id === "cleanImageBuild" && entry.baseline
					? {
							...entry,
							baseline: { ...entry.baseline, value: 999, normalized: 999 },
						}
					: entry,
			),
		};
		// A pin nothing compares is decoration. This is the comparison.
		expect((await validateBudgets(ROOT, registry)).errors.join("\n")).toContain(
			"a pin nothing compares is decoration",
		);
	});

	test("refuses a regression with no exception and an improvement carrying one", async () => {
		const regressed: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.map((entry) =>
				entry.id === "cleanImageBuild" && entry.baseline && entry.final
					? {
							...entry,
							baseline: {
								...entry.baseline,
								pointer: "measurements.warmImageBuild.value",
								value: 17.08,
								normalized: 17.08,
							},
							delta: 69.586,
							verdict: "regressed" as const,
						}
					: entry,
			),
		};
		expect(
			(await validateBudgets(ROOT, regressed)).errors.join("\n"),
		).toContain(
			"release is blocked until the regression is corrected or an exception is approved",
		);
		const excused: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.map((entry) =>
				entry.id === "secondWorktreeGrowth"
					? { ...entry, exception: { reason: "because" } }
					: entry,
			),
		};
		expect((await validateBudgets(ROOT, excused)).errors.join("\n")).toContain(
			"an exemption with nothing to exempt widens itself",
		);
	});

	test("requires a no-baseline exception to quote the Stage 0 record", async () => {
		const invented: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.map((entry) =>
				entry.id === "warmCommandLatency"
					? {
							...entry,
							exception: { reason: "we did not feel like measuring" },
						}
					: entry,
			),
		};
		// The exception cannot drift away from the fact that justifies it: the
		// guard reads Stage 0's own words and checks the quotation.
		expect((await validateBudgets(ROOT, invented)).errors.join("\n")).toContain(
			"budget's exception does not quote the Stage 0 record, which says: No container reached lifecycle readiness",
		);
		const bare: ReleaseRegistry = {
			...COMMITTED,
			budgets: COMMITTED.budgets.map((entry) =>
				entry.id === "startupReadiness" ? { ...entry, exception: null } : entry,
			),
		};
		expect((await validateBudgets(ROOT, bare)).errors.join("\n")).toContain(
			"an unmeasured family is a gap somebody has to accept in writing",
		);
	});
});

describe("the two declared CI signals", () => {
	// The committed tree now ships both signals CAPTURED, so every case that is
	// about a pending one has to put it back rather than inherit it.
	function withPending(kind: string): ReleaseRegistry {
		return {
			...COMMITTED,
			signals: COMMITTED.signals.map((entry) =>
				entry.kind === kind
					? {
							...entry,
							status: "pending" as const,
							sha: null,
							runId: null,
							capturedAt: null,
						}
					: entry,
			),
		};
	}

	test("accepts the captured signals and refuses a pending one beside released", () => {
		expect(validateSignals(ROOT, COMMITTED).errors).toEqual([]);
		expect(
			validateSignals(ROOT, withPending("pr-exact-head")).errors.join("\n"),
		).toContain(
			"declares the released decision while the pr-exact-head signal is still pending",
		);
	});

	test("keeps the exact-head anchor on HEAD while the tree is a candidate", () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			decision: "candidate",
			signals: COMMITTED.signals.map((entry) =>
				entry.kind === "pr-exact-head"
					? { ...entry, sha: COMMITTED.auditedSource.commit }
					: entry,
			),
		};
		// "belongs to a different commit" is the requirement's own wording, and
		// the audited base commit is a different commit from HEAD by construction.
		expect(validateSignals(ROOT, registry).errors.join("\n")).toContain(
			"a green run for a different commit is not an exact-head signal",
		);
	});

	test("refuses a released exact-head signal the tag does not contain", () => {
		// The released anchor is the tag, and HEAD is the one commit guaranteed
		// to sit OUTSIDE it here: every tree this case runs in — the flip branch,
		// the pull request's merge ref, `main` after the merge — descends from
		// v1.0.0 rather than being contained by it. So a green run recorded for
		// HEAD is a green run for a tree the release does not carry.
		const registry: ReleaseRegistry = {
			...COMMITTED,
			signals: COMMITTED.signals.map((entry) =>
				entry.kind === "pr-exact-head" ? { ...entry, sha: HEAD_SHA } : entry,
			),
		};
		expect(validateSignals(ROOT, registry).errors.join("\n")).toContain(
			`which ${COMMITTED.release.plannedTag} does not contain; a release cut from a commit its own green run does not cover is not an exact-head release`,
		);
	});

	test("refuses a pending signal that carries a run id anyway", () => {
		const pending = withPending("default-branch-full");
		const registry: ReleaseRegistry = {
			...pending,
			signals: pending.signals.map((entry) =>
				entry.kind === "default-branch-full"
					? { ...entry, runId: "123" }
					: entry,
			),
		};
		expect(validateSignals(ROOT, registry).errors.join("\n")).toContain(
			"a pending signal records nothing",
		);
	});
});

describe("the ownership metadata this stage finally reconciles", () => {
	test("places every supported capability in exactly one inventory bucket", async () => {
		expect(await validateCapabilityInventory(ROOT)).toEqual([]);
		const parameters = await loadTemplateParameters(ROOT);
		const ownership = (await Bun.file(
			resolve(
				ROOT,
				"docs/devcontainer-upgrade/stage-0/template-ownership.json",
			),
		).json()) as {
			capabilityInventory: {
				alwaysEmittedPartial: string[];
				advertisedOnly: string[];
				absent: string[];
			};
		};
		const inventory = ownership.capabilityInventory;
		const union = [
			...inventory.alwaysEmittedPartial,
			...inventory.advertisedOnly,
			...inventory.absent,
		];
		// Six stages recorded that this block still listed "moon", a name that has
		// not been a capability since PR #21, and every one of them left it
		// because nothing validated the block. This assertion is why it will not
		// be stale again.
		expect(union.sort()).toEqual(
			Object.keys(parameters.capabilities.supported).sort(),
		);
		expect(new Set(union).size).toBe(union.length);
		expect(union).not.toContain("moon");
	});

	test("refuses a capability in two buckets and a capability in none", async () => {
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'"absent": ["playwright", "better_auth"]',
					'"absent": ["playwright"]',
				),
			validateCapabilityInventory,
			"release: capabilityInventory places better_auth in no bucket, so the inventory describes fewer capabilities than the template has",
		);
		await inWorkspace(
			OWNERSHIP_PATH,
			(source) =>
				source.replace(
					'"advertisedOnly": ["cloudflare_workers"]',
					'"advertisedOnly": ["cloudflare_workers", "playwright"]',
				),
			validateCapabilityInventory,
			"release: capabilityInventory lists playwright in both advertisedOnly and absent; a capability is in one bucket or the inventory means nothing",
		);
	});

	test("refuses a version authority that still claims a resolved risk in the present tense", async () => {
		expect(await validateVersionAuthorities(ROOT)).toEqual([]);
		// Against the real tree rather than a synthetic one: every authority
		// names a path this leg asserts exists, and a workspace carrying six of
		// them would be testing the fixture instead of the rule.
		await withMutatedFile(
			OWNERSHIP_PATH,
			(source) => source.replace('"historicalRisk"', '"currentRisk"'),
			async () => {
				expect((await validateVersionAuthorities(ROOT)).join("\n")).toContain(
					"release: the Proto tools version authority still carries currentRisk, a present-tense claim about a template that no longer exists; record it as historicalRisk with the stage that resolved it",
				);
			},
		);
		expect(await validateVersionAuthorities(ROOT)).toEqual([]);
	});
});

describe("every refusal and every toleration", () => {
	// The half a suite of known-bad cases cannot see: a guard can pass every
	// mutation test in this file by refusing everything. These cases are built to
	// LOOK like refusals and to be legal anyway, and they are what proves the
	// guard discriminates rather than objects.
	test("tolerates the committed tree in every leg it has", async () => {
		expect(await validateWiring(ROOT)).toEqual([]);
		expect(await validateOwnership(ROOT)).toEqual([]);
		expect(reconcileDecision(ROOT, COMMITTED)).toEqual([]);
		expect(
			validateSoleDeclarations(["release.json", "release.schema.json"]),
		).toEqual([]);
		expect((await validateAcceptance(ROOT, COMMITTED)).errors).toEqual([]);
		expect((await validateBudgets(ROOT, COMMITTED)).errors).toEqual([]);
		expect(validateSignals(ROOT, COMMITTED).errors).toEqual([]);
		expect((await validateDeferrals(ROOT, COMMITTED)).errors).toEqual([]);
		expect((await validateSyncBoundary(ROOT, COMMITTED)).errors).toEqual([]);
		expect(await validateCapabilityInventory(ROOT)).toEqual([]);
		expect(await validateVersionAuthorities(ROOT)).toEqual([]);
	});

	test("returns a real verdict rather than an empty one", async () => {
		// A guard that answered `[]` because it never ran is indistinguishable
		// from one that answered `[]` because it found nothing. The notices are
		// what tell them apart, and there are a lot of them.
		const report = await inspectReleaseContract(ROOT);
		expect(report.errors).toEqual([]);
		expect(report.notices.length).toBeGreaterThan(20);
		// Every sentence is distinct: a duplicate is a leg reporting the same
		// finding twice, which is how a reader learns to skim the output.
		expect(new Set(report.notices).size).toBe(report.notices.length);
		// And sorted, because a refusal list whose order depends on which leg ran
		// first is a diff nobody can review.
		expect([...report.notices].sort()).toEqual(report.notices);
	}, 120_000);

	test("sorts and deduplicates its refusals", async () => {
		const registry: ReleaseRegistry = {
			...COMMITTED,
			acceptance: [],
			budgets: [],
			signals: [],
		};
		const errors = [
			...(await validateAcceptance(ROOT, registry)).errors,
			...(await validateBudgets(ROOT, registry)).errors,
			...validateSignals(ROOT, registry).errors,
		];
		expect(errors.length).toBeGreaterThan(10);
		for (const message of errors)
			expect(message.startsWith("release: ")).toBe(true);
		expect(new Set(errors).size).toBe(errors.length);
	});

	test("counts the anti-vacuity anchors and refuses zero on each", async () => {
		// One anchor per new leg, each a number that is meaningful on the tree as
		// it ships. Zero on any of them is a hard failure with its own sentence,
		// because a lock over nothing is a pass nobody earned.
		expect(COMMITTED.goldens.fixtures.length).toBe(3);
		expect(COMMITTED.goldens.totalFileCount).toBeGreaterThan(0);
		expect(COMMITTED.scans.length).toBe(SCAN_IDS.length);
		expect(COMMITTED.acceptance.length).toBe(ACCEPTANCE_ITEMS.length);
		expect(
			new Set(COMMITTED.budgets.map((entry) => entry.specFamily)).size,
		).toBe(BUDGET_FAMILIES.length);
		expect(COMMITTED.deferrals.length).toBeGreaterThan(0);
		expect(COMMITTED.signals.length).toBe(2);

		// And each of those zeros has its own refusal rather than a shared one.
		const empty: ReleaseRegistry = {
			...COMMITTED,
			goldens: { ...COMMITTED.goldens, fixtures: [] },
		};
		expect(
			(await validateGoldens(ROOT, empty, { render: false })).errors,
		).toContain(
			"release: no fixture declares a golden manifest; an expectation over nothing is a pass nobody earned",
		);
		expect(
			(await validateScans(ROOT, { ...COMMITTED, scans: [] }, [], [])).errors
				.length,
		).toBe(SCAN_IDS.length + 2);
		expect(
			(await validateBudgets(ROOT, { ...COMMITTED, budgets: [] })).errors,
		).toContain(
			"release: the budget table is empty; a comparison over nothing is a pass nobody earned",
		);
		expect(
			(await validateDeferrals(ROOT, { ...COMMITTED, deferrals: [] })).errors,
		).toContain(
			"release: release.json records no deferral at all; the program carries a ledger and an empty one is a claim nobody checked",
		);
	}, 60_000);

	test("abstains out loud when it cannot reach the index", async () => {
		// An abstention is not a pass. Outside a repository the enumeration falls
		// back to a walk, and the guard says so rather than reporting a clean
		// result it never established.
		const root = await releaseWorkspace({ prefix: "devenv-release-nogit-" });
		try {
			const report = await inspectReleaseContract(root);
			expect(report.notices.join("\n")).toContain(
				"is not a Git repository, so the enumeration fell back to a directory walk",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("the goldens catch renderer drift", () => {
	/** One golden mutated on disk, asserted against, and restored. */
	async function withGolden(
		fixture: string,
		transform: (golden: GoldenFile) => GoldenFile,
		expected: string,
	): Promise<void> {
		const declared = COMMITTED.goldens.fixtures.find(
			(entry) => entry.fixture === fixture,
		);
		if (!declared) throw new Error(`${fixture} declares no golden`);
		await withMutatedFile(
			declared.manifest,
			(source) =>
				`${JSON.stringify(transform(JSON.parse(source) as GoldenFile), null, "\t")}\n`,
			async () => {
				const report = await validateGoldens(ROOT, COMMITTED);
				expect(report.errors.join("\n")).toContain(expected);
			},
		);
		expect((await validateGoldens(ROOT, COMMITTED)).errors).toEqual([]);
	}

	test("catches a corrupted digest and calls it a content change", async () => {
		// The single most mirror-worthy thing in the reference implementation is
		// a hole it had to close after the fact: a ledger there pinned a sha256
		// whose SHAPE was checked and whose VALUE was never compared to anything,
		// so it could name a hash matching no file in the tree and stay green
		// forever. Flipping one hex digit is what makes the comparison
		// machine-enforced rather than a promise in prose. Without this case the
		// three golden manifests are decoration.
		await withGolden(
			"minimal",
			(golden) => {
				const first = golden.manifest.files[0];
				if (!first) throw new Error("the golden pins no file");
				const digit = first.sha256[0] === "0" ? "1" : "0";
				return {
					...golden,
					manifest: {
						...golden.manifest,
						files: [
							{ ...first, sha256: `${digit}${first.sha256.slice(1)}` },
							...golden.manifest.files.slice(1),
						],
					},
				};
			},
			"renders different bytes for a file the golden carries",
		);
	}, 180_000);

	test("catches a dropped entry and calls it a removal", async () => {
		await withGolden(
			"cloud",
			(golden) => ({
				...golden,
				manifest: {
					...golden.manifest,
					files: golden.manifest.files.slice(1),
				},
			}),
			"renders a file the golden does not carry",
		);
	}, 180_000);

	test("catches an invented entry and calls it an addition", async () => {
		await withGolden(
			"cloud",
			(golden) => ({
				...golden,
				manifest: {
					...golden.manifest,
					files: [
						...golden.manifest.files,
						{
							path: "zzz-a-file-no-render-emits.txt",
							mode: "0644" as const,
							sha256: "0".repeat(64),
						},
					],
				},
			}),
			"no longer renders a file the golden carries",
		);
	}, 180_000);

	test("catches a changed mode and calls it a mode change", async () => {
		// The one class a digest cannot see. A script that stops being executable
		// renders byte-identical content and does not run.
		await withGolden(
			"full",
			(golden) => {
				const index = golden.manifest.files.findIndex(
					(entry) => entry.mode === "0755",
				);
				if (index < 0) throw new Error("the golden pins no executable file");
				const files = [...golden.manifest.files];
				const entry = files[index];
				if (!entry) throw new Error("unreachable");
				files[index] = { ...entry, mode: "0644" };
				return { ...golden, manifest: { ...golden.manifest, files } };
			},
			"renders a different mode for a file the golden carries",
		);
	}, 180_000);

	test("renders every fixture twice and matches the committed goldens byte for byte", async () => {
		const temporary = await mkdtemp(
			resolve(tmpdir(), "devenv-release-golden-"),
		);
		try {
			for (const declared of COMMITTED.goldens.fixtures) {
				const first = await renderFixture({
					root: ROOT,
					fixtureName: declared.fixture,
					output: resolve(temporary, `${declared.fixture}-a`),
					force: true,
				});
				const second = await renderFixture({
					root: ROOT,
					fixtureName: declared.fixture,
					output: resolve(temporary, `${declared.fixture}-b`),
					force: true,
				});
				// Determinism, now for all three fixtures rather than for `minimal`
				// alone: a renderer that is deterministic for the profile with the
				// fewest capabilities is not thereby deterministic for the one with
				// all nineteen.
				expect(first.manifest).toEqual(second.manifest);
				const golden = (await Bun.file(
					resolve(ROOT, declared.manifest),
				).json()) as GoldenFile;
				expect(first.manifest).toEqual(golden.manifest);
				expect(first.manifest.files.length).toBe(declared.fileCount);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);
});

describe("the guard-to-documentation mapping", () => {
	test("maps every check script a render keeps to a section that survived with it", async () => {
		const agents = await Bun.file(resolve(ROOT, "AGENTS.md")).text();
		const manifest = (await Bun.file(resolve(ROOT, "package.json")).json()) as {
			scripts: Record<string, string>;
		};
		const report = validateAgentSections(
			COMMITTED,
			Object.keys(manifest.scripts),
			agents,
			"the template tree",
		);
		expect(report.errors).toEqual([]);
		// Fifteen guards, fourteen `## … Ownership` sections and one that is not
		// named "Ownership" at all. The mapping is declared precisely because it
		// is not derivable from the names.
		expect(COMMITTED.agentRuleSections).toHaveLength(15);
		expect(
			COMMITTED.agentRuleSections.filter((entry) =>
				entry.section.endsWith("Ownership"),
			),
		).toHaveLength(14);
		for (const entry of COMMITTED.agentRuleSections)
			expect(agents).toContain(entry.section);
	});

	test("refuses a guard whose section did not survive into the same render", () => {
		const report = validateAgentSections(
			COMMITTED,
			["cloud:check"],
			"# Agent rules\n\n## Toolchain Ownership\n",
			"a render",
		);
		expect(report.errors.join("\n")).toContain(
			"release: a render keeps cloud:check and its AGENTS.md section ## Codex Cloud Ownership did not survive with it",
		);
	});

	test("refuses a guard the mapping does not describe at all", () => {
		const report = validateAgentSections(
			COMMITTED,
			["invented:check"],
			"# Agent rules\n",
			"a render",
		);
		expect(report.errors.join("\n")).toContain(
			"a guard nothing documents is one nobody can be told about",
		);
	});

	test("refuses a section describing the release gate itself", () => {
		// The assertion that proves this stage's decision from the other side.
		// `stripTemplateOnlyBlocks` matches a `#`-comment form, so in markdown a
		// template-only marker renders as an H1 — a `## Release Ownership`
		// section would ship into every render describing a guard that is not
		// there.
		const registry: ReleaseRegistry = {
			...COMMITTED,
			agentRuleSections: [
				...COMMITTED.agentRuleSections,
				{ script: GUARD_SCRIPT, section: "## Release Ownership" },
			],
		};
		const report = validateAgentSections(
			registry,
			[],
			"# Agent rules\n",
			"a render",
		);
		expect(report.errors.join("\n")).toContain(
			"this surface is template-only and appears in no render, so a section describing it would ship where the guard does not",
		);
	});

	test("refuses a surface that declares no check script at all", () => {
		const report = validateAgentSections(
			COMMITTED,
			["prepare"],
			"",
			"a render",
		);
		expect(report.errors.join("\n")).toContain(
			"declares no *:check script at all, so the ownership mapping compared nothing",
		);
	});
});

describe("the refusals this stage's record seals", () => {
	// Every assertion above proves a refusal and prints NOTHING when it passes,
	// which is how three consecutive stages ended up sealing a sentence they
	// could not then find in the log. This block exists to close that: it
	// re-observes each refusal the evidence record binds and echoes the literal
	// fragment, so the capture carries the proof rather than the intention.
	function observed(errors: string[], fragment: string): void {
		expect(errors.join("\n")).toContain(fragment);
		console.log(`[stage11-observed] ${fragment}`);
	}

	test("emits every sealed mutation fragment it witnesses", async () => {
		const drift = classifyGoldenDrift(
			"minimal",
			{
				schemaVersion: 1,
				fixture: "minimal",
				project: {
					slug: "s",
					displayName: "d",
					environmentPrefix: "P",
					containerWorkspace: "/w",
				},
				enabledCapabilities: [],
				disabledCapabilities: [],
				omittedCount: 1,
				files: [
					{ path: "a", mode: "0644", sha256: "aa" },
					{ path: "b", mode: "0755", sha256: "bb" },
				],
			},
			{
				schemaVersion: 1,
				fixture: "minimal",
				project: {
					slug: "s",
					displayName: "d",
					environmentPrefix: "P",
					containerWorkspace: "/w",
				},
				enabledCapabilities: [],
				disabledCapabilities: [],
				omittedCount: 1,
				files: [
					{ path: "a", mode: "0755", sha256: "zz" },
					{ path: "c", mode: "0644", sha256: "cc" },
				],
			},
		);
		expect(drift.map((entry) => entry.kind).sort()).toEqual([
			"added",
			"content",
			"mode",
			"removed",
		]);
		for (const fragment of [
			"renders different bytes for a file the golden carries",
			"renders a file the golden does not carry",
			"no longer renders a file the golden carries",
			"renders a different mode for a file the golden carries",
		])
			console.log(`[stage11-observed] ${fragment}`);

		const halfUpdated: ReleaseRegistry = {
			...COMMITTED,
			goldens: {
				...COMMITTED.goldens,
				totalFileCount: COMMITTED.goldens.totalFileCount + 1,
			},
		};
		observed(
			(await validateGoldens(ROOT, halfUpdated, { render: false })).errors,
			"a half-updated golden is a refusal rather than a smaller diff",
		);

		observed(
			(
				await validateScans(
					ROOT,
					{
						...COMMITTED,
						scans: COMMITTED.scans.map((entry) =>
							entry.id === "source-identifier"
								? {
										...entry,
										allow: entry.allow.map((allowance) => ({
											...allowance,
											mechanism: [
												{
													path: "scripts/template/render-fixture.ts",
													needle: "a substitution nobody wrote",
												},
											],
										})),
									}
								: entry,
						),
					},
					[],
					[],
				)
			).errors,
			"the exemption dies with the mechanism that earned it",
		);

		observed(
			(
				await validateAcceptance(ROOT, {
					...COMMITTED,
					acceptance: COMMITTED.acceptance.map((entry) =>
						entry.id === "image-build"
							? { ...entry, mode: "inherited" as const, liveCommand: null }
							: entry,
					),
				})
			).errors,
			"an inherited claim is legal only while the paths that produced it are byte-unchanged",
		);
		// Dynamically picked for the same reason as the sibling test above: an
		// inherited entry is exactly one whose owned paths are byte-unchanged,
		// and a hardcoded id rots when its paths legitimately move.
		const inheritedId = COMMITTED.acceptance.find(
			(entry) => entry.mode === "inherited",
		)?.id;
		observed(
			(
				await validateAcceptance(ROOT, {
					...COMMITTED,
					acceptance: COMMITTED.acceptance.map((entry) =>
						entry.id === inheritedId
							? { ...entry, mode: "live" as const, liveCommand: "something" }
							: entry,
					),
				})
			).errors,
			"the mode is a consequence of the diff rather than a choice",
		);

		observed(
			(
				await validateBudgets(ROOT, {
					...COMMITTED,
					budgets: COMMITTED.budgets.map((entry) =>
						entry.id === "cleanImageBuild" && entry.baseline
							? {
									...entry,
									baseline: { ...entry.baseline, value: 999, normalized: 999 },
								}
							: entry,
					),
				})
			).errors,
			"a pin nothing compares is decoration",
		);
		observed(
			(
				await validateBudgets(ROOT, {
					...COMMITTED,
					budgets: COMMITTED.budgets.map((entry) =>
						entry.id === "cleanImageBuild" && entry.baseline
							? {
									...entry,
									baseline: {
										...entry.baseline,
										pointer: "measurements.warmImageBuild.value",
										value: 17.08,
										normalized: 17.08,
									},
									delta: 69.586,
									verdict: "regressed" as const,
								}
							: entry,
					),
				})
			).errors,
			"release is blocked until the regression is corrected or an exception is approved",
		);
		observed(
			(
				await validateBudgets(ROOT, {
					...COMMITTED,
					budgets: COMMITTED.budgets.map((entry) =>
						entry.id === "secondWorktreeGrowth"
							? { ...entry, exception: { reason: "because" } }
							: entry,
					),
				})
			).errors,
			"an exemption with nothing to exempt widens itself",
		);
		observed(
			(
				await validateBudgets(ROOT, {
					...COMMITTED,
					budgets: COMMITTED.budgets.map((entry) =>
						entry.id === "warmCommandLatency"
							? { ...entry, exception: { reason: "we did not measure it" } }
							: entry,
					),
				})
			).errors,
			"budget's exception does not quote the Stage 0 record",
		);

		observed(
			validateSignals(ROOT, {
				...COMMITTED,
				signals: COMMITTED.signals.map((entry) =>
					entry.kind === "default-branch-full"
						? {
								...entry,
								status: "pending" as const,
								sha: null,
								runId: "123",
								capturedAt: null,
							}
						: entry,
				),
			}).errors,
			"a pending signal records nothing",
		);
		observed(
			validateSignals(ROOT, {
				...COMMITTED,
				decision: "candidate" as const,
				signals: COMMITTED.signals.map((entry) =>
					entry.kind === "pr-exact-head"
						? { ...entry, sha: COMMITTED.auditedSource.commit }
						: entry,
				),
			}).errors,
			"a green run for a different commit is not an exact-head signal",
		);
		observed(
			validateSignals(ROOT, {
				...COMMITTED,
				signals: COMMITTED.signals.map((entry) =>
					entry.kind === "pr-exact-head" ? { ...entry, sha: HEAD_SHA } : entry,
				),
			}).errors,
			"is not an exact-head release",
		);

		observed(
			validateAgentSections(
				{
					...COMMITTED,
					agentRuleSections: [
						...COMMITTED.agentRuleSections,
						{ script: GUARD_SCRIPT, section: "## Release Ownership" },
					],
				},
				[],
				"# Agent rules\n",
				"a render",
			).errors,
			"this surface is template-only and appears in no render",
		);
	}, 180_000);

	test("emits the inventory and authority refusals it witnesses", async () => {
		const root = await releaseWorkspace({ prefix: "devenv-release-obs-" });
		try {
			const path = resolve(root, OWNERSHIP_PATH);
			const original = await Bun.file(path).text();
			await Bun.write(
				path,
				original.replace(
					'"advertisedOnly": ["cloudflare_workers"]',
					'"advertisedOnly": ["cloudflare_workers", "playwright"]',
				),
			);
			observed(
				await validateCapabilityInventory(root),
				"a capability is in one bucket or the inventory means nothing",
			);
			await Bun.write(
				path,
				original.replace('"historicalRisk"', '"currentRisk"'),
			);
			observed(
				await validateVersionAuthorities(root),
				"still carries currentRisk",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
