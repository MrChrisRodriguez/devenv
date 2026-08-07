import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	NEEDLES,
	type StartApp,
	type StartSurface,
} from "../../start-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

// Everything validateStartContract reads out of a tree. The workspaces built
// here are plain directories and not Git repositories on purpose: the file
// enumeration falls back to a pruned walk there, which is the path a rendered
// project's CI takes before its first commit.
//
// The development proxy registry travels with the rest because this surface
// declares its proxy routes by id and reconciles them when that file is there;
// a workspace missing it would be testing the absent-registry NOTICE instead of
// the leg under test. It is READ as data and never imported, which is the whole
// of what a declared capability dependency buys.
export const CONTRACT_FILES = [
	"start-surface.json",
	"start-surface.schema.json",
	"package.json",
	"template-parameters.toml",
	"biome.jsonc",
	".gitignore",
	".github/workflows/ci.yml",
	"proxy-routes.json",
	"tsconfig.base.json",
	"tsconfig.start.base.json",
	"scripts/template/start-contract.ts",
	"scripts/template/validate-start.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

export const REGISTRY_PATH = "start-surface.json";
export const PROXY_REGISTRY_PATH = "proxy-routes.json";
export const TSCONFIG_PATH = "tsconfig.start.base.json";

/** The committed skeleton, read once so a fixture never has to restate it. */
export const SKELETON: StartSurface = JSON.parse(
	await Bun.file(resolve(ROOT, REGISTRY_PATH)).text(),
) as StartSurface;

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	contract: StartSurface,
): Promise<void> {
	await Bun.write(
		resolve(root, REGISTRY_PATH),
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

export const APP_DIRECTORY = "apps/platform-start";

/** One declared application, in the shape the reference implementation ships. */
export function declaredApp(overrides: Partial<StartApp> = {}): StartApp {
	return {
		id: "platform",
		directory: APP_DIRECTORY,
		basePath: "/",
		routerBasepath: "/",
		assetsDir: "_start/assets",
		serverEntry: "src/server.ts",
		clientEntry: "src/client.tsx",
		routerModule: "src/router.tsx",
		routeTree: `src/${NEEDLES.routeTree}`,
		wranglerConfig: "wrangler.jsonc",
		ambientDeclarations: ["src/env.d.ts"],
		clientOnlyModules: [],
		proxyRouteId: null,
		...overrides,
	};
}

/**
 * A generated route tree, in the shape a generator emits.
 *
 * It is the derived signal that flips the tree state, and it carries the header
 * a real one carries because the route-tree rules govern it as a COMMITTED
 * artefact: tracked, un-ignored, and excluded from the formatter, since the
 * generator's raw style fails a lint pass a checked-in copy does not.
 */
export const ROUTE_TREE_SOURCE = [
	"/* eslint-disable */",
	"",
	"// @ts-nocheck",
	"",
	"// This file was automatically generated. Do not edit it.",
	"",
	"export interface FileRoutesByFullPath {",
	'\t"/": unknown;',
	"}",
	"",
].join("\n");

/** A source file that really does call one of the two entry helpers. */
export const SERVER_ENTRY_SOURCE = [
	`export default { fetch: ${NEEDLES.handlerCall}() };`,
	"",
].join("\n");

/** ... and one that only looks like it might. */
export const PROSE_SOURCE = [
	`// A server entry calls ${NEEDLES.handlerCall} exactly once.`,
	`export const documented = "${NEEDLES.handlerCall}";`,
	"",
].join("\n");

export const AMBIENT_DECLARATION_SOURCE = [
	'/// <reference types="vite/client" />',
	"",
	"// Modelled structurally so the application never needs a platform types",
	"// package in its empty `types` list.",
	"export interface StartWorkerEnv {",
	"\tGATEWAY: { fetch: typeof fetch };",
	"}",
	"",
].join("\n");

/** The formatter and linter exclusion the route-tree rule requires. */
export const BIOME_WITH_ROUTE_TREE_EXCLUSION = `${JSON.stringify(
	{
		$schema: "https://biomejs.dev/schemas/2.4.16/schema.json",
		files: { includes: ["**", `!**/${NEEDLES.routeTree}`] },
	},
	null,
	"\t",
)}\n`;

/** A hand-written source worker configuration matching `activeContract()`. */
export function workerConfigSource(
	overrides: Record<string, unknown> = {},
): string {
	return `${JSON.stringify(
		{
			name: "platform-start",
			main: "src/server.ts",
			compatibility_date: SKELETON.worker.compatibilityDate,
			compatibility_flags: [...SKELETON.worker.compatibilityFlags],
			workers_dev: false,
			preview_urls: false,
			...overrides,
		},
		null,
		"\t",
	)}\n`;
}

/** The generated worker configuration a build emits, in the shape it emits it. */
export function builtConfigSource(
	overrides: Record<string, unknown> = {},
): string {
	return `${JSON.stringify(
		{
			name: "platform-start",
			main: SKELETON.build.serverModule,
			compatibility_date: SKELETON.worker.compatibilityDate,
			compatibility_flags: [...SKELETON.worker.compatibilityFlags],
			assets: { directory: SKELETON.build.assetsDirectory },
			...overrides,
		},
		null,
		"\t",
	)}\n`;
}

/** A registry with one real application and every policy block populated. */
export function activeContract(
	overrides: Partial<StartSurface> = {},
): StartSurface {
	return {
		...SKELETON,
		mode: "active",
		apps: [declaredApp()],
		...overrides,
	};
}

/** Every file one declared application owns, keyed by repository-relative path. */
export function appFiles(
	app: StartApp = declaredApp(),
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		[`${app.directory}/${app.routeTree}`]: ROUTE_TREE_SOURCE,
		[`${app.directory}/${app.serverEntry}`]: SERVER_ENTRY_SOURCE,
		[`${app.directory}/${app.clientEntry}`]: "export const hydrated = true;\n",
		[`${app.directory}/${app.routerModule}`]: "export const router = {};\n",
		[`${app.directory}/${app.wranglerConfig}`]: workerConfigSource(),
		[`${app.directory}/${SKELETON.build.builtConfigPath}`]: builtConfigSource(),
		...Object.fromEntries(
			app.ambientDeclarations.map((path) => [
				`${app.directory}/${path}`,
				AMBIENT_DECLARATION_SOURCE,
			]),
		),
		...overrides,
	};
}

/**
 * An `active` workspace with a real registry and every declared artefact.
 *
 * The registry and the files move together on purpose: the guard reconciles the
 * declared mode with the derived tree state before any leg runs, so a fixture
 * that wrote one without the other would be testing the reconciliation instead
 * of the leg it meant to reach.
 */
export async function activeWorkspace(options?: {
	contract?: Partial<StartSurface>;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<{ root: string; contract: StartSurface }> {
	const contract = activeContract(options?.contract ?? {});
	const root = await startWorkspace({
		contract,
		prefix: options?.prefix ?? "devenv-start-active-",
		files: {
			"biome.jsonc": BIOME_WITH_ROUTE_TREE_EXCLUSION,
			...appFiles(contract.apps[0] ?? declaredApp()),
			...options?.files,
		},
	});
	return { root, contract };
}

/**
 * A synthetic workspace carrying the committed application surface plus
 * whatever the caller declares.
 */
export async function startWorkspace(options?: {
	contract?: StartSurface;
	files?: Record<string, string>;
	prefix?: string;
	withoutProxyRegistry?: boolean;
	withNodeModules?: boolean;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-start-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	// Only where a leg has to answer "does this resolve", and never otherwise:
	// a workspace with no resolver at all makes every resolution question a
	// blind rather than a miss, which the guard reports as a notice.
	if (options?.withNodeModules)
		await symlink(
			resolve(ROOT, "node_modules"),
			resolve(temporary, "node_modules"),
			"dir",
		);
	if (options?.withoutProxyRegistry)
		await rm(resolve(temporary, PROXY_REGISTRY_PATH));
	if (options?.contract) await writeRegistry(temporary, options.contract);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}

/**
 * The compiler binary, located through the same resolver the guard uses.
 *
 * The catalog already pins it, so the executed proof needs no new dependency —
 * and it has to be the executed proof rather than a JSON assertion, because the
 * defect being proved is invisible to every reader of the JSON: `types` is a
 * list the BUILD never reads. Only the typechecker does.
 */
export function compilerBinary(): string {
	return createRequire(import.meta.url)
		.resolve("typescript")
		.replace(/lib[/\\]typescript\.js$/, "bin/tsc");
}

/**
 * A workspace whose only purpose is to be compiled: the repaired base, the
 * repository base it extends, and one project that really does extend it.
 *
 * It has NO `node_modules`, which is the point — the reserved type entry is
 * unresolvable in an empty tree exactly as it is in a full one, and the failure
 * that proves it needs no package installed.
 */
export async function typecheckWorkspace(): Promise<{
	root: string;
	project: string;
	base: string;
}> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-start-typecheck-"));
	for (const path of ["tsconfig.base.json", TSCONFIG_PATH])
		await copyFile(resolve(ROOT, path), resolve(root, path));
	await mkdir(resolve(root, "project/src"), { recursive: true });
	await Bun.write(
		resolve(root, "project/tsconfig.json"),
		`${JSON.stringify(
			{ extends: `../${TSCONFIG_PATH}`, include: ["src"] },
			null,
			"\t",
		)}\n`,
	);
	await Bun.write(
		resolve(root, "project/src/index.ts"),
		"export const value: string = 'ok';\n",
	);
	return {
		root,
		project: resolve(root, "project"),
		base: resolve(root, TSCONFIG_PATH),
	};
}

export async function skeletonWorkspace(prefix?: string): Promise<string> {
	return await startWorkspace({ prefix: prefix ?? "devenv-start-skeleton-" });
}
