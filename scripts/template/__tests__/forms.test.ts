import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type ApiContract,
	deriveTreeState,
	describeArtifact,
	GENERATE_BIN_VARIABLE,
	MERGE_BASE_VARIABLE,
	REGISTRY_PATH,
	readApiContract,
	type ServerParser,
	validateBrowserSafety,
	validateEvolution,
	validateFormsContract,
	validateSoleDeclarations,
} from "../forms-contract";
import { renderFixture } from "../render-fixture";
import {
	ARTIFACT_PATH,
	activeWorkspace,
	artifactDocument,
	CLIENT_PATH,
	clientTypes,
	contractWorkspace,
	GENERATE_COMMAND,
	GENERATED_MARKER,
	generatorScript,
	RESOLVER_BINDING,
	ROOT,
	SCHEMA_IMPORT,
	SKELETON,
	schemaPackage,
	writeFiles,
	writeRegistry,
} from "./fixtures/api-contract-workspaces";

async function contractFixture(): Promise<string> {
	return await contractWorkspace({ prefix: "devenv-forms-contract-" });
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
	expect(await validateFormsContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateFormsContract(root)).toEqual([]);
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
	expect(await validateFormsContract(root)).toContain(expected);
	await rm(target);
	expect(await validateFormsContract(root)).toEqual([]);
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
	expect(await validateFormsContract(root)).toEqual([]);
	await rm(target);
}

function declareActive(source: string): string {
	return source.replace('"mode": "skeleton"', '"mode": "active"');
}

describe("shared schema and API contract registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateFormsContract(ROOT)).toEqual([]);
		const { contract, errors } = await readApiContract(ROOT);
		expect(errors).toEqual([]);
		expect(contract?.mode).toBe("skeleton");
		expect(contract?.schemaVersion).toBe(1);
	});

	test("derives the tree state from the tree and never from the registry", () => {
		const state = deriveTreeState(ROOT);
		// Anti-vacuity in the one place it is easiest to lose: a scan that read
		// nothing would report `skeleton` for every tree there will ever be.
		expect(state.scanned).toBeGreaterThan(100);
		expect(state.errors).toEqual([]);
		expect(state.signals).toEqual([]);
		expect(state.mode).toBe("skeleton");
	});

	test("refuses a tree that grew a surface the registry still calls skeleton", async () => {
		const temporary = await contractFixture();
		try {
			expect(await validateFormsContract(temporary)).toEqual([]);
			// One case per derived shape. Each is the visible consequence of a
			// shared schema surface existing, and each has to be named on its own
			// so the failure says which file to look at.
			await withFile(
				temporary,
				"libs/forms/src/index.ts",
				"export const placeholder = 1;\n",
				`forms: ${REGISTRY_PATH} declares skeleton mode but libs/forms/src/index.ts lives under the reserved schema package root libs/forms`,
			);
			await withFile(
				temporary,
				"apps/api/src/schemas.ts",
				`${SCHEMA_IMPORT}export const Body = z.object({});\n`,
				`forms: ${REGISTRY_PATH} declares skeleton mode but apps/api/src/schemas.ts imports the shared schema library`,
			);
			// A bare side-effect import and a dynamic import are the two spellings a
			// leg that only knew `import … from` would wave through.
			await withFile(
				temporary,
				"apps/api/src/side-effect.ts",
				'import "zod/v4";\n',
				`forms: ${REGISTRY_PATH} declares skeleton mode but apps/api/src/side-effect.ts imports the shared schema library`,
			);
			await withFile(
				temporary,
				"apps/api/src/lazy.ts",
				'export const load = async () => await import("zod");\n',
				`forms: ${REGISTRY_PATH} declares skeleton mode but apps/api/src/lazy.ts imports the shared schema library`,
			);
			await withFile(
				temporary,
				"apps/web/src/form.tsx",
				`export const resolver = ${RESOLVER_BINDING}Schema);\n`,
				`forms: ${REGISTRY_PATH} declares skeleton mode but apps/web/src/form.tsx binds a form resolver`,
			);
			await withFile(
				temporary,
				"libs/client/src/generated.ts",
				`// GENERATED FILE — ${GENERATED_MARKER}.\nexport type Api = unknown;\n`,
				`forms: ${REGISTRY_PATH} declares skeleton mode but libs/client/src/generated.ts opens with a generated-artifact banner`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a registry that declares a surface the tree does not have", async () => {
		const temporary = await contractFixture();
		try {
			const target = resolve(temporary, REGISTRY_PATH);
			const original = await Bun.file(target).text();
			await Bun.write(target, declareActive(original));
			const errors = await validateFormsContract(temporary);
			expect(errors).toContain(
				`forms: ${REGISTRY_PATH} declares active mode but declares no schema package, contract artifact, form module or server parser`,
			);
			expect(errors).toContain(
				`forms: ${REGISTRY_PATH} declares active mode but no tracked file carries a shared schema surface`,
			);
			await Bun.write(target, original);
			expect(await validateFormsContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a second registry, a second validator, and a broken declaration", async () => {
		const temporary = await contractFixture();
		try {
			await withFile(
				temporary,
				"libs/api/api-contract.json",
				"{}\n",
				`forms: libs/api/api-contract.json is a second api contract registry; ${REGISTRY_PATH} is the only one`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"schemaVersion": 1', '"schemaVersion": 2'),
				`forms: ${REGISTRY_PATH} $.schemaVersion must equal 1`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace('"mode": "skeleton"', '"mode": "provisional"'),
				`forms: ${REGISTRY_PATH} $.mode must be one of ["skeleton","active"]`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace(',\n\t"evolution": []\n', "\n"),
				`forms: ${REGISTRY_PATH} $.evolution is required`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses two modules that claim the same declared surface", () => {
		// 13.1's "remove superseded validators atomically" has no deletion target
		// in this tree, so it ships as a refusal that holds going forward. The leg
		// is driven directly because the mode reconciliation above it stops a
		// registry that declares a surface the tree does not carry — which is a
		// different, earlier failure with a different fix.
		const parser = (path: string): ServerParser => ({
			path,
			surface: "POST /orders",
			envelope: "platform",
		});
		const contract: ApiContract = {
			schemaVersion: 1,
			mode: "active",
			schemaPackages: [],
			openapi: null,
			policySeam: null,
			formModules: [],
			serverParsers: [
				parser("apps/api/src/validate.ts"),
				parser("apps/api/src/legacy.ts"),
			],
			evolution: [],
		};
		expect(validateSoleDeclarations([], contract)).toEqual([
			"forms: apps/api/src/legacy.ts is a second validator for POST /orders; apps/api/src/validate.ts is the only one",
		]);
		expect(
			validateSoleDeclarations([], {
				...contract,
				serverParsers: [parser("apps/api/src/validate.ts")],
			}),
		).toEqual([]);
	});

	test("refuses a guard nothing runs", async () => {
		const temporary = await contractFixture();
		try {
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'\t\t"forms:check": "bun scripts/template/validate-forms.ts",\n',
						"",
					),
				"forms: package script forms:check must run scripts/template/validate-forms.ts",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) => source.replace("        run: bun run forms:check\n", ""),
				"forms: the ci job must run `bun run forms:check` in the required lane",
			);
			// The fence removed on one side only. The renderer deletes a fenced
			// block outright and has no inverse, so an unfenced step ships the guard
			// invocation into every project that disabled the capability.
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source
						.replace("      # capability:start rhf_zod\n", "")
						.replace("      # capability:end rhf_zod\n", ""),
				"forms: the `bun run forms:check` step must sit inside a rhf_zod capability fence",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source.replace(
						"      - name: Validate shared schema and API contract\n        run: bun run forms:check",
						"      - name: Validate shared schema and API contract\n        if: ${{ github.event_name == 'push' }}\n        run: bun run forms:check",
					),
				"forms: the `bun run forms:check` step must not be conditional",
			);
			const registry = resolve(temporary, "api-contract.json");
			const original = await Bun.file(registry).text();
			await rm(registry);
			expect(await validateFormsContract(temporary)).toEqual([
				"forms: api-contract.json is missing",
			]);
			await Bun.write(registry, original);
			expect(await validateFormsContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses ownership that would ship or strand the guard", async () => {
		const temporary = await contractFixture();
		const ownership =
			"docs/devcontainer-upgrade/stage-0/template-ownership.json";
		try {
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "libs/forms/**", "requiresAll": ["rhf_zod"] },\n\t\t',
						"",
					),
				"forms: libs/forms/** must be gated by the capability",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "api-contract.json", "requiresAll": ["rhf_zod"] },\n\t\t',
						"",
					),
				"forms: api-contract.json must be gated by the capability",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(',\n\t\t\t"scripts": ["forms:check"]\n', "\n"),
				"forms: the rhf_zod package rule must strip the forms:check script",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"tokens": ["react-hook-form", "@hookform/resolvers", "zod", "forms:check"]',
						'"tokens": ["react-hook-form", "@hookform/resolvers", "zod"]',
					),
				"forms: forms:check must be a declared capability signature token",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'\t\t\t\t"scripts/template/forms-contract.ts",\n\t\t\t\t"scripts/template/validate-forms.ts"\n',
						'\t\t\t\t"scripts/template/validate-forms.ts"\n',
					),
				"forms: scripts/template/forms-contract.ts must be a declared capability signature",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"absent": ["playwright", "better_auth"]',
						'"absent": ["playwright", "better_auth", "rhf_zod"]',
					),
				"forms: rhf_zod ships a guard surface and must leave the absent inventory",
			);
			// The `copy` entry has to precede the `scripts/template/**` omit
			// catch-all. Behind it the render drops the guard while package.json
			// still declares the script, which the fixture suite reports as a
			// different error entirely.
			await mutate(
				temporary,
				ownership,
				(source) => {
					const entry = `\t\t{
\t\t\t"pattern": "scripts/template/forms-contract.ts",
\t\t\t"classification": "template-owned",
\t\t\t"syncPolicy": "merge",
\t\t\t"renderPolicy": "copy",
\t\t\t"sourceOfTruth": "api-contract.json"
\t\t},\n`;
					return source.replace(entry, "");
				},
				"forms: template ownership must cover scripts/template/forms-contract.ts",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("keeps a declared schema package browser safe by allowlist", async () => {
		const contract: ApiContract = {
			...SKELETON,
			mode: "active",
			schemaPackages: [schemaPackage({ allowedSpecifiers: ["@scope/units"] })],
		};
		const good = {
			"libs/forms/src/index.ts": `${SCHEMA_IMPORT}export * from "./orders";\nexport * from "./util/money";\n`,
			"libs/forms/src/orders.ts": `${SCHEMA_IMPORT}import { Money } from "@scope/units";\nexport const Order = z.object({ total: Money });\n`,
			"libs/forms/src/util/money.ts":
				'export { Money } from "../vendor/money";\n',
			"libs/forms/src/vendor/money.ts": "export const Money = 1;\n",
		};
		const temporary = await contractWorkspace({ contract, files: good });
		try {
			expect(await validateFormsContract(temporary)).toEqual([]);

			// A relative specifier that leaves the package is the case a denylist
			// never catches: it looks local and is not.
			await writeFiles(temporary, {
				"libs/forms/src/util/money.ts":
					'export { Money } from "../../../apps/api/src/money";\n',
			});
			expect(await validateFormsContract(temporary)).toContain(
				"forms: libs/forms/src/util/money.ts imports ../../../apps/api/src/money, which resolves outside the schema package forms",
			);
			await writeFiles(temporary, good);
			expect(await validateFormsContract(temporary)).toEqual([]);

			// Three spellings a leg that only knew `import … from` would wave
			// through, each of which reaches a module the allowlist never named.
			for (const [path, body, specifier] of [
				[
					"libs/forms/src/db.ts",
					'import { open } from "node:fs";\nexport const use = open;\n',
					"node:fs",
				],
				[
					"libs/forms/src/lazy.ts",
					'export const load = async () => await import("better-auth");\n',
					"better-auth",
				],
				["libs/forms/src/side-effect.ts", 'import "wrangler";\n', "wrangler"],
			] as const) {
				await writeFiles(temporary, { [path]: body });
				expect(await validateFormsContract(temporary)).toContain(
					`forms: ${path} imports ${specifier}, which the schema package forms does not allow`,
				);
				await rm(resolve(temporary, path));
			}
			expect(await validateFormsContract(temporary)).toEqual([]);

			// A package with nothing in it is the classic hole: a scan with no
			// input returns [] and calls it a pass.
			await writeRegistry(temporary, {
				...contract,
				schemaPackages: [
					schemaPackage({
						id: "empty",
						root: "libs/empty",
						entry: "libs/empty/src/index.ts",
					}),
					...contract.schemaPackages,
				],
			});
			expect(await validateFormsContract(temporary)).toContain(
				"forms: the schema package empty at libs/empty contains no file to scan",
			);
			await writeRegistry(temporary, contract);

			// The declared entry has to be inside the package it is the entry of.
			await writeRegistry(temporary, {
				...contract,
				schemaPackages: [
					schemaPackage({
						entry: "apps/api/src/index.ts",
						allowedSpecifiers: ["@scope/units"],
					}),
				],
			});
			expect(await validateFormsContract(temporary)).toContain(
				"forms: the schema package forms declares the entry apps/api/src/index.ts, which is outside libs/forms",
			);
			await writeRegistry(temporary, contract);

			// Derive-the-surface: a module outside every declared package that
			// reaches for the schema library extends the ban with no guard edit.
			await writeFiles(temporary, {
				"apps/api/src/rogue.ts": `${SCHEMA_IMPORT}export const Rogue = z.string();\n`,
			});
			expect(await validateFormsContract(temporary)).toContain(
				"forms: apps/api/src/rogue.ts imports the shared schema library outside a declared schema package",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a browser-safety scan that read nothing", () => {
		// Anti-vacuity, driven directly. Reached through the whole contract this
		// state is impossible, which is the point: the leg has to fail on it
		// rather than return the empty list a passing run also returns.
		expect(
			validateBrowserSafety(ROOT, SKELETON, {
				mode: "skeleton",
				signals: [],
				scanned: 0,
				errors: [],
			}),
		).toEqual([
			"forms: the browser-safety scan read no file at all; a rule with no input has answered nothing",
		]);
		expect(
			validateBrowserSafety(ROOT, SKELETON, deriveTreeState(ROOT)),
		).toEqual([]);
	});

	test("refuses generated artifacts that drift, and restores the tree either way", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			expect(await validateFormsContract(root)).toEqual([]);
			const committed = await Bun.file(resolve(root, ARTIFACT_PATH)).text();

			// A hand-edited artifact is what the generator would overwrite, which
			// is exactly the state the gate exists to name.
			await writeFiles(root, {
				[ARTIFACT_PATH]: committed.replace('"3.1.0"', '"3.1.1"'),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${ARTIFACT_PATH} is a stale generated artifact; run \`${GENERATE_COMMAND}\` and commit the result`,
			);
			// The gate ran a generator that rewrote the tree, and the tree is back
			// exactly as it was. A drifted repository must not be left mutated by
			// the guard that noticed the drift.
			expect(await Bun.file(resolve(root, ARTIFACT_PATH)).text()).toBe(
				committed.replace('"3.1.0"', '"3.1.1"'),
			);
			await writeFiles(root, { [ARTIFACT_PATH]: committed });
			expect(await validateFormsContract(root)).toEqual([]);
			expect(await Bun.file(resolve(root, ARTIFACT_PATH)).text()).toBe(
				committed,
			);

			// An artifact the registry declares and the tree does not have. The
			// generator recreates it during the run, so "restore on every exit
			// path" has to mean deleting it again.
			await rm(resolve(root, ARTIFACT_PATH));
			expect(await validateFormsContract(root)).toContain(
				`forms: ${REGISTRY_PATH} declares ${ARTIFACT_PATH}, which is missing`,
			);
			expect(await Bun.file(resolve(root, ARTIFACT_PATH)).exists()).toBe(false);
			await writeFiles(root, { [ARTIFACT_PATH]: committed });

			// A generated client that no longer says it is generated is a file the
			// next generator run silently reverts.
			const client = await Bun.file(resolve(root, CLIENT_PATH)).text();
			await writeFiles(root, {
				[CLIENT_PATH]: client.split("\n").slice(1).join("\n"),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${CLIENT_PATH} must open with its declared generated-artifact banner`,
			);
			await writeFiles(root, { [CLIENT_PATH]: client });
			expect(await validateFormsContract(root)).toEqual([]);

			// A generator that is not there fails the gate rather than skipping it.
			process.env[GENERATE_BIN_VARIABLE] = resolve(root, "no-such-generator");
			const absent = await validateFormsContract(root);
			delete process.env[GENERATE_BIN_VARIABLE];
			expect(absent.join("\n")).toContain("forms: the declared generator");
			expect(await validateFormsContract(root)).toEqual([]);

			// Biome must not touch the generated output, or the byte-compare above
			// fails for a file that is perfectly correct.
			const biome = await Bun.file(resolve(root, "biome.jsonc")).text();
			await writeFiles(root, {
				"biome.jsonc": biome.replace(', "**/openapi/**"', ""),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: biome.jsonc must exempt the generated ${ARTIFACT_PATH} from reformatting`,
			);
			await writeFiles(root, { "biome.jsonc": biome });
			expect(await validateFormsContract(root)).toEqual([]);

			// Strict on the wire is the one asymmetry the reference is explicit
			// about: a browser that strict-parses a live response breaks on the
			// first purely additive deploy.
			await writeFiles(root, {
				[ARTIFACT_PATH]: artifactDocument({ strictResponse: true }),
				"scripts/generate.ts": generatorScript(
					artifactDocument({ strictResponse: true }),
					clientTypes(),
				),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${ARTIFACT_PATH} strict-parses the response body of POST /orders 201; the published contract must stay lenient on the wire`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
			delete process.env[GENERATE_BIN_VARIABLE];
		}
	}, 60_000);

	test("refuses contract evolution that is not additive", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "devenv-forms-evolution-"));
		const git = (...args: string[]): void => {
			const result = Bun.spawnSync(["git", "-C", root, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
			if (result.exitCode !== 0)
				throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
		};
		const contractFor = (evolution: ApiContract["evolution"]): ApiContract => ({
			...SKELETON,
			mode: "active",
			evolution,
			openapi: {
				artifact: ARTIFACT_PATH,
				generate: GENERATE_COMMAND,
				clients: [],
			},
		});
		const publish = async (document: string): Promise<void> => {
			await writeFiles(root, { [ARTIFACT_PATH]: document });
		};
		try {
			git("init", "--quiet", "--initial-branch", "main");
			await publish(artifactDocument());
			git("add", "-A");
			git("commit", "--quiet", "--no-verify", "-m", "base");
			const base =
				Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
					stdout: "pipe",
				})
					.stdout.toString()
					.trim() ?? "";
			process.env[MERGE_BASE_VARIABLE] = base;

			expect(validateEvolution(root, contractFor([])).errors).toEqual([]);

			// Four ways to break a client that is still running the old build,
			// during the window in which two versions are both serving.
			for (const [options, detail, operations] of [
				[
					{ dropField: true },
					"removes the field POST /orders#201.note",
					["POST /orders", "GET /orders/{id}"],
				],
				[
					{ dropOperation: true },
					"removes the operation GET /orders/{id}",
					["GET /orders/{id}"],
				],
				[
					{ requireField: true },
					"newly requires POST /orders#request.note",
					["POST /orders"],
				],
				[
					{ narrowField: true },
					"narrows POST /orders#request.total from number to string",
					["POST /orders"],
				],
			] as const) {
				await publish(artifactDocument(options));
				expect(
					validateEvolution(root, contractFor([])).errors.join("\n"),
				).toContain(detail);
				// ... each of which a staged migration authorizes by name.
				expect(
					validateEvolution(
						root,
						contractFor(
							operations.map((operation) => ({
								operation,
								stage: "migrate" as const,
								note: "staged add then remove",
							})),
						),
					).errors,
				).toEqual([]);
			}

			// A contract artifact new in this branch has no earlier contract to
			// compare against, and the gate says so instead of passing quietly.
			await publish(artifactDocument());
			const moved = "libs/api-client/openapi/api.v2.json";
			await writeFiles(root, { [moved]: artifactDocument() });
			const fresh = validateEvolution(root, {
				...contractFor([]),
				openapi: {
					artifact: moved,
					generate: GENERATE_COMMAND,
					clients: [],
				},
			});
			expect(fresh.errors).toEqual([]);
			expect(fresh.notices.join("\n")).toContain(
				`forms: ${moved} is new at ${base}`,
			);

			// No base at all is a notice too, never a silent pass.
			delete process.env[MERGE_BASE_VARIABLE];
			process.env[MERGE_BASE_VARIABLE] = "refs/heads/no-such-branch";
			const unresolved = validateEvolution(root, contractFor([]));
			expect(unresolved.errors).toEqual([]);
			expect(unresolved.notices.join("\n")).toContain(
				"the evolution gate compared nothing",
			);
		} finally {
			delete process.env[MERGE_BASE_VARIABLE];
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("bans a second set of response types, in all four spellings", async () => {
		const { root, contract } = await activeWorkspace();
		const CLIENT = "../../../libs/api-client/src/generated/api";
		try {
			// Legal by construction, and deliberately similar to every refusal
			// below: an uncovered route, an opaque annotation, a generic type
			// parameter, and the right contract type for the right operation.
			await tolerate(
				root,
				"apps/web/src/legal.ts",
				[
					`import type { CreateOrder } from "${CLIENT}";`,
					"declare function fetchJson(path: string): Promise<unknown>;",
					'const uncovered = (await fetchJson("/health")) as { ok: boolean };',
					'const opaque: unknown = await fetchJson("/orders");',
					'const right = (await fetchJson("/orders")) as CreateOrder;',
					"export async function load<T>(): Promise<T> {",
					'\treturn (await fetchJson("/orders")) as T;',
					"}",
					"export const surface = [uncovered, opaque, right];",
					"",
				].join("\n"),
			);

			for (const [category, body, text] of [
				[
					"INLINE_RESPONSE_SHAPE",
					'const row = (await fetchJson("/orders")) as { id: string };\nexport const use = row;\n',
					"{ id: string }",
				],
				[
					"APP_LOCAL_RESPONSE_TYPE",
					'interface OrderRow { id: string }\nconst row: OrderRow = await fetchJson("/orders");\nexport const use = row;\n',
					"OrderRow",
				],
				[
					"NON_CONTRACT_RESPONSE_TYPE",
					'import type { OrderRow } from "../types";\nconst row: OrderRow = await fetchJson("/orders");\nexport const use = row;\n',
					"OrderRow",
				],
				[
					"WRONG_CONTRACT_RESPONSE_TYPE",
					`import type { ReadOrder } from "${CLIENT}";\nconst row: ReadOrder = await fetchJson("/orders");\nexport const use = row;\n`,
					"ReadOrder",
				],
			] as const) {
				await writeFiles(root, {
					"apps/web/src/bad.ts": `declare function fetchJson(path: string): Promise<unknown>;\n${body}`,
				});
				expect(await validateFormsContract(root)).toContain(
					`forms: ${category} apps/web/src/bad.ts states the response of POST /orders as ${text}; the generated contract types are the only ones`,
				);
			}
			await rm(resolve(root, "apps/web/src/bad.ts"));
			expect(await validateFormsContract(root)).toEqual([]);

			// The route reaches the call site through a module-level constant, an
			// object property and a template literal, because that is how a real
			// call site spells it.
			for (const spelling of [
				'const ORDERS = "/orders";\nconst row = (await fetchJson(ORDERS)) as { id: string };\nexport const use = row;\n',
				'const ROUTES = { orders: "/orders" };\nconst row = (await fetchJson(ROUTES.orders)) as { id: string };\nexport const use = row;\n',
				'const row = (await fetchJson(`/orders/${"1"}`)) as { id: string };\nexport const use = row;\n',
			]) {
				await writeFiles(root, {
					"apps/web/src/hop.ts": `declare function fetchJson(path: string): Promise<unknown>;\n${spelling}`,
				});
				expect((await validateFormsContract(root)).join("\n")).toContain(
					"apps/web/src/hop.ts states the response of",
				);
			}
			await rm(resolve(root, "apps/web/src/hop.ts"));

			// Derive-the-surface: the ban follows the artifact. Removing the covered
			// operation removes the refusal with no guard edit, and adding one back
			// restores it.
			await writeFiles(root, {
				"apps/web/src/bad.ts":
					'declare function fetchJson(path: string): Promise<unknown>;\nconst row = (await fetchJson("/audits")) as { id: string };\nexport const use = row;\n',
			});
			expect(await validateFormsContract(root)).toEqual([]);
			const widened = JSON.parse(
				await Bun.file(resolve(root, ARTIFACT_PATH)).text(),
			) as { paths: Record<string, unknown> };
			widened.paths["/audits"] = {
				get: { operationId: "readAudit", responses: {} },
			};
			const document = `${JSON.stringify(widened, null, "\t")}\n`;
			await writeFiles(root, {
				[ARTIFACT_PATH]: document,
				"scripts/generate.ts": generatorScript(document, clientTypes()),
			});
			expect((await validateFormsContract(root)).join("\n")).toContain(
				"apps/web/src/bad.ts states the response of GET /audits",
			);

			// An artifact with no operation at all covers nothing, and a rule that
			// covers nothing has to say so rather than return an empty list.
			const empty = `${JSON.stringify({ openapi: "3.1.0", info: { title: "api", version: "1" }, paths: {} }, null, "\t")}\n`;
			await writeFiles(root, {
				[ARTIFACT_PATH]: empty,
				"scripts/generate.ts": generatorScript(empty, clientTypes()),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${ARTIFACT_PATH} declares no operation; the parallel-type ban would cover nothing`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		expect(contract.openapi?.artifact).toBe(ARTIFACT_PATH);
	}, 60_000);

	test("bans inline authorization outside the declared policy seam", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			const seamed: ApiContract = {
				...contract,
				policySeam: {
					root: "libs/authz",
					denialModule: "libs/authz/src/model.ts",
					exemptMessages: ["Forbidden"],
				},
			};
			await writeFiles(root, {
				"libs/authz/src/model.ts": [
					'export type DenialReason = "not_member" | "not_self";',
					"export const denialEnvelope = (reason: DenialReason) =>",
					'\treason === "not_member"',
					'\t\t? { message: "You are not a member of this organization" }',
					'\t\t: { message: "Forbidden" };',
					"",
				].join("\n"),
				// Legal: a branch on a seam DECISION, and a role branch that answers
				// something other than a refusal.
				"apps/api/src/legal.ts": [
					"declare function decide(caller: unknown): boolean;",
					"declare function json(body: unknown, status: number): unknown;",
					"export function handler(caller: { role: string }) {",
					"\tif (decide(caller)) return json({}, 403);",
					'\tif (caller.role === "guest") return json({}, 404);',
					"\treturn json({}, 200);",
					"}",
					"",
				].join("\n"),
			});
			await writeRegistry(root, seamed);
			expect(await validateFormsContract(root)).toEqual([]);

			await writeFiles(root, {
				"apps/api/src/bad.ts": [
					"declare function json(body: unknown, status: number): unknown;",
					"export function handler(caller: { role: string }) {",
					'\tif (caller.role !== "admin") return json({}, 403);',
					"\treturn json({}, 200);",
					"}",
					"",
				].join("\n"),
			});
			expect(await validateFormsContract(root)).toContain(
				"forms: apps/api/src/bad.ts answers a caller-role branch with a refusal; libs/authz is the only place that decides",
			);

			// The banned message set is READ from the seam, so a new reason extends
			// the ban with no guard edit — and the generic one the seam exempts
			// stays legal, because it collides with an unrelated refusal.
			await writeFiles(root, {
				"apps/api/src/bad.ts": [
					"declare function json(body: unknown, status: number): unknown;",
					"export const refuse = () =>",
					'\tjson({ message: "You are not a member of this organization" }, 403);',
					'export const generic = () => json({ message: "Forbidden" }, 403);',
					"",
				].join("\n"),
			});
			const errors = await validateFormsContract(root);
			expect(errors).toContain(
				'forms: apps/api/src/bad.ts redeclares the seam denial message "You are not a member of this organization"; libs/authz/src/model.ts is where it is written',
			);
			expect(errors.join("\n")).not.toContain('"Forbidden"');
			await rm(resolve(root, "apps/api/src/bad.ts"));
			expect(await validateFormsContract(root)).toEqual([]);

			// A seam whose denial module declares nothing would derive an empty ban.
			await writeFiles(root, {
				"libs/authz/src/model.ts":
					"export const denialEnvelope = () => null;\n",
			});
			expect(await validateFormsContract(root)).toContain(
				"forms: libs/authz/src/model.ts declares no denial message; the inline-authorization ban would derive an empty set",
			);

			// With no seam declared, nothing at all may decide.
			await writeRegistry(root, contract);
			await writeFiles(root, {
				"apps/api/src/bad.ts": [
					"declare function json(body: unknown, status: number): unknown;",
					"export function handler(caller: { isAdmin: boolean }) {",
					"\treturn caller.isAdmin ? json({}, 200) : json({}, 403);",
					"}",
					"",
				].join("\n"),
			});
			expect((await validateFormsContract(root)).join("\n")).toContain(
				"no file may decide authorization while the registry declares no policy seam",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("registers every form and refuses a field no schema declares", async () => {
		const { root, contract } = await activeWorkspace();
		try {
			const formPath = "apps/web/src/order-form.tsx";
			await writeFiles(root, {
				"libs/forms/src/index.ts": [
					SCHEMA_IMPORT.trimEnd(),
					"export const OrderForm = z.object({",
					"\ttotal: z.number(),",
					"\tnote: z.string(),",
					"});",
					"",
				].join("\n"),
				[formPath]: [
					"declare function useForm(options: unknown): {",
					"\tregister: (name: string) => void;",
					"\tsetError: (name: string, error: unknown) => void;",
					"};",
					"declare const Schema: unknown;",
					`const form = useForm({ resolver: ${RESOLVER_BINDING}Schema) });`,
					'form.register("total");',
					'form.setError("root.server", { message: "rejected" });',
					"export const bound = form;",
					"",
				].join("\n"),
			});
			// The loud half: a form nothing registered is a form nothing checks,
			// and the exemption set is empty on purpose.
			expect(await validateFormsContract(root)).toContain(
				`forms: ${formPath} binds a form resolver and is not declared in ${REGISTRY_PATH}`,
			);

			const registered: ApiContract = {
				...contract,
				formModules: [{ path: formPath, schemas: ["OrderForm"] }],
			};
			await writeRegistry(root, registered);
			expect(await validateFormsContract(root)).toEqual([]);

			// The typo a runtime never reports: the field simply never validates.
			await writeFiles(root, {
				[formPath]: (await Bun.file(resolve(root, formPath)).text()).replace(
					'form.register("total")',
					'form.register("noet")',
				),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${formPath} binds the field noet, which OrderForm does not declare`,
			);

			await writeRegistry(root, {
				...registered,
				formModules: [{ path: formPath, schemas: ["MissingForm"] }],
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${formPath} binds MissingForm, which no declared schema package exports`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("requires a server parser to be shared, distinct, and visible", async () => {
		const { root, contract } = await activeWorkspace();
		const parserPath = "apps/api/src/validate.ts";
		const mappingPath = "apps/web/src/apply-server-error.ts";
		try {
			await writeFiles(root, {
				"libs/forms/src/index.ts": [
					SCHEMA_IMPORT.trimEnd(),
					"export const OrderForm = z.object({ total: z.number() });",
					"",
				].join("\n"),
				[parserPath]: [
					'import { OrderForm } from "../../../libs/forms/src/index";',
					"export function validateBody(body: unknown, requestId: string) {",
					'\tif (body === undefined) return { error: { code: "BAD_REQUEST", message: "Invalid JSON body" }, requestId };',
					"\tconst parsed = OrderForm.safeParse(body);",
					"\tif (parsed.success) return { data: parsed.data, requestId };",
					'\treturn { error: { code: "VALIDATION_ERROR", message: "Validation failed" }, requestId };',
					"}",
					"",
				].join("\n"),
				[mappingPath]: [
					"export function applyServerError(",
					"\tissues: Array<{ path: string; message: string }>,",
					"\tsetError: (name: string, error: { message: string }) => void,",
					"\tfields: string[],",
					") {",
					"\tfor (const issue of issues) {",
					"\t\tif (fields.includes(issue.path)) setError(issue.path, issue);",
					'\t\telse setError("root.server", issue);',
					"\t}",
					"}",
					"",
				].join("\n"),
			});
			const declared: ApiContract = {
				...contract,
				serverParsers: [
					{
						path: parserPath,
						surface: "POST /orders",
						envelope: "VALIDATION_ERROR",
						clientMapping: mappingPath,
					},
				],
			};
			await writeRegistry(root, declared);
			expect(await validateFormsContract(root)).toEqual([]);

			// A rejection nothing renders is the silent failure the spec forbids.
			await writeRegistry(root, {
				...declared,
				serverParsers: [
					{
						path: parserPath,
						surface: "POST /orders",
						envelope: "VALIDATION_ERROR",
					},
				],
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${parserPath} declares no clientMapping; a server rejection nothing renders is a silent failure`,
			);
			await writeRegistry(root, declared);

			const original = await Bun.file(resolve(root, parserPath)).text();
			for (const [transform, expected] of [
				[
					(source: string) =>
						source.replace(
							'import { OrderForm } from "../../../libs/forms/src/index";',
							"const OrderForm = { safeParse: (value: unknown) => ({ success: true, data: value }) };",
						),
					`forms: ${parserPath} declares no import of a shared schema package; a re-declared shape is a second contract`,
				],
				[
					(source: string) =>
						source.replace(
							"const parsed = OrderForm.safeParse(body);",
							"const parsed = z.object({ total: z.number() }).safeParse(body);",
						),
					`forms: ${parserPath} re-declares an object schema; POST /orders is parsed with the shared one`,
				],
				[
					(source: string) => source.replaceAll("VALIDATION_ERROR", "OOPS"),
					`forms: ${parserPath} must answer a rejection of POST /orders with the declared VALIDATION_ERROR envelope`,
				],
				[
					(source: string) =>
						source.replace("Invalid JSON body", "Validation failed"),
					`forms: ${parserPath} must answer a malformed body distinctly from a schema rejection`,
				],
			] as const) {
				await writeFiles(root, { [parserPath]: transform(original) });
				expect(await validateFormsContract(root)).toContain(expected);
				await writeFiles(root, { [parserPath]: original });
			}
			expect(await validateFormsContract(root)).toEqual([]);

			const mapping = await Bun.file(resolve(root, mappingPath)).text();
			await writeFiles(root, {
				[mappingPath]: mapping.replaceAll("setError", "record"),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${mappingPath} must set a field error for every mappable issue path`,
			);
			await writeFiles(root, {
				[mappingPath]: mapping.replace('"root.server"', "issue.path"),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${mappingPath} must set a root-level error for an issue that maps to no field`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("parses the same schema in the browser and on the server", async () => {
		// One schema, two consumers. The browser half may reach nothing but the
		// schema library; the server half must reach the schema itself rather than
		// re-state its shape. A tree that got either wrong would still compile.
		const { root, contract } = await activeWorkspace();
		const parserPath = "apps/api/src/validate.ts";
		const mappingPath = "apps/web/src/apply-server-error.ts";
		try {
			await writeFiles(root, {
				"libs/forms/src/index.ts": [
					SCHEMA_IMPORT.trimEnd(),
					"export const OrderForm = z.object({ total: z.number() });",
					"",
				].join("\n"),
				"apps/web/src/browser.ts": [
					'import { OrderForm } from "../../../libs/forms/src/index";',
					"export const check = (value: unknown) => OrderForm.safeParse(value);",
					"",
				].join("\n"),
				[parserPath]: [
					'import { OrderForm } from "../../../libs/forms/src/index";',
					"export function validateBody(body: unknown, requestId: string) {",
					'\tif (body === undefined) return { error: { code: "BAD_REQUEST", message: "Invalid JSON body" }, requestId };',
					"\tconst parsed = OrderForm.safeParse(body);",
					"\tif (parsed.success) return { data: parsed.data, requestId };",
					'\treturn { error: { code: "VALIDATION_ERROR", message: "Validation failed", details: { issues: parsed.error.issues } }, requestId };',
					"}",
					"",
				].join("\n"),
				[mappingPath]: [
					"export function applyServerError(",
					"\tissues: Array<{ path: string; message: string }>,",
					"\tsetError: (name: string, error: { message: string }) => void,",
					"\tfields: string[],",
					") {",
					"\tfor (const issue of issues)",
					'\t\tsetError(fields.includes(issue.path) ? issue.path : "root.server", issue);',
					"}",
					"",
				].join("\n"),
			});
			await writeRegistry(root, {
				...contract,
				serverParsers: [
					{
						path: parserPath,
						surface: "POST /orders",
						envelope: "VALIDATION_ERROR",
						clientMapping: mappingPath,
					},
				],
			});
			expect(await validateFormsContract(root)).toEqual([]);

			// The browser half reaching a server-only module is the one case a
			// denylist over "known server packages" never sees coming.
			await tolerate(
				root,
				"libs/forms/src/util.ts",
				'export { OrderForm as Alias } from "./index";\n',
			);
			await writeFiles(root, {
				"libs/forms/src/util.ts":
					'export { readFileSync } from "node:fs";\nexport const use = readFileSync;\n',
			});
			expect(await validateFormsContract(root)).toContain(
				"forms: libs/forms/src/util.ts imports node:fs, which the schema package forms does not allow",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("lets an old client keep reading a newer contract", async () => {
		// The deployment-skew fixture. There is no wire-level skew protocol here
		// and the reference has none either; what holds a deploy window together
		// is that evolution stays additive and nothing strict-parses a live
		// response. So the proof is two versions: the artifact the old client was
		// generated from, and the one the server is now publishing.
		const root = await mkdtemp(resolve(tmpdir(), "devenv-forms-skew-"));
		const git = (...args: string[]): void => {
			const result = Bun.spawnSync(["git", "-C", root, ...args], {
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
			if (result.exitCode !== 0)
				throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
		};
		try {
			git("init", "--quiet", "--initial-branch", "main");
			const old = artifactDocument();
			await writeFiles(root, { [ARTIFACT_PATH]: old });
			git("add", "-A");
			git("commit", "--quiet", "--no-verify", "-m", "v1");
			process.env[MERGE_BASE_VARIABLE] = Bun.spawnSync(
				["git", "-C", root, "rev-parse", "HEAD"],
				{ stdout: "pipe" },
			)
				.stdout.toString()
				.trim();
			const contract: ApiContract = {
				...SKELETON,
				mode: "active",
				openapi: {
					artifact: ARTIFACT_PATH,
					generate: GENERATE_COMMAND,
					clients: [],
				},
			};

			// The new server publishes a purely additive contract: one more optional
			// field and one more operation.
			const next = JSON.parse(old) as {
				paths: Record<string, Record<string, unknown>>;
			};
			const post = next.paths["/orders"]?.["post"] as {
				responses: Record<
					string,
					{
						content: Record<
							string,
							{ schema: { properties: Record<string, unknown> } }
						>;
					}
				>;
			};
			const created =
				post.responses["201"]?.content["application/json"]?.schema;
			if (created) created.properties["createdAt"] = { type: "string" };
			next.paths["/audits"] = {
				get: { operationId: "readAudit", responses: {} },
			};
			const published = `${JSON.stringify(next, null, "\t")}\n`;
			await writeFiles(root, { [ARTIFACT_PATH]: published });
			expect(validateEvolution(root, contract).errors).toEqual([]);

			// The old client reads exactly the fields it was generated with, and
			// every one of them is still there. That is the whole skew guarantee,
			// stated as a fact about the two documents rather than as a header.
			const before = describeArtifact(old);
			const after = describeArtifact(published);
			expect(before).toBeDefined();
			expect(after).toBeDefined();
			for (const [key, type] of before?.properties ?? [])
				expect(after?.properties.get(key)).toBe(type);
			// ... and the published document must not ask the old client to be
			// strict about the field it has never heard of.
			expect(after?.strictResponses).toEqual([]);

			// The same additive document with ONE field removed breaks that client,
			// and the gate says so.
			await writeFiles(root, {
				[ARTIFACT_PATH]: artifactDocument({ dropField: true }),
			});
			expect(validateEvolution(root, contract).errors.join("\n")).toContain(
				"removes the field POST /orders#201.note",
			);
		} finally {
			delete process.env[MERGE_BASE_VARIABLE];
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("fails distinctly wherever a leg could have nothing to look at", async () => {
		// The classic hole, gathered in one place: five legs that could each be
		// reached with no input and return the empty list a passing run returns.
		// Every one of them has to say something instead.
		expect(
			validateBrowserSafety(ROOT, SKELETON, {
				mode: "skeleton",
				signals: [],
				scanned: 0,
				errors: [],
			}),
		).toEqual([
			"forms: the browser-safety scan read no file at all; a rule with no input has answered nothing",
		]);

		const { root, contract } = await activeWorkspace();
		try {
			// A declared package with no files.
			await writeRegistry(root, {
				...contract,
				schemaPackages: [
					...contract.schemaPackages,
					schemaPackage({
						id: "empty",
						root: "libs/empty",
						entry: "libs/empty/src/index.ts",
					}),
				],
			});
			expect(await validateFormsContract(root)).toContain(
				"forms: the schema package empty at libs/empty contains no file to scan",
			);
			await writeRegistry(root, contract);

			// An artifact that covers no operation.
			const empty = `${JSON.stringify({ openapi: "3.1.0", info: { title: "api", version: "1" }, paths: {} }, null, "\t")}\n`;
			const document = await Bun.file(resolve(root, ARTIFACT_PATH)).text();
			await writeFiles(root, {
				[ARTIFACT_PATH]: empty,
				"scripts/generate.ts": generatorScript(empty, clientTypes()),
			});
			expect(await validateFormsContract(root)).toContain(
				`forms: ${ARTIFACT_PATH} declares no operation; the parallel-type ban would cover nothing`,
			);
			await writeFiles(root, {
				[ARTIFACT_PATH]: document,
				"scripts/generate.ts": generatorScript(document, clientTypes()),
			});

			// A seam whose denial module names nothing.
			await writeFiles(root, {
				"libs/authz/src/model.ts":
					"export const denialEnvelope = () => null;\n",
			});
			await writeRegistry(root, {
				...contract,
				policySeam: {
					root: "libs/authz",
					denialModule: "libs/authz/src/model.ts",
				},
			});
			expect(await validateFormsContract(root)).toContain(
				"forms: libs/authz/src/model.ts declares no denial message; the inline-authorization ban would derive an empty set",
			);
			await writeRegistry(root, contract);

			// A registry that says `active` and declares nothing.
			await writeRegistry(root, { ...SKELETON, mode: "active" });
			expect(await validateFormsContract(root)).toContain(
				`forms: ${REGISTRY_PATH} declares active mode but declares no schema package, contract artifact, form module or server parser`,
			);

			// ... and a registry that says `skeleton` while declaring one.
			await writeRegistry(root, { ...contract, mode: "skeleton" });
			expect(await validateFormsContract(root)).toContain(
				`forms: ${REGISTRY_PATH} declares skeleton mode but declares a contract surface`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);

	test("renders the contract surface only for the selected capability", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-forms-render-"));
		try {
			const outputs: Record<string, string> = {};
			for (const fixtureName of ["minimal", "cloud", "full"]) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				outputs[fixtureName] = output;
			}
			for (const fixtureName of ["minimal", "cloud"]) {
				const output = outputs[fixtureName] ?? "";
				for (const path of [
					"api-contract.json",
					"api-contract.schema.json",
					"scripts/template/forms-contract.ts",
					"scripts/template/validate-forms.ts",
				])
					expect(await Bun.file(resolve(output, path)).exists()).toBe(false);
				const manifest = await Bun.file(resolve(output, "package.json")).json();
				expect(manifest.scripts["forms:check"]).toBeUndefined();
				const workflow = await Bun.file(
					resolve(output, ".github/workflows/ci.yml"),
				).text();
				expect(workflow).not.toContain("forms:check");
			}

			const full = outputs["full"] ?? "";
			for (const path of [
				"api-contract.json",
				"api-contract.schema.json",
				"scripts/template/forms-contract.ts",
				"scripts/template/validate-forms.ts",
				"scripts/template/json-schema.ts",
			])
				expect(await Bun.file(resolve(full, path)).exists()).toBe(true);
			const fullPackage = await Bun.file(resolve(full, "package.json")).json();
			expect(fullPackage.scripts["forms:check"]).toBe(
				"bun scripts/template/validate-forms.ts",
			);
			expect(
				await Bun.file(resolve(full, ".github/workflows/ci.yml")).text(),
			).toContain("bun run forms:check");

			// A real verdict from a real run inside the render, through the package
			// script a generated project's CI actually invokes. The dependency tree
			// is borrowed rather than installed — the compiler API has to resolve
			// from somewhere, and `node_modules` is pruned from every walk this
			// guard makes, so it cannot become an input to the answer.
			await symlink(
				resolve(ROOT, "node_modules"),
				resolve(full, "node_modules"),
				"dir",
			);
			const run = Bun.spawnSync(["bun", "run", "forms:check"], {
				cwd: full,
				stdout: "pipe",
				stderr: "pipe",
			});
			// Bun's script runner echoes the command it is about to run; nothing
			// else may reach stderr on a passing run.
			expect(run.stderr.toString().trim()).toBe(
				"$ bun scripts/template/validate-forms.ts",
			);
			expect(run.stdout.toString()).toContain(
				"Validated the api contract registry",
			);
			expect(run.exitCode).toBe(0);

			// ... and it is a verdict rather than a greeting: a project that grows
			// a schema surface without declaring it is refused inside the render
			// too.
			await mkdir(resolve(full, "libs/forms/src"), { recursive: true });
			await Bun.write(
				resolve(full, "libs/forms/src/index.ts"),
				"export const placeholder = 1;\n",
			);
			const refused = Bun.spawnSync(["bun", "run", "forms:check"], {
				cwd: full,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(refused.exitCode).toBe(1);
			expect(refused.stderr.toString()).toContain(
				"declares skeleton mode but libs/forms/src/index.ts lives under the reserved schema package root",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);
});
