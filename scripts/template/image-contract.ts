// biome-ignore-all lint/complexity/useLiteralKeys: Contract records use dynamic keys.
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	if (!isRecord(value)) throw new Error(`${path} must contain an object`);
	return value;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonical(entry)]),
	);
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function manifestEntries(value: JsonRecord): {
	tools: JsonRecord;
	plugins: JsonRecord;
} {
	return {
		tools: Object.fromEntries(
			Object.entries(value).filter(
				([name, version]) =>
					name !== "plugins" &&
					name !== "settings" &&
					typeof version === "string",
			),
		),
		plugins: recordAt(value, "plugins"),
	};
}

function mergedPartitions(
	foundation: JsonRecord,
	auxiliary: JsonRecord,
	errors: string[],
): { tools: JsonRecord; plugins: JsonRecord } {
	const left = manifestEntries(foundation);
	const right = manifestEntries(auxiliary);
	for (const kind of ["tools", "plugins"] as const) {
		for (const name of Object.keys(left[kind])) {
			if (Object.hasOwn(right[kind], name))
				errors.push(`image: Proto partition duplicates ${kind}.${name}`);
		}
	}
	return {
		tools: { ...left.tools, ...right.tools },
		plugins: { ...left.plugins, ...right.plugins },
	};
}

interface DockerStage {
	base: string;
	name: string;
}

function dockerStages(source: string): DockerStage[] {
	return source.split("\n").flatMap((line) => {
		const match = /^FROM\s+([^\s]+)\s+AS\s+([a-z0-9_]+)\s*$/i.exec(line.trim());
		return match?.[1] && match[2]
			? [{ base: match[1], name: match[2].toLowerCase() }]
			: [];
	});
}

function argValues(source: string): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (const match of source.matchAll(/^ARG\s+([A-Z0-9_]+)=([^\s#]+)\s*$/gm)) {
		if (!match[1] || !match[2]) continue;
		values.set(match[1], [...(values.get(match[1]) ?? []), match[2]]);
	}
	return values;
}

export function selectArchitectureChecksums(
	dockerfile: string,
	architecture: "amd64" | "arm64",
): Record<string, string> {
	const values = argValues(dockerfile);
	const suffix = architecture.toUpperCase();
	return Object.fromEntries(
		["DELTA", "RTK", "CLAUDE"].map((owner) => [
			owner.toLowerCase(),
			values.get(`${owner}_SHA256_${suffix}`)?.[0] ?? "",
		]),
	);
}

function stageMap(stages: DockerStage[]): Map<string, string> {
	return new Map(stages.map(({ name, base }) => [name, base]));
}

function requireStage(
	stages: Map<string, string>,
	name: string,
	base: string | RegExp,
	errors: string[],
): void {
	const actual = stages.get(name);
	if (actual === undefined) {
		errors.push(`image: Docker stage ${name} is missing`);
		return;
	}
	if (
		(typeof base === "string" && actual !== base) ||
		(base instanceof RegExp && !base.test(actual))
	)
		errors.push(`image: Docker stage ${name} has unexpected base ${actual}`);
}

function sourceHasInstallMutation(source: string): boolean {
	return /(?:\bbun\s+(?:add|install|remove)\s+-g\b|\bnpm\s+install\s+-g\b|\buv\s+tool\s+install\b|install-proto\.sh|\bproto\s+(?:install|use)\b|curl[^\n]*install\.sh|git\s+clone)/.test(
		source,
	);
}

export async function validateImageContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const rootManifest = Bun.TOML.parse(
		await Bun.file(resolve(root, ".prototools")).text(),
	) as JsonRecord;
	const foundation = Bun.TOML.parse(
		await Bun.file(resolve(root, ".devcontainer/prototools.foundation")).text(),
	) as JsonRecord;
	const auxiliary = Bun.TOML.parse(
		await Bun.file(resolve(root, ".devcontainer/prototools.auxiliary")).text(),
	) as JsonRecord;
	const rootEntries = manifestEntries(rootManifest);
	const union = mergedPartitions(foundation, auxiliary, errors);
	if (!same(union.tools, rootEntries.tools))
		errors.push("image: Proto partition tool union differs from .prototools");
	if (!same(union.plugins, rootEntries.plugins))
		errors.push("image: Proto partition plugin union differs from .prototools");
	for (const kind of ["tools", "plugins"] as const) {
		for (const [name, value] of Object.entries(union[kind])) {
			if (value !== rootEntries[kind][name])
				errors.push(`image: Proto partition value drifted for ${kind}.${name}`);
		}
	}
	if (
		Object.hasOwn(foundation, "settings") ||
		Object.hasOwn(auxiliary, "settings")
	)
		errors.push("image: derived Proto partitions must not own root settings");

	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const syntax =
		/^# syntax=docker\/dockerfile:[^@\s]+@(sha256:[0-9a-f]{64})$/m.exec(
			dockerfile,
		)?.[1];
	if (!syntax || !DIGEST.test(syntax))
		errors.push("image: Dockerfile frontend must be digest-pinned");
	const parsedStages = dockerStages(dockerfile);
	const stages = stageMap(parsedStages);
	if (parsedStages.length !== stages.size)
		errors.push("image: Docker stage names must be unique");
	requireStage(
		stages,
		"stable_base",
		/^mcr\.microsoft\.com\/.+@sha256:[0-9a-f]{64}$/,
		errors,
	);
	requireStage(stages, "proto_foundation", "stable_base", errors);
	requireStage(stages, "proto_auxiliary", "proto_foundation", errors);
	requireStage(stages, "shell_payload", "stable_base", errors);
	requireStage(stages, "development", "proto_auxiliary", errors);

	const optionalStages: Array<[string, string, string]> = [
		["graphify", "graphify_payload", "proto_foundation"],
		["codex", "codex_payload", "proto_foundation"],
		["gemini", "gemini_payload", "proto_foundation"],
		["ccstatusline", "ccstatusline_payload", "proto_foundation"],
		["claude", "claude_payload", "proto_foundation"],
	];
	for (const [capability, stage, base] of optionalStages) {
		if (
			await Bun.file(
				resolve(root, `.devcontainer/on-create/setup-${capability}.sh`),
			).exists()
		)
			requireStage(stages, stage, base, errors);
	}
	const packageJson = await readJson(resolve(root, "package.json"));
	const catalog = recordAt(recordAt(packageJson, "workspaces"), "catalog");
	let expectedTarget = "development";
	// capability:start playwright
	const playwrightSupported = catalog["@playwright/test"] !== undefined;
	const parameterPath = resolve(root, "template-parameters.toml");
	const isTemplateSource = await Bun.file(parameterPath).exists();
	const playwrightSelected = isTemplateSource
		? recordAt(
				recordAt(
					Bun.TOML.parse(await Bun.file(parameterPath).text()) as JsonRecord,
					"capabilities",
				),
				"defaults",
			)["playwright"] === true
		: playwrightSupported;
	if (playwrightSupported) {
		requireStage(stages, "playwright_browser", "proto_foundation", errors);
		requireStage(stages, "development_browser", "development", errors);
		const playwrightArg = argValues(dockerfile).get("PLAYWRIGHT_VERSION")?.[0];
		if (playwrightArg !== catalog["@playwright/test"])
			errors.push(
				"image: Playwright Docker pin differs from the package catalog",
			);
	} else if (
		stages.has("playwright_browser") ||
		stages.has("development_browser") ||
		dockerfile.toLowerCase().includes("playwright")
	)
		errors.push("image: disabled Playwright capability leaves Docker residue");
	expectedTarget = playwrightSelected ? "development_browser" : "development";
	// capability:end playwright

	const args = argValues(dockerfile);
	for (const owner of [
		"DELTA",
		"RTK",
		"GRAPHIFY",
		// capability:start playwright
		"PLAYWRIGHT",
		// capability:end playwright
		"CODEX",
		"GEMINI",
		"CCSTATUSLINE",
		"CLAUDE",
		"NODE_GYP",
	] as const) {
		const values = args.get(`${owner}_VERSION`) ?? [];
		if (values.length > 1)
			errors.push(`image: ${owner}_VERSION has multiple Docker authorities`);
		if (values.length === 1 && !EXACT_VERSION.test(values[0] ?? ""))
			errors.push(`image: ${owner}_VERSION must be exact`);
	}
	const zinitCommits = args.get("ZINIT_COMMIT") ?? [];
	if (
		zinitCommits.length !== 1 ||
		!/^[0-9a-f]{40}$/.test(zinitCommits[0] ?? "")
	)
		errors.push("image: ZINIT_COMMIT must have one immutable authority");
	for (const architecture of ["amd64", "arm64"] as const) {
		const selected = selectArchitectureChecksums(dockerfile, architecture);
		for (const [owner, checksum] of Object.entries(selected)) {
			if (!SHA256.test(checksum))
				errors.push(
					`image: ${owner} ${architecture} checksum is missing or malformed`,
				);
		}
	}
	const zinitChecksum = args.get("ZINIT_SHA256") ?? [];
	if (zinitChecksum.length !== 1 || !SHA256.test(zinitChecksum[0] ?? ""))
		errors.push("image: Zinit checksum must have one exact authority");
	if (/releases\/latest|:\s*latest\b|\bgit\s+clone\b/i.test(dockerfile))
		errors.push("image: Dockerfile contains a mutable download source");
	if (!dockerfile.includes("/etc/profile.d/devenv-path.sh"))
		errors.push("image: login shells omit the image-owned tool PATH");
	for (const install of [
		"/usr/local/share/devenv-image/devcontainer-fingerprint.sh",
		"/usr/local/share/devenv-image/setup-proto.sh",
	])
		if (!dockerfile.includes(install))
			errors.push(`image: Dockerfile omits image-owned verifier ${install}`);
	for (const owner of ["DELTA", "RTK", "CLAUDE", "ZINIT"] as const) {
		if (!dockerfile.includes(`$${owner}_SHA256`))
			errors.push(`image: ${owner} download does not select a checksum`);
	}

	const renovate = await readJson(resolve(root, "renovate.json"));
	const managers = renovate["customManagers"];
	if (!Array.isArray(managers) || managers.length !== 2)
		errors.push("image: Renovate image pin managers must be isolated");
	const packageRules = renovate["packageRules"];
	if (
		!Array.isArray(packageRules) ||
		!JSON.stringify(packageRules).includes('"automerge":false')
	)
		errors.push("image: Renovate image updates must disable automerge");

	const devcontainer = await readJson(
		resolve(root, ".devcontainer/devcontainer.json"),
	);
	const build = recordAt(devcontainer, "build");
	if (build["context"] !== "..")
		errors.push(
			"image: devcontainer build context must include the repository root",
		);
	if (build["target"] !== expectedTarget)
		errors.push(
			`image: devcontainer build target must be ${expectedTarget} for this capability set`,
		);
	const features = recordAt(devcontainer, "features");
	if (
		!same(Object.keys(features), [
			"ghcr.io/devcontainers/features/github-cli:1",
		])
	)
		errors.push("image: only the digest-locked GitHub CLI feature is retained");
	const mounts = Array.isArray(devcontainer["mounts"])
		? devcontainer["mounts"]
		: [];
	if (mounts.some((mount) => String(mount).includes(".proto")))
		errors.push("image: active devcontainer must not mount Proto storage");
	const lifecyclePrefix = [
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
	];
	const imageVerifier =
		"/usr/bin/env -i HOME=/home/vscode PATH=/usr/bin:/bin /bin/bash -p /usr/local/share/devenv-image/setup-proto.sh";
	for (const lifecycle of [
		"onCreateCommand",
		"postCreateCommand",
		"postStartCommand",
	]) {
		const command = devcontainer[lifecycle];
		if (
			!Array.isArray(command) ||
			!same(command.slice(0, lifecyclePrefix.length), lifecyclePrefix)
		)
			errors.push(
				`image: ${lifecycle} must scrub shell startup code before privileged Bash`,
			);
		const body = Array.isArray(command)
			? command[lifecyclePrefix.length]
			: undefined;
		const commandLength = Array.isArray(command) ? command.length : -1;
		if (
			typeof body !== "string" ||
			commandLength !== lifecyclePrefix.length + 1 ||
			!body.startsWith(`${imageVerifier} && `)
		)
			errors.push(
				`image: ${lifecycle} must run the image-owned verifier before checkout code`,
			);
	}
	if (!JSON.stringify(devcontainer["postStartCommand"]).includes("/bin/bash"))
		errors.push("image: postStartCommand inner shell must use absolute Bash");
	const featureLock = recordAt(
		await readJson(resolve(root, ".devcontainer/devcontainer-lock.json")),
		"features",
	);
	if (!same(Object.keys(featureLock), Object.keys(features)))
		errors.push("image: feature lock set differs from devcontainer features");

	const dockerignore = await Bun.file(resolve(root, ".dockerignore")).text();
	for (const line of [
		"**",
		"!.dockerignore",
		"!.prototools",
		"!.devcontainer/",
		"!.devcontainer/**",
	]) {
		if (!dockerignore.split("\n").includes(line))
			errors.push(`image: .dockerignore omits required rule ${line}`);
	}
	const setupProto = await Bun.file(
		resolve(root, ".devcontainer/on-create/setup-proto.sh"),
	).text();
	if (sourceHasInstallMutation(setupProto))
		errors.push("image: setup-proto mutates the image-owned toolchain");
	for (const marker of [
		"prototools.sha256",
		"definition.sha256",
		"devcontainer-fingerprint.sh",
		"DEVCONTAINER_FINGERPRINT_BUN",
		"/tools/bun/",
		"/home/vscode/.proto",
		"/bin/proto",
		"/bin/bash",
		"/usr/bin/readlink -f",
		"/usr/bin/sha256sum",
		"/usr/bin/awk",
		"/usr/bin/tr",
		'fingerprint_script="$image_contract_dir/devcontainer-fingerprint.sh"',
		"Rebuild/recreate the devcontainer",
	]) {
		if (!setupProto.includes(marker))
			errors.push(`image: setup-proto omits ${marker}`);
	}
	if (/image_bun=.*\/shims\/bun/.test(setupProto))
		errors.push("image: setup-proto must not fingerprint through a Proto shim");
	if (setupProto.includes("setup-common.sh"))
		errors.push("image: image verifier must not source checkout helpers");
	if (
		!setupProto.includes(
			'/usr/bin/env -i DEVCONTAINER_FINGERPRINT_BUN="$image_bun"',
		)
	)
		errors.push("image: setup-proto must isolate the fingerprint environment");
	for (const override of [
		"DEVCONTAINER_REPO_ROOT",
		"DEVCONTAINER_IMAGE_CONTRACT_DIR",
	])
		if (setupProto.includes(override))
			errors.push(`image: setup-proto trusts forbidden ${override} override`);
	for (const capability of [
		"codex",
		"gemini",
		"graphify",
		"claude",
		"ccstatusline",
	]) {
		const path = resolve(
			root,
			`.devcontainer/on-create/setup-${capability}.sh`,
		);
		if (!(await Bun.file(path).exists())) continue;
		if (sourceHasInstallMutation(await Bun.file(path).text()))
			errors.push(`image: setup-${capability} contains a runtime installer`);
	}
	const onCreate = await Bun.file(
		resolve(root, ".devcontainer/on-create.sh"),
	).text();
	if (onCreate.includes("setup-proto.sh"))
		errors.push(
			"image: mounted on-create must not implement the image verifier",
		);
	if (
		/\$HOME\/\.proto[^\n]*(?:chown|Claim)|setup-vscode-extensions/.test(
			onCreate,
		)
	)
		errors.push("image: on-create retains obsolete mutable image setup");

	return [...new Set(errors)].sort();
}

if (import.meta.main) {
	const errors = await validateImageContract();
	if (errors.length > 0) {
		for (const error of errors) console.error(error);
		process.exit(1);
	}
	console.log(
		"Validated image stages, Proto partitions, immutable payloads, feature ownership, and runtime refusal.",
	);
}
