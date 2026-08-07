// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The fixtures carry
// shell parameter expansions and runner expressions verbatim.
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type DeclaredWrite,
	type ExternalWrites,
	NEEDLES,
	type TelemetryDeclaration,
} from "../../telemetry-contract";

export const ROOT = resolve(import.meta.dir, "../../../..");

// Everything validateTelemetryContract reads out of a tree. The workspaces
// built here are plain directories and not Git repositories on purpose: the
// file enumeration falls back to a pruned walk there, which is the path a
// rendered project's CI takes before its first commit.
//
// The archive wrapper and its authority travel with the rest because the
// committed registry delegates one write to them, and a workspace missing
// either would be testing the delegation instead of the leg under test.
export const CONTRACT_FILES = [
	"external-writes.json",
	"external-writes.schema.json",
	"package.json",
	"template-parameters.toml",
	".github/workflows/ci.yml",
	"scripts/openspec/archive.sh",
	"scripts/template/openspec-contract.ts",
	"scripts/template/telemetry-contract.ts",
	"scripts/template/validate-telemetry.ts",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

// Every needle is taken from the guard rather than spelled here. A fixture
// module that wrote either the SDK scope or the initializer out would BE an
// instance of the shape it exists to produce, and the file carrying the
// fixtures would then fail the guard under test.
export const SDK_SCOPE = NEEDLES.scope;
export const SDK_IMPORT = `import * as Telemetry from "${SDK_SCOPE}node";\n`;
export const SDK_INITIALIZER = `${NEEDLES.initializer}{});\n`;
export const SDK_SET_USER = `${NEEDLES.setUser}{ id: "1" });\n`;
export const SDK_LOGGER = `${NEEDLES.logger}info("hello");\n`;
export const SDK_METRICS = `${NEEDLES.metrics}increment("hits");\n`;

// A real remote write, and a script that only ever talks about one. The second
// is the `tolerate()` half of the write-shape scan: `echo` prints an
// instruction to a human and pushes nothing, and a scan that could not tell
// them apart would make writing the instruction impossible.
export const WRITE_SCRIPT = [
	"#!/usr/bin/env bash",
	"set -euo pipefail",
	"git push --quiet origin HEAD",
	"",
].join("\n");

export const INSTRUCTION_SCRIPT = [
	"#!/usr/bin/env bash",
	"set -euo pipefail",
	"# Nothing here pushes anything; run this yourself:",
	'echo "  git push -u origin HEAD"',
	"",
].join("\n");

export const SKELETON: ExternalWrites = {
	schemaVersion: 1,
	mode: "skeleton",
	telemetry: null,
	writes: [],
	allowedHosts: [],
	governedElsewhere: [
		{
			path: "scripts/openspec/archive.sh",
			authority: "scripts/template/openspec-contract.ts",
		},
	],
};

/** Tab-indented with a trailing newline, exactly as the committed one is. */
export async function writeRegistry(
	root: string,
	contract: ExternalWrites,
): Promise<void> {
	await Bun.write(
		resolve(root, "external-writes.json"),
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

// Deliberately vendor-neutral names. A fixture never needs a real vendor's
// spelling to exercise a rule, and every host below is `example.invalid`, which
// is reserved by the DNS specification and can never resolve.
export const RELEASE_VARIABLE = "TELEMETRY_RELEASE";
export const TOKEN_VARIABLE = "TELEMETRY_UPLOAD_TOKEN";
export const DSN_VARIABLE = "TELEMETRY_DSN";
export const DEPLOY_CREDENTIAL = "DEPLOY_ACCESS_TOKEN";

export const CONFIG_MODULE_PATH = "libs/observability/src/telemetry.ts";
export const SCRUB_MODULE_PATH = "libs/observability/src/scrub.ts";
export const DEPLOY_SCRIPT_PATH = "scripts/deploy.sh";

export const INGEST_HOST = "https://ingest.example.invalid";
export const GIT_HOST = "https://git.example.invalid";
export const UPLOAD_COMMAND = "bun run upload-sourcemaps";
export const WRITE_COMMAND = "git push --quiet origin HEAD";
export const VERIFY_COMMAND = "git ls-remote --exit-code origin";
export const WRITE_INTENT = "--confirm-push";

/**
 * A configuration module that implements the whole truth table.
 *
 * Neither half set is quiet, one half set warns loudly and writes nothing, and
 * both halves set is the only state that enables the upload. The credential is
 * read into a local once and then never used outside an expression the release
 * also appears in, which is the shape the dominance rule projects onto.
 */
export function configModuleSource(): string {
	return [
		`import * as Telemetry from "${SDK_SCOPE}node";`,
		'import { scrub } from "./scrub";',
		"",
		`const release = process.env.${RELEASE_VARIABLE};`,
		`const authToken = process.env.${TOKEN_VARIABLE};`,
		"",
		"if (Boolean(release) !== Boolean(authToken)) {",
		'\tconsole.warn("[telemetry] upload DISABLED: one half of the gate is set and the other is not");',
		"}",
		"",
		"export const uploadEnabled = Boolean(release) && Boolean(authToken);",
		"",
		"export function start(): void {",
		`\tconst dsn = process.env.${DSN_VARIABLE};`,
		"\tif (!dsn) return;",
		`\t${NEEDLES.initializer}{`,
		"\t\tdsn,",
		"\t\tsendDefaultPii: false,",
		"\t\tbeforeSend: scrub,",
		"\t\ttransport: Telemetry.makeNodeTransport,",
		"\t});",
		"}",
		"",
	].join("\n");
}

/** A pure, SDK-free scrubber that fails closed. */
export function scrubModuleSource(): string {
	return [
		"const SENSITIVE = /authorization|cookie|password|private[-_]?key|signature/i;",
		"",
		"export function scrub(event: Record<string, unknown>): Record<string, unknown> {",
		"\ttry {",
		"\t\tfor (const key of Object.keys(event)) {",
		"\t\t\tif (SENSITIVE.test(key)) delete event[key];",
		"\t\t}",
		"\t\treturn event;",
		"\t} catch {",
		"\t\t// Fail CLOSED: a scrubber that throws drops the payload rather than",
		"\t\t// shipping the one it could not clean.",
		"\t\treturn {};",
		"\t}",
		"}",
		"",
	].join("\n");
}

/** A write that refuses without its named intent and no-ops without its credential. */
export function deployScriptSource(): string {
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"",
		'if [ "${1:-}" != "--confirm-push" ]; then',
		'\techo "refusing to write without the confirmation flag" >&2',
		"\texit 1",
		"fi",
		`if [ -z "\${${DEPLOY_CREDENTIAL}:-}" ]; then`,
		`\techo "::warning::no ${DEPLOY_CREDENTIAL}; nothing was written" >&2`,
		"\texit 0",
		"fi",
		"git push --quiet origin HEAD",
		"git ls-remote --exit-code origin refs/heads/main",
		"",
	].join("\n");
}

export function declaredWrite(
	overrides: Partial<DeclaredWrite> = {},
): DeclaredWrite {
	return {
		id: "deploy",
		path: DEPLOY_SCRIPT_PATH,
		kind: "git",
		command: WRITE_COMMAND,
		intent: WRITE_INTENT,
		credentials: [DEPLOY_CREDENTIAL],
		verify: VERIFY_COMMAND,
		allowedHosts: [GIT_HOST],
		...overrides,
	};
}

export function declaredTelemetry(
	overrides: Partial<TelemetryDeclaration> = {},
): TelemetryDeclaration {
	return {
		configModules: [{ path: CONFIG_MODULE_PATH, tier: "server" }],
		scrubModule: SCRUB_MODULE_PATH,
		sendDefaultPii: false,
		tunnel: null,
		dsnVariable: DSN_VARIABLE,
		upload: {
			command: UPLOAD_COMMAND,
			releaseVariable: RELEASE_VARIABLE,
			tokenVariable: TOKEN_VARIABLE,
			scope: "client",
		},
		...overrides,
	};
}

/** An `active` workspace with a real configuration module, scrubber and write. */
export async function activeWorkspace(options?: {
	contract?: Partial<ExternalWrites>;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<{ root: string; contract: ExternalWrites }> {
	const contract: ExternalWrites = {
		...SKELETON,
		mode: "active",
		telemetry: declaredTelemetry(),
		writes: [declaredWrite()],
		allowedHosts: [GIT_HOST, INGEST_HOST],
		...options?.contract,
	};
	const root = await telemetryWorkspace({
		contract,
		prefix: options?.prefix ?? "devenv-telemetry-active-",
		files: {
			[CONFIG_MODULE_PATH]: configModuleSource(),
			[SCRUB_MODULE_PATH]: scrubModuleSource(),
			[DEPLOY_SCRIPT_PATH]: deployScriptSource(),
			...options?.files,
		},
	});
	return { root, contract };
}

/**
 * A synthetic workspace carrying the committed external-write surface plus
 * whatever the caller declares.
 *
 * The registry and the files move together on purpose: the guard reconciles the
 * declared mode with the derived tree state before any leg runs, so a fixture
 * that wrote one without the other would be testing the reconciliation instead
 * of the leg it meant to reach.
 */
export async function telemetryWorkspace(options?: {
	contract?: ExternalWrites;
	files?: Record<string, string>;
	prefix?: string;
}): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), options?.prefix ?? "devenv-telemetry-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
	}
	if (options?.contract) await writeRegistry(temporary, options.contract);
	if (options?.files) await writeFiles(temporary, options.files);
	return temporary;
}
