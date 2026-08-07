// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The mutations write
// runner expressions into a workflow verbatim.
import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	deriveTreeState,
	type ExternalWrites,
	REGISTRY_PATH,
	readExternalWrites,
	validateAllowlist,
	validateCredentialLiterals,
	validateDeclaredWrites,
	validateSoleDeclarations,
	validateTelemetryContract,
} from "../telemetry-contract";
import {
	activeWorkspace,
	CONFIG_MODULE_PATH,
	configModuleSource,
	DEPLOY_SCRIPT_PATH,
	declaredTelemetry,
	declaredWrite,
	INSTRUCTION_SCRIPT,
	RELEASE_VARIABLE,
	ROOT,
	SCRUB_MODULE_PATH,
	SDK_IMPORT,
	SDK_INITIALIZER,
	SDK_LOGGER,
	SDK_SCOPE,
	SDK_SET_USER,
	SKELETON,
	TOKEN_VARIABLE,
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
				writes: [declaredWrite()],
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
				writes: [declaredWrite({ path: "scripts/openspec/archive.sh" })],
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

describe("telemetry SDK confinement", () => {
	test("accepts a declared configuration module and refuses every other caller", async () => {
		const { root } = await activeWorkspace({ prefix: "devenv-telemetry-sdk-" });
		try {
			expect(await validateTelemetryContract(root)).toEqual([]);
			// The allowlist is derived from the registry, so the SAME content is
			// legal in a declared module and refused outside one. That is the whole
			// difference between an allowlist and a list of mistakes.
			await withFile(
				root,
				"apps/web/src/boot.ts",
				SDK_IMPORT,
				"telemetry: apps/web/src/boot.ts imports the telemetry SDK outside a declared configuration module",
			);
			await withFile(
				root,
				"apps/web/src/init.ts",
				SDK_INITIALIZER,
				"telemetry: apps/web/src/init.ts calls the telemetry SDK initializer outside a declared configuration module",
			);
			await withFile(
				root,
				"apps/web/src/log.ts",
				SDK_LOGGER,
				"telemetry: apps/web/src/log.ts reaches the telemetry SDK's structured logger or metrics namespace outside a declared configuration module",
			);
			// The user binding is banned in EVERY file, declared or not: it is the
			// one call whose whole purpose is to attach an identity to a report that
			// leaves the building.
			await withFile(
				root,
				`${CONFIG_MODULE_PATH.slice(0, -3)}-user.ts`,
				SDK_SET_USER,
				`telemetry: ${CONFIG_MODULE_PATH.slice(0, -3)}-user.ts binds a telemetry user identity; the SDK's user binding attaches an identity to every report and is banned everywhere`,
			);
			// ... and the near-misses. An unrelated object with the same method
			// name is not the SDK, and the SDK's own surface inside a declared
			// module is exactly what the declaration is for.
			await tolerate(
				root,
				"apps/web/src/session.ts",
				'declare const app: { setUser(id: string): void };\napp.setUser("1");\n',
			);
			// The import scan reads the AST, so a module that only NAMES the scope
			// in a string is not a module that imports it.
			await tolerate(
				root,
				"apps/web/src/docs.ts",
				`export const documentedScope = "${SDK_SCOPE}";\n`,
			);
			// ... and the executable half is what the substring rules read, so a
			// comment explaining the ban is not an instance of it.
			await tolerate(
				root,
				"apps/web/src/notes.ts",
				`// Never call ${SDK_INITIALIZER.trim()} outside a declared module.\nexport const note = 1;\n`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the upload truth table", () => {
	test("accepts a module that gates on both halves and warns on one", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-table-",
		});
		try {
			expect(await validateTelemetryContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses every state the table does not have", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-table-bad-",
		});
		try {
			// Neither half. A module that reads no gate at all cannot be gated on
			// one, so the message names both variables rather than the missing one.
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) =>
					source
						.replace(`process.env.${RELEASE_VARIABLE}`, '""')
						.replace(`process.env.${TOKEN_VARIABLE}`, '""'),
				`telemetry: no declared configuration module reads both ${RELEASE_VARIABLE} and ${TOKEN_VARIABLE}; an upload gated on one half is gated on nothing`,
			);
			// The credential without the intent — the exact bug the reference's
			// header names: a leaked CI token in a developer shell minting phantom
			// releases from a plain local build.
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) => source.replace(`process.env.${RELEASE_VARIABLE}`, '""'),
				`telemetry: no declared configuration module reads both ${RELEASE_VARIABLE} and ${TOKEN_VARIABLE}; an upload gated on one half is gated on nothing`,
			);
			// The intent without the credential.
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) => source.replace(`process.env.${TOKEN_VARIABLE}`, '""'),
				`telemetry: no declared configuration module reads both ${RELEASE_VARIABLE} and ${TOKEN_VARIABLE}; an upload gated on one half is gated on nothing`,
			);
			// Both halves read, and the credential still used where the intent does
			// not reach. This is the case a presence check would wave through.
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) =>
					source.replace(
						"export const uploadEnabled = Boolean(release) && Boolean(authToken);",
						"export const uploadEnabled = Boolean(authToken);",
					),
				`telemetry: ${CONFIG_MODULE_PATH} reads ${TOKEN_VARIABLE} in a branch ${RELEASE_VARIABLE} does not dominate; the gate is intent times credential`,
			);
			// The partial state must be loud.
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) =>
					source.replace(
						'\tconsole.warn("[telemetry] upload DISABLED: one half of the gate is set and the other is not");\n',
						"",
					),
				`telemetry: no declared configuration module warns from a branch that reads both ${RELEASE_VARIABLE} and ${TOKEN_VARIABLE}; a build that silently skips the upload is a build nobody notices`,
			);
			// A declared upload has a declared scope, and one that can reach the
			// server bundle is a different artifact leaving the building.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) => source.replace('"scope": "client"', '"scope": "server"'),
				`telemetry: ${REGISTRY_PATH} declares the upload scope server; an upload that can reach the server bundle is a refusal`,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a module that gates correctly but names the variables in prose is tolerated", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-table-prose-",
		});
		try {
			// The comment names the credential outside every branch. Reading the
			// executable half is what lets the explanation be written at all.
			await Bun.write(
				resolve(root, CONFIG_MODULE_PATH),
				`// ${TOKEN_VARIABLE} is never read without ${RELEASE_VARIABLE}.\n${configModuleSource()}`,
			);
			expect(await validateTelemetryContract(root)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("declared writes", () => {
	test("requires an intent, its credentials and a separate verifier", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-writes-",
		});
		try {
			await mutate(
				root,
				DEPLOY_SCRIPT_PATH,
				(source) => source.replace('"--confirm-push"', '"--yes"'),
				"telemetry: scripts/deploy.sh never reads the intent --confirm-push; a credential is not an authorization",
			);
			await mutate(
				root,
				DEPLOY_SCRIPT_PATH,
				(source) => source.replaceAll("DEPLOY_ACCESS_TOKEN", "OTHER_TOKEN"),
				"telemetry: scripts/deploy.sh declares the credential DEPLOY_ACCESS_TOKEN and never reads it",
			);
			await mutate(
				root,
				DEPLOY_SCRIPT_PATH,
				(source) =>
					source.replace(
						"git ls-remote --exit-code origin refs/heads/main\n",
						"",
					),
				"telemetry: scripts/deploy.sh never runs the declared verify command git ls-remote --exit-code origin; an unread final state is an unasserted one",
			);
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"verify": "git ls-remote --exit-code origin"',
						'"verify": "git push --quiet origin HEAD"',
					),
				"telemetry: the write deploy verifies with its own write command; verification is a separate command, never a flag on the write",
			);
			// A declared write whose file writes nothing is a declaration nothing
			// exercises — the mirror image of a write nothing declares.
			await mutate(
				root,
				DEPLOY_SCRIPT_PATH,
				(source) => source.replace("git push --quiet origin HEAD\n", ""),
				"telemetry: scripts/deploy.sh is declared as the write deploy but performs no remote write",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("refuses a verifier that is itself a remote write", () => {
		expect(
			validateDeclaredWrites("/nonexistent", {
				...SKELETON,
				mode: "active",
				writes: [declaredWrite({ verify: "git push --tags origin" })],
			}),
		).toContain(
			"telemetry: the write deploy declares a verify command that is itself a remote write; a verifier that mutates confirms only its own effect",
		);
	});
});

// Assembled at run time, exactly as the guard assembles the patterns that find
// them. A test file that spelled either literal out would be the first thing
// its own scan reported, and neither host can ever resolve: `.invalid` is
// reserved by the DNS specification for exactly this.
const PLANTED_DSN = [
	"https://",
	"a".repeat(16),
	"@ingest.example.invalid/",
	"1",
].join("");
const PLANTED_TOKEN = [
	"TELEMETRY_UPLOAD_TOKEN",
	' = "',
	"b1".repeat(20),
	'"',
].join("");

describe("credential literals", () => {
	test("finds a planted literal and stays quiet on one that only looks like one", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-literals-",
		});
		const planted = resolve(root, "docs/planted.md");
		try {
			// A tree-wide scan that finds nothing is only meaningful when something
			// proves it WOULD find something.
			expect(await validateTelemetryContract(root)).toEqual([]);
			await mkdir(dirname(planted), { recursive: true });
			await Bun.write(planted, `${PLANTED_DSN}\n`);
			expect(await validateTelemetryContract(root)).toContain(
				"telemetry: docs/planted.md carries a committed ingest DSN literal; a credential belongs to the environment that supplies it",
			);
			await Bun.write(planted, `${PLANTED_TOKEN}\n`);
			expect(await validateTelemetryContract(root)).toContain(
				"telemetry: docs/planted.md assigns a long opaque value to a credential-named binding; a credential belongs to the environment that supplies it",
			);
			// The near-misses. A documentation example with placeholders and a long
			// descriptive placeholder are both harmless, and a rule that cried wolf
			// on either would be turned off within a week.
			await Bun.write(
				planted,
				"https://<key>@ingest.example.invalid/<project>\n" +
					'TELEMETRY_UPLOAD_TOKEN = "replace-this-with-the-value-from-your-provider"\n',
			);
			expect(await validateTelemetryContract(root)).toEqual([]);
		} finally {
			await rm(planted, { force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	test("the committed tree carries no credential literal at all", () => {
		expect(validateCredentialLiterals(ROOT)).toEqual([]);
	});
});

describe("scrubbing policy", () => {
	test("requires a pure scrubber every declared tier routes through", async () => {
		const { root } = await activeWorkspace({
			prefix: "devenv-telemetry-scrub-",
		});
		try {
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) => source.replace("\t\tbeforeSend: scrub,\n", ""),
				`telemetry: ${CONFIG_MODULE_PATH} declares no beforeSend hook; a payload nothing scrubs is a payload nothing checked`,
			);
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) =>
					source.replace("sendDefaultPii: false", "sendDefaultPii: true"),
				`telemetry: ${CONFIG_MODULE_PATH} must pin sendDefaultPii to false; there is no configuration in which a template collects default PII`,
			);
			await mutate(
				root,
				CONFIG_MODULE_PATH,
				(source) => source.replace('import { scrub } from "./scrub";\n', ""),
				`telemetry: ${CONFIG_MODULE_PATH} never imports ${SCRUB_MODULE_PATH}; a declared scrubber nothing routes through scrubs nothing`,
			);
			// The scrubber is shared by every tier, and that is only possible while
			// it stays pure.
			await mutate(
				root,
				SCRUB_MODULE_PATH,
				(source) => `${SDK_IMPORT}${source}`,
				`telemetry: ${SCRUB_MODULE_PATH} imports the telemetry SDK; the scrubber is shared by every tier and must stay pure`,
			);
			// NON-SECRECY, in both directions. The ingest DSN ships inside the
			// client bundle and may not read like a secret; the upload token never
			// reaches one and must.
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"dsnVariable": "TELEMETRY_DSN"',
						'"dsnVariable": "TELEMETRY_DSN_SECRET"',
					),
				"telemetry: TELEMETRY_DSN_SECRET is declared as the client-visible ingest variable and reads like a credential; a value that ships inside a bundle may not be named as a secret",
			);
			await mutate(
				root,
				REGISTRY_PATH,
				(source) =>
					source.replace(
						'"tokenVariable": "TELEMETRY_UPLOAD_TOKEN"',
						'"tokenVariable": "TELEMETRY_UPLOAD_HANDLE"',
					),
				"telemetry: TELEMETRY_UPLOAD_HANDLE is the upload credential and is not named as one; a secret that does not read like a secret is a secret nobody protects",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("the host allowlist", () => {
	test("accepts exact origins and refuses anything wider", () => {
		const base = { ...SKELETON, mode: "active" as const };
		expect(
			validateAllowlist({
				...base,
				allowedHosts: ["https://git.example.invalid"],
				writes: [declaredWrite()],
			}),
		).toEqual([]);
		// A wildcard is a denylist wearing an allowlist's name.
		expect(
			validateAllowlist({
				...base,
				allowedHosts: ["https://*.example.invalid"],
				writes: [],
			}),
		).toContain(
			"telemetry: the allowed host https://*.example.invalid is a wildcard; an allowlist that can match a host nobody enumerated is a denylist wearing an allowlist's name",
		);
		// An entry with a path is not an origin: the path is not what a socket
		// connects to, so listing one narrows nothing while looking like it does.
		expect(
			validateAllowlist({
				...base,
				allowedHosts: ["https://git.example.invalid/org/repo"],
				writes: [],
			}),
		).toContain(
			"telemetry: the allowed host https://git.example.invalid/org/repo carries a path, a query or a fragment; an allowlist entry is an origin",
		);
		expect(
			validateAllowlist({
				...base,
				allowedHosts: ["http://git.example.invalid"],
				writes: [],
			}),
		).toContain(
			"telemetry: the allowed host http://git.example.invalid is not https and is not loopback",
		);
		// A write may only reach a host the union lists.
		expect(
			validateAllowlist({
				...base,
				allowedHosts: ["https://git.example.invalid"],
				writes: [
					declaredWrite({ allowedHosts: ["https://other.example.invalid"] }),
				],
			}),
		).toContain(
			`telemetry: the write deploy allows the host https://other.example.invalid, which ${REGISTRY_PATH} does not list; every write's hosts are a subset of the declared union`,
		);
		// A declared tunnel is same-origin or it is a second ingest endpoint.
		expect(
			validateAllowlist({
				...base,
				allowedHosts: [],
				telemetry: declaredTelemetry({
					tunnel: "https://tunnel.example.invalid/relay",
				}),
			}),
		).toContain(
			"telemetry: the declared tunnel https://tunnel.example.invalid/relay is not a same-origin path; a tunnel that names a host is a second ingest endpoint",
		);
		// ... and an empty allowlist beside a declared write is not a narrow one.
		expect(
			validateAllowlist({
				...base,
				allowedHosts: [],
				writes: [
					declaredWrite({ allowedHosts: ["https://git.example.invalid"] }),
				],
			}),
		).toContain(
			`telemetry: ${REGISTRY_PATH} declares a write and no allowed host; an empty allowlist is not a narrow one`,
		);
	});
});
