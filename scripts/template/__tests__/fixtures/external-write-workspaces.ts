import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { type ExternalWrites, NEEDLES } from "../../telemetry-contract";

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
