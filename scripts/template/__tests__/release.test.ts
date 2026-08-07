import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	classifyGoldenDrift,
	declaredFixtures,
	GOLDEN_ROOT,
	GUARD_SCRIPT,
	inspectReleaseContract,
	type ReleaseRegistry,
	readReleaseRegistry,
	reconcileDecision,
	SYNC_SCRIPT,
	TEMPLATE_ONLY_PATHS,
	templateOnlyBlockOf,
	validateGoldens,
	validateOwnership,
	validateReleaseContract,
	validateSoleDeclarations,
	validateWiring,
} from "../release-contract";
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

describe("the release gate registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateReleaseContract(ROOT)).toEqual([]);
		const { registry, errors } = await readReleaseRegistry(ROOT);
		expect(errors).toEqual([]);
		expect(registry?.schemaVersion).toBe(1);
		// The pull request that introduces this file ships `candidate`. The
		// runbook's final step is what flips it, on `main` or not at all.
		expect(registry?.decision).toBe("candidate");
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
		const registry = registryWith({ decision: "released" });
		expect(reconcileDecision(ROOT, registry)).toContain(
			`release: ${"release.json"} declares the released decision but ${registry.release.plannedTag} is not a tag in this repository; a record never upgrades its own gate`,
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
					'\t\t{ "pattern": "openspec/config.yaml", "requiresAll": ["openspec"] },',
					'\t\t{ "pattern": "release.json", "requiresAll": ["openspec"] },\n\t\t{ "pattern": "openspec/config.yaml", "requiresAll": ["openspec"] },',
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
