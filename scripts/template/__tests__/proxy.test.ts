// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The mutations write
// runner expressions into a workflow verbatim.
import { describe, expect, test } from "bun:test";
import { link, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	deriveTreeState,
	inspectProxyContract,
	NEEDLES,
	type ProxyRoutes,
	REGISTRY_PATH,
	readProxyRoutes,
	validateProxyContract,
	validateSoleDeclarations,
} from "../proxy-contract";
import {
	ACTIVE_CONFIG_SOURCE,
	API_UPSTREAM_PORT,
	activeContract,
	activeWorkspace,
	BARE_SERVER_SOURCE,
	CONFIG_PATH,
	declaredRoute,
	declaredServer,
	PROSE_SOURCE,
	PROXY_TABLE_SOURCE,
	PUBLISHED_CONTAINER_PORT,
	proxyWorkspace,
	ROOT,
	SKELETON,
	SOCKET_UPSTREAM_PORT,
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

describe("configuration identity and shape", () => {
	test("accepts an active workspace whose configuration matches its registry", async () => {
		const { root } = await activeWorkspace({ prefix: "devenv-proxy-shape-" });
		try {
			expect(await validateProxyContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a configuration this repository does not exclusively own", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-identity-",
		});
		const target = resolve(root, contract.configPath);
		try {
			// A hardlinked twin. The bytes the guard approves and the bytes the tool
			// loads stop being the same thing the moment somebody writes through the
			// other name, and neither file can tell you that happened.
			await link(target, resolve(root, "vite.config.twin.ts"));
			expect(await validateProxyContract(root)).toContain(
				`proxy: ${contract.configPath} must be an independent ordinary in-tree file with exactly one hard link`,
			);
			await rm(resolve(root, "vite.config.twin.ts"));
			expect(await validateProxyContract(root)).toEqual([]);

			// ... and a symlink, which is the same defect with a visible cause.
			const source = await Bun.file(target).text();
			await Bun.write(resolve(root, "config-real.ts"), source);
			await rm(target);
			await symlink(resolve(root, "config-real.ts"), target);
			expect(await validateProxyContract(root)).toContain(
				`proxy: ${contract.configPath} must be an independent ordinary in-tree file with exactly one hard link`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses every exported shape that is not one effective config object", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-export-",
		});
		try {
			await mutate(
				root,
				contract.configPath,
				(source) =>
					`${source}export = { ${NEEDLES.server}: {} };\n`.replace(
						"export default",
						"const config =",
					),
				`proxy: ${contract.configPath} must not contain an export = assignment; found 1`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) => `${source}export default {};\n`,
				`proxy: ${contract.configPath} must contain exactly one effective default export; found 2`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source
						.replace("export default {", "export default [{")
						.replace(/^};$/m, "}];"),
				`proxy: ${contract.configPath} exported configuration must be an object literal`,
			);
			// A commented-out export is not an export, which is the whole reason
			// this leg is a parse and not a search.
			await tolerate(
				root,
				"decoy.ts",
				`// export default { ${NEEDLES.server}: {} };\nexport const decoy = 1;\n`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("accepts the helper form only when its binding is unambiguous", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-helper-",
			config: `import { defineConfig } from "vite";\n${ACTIVE_CONFIG_SOURCE.replace(
				"export default {",
				"export default defineConfig({",
			).replace(/^};$/m, "});")}`,
		});
		try {
			// The helper form is legal, and so is the import-free form the renderer
			// emits. A template that forced the import would force a dependency on
			// every generated project for no behaviour at all.
			expect(await validateProxyContract(root)).toEqual([]);
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replace(
						'import { defineConfig } from "vite";',
						'import { defineConfig as build } from "vite";\nconst defineConfig = build;',
					),
				`proxy: ${contract.configPath} defineConfig must have exactly one unaliased runtime named import from the build tool and no conflicting local runtime binding`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replace(
						'import { defineConfig } from "vite";',
						"function defineConfig(value: unknown) {\n\treturn value;\n}",
					),
				`proxy: ${contract.configPath} defineConfig must have exactly one unaliased runtime named import from the build tool and no conflicting local runtime binding`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("route shape", () => {
	test("refuses a string shorthand and every undeclared route field", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-form-",
		});
		try {
			// The reference implementation wrote this rule down in its own comment
			// and then shipped three violations of it beside object-form siblings.
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll(
						`"/api": { target: "http://127.0.0.1:${API_UPSTREAM_PORT}", ws: false, changeOrigin: true, secure: true }`,
						`"/api": "http://127.0.0.1:${API_UPSTREAM_PORT}"`,
					),
				`proxy: ${contract.configPath} ${NEEDLES.server} route /api is a string shorthand; a string target never proxies a WebSocket upgrade, so the object form is not a style preference`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll(", ws: false", "").replaceAll(", ws: true", ""),
				`proxy: ${contract.configPath} ${NEEDLES.server} route /api does not declare ws; a route that never states whether it forwards the upgrade has not decided`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) => source.replaceAll(", changeOrigin: true", ""),
				`proxy: ${contract.configPath} ${NEEDLES.server} route /api does not declare changeOrigin`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) => source.replaceAll(", secure: true", ""),
				`proxy: ${contract.configPath} ${NEEDLES.server} route /api does not declare secure`,
			);
			// The single best find in the reference: a route carrying both a rewrite
			// and a forwarded upgrade is structurally valid and nonfunctional, and
			// the reference's own socket client says so and works around it.
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll(
						", ws: true, changeOrigin: true, secure: true }",
						', ws: true, changeOrigin: true, secure: true, rewrite: (p: string) => p.replace(/^\\/socket/, "") }',
					),
				`proxy: ${contract.configPath} ${NEEDLES.server} route /socket rewrites its path and forwards the upgrade; path rewriting and WebSocket upgrade forwarding do not compose`,
			);
			// ... and the toleration that makes the rule a rule rather than a ban on
			// rewriting. A rewrite beside a route that does NOT forward the upgrade
			// is exactly what a rewrite is for.
			const withRewrite = ACTIVE_CONFIG_SOURCE.replaceAll(
				", ws: false, changeOrigin: true, secure: true }",
				', ws: false, changeOrigin: true, secure: true, rewrite: (p: string) => p.replace(/^\\/api/, "") }',
			);
			await Bun.write(resolve(root, contract.configPath), withRewrite);
			expect(await validateProxyContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses every declared route target that is not a loopback upstream", async () => {
		const { root } = await activeWorkspace({ prefix: "devenv-proxy-target-" });
		try {
			for (const [target, tail] of [
				[
					"http://api.example.invalid:8787",
					"is not loopback; a proxy target that names another host is an unintended external call",
				],
				[
					"http://0.0.0.0:8787",
					"binds the wildcard address, which is not an address a client connects to",
				],
				["http://127.0.0.1", "declares no port"],
				[
					"http://127.0.0.1:8787/api",
					"carries a path, a query or a fragment; a proxy target is an origin",
				],
				["not-a-url", "is not an absolute origin"],
			] as const) {
				await mutate(
					root,
					REGISTRY_PATH,
					(source) =>
						source.replace(
							`"http://127.0.0.1:${API_UPSTREAM_PORT}"`,
							`"${target}"`,
						),
					`proxy: the route api targets ${target}, which ${tail}`,
				);
			}
			// A loopback target nothing declares as an upstream is a route to a
			// service this project does not own.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						`"http://127.0.0.1:${API_UPSTREAM_PORT}"`,
						'"http://127.0.0.1:9999"',
					),
				"proxy: the route api targets port 9999, which no declared upstream binds",
			);
			// ... and the other direction: an upstream nothing routes to is a stale
			// entry that outlives the route it was written for.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(`"port": ${API_UPSTREAM_PORT},`, '"port": 9999,'),
				"proxy: the upstream api binds port 9999, which no declared route targets",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a socket target that drops the upgrade and an insecure https target", async () => {
		const { root } = await activeWorkspace({ prefix: "devenv-proxy-upgrade-" });
		try {
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source
						.replace(
							`"http://127.0.0.1:${SOCKET_UPSTREAM_PORT}"`,
							`"ws://127.0.0.1:${SOCKET_UPSTREAM_PORT}"`,
						)
						.replace('"ws": true', '"ws": false'),
				"proxy: the route socket targets a socket scheme and does not forward the upgrade; a route that answers HTTP and drops every upgrade is structurally valid and nonfunctional",
			);
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source
						.replace(
							`"http://127.0.0.1:${API_UPSTREAM_PORT}"`,
							`"https://127.0.0.1:${API_UPSTREAM_PORT}"`,
						)
						.replace('"secure": true', '"secure": false'),
				"proxy: the route api disables certificate verification against an https target",
			);
			// The registry can express the same defect the configuration can, and
			// the message is the same sentence: the socket route is the one that
			// forwards the upgrade, so it is the one a rewrite breaks.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"ws": true,\n\t\t\t"changeOrigin": true,\n\t\t\t"secure": true,\n\t\t\t"rewrite": null',
						'"ws": true,\n\t\t\t"changeOrigin": true,\n\t\t\t"secure": true,\n\t\t\t"rewrite": "^/socket"',
					),
				"proxy: the route socket rewrites its path and forwards the upgrade; path rewriting and WebSocket upgrade forwarding do not compose",
			);
			// ... and the toleration: a rewrite beside a route that does NOT forward
			// the upgrade is exactly what a rewrite is for.
			const registry = resolve(root, REGISTRY_PATH);
			const original = await Bun.file(registry).text();
			await Bun.write(
				registry,
				original.replace(
					'"ws": false,\n\t\t\t"changeOrigin": true,\n\t\t\t"secure": true,\n\t\t\t"rewrite": null',
					'"ws": false,\n\t\t\t"changeOrigin": true,\n\t\t\t"secure": true,\n\t\t\t"rewrite": "^/api"',
				),
			);
			expect(await validateProxyContract(root)).toEqual([]);
			await Bun.write(registry, original);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("dev and preview alignment", () => {
	test("refuses a route that exists for one server and not the other", async () => {
		const marker = `\t\t\t"/socket": { target: "http://127.0.0.1:${SOCKET_UPSTREAM_PORT}", ws: true, changeOrigin: true, secure: true },\n`;
		const first = ACTIVE_CONFIG_SOURCE.indexOf(marker);
		const last = ACTIVE_CONFIG_SOURCE.lastIndexOf(marker);
		// The reference implementation is the worked example: three development
		// routes, two preview routes, disjoint keys — so a surface that worked in
		// development simply was not there in preview, and nothing said so.
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-align-",
			config:
				ACTIVE_CONFIG_SOURCE.slice(0, last) +
				ACTIVE_CONFIG_SOURCE.slice(last + marker.length),
		});
		try {
			expect(await validateProxyContract(root)).toContain(
				`proxy: ${contract.configPath} declares the route /socket for ${NEEDLES.server} and not for ${NEEDLES.preview}; a surface that disappears in preview is a surface nobody tested`,
			);
			// ... and the reverse, which is the direction nobody thinks to check.
			await Bun.write(
				resolve(root, contract.configPath),
				ACTIVE_CONFIG_SOURCE.slice(0, first) +
					ACTIVE_CONFIG_SOURCE.slice(first + marker.length),
			);
			expect(await validateProxyContract(root)).toContain(
				`proxy: ${contract.configPath} declares the route /socket for ${NEEDLES.preview} and not for ${NEEDLES.server}`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a route whose target or upgrade differs between the servers", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-align-drift-",
		});
		try {
			await mutate(
				root,
				contract.configPath,
				(source) => {
					const marker = `"/api": { target: "http://127.0.0.1:${API_UPSTREAM_PORT}"`;
					const last = source.lastIndexOf(marker);
					return `${source.slice(0, last)}"/api": { target: "http://127.0.0.1:${SOCKET_UPSTREAM_PORT}"${source.slice(last + marker.length)}`;
				},
				`proxy: ${contract.configPath} route /api targets http://127.0.0.1:${API_UPSTREAM_PORT} for ${NEEDLES.server} and http://127.0.0.1:${SOCKET_UPSTREAM_PORT} for ${NEEDLES.preview}`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) => {
					const marker = `"/socket": { target: "http://127.0.0.1:${SOCKET_UPSTREAM_PORT}", ws: true`;
					const last = source.lastIndexOf(marker);
					return `${source.slice(0, last)}"/socket": { target: "http://127.0.0.1:${SOCKET_UPSTREAM_PORT}", ws: false${source.slice(last + marker.length)}`;
				},
				`proxy: ${contract.configPath} route /socket forwards the upgrade for one server and not the other`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("host validation", () => {
	test("refuses every allowlist that stops being an allowlist", async () => {
		for (const [hosts, expected] of [
			[
				["localhost", "127.0.0.1", "*.localhost"],
				`proxy: the ${NEEDLES.server} allowed host *.localhost is a wildcard; an allowlist that can match a host nobody enumerated is a disabled defense wearing an allowlist's name`,
			],
			[
				["localhost", "127.0.0.1", ".localhost", "all"],
				`proxy: the ${NEEDLES.server} allowed host "all" disables the host check entirely`,
			],
			[
				["localhost", "127.0.0.1"],
				`proxy: the ${NEEDLES.server} host allowlist omits .localhost; the loopback family and the friendly domain are both browser-visible and both must be listed`,
			],
			[
				[".localhost"],
				`proxy: the ${NEEDLES.server} host allowlist omits localhost; the loopback family and the friendly domain are both browser-visible and both must be listed`,
			],
			[
				[],
				`proxy: the ${NEEDLES.server} host allowlist omits 127.0.0.1; the loopback family and the friendly domain are both browser-visible and both must be listed`,
			],
		] as const) {
			const { root } = await activeWorkspace({
				prefix: "devenv-proxy-hosts-",
				contract: { server: declaredServer({ allowedHosts: [...hosts] }) },
			});
			try {
				expect(await validateProxyContract(root)).toContain(expected);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("refuses a configuration that turns the host check off in one word", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-hosts-true-",
		});
		try {
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll(
						'allowedHosts: ["localhost", "127.0.0.1", ".localhost", "workspace.project.localhost"],',
						"allowedHosts: true,",
					),
				`proxy: ${contract.configPath} ${NEEDLES.server} sets allowedHosts to true; that is a disabled Cross-Site WebSocket Hijacking defense, not a convenience`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("reachability", () => {
	test("refuses a server nothing outside the container can reach", async () => {
		for (const [overrides, expected] of [
			[
				{ strictPort: false },
				`proxy: the ${NEEDLES.server} does not pin strictPort; a server that silently takes the next free port maps the published port to nothing`,
			],
			[
				{ host: "127.0.0.1" },
				`proxy: the ${NEEDLES.server} binds "127.0.0.1"; a server bound to the container's loopback is unreachable through the published port`,
			],
			[
				{ host: false },
				`proxy: the ${NEEDLES.server} binds false; a server bound to the container's loopback is unreachable through the published port`,
			],
			[
				{ port: 5173 },
				`proxy: the ${NEEDLES.server} binds port 5173 and declares no fronting service; nothing binds the published container port ${PUBLISHED_CONTAINER_PORT}`,
			],
			[
				{ port: 5173, frontedBy: "caddy" },
				`proxy: the ${NEEDLES.server} declares the fronting service caddy, which ${WORKTREE_CONTRACT_PATH} does not declare`,
			],
			[
				{ frontedBy: "caddy" },
				`proxy: the ${NEEDLES.server} binds the published container port ${PUBLISHED_CONTAINER_PORT} and also declares the fronting service caddy; exactly one process binds that port`,
			],
		] as const) {
			const { root } = await activeWorkspace({
				prefix: "devenv-proxy-reach-",
				contract: { server: declaredServer(overrides) },
			});
			try {
				expect(await validateProxyContract(root)).toContain(expected);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("a wide bind is accepted only in its literal spelling", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-proxy-reach-wide-",
			contract: { server: declaredServer({ host: "0.0.0.0" }) },
		});
		try {
			// The pairing is the whole safety argument: a wide bind is safe because
			// the host allowlist is strict, and a strict allowlist is useful because
			// the bind is wide. Neither half is optional.
			expect(await validateProxyContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("hot reload and asset origin policy", () => {
	test("refuses every pinned client port and every pinned asset origin", async () => {
		for (const [overrides, expected] of [
			[
				{
					hmr: {
						protocol: null,
						host: null,
						clientPort: 5173,
						reason: "A downstream project pinned it and wrote down why.",
					},
				},
				`proxy: the ${NEEDLES.server} pins the reload client port 5173; two origins are browser-visible at once and one number can match at most one of them`,
			],
			[
				{
					hmr: {
						protocol: null,
						host: null,
						clientPort: PUBLISHED_CONTAINER_PORT,
						reason: "A downstream project pinned it and wrote down why.",
					},
				},
				`proxy: the ${NEEDLES.server} pins the reload client port to the published container port ${PUBLISHED_CONTAINER_PORT}, which is an internal port no browser ever dials`,
			],
			[
				{ origin: "http://127.0.0.1:8080" },
				`proxy: the ${NEEDLES.server} pins the asset origin http://127.0.0.1:8080; two origins are browser-visible at once and a single absolute origin is wrong for whichever one it is not`,
			],
		] as const) {
			const { root } = await activeWorkspace({
				prefix: "devenv-proxy-hmr-",
				contract: { server: declaredServer(overrides) },
			});
			try {
				expect(await validateProxyContract(root)).toContain(expected);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("tolerates an override that carries its reason and pins no port", async () => {
		// The rule is not "never override". It is "never pin a number that can
		// only be right for one of two published origins" — so an override that
		// states its protocol and carries the reason it was needed is a decision
		// rather than a mistake.
		const { root } = await activeWorkspace({
			prefix: "devenv-proxy-hmr-ok-",
			contract: {
				server: declaredServer({
					hmr: {
						protocol: "ws",
						host: null,
						clientPort: null,
						reason:
							"The friendly host terminates plain HTTP, so the client must not infer wss.",
					},
				}),
			},
		});
		try {
			expect(await validateProxyContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a configuration that disables hot reload outright", async () => {
		const { root, contract } = await activeWorkspace({
			prefix: "devenv-proxy-hmr-off-",
		});
		try {
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll(
						"\t\thost: true,",
						"\t\thost: true,\n\t\thmr: false,",
					),
				`proxy: ${contract.configPath} ${NEEDLES.server} disables hot module replacement while the capability that exists to make it work is enabled`,
			);
			await mutate(
				root,
				contract.configPath,
				(source) =>
					source.replaceAll("strictPort: true,", "strictPort: false,"),
				`proxy: ${contract.configPath} ${NEEDLES.server} sets strictPort to false; a server that silently takes the next free port maps the published port to nothing`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
