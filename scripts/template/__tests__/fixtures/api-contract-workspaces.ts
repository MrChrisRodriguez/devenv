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
	"biome.jsonc",
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

export const ARTIFACT_PATH = "libs/api-client/openapi/api.v1.json";
export const CLIENT_PATH = "libs/api-client/src/generated/api.ts";
export const CLIENT_BANNER = `GENERATED FILE — ${GENERATED_MARKER}.`;
export const GENERATE_COMMAND = "bun scripts/generate.ts";

/** A minimal but real OpenAPI 3.1 document, in the reference's shape. */
export function artifactDocument(options?: {
	strictResponse?: boolean;
	dropField?: boolean;
	requireField?: boolean;
	narrowField?: boolean;
	dropOperation?: boolean;
}): string {
	const created: Record<string, unknown> = {
		type: "object",
		properties: {
			id: { type: "string" },
			...(options?.dropField ? {} : { note: { type: "string" } }),
		},
		...(options?.strictResponse ? { additionalProperties: false } : {}),
	};
	const paths: Record<string, unknown> = {
		"/orders": {
			post: {
				operationId: "createOrder",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: options?.requireField ? ["total", "note"] : ["total"],
								properties: {
									total: { type: options?.narrowField ? "string" : "number" },
									note: { type: "string" },
								},
							},
						},
					},
				},
				responses: {
					"201": { content: { "application/json": { schema: created } } },
				},
			},
		},
	};
	if (!options?.dropOperation) {
		paths["/orders/{id}"] = {
			get: {
				operationId: "readOrder",
				responses: {
					"200": { content: { "application/json": { schema: created } } },
				},
			},
		};
	}
	return `${JSON.stringify(
		{
			openapi: "3.1.0",
			info: { title: "api", version: "1" },
			paths,
		},
		null,
		"\t",
	)}\n`;
}

export function clientTypes(): string {
	return `// ${CLIENT_BANNER}\n// CI byte-compares this file.\nexport type CreateOrder = { id: string; note: string };\n`;
}

/**
 * A generator committed INTO the workspace, so the drift leg has a real command
 * to run rather than a mock to believe.
 */
export function generatorScript(artifact: string, client: string): string {
	return [
		'import { mkdir } from "node:fs/promises";',
		'import { dirname, resolve } from "node:path";',
		`const files = ${JSON.stringify({ [ARTIFACT_PATH]: artifact, [CLIENT_PATH]: client }, null, "\t")};`,
		"for (const [path, content] of Object.entries(files)) {",
		'\tconst target = resolve(import.meta.dir, "..", path);',
		"\tawait mkdir(dirname(target), { recursive: true });",
		"\tawait Bun.write(target, content);",
		"}",
		"",
	].join("\n");
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

/** An `active` workspace with a real artifact, client, generator and package. */
export async function activeWorkspace(): Promise<{
	root: string;
	contract: ApiContract;
}> {
	const artifact = artifactDocument();
	const client = clientTypes();
	const contract: ApiContract = {
		...SKELETON,
		mode: "active",
		schemaPackages: [schemaPackage()],
		openapi: {
			artifact: ARTIFACT_PATH,
			generate: GENERATE_COMMAND,
			clients: [{ path: CLIENT_PATH, banner: CLIENT_BANNER }],
		},
	};
	const root = await contractWorkspace({
		contract,
		prefix: "devenv-forms-active-",
		files: {
			"libs/forms/src/index.ts": `${SCHEMA_IMPORT}export const Order = z.object({});\n`,
			[ARTIFACT_PATH]: artifact,
			[CLIENT_PATH]: client,
			"scripts/generate.ts": generatorScript(artifact, client),
		},
	});
	return { root, contract };
}
