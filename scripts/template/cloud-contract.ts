// biome-ignore-all lint/complexity/useLiteralKeys: Contract records use dynamic keys.
import { statSync } from "node:fs";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const DEPLOYMENT_SECRET = /CLOUDFLARE|SENTRY|DEPLOY|PROD/;
const PERSISTED_ENVIRONMENT = /^~\/\.config\/([a-z0-9-]+)\/codex-cloud\.env$/;
const PERSISTED_SECRETS =
	/^~\/\.config\/([a-z0-9-]+)\/codex-cloud-secrets\.env$/;
const MARKER_DIRECTORY = /^~\/\.cache\/([a-z0-9-]+)\/codex-cloud$/;

const CONTRACT_PATH = ".codex/cloud/contract.toml";
const SMOKE_WORKFLOW = ".github/workflows/codex-cloud-smoke.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const STAGE_THREE_EVIDENCE = "evidence/stage-3-runtimes.json";
const GUARD_CONTRACT = "scripts/template/cloud-contract.ts";
const GUARD_ENTRYPOINT = "scripts/template/validate-cloud.ts";

const CLOUD_SCRIPTS = [
	".codex/cloud/lib.sh",
	".codex/cloud/bootstrap.sh",
	".codex/cloud/doctor.sh",
	".codex/cloud/exec.sh",
	".codex/cloud/selftest.sh",
] as const;

// Every scalar and array the contract may carry. The Graphify and Playwright
// subsets are required when their capability is present in this tree and
// forbidden when it is not, so a rendered project can never keep a fenced pin
// for a capability it disabled.
const BASE_KEYS = [
	"version",
	"default_profile",
	"setup_command",
	"maintenance_command",
	"doctor_command",
	"selftest_command",
	"exec_command",
	"agent_internet_access",
	"network_attempts",
	"network_timeout_seconds",
	"required_environment_variables",
	"profile_environment_variable",
	"persisted_environment",
	"persisted_secrets_environment",
	"extra_environment_variable",
	"fingerprint_marker_directory",
	"frozen_dependency_command",
	"proto_installer",
	"proto_checksums",
	"supported_architectures",
	"proto_sha256_x86_64_linux",
	"proto_sha256_aarch64_linux",
	"required_tools",
	"tool_proto",
	"tool_bun",
	"tool_node",
	"tool_moon",
	"tool_python",
	"tool_uv",
	"tool_jq",
	"fingerprint_inputs",
	"secret_allow_list",
	"forbidden_cloud_commands",
] as const;

const GRAPHIFY_KEYS = [
	"graphify_version",
	"graphify_package",
	"graphify_binary",
] as const;

// Browser pins exist only in a tree that ships the Playwright capability. The
// fenced regions in this file are removed when a project renders without it, so
// a cloud-only project carries a guard that knows nothing about browsers rather
// than a guard that silently skips them.
const PLAYWRIGHT_KEYS: readonly string[] = [
	// capability:start playwright
	"browser_profile",
	"browser_network_timeout_seconds",
	"browser_playwright_version",
	"browser_payload_root",
	"browser_environment_variable",
	"browser_marker_basename",
	"browser_reference_marker_path",
	"browser_required_command",
	"browser_install_command",
	// capability:end playwright
];

const BROWSER_CATALOG_PACKAGES: readonly string[] = [
	// capability:start playwright
	"@playwright/test",
	// capability:end playwright
];

const FROZEN_SCALARS: ReadonlyArray<readonly [string, string]> = [
	["default_profile", "core"],
	["profile_environment_variable", "CODEX_CLOUD_PROFILE"],
	["extra_environment_variable", "CODEX_CLOUD_PERSIST_EXTRA_ENV"],
	["frozen_dependency_command", "bun install --frozen-lockfile"],
	["proto_installer", ".devcontainer/install-proto.sh"],
	["proto_checksums", ".devcontainer/proto-checksums.txt"],
];

const COMMAND_KEYS: ReadonlyArray<readonly [string, string]> = [
	["setup_command", ".codex/cloud/bootstrap.sh"],
	["maintenance_command", ".codex/cloud/bootstrap.sh"],
	["doctor_command", ".codex/cloud/doctor.sh"],
	["selftest_command", ".codex/cloud/selftest.sh"],
	["exec_command", ".codex/cloud/exec.sh"],
];

const EXPECTED_ARCHITECTURES = [
	"aarch64-unknown-linux-gnu",
	"x86_64-unknown-linux-gnu",
] as const;

const CHECKSUM_KEYS: ReadonlyArray<readonly [string, string]> = [
	["proto_sha256_x86_64_linux", "x86_64-unknown-linux-gnu"],
	["proto_sha256_aarch64_linux", "aarch64-unknown-linux-gnu"],
];

const EXPECTED_FINGERPRINT_INPUTS = [
	".codex/cloud/bootstrap.sh",
	".codex/cloud/contract.toml",
	".codex/cloud/doctor.sh",
	".codex/cloud/exec.sh",
	".codex/cloud/lib.sh",
	".devcontainer/install-proto.sh",
	".devcontainer/proto-checksums.txt",
	".prototools",
	"bun.lock",
	"package.json",
] as const;

// Generic developer and agent credentials only. Deployment and production
// credentials stay in GitHub Actions and must never be bridged into a cloud
// agent phase.
const EXPECTED_SECRET_ALLOW_LIST = [
	"ANTHROPIC_API_KEY",
	"CONTEXT7_API_KEY",
	"GEMINI_API_KEY",
	"GH_TOKEN",
	"GIT_USER_EMAIL",
	"GIT_USER_NAME",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
] as const;

const EXPECTED_FORBIDDEN_COMMANDS = [
	"docker",
	"devpod",
	"devcontainer",
	"wrangler deploy",
	"git push",
	".devcontainer/host/",
] as const;

// The doctor reports; it never repairs. A single one of these outside a comment
// turns the drift detector into a silent installer.
const MUTATING_TOKENS = [
	"curl",
	"proto install",
	"bun install",
	"uv tool install",
	"mkdir -p",
	"chmod",
] as const;

const EXEC_ORDER = [
	"cloud_source_persisted_environment",
	"cloud_is_verified",
	"doctor.sh",
	'exec "$@"',
] as const;

const OWNED_ARTIFACTS = [
	".codex/cloud/**",
	SMOKE_WORKFLOW,
	GUARD_CONTRACT,
	GUARD_ENTRYPOINT,
] as const;

const SIGNATURE_TOKENS = ["CODEX_CLOUD", "codex-cloud", "cloud:check"] as const;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	if (!isRecord(value)) throw new Error(`${path} must contain an object`);
	return value;
}

async function readText(path: string): Promise<string> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : "";
}

function scalar(contract: JsonRecord, key: string): string | undefined {
	const value = contract[key];
	return typeof value === "string" ? value : undefined;
}

function list(contract: JsonRecord, key: string): string[] | undefined {
	const value = contract[key];
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string")
		? (value as string[])
		: undefined;
}

function sorted(values: readonly string[]): string {
	return [...values].sort().join(",");
}

// Bash comments describe the boundary; only executable lines can cross it.
function stripComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

function stageBody(source: string, name: string): string | undefined {
	const stages = [
		...source.matchAll(/^FROM\s+[^\s]+\s+AS\s+([a-z0-9_]+)\s*$/gim),
	];
	const index = stages.findIndex((match) => match[1]?.toLowerCase() === name);
	if (index < 0) return undefined;
	const start = (stages[index]?.index ?? 0) + (stages[index]?.[0].length ?? 0);
	const end = stages[index + 1]?.index ?? source.length;
	return source.slice(start, end);
}

function dockerArgument(source: string, name: string): string | undefined {
	const matches = [
		...source.matchAll(new RegExp(`^ARG ${name}=([^\\s#]+)\\s*$`, "gm")),
	].flatMap((match) => (match[1] ? [match[1]] : []));
	return matches.length === 1 ? matches[0] : undefined;
}

// One block of a two-space YAML mapping, up to the next key at the same indent.
function yamlBlock(source: string, key: string, indent: string): string {
	const anchor = `\n${indent}${key}:`;
	const start = source.indexOf(anchor);
	if (start < 0) return "";
	const lines = source.slice(start + 1).split("\n");
	const block: string[] = [];
	for (const line of lines) {
		if (
			block.length > 0 &&
			line.trim() !== "" &&
			!line.startsWith(`${indent} `)
		)
			break;
		block.push(line);
	}
	return block.join("\n");
}

function isExecutable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

export async function validateCloudContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const contractPath = resolve(root, CONTRACT_PATH);
	const supported = await exists(contractPath);
	const packageJson = await readJson(resolve(root, "package.json"));
	const catalog = recordAt(recordAt(packageJson, "workspaces"), "catalog");
	const scripts = recordAt(packageJson, "scripts");
	const ci = await readText(resolve(root, CI_WORKFLOW));
	const agents = await readText(resolve(root, "AGENTS.md"));

	if (!supported) {
		for (const path of [
			...CLOUD_SCRIPTS,
			GUARD_CONTRACT,
			GUARD_ENTRYPOINT,
			SMOKE_WORKFLOW,
		]) {
			if (await exists(resolve(root, path)))
				errors.push(`cloud: disabled capability leaves ${path}`);
		}
		if (scripts["cloud:check"] !== undefined)
			errors.push("cloud: disabled capability leaves package scripts");
		if (ci.includes("cloud:check") || ci.includes("codex-cloud"))
			errors.push("cloud: disabled capability leaves workflow wiring");
		if (agents.includes("CODEX_CLOUD"))
			errors.push("cloud: disabled capability leaves agent rules");
		return errors;
	}

	let contract: JsonRecord;
	try {
		contract = Bun.TOML.parse(
			await Bun.file(contractPath).text(),
		) as JsonRecord;
	} catch {
		errors.push("cloud: contract must parse as TOML");
		return errors;
	}

	const dockerfile = await readText(resolve(root, ".devcontainer/Dockerfile"));
	const parameterPath = resolve(root, "template-parameters.toml");
	const templateSource = await exists(parameterPath);
	const browserSupported = BROWSER_CATALOG_PACKAGES.some(
		(name) => catalog[name] !== undefined,
	);
	const graphifySupported = dockerfile.includes("ARG GRAPHIFY_VERSION=");

	const expectedKeys = new Set<string>([
		...BASE_KEYS,
		...(graphifySupported ? GRAPHIFY_KEYS : []),
		...(browserSupported ? PLAYWRIGHT_KEYS : []),
	]);
	for (const key of expectedKeys) {
		if (!(key in contract))
			errors.push(`cloud: contract key ${key} is missing`);
	}
	for (const key of Object.keys(contract)) {
		if (!expectedKeys.has(key))
			errors.push(`cloud: contract key ${key} is unknown`);
	}

	if (contract["version"] !== 1)
		errors.push("cloud: contract version must be 1");
	for (const [key, expected] of FROZEN_SCALARS) {
		if (expectedKeys.has(key) && scalar(contract, key) !== expected)
			errors.push(`cloud: ${key} must be ${expected}`);
	}
	for (const [key, script] of COMMAND_KEYS) {
		if (!(scalar(contract, key) ?? "").includes(script))
			errors.push(`cloud: ${key} must invoke ${script}`);
	}
	if (!(scalar(contract, "agent_internet_access") ?? "").trim())
		errors.push("cloud: agent_internet_access must record the network posture");
	if (
		!(list(contract, "required_environment_variables") ?? []).includes(
			"CODEX_CLOUD=true",
		)
	)
		errors.push("cloud: required environment must demand CODEX_CLOUD=true");

	const versionKeys = [
		"tool_proto",
		"tool_bun",
		"tool_node",
		"tool_moon",
		"tool_python",
		"tool_uv",
		"tool_jq",
		...(graphifySupported ? ["graphify_version"] : []),
		// capability:start playwright
		...(browserSupported ? ["browser_playwright_version"] : []),
		// capability:end playwright
	];
	for (const key of versionKeys) {
		if (!(key in contract)) continue;
		const value = scalar(contract, key);
		if (value === undefined || !EXACT_VERSION.test(value))
			errors.push(`cloud: ${key} must use an exact version`);
	}
	for (const [key] of CHECKSUM_KEYS) {
		const value = scalar(contract, key);
		if (value === undefined || !LOWERCASE_SHA256.test(value))
			errors.push(`cloud: ${key} must be a lowercase sha-256 digest`);
	}
	for (const key of [
		"network_attempts",
		"network_timeout_seconds",
		...(browserSupported ? ["browser_network_timeout_seconds"] : []),
	]) {
		if (!(key in contract)) continue;
		const value = contract[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
			errors.push(`cloud: ${key} must be a positive integer`);
	}

	const prototools = Bun.TOML.parse(
		await Bun.file(resolve(root, ".prototools")).text(),
	) as JsonRecord;
	const protoTools = Object.entries(prototools)
		.filter(([, value]) => typeof value === "string")
		.map(([name]) => name);
	for (const tool of protoTools) {
		const expected = prototools[tool];
		const actual = scalar(contract, `tool_${tool}`);
		if (actual !== expected)
			errors.push(
				`cloud: tool ${tool} must match .prototools (expected ${String(expected)}, got ${actual ?? "missing"})`,
			);
	}
	const requiredTools = list(contract, "required_tools") ?? [];
	if (sorted(requiredTools) !== sorted(protoTools))
		errors.push("cloud: required tools must equal the Proto manifest");

	const checksums = new Map<string, string>();
	for (const line of (
		await readText(resolve(root, ".devcontainer/proto-checksums.txt"))
	).split("\n")) {
		const match = /^([0-9a-f]{64})\s+proto_cli-(.+)\.tar\.xz\s*$/.exec(line);
		if (match?.[1] && match[2]) checksums.set(match[2], match[1]);
	}
	for (const [key, target] of CHECKSUM_KEYS) {
		if (scalar(contract, key) !== checksums.get(target))
			errors.push(
				`cloud: proto checksum for ${target} must match .devcontainer/proto-checksums.txt`,
			);
	}
	if (
		sorted(list(contract, "supported_architectures") ?? []) !==
		sorted([...checksums.keys()])
	)
		errors.push(
			"cloud: supported architectures must equal the checksum manifest",
		);
	if (sorted([...checksums.keys()]) !== sorted(EXPECTED_ARCHITECTURES))
		errors.push("cloud: checksum manifest must cover both Linux architectures");

	if (graphifySupported) {
		if (
			scalar(contract, "graphify_version") !==
			dockerArgument(dockerfile, "GRAPHIFY_VERSION")
		)
			errors.push("cloud: graphify version must match the Docker authority");
		const graphifyPackage = scalar(contract, "graphify_package") ?? "";
		if (!graphifyPackage || !dockerfile.includes(`${graphifyPackage}==`))
			errors.push("cloud: graphify package must match the Docker authority");
	}

	// capability:start playwright
	if (browserSupported) {
		const browserPin = scalar(contract, "browser_playwright_version");
		if (
			browserPin !== catalog["@playwright/test"] ||
			browserPin !== dockerArgument(dockerfile, "PLAYWRIGHT_VERSION")
		)
			errors.push(
				"cloud: browser pin must equal the package catalog and Docker pins",
			);
		const markerBasename = scalar(contract, "browser_marker_basename");
		const payloadStage = stageBody(dockerfile, "playwright_browser") ?? "";
		if (markerBasename !== ".devenv-playwright-version")
			errors.push(
				"cloud: browser marker basename must equal the image payload marker",
			);
		if (!markerBasename || !payloadStage.includes(markerBasename))
			errors.push(
				"cloud: browser marker basename must appear in the image payload stage",
			);
		const installCommand = scalar(contract, "browser_install_command") ?? "";
		if (!installCommand || !payloadStage.includes(installCommand))
			errors.push(
				"cloud: browser install command must match the image payload stage",
			);
		// The Stage 3 image bakes an absolute payload root under the development
		// user's home; the cloud contract templates it so any hosted HOME works.
		// Both must describe the same marker file.
		const imageRoot =
			/^ENV PLAYWRIGHT_BROWSERS_PATH=([^\s#]+)\s*$/m.exec(dockerfile)?.[1] ??
			"";
		const contractRoot = (scalar(contract, "browser_payload_root") ?? "")
			// biome-ignore lint/suspicious/noTemplateCurlyInString: The contract stores a literal ${HOME} placeholder the cloud scripts expand without eval.
			.replace("${HOME}", "/home/vscode");
		const reference = scalar(contract, "browser_reference_marker_path");
		if (
			!markerBasename ||
			reference !== `${contractRoot}/${markerBasename}` ||
			reference !== `${imageRoot}/${markerBasename}`
		)
			errors.push(
				"cloud: browser reference marker must match the image payload root",
			);

		const evidencePath = resolve(root, STAGE_THREE_EVIDENCE);
		if (await exists(evidencePath)) {
			const handoff = recordAt(await readJson(evidencePath), "cloudHandoff");
			if (
				reference !== handoff["requiredMarkerPath"] ||
				scalar(contract, "browser_environment_variable") !==
					handoff["requiredEnvironment"] ||
				scalar(contract, "browser_required_command") !==
					handoff["requiredCommand"] ||
				scalar(contract, "browser_profile") !== handoff["requiredProfile"]
			)
				errors.push("cloud: Stage 3 browser handoff drifted");
		}
	}
	// capability:end playwright

	// One project slug derives all three persisted locations, so a rendered
	// project can never source another project's cloud environment.
	const persistedSlugs = [
		PERSISTED_ENVIRONMENT.exec(scalar(contract, "persisted_environment") ?? ""),
		PERSISTED_SECRETS.exec(
			scalar(contract, "persisted_secrets_environment") ?? "",
		),
		MARKER_DIRECTORY.exec(
			scalar(contract, "fingerprint_marker_directory") ?? "",
		),
	].map((match) => match?.[1]);
	if (
		persistedSlugs.some((slug) => slug === undefined) ||
		new Set(persistedSlugs).size !== 1
	)
		errors.push("cloud: persisted paths must be derived from one project slug");

	if (templateSource) {
		const parameters = Bun.TOML.parse(
			await Bun.file(parameterPath).text(),
		) as JsonRecord;
		const paths = recordAt(parameters, "paths");
		const toolchain = recordAt(parameters, "toolchain");
		if (
			scalar(contract, "persisted_environment") !==
			paths["cloud_persisted_environment"]
		)
			errors.push(
				"cloud: persisted environment must equal paths.cloud_persisted_environment",
			);
		if (scalar(contract, "proto_checksums") !== toolchain["proto_checksums"])
			errors.push(
				"cloud: proto checksums must equal toolchain.proto_checksums",
			);
	}

	for (const key of ["proto_installer", "proto_checksums"]) {
		const value = scalar(contract, key);
		if (!value || !(await exists(resolve(root, value))))
			errors.push(`cloud: ${key} must point at a committed file`);
	}

	const fingerprintInputs = list(contract, "fingerprint_inputs") ?? [];
	for (const input of fingerprintInputs) {
		if (!(await exists(resolve(root, input))))
			errors.push(`cloud: fingerprint input ${input} is missing`);
	}
	if (sorted(fingerprintInputs) !== sorted(EXPECTED_FINGERPRINT_INPUTS))
		errors.push("cloud: fingerprint inputs drifted");

	const secretAllowList = list(contract, "secret_allow_list") ?? [];
	for (const secret of secretAllowList) {
		if (!ENVIRONMENT_NAME.test(secret))
			errors.push(
				`cloud: secret ${secret} must be an environment variable name`,
			);
		if (DEPLOYMENT_SECRET.test(secret)) {
			errors.push(
				"cloud: secret allow-list must not carry deployment credentials",
			);
			break;
		}
	}
	if (secretAllowList.join(",") !== [...secretAllowList].sort().join(","))
		errors.push("cloud: secret allow-list must be sorted");
	if (sorted(secretAllowList) !== sorted(EXPECTED_SECRET_ALLOW_LIST))
		errors.push("cloud: secret allow-list drifted");

	const forbiddenCommands = list(contract, "forbidden_cloud_commands") ?? [];
	if (sorted(forbiddenCommands) !== sorted(EXPECTED_FORBIDDEN_COMMANDS))
		errors.push("cloud: forbidden cloud commands drifted");

	for (const script of CLOUD_SCRIPTS) {
		const path = resolve(root, script);
		if (!(await exists(path))) {
			errors.push(`cloud: ${script} is missing`);
			continue;
		}
		if (!isExecutable(path)) errors.push(`cloud: ${script} must be executable`);
		const syntax = Bun.spawnSync(["bash", "-n", path], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (syntax.exitCode !== 0)
			errors.push(`cloud: ${script} has a bash syntax error`);
		const source = await Bun.file(path).text();
		if (!source.includes("set -euo pipefail"))
			errors.push(`cloud: ${script} must fail closed with set -euo pipefail`);
		const body = stripComments(source).toLowerCase();
		for (const token of forbiddenCommands) {
			if (body.includes(token.toLowerCase()))
				errors.push(`cloud: ${script} must not invoke ${token} in cloud`);
		}
	}

	const bootstrap = await readText(resolve(root, ".codex/cloud/bootstrap.sh"));
	if (bootstrap.includes("PROTO_BYPASS_VERSION_CHECK"))
		errors.push("cloud: bootstrap must not bypass the pinned Proto version");
	// Task 5.2 requires one shared installer: bootstrap reads its path from the
	// contract rather than duplicating a cloud-only download.
	if (!stripComments(bootstrap).includes("proto_installer"))
		errors.push(
			"cloud: bootstrap must install Proto through the shared installer",
		);

	const doctorBody = stripComments(
		await readText(resolve(root, ".codex/cloud/doctor.sh")),
	);
	if (MUTATING_TOKENS.some((token) => doctorBody.includes(token)))
		errors.push("cloud: doctor must be read-only");

	const execBody = stripComments(
		await readText(resolve(root, ".codex/cloud/exec.sh")),
	);
	const execOrder = EXEC_ORDER.map((token) => execBody.indexOf(token));
	if (
		execOrder.some((index) => index < 0) ||
		execOrder.some((index, position) =>
			position === 0 ? false : index <= (execOrder[position - 1] ?? -1),
		)
	)
		errors.push("cloud: exec must verify cloud before executing");

	const smokePath = resolve(root, SMOKE_WORKFLOW);
	if (!(await exists(smokePath))) {
		errors.push(`cloud: ${SMOKE_WORKFLOW} is missing`);
	} else {
		const smoke = await Bun.file(smokePath).text();
		const triggers = yamlBlock(smoke, "on", "");
		if (
			!triggers.includes("schedule:") ||
			!triggers.includes("workflow_dispatch:")
		)
			errors.push("cloud: smoke workflow must offer scheduled and manual runs");
		const pullRequest = yamlBlock(smoke, "pull_request", "  ");
		if (!pullRequest.includes("paths:"))
			errors.push("cloud: smoke pull_request must filter by changed path");
		// Stage 7 owns base-branch policy; a base-branch filter here silently
		// disables the smoke on every non-main development branch.
		if (/^\s+branches(-ignore)?:/m.test(pullRequest))
			errors.push("cloud: smoke pull_request must not filter base branches");
		if (!smoke.includes("fail-fast: false"))
			errors.push("cloud: smoke matrix must not stop at the first failure");
		if (!/^\s+- core\s*$/m.test(smoke))
			errors.push("cloud: smoke matrix must cover the core profile");
		if (!smoke.includes("runs-on: ubuntu-latest"))
			errors.push("cloud: smoke workflow must run on a stock runner");
		if (!smoke.includes("bash .codex/cloud/bootstrap.sh"))
			errors.push("cloud: smoke workflow must run the committed bootstrap");
	}

	// Both workflows now reach Bun through a composite action, so no literal
	// version survives in either file: the only thing left to compare against the
	// cloud contract is the top-level env pin those callers relay. Matching the
	// old `bun-version: '<literal>'` form here would be vacuous by construction.
	const bunPin = scalar(contract, "tool_bun");
	for (const workflow of [CI_WORKFLOW, SMOKE_WORKFLOW]) {
		const source = await readText(resolve(root, workflow));
		if (source === "") continue;
		const pins = [
			...source.matchAll(/^\s+BUN_VERSION:\s*['"]?([^'"\s#]+)/gm),
		].flatMap((match) => (match[1] ? [match[1]] : []));
		if (pins.length === 0) {
			errors.push("cloud: workflow must pin Bun through env.BUN_VERSION");
			continue;
		}
		if (pins.some((pin) => pin !== bunPin))
			errors.push("cloud: workflow Bun pin must equal the cloud contract");
	}

	if (!ci.includes("bun run cloud:check"))
		errors.push("cloud: ci must run the hermetic contract guard");
	if (!ci.includes("bash .codex/cloud/selftest.sh"))
		errors.push("cloud: ci must run the hermetic bootstrap selftest");
	if (
		!agents.includes("CODEX_CLOUD") ||
		!agents.includes(".codex/cloud/bootstrap.sh")
	)
		errors.push("cloud: agent rules must own the cloud boundary");
	if (scripts["cloud:check"] !== "bun scripts/template/validate-cloud.ts")
		errors.push("cloud: package script must expose the dedicated cloud guard");
	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
		if (!(await exists(resolve(root, path))))
			errors.push(`cloud: ${path} is missing`);
	}

	// Anti-residue completeness is part of the contract: the ownership manifest
	// is what omits every cloud artifact from a project that disabled the
	// capability, and what proves it stayed omitted.
	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (templateSource && (await exists(ownershipPath))) {
		const ownership = await readJson(ownershipPath);
		const artifactRules = records(ownership["artifactRules"]);
		const ownershipRules = records(ownership["ownershipRules"]);
		const packageRules = records(ownership["packageRules"]);
		const signature = recordAt(
			recordAt(ownership, "capabilitySignatures"),
			"codex_cloud",
		);
		const signaturePaths = list(signature, "paths") ?? [];
		const signatureTokens = list(signature, "tokens") ?? [];
		for (const pattern of OWNED_ARTIFACTS) {
			const rule = artifactRules.find((entry) => entry["pattern"] === pattern);
			const requires = rule ? (list(rule, "requiresAll") ?? []) : [];
			if (!requires.includes("codex_cloud"))
				errors.push(
					`cloud: ${pattern} must require the codex_cloud capability`,
				);
			if (!signaturePaths.includes(pattern))
				errors.push(`cloud: capability signature must name ${pattern}`);
		}
		for (const token of SIGNATURE_TOKENS) {
			if (!signatureTokens.includes(token))
				errors.push(`cloud: capability signature must name ${token}`);
		}
		const packageRule = packageRules.find(
			(entry) => entry["capability"] === "codex_cloud",
		);
		if (
			!(packageRule ? (list(packageRule, "scripts") ?? []) : []).includes(
				"cloud:check",
			)
		)
			errors.push("cloud: package rules must strip cloud:check when disabled");
		const catchAll = ownershipRules.findIndex(
			(entry) => entry["pattern"] === "scripts/template/**",
		);
		for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
			const index = ownershipRules.findIndex(
				(entry) => entry["pattern"] === path,
			);
			if (
				index < 0 ||
				(catchAll >= 0 && index > catchAll) ||
				ownershipRules[index]?.["renderPolicy"] !== "copy"
			)
				errors.push(`cloud: ownership rules must render ${path} downstream`);
		}
	}

	return errors;
}
