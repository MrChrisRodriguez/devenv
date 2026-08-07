import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type ApiContract,
	deriveTreeState,
	REGISTRY_PATH,
	readApiContract,
	type ServerParser,
	validateFormsContract,
	validateSoleDeclarations,
} from "../forms-contract";
import { renderFixture } from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");

// Everything validateFormsContract reads. The fixture is a plain directory and
// not a Git repository on purpose: the enumeration falls back to a pruned walk
// there, which is the path a rendered project's CI actually takes before its
// first commit.
const CONTRACT_FILES = [
	"api-contract.json",
	"api-contract.schema.json",
	"package.json",
	"template-parameters.toml",
	".github/workflows/ci.yml",
	"scripts/template/forms-contract.ts",
	"scripts/template/validate-forms.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

// Assembled exactly as the guard assembles them. A fixture that spelled either
// needle out would BE an instance of the shape it is testing for, and the file
// carrying the test would fail the guard it is testing.
const RESOLVER_BINDING = `${"zod"}Resolver(`;
const GENERATED_MARKER = ["DO", "NOT", "EDIT"].join(" ");

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-forms-contract-"));
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	return temporary;
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
				'import { z } from "zod";\nexport const Body = z.object({});\n',
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
						'"absent": ["playwright", "better_auth", "sentry", "vite_websocket_proxy"]',
						'"absent": ["playwright", "better_auth", "rhf_zod", "sentry", "vite_websocket_proxy"]',
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

	test("renders the contract surface only for the selected capability", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-forms-render-"));
		try {
			const minimal = resolve(temporary, "minimal");
			const full = resolve(temporary, "full");
			await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: minimal,
			});
			await renderFixture({ root: ROOT, fixtureName: "full", output: full });
			for (const path of [
				"api-contract.json",
				"api-contract.schema.json",
				"scripts/template/forms-contract.ts",
				"scripts/template/validate-forms.ts",
			]) {
				expect(await Bun.file(resolve(minimal, path)).exists()).toBe(false);
				expect(await Bun.file(resolve(full, path)).exists()).toBe(true);
			}
			const minimalPackage = await Bun.file(
				resolve(minimal, "package.json"),
			).json();
			expect(minimalPackage.scripts["forms:check"]).toBeUndefined();
			const fullPackage = await Bun.file(resolve(full, "package.json")).json();
			expect(fullPackage.scripts["forms:check"]).toBe(
				"bun scripts/template/validate-forms.ts",
			);
			const minimalWorkflow = await Bun.file(
				resolve(minimal, ".github/workflows/ci.yml"),
			).text();
			expect(minimalWorkflow).not.toContain("forms:check");
			const fullWorkflow = await Bun.file(
				resolve(full, ".github/workflows/ci.yml"),
			).text();
			expect(fullWorkflow).toContain("bun run forms:check");
			// A real verdict over a real render. The generated project carries no
			// fences and no ownership registry, so the legs that are questions about
			// the template stand down there instead of failing.
			expect(await validateFormsContract(full)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);
});
