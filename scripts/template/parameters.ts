import { posix, resolve } from "node:path";
import { validateJsonSchema } from "./json-schema";

export type CapabilityMap = Record<string, boolean>;

export interface ProjectParameters {
	slug: string;
	display_name: string;
	environment_prefix: string;
	docker_resource_prefix: string;
	local_domain_stem: string;
	default_branch: string;
}

export interface ServiceParameters {
	name: string;
	kind: "frontend" | "backend" | "worker";
	base_port: number;
	depends_on: string[];
	health_path: string;
	health_expectation: string;
	profiles: string[];
	capability?: string;
}

export interface AdvertisedPortParameters {
	port: number;
	label: string;
	profiles: string[];
	capability?: string;
}

export interface TemplateParameters {
	schema: { version: number };
	project: ProjectParameters;
	paths: {
		container_workspace: string;
		generated_state: string;
		mutable_persistence: string;
		shared_cache: string;
		common_secrets: string;
		project_secrets: string;
		cloud_persisted_environment: string;
	};
	container: {
		development_user: string;
		supported_architectures: string[];
		feature_lock_required: boolean;
		git_common_directory_mount_required: boolean;
	};
	services: ServiceParameters[];
	advertised_ports: AdvertisedPortParameters[];
	routing: {
		friendly_domain_pattern: string;
		direct_host: string;
		host_caddy: "optional" | "required" | "disabled";
		always_publish_direct_url: boolean;
	};
	toolchain: Record<string, string>;
	capabilities: {
		supported: CapabilityMap;
		defaults: CapabilityMap;
	};
	capability_dependencies: Record<string, string[]>;
	ci: {
		affected_mode_initial: "full" | "moon";
		aggregate_gate_name: string;
		network_smoke_is_required: boolean;
		require_negative_guard_tests: boolean;
	};
	worktrees: {
		preferred_offset_modulus: number;
		collision_scan_limit: number;
		manifest_schema_version: number;
		doctor_schema_version: number;
		default_probe_timeout_seconds: number;
		startup_timeout_seconds: number;
		diagnostic_staggered_mode: boolean;
	};
	generation: {
		omit_disabled_capabilities: boolean;
		fixture_names: string[];
	};
}

export interface FixtureDefinition {
	fixture: {
		name: string;
		description: string;
	};
	project: Omit<ProjectParameters, "default_branch">;
	capabilities: CapabilityMap;
}

export class ParameterValidationError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		const sortedIssues = [...issues].sort();
		super(
			`Template parameter validation failed:\n- ${sortedIssues.join("\n- ")}`,
		);
		this.name = "ParameterValidationError";
		this.issues = sortedIssues;
	}
}

const TOP_LEVEL_KEYS = new Set([
	"schema",
	"project",
	"paths",
	"container",
	"services",
	"advertised_ports",
	"routing",
	"toolchain",
	"capabilities",
	"capability_dependencies",
	"ci",
	"worktrees",
	"generation",
]);
const FIXTURE_KEYS = new Set(["fixture", "project", "capabilities"]);
const ARCHITECTURES = new Set(["amd64", "arm64"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_PREFIX = /^[A-Z][A-Z0-9_]*$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;
const BRANCH =
	/^(?![./])(?!.*(?:\.\.|@\{|[~^:?*[\\]))(?!.*[/.]$)[A-Za-z0-9._/-]+$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 32);
}

function isSafeHomePath(value: string): boolean {
	return (
		value.startsWith("~/") &&
		value.length > 2 &&
		posix.normalize(value) === value &&
		!value.split("/").includes("..") &&
		!hasControlCharacters(value)
	);
}

function isSafeGitBranch(value: string): boolean {
	return (
		BRANCH.test(value) &&
		!value.includes("//") &&
		!value.endsWith(".lock") &&
		!value.split("/").some((component) => component.startsWith("."))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
	root: Record<string, unknown>,
	key: string,
	issues: string[],
): Record<string, unknown> {
	const value = root[key];
	if (!isRecord(value)) {
		issues.push(`${key} must be a table`);
		return {};
	}
	return value;
}

function stringAt(
	root: Record<string, unknown>,
	key: string,
	path: string,
	issues: string[],
): string {
	const value = root[key];
	if (typeof value !== "string" || value.length === 0) {
		issues.push(`${path}.${key} must be a non-empty string`);
		return "";
	}
	return value;
}

function numberAt(
	root: Record<string, unknown>,
	key: string,
	path: string,
	issues: string[],
): number {
	const value = root[key];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.push(`${path}.${key} must be an integer`);
		return 0;
	}
	return value;
}

function booleanAt(
	root: Record<string, unknown>,
	key: string,
	path: string,
	issues: string[],
): boolean {
	const value = root[key];
	if (typeof value !== "boolean") {
		issues.push(`${path}.${key} must be a boolean`);
		return false;
	}
	return value;
}

function stringArrayAt(
	root: Record<string, unknown>,
	key: string,
	path: string,
	issues: string[],
): string[] {
	const value = root[key];
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		issues.push(`${path}.${key} must be an array of strings`);
		return [];
	}
	return value as string[];
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	issues: string[],
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			issues.push(`${path}.${key} is not a recognized field`);
	}
}

function validateProject(
	project: Record<string, unknown>,
	issues: string[],
	includeDefaultBranch: boolean,
): void {
	const allowed = new Set([
		"slug",
		"display_name",
		"environment_prefix",
		"docker_resource_prefix",
		"local_domain_stem",
		...(includeDefaultBranch ? ["default_branch"] : []),
	]);
	rejectUnknownKeys(project, allowed, "project", issues);
	const slug = stringAt(project, "slug", "project", issues);
	const environmentPrefix = stringAt(
		project,
		"environment_prefix",
		"project",
		issues,
	);
	stringAt(project, "display_name", "project", issues);
	const dockerPrefix = stringAt(
		project,
		"docker_resource_prefix",
		"project",
		issues,
	);
	const domainStem = stringAt(project, "local_domain_stem", "project", issues);
	const defaultBranch = includeDefaultBranch
		? stringAt(project, "default_branch", "project", issues)
		: "";
	if (slug && !SLUG.test(slug))
		issues.push("project.slug must be lowercase kebab-case");
	if (dockerPrefix && !SLUG.test(dockerPrefix)) {
		issues.push("project.docker_resource_prefix must be lowercase kebab-case");
	}
	if (domainStem && !SLUG.test(domainStem)) {
		issues.push("project.local_domain_stem must be lowercase kebab-case");
	}
	if (environmentPrefix && !ENVIRONMENT_PREFIX.test(environmentPrefix)) {
		issues.push("project.environment_prefix must be uppercase snake-case");
	}
	if (defaultBranch && !isSafeGitBranch(defaultBranch)) {
		issues.push("project.default_branch is not a safe Git branch name");
	}
}

function validateCapabilities(
	capabilities: Record<string, unknown>,
	supported: CapabilityMap,
	path: string,
	issues: string[],
): CapabilityMap {
	const result: CapabilityMap = {};
	const expected = Object.keys(supported).sort();
	const actual = Object.keys(capabilities).sort();
	for (const missing of expected.filter((key) => !(key in capabilities))) {
		issues.push(`${path}.${missing} is required`);
	}
	for (const unknown of actual.filter((key) => !(key in supported))) {
		issues.push(`${path}.${unknown} is not supported`);
	}
	for (const key of expected) {
		const value = capabilities[key];
		if (typeof value !== "boolean") {
			issues.push(`${path}.${key} must be a boolean`);
			continue;
		}
		if (value && supported[key] !== true) {
			issues.push(`${path}.${key} cannot be enabled because it is unsupported`);
		}
		result[key] = value;
	}
	return result;
}

function validateCapabilityDependencies(
	capabilities: CapabilityMap,
	dependencies: Record<string, string[]>,
	supported: CapabilityMap,
	path: string,
	issues: string[],
): void {
	for (const [capability, requirements] of Object.entries(dependencies)) {
		if (!(capability in supported)) {
			issues.push(
				`capability_dependencies.${capability} names an unknown capability`,
			);
			continue;
		}
		for (const requirement of requirements) {
			if (!(requirement in supported)) {
				issues.push(
					`capability_dependencies.${capability} names unknown requirement ${requirement}`,
				);
			} else if (capabilities[capability] && !capabilities[requirement]) {
				issues.push(`${path}.${capability} requires ${requirement}`);
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (capability: string): void => {
		if (visiting.has(capability)) {
			issues.push(
				`capability_dependencies contains a cycle through ${capability}`,
			);
			return;
		}
		if (visited.has(capability)) return;
		visiting.add(capability);
		for (const requirement of dependencies[capability] ?? [])
			visit(requirement);
		visiting.delete(capability);
		visited.add(capability);
	};
	for (const capability of Object.keys(dependencies)) visit(capability);
}

export function validateTemplateParameters(value: unknown): TemplateParameters {
	const issues: string[] = [];
	if (!isRecord(value))
		throw new ParameterValidationError(["root must be a table"]);
	rejectUnknownKeys(value, TOP_LEVEL_KEYS, "root", issues);

	const schema = recordAt(value, "schema", issues);
	rejectUnknownKeys(schema, new Set(["version"]), "schema", issues);
	if (numberAt(schema, "version", "schema", issues) !== 1) {
		issues.push("schema.version must equal 1");
	}
	const project = recordAt(value, "project", issues);
	validateProject(project, issues, true);

	const paths = recordAt(value, "paths", issues);
	rejectUnknownKeys(
		paths,
		new Set([
			"container_workspace",
			"generated_state",
			"mutable_persistence",
			"shared_cache",
			"common_secrets",
			"project_secrets",
			"cloud_persisted_environment",
		]),
		"paths",
		issues,
	);
	const workspace = stringAt(paths, "container_workspace", "paths", issues);
	if (
		workspace &&
		(workspace === "/" ||
			!workspace.startsWith("/") ||
			posix.normalize(workspace) !== workspace ||
			hasControlCharacters(workspace))
	) {
		issues.push(
			"paths.container_workspace must be a normalized safe absolute path",
		);
	}
	for (const key of [
		"generated_state",
		"mutable_persistence",
		"shared_cache",
	]) {
		const path = stringAt(paths, key, "paths", issues);
		if (
			path &&
			(!SAFE_RELATIVE_PATH.test(path) ||
				posix.normalize(path) !== path ||
				hasControlCharacters(path))
		) {
			issues.push(`paths.${key} must be a contained relative path`);
		}
	}
	const generatedPaths = [
		"generated_state",
		"mutable_persistence",
		"shared_cache",
	].map((key) => paths[key]);
	if (new Set(generatedPaths).size !== generatedPaths.length) {
		issues.push(
			"paths generated_state, mutable_persistence, and shared_cache must be distinct",
		);
	}
	for (const key of [
		"common_secrets",
		"project_secrets",
		"cloud_persisted_environment",
	]) {
		const path = stringAt(paths, key, "paths", issues);
		if (path && !isSafeHomePath(path))
			issues.push(`paths.${key} must be a normalized contained home path`);
	}
	if (paths["common_secrets"] !== "~/.config/devcontainer/secrets") {
		issues.push("paths.common_secrets must be ~/.config/devcontainer/secrets");
	}
	if (
		paths["project_secrets"] !==
		`~/.config/devcontainer/secrets.d/${project["slug"] ?? ""}`
	) {
		issues.push("paths.project_secrets must be derived from project.slug");
	}
	if (
		paths["cloud_persisted_environment"] !==
		`~/.config/${project["slug"] ?? ""}/codex-cloud.env`
	) {
		issues.push(
			"paths.cloud_persisted_environment must be derived from project.slug",
		);
	}

	const container = recordAt(value, "container", issues);
	rejectUnknownKeys(
		container,
		new Set([
			"development_user",
			"supported_architectures",
			"feature_lock_required",
			"git_common_directory_mount_required",
		]),
		"container",
		issues,
	);
	stringAt(container, "development_user", "container", issues);
	const architectures = stringArrayAt(
		container,
		"supported_architectures",
		"container",
		issues,
	);
	if (architectures.length === 0)
		issues.push("container.supported_architectures cannot be empty");
	if (new Set(architectures).size !== architectures.length) {
		issues.push("container.supported_architectures cannot contain duplicates");
	}
	for (const architecture of architectures) {
		if (!ARCHITECTURES.has(architecture)) {
			issues.push(
				`container.supported_architectures contains unsupported ${architecture}`,
			);
		}
	}
	booleanAt(container, "feature_lock_required", "container", issues);
	booleanAt(
		container,
		"git_common_directory_mount_required",
		"container",
		issues,
	);

	const capabilitiesTable = recordAt(value, "capabilities", issues);
	rejectUnknownKeys(
		capabilitiesTable,
		new Set(["supported", "defaults"]),
		"capabilities",
		issues,
	);
	const supportedTable = recordAt(capabilitiesTable, "supported", issues);
	const supported: CapabilityMap = {};
	for (const [key, capability] of Object.entries(supportedTable)) {
		if (typeof capability !== "boolean") {
			issues.push(`capabilities.supported.${key} must be a boolean`);
		} else {
			supported[key] = capability;
		}
	}
	if (Object.keys(supported).length === 0)
		issues.push("capabilities.supported cannot be empty");
	const defaults = validateCapabilities(
		recordAt(capabilitiesTable, "defaults", issues),
		supported,
		"capabilities.defaults",
		issues,
	);

	const dependenciesTable = recordAt(value, "capability_dependencies", issues);
	const dependencies: Record<string, string[]> = {};
	for (const [capability, requirementValue] of Object.entries(
		dependenciesTable,
	)) {
		if (
			!Array.isArray(requirementValue) ||
			requirementValue.some((item) => typeof item !== "string")
		) {
			issues.push(
				`capability_dependencies.${capability} must be an array of strings`,
			);
			continue;
		}
		const requirements = requirementValue as string[];
		if (new Set(requirements).size !== requirements.length) {
			issues.push(
				`capability_dependencies.${capability} cannot contain duplicates`,
			);
		}
		dependencies[capability] = requirements;
	}
	validateCapabilityDependencies(
		defaults,
		dependencies,
		supported,
		"capabilities.defaults",
		issues,
	);

	const generation = recordAt(value, "generation", issues);
	rejectUnknownKeys(
		generation,
		new Set(["omit_disabled_capabilities", "fixture_names"]),
		"generation",
		issues,
	);
	if (
		!booleanAt(generation, "omit_disabled_capabilities", "generation", issues)
	) {
		issues.push("generation.omit_disabled_capabilities must be true");
	}
	const fixtureNames = stringArrayAt(
		generation,
		"fixture_names",
		"generation",
		issues,
	);
	if (fixtureNames.join(",") !== "minimal,cloud,full") {
		issues.push(
			"generation.fixture_names must be ordered minimal, cloud, full",
		);
	}
	const fixtureNameSet = new Set(fixtureNames);

	const serviceValue = value["services"];
	const services: ServiceParameters[] = [];
	if (!Array.isArray(serviceValue)) {
		issues.push("services must be an array of tables");
	} else {
		const names = new Set<string>();
		const ports = new Set<number>();
		for (const [index, rawService] of serviceValue.entries()) {
			if (!isRecord(rawService)) {
				issues.push(`services[${index}] must be a table`);
				continue;
			}
			const path = `services[${index}]`;
			rejectUnknownKeys(
				rawService,
				new Set([
					"name",
					"kind",
					"base_port",
					"depends_on",
					"health_path",
					"health_expectation",
					"profiles",
					"capability",
				]),
				path,
				issues,
			);
			const name = stringAt(rawService, "name", path, issues);
			const kind = stringAt(rawService, "kind", path, issues);
			const basePort = numberAt(rawService, "base_port", path, issues);
			const dependsOn = stringArrayAt(rawService, "depends_on", path, issues);
			const profiles = stringArrayAt(rawService, "profiles", path, issues);
			const healthPath = stringAt(rawService, "health_path", path, issues);
			const healthExpectation = stringAt(
				rawService,
				"health_expectation",
				path,
				issues,
			);
			const capability = rawService["capability"];
			if (name && !SERVICE_NAME.test(name))
				issues.push(`${path}.name must be kebab-case`);
			if (names.has(name)) issues.push(`${path}.name duplicates ${name}`);
			names.add(name);
			if (!new Set(["frontend", "backend", "worker"]).has(kind)) {
				issues.push(`${path}.kind is unsupported`);
			}
			if (basePort < 1024 || basePort > 65535)
				issues.push(`${path}.base_port is out of range`);
			if (ports.has(basePort))
				issues.push(`${path}.base_port duplicates ${basePort}`);
			ports.add(basePort);
			if (new Set(dependsOn).size !== dependsOn.length) {
				issues.push(`${path}.depends_on cannot contain duplicates`);
			}
			if (profiles.length === 0)
				issues.push(`${path}.profiles cannot be empty`);
			for (const profile of profiles) {
				if (!fixtureNameSet.has(profile))
					issues.push(`${path}.profiles contains unknown ${profile}`);
			}
			if (!healthPath.startsWith("/"))
				issues.push(`${path}.health_path must start with /`);
			if (
				!new Set(["http-2xx", "http-2xx-html", "json-status-ok"]).has(
					healthExpectation,
				)
			) {
				issues.push(`${path}.health_expectation is unsupported`);
			}
			if (
				capability !== undefined &&
				(typeof capability !== "string" || !(capability in supported))
			) {
				issues.push(`${path}.capability must name a supported capability`);
			}
			services.push({
				name,
				kind: kind as ServiceParameters["kind"],
				base_port: basePort,
				depends_on: dependsOn,
				health_path: healthPath,
				health_expectation: healthExpectation,
				profiles,
				...(typeof capability === "string" ? { capability } : {}),
			});
		}
		for (const [index, service] of services.entries()) {
			for (const dependency of service.depends_on) {
				const dependencyService = services.find(
					(candidate) => candidate.name === dependency,
				);
				if (!dependencyService) {
					issues.push(`services[${index}] depends on unknown ${dependency}`);
				} else {
					for (const profile of service.profiles) {
						if (!dependencyService.profiles.includes(profile)) {
							issues.push(
								`services[${index}] dependency ${dependency} is unavailable in profile ${profile}`,
							);
						}
					}
					if (dependencyService.capability && !service.capability) {
						issues.push(
							`services[${index}] dependency ${dependency} is capability-gated but ${service.name} is not`,
						);
					}
				}
				if (dependency === service.name)
					issues.push(`services[${index}] cannot depend on itself`);
			}
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const byName = new Map(services.map((service) => [service.name, service]));
		const visit = (name: string): void => {
			if (visiting.has(name)) {
				issues.push(`services contain a dependency cycle through ${name}`);
				return;
			}
			if (visited.has(name)) return;
			visiting.add(name);
			for (const dependency of byName.get(name)?.depends_on ?? [])
				visit(dependency);
			visiting.delete(name);
			visited.add(name);
		};
		for (const service of services) visit(service.name);
	}

	const advertisedPortValue = value["advertised_ports"];
	const advertisedPorts: AdvertisedPortParameters[] = [];
	if (!Array.isArray(advertisedPortValue) || advertisedPortValue.length === 0) {
		issues.push("advertised_ports must be a non-empty array of tables");
	} else {
		const seenPorts = new Set<number>();
		for (const [index, rawPort] of advertisedPortValue.entries()) {
			if (!isRecord(rawPort)) {
				issues.push(`advertised_ports[${index}] must be a table`);
				continue;
			}
			const path = `advertised_ports[${index}]`;
			rejectUnknownKeys(
				rawPort,
				new Set(["port", "label", "profiles", "capability"]),
				path,
				issues,
			);
			const port = numberAt(rawPort, "port", path, issues);
			const label = stringAt(rawPort, "label", path, issues);
			const profiles = stringArrayAt(rawPort, "profiles", path, issues);
			const capability = rawPort["capability"];
			if (port < 1024 || port > 65535)
				issues.push(`${path}.port is out of range`);
			if (seenPorts.has(port)) issues.push(`${path}.port duplicates ${port}`);
			seenPorts.add(port);
			if (profiles.length === 0)
				issues.push(`${path}.profiles cannot be empty`);
			for (const profile of profiles) {
				if (!fixtureNameSet.has(profile))
					issues.push(`${path}.profiles contains unknown ${profile}`);
			}
			if (
				capability !== undefined &&
				(typeof capability !== "string" || !(capability in supported))
			) {
				issues.push(`${path}.capability must name a supported capability`);
			}
			advertisedPorts.push({
				port,
				label,
				profiles,
				...(typeof capability === "string" ? { capability } : {}),
			});
		}
	}

	const routing = recordAt(value, "routing", issues);
	rejectUnknownKeys(
		routing,
		new Set([
			"friendly_domain_pattern",
			"direct_host",
			"host_caddy",
			"always_publish_direct_url",
		]),
		"routing",
		issues,
	);
	const domainPattern = stringAt(
		routing,
		"friendly_domain_pattern",
		"routing",
		issues,
	);
	if (domainPattern && !domainPattern.includes("{workspace}")) {
		issues.push("routing.friendly_domain_pattern must contain {workspace}");
	}
	if (domainPattern && !domainPattern.includes("{project}")) {
		issues.push("routing.friendly_domain_pattern must contain {project}");
	}
	if (
		domainPattern &&
		(!domainPattern.endsWith(".localhost") ||
			hasControlCharacters(domainPattern))
	) {
		issues.push(
			"routing.friendly_domain_pattern must be a safe .localhost domain",
		);
	}
	if (stringAt(routing, "direct_host", "routing", issues) !== "127.0.0.1") {
		issues.push("routing.direct_host must be 127.0.0.1");
	}
	const hostCaddy = stringAt(routing, "host_caddy", "routing", issues);
	if (!new Set(["optional", "required", "disabled"]).has(hostCaddy)) {
		issues.push("routing.host_caddy is unsupported");
	}
	booleanAt(routing, "always_publish_direct_url", "routing", issues);

	const toolchain = recordAt(value, "toolchain", issues);
	rejectUnknownKeys(
		toolchain,
		new Set([
			"package_manager",
			"proto_manifest",
			"package_manifest",
			"package_lock",
			"feature_lock",
		]),
		"toolchain",
		issues,
	);
	for (const key of [
		"package_manager",
		"proto_manifest",
		"package_manifest",
		"package_lock",
		"feature_lock",
	]) {
		stringAt(toolchain, key, "toolchain", issues);
	}
	if (toolchain["package_manager"] !== "bun")
		issues.push("toolchain.package_manager must be bun");

	const ci = recordAt(value, "ci", issues);
	rejectUnknownKeys(
		ci,
		new Set([
			"affected_mode_initial",
			"aggregate_gate_name",
			"network_smoke_is_required",
			"require_negative_guard_tests",
		]),
		"ci",
		issues,
	);
	const affectedMode = stringAt(ci, "affected_mode_initial", "ci", issues);
	if (affectedMode !== "full" && affectedMode !== "moon") {
		issues.push("ci.affected_mode_initial must be full or moon");
	}
	stringAt(ci, "aggregate_gate_name", "ci", issues);
	if (booleanAt(ci, "network_smoke_is_required", "ci", issues)) {
		issues.push("ci.network_smoke_is_required must be false");
	}
	if (!booleanAt(ci, "require_negative_guard_tests", "ci", issues)) {
		issues.push("ci.require_negative_guard_tests must be true");
	}
	if (
		affectedMode === "moon" &&
		(!defaults["moon"] || !defaults["moon_affected_selection"])
	) {
		issues.push(
			"ci.affected_mode_initial moon requires moon and moon_affected_selection",
		);
	}

	const worktrees = recordAt(value, "worktrees", issues);
	rejectUnknownKeys(
		worktrees,
		new Set([
			"preferred_offset_modulus",
			"collision_scan_limit",
			"manifest_schema_version",
			"doctor_schema_version",
			"default_probe_timeout_seconds",
			"startup_timeout_seconds",
			"diagnostic_staggered_mode",
		]),
		"worktrees",
		issues,
	);
	for (const key of [
		"preferred_offset_modulus",
		"collision_scan_limit",
		"manifest_schema_version",
		"doctor_schema_version",
		"default_probe_timeout_seconds",
		"startup_timeout_seconds",
	]) {
		if (numberAt(worktrees, key, "worktrees", issues) <= 0) {
			issues.push(`worktrees.${key} must be positive`);
		}
	}
	booleanAt(worktrees, "diagnostic_staggered_mode", "worktrees", issues);

	if (issues.length > 0) throw new ParameterValidationError(issues);
	return value as unknown as TemplateParameters;
}

export function validateFixtureDefinition(
	value: unknown,
	parameters: TemplateParameters,
): FixtureDefinition {
	const issues: string[] = [];
	if (!isRecord(value))
		throw new ParameterValidationError(["fixture root must be a table"]);
	rejectUnknownKeys(value, FIXTURE_KEYS, "fixture root", issues);
	const fixture = recordAt(value, "fixture", issues);
	rejectUnknownKeys(
		fixture,
		new Set(["name", "description"]),
		"fixture",
		issues,
	);
	const name = stringAt(fixture, "name", "fixture", issues);
	stringAt(fixture, "description", "fixture", issues);
	if (!parameters.generation.fixture_names.includes(name)) {
		issues.push(
			`fixture.name must be one of ${parameters.generation.fixture_names.join(", ")}`,
		);
	}
	const project = recordAt(value, "project", issues);
	validateProject(project, issues, false);
	const capabilities = validateCapabilities(
		recordAt(value, "capabilities", issues),
		parameters.capabilities.supported,
		"capabilities",
		issues,
	);
	validateCapabilityDependencies(
		capabilities,
		parameters.capability_dependencies,
		parameters.capabilities.supported,
		"capabilities",
		issues,
	);
	if (issues.length > 0) throw new ParameterValidationError(issues);
	return value as unknown as FixtureDefinition;
}

export async function parseToml(path: string): Promise<unknown> {
	const source = await Bun.file(path).text();
	try {
		return Bun.TOML.parse(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ParameterValidationError([`${path}: invalid TOML: ${message}`]);
	}
}

export async function loadTemplateParameters(
	root: string,
): Promise<TemplateParameters> {
	const value = await parseToml(resolve(root, "template-parameters.toml"));
	const schema = (await Bun.file(
		resolve(root, "template-parameters.schema.json"),
	).json()) as Record<string, unknown>;
	const schemaIssues = validateJsonSchema(value, schema);
	if (schemaIssues.length > 0) {
		throw new ParameterValidationError(
			schemaIssues.map((issue) => `schema: ${issue}`),
		);
	}
	return validateTemplateParameters(value);
}

export async function loadFixtureDefinition(
	root: string,
	fixtureName: string,
	parameters: TemplateParameters,
): Promise<FixtureDefinition> {
	if (!parameters.generation.fixture_names.includes(fixtureName)) {
		throw new ParameterValidationError([`unknown fixture ${fixtureName}`]);
	}
	const fixture = validateFixtureDefinition(
		await parseToml(
			resolve(root, "fixtures", "template", `${fixtureName}.toml`),
		),
		parameters,
	);
	if (fixture.fixture.name !== fixtureName) {
		throw new ParameterValidationError([
			`fixture ${fixtureName} declares mismatched name ${fixture.fixture.name}`,
		]);
	}
	return fixture;
}

export function resolveFixtureParameters(
	parameters: TemplateParameters,
	fixture: FixtureDefinition,
): TemplateParameters {
	const resolved = structuredClone(parameters);
	resolved.project = {
		...resolved.project,
		...fixture.project,
	};
	resolved.paths.project_secrets = `~/.config/devcontainer/secrets.d/${fixture.project.slug}`;
	resolved.paths.cloud_persisted_environment = `~/.config/${fixture.project.slug}/codex-cloud.env`;
	resolved.capabilities.defaults = structuredClone(fixture.capabilities);
	return validateTemplateParameters(resolved);
}
