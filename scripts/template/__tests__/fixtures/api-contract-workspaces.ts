import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ApiContract } from "../../forms-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

// Everything validateFormsContract reads out of a tree. The workspaces built
// here are plain directories and not Git repositories on purpose: the file
// enumeration falls back to a pruned walk there, which is the path a rendered
// project's CI takes before its first commit.
export const CONTRACT_FILES = [
	"api-contract.json",
	"api-contract.schema.json",
	"package.json",
	"template-parameters.toml",
	".github/workflows/ci.yml",
	"scripts/template/forms-contract.ts",
	"scripts/template/validate-forms.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

// Assembled exactly as the guard assembles them. A fixture module that spelled
// either needle out would BE an instance of the shape it exists to produce, and
// the file carrying the fixtures would then fail the guard under test.
export const RESOLVER_BINDING = `${"zod"}Resolver(`;
export const GENERATED_MARKER = ["DO", "NOT", "EDIT"].join(" ");
export const SCHEMA_LIBRARY = "zod";
export const SCHEMA_IMPORT = `import { z } from "${SCHEMA_LIBRARY}";\n`;

export const SKELETON: ApiContract = {
	schemaVersion: 1,
	mode: "skeleton",
	schemaPackages: [],
	openapi: null,
	policySeam: null,
	formModules: [],
	serverParsers: [],
	evolution: [],
};

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	contract: ApiContract,
): Promise<void> {
	await Bun.write(
		resolve(root, "api-contract.json"),
		`${JSON.stringify(contract, null, "\t")}\n`,
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

/**
 * A synthetic workspace carrying the committed contract surface plus whatever
 * the caller declares.
 *
 * The registry and the files move together on purpose: the guard reconciles the
 * declared mode with the derived tree state before any leg runs, so a fixture
 * that wrote one without the other would be testing the reconciliation instead
 * of the leg it meant to reach.
 */
export async function contractWorkspace(options?: {
	contract?: ApiContract;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-forms-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	if (options?.contract) await writeRegistry(temporary, options.contract);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}

/** A declared schema package, in the shape the registry names it. */
export function schemaPackage(
	overrides: Partial<ApiContract["schemaPackages"][number]> = {},
): ApiContract["schemaPackages"][number] {
	return {
		id: "forms",
		root: "libs/forms",
		entry: "libs/forms/src/index.ts",
		allowedSpecifiers: [],
		...overrides,
	};
}
