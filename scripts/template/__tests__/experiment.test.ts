import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	CORE_PATHS,
	deriveTreeState,
	type ExperimentRegistry,
	GUARD_SCRIPT,
	inspectExperimentContract,
	inspectSurfaces,
	readExperimentRegistry,
	reconcileMode,
	SURFACE_COUNT,
	SURFACES,
	validateExperimentContract,
	validateSoleDeclarations,
} from "../experiment-contract";
import {
	APP_DIRECTORY,
	experimentFiles,
	experimentWorkspace,
	MANIFEST_PATH,
	OWNERSHIP_PATH,
	REGISTRY_PATH,
	ROOT,
	SKELETON,
	skeletonWorkspace,
	UNIVERSE_PATH,
	WORKFLOW_PATH,
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
