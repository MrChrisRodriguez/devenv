// biome-ignore-all lint/complexity/useLiteralKeys: Strict JSON/TOML records require bracket access.
import { resolve } from "node:path";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMMUTABLE_PLUGIN =
	/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/.+\/plugin\.toml$/;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/;

const REQUIRED_CATALOG_PACKAGES = [
	"@biomejs/biome",
	"@cloudflare/vite-plugin",
	"@cloudflare/vitest-pool-workers",
	"@commitlint/cli",
	"@commitlint/config-conventional",
	"@fission-ai/openspec",
	"@hookform/resolvers",
	"@playwright/test",
	"@types/bun",
	"@types/node",
	"better-auth",
	"husky",
	"lint-staged",
	"react-hook-form",
	"typescript",
	"wrangler",
	"zod",
] as const;

const SINGLETON_PACKAGES = [
	...REQUIRED_CATALOG_PACKAGES,
	"@better-auth/core",
	"miniflare",
	"playwright",
	"playwright-core",
	"workerd",
] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
	return value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolvedVersions(lock: string, packageName: string): string[] {
	const matcher = new RegExp(
		`\\["${escapeRegExp(packageName)}@([^"\\s]+)"`,
		"g",
	);
	return [
		...new Set(
			[...lock.matchAll(matcher)].flatMap((match) =>
				match[1] ? [match[1]] : [],
			),
		),
	].sort();
}

function validatePathPriority(
	value: string,
	label: string,
	errors: string[],
): void {
	const local = value.indexOf("/workspace/node_modules/.bin");
	const proto = value.indexOf(".proto/shims");
	if (local < 0)
		errors.push(`path: ${label} omits workspace node_modules/.bin`);
	else if (proto >= 0 && local > proto)
		errors.push(`path: ${label} resolves Proto before workspace binaries`);
}

async function workspacePackagePaths(root: string): Promise<string[]> {
	const paths = ["package.json"];
	for (const pattern of [
		"apps/*/package.json",
		"libs/*/package.json",
		"scripts/*/package.json",
	]) {
		for await (const path of new Bun.Glob(pattern).scan({
			cwd: root,
			onlyFiles: true,
		})) {
			paths.push(path);
		}
	}
	return [...new Set(paths)].sort();
}

async function tsconfigPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const pattern of [
		"tsconfig*.json",
		"apps/*/tsconfig*.json",
		"libs/*/tsconfig*.json",
		"scripts/*/tsconfig*.json",
	]) {
		for await (const path of new Bun.Glob(pattern).scan({
			cwd: root,
			onlyFiles: true,
		})) {
			paths.push(path);
		}
	}
	return [...new Set(paths)].sort();
}

async function nestedLockPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const directory of ["apps", "libs", "scripts"]) {
		for (const filename of [
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"pnpm-lock.yaml",
			"yarn.lock",
		]) {
			for await (const path of new Bun.Glob(`${directory}/*/${filename}`).scan({
				cwd: root,
				onlyFiles: true,
			})) {
				paths.push(path);
			}
		}
	}
	for (const filename of [
		"bun.lockb",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
	]) {
		if (await Bun.file(resolve(root, filename)).exists()) paths.push(filename);
	}
	return [...new Set(paths)].sort();
}

export async function validateToolchainContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const protoPath = resolve(root, ".prototools");
	const protoText = await Bun.file(protoPath).text();
	const protoValue = Bun.TOML.parse(protoText) as JsonRecord;
	const plugins = recordAt(protoValue, "plugins");
	for (const [tool, value] of Object.entries(protoValue)) {
		if (tool === "plugins" || tool === "settings") continue;
		if (typeof value !== "string" || !EXACT_VERSION.test(value))
			errors.push(`proto: ${tool} must use an exact version`);
	}
	for (const [tool, locator] of Object.entries(plugins)) {
		if (typeof locator !== "string" || !IMMUTABLE_PLUGIN.test(locator))
			errors.push(`proto: plugin ${tool} must use an immutable commit URL`);
	}
	for (const required of ["bun", "node", "moon", "proto"]) {
		if (!EXACT_VERSION.test(String(protoValue[required] ?? "")))
			errors.push(`proto: required tool ${required} is not exact-pinned`);
	}

	const parameters = Bun.TOML.parse(
		await Bun.file(resolve(root, "template-parameters.toml")).text(),
	) as JsonRecord;
	const architectures = recordAt(parameters, "container")[
		"supported_architectures"
	];
	const supportedArchitectures = Array.isArray(architectures)
		? architectures.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];
	const checksumText = await Bun.file(
		resolve(root, ".devcontainer/proto-checksums.txt"),
	).text();
	const checksumTargets = new Map<string, string>();
	for (const line of checksumText.trim().split("\n")) {
		const match =
			/^([0-9a-f]{64}) {2}(proto_cli-(x86_64|aarch64)-unknown-linux-gnu\.tar\.xz)$/.exec(
				line,
			);
		if (!match?.[1] || !match[2] || !match[3]) {
			errors.push(`proto: malformed checksum record ${line}`);
			continue;
		}
		if (checksumTargets.has(match[3]))
			errors.push(`proto: duplicate checksum target ${match[3]}`);
		checksumTargets.set(match[3], match[1]);
	}
	const expectedTargets = supportedArchitectures.map((architecture) =>
		architecture === "amd64"
			? "x86_64"
			: architecture === "arm64"
				? "aarch64"
				: architecture,
	);
	if (
		expectedTargets.length === 0 ||
		expectedTargets.some((target) => !checksumTargets.has(target)) ||
		checksumTargets.size !== expectedTargets.length
	)
		errors.push("proto: checksum architectures drift from template parameters");

	const packagePath = resolve(root, "package.json");
	const packageValue = await readJson(packagePath);
	const workspaces = recordAt(packageValue, "workspaces");
	const catalog = recordAt(workspaces, "catalog");
	const devDependencies = recordAt(packageValue, "devDependencies");
	for (const packageName of REQUIRED_CATALOG_PACKAGES) {
		const version = catalog[packageName];
		if (typeof version !== "string" || !EXACT_VERSION.test(version))
			errors.push(`catalog: ${packageName} must use an exact version`);
		if (devDependencies[packageName] !== "catalog:")
			errors.push(`catalog: root consumer ${packageName} must use catalog:`);
	}
	for (const [packageName, version] of Object.entries(catalog)) {
		if (typeof version !== "string" || !EXACT_VERSION.test(version))
			errors.push(`catalog: ${packageName} is floating or ranged`);
	}
	if (recordAt(packageValue, "overrides")["zod"] !== catalog["zod"])
		errors.push("catalog: zod override must equal the catalog pin");
	if (recordAt(packageValue, "engines")["bun"] !== protoValue["bun"])
		errors.push("catalog: Bun engine must equal the Proto pin");

	for (const relativePath of await workspacePackagePaths(root)) {
		const manifest = await readJson(resolve(root, relativePath));
		for (const sectionName of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const section = recordAt(manifest, sectionName);
			for (const packageName of Object.keys(catalog)) {
				const consumer = section[packageName];
				if (consumer !== undefined && consumer !== "catalog:")
					errors.push(
						`catalog: ${relativePath} ${sectionName}.${packageName} bypasses catalog:`,
					);
			}
		}
	}

	const lockText = await Bun.file(resolve(root, "bun.lock")).text();
	for (const path of await nestedLockPaths(root))
		errors.push(`lock: secondary package lock ${path} is forbidden`);
	for (const packageName of SINGLETON_PACKAGES) {
		const versions = resolvedVersions(lockText, packageName);
		if (versions.length !== 1)
			errors.push(
				`lock: ${packageName} must resolve exactly once, found ${versions.join(", ") || "none"}`,
			);
	}
	for (const packageName of REQUIRED_CATALOG_PACKAGES) {
		const version = catalog[packageName];
		const versions = resolvedVersions(lockText, packageName);
		if (typeof version === "string" && !versions.includes(version))
			errors.push(
				`lock: ${packageName} does not resolve to catalog ${version}`,
			);
	}
	const betterAuthVersions = resolvedVersions(lockText, "better-auth");
	const betterAuthCoreVersions = resolvedVersions(
		lockText,
		"@better-auth/core",
	);
	if (betterAuthVersions[0] !== betterAuthCoreVersions[0])
		errors.push("lock: Better Auth core and package versions diverge");
	const playwrightVersions = [
		resolvedVersions(lockText, "@playwright/test")[0],
		resolvedVersions(lockText, "playwright")[0],
		resolvedVersions(lockText, "playwright-core")[0],
	];
	if (new Set(playwrightVersions).size !== 1)
		errors.push("lock: Playwright package family versions diverge");

	const devcontainer = await readJson(
		resolve(root, ".devcontainer/devcontainer.json"),
	);
	const featureConfig = recordAt(devcontainer, "features");
	const featureLock = recordAt(
		await readJson(resolve(root, ".devcontainer/devcontainer-lock.json")),
		"features",
	);
	const configuredFeatures = Object.keys(featureConfig).sort();
	const lockedFeatures = Object.keys(featureLock).sort();
	if (JSON.stringify(configuredFeatures) !== JSON.stringify(lockedFeatures))
		errors.push("features: config and digest lock feature sets differ");
	for (const feature of configuredFeatures) {
		const locked = featureLock[feature];
		if (!isRecord(locked)) {
			errors.push(`features: ${feature} is missing from the digest lock`);
			continue;
		}
		const version = locked["version"];
		const integrity = locked["integrity"];
		const resolved = locked["resolved"];
		if (typeof version !== "string" || !EXACT_VERSION.test(version))
			errors.push(`features: ${feature} has a non-exact release version`);
		if (typeof integrity !== "string" || !SHA256.test(integrity))
			errors.push(`features: ${feature} has invalid integrity`);
		const featureRepository = feature.replace(/:\d+$/, "");
		if (resolved !== `${featureRepository}@${integrity}`)
			errors.push(
				`features: ${feature} resolved reference and integrity differ`,
			);
	}
	if (
		protoValue["node"] !== undefined &&
		configuredFeatures.some((feature) => feature.endsWith("/node:1"))
	)
		errors.push("features: Node cannot be owned by both Proto and a feature");

	for (const relativePath of await tsconfigPaths(root)) {
		const source = await Bun.file(resolve(root, relativePath)).text();
		const tsconfigValue = Bun.JSONC.parse(source) as unknown;
		if (!isRecord(tsconfigValue)) {
			errors.push(`typescript: ${relativePath} must contain an object`);
			continue;
		}
		const compilerOptions = recordAt(tsconfigValue, "compilerOptions");
		if (Object.hasOwn(compilerOptions, "baseUrl"))
			errors.push(`typescript: ${relativePath} reintroduces baseUrl`);
		const paths = recordAt(compilerOptions, "paths");
		for (const targets of Object.values(paths)) {
			if (
				Array.isArray(targets) &&
				targets.some(
					(target) => typeof target === "string" && target.startsWith("/"),
				)
			)
				errors.push(
					`typescript: ${relativePath} contains an absolute path alias`,
				);
		}
	}
	const baseTsconfig = await Bun.file(
		resolve(root, "tsconfig.base.json"),
	).text();
	if (!baseTsconfig.includes(`\${configDir}/../../libs/*/src`))
		errors.push("typescript: project alias is not config-relative");

	const shellCommon = await Bun.file(
		resolve(root, ".devcontainer/configs/.shell_common"),
	).text();
	const setupCommon = await Bun.file(
		resolve(root, ".devcontainer/on-create/setup-common.sh"),
	).text();
	validatePathPriority(shellCommon, ".shell_common", errors);
	validatePathPriority(setupCommon, "setup-common.sh", errors);
	const remoteEnvironment = recordAt(devcontainer, "remoteEnv");
	validatePathPriority(
		String(remoteEnvironment["PATH"] ?? ""),
		"remoteEnv.PATH",
		errors,
	);
	for (const commandName of ["postCreateCommand", "postStartCommand"]) {
		const command = devcontainer[commandName];
		validatePathPriority(
			Array.isArray(command) ? command.join(" ") : String(command ?? ""),
			commandName,
			errors,
		);
	}

	const setupProto = await Bun.file(
		resolve(root, ".devcontainer/on-create/setup-proto.sh"),
	).text();
	if (
		setupProto.includes("moonrepo.dev/install/proto.sh") ||
		!setupProto.includes(".devcontainer/install-proto.sh")
	)
		errors.push("proto: setup does not use the checksum-verified installer");

	return [...new Set(errors)].sort();
}

if (import.meta.main) {
	const errors = await validateToolchainContract();
	if (errors.length > 0) {
		for (const error of errors) console.error(error);
		process.exit(1);
	}
	console.log(
		"Validated exact Proto, catalog, lock, feature, TypeScript, and PATH contracts.",
	);
}
