import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ReleaseRegistry } from "../../release-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

/**
 * Everything the wiring and ownership legs read out of a tree.
 *
 * These workspaces are plain directories rather than repositories, and every
 * case built on them calls a LEG rather than the aggregate. That is deliberate:
 * the decision leg resolves the audited commit through local Git objects and
 * the golden leg renders three fixtures out of a Git index, so neither can
 * answer in a synthetic tree — and a fixture that made them abstain would be
 * testing the abstention instead of the rule under test. The cases that need
 * those two legs run against this repository and restore what they touched.
 */
export const CONTRACT_FILES = [
	"release.json",
	"release.schema.json",
	"package.json",
	"template-parameters.toml",
	"template-parameters.schema.json",
	"scripts/template/validate.ts",
	".github/workflows/ci.yml",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	"scripts/template/release-contract.ts",
	"scripts/template/validate-release.ts",
	"scripts/template/sync-release-goldens.ts",
] as const;

export const REGISTRY_PATH = "release.json";
export const MANIFEST_PATH = "package.json";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const VALIDATOR_PATH = "scripts/template/validate.ts";
export const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";

/** The committed declaration, read once so a fixture never has to restate it. */
export const COMMITTED: ReleaseRegistry = JSON.parse(
	await Bun.file(resolve(ROOT, REGISTRY_PATH)).text(),
) as ReleaseRegistry;

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	registry: ReleaseRegistry,
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

/** A synthetic workspace carrying the committed declaration and its wiring. */
export async function releaseWorkspace(options?: {
	registry?: ReleaseRegistry;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-release-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	if (options?.registry) await writeRegistry(temporary, options.registry);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}

/** The committed declaration with one field replaced, and nothing else moved. */
export function registryWith(
	overrides: Partial<ReleaseRegistry>,
): ReleaseRegistry {
	return { ...COMMITTED, ...overrides };
}

/**
 * A committed file edited in THIS repository, asserted against, and put back.
 *
 * Used only by the cases that cannot run anywhere else — the decision leg needs
 * real Git objects and the golden leg needs a real index. The restore happens
 * in a `finally`, because a mutation left behind by a failing assertion makes
 * every later case in the file fail for a reason none of them is about.
 */
export async function withMutatedFile<T>(
	path: string,
	transform: (source: string) => string,
	body: () => Promise<T>,
): Promise<T> {
	const target = resolve(ROOT, path);
	const original = await Bun.file(target).text();
	const changed = transform(original);
	if (changed === original) throw new Error(`Mutation did not change ${path}`);
	await Bun.write(target, changed);
	try {
		return await body();
	} finally {
		await Bun.write(target, original);
	}
}
