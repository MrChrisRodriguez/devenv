import {
	chmod,
	lstat,
	mkdir,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	type CapabilityMap,
	type FixtureDefinition,
	loadFixtureDefinition,
	loadTemplateParameters,
	resolveFixtureParameters,
	type TemplateParameters,
} from "./parameters";

export interface OwnershipRule {
	pattern: string;
	classification: string;
	syncPolicy: string;
	renderPolicy: "copy" | "omit" | "render-readme";
	sourceOfTruth: string;
}

export interface ArtifactRule {
	pattern: string;
	requiresAll: string[];
}

export interface PackageRule {
	capability: string;
	sections: string[];
	packages: string[];
}

export interface CapabilitySignature {
	paths: string[];
	tokens: string[];
}

export interface TemplateOwnership {
	schemaVersion: number;
	classificationMode: "first-match";
	ownershipRules: OwnershipRule[];
	artifactRules: ArtifactRule[];
	packageRules: PackageRule[];
	capabilitySignatures: Record<string, CapabilitySignature>;
}

interface SourceFile {
	path: string;
	mode: "0644" | "0755" | "120000";
	linkTarget?: string;
}

export interface RenderPlanEntry extends SourceFile {
	target: string;
	renderPolicy: Exclude<OwnershipRule["renderPolicy"], "omit">;
}

export interface RenderPlan {
	fixture: string;
	entries: RenderPlanEntry[];
	omitted: Array<{ path: string; reason: string }>;
}

export interface RenderManifest {
	schemaVersion: 1;
	fixture: string;
	project: {
		slug: string;
		displayName: string;
		environmentPrefix: string;
		containerWorkspace: string;
	};
	enabledCapabilities: string[];
	disabledCapabilities: string[];
	files: Array<{
		path: string;
		mode: "0644" | "0755" | "120000";
		sha256: string;
	}>;
	omittedCount: number;
}

export interface ResidueFinding {
	capability: string;
	path: string;
	signature: string;
	kind: "path" | "token";
}

export interface ResidueReport {
	status: "pass" | "fail";
	scannedFiles: number;
	scannedDisabledCapabilities: number;
	findings: ResidueFinding[];
}

const GLOBAL_FORBIDDEN_TOKENS = [
	"trading-games",
	"TG_",
	"@confiador/",
	"/Users/mrcr",
	'"name": "devenv-template"',
];

function matches(pattern: string, path: string): boolean {
	return new Bun.Glob(pattern).match(path);
}

function containsPath(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child !== "" &&
		child !== ".." &&
		!child.startsWith(`..${sep}`) &&
		!isAbsolute(child)
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return false;
		throw error;
	}
}

async function canonicalizePotentialPath(path: string): Promise<string> {
	const missing: string[] = [];
	let existing = path;
	while (!(await pathExists(existing))) {
		const parent = dirname(existing);
		if (parent === existing)
			throw new Error(`Cannot resolve an existing ancestor for ${path}`);
		missing.unshift(basename(existing));
		existing = parent;
	}
	return resolve(await realpath(existing), ...missing);
}

function pathsOverlap(left: string, right: string): boolean {
	return (
		left === right || containsPath(left, right) || containsPath(right, left)
	);
}

async function gitMetadataPaths(root: string): Promise<string[]> {
	const output =
		await Bun.$`git -C ${root} rev-parse --path-format=absolute --git-dir --git-common-dir`
			.quiet()
			.text();
	const paths = [resolve(root, ".git"), ...output.trim().split("\n")];
	return [
		...new Set(
			await Promise.all(
				paths.filter(Boolean).map((path) => canonicalizePotentialPath(path)),
			),
		),
	].sort();
}

export async function loadTemplateOwnership(
	root: string,
): Promise<TemplateOwnership> {
	const path = resolve(
		root,
		"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	);
	const value = (await Bun.file(path).json()) as TemplateOwnership;
	if (
		value.schemaVersion !== 1 ||
		value.classificationMode !== "first-match" ||
		!Array.isArray(value.ownershipRules) ||
		value.ownershipRules.length === 0 ||
		!Array.isArray(value.artifactRules) ||
		!Array.isArray(value.packageRules)
	) {
		throw new Error(`Invalid ownership inventory: ${path}`);
	}
	return value;
}

async function trackedSourceFiles(root: string): Promise<SourceFile[]> {
	const output = await Bun.$`git -C ${root} ls-files --stage`.quiet().text();
	const files: SourceFile[] = [];
	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const match = /^(\d{6}) [0-9a-f]{40,64} \d+\t(.+)$/.exec(line);
		if (!match?.[1] || !match[2])
			throw new Error(`Cannot parse git index entry: ${line}`);
		if (match[1] === "120000") {
			const target = await realpath(resolve(root, match[2]));
			if (!containsPath(root, target)) {
				throw new Error(
					`Symlink source escapes the template root: ${match[2]}`,
				);
			}
			files.push({
				path: match[2],
				mode: "120000",
				linkTarget: await readlink(resolve(root, match[2])),
			});
			continue;
		}
		files.push({
			path: match[2],
			mode: match[1] === "100755" ? "0755" : "0644",
		});
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function ownershipFor(
	path: string,
	ownership: TemplateOwnership,
): OwnershipRule {
	const rule = ownership.ownershipRules.find((candidate) =>
		matches(candidate.pattern, path),
	);
	if (!rule)
		throw new Error(`Tracked path has no ownership classification: ${path}`);
	return rule;
}

function capabilityOmissionReason(
	path: string,
	capabilities: CapabilityMap,
	ownership: TemplateOwnership,
): string | undefined {
	for (const rule of ownership.artifactRules) {
		if (!matches(rule.pattern, path)) continue;
		const missing = rule.requiresAll.filter(
			(capability) => capabilities[capability] !== true,
		);
		if (missing.length > 0)
			return `disabled capabilities: ${missing.sort().join(", ")}`;
	}
	return undefined;
}

export function buildRenderPlan(
	fixture: FixtureDefinition,
	parameters: TemplateParameters,
	ownership: TemplateOwnership,
	sourceFiles: SourceFile[],
): RenderPlan {
	const entries: RenderPlanEntry[] = [];
	const omitted: RenderPlan["omitted"] = [];
	const targets = new Set<string>();
	for (const source of sourceFiles) {
		const rule = ownershipFor(source.path, ownership);
		if (rule.renderPolicy === "omit") {
			omitted.push({
				path: source.path,
				reason: `${rule.classification}: omit`,
			});
			continue;
		}
		const capabilityReason = capabilityOmissionReason(
			source.path,
			parameters.capabilities.defaults,
			ownership,
		);
		if (capabilityReason) {
			omitted.push({ path: source.path, reason: capabilityReason });
			continue;
		}
		const target =
			rule.renderPolicy === "render-readme" ? "README.md" : source.path;
		if (target.startsWith("/") || target.split("/").includes("..")) {
			throw new Error(`Unsafe render target ${target} from ${source.path}`);
		}
		if (targets.has(target))
			throw new Error(`Duplicate render target: ${target}`);
		targets.add(target);
		entries.push({ ...source, target, renderPolicy: rule.renderPolicy });
	}
	if (entries.length === 0)
		throw new Error(`Fixture ${fixture.fixture.name} render plan is empty`);
	return {
		fixture: fixture.fixture.name,
		entries: entries.sort((left, right) =>
			left.target.localeCompare(right.target),
		),
		omitted: omitted.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function replaceWorkspace(value: unknown, workspace: string): unknown {
	if (typeof value === "string")
		return value.replaceAll("/workspace", workspace);
	if (Array.isArray(value))
		return value.map((entry) => replaceWorkspace(entry, workspace));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				replaceWorkspace(entry, workspace),
			]),
		);
	}
	return value;
}

async function renderDevcontainer(
	source: string,
	parameters: TemplateParameters,
	fixtureName: string,
): Promise<string> {
	const parsed = (await Bun.file(source).json()) as Record<string, unknown>;
	const transformed = replaceWorkspace(
		parsed,
		parameters.paths.container_workspace,
	) as Record<string, unknown>;
	transformed["name"] = parameters.project.display_name;
	const build = transformed["build"] as Record<string, unknown>;
	build["target"] = parameters.capabilities.defaults["playwright"]
		? "development_browser"
		: "development";
	const containerEnv = transformed["containerEnv"] as Record<string, unknown>;
	containerEnv["DEVCONTAINER_PROJECT"] = parameters.project.slug;
	const ports = parameters.advertised_ports
		.filter(
			(port) =>
				port.profiles.includes(fixtureName) &&
				(!port.capability ||
					parameters.capabilities.defaults[port.capability] === true),
		)
		.map((port) => port.port);
	transformed["forwardPorts"] = ports;
	const currentAttributes = transformed["portsAttributes"] as Record<
		string,
		unknown
	>;
	transformed["portsAttributes"] = Object.fromEntries(
		ports
			.map((port) => [String(port), currentAttributes[String(port)]])
			.filter((entry) => entry[1]),
	);
	const customizations = transformed["customizations"] as Record<
		string,
		unknown
	>;
	const vscode = customizations["vscode"] as Record<string, unknown>;
	const extensions = vscode["extensions"] as string[];
	vscode["extensions"] = extensions.filter(
		(extension) =>
			parameters.capabilities.defaults["cloudflare_workers"] ||
			extension !== "cloudflare.vscode-cloudflare-workers",
	);
	if (!parameters.capabilities.defaults["context7"]) {
		const comment = transformed["_comment_secrets"];
		if (typeof comment === "string") {
			transformed["_comment_secrets"] = comment.replace(
				" and CONTEXT7_API_KEY",
				"",
			);
		}
	}
	return json(transformed);
}

async function renderPackage(
	source: string,
	parameters: TemplateParameters,
	ownership: TemplateOwnership,
): Promise<string> {
	const value = (await Bun.file(source).json()) as Record<string, unknown>;
	value["name"] = parameters.project.slug;
	const scripts = value["scripts"];
	if (
		typeof scripts === "object" &&
		scripts !== null &&
		!Array.isArray(scripts)
	) {
		const scriptMap = scripts as Record<string, unknown>;
		for (const key of Object.keys(scriptMap)) {
			if (key.startsWith("template:")) delete scriptMap[key];
		}
	}
	for (const rule of ownership.packageRules) {
		if (parameters.capabilities.defaults[rule.capability] === true) continue;
		for (const sectionPath of rule.sections) {
			let section: unknown = value;
			for (const segment of sectionPath.split(".")) {
				if (
					typeof section !== "object" ||
					section === null ||
					Array.isArray(section)
				) {
					section = undefined;
					break;
				}
				section = (section as Record<string, unknown>)[segment];
			}
			if (
				typeof section !== "object" ||
				section === null ||
				Array.isArray(section)
			)
				continue;
			for (const packageName of rule.packages)
				delete (section as Record<string, unknown>)[packageName];
		}
	}
	return json(value);
}

export function stripTemplateOnlyBlocks(source: string): string {
	const output: string[] = [];
	let block: string | undefined;
	for (const line of source.split("\n")) {
		const start = /^# template-only:start ([a-z0-9-]+)$/.exec(line.trim());
		const end = /^# template-only:end ([a-z0-9-]+)$/.exec(line.trim());
		if (start?.[1]) {
			if (block) throw new Error(`Nested template-only block ${start[1]}`);
			block = start[1];
			continue;
		}
		if (end?.[1]) {
			if (block !== end[1])
				throw new Error(`Mismatched template-only block ${end[1]}`);
			block = undefined;
			continue;
		}
		if (!block) output.push(line);
	}
	if (block) throw new Error(`Unterminated template-only block ${block}`);
	return output.join("\n");
}

export function filterCapabilityBlocks(
	source: string,
	capabilities: CapabilityMap,
): string {
	const output: string[] = [];
	let block: string | undefined;
	let retain = false;
	for (const line of source.split("\n")) {
		const start = /^\s*(?:\/\/|#) capability:start ([a-z0-9_]+)$/.exec(line);
		const end = /^\s*(?:\/\/|#) capability:end ([a-z0-9_]+)$/.exec(line);
		if (start?.[1]) {
			if (block) throw new Error(`Nested capability block ${start[1]}`);
			block = start[1];
			retain = capabilities[block] === true;
			continue;
		}
		if (end?.[1]) {
			if (block !== end[1])
				throw new Error(`Mismatched capability block ${end[1]}`);
			block = undefined;
			retain = false;
			continue;
		}
		if (!block || retain) output.push(line);
	}
	if (block) throw new Error(`Unterminated capability block ${block}`);
	return output.join("\n");
}

async function renderMcpSettings(
	source: string,
	parameters: TemplateParameters,
): Promise<string> {
	const value = (await Bun.file(source).json()) as Record<string, unknown>;
	const servers = value["mcpServers"];
	if (
		!parameters.capabilities.defaults["context7"] &&
		typeof servers === "object" &&
		servers !== null &&
		!Array.isArray(servers)
	) {
		delete (servers as Record<string, unknown>)["context7"];
	}
	return json(value);
}

async function renderTsconfig(
	source: string,
	parameters: TemplateParameters,
): Promise<string> {
	const value = (await Bun.file(source).json()) as Record<string, unknown>;
	const compilerOptions = value["compilerOptions"] as Record<string, unknown>;
	const paths = compilerOptions["paths"] as Record<string, unknown>;
	delete paths["@confiador/*"];
	paths[`@${parameters.project.slug}/*`] = [
		"$" + "{configDir}/../../libs/*/src",
	];
	return json(value);
}

async function renderExtensions(
	root: string,
	parameters: TemplateParameters,
): Promise<string> {
	const devcontainer = (await Bun.file(
		resolve(root, ".devcontainer/devcontainer.json"),
	).json()) as {
		customizations: { vscode: { extensions: string[] } };
	};
	const recommendations = devcontainer.customizations.vscode.extensions.filter(
		(extension) =>
			parameters.capabilities.defaults["cloudflare_workers"] ||
			extension !== "cloudflare.vscode-cloudflare-workers",
	);
	return json({ recommendations });
}

function filterAgentRuleLines(
	source: string,
	parameters: TemplateParameters,
): string {
	return source
		.split("\n")
		.filter((line) => {
			if (
				!parameters.capabilities.defaults["cloudflare_workers"] &&
				line.includes("Cloudflare package family")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["better_auth"] &&
				line.includes("Better Auth package family")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["rhf_zod"] &&
				line.includes("RHF/Zod package family")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["playwright"] &&
				line.includes("Playwright package family")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["cloudflare_workers"] &&
				line.includes("Cloudflare Workers")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["cloudflare_workers"] &&
				line.includes("tsconfig.worker")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["tanstack_start"] &&
				line.includes("tsconfig.start")
			) {
				return false;
			}
			if (
				!parameters.capabilities.defaults["playwright"] &&
				line.includes("tsconfig.stagehand")
			) {
				return false;
			}
			return true;
		})
		.join("\n");
}

function filterOnCreateLines(
	source: string,
	capabilities: CapabilityMap,
): string {
	const owners: Array<[string, string]> = [
		["setup-ccstatusline.sh", "ccstatusline"],
		["setup-claude-octopus.sh", "claude_octopus"],
		["setup-claude-warp.sh", "claude_warp"],
		["setup-claude.sh", "claude"],
		["setup-codex.sh", "codex"],
		["setup-gemini.sh", "gemini"],
		["setup-graphify.sh", "graphify"],
		["setup-openspec.sh", "openspec"],
	];
	return source
		.split("\n")
		.filter(
			(line) =>
				!owners.some(
					([filename, capability]) =>
						line.includes(filename) && capabilities[capability] !== true,
				),
		)
		.join("\n");
}

function filterContext7Lines(source: string): string {
	const lines = source.split("\n");
	const filtered: string[] = [];
	let inRegistrationBlock = false;
	for (const line of lines) {
		if (line.includes("# Register Context7 MCP server")) {
			inRegistrationBlock = true;
			continue;
		}
		if (inRegistrationBlock) {
			if (line.trim() === "fi") inRegistrationBlock = false;
			continue;
		}
		if (line.toLowerCase().includes("context7")) continue;
		filtered.push(line);
	}
	return filtered.join("\n");
}

async function renderContent(
	root: string,
	entry: RenderPlanEntry,
	parameters: TemplateParameters,
	fixture: FixtureDefinition,
): Promise<Uint8Array | string> {
	const source = resolve(root, entry.path);
	if (entry.mode === "120000") {
		if (!entry.linkTarget)
			throw new Error(`Tracked symlink has no target: ${entry.path}`);
		return entry.linkTarget;
	}
	if (entry.renderPolicy === "render-readme") {
		return (await Bun.file(source).text()).replaceAll(
			"{{PROJECT_NAME}}",
			parameters.project.display_name,
		);
	}
	if (entry.path === ".devcontainer/devcontainer.json") {
		return renderDevcontainer(source, parameters, fixture.fixture.name);
	}
	if (entry.path === "package.json")
		return renderPackage(source, parameters, await loadTemplateOwnership(root));
	if (
		entry.path === ".cursor/mcp.json" ||
		entry.path === ".claude/settings.json"
	) {
		return renderMcpSettings(source, parameters);
	}
	if (entry.path === "tsconfig.base.json")
		return renderTsconfig(source, parameters);
	if (entry.path === ".vscode/extensions.json")
		return renderExtensions(root, parameters);
	const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
	if (bytes.includes(0)) return bytes;
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return bytes;
	}
	content = stripTemplateOnlyBlocks(content)
		.replaceAll("/workspace", parameters.paths.container_workspace)
		.replaceAll("@confiador/", `@${parameters.project.slug}/`);
	if (
		entry.path === "scripts/template/toolchain.ts" ||
		entry.path === "scripts/template/image-contract.ts" ||
		entry.path === ".devcontainer/Dockerfile"
	)
		content = filterCapabilityBlocks(content, parameters.capabilities.defaults);
	if (entry.path === "AGENTS.md")
		content = filterAgentRuleLines(content, parameters);
	if (entry.path === ".devcontainer/on-create.sh") {
		content = filterOnCreateLines(content, parameters.capabilities.defaults);
	}
	if (
		!parameters.capabilities.defaults["context7"] &&
		(entry.path === ".devcontainer/on-create/setup-claude.sh" ||
			entry.path === ".devcontainer/secrets.example")
	) {
		content = filterContext7Lines(content);
	}
	if (
		!parameters.capabilities.defaults["cloudflare_workers"] &&
		(entry.path === ".gitignore" ||
			entry.path === ".devcontainer/configs/.shell_common")
	) {
		content = content
			.split("\n")
			.filter((line) => !/(?:cloudflare|wrangler)/i.test(line))
			.join("\n");
	}
	return content;
}

function sha256(value: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function scanDisabledResidue(
	output: string,
	parameters: TemplateParameters,
	ownership: TemplateOwnership,
): Promise<ResidueReport> {
	const files: string[] = [];
	for await (const path of new Bun.Glob("**/*").scan({
		cwd: output,
		dot: true,
		onlyFiles: true,
	})) {
		files.push(path);
	}
	files.sort();
	if (files.length === 0)
		throw new Error("Anti-residue scan has no generated files");
	const disabled = Object.entries(parameters.capabilities.defaults)
		.filter(([, enabled]) => !enabled)
		.map(([capability]) => capability)
		.filter((capability) => ownership.capabilitySignatures[capability]);
	const findings: ResidueFinding[] = [];
	for (const path of files) {
		for (const token of GLOBAL_FORBIDDEN_TOKENS) {
			const content = await Bun.file(resolve(output, path)).text();
			if (content.includes(token)) {
				findings.push({
					capability: "global",
					path,
					signature: token,
					kind: "token",
				});
			}
		}
		for (const capability of disabled) {
			if (path === "fixture-manifest.json") continue;
			const signatures = ownership.capabilitySignatures[capability];
			if (!signatures) continue;
			for (const pattern of signatures.paths) {
				if (matches(pattern, path)) {
					findings.push({ capability, path, signature: pattern, kind: "path" });
				}
			}
			if (signatures.tokens.length > 0) {
				const content = await Bun.file(resolve(output, path)).text();
				for (const token of signatures.tokens) {
					if (content.includes(token)) {
						findings.push({
							capability,
							path,
							signature: token,
							kind: "token",
						});
					}
				}
			}
		}
	}
	findings.sort((left, right) =>
		`${left.capability}:${left.path}:${left.signature}`.localeCompare(
			`${right.capability}:${right.path}:${right.signature}`,
		),
	);
	return {
		status: findings.length === 0 ? "pass" : "fail",
		scannedFiles: files.length,
		scannedDisabledCapabilities: disabled.length,
		findings,
	};
}

async function atomicPublish(
	target: string,
	force: boolean,
	write: (temporary: string) => Promise<void>,
): Promise<void> {
	const parent = dirname(target);
	await mkdir(parent, { recursive: true });
	const temporary = resolve(parent, `.${basename(target)}.tmp-${process.pid}`);
	const backup = resolve(parent, `.${basename(target)}.backup-${process.pid}`);
	await rm(temporary, { recursive: true, force: true });
	await rm(backup, { recursive: true, force: true });
	await mkdir(temporary);
	try {
		await write(temporary);
		const exists = await pathExists(target);
		if (exists && !force)
			throw new Error(`Output already exists (use --force): ${target}`);
		if (exists) await rename(target, backup);
		try {
			await rename(temporary, target);
		} catch (error) {
			if (exists && (await pathExists(backup))) await rename(backup, target);
			throw error;
		}
		await rm(backup, { recursive: true, force: true });
	} catch (error) {
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

function formatRenderedFiles(
	root: string,
	output: string,
	paths: string[],
): void {
	const formatter = resolve(root, "node_modules/.bin/biome");
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			formatter,
			"format",
			"--write",
			"--no-errors-on-unmatched",
			...paths,
		],
		cwd: output,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`Rendered fixture formatting failed:\n${result.stdout.toString()}${result.stderr.toString()}`,
		);
	}
}

export async function renderFixture(options: {
	root: string;
	fixtureName: string;
	output: string;
	force?: boolean;
}): Promise<{ manifest: RenderManifest; residue: ResidueReport }> {
	const root = await realpath(resolve(options.root));
	const target = await canonicalizePotentialPath(resolve(options.output));
	if (target === root || containsPath(target, root)) {
		throw new Error(`Unsafe output path: ${target}`);
	}
	for (const gitPath of await gitMetadataPaths(root)) {
		if (pathsOverlap(target, gitPath))
			throw new Error(`Output path overlaps protected Git metadata: ${target}`);
	}
	const parameters = await loadTemplateParameters(root);
	const fixture = await loadFixtureDefinition(
		root,
		options.fixtureName,
		parameters,
	);
	const resolvedParameters = resolveFixtureParameters(parameters, fixture);
	const ownership = await loadTemplateOwnership(root);
	const sourceFiles = await trackedSourceFiles(root);
	if (
		sourceFiles.some((source) => {
			const sourcePath = resolve(root, source.path);
			return sourcePath === target || containsPath(target, sourcePath);
		})
	) {
		throw new Error(`Output path contains tracked template sources: ${target}`);
	}
	const plan = buildRenderPlan(
		fixture,
		resolvedParameters,
		ownership,
		sourceFiles,
	);
	const rendered: Array<{
		entry: RenderPlanEntry;
		content: Uint8Array | string;
	}> = [];
	for (const entry of plan.entries) {
		rendered.push({
			entry,
			content: await renderContent(root, entry, resolvedParameters, fixture),
		});
	}
	const manifest: RenderManifest = {
		schemaVersion: 1,
		fixture: fixture.fixture.name,
		project: {
			slug: resolvedParameters.project.slug,
			displayName: resolvedParameters.project.display_name,
			environmentPrefix: resolvedParameters.project.environment_prefix,
			containerWorkspace: resolvedParameters.paths.container_workspace,
		},
		enabledCapabilities: Object.entries(
			resolvedParameters.capabilities.defaults,
		)
			.filter(([, enabled]) => enabled)
			.map(([capability]) => capability)
			.sort(),
		disabledCapabilities: Object.entries(
			resolvedParameters.capabilities.defaults,
		)
			.filter(([, enabled]) => !enabled)
			.map(([capability]) => capability)
			.sort(),
		files: [],
		omittedCount: plan.omitted.length,
	};
	let residue: ResidueReport | undefined;
	await atomicPublish(target, options.force ?? false, async (temporary) => {
		for (const { entry, content } of rendered) {
			const destination = resolve(temporary, entry.target);
			if (!containsPath(temporary, destination)) {
				throw new Error(
					`Render target escaped temporary root: ${entry.target}`,
				);
			}
			await mkdir(dirname(destination), { recursive: true });
			if (entry.mode === "120000") {
				await symlink(String(content), destination);
			} else {
				await Bun.write(destination, content);
				await chmod(destination, entry.mode === "0755" ? 0o755 : 0o644);
			}
		}
		formatRenderedFiles(root, temporary, ["."]);
		manifest.files = [];
		for (const { entry, content } of rendered) {
			const formatted =
				entry.mode === "120000"
					? content
					: new Uint8Array(
							await Bun.file(resolve(temporary, entry.target)).arrayBuffer(),
						);
			manifest.files.push({
				path: entry.target,
				mode: entry.mode,
				sha256: sha256(formatted),
			});
		}
		await Bun.write(
			resolve(temporary, "fixture-manifest.json"),
			json(manifest),
		);
		formatRenderedFiles(root, temporary, ["fixture-manifest.json"]);
		residue = await scanDisabledResidue(
			temporary,
			resolvedParameters,
			ownership,
		);
		if (residue.status === "fail") {
			throw new Error(
				`Disabled capability residue detected:\n${JSON.stringify(residue.findings, null, 2)}`,
			);
		}
	});
	if (!residue) throw new Error("Fixture residue scan did not run");
	return { manifest, residue };
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
	const fixtureName = argument("--fixture");
	const output = argument("--output");
	if (!fixtureName || !output) {
		console.error(
			"Usage: bun scripts/template/render-fixture.ts --fixture <minimal|cloud|full> --output <path> [--force]",
		);
		process.exit(2);
	}
	try {
		const result = await renderFixture({
			root: resolve(import.meta.dir, "../.."),
			fixtureName,
			output,
			force: process.argv.includes("--force"),
		});
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
