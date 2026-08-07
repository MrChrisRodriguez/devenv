import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	deriveTreeState,
	type ExternalWrites,
	REGISTRY_PATH,
	readExternalWrites,
	validateSoleDeclarations,
	validateTelemetryContract,
} from "../telemetry-contract";
import {
	INSTRUCTION_SCRIPT,
	ROOT,
	SDK_IMPORT,
	SDK_INITIALIZER,
	SKELETON,
	telemetryWorkspace,
	WRITE_SCRIPT,
	writeRegistry,
} from "./fixtures/external-write-workspaces";

async function telemetryFixture(): Promise<string> {
	return await telemetryWorkspace({ prefix: "devenv-telemetry-contract-" });
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
	expect(await validateTelemetryContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateTelemetryContract(root)).toEqual([]);
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
		expect(await validateTelemetryContract(root)).toContain(expected);
	} finally {
		// Removed in a `finally` on purpose. A planted shape left behind by a
		// failing assertion would make every later case in this file fail for a
		// reason none of them is about.
		await rm(target);
	}
	expect(await validateTelemetryContract(root)).toEqual([]);
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
		expect(await validateTelemetryContract(root)).toEqual([]);
	} finally {
		await rm(target);
	}
}

describe("external write registry", () => {
	test("accepts the source tree and its own committed declaration", async () => {
		expect(await validateTelemetryContract(ROOT)).toEqual([]);
		const { contract, errors } = await readExternalWrites(ROOT);
		expect(errors).toEqual([]);
		expect(contract?.mode).toBe("skeleton");
		expect(contract?.schemaVersion).toBe(1);
		expect(contract?.telemetry).toBeNull();
		expect(contract?.writes).toEqual([]);
		// The entry that stops the write-shape scan from being a scan with nothing
		// to find. This repository DOES perform a remote write.
		expect(contract?.governedElsewhere).toEqual([
			{
				path: "scripts/openspec/archive.sh",
				authority: "scripts/template/openspec-contract.ts",
			},
		]);
	});

	test("derives the tree state from the tree and never from the registry", async () => {
		const { contract } = await readExternalWrites(ROOT);
		const state = deriveTreeState(ROOT, contract);
		// Anti-vacuity in the one place it is easiest to lose: a scan that read
		// nothing would report `skeleton` for every tree there will ever be.
		expect(state.scanned).toBeGreaterThan(100);
		expect(state.errors).toEqual([]);
		expect(state.signals).toEqual([]);
		expect(state.mode).toBe("skeleton");
	});

	test("the write-shape scan finds the write this repository really performs", async () => {
		// The delegation is only meaningful if the delegated file would otherwise
		// be caught. Dropping the exemption has to flip the derived mode.
		const withoutExemption = deriveTreeState(ROOT, {
			...SKELETON,
			governedElsewhere: [],
		});
		expect(withoutExemption.mode).toBe("active");
		expect(withoutExemption.signals.map((signal) => signal.path)).toContain(
			"scripts/openspec/archive.sh",
		);
	});

	test("refuses a tree that grew a surface the registry still calls skeleton", async () => {
		const temporary = await telemetryFixture();
		try {
			expect(await validateTelemetryContract(temporary)).toEqual([]);
			// One case per derived shape. Each is the visible consequence of a
			// telemetry surface or a remote write existing, and each is named on its
			// own so the failure says which file to look at.
			await withFile(
				temporary,
				"libs/observability/src/index.ts",
				"export const placeholder = 1;\n",
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but libs/observability/src/index.ts lives under the reserved telemetry configuration root libs/observability`,
			);
			await withFile(
				temporary,
				"apps/web/src/telemetry.ts",
				SDK_IMPORT,
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but apps/web/src/telemetry.ts imports the telemetry SDK`,
			);
			await withFile(
				temporary,
				"apps/web/src/boot.ts",
				SDK_INITIALIZER,
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but apps/web/src/boot.ts calls the telemetry SDK initializer`,
			);
			await withFile(
				temporary,
				"scripts/deploy.sh",
				WRITE_SCRIPT,
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but scripts/deploy.sh performs the remote write git-push that ${REGISTRY_PATH} does not declare`,
			);
			// ... and the near-miss. A script that prints the command a human should
			// run is not a script that runs it.
			await tolerate(temporary, "scripts/instructions.sh", INSTRUCTION_SCRIPT);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a registry that declares a surface the tree does not have", async () => {
		const temporary = await telemetryFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"skeleton"', '"active"'),
				`telemetry: ${REGISTRY_PATH} declares active mode but declares no telemetry configuration and no external write`,
			);
			// The other direction: a declaration in a registry that still says the
			// world is empty.
			const declared: ExternalWrites = {
				...SKELETON,
				writes: [
					{
						id: "deploy",
						path: "scripts/deploy.sh",
						kind: "git",
						intent: "--confirm-push",
						credentials: ["DEPLOY_TOKEN_NAME"],
						verify: "bash scripts/verify.sh",
						allowedHosts: ["https://example.invalid"],
					},
				],
			};
			const original = await Bun.file(resolve(temporary, REGISTRY_PATH)).text();
			await writeRegistry(temporary, declared);
			expect(await validateTelemetryContract(temporary)).toContain(
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but declares a telemetry or write surface`,
			);
			await Bun.write(resolve(temporary, REGISTRY_PATH), original);
			expect(await validateTelemetryContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a second registry anywhere in the tree", async () => {
		expect(
			validateSoleDeclarations(
				["external-writes.json", "packages/api/external-writes.json"],
				undefined,
			),
		).toContain(
			`telemetry: packages/api/external-writes.json is a second external write registry; ${REGISTRY_PATH} is the only one`,
		);
		// One file, one authority. A path that is both declared and delegated
		// leaves two answers to the question the registry exists to answer.
		expect(
			validateSoleDeclarations([REGISTRY_PATH], {
				...SKELETON,
				writes: [
					{
						id: "archive",
						path: "scripts/openspec/archive.sh",
						kind: "git",
						intent: "--change",
						credentials: ["GIT_TOKEN_NAME"],
						verify: "git ls-remote",
						allowedHosts: ["https://example.invalid"],
					},
				],
			}),
		).toContain(
			"telemetry: scripts/openspec/archive.sh is both a declared write and governed elsewhere; one file has one authority",
		);
	});

	test("requires the guard to be wired into the manifest and the required lane", async () => {
		const temporary = await telemetryFixture();
		try {
			await mutate(
				temporary,
				"package.json",
				(source) =>
					source.replace(
						'"telemetry:check": "bun scripts/template/validate-telemetry.ts",',
						'"telemetry:check": "true",',
					),
				"telemetry: package script telemetry:check must run scripts/template/validate-telemetry.ts",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source.replace("        run: bun run telemetry:check\n", ""),
				"telemetry: the ci job must run `bun run telemetry:check` in the required lane",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source
						.replace("      # capability:start sentry\n", "")
						.replace("      # capability:end sentry\n", ""),
				"telemetry: the `bun run telemetry:check` step must sit inside a sentry capability fence",
			);
			await mutate(
				temporary,
				".github/workflows/ci.yml",
				(source) =>
					source.replace(
						"        run: bun run telemetry:check\n",
						"        run: bun run telemetry:check\n        if: ${{ always() }}\n",
					),
				"telemetry: the `bun run telemetry:check` step must not be conditional",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("requires template ownership to gate, strip and sign every added file", async () => {
		const temporary = await telemetryFixture();
		const ownership =
			"docs/devcontainer-upgrade/stage-0/template-ownership.json";
		try {
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "external-writes.json", "requiresAll": ["sentry"] },\n\t\t',
						"",
					),
				"telemetry: external-writes.json must be gated by the capability",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'{ "pattern": "libs/observability/**", "requiresAll": ["sentry"] },\n\t\t',
						"",
					),
				"telemetry: libs/observability/** must be gated by the capability",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace('"scripts": ["telemetry:check"]', '"scripts": []'),
				"telemetry: the sentry package rule must strip the telemetry:check script",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"tokens": ["@sentry/", "telemetry:check"]',
						'"tokens": []',
					),
				"telemetry: telemetry:check must be a declared capability signature token",
			);
			await mutate(
				temporary,
				ownership,
				(source) =>
					source.replace(
						'"absent": ["playwright", "better_auth", "vite_websocket_proxy"]',
						'"absent": ["playwright", "better_auth", "sentry", "vite_websocket_proxy"]',
					),
				"telemetry: sentry ships a guard surface and must leave the absent inventory",
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
						'\t\t\t"pattern": "scripts/template/telemetry-contract.ts",\n\t\t\t"classification": "template-owned",',
						'\t\t\t"pattern": "scripts/template/telemetry-contract.ts.moved",\n\t\t\t"classification": "template-owned",',
					),
				"telemetry: template ownership must cover scripts/template/telemetry-contract.ts",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("reconciles every delegated write authority in both directions", async () => {
		const temporary = await telemetryFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						"scripts/template/openspec-contract.ts",
						"scripts/template/nothing-contract.ts",
					),
				"telemetry: scripts/openspec/archive.sh names the authority scripts/template/nothing-contract.ts, which is not a file",
			);
			// A delegated path that performs no write is a stale exemption, and a
			// stale exemption widens itself: the next write to land in that file is
			// exempt before anybody reads it.
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'\t"governedElsewhere": [\n',
						'\t"governedElsewhere": [\n\t\t{\n\t\t\t"path": "scripts/template/validate-telemetry.ts",\n\t\t\t"authority": "scripts/template/telemetry-contract.ts"\n\t\t},\n',
					),
				"telemetry: scripts/template/validate-telemetry.ts is exempted as governed elsewhere but performs no remote write; a stale exemption widens itself",
			);
			// ... and an authority that never reads the file it governs governs
			// nothing, which is the failure a plausible-looking path would hide.
			await mutate(
				temporary,
				"scripts/template/openspec-contract.ts",
				(source) =>
					source.replace(
						'export const ARCHIVE_WRAPPER = "scripts/openspec/archive.sh";',
						'export const ARCHIVE_WRAPPER = ["scripts", "openspec", "archive.sh"].join("/");',
					),
				"telemetry: scripts/template/openspec-contract.ts does not name scripts/openspec/archive.sh; an authority that never reads the file it governs governs nothing",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("refuses a registry that does not match its own schema", async () => {
		const temporary = await telemetryFixture();
		try {
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) => source.replace('"schemaVersion": 1', '"schemaVersion": 2'),
				`telemetry: ${REGISTRY_PATH} $.schemaVersion must equal 1`,
			);
			await mutate(
				temporary,
				REGISTRY_PATH,
				(source) =>
					source.replace('"writes": [],', '"writes": [], "extra": 1,'),
				`telemetry: ${REGISTRY_PATH} $.extra is not allowed`,
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
