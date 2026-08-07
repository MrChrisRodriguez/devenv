// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The mutations write
// runner expressions into a workflow verbatim.
import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	deriveTreeState,
	inspectProxyContract,
	type ProxyRoutes,
	REGISTRY_PATH,
	readProxyRoutes,
	validateProxyContract,
	validateSoleDeclarations,
} from "../proxy-contract";
import {
	activeContract,
	BARE_SERVER_SOURCE,
	CONFIG_PATH,
	declaredRoute,
	PROSE_SOURCE,
	PROXY_TABLE_SOURCE,
	PUBLISHED_CONTAINER_PORT,
	proxyWorkspace,
	ROOT,
	SKELETON,
	WORKTREE_CONTRACT_PATH,
	writeRegistry,
} from "./fixtures/proxy-route-workspaces";

async function skeletonFixture(): Promise<string> {
	return await proxyWorkspace({ prefix: "devenv-proxy-skeleton-" });
}

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
	expect(await validateProxyContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateProxyContract(root)).toEqual([]);
}

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
		expect(await validateProxyContract(root)).toContain(expected);
	} finally {
		// Removed in a `finally` on purpose. A planted shape left behind by a
		// failing assertion would make every later case in this file fail for a
		// reason none of them is about.
		await rm(target);
	}
	expect(await validateProxyContract(root)).toEqual([]);
}

/**
 * The other half of `mutate`: a case built to look exactly like a refusal and
 * to be legal anyway.
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
		expect(await validateProxyContract(root)).toEqual([]);
	} finally {
		await rm(target);
	}
}

describe("proxy route registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateProxyContract(ROOT)).toEqual([]);
		const { contract, errors } = await readProxyRoutes(ROOT);
		expect(errors).toEqual([]);
		expect(contract?.schemaVersion).toBe(1);
		expect(contract?.mode).toBe("skeleton");
		expect(contract?.configPath).toBe(CONFIG_PATH);
		expect(contract?.server).toBeNull();
		expect(contract?.preview).toBeNull();
		expect(contract?.routes).toEqual([]);
		expect(contract?.upstreams).toEqual([]);
		// The reachability numbers this registry declares, and the reason it
		// declares them: the files that carry them belong to another capability
		// and are not reliably readable in a rendered project.
		expect(contract?.publishedContainerPort).toBe(PUBLISHED_CONTAINER_PORT);
	});

	test("derives the tree state from the tree and never from the registry", async () => {
		const { contract } = await readProxyRoutes(ROOT);
		const state = deriveTreeState(ROOT, contract);
		// Anti-vacuity in the one place it is easiest to lose: a scan that read
		// nothing would report `skeleton` for every tree there will ever be.
		expect(state.scanned).toBeGreaterThan(100);
		expect(state.errors).toEqual([]);
		expect(state.signals).toEqual([]);
		expect(state.mode).toBe("skeleton");
	});

	test("refuses a tree that grew a surface the registry still calls skeleton", async () => {
		const temporary = await skeletonFixture();
		try {
			expect(await validateProxyContract(temporary)).toEqual([]);
			// One case per derived shape. Each is the visible consequence of a
			// development server existing, and each is named on its own so the
			// failure says which file to look at.
			await withFile(
				temporary,
				CONFIG_PATH,
				"export default {};\n",
				`proxy: ${REGISTRY_PATH} declares skeleton mode but ${CONFIG_PATH} is a build-tool configuration file, and its presence is what marks this project as having a development server`,
			);
			// The Stage 0 reservation is an exact filename with no glob, so a nested
			// configuration would slip past a path signature. The derived mode is
			// what catches it, and it catches every extension.
			await withFile(
				temporary,
				"apps/web/vite.config.mts",
				"export default {};\n",
				`proxy: ${REGISTRY_PATH} declares skeleton mode but apps/web/vite.config.mts is a build-tool configuration file, and its presence is what marks this project as having a development server`,
			);
			await withFile(
				temporary,
				"apps/web/src/config.ts",
				PROXY_TABLE_SOURCE,
				`proxy: ${REGISTRY_PATH} declares skeleton mode but apps/web/src/config.ts declares a development or preview proxy table`,
			);
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"@biomejs/biome": "catalog:",',
						'"@biomejs/biome": "catalog:",\n\t\t"vite": "catalog:",',
					),
				`proxy: ${REGISTRY_PATH} declares skeleton mode but package.json pins the build tool as a direct dependency`,
			);
			// ... and the near-misses. The scan reads the AST, so a server block with
			// no proxy table is not a proxy table, and a string that names the shape
			// is not an instance of it.
			await tolerate(temporary, "apps/web/src/bare.ts", BARE_SERVER_SOURCE);
			await tolerate(temporary, "apps/web/src/docs.ts", PROSE_SOURCE);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a registry that declares a surface the tree does not have", async () => {
		const temporary = await skeletonFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"skeleton"', '"active"'),
				`proxy: ${REGISTRY_PATH} declares active mode but no tracked file carries a build-tool configuration or a proxy table`,
			);
			// The other direction: a declaration in a registry that still says the
			// world is empty.
			const declared: ProxyRoutes = { ...SKELETON, routes: [declaredRoute()] };
			const original = await Bun.file(resolve(temporary, REGISTRY_PATH)).text();
			await writeRegistry(temporary, declared);
			expect(await validateProxyContract(temporary)).toContain(
				`proxy: ${REGISTRY_PATH} declares skeleton mode but declares a server, a preview server or a route`,
			);
			await Bun.write(resolve(temporary, REGISTRY_PATH), original);
			expect(await validateProxyContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses an active registry that leaves the servers or the routes empty", async () => {
		const temporary = await proxyWorkspace({
			prefix: "devenv-proxy-half-active-",
			contract: activeContract({ server: null, routes: [] }),
			files: { [CONFIG_PATH]: "export default {};\n" },
		});
		try {
			const errors = await validateProxyContract(temporary);
			expect(errors).toContain(
				`proxy: ${REGISTRY_PATH} declares active mode but leaves the development or preview server null`,
			);
			expect(errors).toContain(
				`proxy: ${REGISTRY_PATH} declares active mode but declares no route`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a second registry anywhere in the tree", async () => {
		expect(
			validateSoleDeclarations(
				["proxy-routes.json", "packages/api/proxy-routes.json"],
				undefined,
			),
		).toContain(
			`proxy: packages/api/proxy-routes.json is a second proxy route registry; ${REGISTRY_PATH} is the only one`,
		);
		// One route id, one route. Two entries claiming the same name leave two
		// answers to the question the registry exists to answer once.
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				routes: [declaredRoute(), declaredRoute({ path: "/other" })],
			}),
		).toContain(
			"proxy: /other is a second route named api; /api is the only one",
		);
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				upstreams: [
					{ id: "api", port: 8787, description: "one" },
					{ id: "socket", port: 8787, description: "two" },
				],
			}),
		).toContain(
			"proxy: the upstream port 8787 is declared as both api and socket",
		);
	});

	test("requires the guard to be wired into the manifest and the required lane", async () => {
		const temporary = await skeletonFixture();
		try {
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"proxy:check": "bun scripts/template/validate-proxy.ts",',
						'"proxy:check": "true",',
					),
				"proxy: package script proxy:check must run scripts/template/validate-proxy.ts",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) => source.replace("        run: bun run proxy:check\n", ""),
				"proxy: the ci job must run `bun run proxy:check` in the required lane",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source
						.replace("      # capability:start vite_websocket_proxy\n", "")
						.replace("      # capability:end vite_websocket_proxy\n", ""),
				"proxy: the `bun run proxy:check` step must sit inside a vite_websocket_proxy capability fence",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source.replace(
						"        run: bun run proxy:check\n",
						"        run: bun run proxy:check\n        if: ${{ always() }}\n",
					),
				"proxy: the `bun run proxy:check` step must not be conditional",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("requires template ownership to gate, strip and sign every added file", async () => {
		const temporary = await skeletonFixture();
		const ownership =
			"docs/devcontainer-upgrade/stage-0/template-ownership.json";
		try {
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "proxy-routes.json", "requiresAll": ["vite_websocket_proxy"] },\n\t\t',
						"",
					),
				"proxy: proxy-routes.json must be gated by the capability",
			);
			// The reserved configuration path is gated even though nothing creates
			// it, so the first downstream project to write one is governed from its
			// first commit rather than from the commit somebody noticed.
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "vite.config.ts", "requiresAll": ["vite_websocket_proxy"] },\n\t\t',
						"",
					),
				"proxy: vite.config.ts must be gated by the capability",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace('"scripts": ["proxy:check"]', '"scripts": []'),
				"proxy: the vite_websocket_proxy package rule must strip the proxy:check script",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"tokens": ["ws: true", "proxy:check"]',
						'"tokens": []',
					),
				"proxy: proxy:check must be a declared capability signature token",
			);
			// The widened glob joins the Stage 0 reservation rather than replacing
			// it: the reserved string is an exact filename, so a nested configuration
			// would leak into a render nothing reported.
			await mutate(
				temporary,
				ownership,
				(source) => source.replace('\t\t\t\t"**/vite.config.*",\n', ""),
				"proxy: **/vite.config.* must be a declared capability signature",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"absent": ["playwright", "better_auth"]',
						'"absent": ["playwright", "better_auth", "vite_websocket_proxy"]',
					),
				"proxy: vite_websocket_proxy ships a guard surface and must leave the absent inventory",
			);
			// The render order trap: `scripts/template/**` is `omit`, so a `copy`
			// entry behind it drops the guard while the manifest still declares the
			// script — which the fixture suite reports as a different error in a
			// different file.
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'\t\t\t"pattern": "scripts/template/proxy-contract.ts",\n\t\t\t"classification": "template-owned",',
						'\t\t\t"pattern": "scripts/template/proxy-contract.ts.moved",\n\t\t\t"classification": "template-owned",',
					),
				"proxy: template ownership must cover scripts/template/proxy-contract.ts",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a registry that does not match its own schema", async () => {
		const temporary = await skeletonFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"schemaVersion": 1', '"schemaVersion": 2'),
				`proxy: ${REGISTRY_PATH} $.schemaVersion must equal 1`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace('"routes": [],', '"routes": [], "extra": 1,'),
				`proxy: ${REGISTRY_PATH} $.extra is not allowed`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"runtime": "bun"', '"runtime": "deno"'),
				`proxy: ${REGISTRY_PATH} $.runtime must be one of ["bun","node"]`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("worktree runtime reconciliation", () => {
	test("refuses a registry that disagrees with the worktree runtime contract", async () => {
		const temporary = await skeletonFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"publishedContainerPort": 8080',
						'"publishedContainerPort": 8081',
					),
				`proxy: ${REGISTRY_PATH} declares the published container port 8081 and ${WORKTREE_CONTRACT_PATH} declares 8080`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"friendlyDomainPattern": "{workspace}.{project}.localhost"',
						'"friendlyDomainPattern": "{workspace}.example.invalid"',
					),
				`proxy: ${REGISTRY_PATH} declares the friendly domain pattern {workspace}.example.invalid and ${WORKTREE_CONTRACT_PATH} declares {workspace}.{project}.localhost`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("says out loud when there was nothing to reconcile against", async () => {
		// A gated guard must not hard-depend on a file another capability owns, so
		// the absent contract is a NOTICE and not an error. It is still printed,
		// because "checked nothing" and "found nothing wrong" produce the same exit
		// status and are not the same claim.
		const temporary = await proxyWorkspace({
			prefix: "devenv-proxy-no-worktree-",
			withoutWorktreeContract: true,
		});
		try {
			const report = await inspectProxyContract(temporary);
			expect(report.errors).toEqual([]);
			expect(report.notices).toEqual([
				`proxy: ${WORKTREE_CONTRACT_PATH} is absent, so the published port 8080 and the friendly domain {workspace}.{project}.localhost were declared and not reconciled`,
			]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
		// ... and the template's own tree has the contract, so it is silent.
		expect((await inspectProxyContract(ROOT)).notices).toEqual([]);
	});
});
