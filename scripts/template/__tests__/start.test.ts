import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
	APP_DIRECTORY,
	activeWorkspace,
	appFiles,
	compilerBinary,
	declaredApp,
	PROSE_SOURCE,
	PROXY_REGISTRY_PATH,
	REGISTRY_PATH,
	ROOT,
	ROUTE_TREE_SOURCE,
	skeletonWorkspace,
	startWorkspace,
	TSCONFIG_PATH,
	typecheckWorkspace,
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

/** The compatibility flag this stack's server bundle cannot boot without. */
const COMPATIBILITY_FLAG = "nodejs_compat";

/** The compiler, run for real against a project that really extends the base. */
async function runCompiler(
	project: string,
): Promise<{ code: number; output: string }> {
	// `Bun.spawn` and never `Bun.spawnSync`: a synchronous spawn blocks the loop
	// this suite's other cases need, and it presents as a hang rather than an
	// error. The deadline is bounded for the same reason.
	const run = Bun.spawn(["bun", compilerBinary(), "--noEmit", "-p", project], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const deadline = setTimeout(() => run.kill(), 120000);
	try {
		const [code, output, errors] = await Promise.all([
			run.exited,
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
		]);
		return { code, output: `${output}${errors}` };
	} finally {
		clearTimeout(deadline);
	}
}

describe("the shared TypeScript base, compiled for real", () => {
	test("the repaired base compiles clean and the reserved entry fails TS2688", async () => {
		const { root, project, base } = await typecheckWorkspace();
		try {
			// The tolerate half. A base nothing compiles is green forever, so the
			// only proof that this repair is a repair is the compiler's own verdict
			// over a project that really extends it.
			const clean = await runCompiler(project);
			expect(clean.output).toBe("");
			expect(clean.code).toBe(0);

			// ... and the mutate half, which is the defect this file shipped with
			// since Stage 0: the entry names a subpath the router package does not
			// export. `vite build` was never affected, because esbuild ignores
			// `types` entirely — so a build-based proof of this repair would have
			// been green against the broken file.
			const original = await Bun.file(base).text();
			await Bun.write(
				base,
				original.replace(
					'"types": []',
					'"types": ["@tanstack/react-router/globals"]',
				),
			);
			const mutated = await runCompiler(project);
			expect(mutated.output).toContain("error TS2688");
			expect(mutated.output).toContain("@tanstack/react-router/globals");
			expect(mutated.code).not.toBe(0);

			// ... and the repair restores the clean verdict, so the failure is the
			// entry and not the workspace.
			await Bun.write(base, original);
			const restored = await runCompiler(project);
			expect(restored.code).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 300000);

	test("a stale include entry would exit TS18003 rather than typecheck nothing", async () => {
		const { root, project, base } = await typecheckWorkspace();
		try {
			// The generalized rule behind dropping `app.config.ts`: an include entry
			// naming a concrete file nothing produces is a claim about a file layout,
			// and when it is the ONLY matching pattern the compiler refuses outright.
			await Bun.write(
				resolve(project, "tsconfig.json"),
				`${JSON.stringify(
					{ extends: `../${TSCONFIG_PATH}`, include: ["app.config.ts"] },
					null,
					"\t",
				)}\n`,
			);
			const stale = await runCompiler(project);
			expect(stale.output).toContain("error TS18003");
			expect(stale.code).not.toBe(0);
			expect(await Bun.file(base).text()).toContain('"types": []');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 300000);
});

describe("the shared TypeScript base, as a declaration", () => {
	test("the base must extend the repository base and keep the strict set", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) =>
					source.replace('"extends": "./tsconfig.base.json",\n\t', ""),
				`start: ${TSCONFIG_PATH} must extend tsconfig.base.json; a base that restates a weaker option set beside the repository base calls itself strict without being it`,
			);
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) =>
					source.replace(
						'"noEmit": true',
						'"noEmit": true,\n\t\t"strict": false',
					),
				`start: ${TSCONFIG_PATH} must set strict to true`,
			);
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) =>
					source.replace(
						'"noEmit": true',
						'"noEmit": true,\n\t\t"moduleResolution": "NodeNext"',
					),
				`start: ${TSCONFIG_PATH} must resolve modules as bundler`,
			);
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) => source.replace('"jsx": "react-jsx",\n\t\t', ""),
				`start: ${TSCONFIG_PATH} must declare jsx`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("an include entry no declared application produces is refused", async () => {
		const root = await skeletonWorkspace();
		try {
			await mutate(
				root,
				TSCONFIG_PATH,
				(source) =>
					source.replace(
						'"include": ["src", "*.d.ts"]',
						'"include": ["src", "app.config.ts", "*.d.ts"]',
					),
				`start: ${TSCONFIG_PATH} includes app.config.ts, which no declared application produces; an include entry that can never match is a claim about a file layout that no longer exists`,
			);
			// The tolerate half: a directory entry and a glob are not concrete
			// filenames, so neither is a claim about a file some application has to
			// produce, and both stay legal.
			const target = resolve(root, TSCONFIG_PATH);
			const original = await Bun.file(target).text();
			await Bun.write(
				target,
				original.replace(
					'"include": ["src", "*.d.ts"]',
					'"include": ["src", "test", "**/*.d.ts"]',
				),
			);
			try {
				expect(await validateStartContract(root)).toEqual([]);
			} finally {
				await Bun.write(target, original);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the base must be a file this repository exclusively owns", async () => {
		const root = await skeletonWorkspace();
		const target = resolve(root, TSCONFIG_PATH);
		try {
			const original = await Bun.file(target).text();

			// A guard that reads a symlink validates a file it does not own: the
			// bytes it approves and the bytes the compiler loads stop being the same
			// thing the moment somebody repoints the link.
			await Bun.write(resolve(root, "elsewhere.json"), original);
			await rm(target);
			await symlink(resolve(root, "elsewhere.json"), target);
			expect(await validateStartContract(root)).toContain(
				`start: ${TSCONFIG_PATH} must be an independent ordinary in-tree file with exactly one hard link`,
			);
			await rm(target);
			await rm(resolve(root, "elsewhere.json"));
			await Bun.write(target, original);
			expect(await validateStartContract(root)).toEqual([]);

			// ... and a hardlinked twin is the same defect without a symlink to see.
			await link(target, resolve(root, "twin.json"));
			expect(await validateStartContract(root)).toContain(
				`start: ${TSCONFIG_PATH} must be an independent ordinary in-tree file with exactly one hard link`,
			);
			await rm(resolve(root, "twin.json"));
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("every type entry must resolve, and a forbidden one is refused whether it does or not", async () => {
		const root = await startWorkspace({ withNodeModules: true });
		const target = resolve(root, TSCONFIG_PATH);
		const original = await Bun.file(target).text();
		const { contract } = await readStartSurface(root);
		if (!contract) throw new Error("The committed registry did not parse");
		const withTypes = async (
			entries: string[],
			expected?: string,
		): Promise<string[]> => {
			await Bun.write(
				target,
				original.replace('"types": []', `"types": ${JSON.stringify(entries)}`),
			);
			await writeRegistry(root, { ...contract, types: entries });
			const errors = await validateStartContract(root);
			if (expected !== undefined) expect(errors).toContain(expected);
			return errors;
		};
		try {
			// The tolerate half: an entry that resolves and is not forbidden.
			expect(await withTypes(["bun-types"])).toEqual([]);

			// An entry that does not resolve. This is the general rule the reserved
			// entry is one instance of — removing that one entry would fix the file
			// and leave the class open.
			await withTypes(
				["@acme/does-not-exist"],
				`start: ${TSCONFIG_PATH} declares the type entry @acme/does-not-exist, which does not resolve; the build never reads this list and only the typechecker does, so an unresolvable entry is green everywhere a build is the proof`,
			);

			// ... and a forbidden entry is refused on its name, before resolution is
			// even asked about.
			await withTypes(
				["@tanstack/react-router/globals"],
				`start: ${TSCONFIG_PATH} declares the forbidden type entry @tanstack/react-router/globals; removing it would fix this file and leave the class open, which is why the entry is declared forbidden rather than merely deleted`,
			);

			// The registry and the file must agree, so neither can drift alone.
			await Bun.write(target, original);
			await writeRegistry(root, { ...contract, types: ["bun-types"] });
			expect(await validateStartContract(root)).toContain(
				`start: ${TSCONFIG_PATH} declares the types [] and ${REGISTRY_PATH} declares ["bun-types"]`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a workspace with no resolver reports a notice rather than a silent miss", async () => {
		const root = await skeletonWorkspace();
		const target = resolve(root, TSCONFIG_PATH);
		try {
			const original = await Bun.file(target).text();
			const { contract } = await readStartSurface(root);
			if (!contract) throw new Error("The committed registry did not parse");
			await Bun.write(
				target,
				original.replace('"types": []', '"types": ["bun-types"]'),
			);
			await writeRegistry(root, { ...contract, types: ["bun-types"] });
			const report = await inspectStartContract(root);
			expect(report.errors).toEqual([]);
			expect(report.notices).toContain(
				`start: no module resolver is available under ${root}, so the type entry bun-types was declared and not resolved`,
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

	test("the server render policy is a declared matrix, and streaming is waivable", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			await withRegistry(
				root,
				{ ...contract, ssr: { ...contract.ssr, mode: "streaming" } },
				`start: ${REGISTRY_PATH} declares a streamed server render; the buffered render is the declared default because this worker runtime's backpressure and abort behaviour under a stream is unproven`,
			);
			// The tolerate half: "unproven" is a statement about a date rather than a
			// law, so a reasoned waiver keeps it a decision the next reader can
			// re-open with evidence.
			await writeRegistry(root, {
				...contract,
				ssr: {
					...contract.ssr,
					mode: "streaming",
					streamingWaiver: {
						reason:
							"Backpressure and abort behaviour were measured end to end on the pinned runtime.",
					},
				},
			});
			const waived = await inspectStartContract(root);
			expect(waived.errors).toEqual([]);
			expect(waived.notices).toContain(
				"start: the server render is streamed under a declared waiver: Backpressure and abort behaviour were measured end to end on the pinned runtime.",
			);
			// ... and a waiver beside the buffered default lifts nothing.
			await withRegistry(
				root,
				{
					...contract,
					ssr: {
						...contract.ssr,
						streamingWaiver: {
							reason:
								"Backpressure and abort behaviour were measured end to end on the pinned runtime.",
						},
					},
				},
				`start: ${REGISTRY_PATH} carries a streaming waiver that lifts nothing; a stale exemption widens itself`,
			);
			await withRegistry(
				root,
				{ ...contract, ssr: { ...contract.ssr, methods: ["GET"] } },
				`start: ${REGISTRY_PATH} declares the document methods ["GET"]; a document is a read, and HEAD is answered with GET semantics minus the body`,
			);
			await withRegistry(
				root,
				{
					...contract,
					ssr: {
						...contract.ssr,
						methodRejection: { status: 404, allowHeader: "GET, HEAD" },
					},
				},
				`start: ${REGISTRY_PATH} rejects an unsupported document method with 404; a document route that answers anything but 405 has told the caller the wrong thing`,
			);
			await withRegistry(
				root,
				{
					...contract,
					ssr: {
						...contract.ssr,
						methodRejection: { status: 405, allowHeader: "GET" },
					},
				},
				`start: ${REGISTRY_PATH} rejects with the allow header "GET" while declaring the methods ["GET","HEAD"]`,
			);
			await withRegistry(
				root,
				{ ...contract, ssr: { ...contract.ssr, cacheControl: "no-store" } },
				`start: ${REGISTRY_PATH} declares the cache directive "no-store"; these payloads are per-user and must never be shared-cached, on every response class alike`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the hand-written worker configuration is reconciled with the declaration", async () => {
		const { root, contract } = await activeWorkspace();
		const config = `${APP_DIRECTORY}/wrangler.jsonc`;
		try {
			await mutate(
				root,
				config,
				(source) =>
					source.replace(
						`"${COMPATIBILITY_FLAG}"`,
						'"streams_enable_constructors"',
					),
				`start: ${config} omits the compatibility flag ${COMPATIBILITY_FLAG}; this stack's server bundle requires it and its absence fails at module evaluation rather than at a request`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace('"workers_dev": false', '"workers_dev": true'),
				`start: ${config} must declare workers_dev as false; a generated subdomain is a public origin nobody enumerated`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace('"preview_urls": false', '"preview_urls": true'),
				`start: ${config} must declare preview_urls as false; a generated preview origin is a public origin nobody enumerated`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace(
						'"workers_dev": false',
						'"assets": { "directory": "./dist/client" },\n\t"workers_dev": false',
					),
				`start: ${config} hand-writes an assets block; the plugin synthesizes it into the generated configuration, so a hand-written one is a second authority for one directory`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace('"main": "src/server.ts"', '"main": "src/index.ts"'),
				`start: ${config} declares the entry "src/index.ts" and ${REGISTRY_PATH} declares "src/server.ts"`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace(
						'"workers_dev": false',
						'"services": [{ "binding": "GATEWAY", "service": "gateway" }],\n\t"workers_dev": false',
					),
				`start: ${config} binds GATEWAY to gateway, which ${REGISTRY_PATH} does not declare; the allowlist is closed because a narrow binding set is what makes a leak structurally impossible`,
			);
			await mutate(
				root,
				config,
				(source) =>
					source.replace(
						'"workers_dev": false',
						'"kv_namespaces": [{ "binding": "CACHE", "id": "abc" }],\n\t"workers_dev": false',
					),
				`start: ${config} declares the forbidden binding kind kv_namespaces`,
			);
			// The tolerate half of the closed allowlist: a binding the registry
			// declares is accepted in both the source configuration and the artefact.
			const binding = { binding: "GATEWAY", service: "gateway" };
			const original = await Bun.file(resolve(root, config)).text();
			const builtPath = `${APP_DIRECTORY}/${contract.build.builtConfigPath}`;
			const built = await Bun.file(resolve(root, builtPath)).text();
			await Bun.write(
				resolve(root, config),
				original.replace(
					'"workers_dev": false',
					`"services": [${JSON.stringify(binding)}],\n\t"workers_dev": false`,
				),
			);
			await Bun.write(
				resolve(root, builtPath),
				built.replace(
					'"assets"',
					`"services": [${JSON.stringify(binding)}],\n\t"assets"`,
				),
			);
			await writeRegistry(root, {
				...contract,
				worker: { ...contract.worker, serviceBindings: [binding] },
			});
			expect(await validateStartContract(root)).toEqual([]);
			// ... and an empty forbidden family is absence, not presence.
			await Bun.write(
				resolve(root, config),
				original.replace(
					'"workers_dev": false',
					'"kv_namespaces": [],\n\t"workers_dev": false',
				),
			);
			await Bun.write(resolve(root, builtPath), built);
			await writeRegistry(root, contract);
			expect(await validateStartContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the built worker configuration is the only portable proof of a build", async () => {
		const { root, contract } = await activeWorkspace();
		const built = `${APP_DIRECTORY}/${contract.build.builtConfigPath}`;
		try {
			await mutate(
				root,
				built,
				(source) => source.replace('"main": "index.js"', '"main": "server.js"'),
				`start: ${built} declares the built entry "server.js" and ${REGISTRY_PATH} declares "index.js"`,
			);
			await mutate(
				root,
				built,
				(source) =>
					source.replace('"directory": "../client"', '"directory": "./client"'),
				`start: ${built} serves assets from "./client" and ${REGISTRY_PATH} declares "../client"`,
			);
			await mutate(
				root,
				built,
				(source) =>
					source.replace(
						'"assets"',
						'"d1_databases": [{ "binding": "DB", "database_id": "x" }],\n\t"assets"',
					),
				`start: ${built} ships the forbidden binding kind d1_databases in a deploy artefact`,
			);
			await mutate(
				root,
				built,
				(source) =>
					source.replace(
						'"assets"',
						'"services": [{ "binding": "GATEWAY", "service": "gateway" }],\n\t"assets"',
					),
				`start: ${built} ships the service bindings ["GATEWAY=gateway"] and ${REGISTRY_PATH} declares []`,
			);
			// A harness oracle that reaches a deploy artefact is a harness oracle
			// running in production, which is a hard failure and not a warning.
			await writeRegistry(root, {
				...contract,
				worker: {
					...contract.worker,
					harnessOnlyVariables: ["START_E2E_READ_ORACLE"],
				},
			});
			const original = await Bun.file(resolve(root, built)).text();
			await Bun.write(
				resolve(root, built),
				original.replace(
					'"assets"',
					'"vars": { "START_E2E_READ_ORACLE": "1" },\n\t"assets"',
				),
			);
			expect(await validateStartContract(root)).toContain(
				`start: ${built} ships the harness-only variable START_E2E_READ_ORACLE in a deploy artefact`,
			);
			await Bun.write(resolve(root, built), original);
			await writeRegistry(root, contract);
			expect(await validateStartContract(root)).toEqual([]);

			// An absent build output is a NOTICE: a build artefact is not tracked,
			// and "could not compare" is not "found nothing wrong".
			await rm(resolve(root, built));
			const report = await inspectStartContract(root);
			expect(report.errors).toEqual([]);
			expect(report.notices).toContain(
				`start: ${built} is absent, so the built worker configuration of platform was declared and not reconciled`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the asset namespace, the route tree and the router options are decisions", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			await withRegistry(
				root,
				{
					...contract,
					apps: [declaredApp({ basePath: "/games/", routerBasepath: "/" })],
				},
				"start: the application platform serves /games/ and routes /; the public prefix and the router basepath are two spellings of one decision",
			);
			await withRegistry(
				root,
				{ ...contract, apps: [declaredApp({ assetsDir: "assets" })] },
				`start: the application platform emits assets to assets and ${REGISTRY_PATH} declares ${contract.build.assetsPrefix}; rewriting document URLs does not move the directory the asset binding serves`,
			);
			await withRegistry(
				root,
				{
					...contract,
					router: { ...contract.router, defaultErrorComponent: false },
				},
				`start: ${REGISTRY_PATH} declares no default error component; without one the router installs NO catch boundary for a match, so a render throw escapes to the nearest ancestor gate and is misreported as a session failure`,
			);
			await withRegistry(
				root,
				{ ...contract, router: { ...contract.router, defaultPreload: true } },
				`start: ${REGISTRY_PATH} enables router-wide preloading; only source-audited high-frequency link sites should speculate, and a router-wide default speculates on every one`,
			);

			const routeTree = `${APP_DIRECTORY}/src/${NEEDLES.routeTree}`;
			await mutate(
				root,
				".gitignore",
				(source) => `${source}\n**/${NEEDLES.routeTree}\n`,
				`start: ${routeTree} is ignored by .gitignore; this route tree is governed as a committed artefact and an ignored one is an artefact nothing reviews`,
			);
			await mutate(
				root,
				"biome.jsonc",
				(source) =>
					source.replace(`"!**/${NEEDLES.routeTree}"`, '"!**/generated"'),
				`start: ${routeTree} is not excluded from the formatter and the linter in biome.jsonc; the generator's raw style fails a lint pass over a freshly built tree that a checked-in copy does not`,
			);
			// The tolerate half: an override block with all three tools off is the
			// other spelling of the same exclusion, and it is accepted. All three
			// have to be off rather than just the formatter, because an assist action
			// rewrites a file just as thoroughly as a format does.
			const biome = resolve(root, "biome.jsonc");
			const originalBiome = await Bun.file(biome).text();
			await Bun.write(
				biome,
				`${JSON.stringify(
					{
						$schema: "https://biomejs.dev/schemas/2.4.16/schema.json",
						files: { includes: ["**"] },
						overrides: [
							{
								includes: [`**/${NEEDLES.routeTree}`],
								linter: { enabled: false },
								formatter: { enabled: false },
								assist: { enabled: false },
							},
						],
					},
					null,
					"\t",
				)}\n`,
			);
			try {
				expect(await validateStartContract(root)).toEqual([]);
			} finally {
				await Bun.write(biome, originalBiome);
			}

			// A declared artefact that does not exist is a declaration nothing
			// produced.
			const entry = resolve(root, `${APP_DIRECTORY}/src/env.d.ts`);
			const ambient = await Bun.file(entry).text();
			await rm(entry);
			expect(await validateStartContract(root)).toContain(
				`start: the application platform declares ${APP_DIRECTORY}/src/env.d.ts, which is missing`,
			);
			await Bun.write(entry, ambient);
			expect(await validateStartContract(root)).toEqual([]);
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

describe("the refusal matrix", () => {
	/**
	 * Every structural refusal this guard can produce, driven one at a time.
	 *
	 * The point is not the individual refusals — each already has a case above —
	 * but the two properties the whole set has to have: every sentence must be
	 * DISTINCT, so a reader can search for the one they were given, and the set
	 * must be non-vacuous, so a guard cannot pass this suite by refusing
	 * everything or by answering nothing at all.
	 */
	test("every refusal is distinct, prefixed, sorted and deduplicated", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			const sentences: string[] = [];
			const registryMutations: Array<Partial<StartSurface>> = [
				{ devServer: "vite" },
				{ ssr: { ...contract.ssr, mode: "streaming" } },
				{ ssr: { ...contract.ssr, methods: ["GET"] } },
				{ ssr: { ...contract.ssr, cacheControl: "public" } },
				{
					ssr: {
						...contract.ssr,
						methodRejection: { status: 404, allowHeader: "GET, HEAD" },
					},
				},
				{ apps: [declaredApp({ assetsDir: "static" })] },
				{ apps: [declaredApp({ basePath: "/games/" })] },
				{ apps: [declaredApp(), declaredApp({ id: "second" })] },
				{ router: { ...contract.router, defaultErrorComponent: false } },
				{ router: { ...contract.router, defaultPreload: true } },
			];
			for (const overrides of registryMutations) {
				await writeRegistry(root, { ...contract, ...overrides });
				const errors = await validateStartContract(root);
				expect(errors.length).toBeGreaterThan(0);
				sentences.push(...errors);
			}
			await writeRegistry(root, contract);

			const fileMutations: Array<[string, (source: string) => string]> = [
				[
					`${APP_DIRECTORY}/wrangler.jsonc`,
					(source) =>
						source.replace('"workers_dev": false', '"workers_dev": true'),
				],
				[
					`${APP_DIRECTORY}/wrangler.jsonc`,
					(source) =>
						source.replace(
							`"${COMPATIBILITY_FLAG}"`,
							'"streams_enable_constructors"',
						),
				],
				[
					`${APP_DIRECTORY}/${contract.build.builtConfigPath}`,
					(source) =>
						source.replace('"main": "index.js"', '"main": "server.js"'),
				],
				[
					TSCONFIG_PATH,
					(source) => source.replace('"noEmit": true', '"noEmit": false'),
				],
				[".gitignore", (source) => `${source}\n**/${NEEDLES.routeTree}\n`],
				[
					"biome.jsonc",
					(source) =>
						source.replace(`"!**/${NEEDLES.routeTree}"`, '"!**/nothing"'),
				],
			];
			for (const [path, transform] of fileMutations) {
				const target = resolve(root, path);
				const original = await Bun.file(target).text();
				await Bun.write(target, transform(original));
				const errors = await validateStartContract(root);
				expect(errors.length).toBeGreaterThan(0);
				sentences.push(...errors);
				await Bun.write(target, original);
			}

			// Every sentence this guard can produce is prefixed with its domain, so
			// an aggregated report never leaves a reader guessing which guard spoke.
			for (const sentence of sentences)
				expect(sentence.startsWith("start: ")).toBe(true);
			// ... and there are genuinely many distinct ones, rather than one
			// sentence returned for every defect.
			expect(new Set(sentences).size).toBeGreaterThan(12);

			// The aggregate is sorted and deduplicated, which is what makes a diff
			// of two runs readable.
			await writeRegistry(root, {
				...contract,
				devServer: "vite",
				ssr: { ...contract.ssr, mode: "streaming", cacheControl: "public" },
				router: { ...contract.router, defaultErrorComponent: false },
			});
			const aggregate = await validateStartContract(root);
			expect(aggregate.length).toBeGreaterThan(3);
			expect(new Set(aggregate).size).toBe(aggregate.length);
			expect(aggregate).toEqual([...aggregate].sort());

			// ... and the entirely correct workspace still returns a real verdict
			// rather than an empty one because nothing was looked at.
			await writeRegistry(root, contract);
			expect(await validateStartContract(root)).toEqual([]);
			const state = deriveTreeState(root, contract);
			expect(state.scanned).toBeGreaterThan(0);
			expect(state.mode).toBe("active");
			expect(state.signals.length).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 120000);

	test("the skeleton this template ships is non-vacuous in the same way", async () => {
		const root = await skeletonWorkspace();
		try {
			// A skeleton is where a vacuous pass hides best: every question about an
			// application is trivially true when there is no application. So the
			// derived state records what it read, and the same guard that returns
			// green here refuses a planted application immediately.
			const state = deriveTreeState(root);
			expect(state.scanned).toBeGreaterThan(0);
			expect(state.signals).toEqual([]);
			expect(await validateStartContract(root)).toEqual([]);
			await withFile(
				root,
				`apps/planted-start/src/${NEEDLES.routeTree}`,
				ROUTE_TREE_SOURCE,
				`start: ${REGISTRY_PATH} declares skeleton mode but apps/planted-start/src/${NEEDLES.routeTree} is a generated route tree, and its presence is what marks this project as carrying an application of this stack`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
