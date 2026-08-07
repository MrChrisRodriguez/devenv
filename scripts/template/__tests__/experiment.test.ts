import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	CORE_PATHS,
	deriveTreeState,
	type ExperimentRegistry,
	enumerateFiles,
	GUARD_SCRIPT,
	inspectExperimentContract,
	inspectSurfaces,
	type RetiredExperiment,
	readExperimentRegistry,
	reconcileMode,
	SURFACE_COUNT,
	SURFACES,
	validateContainment,
	validateExperimentContract,
	validateRetirementResidue,
	validateSoleDeclarations,
} from "../experiment-contract";
import { renderFixture } from "../render-fixture";
import {
	APP_DIRECTORY,
	APP_ID,
	APP_PACKAGE,
	activeRegistry,
	activeWorkspace,
	BIOME_PATH,
	commitAll,
	declaredExperiment,
	experimentFiles,
	experimentWorkspace,
	FINDINGS_PATH,
	generatedMoonConfig,
	gitWorkspace,
	IGNORE_PATH,
	KEEPER_DIRECTORY,
	keeperFiles,
	MANIFEST_PATH,
	MOON_WORKSPACE_PATH,
	OWNERSHIP_PATH,
	REGISTRY_PATH,
	ROOT,
	retiredExperiment,
	SKELETON,
	skeletonWorkspace,
	TSCONFIG_PATH,
	UNIVERSE_PATH,
	WORKFLOW_PATH,
	writeFiles,
	writeRegistry,
} from "./fixtures/experiment-workspaces";

/** A file edited, asserted against, and put back exactly as it was. */
async function mutate(
	root: string,
	path: string,
	transform: (source: string) => string,
	expected: string,
): Promise<void> {
	const target = resolve(root, path);
	const original = await Bun.file(target).text();
	const changed = transform(original);
	if (changed === original) throw new Error(`Mutation did not change ${path}`);
	await Bun.write(target, changed);
	expect(await validateExperimentContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateExperimentContract(root)).toEqual([]);
}

/** A file planted, asserted against, and removed in a `finally`. */
async function withFile(
	root: string,
	path: string,
	content: string,
	expected: string,
): Promise<void> {
	const target = resolve(root, path);
	await mkdir(dirname(target), { recursive: true });
	await Bun.write(target, content);
	try {
		expect(await validateExperimentContract(root)).toContain(expected);
	} finally {
		// Removed in a `finally` on purpose. A planted shape left behind by a
		// failing assertion would make every later case in this file fail for a
		// reason none of them is about.
		await rm(target);
	}
	expect(await validateExperimentContract(root)).toEqual([]);
}

/**
 * The other half of `mutate`: a case built to look exactly like a refusal and to
 * be legal anyway.
 *
 * Without it a guard can pass its whole suite by refusing everything, which is
 * the failure mode a suite of known-bad cases cannot see.
 */
async function tolerate(
	root: string,
	path: string,
	content: string,
): Promise<void> {
	const target = resolve(root, path);
	await mkdir(dirname(target), { recursive: true });
	await Bun.write(target, content);
	try {
		expect(await validateExperimentContract(root)).toEqual([]);
	} finally {
		await rm(target);
	}
}

/** A registry mutation, applied and then reverted, with the tree left alone. */
async function withRegistry(
	root: string,
	registry: ExperimentRegistry,
	expected: string,
): Promise<void> {
	const original = await Bun.file(resolve(root, REGISTRY_PATH)).text();
	await writeRegistry(root, registry);
	try {
		expect(await validateExperimentContract(root)).toContain(expected);
	} finally {
		await Bun.write(resolve(root, REGISTRY_PATH), original);
	}
	expect(await validateExperimentContract(root)).toEqual([]);
}

describe("the experiment lifecycle registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateExperimentContract(ROOT)).toEqual([]);
		const { registry, errors } = await readExperimentRegistry(ROOT);
		expect(errors).toEqual([]);
		expect(registry?.schemaVersion).toBe(1);
		expect(registry?.mode).toBe("skeleton");
		expect(registry?.experiments).toEqual([]);
		expect(registry?.retired).toEqual([]);
		// The policy block is the deliverable, not the lists. A registry with no
		// experiments in it is still the declaration of the seven surfaces an
		// experiment would have to weaken in order to hide.
		expect(registry?.policy.workspaceGlobs).toEqual(["apps/*", "libs/*"]);
		expect(registry?.policy.projectGlobs).toEqual(["apps/*", "libs/*"]);
		expect(registry?.policy.reservedDirectories.length).toBe(3);
		expect(registry?.policy.findingsRoots.length).toBeGreaterThan(0);
		expect(registry?.policy.retirementAllowList).toContain(REGISTRY_PATH);
	});

	test("counts exception surfaces inspected and never experiments found", async () => {
		const { registry } = await readExperimentRegistry(ROOT);
		if (!registry) throw new Error("the committed registry must be readable");
		const report = await inspectSurfaces(ROOT, registry);
		// The whole design of this stage in one assertion. `experiments` is empty
		// here and in every rendered project, so a guard anchored on the number of
		// experiments would report zero and pass. This one reports seven.
		expect(report.scanned).toBe(SURFACE_COUNT);
		expect(report.scanned).toBe(7);
		expect(report.inspections.map((entry) => entry.surface)).toEqual([
			...SURFACES,
		]);
		expect(report.inspections.every((entry) => entry.present)).toBe(true);
		expect(report.errors).toEqual([]);
	});

	test("derives the tree state from the tree and never from the registry", async () => {
		const { registry } = await readExperimentRegistry(ROOT);
		const state = deriveTreeState(ROOT, registry);
		// Anti-vacuity in the one place it is easiest to lose: an enumeration that
		// read nothing would report `skeleton` for every tree there will ever be.
		expect(state.files).toBeGreaterThan(100);
		expect(state.tracked).toBe(true);
		expect(state.errors).toEqual([]);
		// `apps/` and `libs/` hold a `.gitkeep` and nothing else, and the two
		// placeholders are named exceptions rather than an accident of the walk.
		expect(state.directories).toEqual([]);
		expect(state.experimentDirectories).toEqual([]);
		expect(state.mode).toBe("skeleton");
	});

	test("a .gitkeep does not flip the derived mode", async () => {
		const root = await skeletonWorkspace();
		try {
			await tolerate(root, "apps/.gitkeep", "");
			await tolerate(root, "libs/.gitkeep", "");
			// And the one that is not a placeholder: a `.gitkeep` INSIDE a
			// candidate directory is still not an experiment, because the
			// exception is the file and not its depth.
			await tolerate(root, "apps/spike-beta/.gitkeep", "");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a planted workspace directory flips the derived mode", async () => {
		const root = await skeletonWorkspace();
		try {
			await withFile(
				root,
				`${APP_DIRECTORY}/src/index.ts`,
				"export const value = 1;\n",
				`experiment: ${APP_DIRECTORY} is a workspace directory that ${REGISTRY_PATH} does not declare; an undeclared experiment is one nothing governs`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reconciles the declared mode with the derived one in both directions", async () => {
		const skeleton = {
			mode: "skeleton",
			experiments: [],
			retired: [],
		} as unknown as ExperimentRegistry;
		expect(
			reconcileMode(skeleton, {
				mode: "active",
				directories: [APP_DIRECTORY],
				experimentDirectories: [APP_DIRECTORY],
				files: 12,
				tracked: true,
				errors: [],
				notices: [],
			}),
		).toEqual([
			`experiment: ${APP_DIRECTORY} is a workspace directory that ${REGISTRY_PATH} does not declare; an undeclared experiment is one nothing governs`,
			`experiment: ${REGISTRY_PATH} declares skeleton mode but the tree state derived from the workspace globs is active`,
		]);
		// The other half of the totality, and the half a deletion produces. Only
		// implementing the first is how a guard shrinks silently: the directory
		// goes, the sweep gets smaller, and the summary still says everything is
		// fine — over fewer directories.
		const active = {
			mode: "active",
			experiments: [{ id: "spike-alpha", directory: APP_DIRECTORY }],
			retired: [],
		} as unknown as ExperimentRegistry;
		expect(
			reconcileMode(active, {
				mode: "skeleton",
				directories: [],
				experimentDirectories: [],
				files: 12,
				tracked: true,
				errors: [],
				notices: [],
			}),
		).toContain(
			`experiment: spike-alpha declares ${APP_DIRECTORY}, which holds no tracked file; move the record to the retired list rather than deleting it`,
		);
	});

	test("mode reconciliation is the first error and short-circuits the rest", async () => {
		const root = await skeletonWorkspace();
		try {
			// Two defects at once: an undeclared directory AND a broken package
			// script. Only the first is reported, because every leg below reads the
			// registry as if it described the tree.
			await mkdir(resolve(root, `${APP_DIRECTORY}/src`), { recursive: true });
			await Bun.write(
				resolve(root, `${APP_DIRECTORY}/src/index.ts`),
				"export const value = 1;\n",
			);
			const manifest = (await Bun.file(
				resolve(root, MANIFEST_PATH),
			).json()) as {
				scripts: Record<string, string>;
			};
			delete manifest.scripts[GUARD_SCRIPT];
			await Bun.write(
				resolve(root, MANIFEST_PATH),
				`${JSON.stringify(manifest, null, "\t")}\n`,
			);
			const errors = await validateExperimentContract(root);
			expect(errors).toContain(
				`experiment: ${APP_DIRECTORY} is a workspace directory that ${REGISTRY_PATH} does not declare; an undeclared experiment is one nothing governs`,
			);
			expect(errors.some((error) => error.includes("package script"))).toBe(
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a second registry anywhere is refused", async () => {
		expect(
			validateSoleDeclarations(
				[REGISTRY_PATH, "experiments.backup.json"],
				undefined,
			),
		).toEqual([
			`experiment: experiments.backup.json is a second experiment lifecycle registry; ${REGISTRY_PATH} is the only one`,
		]);
		expect(
			validateSoleDeclarations(
				[REGISTRY_PATH, "tools/experiments.json"],
				undefined,
			),
		).toEqual([
			`experiment: tools/experiments.json is a second experiment lifecycle registry; ${REGISTRY_PATH} is the only one`,
		]);
		// The schema is not a second registry, and neither is a sealed evidence
		// record that happens to carry the word.
		expect(
			validateSoleDeclarations(
				[
					REGISTRY_PATH,
					"experiments.schema.json",
					"evidence/stage-10e-experiments.json",
				],
				undefined,
			),
		).toEqual([]);
		const root = await skeletonWorkspace();
		try {
			await withFile(
				root,
				"experiments.backup.json",
				`${JSON.stringify(SKELETON, null, "\t")}\n`,
				`experiment: experiments.backup.json is a second experiment lifecycle registry; ${REGISTRY_PATH} is the only one`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an id or a directory declared twice is refused", async () => {
		const entry = {
			id: "spike-alpha",
			directory: APP_DIRECTORY,
			status: "disposable",
			opened: "2026-08-07T00:00:00Z",
			findings: null,
			findingsWaiver: null,
			promotion: null,
		};
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				experiments: [entry, { ...entry, directory: "apps/spike-beta" }],
			} as unknown as ExperimentRegistry),
		).toContain("experiment: spike-alpha is declared twice");
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				experiments: [entry, { ...entry, id: "spike-beta" }],
			} as unknown as ExperimentRegistry),
		).toContain(
			`experiment: the directory ${APP_DIRECTORY} is claimed by both spike-alpha and spike-beta`,
		);
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				experiments: [entry],
				retired: [
					{
						id: "spike-alpha",
						directory: APP_DIRECTORY,
						retiredAt: "2026-08-07T00:00:00Z",
						findings: "CHANGES.md",
						findingsWaiver: null,
						aliases: ["spike-alpha", APP_DIRECTORY],
					},
				],
			} as unknown as ExperimentRegistry),
		).toContain(
			"experiment: spike-alpha is declared as live and as retired at the same time",
		);
	});
});

describe("the guard's own wiring", () => {
	test("every core file must exist", async () => {
		const root = await skeletonWorkspace();
		try {
			for (const path of CORE_PATHS) {
				const target = resolve(root, path);
				const original = await Bun.file(target).text();
				await rm(target);
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${path} is missing`,
				);
				await Bun.write(target, original);
			}
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the package script must run the entrypoint", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				MANIFEST_PATH,
				(source) =>
					source.replace(
						`"${GUARD_SCRIPT}": "bun scripts/template/validate-experiment.ts"`,
						`"${GUARD_SCRIPT}": "echo skipped"`,
					),
				`experiment: package script ${GUARD_SCRIPT} must run scripts/template/validate-experiment.ts`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the workflow step must exist, be unconditional, and be unfenced", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				WORKFLOW_PATH,
				(source) =>
					source.replace(
						"        run: bun run experiments:check\n",
						"        run: bun run rules:check\n",
					),
				"experiment: the ci job must run `bun run experiments:check` in the required lane",
			);
			await mutate(
				root,
				WORKFLOW_PATH,
				(source) =>
					source.replace(
						"      - name: Validate experiment lifecycle contract\n",
						"      - name: Validate experiment lifecycle contract\n        if: github.event_name == 'push'\n",
					),
				"experiment: the `bun run experiments:check` step must not be conditional",
			);
			// The inverse of every gated guard's assertion, and the mechanical form
			// of this stage's central decision. A fence here would delete the step
			// from exactly the renders that still received the four files.
			await mutate(
				root,
				WORKFLOW_PATH,
				(source) =>
					source.replace(
						"      - name: Validate experiment lifecycle contract\n        run: bun run experiments:check\n",
						"      # capability:start openspec\n      - name: Validate experiment lifecycle contract\n        run: bun run experiments:check\n      # capability:end openspec\n",
					),
				"experiment: the `bun run experiments:check` step must not sit inside the openspec capability fence; this surface is core and ships in every render",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("template ownership must copy every core file", async () => {
		const root = await skeletonWorkspace();
		try {
			for (const path of CORE_PATHS) {
				await mutate(
					root,
					OWNERSHIP_PATH,
					(source) =>
						source.replace(`"pattern": "${path}"`, '"pattern": "unused"'),
					`experiment: template ownership must copy ${path}`,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("no capability may gate, strip, or sign this surface", async () => {
		const root = await skeletonWorkspace();
		try {
			// An artifact rule would omit the file from a render whose capability is
			// off, while the unfenced workflow step stayed behind calling it.
			await mutate(
				root,
				OWNERSHIP_PATH,
				(source) =>
					source.replace(
						'"artifactRules": [',
						'"artifactRules": [\n\t\t{ "pattern": "experiments.json", "requiresAll": ["openspec"] },',
					),
				"experiment: experiments.json must not be a gated artifact; this surface ships in every render",
			);
			// A package rule is the inverse mistake and the easier one to make: the
			// files ship, the script does not, and the workflow calls a script that
			// is not there.
			await mutate(
				root,
				OWNERSHIP_PATH,
				(source) =>
					source.replace(
						'"packageRules": [',
						`"packageRules": [\n\t\t{ "capability": "openspec", "scripts": ["${GUARD_SCRIPT}"] },`,
					),
				`experiment: no package rule may strip the ${GUARD_SCRIPT} script; the render would keep the workflow step that calls it`,
			);
			// And a signature would turn a core path into a residue token, in a
			// repository where the word this domain is named for already appears in
			// 35 tracked files that ship by default.
			await mutate(
				root,
				OWNERSHIP_PATH,
				(source) =>
					source.replace(
						'"capabilitySignatures": {',
						'"capabilitySignatures": {\n\t\t"graphify": { "paths": ["experiments.json"], "tokens": ["experiments:check"] },',
					),
				"experiment: experiments.json must not be a graphify capability signature path",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a core file may not mention another capability's residue token", async () => {
		const root = await skeletonWorkspace();
		try {
			// This is not hypothetical. The first draft of the committed registry
			// named the reserving capabilities by name, one of those names contains
			// its own capability's residue token as a substring, and every fixture
			// render failed — in the renderer, with a page of generated-output
			// noise pointing at the wrong file. The rule below turns that into one
			// sentence naming the file, the token and the capability.
			await mutate(
				root,
				"scripts/template/validate-experiment.ts",
				(source) =>
					`// A browser harness is one obvious place an experiment starts: playwright.\n${source}`,
				"experiment: scripts/template/validate-experiment.ts must not contain the playwright signature token playwright; this file ships to every render, including the ones that disable it",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a reserved directory must cite an ownership pattern that exists", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"ownershipPattern": "libs/forms/**"',
						'"ownershipPattern": "libs/invented/**"',
					),
				"experiment: libs/forms claims the ownership pattern libs/invented/**, which no artifact rule or capability signature declares",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the notices channel", () => {
	test("a tree with no Git index says so instead of reporting a clean scan", async () => {
		const root = await skeletonWorkspace();
		try {
			const { errors, notices } = await inspectExperimentContract(root);
			expect(errors).toEqual([]);
			expect(
				notices.some((notice) => notice.includes("is not a Git repository")),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an absent universe registry is named rather than skipped", async () => {
		const root = await experimentWorkspace({ withoutUniverseRegistry: true });
		try {
			const { errors, notices } = await inspectExperimentContract(root);
			expect(errors).toEqual([]);
			expect(notices).toContain(
				`experiment: ${UNIVERSE_PATH} is absent, so no declared experiment was reconciled against a CI universe`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a registry that declares an experiment nothing backs is refused", async () => {
		const root = await skeletonWorkspace();
		try {
			await withRegistry(
				root,
				{
					...SKELETON,
					mode: "active",
					experiments: [
						{
							id: "spike-alpha",
							directory: APP_DIRECTORY,
							status: "disposable",
							opened: "2026-08-07T00:00:00Z",
							findings: null,
							findingsWaiver: null,
							promotion: null,
						},
					],
				},
				`experiment: spike-alpha declares ${APP_DIRECTORY}, which holds no tracked file; move the record to the retired list rather than deleting it`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a declared experiment with a real directory is accepted", async () => {
		const root = await experimentWorkspace({
			registry: {
				...SKELETON,
				mode: "active",
				experiments: [
					{
						id: "spike-alpha",
						directory: APP_DIRECTORY,
						status: "disposable",
						opened: "2026-08-07T00:00:00Z",
						findings: null,
						findingsWaiver: null,
						promotion: null,
					},
				],
			},
			files: experimentFiles(),
		});
		try {
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the seven strictness exception surfaces", () => {
	test("the workspace globs are locked to the declaration", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				MANIFEST_PATH,
				(source) => source.replace('"libs/*"', '"libs/shared"'),
				`experiment: package.json workspaces.packages is ["apps/*","libs/shared"] but ${REGISTRY_PATH} declares ["apps/*","libs/*"]; a drift here is a decision somebody makes in a commit, not a side effect of a directory appearing`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the moon project globs and the root project are locked", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				MOON_WORKSPACE_PATH,
				(source) => source.replace("    - 'libs/*'\n", ""),
				`experiment: .moon/workspace.yml projects.globs is ["apps/*"] but ${REGISTRY_PATH} declares ["apps/*","libs/*"]; a drift here is a decision somebody makes in a commit, not a side effect of a directory appearing`,
			);
			await mutate(
				root,
				MOON_WORKSPACE_PATH,
				(source) => source.replace("    root: '.'", "    tooling: 'scripts'"),
				"experiment: .moon/workspace.yml must keep the repository itself as the project named root, so the graph is never empty",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("only the root project may exclude inherited moon tasks", async () => {
		const { root } = await activeWorkspace();
		try {
			await mutate(
				root,
				`${APP_DIRECTORY}/moon.yml`,
				(source) =>
					`${source}workspace:\n  inheritedTasks:\n    exclude:\n      - 'typecheck'\n`,
				`experiment: ${APP_DIRECTORY}/moon.yml excludes inherited moon tasks; only the root moon.yml may, because its directory is the whole repository`,
			);
			// And the root's own exclusion, which is load-bearing, stays legal.
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the typechecker's include and exclude lists are locked", async () => {
		const { root } = await activeWorkspace();
		try {
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) =>
					source.replace(
						'"scripts/template", "tmp"]',
						`"scripts/template", "tmp", "${APP_DIRECTORY}"]`,
					),
				`experiment: tsconfig.json excludes ${APP_DIRECTORY}, which removes a workspace directory from the typechecker`,
			);
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) => source.replace('"libs/**/*.ts", ', ""),
				`experiment: tsconfig.json include is ["apps/**/*.ts","scripts/**/*.ts"] but ${REGISTRY_PATH} declares ["apps/**/*.ts","libs/**/*.ts","scripts/**/*.ts"]; a drift here is a decision somebody makes in a commit, not a side effect of a directory appearing`,
			);
			// The lock is a DECLARATION lock and not a freeze: a change made in both
			// places at once is exactly the reviewable act it is supposed to be.
			const tsconfig = resolve(root, TSCONFIG_PATH);
			const registryFile = resolve(root, REGISTRY_PATH);
			const originalTsconfig = await Bun.file(tsconfig).text();
			const originalRegistry = await Bun.file(registryFile).text();
			try {
				await Bun.write(
					tsconfig,
					originalTsconfig.replace(
						'"scripts/**/*.ts"]',
						'"scripts/**/*.ts", "apps/**/*.tsx"]',
					),
				);
				const declared = JSON.parse(originalRegistry) as ExperimentRegistry;
				declared.policy.typecheckIncludes.push("apps/**/*.tsx");
				await Bun.write(
					registryFile,
					`${JSON.stringify(declared, null, "\t")}\n`,
				);
				expect(await validateExperimentContract(root)).toEqual([]);
			} finally {
				await Bun.write(tsconfig, originalTsconfig);
				await Bun.write(registryFile, originalRegistry);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the formatter's negations and disabling overrides are locked", async () => {
		const { root } = await activeWorkspace();
		try {
			await mutate(
				root,
				BIOME_PATH,
				(source) =>
					source.replace(
						'"!graphify-out"',
						`"!graphify-out", "!${APP_DIRECTORY}"`,
					),
				`experiment: biome.jsonc excludes ${APP_DIRECTORY} from the formatter and the linter, and it names a workspace directory`,
			);
			// An override that turns the linter off for a path is a negation with
			// better manners, and it is the one a reader skims past.
			await mutate(
				root,
				BIOME_PATH,
				(source) =>
					source.replace(
						'"includes": ["**/generated/**", "**/openapi/**"],',
						`"includes": ["**/generated/**", "**/openapi/**", "${APP_DIRECTORY}/**"],`,
					),
				`experiment: biome.jsonc excludes ${APP_DIRECTORY}/** from the formatter and the linter, and it names a workspace directory`,
			);
			// An override that disables nothing is not an exception at all.
			await tolerate(
				root,
				BIOME_PATH,
				`${JSON.stringify(
					{
						$schema: "https://biomejs.dev/schemas/2.4.16/schema.json",
						vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
						files: {
							includes: [
								"**",
								"!**/worker-configuration.d.ts",
								"!graphify-out",
							],
						},
						overrides: [
							{
								includes: ["**/generated/**", "**/openapi/**"],
								linter: { enabled: false },
								formatter: { enabled: false },
								assist: { enabled: false },
							},
							{
								includes: [`${APP_DIRECTORY}/**`],
								formatter: { indentStyle: "space" },
							},
						],
					},
					null,
					"\t",
				)}\n`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an ignored experiment directory is refused and build output is not", async () => {
		const { root } = await activeWorkspace();
		try {
			await mutate(
				root,
				IGNORE_PATH,
				(source) => `${source}${APP_DIRECTORY}/\n`,
				`experiment: .gitignore ignores ${APP_DIRECTORY}/, which names a workspace directory; an ignored directory is invisible to every guard at once`,
			);
			await mutate(
				root,
				IGNORE_PATH,
				(source) => `${source}apps/\n`,
				"experiment: .gitignore ignores apps/, which names a workspace directory; an ignored directory is invisible to every guard at once",
			);
			// The declared build-output patterns match INSIDE an experiment and are
			// legitimate. They are declared rather than special-cased so the list of
			// things this rule does not catch is as legible as the list it does.
			expect(await validateExperimentContract(root)).toEqual([]);
			const ignore = resolve(root, IGNORE_PATH);
			const original = await Bun.file(ignore).text();
			try {
				await Bun.write(ignore, `${original}**/dist/\n**/coverage/\n`);
				expect(await validateExperimentContract(root)).toEqual([]);
			} finally {
				await Bun.write(ignore, original);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the CI tolerance surface is cross-referenced, not duplicated", async () => {
		const { root } = await activeWorkspace();
		try {
			const { errors, notices } = await inspectExperimentContract(root);
			expect(errors).toEqual([]);
			// `ci:check` owns the sentence about a tolerated failing step. Two
			// refusals for one defect send the reader to two files.
			expect(notices).toContain(
				"experiment: a tolerated failing step anywhere under .github/workflows is refused by ci:check, which owns that sentence; this guard adds only the experiment-specific half",
			);
			// The half nobody else covers: a declared toleration matching nothing.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"toleratedWorkflowFailures": []',
						'"toleratedWorkflowFailures": [{ "workflow": ".github/workflows/ci.yml", "job": "ci", "reason": "a reason long enough to be a reason at all" }]',
					),
				"experiment: experiments.json tolerates a failing ci job in .github/workflows/ci.yml, and nothing there tolerates a failure; a stale exemption widens itself",
			);
			// ... and a workflow condition that names a declared experiment.
			await mutate(
				root,
				WORKFLOW_PATH,
				(source) =>
					source.replace(
						"      - name: Validate experiment lifecycle contract\n",
						`      - name: Validate experiment lifecycle contract\n        if: \${{ !contains(github.event.head_commit.message, '${APP_ID}') }}\n`,
					),
				`experiment: a workflow condition under .github/workflows names ${APP_ID}; an experiment may not skip a required step by naming itself`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("containment, registration, and universe membership", () => {
	test("an experiment outside the workspace globs is refused", async () => {
		// The schema refuses the shape outright, because a quarantine directory is
		// the answer a reader expects and it is exactly the wrong one: outside the
		// globs the code is invisible to moon, to the workspace manifest and to the
		// typechecker at once, which is dead code by construction rather than by
		// neglect.
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"experiments": []',
						`"experiments": [${JSON.stringify({ ...declaredExperiment(), directory: "spikes/alpha" })}]`,
					),
				"experiment: experiments.json $.experiments[0].directory does not match ^(?:apps|libs)/[a-z0-9]+(?:-[a-z0-9]+)*$",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		// And the guard's own containment rule, which is stated relative to the
		// declared globs rather than to a hardcoded pair.
		expect(
			validateContainment({
				...SKELETON,
				experiments: [declaredExperiment({ directory: "apps/one/two" })],
			} as ExperimentRegistry),
		).toContain(
			"experiment: spike-alpha claims apps/one/two, which is not one level under apps or libs; code outside the workspace globs is invisible to every guard at once",
		);
	});

	test("an experiment may not claim a reserved capability directory", async () => {
		expect(
			validateContainment({
				...SKELETON,
				experiments: [declaredExperiment({ directory: "libs/forms" })],
			} as ExperimentRegistry),
		).toContain(
			"experiment: spike-alpha claims libs/forms, which the ownership pattern libs/forms/** already reserves",
		);
	});

	test("a declared experiment must be a package and a moon project", async () => {
		const { root } = await activeWorkspace();
		try {
			const manifest = resolve(root, `${APP_DIRECTORY}/package.json`);
			const original = await Bun.file(manifest).text();
			await rm(manifest);
			expect(await validateExperimentContract(root)).toContain(
				`experiment: ${APP_ID} has no ${APP_DIRECTORY}/package.json, so it is a directory in the workspace rather than a package in it`,
			);
			await Bun.write(manifest, original);

			const config = resolve(root, `${APP_DIRECTORY}/moon.yml`);
			const originalConfig = await Bun.file(config).text();
			await rm(config);
			expect(await validateExperimentContract(root)).toContain(
				`experiment: ${APP_ID} has no ${APP_DIRECTORY}/moon.yml; run graph:generate so the project joins the graph`,
			);
			await Bun.write(config, originalConfig);
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a hand-written moon.yml with no generated block is refused", async () => {
		const { root } = await activeWorkspace();
		try {
			await mutate(
				root,
				`${APP_DIRECTORY}/moon.yml`,
				() =>
					"$schema: 'https://moonrepo.dev/schemas/project.json'\ndependsOn:\n  - 'shared'\n",
				`experiment: ${APP_DIRECTORY}/moon.yml carries no generated dependency block; run graph:generate rather than writing dependsOn by hand`,
			);
			// Staleness of the block's CONTENTS is a comparison another module owns,
			// and this guard says so out loud instead of writing it a second time.
			const { notices } = await inspectExperimentContract(root);
			expect(notices).toContain(
				`experiment: ${APP_DIRECTORY}/moon.yml carries a generated dependency block, and whether its contents are stale is a comparison scripts/template/graph-contract.ts already owns`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("universe membership is a notice, and a declared universe id is not", async () => {
		const { root } = await activeWorkspace();
		try {
			// The project belongs to no universe, and that sentence belongs to the
			// project-graph contract. Two refusals for one defect send the reader to
			// two files.
			const report = await inspectExperimentContract(root);
			expect(report.errors).toEqual([]);
			expect(report.notices).toContain(
				`experiment: the project ${APP_ID} belongs to no universe in ${UNIVERSE_PATH}, which is a refusal scripts/template/graph-contract.ts already owns`,
			);
			// A declared universe id nobody declares IS this guard's sentence.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"promotion": null',
						`"promotion": ${JSON.stringify({
							ownershipRule: "apps/**",
							universeId: "invented",
							testGlob: "**/*.test.ts",
							documentation: "docs/spike-alpha.md",
						})}`,
					),
				`experiment: ${APP_ID} declares the CI universe invented, which ${UNIVERSE_PATH} does not declare`,
			);
			// ... and a real universe that does not list the project is too.
			const registryFile = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registryFile).text();
			try {
				const declared = JSON.parse(original) as ExperimentRegistry;
				const entry = declared.experiments[0];
				if (entry)
					entry.promotion = {
						ownershipRule: "apps/**",
						universeId: "ci",
						testGlob: "**/*.test.ts",
						documentation: "docs/spike-alpha.md",
					};
				await Bun.write(
					registryFile,
					`${JSON.stringify(declared, null, "\t")}\n`,
				);
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} declares the CI universe ci, which does not list the project ${APP_ID}`,
				);
			} finally {
				await Bun.write(registryFile, original);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an absent universe registry names each experiment it could not reconcile", async () => {
		const { root } = await activeWorkspace();
		try {
			await rm(resolve(root, UNIVERSE_PATH));
			const { errors, notices } = await inspectExperimentContract(root);
			expect(errors).toEqual([]);
			expect(notices).toContain(
				`experiment: ${UNIVERSE_PATH} is absent, so the declared experiment ${APP_ID} was declared and not reconciled against a CI universe`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the retirement residue scan", () => {
	test("a retired record whose directory still exists is refused", async () => {
		// The record and the tree disagree in the one direction a removal can get
		// wrong without noticing: the entry moved, the directory did not.
		const { root } = await activeWorkspace();
		try {
			const registryFile = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registryFile).text();
			const declared = JSON.parse(original) as ExperimentRegistry;
			declared.retired = [retiredExperiment()];
			await Bun.write(
				registryFile,
				`${JSON.stringify(declared, null, "\t")}\n`,
			);
			try {
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} is retired but ${APP_DIRECTORY} still exists`,
				);
			} finally {
				await Bun.write(registryFile, original);
			}
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a leftover registration is named, one file and one alias at a time", async () => {
		const root = await skeletonWorkspace();
		try {
			const registryFile = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registryFile).text();
			const declared = JSON.parse(original) as ExperimentRegistry;
			declared.retired = [retiredExperiment()];
			await Bun.write(
				registryFile,
				`${JSON.stringify(declared, null, "\t")}\n`,
			);
			try {
				// A workspace dependency the removal forgot.
				await mutate(
					root,
					MANIFEST_PATH,
					(source) =>
						source.replace(
							'"devDependencies": {',
							`"devDependencies": {\n\t\t"${APP_PACKAGE}": "workspace:*",`,
						),
					`experiment: package.json still names ${APP_PACKAGE}, which the retired record for ${APP_ID} declared as removed`,
				);
				// A universe entry the removal forgot.
				await mutate(
					root,
					UNIVERSE_PATH,
					(source) => source.replace('["root"]', `["root", "${APP_ID}"]`),
					`experiment: ${UNIVERSE_PATH} still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
				);
				// A workflow step the removal forgot, naming the directory.
				await mutate(
					root,
					WORKFLOW_PATH,
					(source) =>
						source.replace(
							"      - name: Validate experiment lifecycle contract\n",
							`      - name: Build the spike\n        run: bun run --cwd ${APP_DIRECTORY} build\n      - name: Validate experiment lifecycle contract\n`,
						),
					`experiment: ${WORKFLOW_PATH} still names ${APP_DIRECTORY}, which the retired record for ${APP_ID} declared as removed`,
				);
				// And the other half: a mention inside the allow-list is a RECORD
				// rather than a route, and it is correctly tolerated. Sealed evidence
				// and changelogs describe work that really happened and must never be
				// "cleaned up".
				await tolerate(root, "CHANGES.md", `${APP_ID} was retired.\n`);
				await tolerate(
					root,
					"docs/devcontainer-upgrade/stage-10e/README.md",
					`${APP_DIRECTORY} was deleted and its findings kept.\n`,
				);
			} finally {
				await Bun.write(registryFile, original);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an alias that is not declared is not scanned for", async () => {
		const root = await skeletonWorkspace();
		try {
			const registryFile = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registryFile).text();
			const declared = JSON.parse(original) as ExperimentRegistry;
			declared.retired = [
				retiredExperiment({ aliases: [APP_ID, APP_PACKAGE] }),
			];
			await Bun.write(
				registryFile,
				`${JSON.stringify(declared, null, "\t")}\n`,
			);
			try {
				expect(await validateExperimentContract(root)).toContain(
					`experiment: the retired record for ${APP_ID} must declare ${APP_DIRECTORY} as an alias; the scan is the union of declared spellings and never a pattern over the id`,
				);
			} finally {
				await Bun.write(registryFile, original);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the scan finds a token that genuinely appears in this repository", async () => {
		// The proof that the matcher works rather than passing because it is
		// broken. The probe token is the launcher Stage 5B superseded: it is still
		// named in this tree on purpose, so a synthetic retired record naming it
		// must find it. A scan that reported nothing here would be the most
		// dangerous possible result for a rule whose whole job is to find things.
		//
		// It is ASSEMBLED rather than written, and that is not decoration. Stage
		// 5B's own guard refuses any tracked file outside its allow-list that
		// names the superseded launcher, and this file is not on that list — a
		// literal here fails `worktree:check` rather than this suite, which is a
		// refusal pointing at the wrong file.
		const probeToken = ["dev", "pod"].join("");
		const { registry } = await readExperimentRegistry(ROOT);
		if (!registry) throw new Error("the committed registry must be readable");
		const { files } = enumerateFiles(ROOT);
		const probe = validateRetirementResidue(
			ROOT,
			{
				...registry,
				retired: [
					retiredExperiment({
						id: "spike-probe",
						directory: "apps/spike-probe",
						aliases: ["spike-probe", "apps/spike-probe", probeToken],
					}),
				],
			},
			files,
		);
		const hits = probe.errors.filter((error) => error.includes(probeToken));
		expect(hits.length).toBeGreaterThan(0);
		expect(probe.errors).toContain(
			`experiment: scripts/template/worktree-contract.ts still names ${probeToken}, which the retired record for spike-probe declared as removed`,
		);
		// And the allow-list is doing real work rather than being decorative: the
		// changelog, the sealed evidence and the stage documentation all name it,
		// and every one of those mentions is a record rather than a route.
		expect(
			probe.errors.some((error) => error.startsWith("experiment: CHANGES.md")),
		).toBe(false);
		expect(
			probe.errors.some((error) => error.startsWith("experiment: evidence/")),
		).toBe(false);
	});
});

describe("promotion and findings", () => {
	/** A promoted experiment with all five registrations in place. */
	async function promotedWorkspace(): Promise<string> {
		const { root } = await activeWorkspace({
			registry: {
				experiments: [
					declaredExperiment({
						status: "promoted",
						promotion: {
							ownershipRule: "apps/**",
							universeId: "ci",
							testGlob: "**/*.test.ts",
							documentation: "docs/spike-alpha.md",
						},
					}),
				],
			},
			files: {
				[`${APP_DIRECTORY}/src/index.test.ts`]:
					'import { expect, test } from "bun:test";\ntest("holds", () => expect(1).toBe(1));\n',
				"docs/spike-alpha.md": "# spike-alpha\n\nWhy this was promoted.\n",
			},
			prefix: "devenv-experiment-promoted-",
		});
		// Universe membership is a registration too, and the fixture adds it the
		// way a promotion would.
		const universe = resolve(root, UNIVERSE_PATH);
		const parsed = (await Bun.file(universe).json()) as {
			universes: Array<{ id: string; projects: string[] }>;
		};
		parsed.universes[0]?.projects.push(APP_ID);
		await Bun.write(universe, `${JSON.stringify(parsed, null, "\t")}\n`);
		return root;
	}

	test("a complete promotion is accepted", async () => {
		const root = await promotedWorkspace();
		try {
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("each of the five promotion artefacts is refused when it is missing", async () => {
		const root = await promotedWorkspace();
		try {
			// (i) ownership
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"ownershipRule": "apps/**"',
						'"ownershipRule": "libs/**"',
					),
				`experiment: ${APP_ID} declares the ownership rule libs/**, which does not cover ${APP_DIRECTORY}`,
			);
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"ownershipRule": "apps/**"',
						'"ownershipRule": "invented/**"',
					),
				`experiment: ${APP_ID} declares the ownership rule invented/**, which ${OWNERSHIP_PATH} does not declare`,
			);
			// (ii) graph
			await mutate(
				root,
				`${APP_DIRECTORY}/moon.yml`,
				() => "$schema: 'https://moonrepo.dev/schemas/project.json'\n",
				`experiment: ${APP_DIRECTORY}/moon.yml carries no generated dependency block; run graph:generate rather than writing dependsOn by hand`,
			);
			// (iii) universe
			await mutate(
				root,
				UNIVERSE_PATH,
				(source) =>
					source
						.replace(`\n\t\t\t\t"${APP_ID}"`, "")
						.replace('"root",', '"root"'),
				`experiment: ${APP_ID} declares the CI universe ci, which does not list the project ${APP_ID}`,
			);
			// (iv) tests. Not redundant with the CI wrapper: that wrapper absorbs
			// "no test files matched" and exits 0 by design, so a promoted
			// experiment with no tests is green forever in a project that has none.
			const test = resolve(root, `${APP_DIRECTORY}/src/index.test.ts`);
			const testSource = await Bun.file(test).text();
			await rm(test);
			expect(await validateExperimentContract(root)).toContain(
				`experiment: ${APP_ID} is promoted and no file under ${APP_DIRECTORY} matches **/*.test.ts; the CI test wrapper absorbs an empty match by design, so nothing else would ever say so`,
			);
			await Bun.write(test, testSource);
			expect(await validateExperimentContract(root)).toEqual([]);
			// (v) documentation
			const document = resolve(root, "docs/spike-alpha.md");
			const documentSource = await Bun.file(document).text();
			await rm(document);
			expect(await validateExperimentContract(root)).toContain(
				`experiment: ${APP_ID} documents itself at docs/spike-alpha.md, which does not exist`,
			);
			await Bun.write(document, documentSource);
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"documentation": "docs/spike-alpha.md"',
						`"documentation": "${APP_DIRECTORY}/README.md"`,
					),
				`experiment: ${APP_ID} documents itself at ${APP_DIRECTORY}/README.md, which is under none of ${JSON.stringify(SKELETON.policy.findingsRoots)}`,
			);
			// And the block itself.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						/"promotion": \{[\s\S]*?\n\t\t\t\}/,
						'"promotion": null',
					),
				`experiment: ${APP_ID} is promoted and declares no promotion block; promotion adds ownership, a graph entry, universe membership, tests and documentation, and each of them is named`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a disposable experiment needs no tests and no documents", async () => {
		// The other half of the rule, and the half that keeps it from being "every
		// directory must be a finished library". A disposable experiment is still a
		// workspace member and a moon project — it has no choice about that — and it
		// is required to be nothing else.
		const { root } = await activeWorkspace();
		try {
			expect(await validateExperimentContract(root)).toEqual([]);
			const { registry } = await readExperimentRegistry(root);
			expect(registry?.experiments[0]?.status).toBe("disposable");
			expect(registry?.experiments[0]?.promotion).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a retired experiment must name findings or waive them with a reason", async () => {
		const root = await skeletonWorkspace();
		try {
			const registryFile = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registryFile).text();
			const write = async (entry: Partial<RetiredExperiment>) => {
				const declared = JSON.parse(original) as ExperimentRegistry;
				declared.retired = [retiredExperiment(entry)];
				await Bun.write(
					registryFile,
					`${JSON.stringify(declared, null, "\t")}\n`,
				);
			};
			try {
				await write({ findings: null });
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} is retired with no findings artefact and no waiver; the record and the findings die together or not at all`,
				);
				// Inside the deleted directory is the case this whole rule exists for.
				await write({ findings: `${APP_DIRECTORY}/FINDINGS.md` });
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} names findings at ${APP_DIRECTORY}/FINDINGS.md, which is inside ${APP_DIRECTORY}; a findings file inside the directory dies with it`,
				);
				await write({ findings: "notes/spike-alpha.md" });
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} names findings at notes/spike-alpha.md, which is under none of ${JSON.stringify(SKELETON.policy.findingsRoots)}`,
				);
				await write({ findings: "docs/never-written.md" });
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} names findings at docs/never-written.md, which does not exist`,
				);
				// A waiver is a recorded claim, honoured and reported, never silently
				// absent: "this spike taught us nothing" is a real outcome, and forcing
				// a lie is worse than recording a reason.
				await write({
					findings: null,
					findingsWaiver: {
						reason:
							"The spike was abandoned before it produced a result worth keeping.",
					},
				});
				expect(await validateExperimentContract(root)).toEqual([]);
				// A waiver standing beside the thing it would lift is refused in turn.
				await write({
					findingsWaiver: {
						reason:
							"The spike was abandoned before it produced a result worth keeping.",
					},
				});
				expect(await validateExperimentContract(root)).toContain(
					`experiment: ${APP_ID} names findings at ${FINDINGS_PATH} and also waives them; a waiver lifts a requirement it is not standing beside`,
				);
				// And an empty reason is not a reason. The schema owns that sentence.
				await write({
					findings: null,
					findingsWaiver: { reason: "" },
				});
				expect(await validateExperimentContract(root)).toContain(
					"experiment: experiments.json $.retired[0].findingsWaiver must satisfy exactly one oneOf branch (matched 0)",
				);
			} finally {
				await Bun.write(registryFile, original);
			}
			expect(await validateExperimentContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

/** One named defect: how to introduce it, and what it must be refused with. */
interface Defect {
	label: string;
	path: string;
	transform: (source: string) => string;
}

/**
 * Every structural defect this guard knows about, driven over one workspace.
 *
 * The battery exists for the property a per-case test cannot see: that the
 * sentences are DISTINCT. A guard whose refusals collapse into one message is
 * green on its whole known-bad suite and useless to the person reading the
 * failure, because every defect sends them to the same place.
 */
function structuralDefects(): Defect[] {
	return [
		{
			label: "workspace glob narrowed",
			path: MANIFEST_PATH,
			transform: (source) => source.replace('"libs/*"', '"libs/shared"'),
		},
		{
			label: "package script rewired",
			path: MANIFEST_PATH,
			transform: (source) =>
				source.replace(
					`"${GUARD_SCRIPT}": "bun scripts/template/validate-experiment.ts"`,
					`"${GUARD_SCRIPT}": "echo skipped"`,
				),
		},
		{
			label: "moon glob narrowed",
			path: MOON_WORKSPACE_PATH,
			transform: (source) => source.replace("    - 'libs/*'\n", ""),
		},
		{
			label: "moon root project removed",
			path: MOON_WORKSPACE_PATH,
			transform: (source) =>
				source.replace("    root: '.'", "    tooling: 'scripts'"),
		},
		{
			label: "typecheck exclude widened",
			path: TSCONFIG_PATH,
			transform: (source) =>
				source.replace(
					'"scripts/template", "tmp"]',
					`"scripts/template", "tmp", "${APP_DIRECTORY}"]`,
				),
		},
		{
			label: "typecheck include narrowed",
			path: TSCONFIG_PATH,
			transform: (source) => source.replace('"libs/**/*.ts", ', ""),
		},
		{
			label: "formatter negation added",
			path: BIOME_PATH,
			transform: (source) =>
				source.replace(
					'"!graphify-out"',
					`"!graphify-out", "!${APP_DIRECTORY}"`,
				),
		},
		{
			label: "formatter override widened",
			path: BIOME_PATH,
			transform: (source) =>
				source.replace(
					'"includes": ["**/generated/**", "**/openapi/**"],',
					`"includes": ["**/generated/**", "**/openapi/**", "${APP_DIRECTORY}/**"],`,
				),
		},
		{
			label: "experiment directory ignored",
			path: IGNORE_PATH,
			transform: (source) => `${source}${APP_DIRECTORY}/\n`,
		},
		{
			label: "workflow step removed",
			path: WORKFLOW_PATH,
			transform: (source) =>
				source.replace(
					"        run: bun run experiments:check\n",
					"        run: bun run rules:check\n",
				),
		},
		{
			label: "workflow step fenced",
			path: WORKFLOW_PATH,
			transform: (source) =>
				source.replace(
					"      - name: Validate experiment lifecycle contract\n        run: bun run experiments:check\n",
					"      # capability:start openspec\n      - name: Validate experiment lifecycle contract\n        run: bun run experiments:check\n      # capability:end openspec\n",
				),
		},
		{
			label: "workflow step made conditional",
			path: WORKFLOW_PATH,
			transform: (source) =>
				source.replace(
					"      - name: Validate experiment lifecycle contract\n",
					"      - name: Validate experiment lifecycle contract\n        if: github.event_name == 'push'\n",
				),
		},
		{
			label: "core file gated as an artifact",
			path: OWNERSHIP_PATH,
			transform: (source) =>
				source.replace(
					'"artifactRules": [',
					'"artifactRules": [\n\t\t{ "pattern": "experiments.json", "requiresAll": ["openspec"] },',
				),
		},
		{
			label: "guard script stripped by a package rule",
			path: OWNERSHIP_PATH,
			transform: (source) =>
				source.replace(
					'"packageRules": [',
					`"packageRules": [\n\t\t{ "capability": "openspec", "scripts": ["${GUARD_SCRIPT}"] },`,
				),
		},
		{
			label: "core file claimed as a capability signature",
			path: OWNERSHIP_PATH,
			transform: (source) =>
				source.replace(
					'"capabilitySignatures": {',
					'"capabilitySignatures": {\n\t\t"graphify": { "paths": ["experiments.json"], "tokens": [] },',
				),
		},
		{
			label: "experiment moon project excludes inherited tasks",
			path: `${APP_DIRECTORY}/moon.yml`,
			transform: (source) =>
				`${source}workspace:\n  inheritedTasks:\n    exclude:\n      - 'typecheck'\n`,
		},
		{
			label: "generated dependency block removed",
			path: `${APP_DIRECTORY}/moon.yml`,
			transform: () => "$schema: 'https://moonrepo.dev/schemas/project.json'\n",
		},
		{
			label: "stale workflow toleration declared",
			path: REGISTRY_PATH,
			transform: (source) =>
				source.replace(
					'"toleratedWorkflowFailures": []',
					'"toleratedWorkflowFailures": [{ "workflow": ".github/workflows/ci.yml", "job": "ci", "reason": "a reason long enough to be a reason at all" }]',
				),
		},
		{
			label: "reserved ownership pattern invented",
			path: REGISTRY_PATH,
			transform: (source) =>
				source.replace(
					'"ownershipPattern": "libs/forms/**"',
					'"ownershipPattern": "libs/invented/**"',
				),
		},
	];
}

describe("the structural refusal census", () => {
	test("every defect is refused, and no two defects share a sentence", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-experiment-census-",
		});
		try {
			// The whole battery runs over one workspace that starts and ends green,
			// so a defect left behind by an earlier case cannot make a later one
			// pass or fail for a reason it is not about.
			expect(await validateExperimentContract(root)).toEqual([]);
			const byLabel = new Map<string, string[]>();
			for (const defect of structuralDefects()) {
				const target = resolve(root, defect.path);
				const original = await Bun.file(target).text();
				const changed = defect.transform(original);
				if (changed === original)
					throw new Error(`${defect.label} did not change ${defect.path}`);
				await Bun.write(target, changed);
				try {
					const errors = await validateExperimentContract(root);
					expect(errors.length).toBeGreaterThan(0);
					// Sorted, and every sentence in this guard's own voice: a refusal
					// nobody can attribute is a refusal nobody acts on.
					expect(errors).toEqual([...errors].sort());
					for (const error of errors)
						expect(error.startsWith("experiment: ")).toBe(true);
					byLabel.set(defect.label, errors);
				} finally {
					await Bun.write(target, original);
				}
				expect(await validateExperimentContract(root)).toEqual([]);
			}
			expect(byLabel.size).toBe(structuralDefects().length);
			// Distinctness, which is the property this battery exists for. Two
			// defects that produce the same sentence send the reader to the same
			// file for two different problems.
			const owner = new Map<string, string>();
			for (const [label, errors] of byLabel) {
				for (const error of errors) {
					const previous = owner.get(error);
					if (previous !== undefined && previous !== label)
						throw new Error(
							`"${error}" is produced by both ${previous} and ${label}`,
						);
					owner.set(error, label);
				}
			}
			expect(owner.size).toBeGreaterThanOrEqual(byLabel.size);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a workspace that is entirely correct is tolerated in every state", async () => {
		// The other half of the census. Without it a guard passes its whole
		// known-bad suite by refusing everything, which is the one failure mode a
		// battery of known-bad cases cannot see.
		const disposable = await activeWorkspace({
			prefix: "devenv-experiment-tolerate-",
		});
		try {
			expect(await validateExperimentContract(disposable.root)).toEqual([]);
			const report = await inspectExperimentContract(disposable.root);
			expect(report.errors).toEqual([]);
			// A real verdict rather than silence: the guard says what it could not
			// compare and which rules live somewhere else.
			expect(report.notices.length).toBeGreaterThan(0);
			expect(report.notices).toEqual([...report.notices].sort());
		} finally {
			await rm(disposable.root, { recursive: true, force: true });
		}
		// ... and the same for a retired record whose removal really did finish.
		const retired = await skeletonWorkspace("devenv-experiment-retired-");
		try {
			const registryFile = resolve(retired, REGISTRY_PATH);
			const declared = JSON.parse(
				await Bun.file(registryFile).text(),
			) as ExperimentRegistry;
			declared.retired = [retiredExperiment()];
			await Bun.write(
				registryFile,
				`${JSON.stringify(declared, null, "\t")}\n`,
			);
			expect(await validateExperimentContract(retired)).toEqual([]);
			const { notices } = await inspectExperimentContract(retired);
			expect(
				notices.some((notice) =>
					notice.includes("the retirement scan covered"),
				),
			).toBe(true);
		} finally {
			await rm(retired, { recursive: true, force: true });
		}
	});

	test("the surface count is seven in the source tree and in every render", async () => {
		const { registry } = await readExperimentRegistry(ROOT);
		if (!registry) throw new Error("the committed registry must be readable");
		expect((await inspectSurfaces(ROOT, registry)).scanned).toBe(SURFACE_COUNT);
		const temporary = await mkdtemp(
			resolve(tmpdir(), "devenv-experiment-render-"),
		);
		try {
			for (const fixtureName of ["minimal", "cloud", "full"]) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				const rendered = await readExperimentRegistry(output);
				expect(rendered.errors).toEqual([]);
				if (!rendered.registry)
					throw new Error(`${fixtureName} lost its registry`);
				const surfaces = await inspectSurfaces(output, rendered.registry);
				// Seven surfaces inspected, zero refusals, and — in the profiles
				// whose universe registry is gated away — a NAMED absence rather
				// than a silently skipped leg.
				expect(surfaces.scanned).toBe(SURFACE_COUNT);
				expect(surfaces.errors).toEqual([]);
				const universe = surfaces.inspections.find(
					(entry) => entry.surface === "universe",
				);
				if (universe?.present === false)
					expect(universe.notices).toEqual([
						`experiment: ${UNIVERSE_PATH} is absent, so no declared experiment was reconciled against a CI universe`,
					]);
				expect(await validateExperimentContract(output)).toEqual([]);
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("the removal lifecycle, end to end, over a real repository", () => {
	test("a spike is created, deleted, and cleaned up one registration at a time", async () => {
		// Both fixtures below run under a real `git init`, and that is not
		// incidental. The retirement scan and the universe leg both go through the
		// index, the index abstains when there is no repository, and an abstention
		// reported as a clean result is the exact failure this program exists to
		// refuse.
		// Both directories are declared from the start, because an undeclared
		// workspace directory is refused whatever else is true — which is the
		// totality rule doing its job inside a fixture about something else.
		const registry = activeRegistry({
			experiments: [
				declaredExperiment(),
				declaredExperiment({ id: "keeper", directory: KEEPER_DIRECTORY }),
			],
		});
		const root = await gitWorkspace({
			registry,
			files: {
				...experimentFiles(),
				[`${APP_DIRECTORY}/src/index.test.ts`]:
					'import { expect, test } from "bun:test";\ntest("holds", () => expect(1).toBe(1));\n',
				...keeperFiles(),
			},
			prefix: "devenv-experiment-removal-",
		});
		try {
			// ── the spike exists and everything about it is declared ──────────
			expect(await validateExperimentContract(root)).toEqual([]);
			const created = deriveTreeState(root, registry);
			expect(created.tracked).toBe(true);
			expect(created.experimentDirectories).toEqual(
				[KEEPER_DIRECTORY, APP_DIRECTORY].sort(),
			);

			// ── the registrations a real spike accumulates ────────────────────
			const manifestPath = resolve(root, MANIFEST_PATH);
			const manifest = (await Bun.file(manifestPath).json()) as {
				devDependencies: Record<string, string>;
			};
			manifest.devDependencies[APP_PACKAGE] = "workspace:*";
			await Bun.write(
				manifestPath,
				`${JSON.stringify(manifest, null, "\t")}\n`,
			);
			const universePath = resolve(root, UNIVERSE_PATH);
			const universes = (await Bun.file(universePath).json()) as {
				universes: Array<{ id: string; projects: string[] }>;
			};
			universes.universes[0]?.projects.push(APP_ID);
			await Bun.write(
				universePath,
				`${JSON.stringify(universes, null, "\t")}\n`,
			);
			await writeFiles(root, {
				...keeperFiles([APP_ID]),
				[`${APP_DIRECTORY}/README.md`]: `# ${APP_ID}\n`,
			});
			await commitAll(root, "wire the spike into the workspace");
			expect(await validateExperimentContract(root)).toEqual([]);

			// ── the deletion, with nothing cleaned up ─────────────────────────
			await rm(resolve(root, APP_DIRECTORY), { recursive: true, force: true });
			const retiredRegistry = activeRegistry({
				experiments: [
					declaredExperiment({ id: "keeper", directory: KEEPER_DIRECTORY }),
				],
				retired: [retiredExperiment()],
			});
			await writeRegistry(root, retiredRegistry);
			await commitAll(root, "delete the spike and retire the record");

			const remaining = await validateExperimentContract(root);
			// Every registration the removal forgot is named, one file at a time.
			for (const expected of [
				`experiment: ${MANIFEST_PATH} still names ${APP_PACKAGE}, which the retired record for ${APP_ID} declared as removed`,
				`experiment: ${UNIVERSE_PATH} still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
				`experiment: ${KEEPER_DIRECTORY}/moon.yml still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
			])
				expect(remaining).toContain(expected);
			expect(remaining.length).toBeGreaterThanOrEqual(3);

			// ── cleaned up one at a time, and each refusal disappears in turn ──
			const cleanedManifest = (await Bun.file(manifestPath).json()) as {
				devDependencies: Record<string, string>;
			};
			delete cleanedManifest.devDependencies[APP_PACKAGE];
			await Bun.write(
				manifestPath,
				`${JSON.stringify(cleanedManifest, null, "\t")}\n`,
			);
			await commitAll(root, "drop the workspace dependency");
			let errors = await validateExperimentContract(root);
			expect(errors).not.toContain(
				`experiment: ${MANIFEST_PATH} still names ${APP_PACKAGE}, which the retired record for ${APP_ID} declared as removed`,
			);
			expect(errors).toContain(
				`experiment: ${UNIVERSE_PATH} still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
			);

			const cleanedUniverses = (await Bun.file(universePath).json()) as {
				universes: Array<{ id: string; projects: string[] }>;
			};
			const first = cleanedUniverses.universes[0];
			if (first)
				first.projects = first.projects.filter((entry) => entry !== APP_ID);
			await Bun.write(
				universePath,
				`${JSON.stringify(cleanedUniverses, null, "\t")}\n`,
			);
			await commitAll(root, "drop the universe entry");
			errors = await validateExperimentContract(root);
			expect(errors).not.toContain(
				`experiment: ${UNIVERSE_PATH} still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
			);
			expect(errors).toContain(
				`experiment: ${KEEPER_DIRECTORY}/moon.yml still names ${APP_ID}, which the retired record for ${APP_ID} declared as removed`,
			);

			await writeFiles(root, keeperFiles());
			await commitAll(root, "regenerate the keeper's dependency block");

			// ── fully cleaned: green, with the record and its findings intact ──
			expect(await validateExperimentContract(root)).toEqual([]);
			const { registry: finalRegistry } = await readExperimentRegistry(root);
			expect(finalRegistry?.retired.length).toBe(1);
			expect(finalRegistry?.retired[0]?.findings).toBe(FINDINGS_PATH);
			expect(await Bun.file(resolve(root, FINDINGS_PATH)).exists()).toBe(true);
			// The record is what proves the removal happened. Deleting it deletes
			// the proof, so the guard has to still be looking.
			const withoutRecord = activeRegistry({
				experiments: [
					declaredExperiment({ id: "keeper", directory: KEEPER_DIRECTORY }),
				],
				retired: [],
			});
			const before = await Bun.file(resolve(root, REGISTRY_PATH)).text();
			await writeRegistry(root, withoutRecord);
			const { notices } = await inspectExperimentContract(root);
			expect(
				notices.some((notice) =>
					notice.includes("the retirement scan covered"),
				),
			).toBe(false);
			await Bun.write(resolve(root, REGISTRY_PATH), before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an abstention is reported rather than swallowed, and the fallback still scans", async () => {
		const root = await experimentWorkspace({
			registry: { ...SKELETON, retired: [retiredExperiment()] },
			prefix: "devenv-experiment-abstain-",
		});
		try {
			const state = deriveTreeState(root);
			expect(state.tracked).toBe(false);
			const { errors, notices } = await inspectExperimentContract(root);
			expect(errors).toEqual([]);
			expect(
				notices.some((notice) =>
					notice.includes(
						"is not a Git repository, so the enumeration fell back to a directory walk",
					),
				),
			).toBe(true);
			// And the fallback is a real scan rather than a skip wearing a notice:
			// a leftover planted here is still found.
			await withFile(
				root,
				"tools/leftover.json",
				`{ "name": "${APP_PACKAGE}" }\n`,
				`experiment: tools/leftover.json still names ${APP_PACKAGE}, which the retired record for ${APP_ID} declared as removed`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the promotion lifecycle, end to end, over a real repository", () => {
	test("a spike is created disposable, promoted, and completed one artefact at a time", async () => {
		const root = await gitWorkspace({
			registry: activeRegistry(),
			files: experimentFiles(),
			prefix: "devenv-experiment-promotion-",
		});
		try {
			// ── disposable and complete ───────────────────────────────────────
			expect(await validateExperimentContract(root)).toEqual([]);
			expect(deriveTreeState(root).tracked).toBe(true);

			// ── flipped to promoted, with nothing a promotion adds ────────────
			const promotion = {
				ownershipRule: "apps/**",
				universeId: "ci",
				testGlob: "**/*.test.ts",
				documentation: "docs/spike-alpha.md",
			};
			await writeRegistry(
				root,
				activeRegistry({
					experiments: [declaredExperiment({ status: "promoted", promotion })],
				}),
			);
			await rm(resolve(root, `${APP_DIRECTORY}/moon.yml`));
			await commitAll(root, "promote the spike, before doing the work");
			const missing = await validateExperimentContract(root);
			expect(missing).toContain(
				`experiment: ${APP_ID} has no ${APP_DIRECTORY}/moon.yml; run graph:generate so the project joins the graph`,
			);
			expect(missing).toContain(
				`experiment: ${APP_ID} declares the CI universe ci, which does not list the project ${APP_ID}`,
			);
			expect(missing).toContain(
				`experiment: ${APP_ID} is promoted and no file under ${APP_DIRECTORY} matches **/*.test.ts; the CI test wrapper absorbs an empty match by design, so nothing else would ever say so`,
			);
			expect(missing).toContain(
				`experiment: ${APP_ID} documents itself at docs/spike-alpha.md, which does not exist`,
			);

			// ── each artefact added, and each refusal disappears in turn ──────
			await writeFiles(root, {
				[`${APP_DIRECTORY}/moon.yml`]: generatedMoonConfig(),
			});
			await commitAll(root, "add the graph entry");
			let errors = await validateExperimentContract(root);
			expect(errors).not.toContain(
				`experiment: ${APP_ID} has no ${APP_DIRECTORY}/moon.yml; run graph:generate so the project joins the graph`,
			);

			const universePath = resolve(root, UNIVERSE_PATH);
			const universes = (await Bun.file(universePath).json()) as {
				universes: Array<{ id: string; projects: string[] }>;
			};
			universes.universes[0]?.projects.push(APP_ID);
			await Bun.write(
				universePath,
				`${JSON.stringify(universes, null, "\t")}\n`,
			);
			await commitAll(root, "join a CI universe");
			errors = await validateExperimentContract(root);
			expect(errors).not.toContain(
				`experiment: ${APP_ID} declares the CI universe ci, which does not list the project ${APP_ID}`,
			);

			await writeFiles(root, {
				[`${APP_DIRECTORY}/src/index.test.ts`]:
					'import { expect, test } from "bun:test";\ntest("holds", () => expect(1).toBe(1));\n',
			});
			await commitAll(root, "add a test inside the directory");
			errors = await validateExperimentContract(root);
			expect(
				errors.some((error) => error.includes("matches **/*.test.ts")),
			).toBe(false);
			expect(errors).toContain(
				`experiment: ${APP_ID} documents itself at docs/spike-alpha.md, which does not exist`,
			);

			await writeFiles(root, {
				"docs/spike-alpha.md": "# spike-alpha\n\nWhy this became a project.\n",
			});
			await commitAll(root, "document the promotion");

			// ── complete ──────────────────────────────────────────────────────
			expect(await validateExperimentContract(root)).toEqual([]);
			const { registry: promoted } = await readExperimentRegistry(root);
			expect(promoted?.experiments[0]?.status).toBe("promoted");
			expect(promoted?.experiments[0]?.promotion).toEqual(promotion);
			const { notices } = await inspectExperimentContract(root);
			expect(
				notices.some((notice) => notice.includes("belongs to no universe")),
			).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
