// biome-ignore-all lint/complexity/useLiteralKeys: Contract records use dynamic keys.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The guard matches literal ${localEnv:} and ${devcontainerId} substitutions the container CLI expands.
import { statSync } from "node:fs";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const CONTRACT_PATH = "scripts/worktree/contract.toml";
const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const FINGERPRINT_AUTHORITY = ".devcontainer/devcontainer-fingerprint.sh";
const PARAMETER_PATH = "template-parameters.toml";
const CLOUD_CONTRACT = ".codex/cloud/contract.toml";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SYNC_SCRIPT = "scripts/sync-devcontainer.sh";
const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const GUARD_CONTRACT = "scripts/template/worktree-contract.ts";
const GUARD_ENTRYPOINT = "scripts/template/validate-worktree.ts";
const AGENT_RULES = "AGENTS.md";
const HOST_ONBOARDING = "init-host.sh";
const README = "README.md";
const README_TEMPLATE = "README.template.md";

// The two hooks the cutover routes. Both are optional on disk — a downstream
// project may not use Husky at all — but any hook that ships has to route.
const GIT_HOOKS = [".husky/commit-msg", ".husky/pre-commit"] as const;

// The launcher this stage supersedes. The scan below is the non-vacuous half of
// the cutover: documentation can claim anything, but a tracked file still naming
// the old entry point is a fact.
const LEGACY_LAUNCHER = "devpod";

// Paths whose mention of the superseded launcher is a record, not a route.
// Sealed evidence and its validators describe runs that really did use it and
// must never be "cleaned up"; the cloud contract forbids it by name; this guard
// carries the literal token in order to look for it; graphify-out is derived
// output regenerated from whatever the tree currently says.
const LEGACY_ALLOW_LIST = [
	"CHANGES.md",
	"evidence/",
	"docs/devcontainer-upgrade/",
	"openspec/",
	"graphify-out/",
	"scripts/template/evidence.ts",
	"scripts/template/toolchain-evidence.ts",
	"scripts/template/cloud-contract.ts",
	GUARD_CONTRACT,
	CLOUD_CONTRACT,
] as const;

// The complete fixed key set, in the order the generator emits it. Anything
// missing means a runtime script reads a value nobody writes; anything extra
// means a value nobody reads, which is drift wearing a contract's clothes.
const BASE_KEYS = [
	"version",
	"project_slug",
	"environment_prefix",
	"docker_resource_prefix",
	"local_domain_stem",
	"development_user",
	"container_workspace",
	"generated_state",
	"mutable_persistence",
	"shared_cache",
	"host_config_root",
	"registry_directory",
	"manifest_directory",
	"caddy_snippet_directory",
	"generated_environment",
	"generated_container_environment",
	"run_directory",
	"devcontainer_config",
	"published_container_port",
	"published_host_port_variable",
	"preferred_offset_modulus",
	"collision_scan_limit",
	"manifest_schema_version",
	"registry_schema_version",
	"default_probe_timeout_seconds",
	"startup_timeout_seconds",
	"diagnostic_staggered_mode",
	"friendly_domain_pattern",
	"direct_host",
	"host_caddy",
	"always_publish_direct_url",
	"container_engine",
	"container_cli",
	"container_cli_package",
	"definition_fingerprint_inputs",
	"legacy_cleanup_commands",
	"runtime_scripts",
	"bridge_command",
	"ensure_command",
	"services",
] as const;

// Cloud keys live behind the codex_cloud fence, so they are required in a tree
// that ships the capability and forbidden in one that does not.
const CLOUD_KEYS = ["cloud_doctor_command", "cloud_marker_variable"] as const;

const SERVICE_KEYS = [
	"kind",
	"base_port",
	"depends_on",
	"directory",
	"command",
	"health_path",
	"health_expectation",
	"profiles",
] as const;

const PORT_KEYS = ["published_container_port"] as const;

const POSITIVE_INTEGER_KEYS = [
	"preferred_offset_modulus",
	"collision_scan_limit",
	"manifest_schema_version",
	"registry_schema_version",
	"default_probe_timeout_seconds",
	"startup_timeout_seconds",
] as const;

// The persistence root reaches a script through the contract and the generated
// environment. These are the only places its literal value may appear: the
// authority that defines it, the generated artifact, the reader that resolves
// it, and the destructive path that must re-derive it.
const PERSISTENCE_ALLOW_LIST = [
	PARAMETER_PATH,
	CONTRACT_PATH,
	"scripts/worktree/lib.sh",
	"scripts/worktree/env.sh",
	"scripts/worktree/cleanup.sh",
	"scripts/template/render-fixture.ts",
	GUARD_CONTRACT,
] as const;

const EXTRA_PERSISTENCE_SCAN = [
	DEVCONTAINER_PATH,
	"package.json",
	CI_WORKFLOW,
	AGENT_RULES,
] as const;

const OWNED_ARTIFACTS = [
	"scripts/worktree/**",
	GUARD_CONTRACT,
	GUARD_ENTRYPOINT,
] as const;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function scalar(record: JsonRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function list(record: JsonRecord, key: string): string[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string")
		? (value as string[])
		: undefined;
}

function sorted(values: readonly string[]): string {
	return [...values].sort().join(",");
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

async function readText(path: string): Promise<string> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : "";
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	return isRecord(value) ? value : {};
}

// Bash comments describe the boundary; only executable lines can cross it.
function stripComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

function isExecutable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function volumePrefixes(configuration: string): string[] {
	const found: string[] = [];
	for (const match of configuration.matchAll(
		/source=([A-Za-z0-9][A-Za-z0-9_.-]*)-\$\{devcontainerId\}/g,
	)) {
		const prefix = match[1];
		if (prefix && !found.includes(prefix)) found.push(prefix);
	}
	return found;
}

// The documented degradation path: a project rendered without the devcontainer
// capability ships no scripts/worktree at all, so the hooks decide at run time
// with a file test. Only the lines inside that `else` may call project tooling
// directly.
function hookFallbackLines(hook: string, bridgePath: string): string[] {
	const lines = hook.split("\n");
	const guarded = lines.findIndex((line) =>
		line.includes(`[ -x ${bridgePath} ]`),
	);
	if (guarded < 0) return [];
	const otherwise = lines.findIndex(
		(line, index) => index > guarded && line.trim() === "else",
	);
	if (otherwise < 0) return [];
	const closed = lines.findIndex(
		(line, index) => index > otherwise && line.trim() === "fi",
	);
	if (closed < 0) return [];
	return lines.slice(otherwise + 1, closed);
}

function callsProjectTooling(line: string): boolean {
	return /(?:^|\s)bunx?\s/.test(line);
}

function isLegacyAllowListed(path: string): boolean {
	return (LEGACY_ALLOW_LIST as readonly string[]).some((entry) =>
		entry.endsWith("/") ? path.startsWith(entry) : path === entry,
	);
}

// Tracked files only, and read through Git rather than a directory walk so the
// scan sees exactly what a clone would receive. `undefined` means the tree is
// not a repository — a rendered fixture before `git init` — and the scan
// abstains rather than reporting a clean result it never established.
function legacyLauncherFiles(root: string): string[] | undefined {
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"grep",
			"--files-with-matches",
			"--ignore-case",
			"--fixed-strings",
			"-I",
			LEGACY_LAUNCHER,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode === 1) return [];
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\n").filter(Boolean);
}

// The image owns the fingerprint. Reading its inputs out of the authority means
// a change there cannot silently leave the host implementation hashing a
// different tree than the container start check does.
function authorityFingerprintInputs(source: string): string[] {
	const inputs: string[] = [];
	for (const match of source.matchAll(/await (?:record|walk)\("([^"]+)"\)/g)) {
		if (match[1]) inputs.push(match[1]);
	}
	return inputs;
}

export async function validateWorktreeContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const contractPath = resolve(root, CONTRACT_PATH);
	const packageJson = await readJson(resolve(root, "package.json"));
	const scripts = isRecord(packageJson["scripts"])
		? packageJson["scripts"]
		: {};

	// The runtime is gated on the devcontainer capability. A project rendered
	// without it must carry no half of the runtime at all.
	if (!(await exists(contractPath))) {
		for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
			if (await exists(resolve(root, path)))
				errors.push(`worktree: disabled capability leaves ${path}`);
		}
		if (scripts["worktree:check"] !== undefined)
			errors.push("worktree: disabled capability leaves package scripts");
		return errors;
	}

	let contract: JsonRecord;
	try {
		contract = Bun.TOML.parse(
			await Bun.file(contractPath).text(),
		) as JsonRecord;
	} catch {
		errors.push("worktree: contract must parse as TOML");
		return errors;
	}

	const cloudSupported = await exists(resolve(root, CLOUD_CONTRACT));
	const services = list(contract, "services") ?? [];
	const expectedKeys = new Set<string>([
		...BASE_KEYS,
		...(cloudSupported ? CLOUD_KEYS : []),
	]);
	for (const service of services) {
		for (const key of SERVICE_KEYS)
			expectedKeys.add(`service_${service}_${key}`);
	}
	// The capability key is optional per service, so it is accepted but never
	// required.
	const optionalKeys = new Set<string>(
		services.map((service) => `service_${service}_capability`),
	);
	for (const key of expectedKeys) {
		if (!(key in contract))
			errors.push(`worktree: contract key ${key} is missing`);
	}
	for (const key of Object.keys(contract)) {
		if (!expectedKeys.has(key) && !optionalKeys.has(key))
			errors.push(`worktree: contract key ${key} is unknown`);
	}
	if (!cloudSupported) {
		for (const key of CLOUD_KEYS) {
			if (key in contract)
				errors.push(`worktree: contract key ${key} is unknown`);
		}
	}

	if (contract["version"] !== 1)
		errors.push("worktree: contract version must be 1");
	for (const key of PORT_KEYS) {
		const value = contract[key];
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			value < 1024 ||
			value > 65535
		)
			errors.push(`worktree: ${key} must be between 1024 and 65535`);
	}
	for (const key of POSITIVE_INTEGER_KEYS) {
		const value = contract[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
			errors.push(`worktree: ${key} must be a positive integer`);
	}
	// Loopback only. A published port on 0.0.0.0 puts every worktree's stack on
	// the local network, which is a security change disguised as a typo.
	if (scalar(contract, "direct_host") !== "127.0.0.1")
		errors.push("worktree: direct_host must be 127.0.0.1");
	const friendlyPattern = scalar(contract, "friendly_domain_pattern") ?? "";
	for (const placeholder of ["{workspace}", "{project}"]) {
		if (!friendlyPattern.includes(placeholder))
			errors.push(
				`worktree: friendly_domain_pattern must contain ${placeholder}`,
			);
	}
	// .localhost resolves to loopback with no hosts file edit and is a secure
	// context in Chromium, which is why it is the convention rather than a
	// invented TLD needing manual DNS.
	if (!friendlyPattern.endsWith(".localhost"))
		errors.push("worktree: friendly_domain_pattern must end with .localhost");

	const parameterPath = resolve(root, PARAMETER_PATH);
	if (await exists(parameterPath)) {
		try {
			// Imported here and nowhere else: a rendered project ships this guard
			// without the template's own generator, so a top-level import would make
			// the downstream `worktree:check` fail to load rather than run.
			const { loadTemplateParameters } = await import("./parameters");
			const { renderWorktreeContract } = await import("./render-fixture");
			const parameters = await loadTemplateParameters(root);
			const regenerated = renderWorktreeContract(parameters);
			if ((await Bun.file(contractPath).text()) !== regenerated)
				errors.push("worktree: contract drifted from template-parameters.toml");
		} catch (error) {
			errors.push(
				`worktree: contract could not be regenerated (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	const environmentPrefix = scalar(contract, "environment_prefix") ?? "";
	const containerPort = contract["published_container_port"];
	const configurationPath = resolve(root, DEVCONTAINER_PATH);
	const configuration = await readText(configurationPath);
	if (configuration === "") {
		errors.push(`worktree: ${DEVCONTAINER_PATH} is missing`);
	} else {
		const publish = `127.0.0.1:\${localEnv:${environmentPrefix}_PUBLISHED_HOST_PORT}:${String(containerPort)}`;
		if (!configuration.includes(publish))
			errors.push(
				`worktree: devcontainer.json must publish ${String(containerPort)} on 127.0.0.1`,
			);
		const definition = await readJson(configurationPath);
		if (
			scalar(definition, "remoteUser") !== scalar(contract, "development_user")
		)
			errors.push(
				"worktree: development_user must equal devcontainer.json remoteUser",
			);
		const containerEnv = isRecord(definition["containerEnv"])
			? definition["containerEnv"]
			: {};
		const seam = `${scalar(contract, "container_workspace") ?? ""}/${scalar(contract, "generated_container_environment") ?? ""}`;
		if (containerEnv["DEVCONTAINER_WORKTREE_ENV_FILE"] !== seam)
			errors.push(
				`worktree: devcontainer.json must point DEVCONTAINER_WORKTREE_ENV_FILE at ${seam}`,
			);
		// The host secret delivery entry predates this runtime and is never gated,
		// renamed, or folded into it.
		const initialize = isRecord(definition["initializeCommand"])
			? definition["initializeCommand"]
			: {};
		if (!("prepare-container-env" in initialize))
			errors.push(
				"worktree: devcontainer.json must keep the prepare-container-env initializeCommand",
			);
		if (
			configuration.includes("${devcontainerId}") &&
			volumePrefixes(configuration).length === 0
		)
			errors.push(
				"worktree: devcontainer.json must key its per-worktree volumes on ${devcontainerId}",
			);
	}

	const authority = await readText(resolve(root, FINGERPRINT_AUTHORITY));
	if (authority !== "") {
		const declared = list(contract, "definition_fingerprint_inputs") ?? [];
		if (sorted(declared) !== sorted(authorityFingerprintInputs(authority)))
			errors.push(
				"worktree: definition fingerprint inputs drifted from the image authority",
			);
	}

	const runtimeScripts = list(contract, "runtime_scripts") ?? [];
	if (runtimeScripts.length === 0)
		errors.push("worktree: runtime_scripts must name the runtime");
	const engine = scalar(contract, "container_engine") ?? "docker";
	// Every one of these reaches beyond this checkout. A sibling worktree is
	// alive and is not this script's to reap.
	const forbiddenSweeps = [
		"git worktree prune",
		`${engine} system prune`,
		`${engine} volume prune`,
		`${engine} image prune`,
		`${engine} container prune`,
	];
	const sources = new Map<string, string>();
	for (const script of runtimeScripts) {
		const path = resolve(root, script);
		if (!(await exists(path))) {
			errors.push(`worktree: ${script} is missing`);
			continue;
		}
		if (!isExecutable(path))
			errors.push(`worktree: ${script} must be executable`);
		const syntax = Bun.spawnSync(["bash", "-n", path], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (syntax.exitCode !== 0)
			errors.push(`worktree: ${script} has a bash syntax error`);
		const source = await Bun.file(path).text();
		sources.set(script, source);
		if (!source.includes("set -euo pipefail"))
			errors.push(
				`worktree: ${script} must fail closed with set -euo pipefail`,
			);
		const body = stripComments(source);
		for (const sweep of forbiddenSweeps) {
			if (body.includes(sweep))
				errors.push(`worktree: ${script} must not run an unscoped prune`);
		}
		if (/\brm\s+-rf\s+\/(?:\s|$)/.test(body))
			errors.push(`worktree: ${script} must not remove an absolute root`);
	}

	const environmentScript = sources.get("scripts/worktree/env.sh") ?? "";
	const allocation =
		/allocate_offset\(\)\s*\{[\s\S]*?\n\}/.exec(environmentScript)?.[0] ?? "";
	if (
		!environmentScript.includes('"${DEVCONTAINER:-}" = "true"') ||
		!allocation.includes("in_container")
	)
		errors.push(
			"worktree: allocation must refuse to write the registry inside a container",
		);

	const ensureScript = sources.get("scripts/worktree/ensure.sh") ?? "";
	if (
		!ensureScript.includes("devcontainer.local_folder") ||
		!ensureScript.includes("devcontainer.config_file") ||
		!ensureScript.includes("label=${LOCAL_FOLDER_LABEL}=") ||
		!ensureScript.includes("label=${CONFIG_FILE_LABEL}=")
	)
		errors.push(
			"worktree: ensure must own containers by checkout and config path",
		);
	if (!ensureScript.includes("--remove-existing-container"))
		errors.push(
			"worktree: ensure must recreate a container whose definition changed",
		);

	// Dispatch order is the safety property: a cloud task must never try to start
	// a container engine, and a process already inside the container must never
	// re-enter it.
	const bridgeScript = stripComments(
		sources.get("scripts/worktree/exec.sh") ?? "",
	);
	const bridgeOrder = [
		// capability:start codex_cloud
		...(cloudSupported ? ['"${CODEX_CLOUD:-}" = "true"'] : []),
		// capability:end codex_cloud
		'"${DEVCONTAINER:-}" = "true"',
		'exec "$CONTAINER_ENGINE"',
	].map((token) => bridgeScript.indexOf(token));
	if (
		bridgeOrder.some((index) => index < 0) ||
		bridgeOrder.some((index, position) =>
			position === 0 ? false : index <= (bridgeOrder[position - 1] ?? -1),
		)
	)
		errors.push(
			"worktree: bridge must dispatch cloud and container paths before host orchestration",
		);
	if (
		!bridgeScript.includes(".devcontainer/environment.sh") ||
		!bridgeScript.includes("devcontainer_environment_activate_proto")
	)
		errors.push(
			"worktree: bridge must execute through the canonical container environment",
		);

	// The hooks' mode. It has to be answered ahead of the unsupported-argument
	// arm, or a hook falls through to the reconciling path and a commit silently
	// becomes a container build. The refusal exits 7 and says what to run.
	const readyOnlyArm = bridgeScript.indexOf("--require-ready)");
	const unsupportedArm = bridgeScript.indexOf("-*)");
	if (
		readyOnlyArm < 0 ||
		unsupportedArm < 0 ||
		readyOnlyArm > unsupportedArm ||
		!/wt_die\s+"[^"]*not ready[^"]*"\s+7\b/.test(bridgeScript)
	)
		errors.push("worktree: bridge must expose a ready-only mode for hooks");

	const declaredPrefixes = volumePrefixes(configuration);
	const persistence = scalar(contract, "mutable_persistence") ?? "";
	for (const [script, source] of sources) {
		for (const prefix of declaredPrefixes) {
			if (source.includes(prefix))
				errors.push(
					`worktree: ${script} must derive volume names from devcontainer.json, not hardcode ${prefix}`,
				);
		}
	}
	if (persistence !== "") {
		const scanned = [...runtimeScripts, ...EXTRA_PERSISTENCE_SCAN];
		for (const path of scanned) {
			if ((PERSISTENCE_ALLOW_LIST as readonly string[]).includes(path))
				continue;
			const source = sources.get(path) ?? (await readText(resolve(root, path)));
			if (source.includes(persistence))
				errors.push(
					`worktree: ${path} bypasses the generated persistence root`,
				);
		}
	}

	// Downstream sync excludes every scripts/* path by default. Without the
	// explicit include the runtime's declared merge policy is a lie.
	const sync = await readText(resolve(root, SYNC_SCRIPT));
	if (sync !== "" && !sync.includes("scripts/worktree/*)"))
		errors.push("worktree: template ownership must cover the runtime");

	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (await exists(ownershipPath)) {
		const ownership = await readJson(ownershipPath);
		const ownershipRules = records(ownership["ownershipRules"]);
		const artifactRules = records(ownership["artifactRules"]);
		const catchAll = ownershipRules.findIndex(
			(entry) => entry["pattern"] === "scripts/template/**",
		);
		for (const pattern of OWNED_ARTIFACTS) {
			const index = ownershipRules.findIndex(
				(entry) => entry["pattern"] === pattern,
			);
			if (
				index < 0 ||
				(catchAll >= 0 && index > catchAll) ||
				ownershipRules[index]?.["renderPolicy"] !== "copy"
			)
				errors.push("worktree: template ownership must cover the runtime");
			const artifact = artifactRules.find(
				(entry) => entry["pattern"] === pattern,
			);
			const requires = artifact ? (list(artifact, "requiresAll") ?? []) : [];
			if (!requires.includes("devcontainer"))
				errors.push(
					`worktree: ${pattern} must require the devcontainer capability`,
				);
		}
	}

	if (scripts["worktree:check"] !== "bun scripts/template/validate-worktree.ts")
		errors.push("worktree: package script must expose the dedicated guard");
	const ci = await readText(resolve(root, CI_WORKFLOW));
	if (ci !== "") {
		if (!ci.includes("bun run worktree:check"))
			errors.push("worktree: ci must run the hermetic contract guard");
		if (!ci.includes("bash scripts/worktree/selftest.sh"))
			errors.push("worktree: ci must run the hermetic runtime selftest");
	}
	const agents = await readText(resolve(root, AGENT_RULES));
	if (agents !== "" && !agents.includes("scripts/worktree/exec.sh"))
		errors.push("worktree: agent rules must own the command boundary");
	// The soak is over. Rules that still present the runtime as an addition to a
	// surviving legacy entry point describe a repository that no longer exists.
	if (
		agents !== "" &&
		(/runtime is additive|during the soak/i.test(agents) ||
			!agents.includes("--require-ready"))
	)
		errors.push(
			"worktree: agent rules must describe the cutover, not the soak",
		);

	// Hook routing. Both hooks are optional on disk; any that ships must reach
	// project tooling through the bridge, in ready-only mode, with the only
	// direct invocations sitting inside the documented fallback branch.
	const bridgeCommand = scalar(contract, "bridge_command") ?? "";
	const bridgePath = bridgeCommand.split(" ").pop() ?? "";
	for (const hookPath of GIT_HOOKS) {
		const hook = stripComments(await readText(resolve(root, hookPath)));
		if (hook.trim() === "") continue;
		if (!hook.includes(bridgeCommand)) {
			errors.push(
				"worktree: git hooks must run project tooling through the bridge",
			);
			continue;
		}
		if (!hook.includes(`${bridgeCommand} --require-ready`))
			errors.push("worktree: git hooks must not start a container");
		const fallback = hookFallbackLines(hook, bridgePath);
		for (const line of hook.split("\n")) {
			if (!callsProjectTooling(line)) continue;
			if (line.includes(bridgeCommand) || fallback.includes(line)) continue;
			errors.push(
				"worktree: git hooks must run project tooling through the bridge",
			);
		}
	}

	// Onboarding cutover. The host script installs the CLI this runtime is
	// written against and nothing else, and the onboarding document a generated
	// project actually receives names the bridge.
	const containerCli = scalar(contract, "container_cli") ?? "";
	const containerCliPackage = scalar(contract, "container_cli_package") ?? "";
	const onboarding = await readText(resolve(root, HOST_ONBOARDING));
	if (onboarding !== "") {
		if (new RegExp(LEGACY_LAUNCHER, "i").test(onboarding))
			errors.push(
				`worktree: ${HOST_ONBOARDING} still installs the superseded launcher`,
			);
		const executable = stripComments(onboarding);
		if (
			!executable.includes(`brew install ${containerCli}`) &&
			!executable.includes(`install --global ${containerCliPackage}`)
		)
			errors.push("worktree: onboarding must install the container CLI");
	}
	// A generated project receives README.md rendered from README.template.md, so
	// the template is the authority wherever it still exists.
	const onboardingReadme = (await exists(resolve(root, README_TEMPLATE)))
		? README_TEMPLATE
		: README;
	const readme = await readText(resolve(root, onboardingReadme));
	if (readme !== "" && !readme.includes(bridgeCommand))
		errors.push(
			"worktree: onboarding must document the bridge as the entry point",
		);

	// The non-vacuous proof: no tracked file outside the record allow-list still
	// names the superseded launcher.
	const legacy = legacyLauncherFiles(root);
	if (legacy !== undefined) {
		for (const path of legacy) {
			if (isLegacyAllowListed(path)) continue;
			errors.push(
				`worktree: ${path} still routes onboarding through the superseded launcher`,
			);
		}
	}

	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
		if (!(await exists(resolve(root, path))))
			errors.push(`worktree: ${path} is missing`);
	}

	return errors;
}
