// biome-ignore-all lint/complexity/useLiteralKeys: Strict JSON/TOML records require bracket access.
import { resolve } from "node:path";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMMUTABLE_PLUGIN =
	/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/.+\/plugin\.toml$/;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/;

const CORE_CATALOG_PACKAGES = [
	"@biomejs/biome",
	"@commitlint/cli",
	"@commitlint/config-conventional",
	"@types/bun",
	"@types/node",
	"husky",
	"lint-staged",
	"typescript",
] as const;

const TEMPLATE_CATALOG_PACKAGES = [
	...CORE_CATALOG_PACKAGES,
	// capability:start cloudflare_workers
	"@cloudflare/vite-plugin",
	"@cloudflare/vitest-pool-workers",
	// capability:end cloudflare_workers
	// capability:start openspec
	"@fission-ai/openspec",
	// capability:end openspec
	// capability:start rhf_zod
	"@hookform/resolvers",
	// capability:end rhf_zod
	// capability:start playwright
	"@playwright/test",
	// capability:end playwright
	// capability:start better_auth
	"better-auth",
	// capability:end better_auth
	// capability:start rhf_zod
	"react-hook-form",
	// capability:end rhf_zod
	// capability:start cloudflare_workers
	"wrangler",
	// capability:end cloudflare_workers
	// capability:start rhf_zod
	"zod",
	// capability:end rhf_zod
] as const;

const ATOMIC_CATALOG_FAMILIES = {
	// capability:start cloudflare_workers
	cloudflare: [
		"@cloudflare/vite-plugin",
		"@cloudflare/vitest-pool-workers",
		"wrangler",
	],
	// capability:end cloudflare_workers
	// capability:start rhf_zod
	forms: ["@hookform/resolvers", "react-hook-form", "zod"],
	// capability:end rhf_zod
} as const;

const IGNORED_DISCOVERY_SEGMENTS = new Set([
	".bun",
	".git",
	".moon",
	".next",
	"coverage",
	"dist",
	"graphify-out",
	"node_modules",
	"tmp",
]);

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
	return [...new Set(resolvedOccurrences(lock, packageName))].sort();
}

export function resolvedOccurrences(
	lock: string,
	packageName: string,
): string[] {
	const matcher = new RegExp(
		`\\["${escapeRegExp(packageName)}@([^"\\s]+)"`,
		"g",
	);
	return [...lock.matchAll(matcher)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

function validatePathPriority(
	value: string,
	label: string,
	errors: string[],
): void {
	const local = value.indexOf("node_modules/.bin");
	const proto = value.indexOf(".proto/shims");
	if (local < 0)
		errors.push(`path: ${label} omits workspace-local node_modules/.bin`);
	else if (proto >= 0 && local > proto)
		errors.push(`path: ${label} resolves Proto before workspace binaries`);
}

async function workspacePackagePaths(
	root: string,
	_packageValue: JsonRecord,
): Promise<string[]> {
	const paths: string[] = [];
	for await (const path of new Bun.Glob("**/package.json").scan({
		cwd: root,
		dot: true,
		onlyFiles: true,
	})) {
		if (path.split("/").some((part) => IGNORED_DISCOVERY_SEGMENTS.has(part)))
			continue;
		paths.push(path);
	}
	return [...new Set(paths)].sort();
}

async function tsconfigPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for await (const path of new Bun.Glob("**/tsconfig*.json").scan({
		cwd: root,
		dot: true,
		onlyFiles: true,
	})) {
		if (path.split("/").some((part) => IGNORED_DISCOVERY_SEGMENTS.has(part)))
			continue;
		paths.push(path);
	}
	return [...new Set(paths)].sort();
}

async function nestedLockPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	for (const filename of [
		"bun.lock",
		"bun.lockb",
		"package-lock.json",
		"pnpm-lock.yaml",
		"yarn.lock",
	]) {
		for await (const path of new Bun.Glob(`**/${filename}`).scan({
			cwd: root,
			dot: true,
			onlyFiles: true,
		})) {
			if (path === "bun.lock") continue;
			if (path.split("/").some((part) => IGNORED_DISCOVERY_SEGMENTS.has(part)))
				continue;
			paths.push(path);
		}
	}
	return [...new Set(paths)].sort();
}

function setupBunPins(workflow: string): Array<string | undefined> {
	const lines = workflow.split("\n");
	const pins: Array<string | undefined> = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		if (!/oven-sh\/setup-bun@/i.test(lines[lineIndex] ?? "")) continue;
		let stepStart = lineIndex;
		while (stepStart >= 0 && !/^\s*-\s+/.test(lines[stepStart] ?? ""))
			stepStart -= 1;
		if (stepStart < 0) {
			pins.push(undefined);
			continue;
		}
		const indentation = /^\s*/.exec(lines[stepStart] ?? "")?.[0] ?? "";
		let stepEnd = stepStart + 1;
		while (
			stepEnd < lines.length &&
			!new RegExp(`^${escapeRegExp(indentation)}-\\s+`).test(
				lines[stepEnd] ?? "",
			)
		)
			stepEnd += 1;
		const step = lines.slice(stepStart, stepEnd).join("\n");
		const matches = [
			...step.matchAll(/bun-version:\s*['"]?([^'"\s#]+)/g),
		].flatMap((match) => (match[1] ? [match[1]] : []));
		pins.push(matches.length === 1 ? matches[0] : undefined);
	}
	return pins;
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
	if (Bun.version !== protoValue["bun"])
		errors.push(
			`proto: executing Bun ${Bun.version} differs from .prototools ${String(protoValue["bun"] ?? "missing")}`,
		);

	const templateParametersPath = resolve(root, "template-parameters.toml");
	const isTemplateSource = await Bun.file(templateParametersPath).exists();
	let supportedArchitectures = ["amd64", "arm64"];
	if (isTemplateSource) {
		const parameters = Bun.TOML.parse(
			await Bun.file(templateParametersPath).text(),
		) as JsonRecord;
		const architectures = recordAt(parameters, "container")[
			"supported_architectures"
		];
		supportedArchitectures = Array.isArray(architectures)
			? architectures.filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [];
	}
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
	const requiredCatalogPackages = isTemplateSource
		? TEMPLATE_CATALOG_PACKAGES
		: CORE_CATALOG_PACKAGES;
	for (const packageName of requiredCatalogPackages) {
		const version = catalog[packageName];
		if (typeof version !== "string" || !EXACT_VERSION.test(version))
			errors.push(`catalog: ${packageName} must use an exact version`);
	}
	for (const [packageName, version] of Object.entries(catalog)) {
		if (typeof version !== "string" || !EXACT_VERSION.test(version))
			errors.push(`catalog: ${packageName} is floating or ranged`);
		if (devDependencies[packageName] !== "catalog:")
			errors.push(`catalog: root consumer ${packageName} must use catalog:`);
	}
	for (const [familyName, familyPackages] of Object.entries(
		ATOMIC_CATALOG_FAMILIES,
	)) {
		const selected = familyPackages.filter(
			(packageName) => catalog[packageName] !== undefined,
		);
		if (selected.length !== 0 && selected.length !== familyPackages.length)
			errors.push(`catalog: ${familyName} family must be selected atomically`);
	}
	// capability:start rhf_zod
	if (
		catalog["zod"] !== undefined &&
		recordAt(packageValue, "overrides")["zod"] !== catalog["zod"]
	)
		errors.push("catalog: zod override must equal the catalog pin");
	if (
		catalog["zod"] === undefined &&
		recordAt(packageValue, "overrides")["zod"] !== undefined
	)
		errors.push(
			"catalog: zod override remains while the forms family is disabled",
		);
	// capability:end rhf_zod
	// capability:start cloudflare_workers
	for (const transitive of ["miniflare", "workerd"]) {
		if (catalog[transitive] !== undefined)
			errors.push(
				`catalog: Cloudflare transitive ${transitive} must remain lock-owned`,
			);
	}
	// capability:end cloudflare_workers
	if (recordAt(packageValue, "engines")["bun"] !== protoValue["bun"])
		errors.push("catalog: Bun engine must equal the Proto pin");

	const manifests = new Map<string, JsonRecord>();
	for (const relativePath of await workspacePackagePaths(root, packageValue))
		manifests.set(relativePath, await readJson(resolve(root, relativePath)));
	const internalPackages = new Set(
		[...manifests.values()].flatMap((manifest) =>
			typeof manifest["name"] === "string" ? [manifest["name"]] : [],
		),
	);
	for (const [relativePath, manifest] of manifests) {
		for (const sectionName of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			const section = recordAt(manifest, sectionName);
			for (const [packageName, consumer] of Object.entries(section)) {
				if (internalPackages.has(packageName)) {
					if (
						typeof consumer !== "string" ||
						!consumer.startsWith("workspace:")
					)
						errors.push(
							`catalog: ${relativePath} ${sectionName}.${packageName} must use workspace:`,
						);
					continue;
				}
				const catalogVersion = catalog[packageName];
				if (typeof catalogVersion !== "string") {
					errors.push(
						`catalog: ${relativePath} ${sectionName}.${packageName} is not catalog-owned`,
					);
					continue;
				}
				if (consumer === "catalog:") continue;
				if (
					sectionName === "peerDependencies" &&
					typeof consumer === "string" &&
					Bun.semver.satisfies(catalogVersion, consumer)
				)
					continue;
				errors.push(
					`catalog: ${relativePath} ${sectionName}.${packageName} bypasses catalog:`,
				);
			}
		}
	}
	const githubAutomationPaths: string[] = [];
	for (const pattern of [".github/**/*.yml", ".github/**/*.yaml"]) {
		for await (const automationPath of new Bun.Glob(pattern).scan({
			cwd: root,
			dot: true,
			onlyFiles: true,
		}))
			githubAutomationPaths.push(automationPath);
	}
	for (const automationPath of [...new Set(githubAutomationPaths)].sort()) {
		const automation = await Bun.file(resolve(root, automationPath)).text();
		if (!/oven-sh\/setup-bun@/i.test(automation)) continue;
		const pins = setupBunPins(automation);
		for (const pin of pins) {
			if (pin === undefined) {
				errors.push(`proto: ${automationPath} setup-bun omits bun-version`);
				continue;
			}
			if (pin !== protoValue["bun"])
				errors.push(
					`proto: ${automationPath} Bun ${pin} differs from .prototools`,
				);
		}
	}

	const lockText = await Bun.file(resolve(root, "bun.lock")).text();
	for (const path of await nestedLockPaths(root))
		errors.push(`lock: secondary package lock ${path} is forbidden`);
	const singletonPackages = [
		...Object.keys(catalog),
		// capability:start better_auth
		...(catalog["better-auth"] === undefined ? [] : ["@better-auth/core"]),
		// capability:end better_auth
		// capability:start playwright
		...(catalog["@playwright/test"] === undefined
			? []
			: ["playwright", "playwright-core"]),
		// capability:end playwright
		// capability:start cloudflare_workers
		...(catalog["wrangler"] === undefined ? [] : ["miniflare", "workerd"]),
		// capability:end cloudflare_workers
	];
	for (const packageName of singletonPackages) {
		const occurrences = resolvedOccurrences(lockText, packageName);
		const versions = resolvedVersions(lockText, packageName);
		if (occurrences.length !== 1)
			errors.push(
				`lock: ${packageName} must resolve exactly once, found ${occurrences.length} entries (${versions.join(", ") || "none"})`,
			);
	}
	for (const packageName of Object.keys(catalog)) {
		const version = catalog[packageName];
		const versions = resolvedVersions(lockText, packageName);
		if (typeof version === "string" && !versions.includes(version))
			errors.push(
				`lock: ${packageName} does not resolve to catalog ${version}`,
			);
	}
	// capability:start better_auth
	if (catalog["better-auth"] !== undefined) {
		const betterAuthVersions = resolvedVersions(lockText, "better-auth");
		const betterAuthCoreVersions = resolvedVersions(
			lockText,
			"@better-auth/core",
		);
		if (betterAuthVersions[0] !== betterAuthCoreVersions[0])
			errors.push("lock: Better Auth core and package versions diverge");
	}
	// capability:end better_auth
	// capability:start playwright
	if (catalog["@playwright/test"] !== undefined) {
		const playwrightVersions = [
			resolvedVersions(lockText, "@playwright/test")[0],
			resolvedVersions(lockText, "playwright")[0],
			resolvedVersions(lockText, "playwright-core")[0],
		];
		if (new Set(playwrightVersions).size !== 1)
			errors.push("lock: Playwright package family versions diverge");
	}
	// capability:end playwright

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
