// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
import { resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const STAGE_THREE_COMMAND_IDS = [
	"image-inspect",
	"warm-browser-build",
	"browser-preflight",
	"launcher-smoke",
	"plugin-repair-smoke",
	"shell-bash-login",
	"shell-bash-non-login",
	"shell-zsh-login",
	"shell-zsh-non-login",
	"browser-known-bad-fixtures",
	"agent-known-bad-fixtures",
	"watchdog-known-bad-fixtures",
	"second-worktree-storage",
	"rollback-proof",
] as const;

export type StageThreeCommandId = (typeof STAGE_THREE_COMMAND_IDS)[number];

const LOG_ROOT = "evidence/stage-3-runtimes-run";
const VERIFY =
	"/usr/bin/env -i HOME=/home/vscode PATH=/usr/bin:/bin /bin/bash -p /usr/local/share/devenv-image/setup-proto.sh";
const SHELL_PROBE =
	'command -v bun; command -v proto; command -v codex; printf "%s\\n" "$PATH"';

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	return isRecord(value[key]) ? (value[key] as JsonRecord) : {};
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
	return Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function sha256(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function expectedStageThreeCommands(
	value: JsonRecord,
): Record<StageThreeCommandId, string[]> {
	const image = String(recordAt(value, "image")["tag"] ?? "");
	const imageRecord = recordAt(value, "image");
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const runId = String(run["id"] ?? "");
	const architecture = String(imageRecord["architecture"] ?? "");
	const mounted = [
		"docker",
		"run",
		"--rm",
		"--mount",
		"type=bind,src=.,dst=/workspace,readonly",
		"--workdir",
		"/workspace",
	];
	return {
		"image-inspect": [
			"docker",
			"image",
			"inspect",
			"--format",
			"{{json .Id}}|{{json .Architecture}}|{{json .Os}}",
			image,
		],
		"warm-browser-build": [
			"docker",
			"buildx",
			"build",
			"--file",
			".devcontainer/Dockerfile",
			"--platform",
			`linux/${architecture}`,
			"--target",
			"development_browser",
			"--tag",
			image,
			"--progress",
			"plain",
			"--load",
			".",
		],
		"browser-preflight": [
			...mounted,
			image,
			"/usr/bin/env",
			"-u",
			"BASH_ENV",
			"-u",
			"ENV",
			"-u",
			"BUN_OPTIONS",
			"-u",
			"NODE_OPTIONS",
			"/bin/bash",
			"-p",
			"-c",
			`${VERIFY} && bun run browser:preflight`,
		],
		"launcher-smoke": [
			...mounted,
			"--entrypoint",
			"/bin/bash",
			image,
			"-p",
			"-c",
			`${VERIFY} && /bin/bash -p /workspace/scripts/template/run-stage-three-image-smoke.sh launchers`,
		],
		"plugin-repair-smoke": [
			...mounted,
			"--tmpfs",
			"/home/vscode/.claude:uid=1000,gid=1000,mode=0755",
			"--tmpfs",
			"/home/vscode/.codex:uid=1000,gid=1000,mode=0755",
			"--entrypoint",
			"/bin/bash",
			image,
			"-p",
			"-c",
			`${VERIFY} && /bin/bash -p /workspace/scripts/template/run-stage-three-image-smoke.sh plugins`,
		],
		"shell-bash-login": [
			"docker",
			"run",
			"--rm",
			image,
			"bash",
			"-lc",
			SHELL_PROBE,
		],
		"shell-bash-non-login": [
			"docker",
			"run",
			"--rm",
			image,
			"bash",
			"-c",
			SHELL_PROBE,
		],
		"shell-zsh-login": [
			"docker",
			"run",
			"--rm",
			image,
			"zsh",
			"-lc",
			SHELL_PROBE,
		],
		"shell-zsh-non-login": [
			"docker",
			"run",
			"--rm",
			image,
			"zsh",
			"-c",
			SHELL_PROBE,
		],
		"browser-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/browser.test.ts",
		],
		"agent-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/image.test.ts",
		],
		"watchdog-known-bad-fixtures": [
			"bun",
			"test",
			"scripts/template/__tests__/gemini-watchdog.test.ts",
		],
		"second-worktree-storage": [
			"bun",
			"scripts/template/collect-stage-two-evidence.ts",
			"probe-storage",
			"--image",
			image,
			"--run-id",
			runId,
			"--implementation",
			String(source["implementationSha"] ?? ""),
			"--workspace",
			`/tmp/devenv-stage2-${runId}-storage`,
		],
		"rollback-proof": [
			"bun",
			"scripts/template/collect-stage-two-evidence.ts",
			"probe-rollback",
			"--base",
			String(source["baseSha"] ?? ""),
			"--implementation",
			String(source["implementationSha"] ?? ""),
			"--workspace",
			`/tmp/devenv-stage2-${runId}-rollback`,
		],
	};
}

function git(
	root: string,
	args: string[],
): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString().trim() };
}

function dockerArg(source: string, name: string): string {
	return new RegExp(`^ARG ${name}=([^\\s]+)$`, "m").exec(source)?.[1] ?? "";
}

export async function validateStageThreeEvidenceValue(
	value: unknown,
	schema: JsonRecord,
	root: string,
): Promise<string[]> {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;
	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const image = recordAt(value, "image");
	const expected = expectedStageThreeCommands(value);
	const commands = arrayAt(value, "commands");
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string"
			? [entry["id"] as string]
			: [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_THREE_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 3 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 3 command IDs are not unique");
	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageThreeCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		if (entry["exitCode"] !== 0 || entry["status"] !== "pass")
			errors.push(`semantic: command ${id} did not pass`);
		for (const stream of ["stdout", "stderr"] as const) {
			const path = `${LOG_ROOT}/${id}.${stream}`;
			if (entry[`${stream}Path`] !== path)
				errors.push(`semantic: command ${id} ${stream} path drifted`);
			const file = Bun.file(resolve(root, path));
			if (!(await file.exists()))
				errors.push(`repository: command ${id} ${stream} log is missing`);
			else if (entry[`${stream}Sha256`] !== sha256(await file.bytes()))
				errors.push(`repository: command ${id} ${stream} digest drifted`);
		}
	}

	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const packageJson = (await Bun.file(
		resolve(root, "package.json"),
	).json()) as JsonRecord;
	const catalog = recordAt(recordAt(packageJson, "workspaces"), "catalog");
	const pins = recordAt(image, "pins");
	for (const [field, argument] of [
		["codex", "CODEX_VERSION"],
		["gemini", "GEMINI_VERSION"],
		["graphify", "GRAPHIFY_VERSION"],
		["claude", "CLAUDE_VERSION"],
		["ccstatusline", "CCSTATUSLINE_VERSION"],
		["context7", "CONTEXT7_VERSION"],
		["octopusCommit", "OCTOPUS_COMMIT"],
		["octopusSha256", "OCTOPUS_SHA256"],
		["warpCommit", "WARP_COMMIT"],
		["warpSha256", "WARP_SHA256"],
	] as const) {
		if (pins[field] !== dockerArg(dockerfile, argument))
			errors.push(
				`repository: ${field} evidence differs from Docker authority`,
			);
	}
	if (
		pins["playwright"] !== dockerArg(dockerfile, "PLAYWRIGHT_VERSION") ||
		pins["playwright"] !== catalog["@playwright/test"]
	)
		errors.push(
			"repository: Playwright evidence differs from package/Docker authority",
		);

	const launchers = recordAt(value, "launchers");
	for (const tool of [
		"codex",
		"gemini",
		"graphify",
		"claude",
		"ccstatusline",
		"context7-mcp",
	])
		if (launchers[tool] !== `/home/vscode/.local/bin/${tool}`)
			errors.push(`semantic: ${tool} launcher path drifted`);
	for (const shell of arrayAt(value, "shellPaths")) {
		if (!isRecord(shell)) continue;
		if (shell["bun"] !== "/home/vscode/.proto/shims/bun")
			errors.push("semantic: shell Bun path is not Proto-owned");
		if (shell["proto"] !== "/home/vscode/.proto/bin/proto")
			errors.push("semantic: shell Proto path drifted");
		if (shell["codex"] !== "/home/vscode/.local/bin/codex")
			errors.push("semantic: shell Codex path drifted");
		if (
			typeof shell["path"] !== "string" ||
			!(shell["path"] as string).startsWith(
				"/workspace/node_modules/.bin:/home/vscode/.proto/shims:/home/vscode/.proto/bin:/home/vscode/.local/bin:",
			)
		)
			errors.push("semantic: shell PATH ownership drifted");
	}

	const browser = recordAt(value, "browser");
	if (
		browser["commandId"] !== "browser-preflight" ||
		browser["markerPath"] !==
			"/home/vscode/.payloads/browser/.devenv-playwright-version" ||
		browser["markerVersion"] !== pins["playwright"] ||
		browser["launchPassed"] !== true
	)
		errors.push("semantic: browser launch evidence drifted");
	const plugins = recordAt(value, "plugins");
	if (
		plugins["commandId"] !== "plugin-repair-smoke" ||
		plugins["persistedSourceRepair"] !== true ||
		plugins["sharedGraphifyResidue"] !== false
	)
		errors.push("semantic: plugin repair evidence drifted");
	const knownBad = recordAt(value, "knownBadFixtures");
	if (
		knownBad["browser"] !== "browser-known-bad-fixtures" ||
		knownBad["agents"] !== "agent-known-bad-fixtures" ||
		knownBad["watchdog"] !== "watchdog-known-bad-fixtures"
	)
		errors.push("semantic: known-bad fixture binding drifted");
	const cloud = recordAt(value, "cloudHandoff");
	if (
		cloud["ownerStage"] !== "stage-4-codex-cloud-parity" ||
		cloud["requiredProfile"] !== "browser" ||
		cloud["requiredCommand"] !== "bun run browser:preflight" ||
		cloud["requiredMarkerPath"] !== browser["markerPath"]
	)
		errors.push("semantic: Stage 4 browser handoff drifted");
	const rollback = recordAt(value, "rollback");
	if (
		rollback["mode"] !== "atomic" ||
		!sameValue(rollback["command"], [
			"git",
			"revert",
			"-m",
			"1",
			"<stage-3-pr-merge-commit>",
		])
	)
		errors.push("semantic: Stage 3 rollback is not atomic");
	const comparison = recordAt(value, "comparison");
	if (
		comparison["warmBuildCommandId"] !== "warm-browser-build" ||
		comparison["storageCommandId"] !== "second-worktree-storage" ||
		Number(comparison["warmBuildDurationMs"] ?? 0) <= 0 ||
		Number(comparison["secondWorktreeObservedBytes"] ?? -1) < 0
	)
		errors.push("semantic: Stage 3 performance/storage comparison drifted");
	const proof = recordAt(rollback, "proof");
	if (
		proof["commandId"] !== "rollback-proof" ||
		proof["predecessorSha"] !== source["baseSha"] ||
		proof["implementationSha"] !== source["implementationSha"] ||
		proof["treeMatchesPredecessor"] !== true
	)
		errors.push("semantic: Stage 3 rollback proof drifted");

	for (const [label, sha] of [
		["base", source["baseSha"]],
		["implementation", source["implementationSha"]],
	] as const)
		if (
			typeof sha !== "string" ||
			git(root, ["cat-file", "-e", `${sha}^{commit}`]).exitCode !== 0
		)
			errors.push(`repository: Stage 3 ${label} commit is missing`);
	if (
		typeof source["baseSha"] === "string" &&
		typeof source["implementationSha"] === "string" &&
		git(root, [
			"merge-base",
			"--is-ancestor",
			source["baseSha"] as string,
			source["implementationSha"] as string,
		]).exitCode !== 0
	)
		errors.push(
			"repository: Stage 3 base is not an ancestor of implementation",
		);
	return errors;
}

export async function validateStageThreeEvidence(
	root = resolve(import.meta.dir, "../.."),
	evidencePath = resolve(root, "evidence/stage-3-runtimes.json"),
): Promise<string[]> {
	try {
		const value = await Bun.file(evidencePath).json();
		const schema = (await Bun.file(
			resolve(root, "evidence/stage-3-runtimes.schema.json"),
		).json()) as JsonRecord;
		return validateStageThreeEvidenceValue(value, schema, root);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}
}
