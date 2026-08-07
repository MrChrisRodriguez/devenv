import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	NEEDLES,
	type ProxyRoute,
	type ProxyRoutes,
	type ProxyServer,
} from "../../proxy-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

// Everything validateProxyContract reads out of a tree. The workspaces built
// here are plain directories and not Git repositories on purpose: the file
// enumeration falls back to a pruned walk there, which is the path a rendered
// project's CI takes before its first commit.
//
// The worktree runtime contract travels with the rest because the registry
// declares the published container port and the friendly domain and the guard
// reconciles both against it; a workspace missing it would be testing the
// absent-contract notice instead of the leg under test.
export const CONTRACT_FILES = [
	"proxy-routes.json",
	"proxy-routes.schema.json",
	"package.json",
	"template-parameters.toml",
	".github/workflows/ci.yml",
	"scripts/worktree/contract.toml",
	"scripts/template/proxy-contract.ts",
	"scripts/template/validate-proxy.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

export const WORKTREE_CONTRACT_PATH = "scripts/worktree/contract.toml";

// The published port and the friendly domain the committed registry declares.
// Spelled once here so a fixture never has to guess which number the worktree
// runtime contract carries.
export const PUBLISHED_CONTAINER_PORT = 8080;
export const FRIENDLY_DOMAIN_PATTERN = "{workspace}.{project}.localhost";
export const CONFIG_PATH = "vite.config.ts";

// The two upstreams every active workspace declares, and the ports they bind.
// Loopback by construction: a target that names a public host is an unintended
// external call, and the registry has no way to spell one that is not.
export const API_UPSTREAM_PORT = 8787;
export const SOCKET_UPSTREAM_PORT = 8788;

export const SKELETON: ProxyRoutes = {
	schemaVersion: 1,
	mode: "skeleton",
	configPath: CONFIG_PATH,
	runtime: "bun",
	wsRuntimeWaiver: null,
	publishedContainerPort: PUBLISHED_CONTAINER_PORT,
	friendlyDomainPattern: FRIENDLY_DOMAIN_PATTERN,
	server: null,
	preview: null,
	routes: [],
	upstreams: [],
};

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	contract: ProxyRoutes,
): Promise<void> {
	await Bun.write(
		resolve(root, "proxy-routes.json"),
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

// A source file that really does declare a proxy table, and two that only look
// like they might. The first is the derived signal; the other two are the
// `tolerate()` half — a server block with no proxy has not declared a proxy
// table, and a string naming the shape is not an instance of it.
export const PROXY_TABLE_SOURCE = [
	"export const config = {",
	`\t${NEEDLES.server}: {`,
	`\t\t${NEEDLES.proxy}: {`,
	'\t\t\t"/api": { target: "http://127.0.0.1:8787" },',
	"\t\t},",
	"\t},",
	"};",
	"",
].join("\n");

export const BARE_SERVER_SOURCE = [
	"export const config = {",
	`\t${NEEDLES.server}: { port: 5173 },`,
	"};",
	"",
].join("\n");

export const PROSE_SOURCE = [
	`// A ${NEEDLES.server}.${NEEDLES.proxy} entry must be an object literal.`,
	`export const documented = "${NEEDLES.server}.${NEEDLES.proxy}";`,
	"",
].join("\n");

/** The friendly host the loopback allowlist family is completed with. */
export const FRIENDLY_HOST = "workspace.project.localhost";

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", ".localhost"];

export function declaredServer(
	overrides: Partial<ProxyServer> = {},
): ProxyServer {
	return {
		port: PUBLISHED_CONTAINER_PORT,
		host: true,
		strictPort: true,
		allowedHosts: [...LOOPBACK_HOSTS, FRIENDLY_HOST],
		hmr: null,
		origin: null,
		frontedBy: null,
		...overrides,
	};
}

export function declaredRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
	return {
		id: "api",
		path: "/api",
		target: `http://127.0.0.1:${API_UPSTREAM_PORT}`,
		ws: false,
		changeOrigin: true,
		secure: true,
		rewrite: null,
		...overrides,
	};
}

export function socketRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
	return declaredRoute({
		id: "socket",
		path: "/socket",
		target: `http://127.0.0.1:${SOCKET_UPSTREAM_PORT}`,
		ws: true,
		...overrides,
	});
}

/** A registry with a real server, a real preview server and two real routes. */
export function activeContract(
	overrides: Partial<ProxyRoutes> = {},
): ProxyRoutes {
	return {
		...SKELETON,
		mode: "active",
		server: declaredServer(),
		preview: declaredServer(),
		routes: [declaredRoute(), socketRoute()],
		upstreams: [
			{
				id: "api",
				port: API_UPSTREAM_PORT,
				description: "The HTTP application programming interface",
			},
			{
				id: "socket",
				port: SOCKET_UPSTREAM_PORT,
				description: "The live socket surface",
			},
		],
		...overrides,
	};
}

/**
 * A synthetic workspace carrying the committed proxy surface plus whatever the
 * caller declares.
 *
 * The registry and the files move together on purpose: the guard reconciles the
 * declared mode with the derived tree state before any leg runs, so a fixture
 * that wrote one without the other would be testing the reconciliation instead
 * of the leg it meant to reach.
 */
export async function proxyWorkspace(options?: {
	contract?: ProxyRoutes;
	files?: Record<string, string>;
	prefix?: string;
	withoutWorktreeContract?: boolean;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-proxy-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	if (options?.withoutWorktreeContract)
		await rm(resolve(temporary, WORKTREE_CONTRACT_PATH));
	if (options?.contract) await writeRegistry(temporary, options.contract);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}
