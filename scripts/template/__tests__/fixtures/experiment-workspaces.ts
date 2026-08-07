import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
	Experiment,
	ExperimentRegistry,
	RetiredExperiment,
} from "../../experiment-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

// Everything validateExperimentContract reads out of a tree. The seven
// exception surfaces travel together because the guard counts the surfaces it
// inspects and refuses zero of them — a workspace missing one would be testing
// the absence refusal instead of the leg under test.
//
// The workspaces built here are plain directories rather than Git repositories
// on purpose: the enumeration falls back to a pruned walk there, which is the
// path a rendered project's CI takes before its first commit, and the fallback
// announces itself as a notice. The removal and promotion fixtures at the end
// of this file are the exception, and they are Git-backed for the opposite
// reason: the retirement residue scan and the universe leg both ask the index a
// question, and an abstention is not a pass.
export const CONTRACT_FILES = [
	"experiments.json",
	"experiments.schema.json",
	"package.json",
	"template-parameters.toml",
	"biome.jsonc",
	".gitignore",
	".github/workflows/ci.yml",
	"tsconfig.json",
	"tsconfig.base.json",
	".moon/workspace.yml",
	"moon.yml",
	"ci-matrix-universes.json",
	"scripts/template/experiment-contract.ts",
	"scripts/template/validate-experiment.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

export const REGISTRY_PATH = "experiments.json";
export const MANIFEST_PATH = "package.json";
export const MOON_WORKSPACE_PATH = ".moon/workspace.yml";
export const TSCONFIG_PATH = "tsconfig.json";
export const BIOME_PATH = "biome.jsonc";
export const IGNORE_PATH = ".gitignore";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const UNIVERSE_PATH = "ci-matrix-universes.json";
export const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";

/** The committed skeleton, read once so a fixture never has to restate it. */
export const SKELETON: ExperimentRegistry = JSON.parse(
	await Bun.file(resolve(ROOT, REGISTRY_PATH)).text(),
) as ExperimentRegistry;

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	registry: ExperimentRegistry,
): Promise<void> {
	await Bun.write(
		resolve(root, REGISTRY_PATH),
		`${JSON.stringify(registry, null, "\t")}\n`,
	);
}

export async function writeFiles(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const target = resolve(root, path);
		await mkdir(dirname(target), { recursive: true });
		await Bun.write(target, content);
	}
}

export const APP_DIRECTORY = "apps/spike-alpha";
export const APP_ID = "spike-alpha";
export const APP_PACKAGE = "@devenv/spike-alpha";

/**
 * The findings artefact every fixture's retired record points at.
 *
 * It lives OUTSIDE the experiment's directory and under a declared findings
 * root, because that is the whole rule: a findings file inside the directory
 * dies with it, which is what actually happens.
 */
export const FINDINGS_PATH = "docs/spike-alpha-findings.md";

/** A synthetic workspace carrying the committed declaration and its surfaces. */
export async function experimentWorkspace(options?: {
	registry?: ExperimentRegistry;
	files?: Record<string, string>;
	prefix?: string;
	withoutUniverseRegistry?: boolean;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-experiment-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	if (options?.withoutUniverseRegistry)
		await rm(resolve(temporary, UNIVERSE_PATH));
	await writeFiles(temporary, {
		// The CONTENT deliberately does not name the experiment. The residue
		// scan reads contents rather than paths, and a findings artefact is
		// allow-listed only while the retired record still points at it — so a
		// fixture whose findings file named the experiment would fail the moment
		// a case replaced the findings path with a waiver.
		[FINDINGS_PATH]:
			"# Findings\n\nWhat the throwaway branch established, kept after the code went.\n",
	});
	if (options?.registry) await writeRegistry(temporary, options.registry);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}

export async function skeletonWorkspace(prefix?: string): Promise<string> {
	return await experimentWorkspace({
		prefix: prefix ?? "devenv-experiment-skeleton-",
	});
}

/** One declared experiment, in the shape a real one would carry. */
export function declaredExperiment(
	overrides: Partial<Experiment> = {},
): Experiment {
	return {
		id: APP_ID,
		directory: APP_DIRECTORY,
		status: "disposable",
		opened: "2026-08-07T00:00:00Z",
		findings: null,
		findingsWaiver: null,
		promotion: null,
		...overrides,
	};
}

/** One retired experiment, with its aliases declared as a union of literals. */
export function retiredExperiment(
	overrides: Partial<RetiredExperiment> = {},
): RetiredExperiment {
	return {
		id: APP_ID,
		directory: APP_DIRECTORY,
		retiredAt: "2026-08-07T00:00:00Z",
		findings: FINDINGS_PATH,
		findingsWaiver: null,
		aliases: [APP_ID, APP_DIRECTORY, APP_PACKAGE],
		...overrides,
	};
}

/** The committed skeleton with one live experiment declared. */
export function activeRegistry(
	overrides: Partial<ExperimentRegistry> = {},
): ExperimentRegistry {
	return {
		...SKELETON,
		mode: "active",
		experiments: [declaredExperiment()],
		...overrides,
	};
}

/**
 * A workspace with one declared experiment and the files that back it.
 *
 * The registry and the directory move together on purpose: mode reconciliation
 * runs before any leg and short-circuits on failure, so a fixture that wrote one
 * without the other would be testing the reconciliation instead of the leg it
 * meant to reach.
 */
export async function activeWorkspace(options?: {
	registry?: Partial<ExperimentRegistry>;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<{ root: string; registry: ExperimentRegistry }> {
	const registry = activeRegistry(options?.registry ?? {});
	const root = await experimentWorkspace({
		registry,
		prefix: options?.prefix ?? "devenv-experiment-active-",
		files: {
			...experimentFiles(registry.experiments[0]?.directory ?? APP_DIRECTORY),
			...options?.files,
		},
	});
	return { root, registry };
}

/** The files a plausible experiment directory carries, keyed by path. */
export function experimentFiles(
	directory = APP_DIRECTORY,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		[`${directory}/package.json`]: `${JSON.stringify(
			{ name: APP_PACKAGE, private: true, version: "0.0.0" },
			null,
			"\t",
		)}\n`,
		[`${directory}/moon.yml`]: generatedMoonConfig(),
		[`${directory}/src/index.ts`]: "export const value = 1;\n",
		...overrides,
	};
}

/**
 * A project config carrying the generator's marker pair.
 *
 * The markers are literals here for the same reason they are literals in the
 * guard: the generator and the graph contract are both gated on a capability
 * that defaults to false, so a core module — or a fixture that has to run in a
 * tree without it — cannot import either.
 */
export function generatedMoonConfig(dependsOn: readonly string[] = []): string {
	const lines = [
		"$schema: 'https://moonrepo.dev/schemas/project.json'",
		"",
		"# graph:generated:start",
		"# dependsOn below is DERIVED from this project's package.json manifest and",
		"# its source imports by scripts/template/generate-graph.ts. Do not edit it by",
		"# hand: run `bun run graph:generate`. Every line outside these two markers is",
		"# hand-written and is preserved across regeneration.",
	];
	if (dependsOn.length === 0)
		lines.push(
			"# No cross-project dependency was derived. dependsOn is omitted rather than",
			"# written empty, so this file states nothing it cannot justify.",
		);
	else {
		lines.push("dependsOn:");
		for (const id of dependsOn) lines.push(`  - '${id}'`);
	}
	lines.push("# graph:generated:end", "");
	return lines.join("\n");
}
