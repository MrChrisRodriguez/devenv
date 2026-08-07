import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	ParameterValidationError,
} from "../parameters";
import { renderFixture } from "../render-fixture";
import {
	deriveTreeState,
	inspectStartContract,
	NEEDLES,
	readStartSurface,
	reconcileMode,
	type StartSurface,
	validateSoleDeclarations,
	validateStartContract,
} from "../start-contract";
import {
	activeWorkspace,
	appFiles,
	declaredApp,
	PROSE_SOURCE,
	PROXY_REGISTRY_PATH,
	REGISTRY_PATH,
	ROOT,
	ROUTE_TREE_SOURCE,
	skeletonWorkspace,
	startWorkspace,
	TSCONFIG_PATH,
	writeRegistry,
} from "./fixtures/start-workspaces";

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
	expect(await validateStartContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateStartContract(root)).toEqual([]);
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
		expect(await validateStartContract(root)).toContain(expected);
	} finally {
		// Removed in a `finally` on purpose. A planted shape left behind by a
		// failing assertion would make every later case in this file fail for a
		// reason none of them is about.
		await rm(target);
	}
	expect(await validateStartContract(root)).toEqual([]);
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
		expect(await validateStartContract(root)).toEqual([]);
	} finally {
		await rm(target);
	}
}

/** A registry mutation, applied and then reverted, with the tree left alone. */
async function withRegistry(
	root: string,
	contract: StartSurface,
	expected: string,
): Promise<void> {
	const original = await Bun.file(resolve(root, REGISTRY_PATH)).text();
	await writeRegistry(root, contract);
	try {
		expect(await validateStartContract(root)).toContain(expected);
	} finally {
		await Bun.write(resolve(root, REGISTRY_PATH), original);
	}
	expect(await validateStartContract(root)).toEqual([]);
}

describe("the application surface registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateStartContract(ROOT)).toEqual([]);
		const { contract, errors } = await readStartSurface(ROOT);
		expect(errors).toEqual([]);
		expect(contract?.schemaVersion).toBe(1);
		expect(contract?.mode).toBe("skeleton");
		expect(contract?.apps).toEqual([]);
		expect(contract?.tsconfigPath).toBe(TSCONFIG_PATH);
		// The two policy decisions this stage exists to make explicit: the
		// development runtime is the built worker rather than a bundler dev
		// server, and the server render is buffered rather than streamed.
		expect(contract?.devServer).toBe("wrangler");
		expect(contract?.ssr.mode).toBe("buffered");
		// The reserved type entry that does not resolve, declared as forbidden
		// rather than merely removed: removing it fixes the file and leaves the
		// class open.
		expect(contract?.types).toEqual([]);
		expect(contract?.forbiddenTypes.length).toBeGreaterThan(0);
	});

	test("derives the tree state from the tree and never from the registry", async () => {
		const { contract } = await readStartSurface(ROOT);
		const state = deriveTreeState(ROOT, contract);
		// Anti-vacuity in the one place it is easiest to lose: a scan that read
		// nothing would report `skeleton` for every tree there will ever be. This
		// repository is the worked example of why that matters — the shared base
		// this registry governs has been wrong since it was written and every gate
		// has been green, because nothing here compiles it.
		expect(state.scanned).toBeGreaterThan(100);
		expect(state.errors).toEqual([]);
		expect(state.signals).toEqual([]);
		expect(state.mode).toBe("skeleton");
	});

	test("reconciles the declared mode with the derived one in both directions", async () => {
		const skeleton = { mode: "skeleton", apps: [] } as unknown as StartSurface;
		expect(
			reconcileMode(skeleton, {
				mode: "active",
				signals: [
					{
						path: `apps/web/src/${NEEDLES.routeTree}`,
						shape: "route-tree",
						detail: "apps/web declares a generated route tree",
					},
				],
				scanned: 12,
				errors: [],
			}),
		).toEqual([
			`start: ${REGISTRY_PATH} declares skeleton mode but apps/web declares a generated route tree`,
		]);
		const active = {
			mode: "active",
			apps: [],
			tsconfigPath: TSCONFIG_PATH,
		} as unknown as StartSurface;
		expect(
			reconcileMode(active, {
				mode: "skeleton",
				signals: [],
				scanned: 12,
				errors: [],
			}),
		).toEqual([
			`start: ${REGISTRY_PATH} declares active mode but declares no application`,
			`start: ${REGISTRY_PATH} declares active mode but no tracked file carries a generated route tree, a framework dependency, a framework entry call or a project extending ${TSCONFIG_PATH}`,
		]);
	});

	test("a scan that reads nothing fails distinctly instead of passing", async () => {
		const empty = await mkdtemp(resolve(tmpdir(), "devenv-start-empty-"));
		try {
			const state = deriveTreeState(empty);
			expect(state.scanned).toBe(0);
			expect(state.errors).toEqual([
				`start: the tracked-file scan found nothing under ${empty}; a rule with no input has answered nothing`,
			]);
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	test("a second registry anywhere in the tree is refused", async () => {
		expect(
			validateSoleDeclarations(
				[REGISTRY_PATH, `apps/web/${REGISTRY_PATH}`],
				undefined,
			),
		).toEqual([
			`start: apps/web/${REGISTRY_PATH} is a second application surface registry; ${REGISTRY_PATH} is the only one`,
		]);
	});
});

describe("the skeleton workspace", () => {
	test("accepts a workspace that carries the committed declaration", async () => {
		const root = await skeletonWorkspace();
		try {
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a generated route tree planted at depth flips the derived mode", async () => {
		const root = await skeletonWorkspace();
		try {
			await withFile(
				root,
				`apps/platform-start/src/nested/${NEEDLES.routeTree}`,
				ROUTE_TREE_SOURCE,
				`start: ${REGISTRY_PATH} declares skeleton mode but apps/platform-start/src/nested/${NEEDLES.routeTree} is a generated route tree, and its presence is what marks this project as carrying an application of this stack`,
			);
			// ... and a file that only NAMES the entry helper is not one. The signal
			// is a call read off the syntax tree, so prose and a string literal both
			// stay legal.
			await tolerate(root, "apps/platform-start/src/notes.ts", PROSE_SOURCE);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a framework dependency in any manifest section flips the derived mode", async () => {
		const root = await skeletonWorkspace();
		const dependency = `${NEEDLES.scope}react-start`;
		try {
			await withFile(
				root,
				"apps/platform-start/package.json",
				`${JSON.stringify(
					{
						name: "platform-start",
						dependencies: { [dependency]: "1.168.27" },
					},
					null,
					"\t",
				)}\n`,
				`start: ${REGISTRY_PATH} declares skeleton mode but apps/platform-start/package.json depends on ${dependency}`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a project extending the shared base flips the derived mode", async () => {
		const root = await skeletonWorkspace();
		try {
			await withFile(
				root,
				"apps/platform-start/tsconfig.json",
				`${JSON.stringify({ extends: `../../${TSCONFIG_PATH}` }, null, "\t")}\n`,
				`start: ${REGISTRY_PATH} declares skeleton mode but apps/platform-start/tsconfig.json extends ${TSCONFIG_PATH}, so the shared base is compiled by something`,
			);
			// The repository base is a different file, and extending it is what every
			// other project here already does.
			await tolerate(
				root,
				"apps/platform-start/tsconfig.json",
				`${JSON.stringify({ extends: "../../tsconfig.base.json" }, null, "\t")}\n`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a skeleton that declares an application is refused from the registry side", async () => {
		const root = await skeletonWorkspace();
		try {
			const { contract } = await readStartSurface(root);
			if (!contract) throw new Error("The committed registry did not parse");
			await withRegistry(
				root,
				{ ...contract, apps: [declaredApp()] },
				`start: ${REGISTRY_PATH} declares skeleton mode but declares 1 applications`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("guard wiring and template ownership", () => {
	test("the package script, the workflow step and its fence are all contract", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				"package.json",
				(source) =>
					source.replace(
						'"start:check": "bun scripts/template/validate-start.ts",\n\t\t',
						"",
					),
				"start: package script start:check must run scripts/template/validate-start.ts",
			);
			await mutate(
				root,
				".github/workflows/ci.yml",
				(source) => source.replace("bun run start:check", "bun run noop:check"),
				"start: the ci job must run `bun run start:check` in the required lane",
			);
			await mutate(
				root,
				".github/workflows/ci.yml",
				(source) =>
					source
						.replace(
							"      # capability:start tanstack_start\n",
							"      # capability:start playwright\n",
						)
						.replace(
							"      # capability:end tanstack_start\n",
							"      # capability:end playwright\n",
						),
				"start: the `bun run start:check` step must sit inside a tanstack_start capability fence",
			);
			await mutate(
				root,
				".github/workflows/ci.yml",
				(source) =>
					source.replace(
						"      - name: Validate application surface and server render contract\n        run: bun run start:check\n",
						"      - name: Validate application surface and server render contract\n        if: github.event_name == 'push'\n        run: bun run start:check\n",
					),
				"start: the `bun run start:check` step must not be conditional",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("every declared file is missing-checked and the shared base is required", async () => {
		const root = await skeletonWorkspace();
		try {
			for (const path of [
				"start-surface.schema.json",
				"scripts/template/start-contract.ts",
				"scripts/template/validate-start.ts",
			]) {
				const target = resolve(root, path);
				const original = await Bun.file(target).text();
				await rm(target);
				try {
					// The schema's absence stops the registry read before the wiring leg
					// is reached, so both sentences are legitimate answers here.
					const errors = await validateStartContract(root);
					expect(
						errors.includes(`start: ${path} is missing`) ||
							errors.includes(`start: ${REGISTRY_PATH} is missing`),
					).toBe(true);
				} finally {
					await Bun.write(target, original);
				}
			}
			const base = resolve(root, TSCONFIG_PATH);
			const original = await Bun.file(base).text();
			await rm(base);
			try {
				expect(await validateStartContract(root)).toContain(
					`start: ${REGISTRY_PATH} declares ${TSCONFIG_PATH}, which is missing`,
				);
			} finally {
				await Bun.write(base, original);
			}
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("template ownership gates every added file and strips the script", async () => {
		const root = await skeletonWorkspace();
		const ownership =
			"docs/devcontainer-upgrade/stage-0/template-ownership.json";
		try {
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "start-surface.json", "requiresAll": ["tanstack_start"] },\n\t\t',
						"",
					),
				"start: start-surface.json must be gated by the capability",
			);
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'"capability": "tanstack_start",\n\t\t\t"sections": [],\n\t\t\t"packages": [],\n\t\t\t"scripts": ["start:check"]',
						'"capability": "tanstack_start",\n\t\t\t"sections": [],\n\t\t\t"packages": [],\n\t\t\t"scripts": []',
					),
				"start: the tanstack_start package rule must strip the start:check script",
			);
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'"tokens": ["@tanstack/start", "@tanstack/", "start:check"]',
						'"tokens": ["@tanstack/start"]',
					),
				`start: ${NEEDLES.scope} must be a declared capability signature token`,
			);
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'"start-surface.schema.json",\n\t\t\t\t"scripts/template/start-contract.ts",',
						'"scripts/template/start-contract.ts",',
					),
				"start: start-surface.schema.json must be a declared capability signature",
			);
			// The inventory is maintained rather than decorative: a capability that
			// ships four gated files is no longer advertised with nothing behind it.
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'"advertisedOnly": ["cloudflare_workers"]',
						'"advertisedOnly": ["cloudflare_workers", "tanstack_start"]',
					),
				"start: tanstack_start ships a guard surface and must leave the advertisedOnly inventory",
			);
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'"absent": ["playwright", "better_auth"]',
						'"absent": ["playwright", "better_auth", "tanstack_start"]',
					),
				"start: tanstack_start ships a guard surface and must leave the absent inventory",
			);
			// The explicit copy entries must precede the template-tooling omit
			// catch-all, or the render drops the guard while the manifest still
			// declares the script it runs.
			await mutate(
				root,
				ownership,
				(source) =>
					source.replace(
						'\t\t{\n\t\t\t"pattern": "scripts/template/start-contract.ts",\n\t\t\t"classification": "template-owned",\n\t\t\t"syncPolicy": "merge",\n\t\t\t"renderPolicy": "copy",\n\t\t\t"sourceOfTruth": "start-surface.json"\n\t\t},\n',
						"",
					),
				"start: template ownership must cover scripts/template/start-contract.ts",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the declared capability dependency", () => {
	test("the proxy registry is read as data, with a named notice when absent", async () => {
		const root = await startWorkspace({ withoutProxyRegistry: true });
		try {
			const report = await inspectStartContract(root);
			expect(report.errors).toEqual([]);
			// Absence is a NOTICE and not an error. It is still printed, because
			// "checked nothing" and "found nothing wrong" produce the same exit
			// status and are not the same claim.
			expect(report.notices).toContain(
				`start: ${PROXY_REGISTRY_PATH} is absent, so the development proxy route table was declared elsewhere and not reconciled`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a declared proxy route the proxy registry does not declare is refused", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			expect(await validateStartContract(root)).toEqual([]);
			const app = declaredApp({ proxyRouteId: "platform" });
			await writeRegistry(root, { ...contract, apps: [app] });
			expect(await validateStartContract(root)).toContain(
				`start: the application platform declares the proxy route platform, which ${PROXY_REGISTRY_PATH} does not declare`,
			);
			// ... and the same declaration reconciles once that registry names it.
			const proxy = JSON.parse(
				await Bun.file(resolve(root, PROXY_REGISTRY_PATH)).text(),
			) as Record<string, unknown>;
			await Bun.write(
				resolve(root, PROXY_REGISTRY_PATH),
				`${JSON.stringify(
					{
						...proxy,
						routes: [
							{
								id: "platform",
								path: "/",
								target: "http://127.0.0.1:8787",
								ws: false,
								changeOrigin: true,
								secure: true,
								rewrite: null,
							},
						],
					},
					null,
					"\t",
				)}\n`,
			);
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the absent proxy registry names every route it could not reconcile", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			await rm(resolve(root, PROXY_REGISTRY_PATH));
			await writeRegistry(root, {
				...contract,
				apps: [declaredApp({ proxyRouteId: "platform" })],
			});
			const report = await inspectStartContract(root);
			expect(report.errors).toEqual([]);
			expect(report.notices).toContain(
				`start: ${PROXY_REGISTRY_PATH} is absent, so the declared proxy route platform was declared and not reconciled`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the rules that live in core are named rather than duplicated", async () => {
		const report = await inspectStartContract(ROOT);
		expect(report.notices).toContain(
			`start: baseUrl is refused in every tsconfig by toolchain:check, which already covers ${TSCONFIG_PATH}; it is not re-checked here`,
		);
		expect(report.notices).toContain(
			"start: the coupled build-tool and worker-runtime pin family is owned by toolchain:check, because it must hold whenever that capability is enabled and this one is not",
		);
	});
});

describe("the development runtime policy", () => {
	test("a bundler development server is a refusal a reasoned waiver lifts", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			await withRegistry(
				root,
				{ ...contract, devServer: "vite" },
				"start: start-surface.json declares a bundler development server; the built worker under the pinned command-line tool is the declared runtime, because a dev server resolves modules at request time and fails the server render with a module-resolution error the build does not have",
			);
			await writeRegistry(root, {
				...contract,
				devServer: "vite",
				viteDevWaiver: {
					reason:
						"This project has no internal subpath imports, so the measured module-resolution class cannot occur.",
				},
			});
			const waived = await inspectStartContract(root);
			expect(waived.errors).toEqual([]);
			expect(waived.notices).toContain(
				"start: the bundler development server is declared under a waiver: This project has no internal subpath imports, so the measured module-resolution class cannot occur.",
			);
			// ... and a waiver that lifts nothing is refused in turn: a stale
			// exemption widens itself.
			await withRegistry(
				root,
				{
					...contract,
					viteDevWaiver: {
						reason:
							"This project has no internal subpath imports, so the measured module-resolution class cannot occur.",
					},
				},
				"start: start-surface.json carries a development server waiver that lifts nothing; a stale exemption widens itself",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the capability dependency edge", () => {
	test("the capability cannot be enabled without the proxy capability", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-start-deps-"));
		try {
			await mkdir(resolve(temporary, "fixtures/template"), { recursive: true });
			for (const path of [
				"template-parameters.toml",
				"template-parameters.schema.json",
			])
				await Bun.write(
					resolve(temporary, path),
					await Bun.file(resolve(ROOT, path)).text(),
				);
			for (const name of ["minimal", "cloud", "full"]) {
				await Bun.write(
					resolve(temporary, `fixtures/template/${name}.toml`),
					await Bun.file(
						resolve(ROOT, `fixtures/template/${name}.toml`),
					).text(),
				);
			}
			const parameters = await loadTemplateParameters(temporary);
			// The fourth cell of the dependency matrix — the capability enabled with
			// a dependency disabled — is not renderable at all: the parameter parse
			// fails first, which is the only way that cell can be proved.
			await Bun.write(
				resolve(temporary, "fixtures/template/full.toml"),
				(
					await Bun.file(resolve(ROOT, "fixtures/template/full.toml")).text()
				).replace(
					"vite_websocket_proxy = true",
					"vite_websocket_proxy = false",
				),
			);
			let issues: string[] = [];
			try {
				await loadFixtureDefinition(temporary, "full", parameters);
			} catch (error) {
				issues =
					error instanceof ParameterValidationError
						? error.issues
						: [String(error)];
			}
			expect(issues).toContain(
				"capabilities.tanstack_start requires vite_websocket_proxy",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

async function runGuard(
	root: string,
): Promise<{ code: number; output: string; errors: string[] }> {
	const run = Bun.spawn(["bun", "run", "start:check"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, output, stderr] = await Promise.all([
		run.exited,
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
	]);
	return {
		code,
		output,
		errors: stderr
			.split("\n")
			.filter((line) => line.startsWith("start: "))
			.filter((line) => !line.includes("is not re-checked here"))
			.filter((line) => !line.includes("is owned by toolchain:check")),
	};
}

describe("the rendered fixtures", () => {
	test("the guard runs for real in an enabled render and is absent from a disabled one", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-start-render-"));
		try {
			const enabled = resolve(temporary, "full");
			await renderFixture({ root: ROOT, fixtureName: "full", output: enabled });

			// A fresh render has not installed anything yet, and the syntax legs need
			// the compiler. The verdict has to be a DISTINCT failure rather than a
			// pass, because "found no application" and "could not look" are the same
			// answer to a guard that does not check.
			const uninstalled = await runGuard(enabled);
			expect(uninstalled.code).toBe(1);
			expect(uninstalled.errors).toContain(
				"start: the TypeScript compiler API is unavailable; run bun install before start:check",
			);

			// ... and the same render, once it has what the guard needs, returns a
			// real green verdict rather than a skipped leg.
			await symlink(
				resolve(ROOT, "node_modules"),
				resolve(enabled, "node_modules"),
				"dir",
			);
			const installed = await runGuard(enabled);
			expect(installed.errors).toEqual([]);
			expect(installed.code).toBe(0);
			expect(installed.output).toContain(
				"Validated the application surface registry",
			);

			for (const name of ["minimal", "cloud"]) {
				const disabled = resolve(temporary, name);
				await renderFixture({
					root: ROOT,
					fixtureName: name,
					output: disabled,
				});
				for (const path of [
					"start-surface.json",
					"start-surface.schema.json",
					"scripts/template/start-contract.ts",
					"scripts/template/validate-start.ts",
					TSCONFIG_PATH,
				])
					expect(await Bun.file(resolve(disabled, path)).exists()).toBe(false);
				const manifest = await Bun.file(
					resolve(disabled, "package.json"),
				).json();
				expect(manifest.scripts["start:check"]).toBeUndefined();
				const workflow = await Bun.file(
					resolve(disabled, ".github/workflows/ci.yml"),
				).text();
				expect(workflow).not.toContain("start:check");
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180000);
});

describe("the declared application", () => {
	test("an active workspace with one declared application is accepted", async () => {
		const { root } = await activeWorkspace();
		try {
			expect(await validateStartContract(root)).toEqual([]);
			const state = deriveTreeState(root);
			expect(state.mode).toBe("active");
			expect(state.scanned).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("two applications may not claim one directory, prefix or proxy route", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			const twin = declaredApp({ id: "second" });
			await withRegistry(
				root,
				{ ...contract, apps: [declaredApp(), twin] },
				`start: the directory ${twin.directory} is claimed by both platform and second`,
			);
			await withRegistry(
				root,
				{
					...contract,
					apps: [
						declaredApp({ proxyRouteId: "shared" }),
						declaredApp({
							id: "second",
							directory: "apps/second-start",
							basePath: "/second/",
							routerBasepath: "/second",
							proxyRouteId: "shared",
						}),
					],
				},
				"start: the proxy route shared is claimed by both platform and second",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the declared artefacts of an application travel with its declaration", async () => {
		const app = declaredApp({
			id: "games",
			directory: "apps/games-start",
			basePath: "/games/",
			routerBasepath: "/games",
		});
		const { root } = await activeWorkspace({
			contract: { apps: [app] },
			files: appFiles(app),
		});
		try {
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
