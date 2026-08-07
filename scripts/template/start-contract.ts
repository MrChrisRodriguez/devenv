// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import {
	type Dirent,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "start-surface.json";
export const REGISTRY_SCHEMA_PATH = "start-surface.schema.json";
export const GUARD_CONTRACT = "scripts/template/start-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-start.ts";
export const GUARD_SCRIPT = "start:check";

// The capability that owns every file this stage adds. Named here and in no
// core module, for the reason every gated guard names it in exactly one place:
// `ci-contract.ts` ships to EVERY rendered project and the anti-residue scan is
// a plain substring search over every file of a render whose capability is off.
export const CAPABILITY = "tanstack_start";

// The shared TypeScript base Stage 0 reserved for this capability before
// anything extended it. It is the one artefact of this stack that already
// existed in this tree, and it has been wrong since the day it was reserved:
// nothing in the repository compiles it, so no gate has ever read it.
export const RESERVED_TSCONFIG_PATH = "tsconfig.start.base.json";

// Every file this capability adds, and the only list of them. Ownership,
// gating, residue and the wiring assertions all read it, so a fifth file cannot
// be added in one place and forgotten in the others. The reserved TypeScript
// base is deliberately NOT here: Stage 0 already gated it, and re-declaring an
// existing reservation would make the diff say this stage created it.
export const GATED_PATHS = [
	REGISTRY_PATH,
	REGISTRY_SCHEMA_PATH,
	GUARD_CONTRACT,
	GUARD_ENTRYPOINT,
] as const;

const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CONTRACT_JOB = "ci";
const REPOSITORY_TSCONFIG_BASE = "tsconfig.base.json";

// The core rule that already refuses `baseUrl` in every `tsconfig*.json` in the
// tree, named so this guard can record the coverage without duplicating it.
const CORE_TOOLCHAIN_SCRIPT = "toolchain:check";

// Directories no tree walk descends into. `tmp/` is where `template:fixtures`
// renders and a rendered fixture carries a full copy of this tree — walking
// into one would invent a shared TypeScript base and a generated route tree
// inside a fixture and flip the derived mode to `active`. `graphify-out/` is
// tracked here, so it has to be pruned out of the tracked list as well as out
// of the walk, and `dist/` is where this stack's own build output lands.
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"tmp",
	"graphify-out",
	"dist",
]);

const SOURCE_EXTENSIONS = new Set([
	".cjs",
	".cts",
	".js",
	".jsx",
	".mjs",
	".mts",
	".ts",
	".tsx",
]);

// Files nobody ships. A test may hand-write any shape it likes, because the
// shape is the thing under test — including an application built to be refused.
const UNSHIPPED = [
	/\.test\.[cm]?[jt]sx?$/,
	/\.spec\.[cm]?[jt]sx?$/,
	/(?:^|\/)__mocks__\//,
	/(?:^|\/)__tests__\//,
];

// ── Needles ────────────────────────────────────────────────────────────────
// Assembled at run time, because this guard scans a tree that contains this
// guard. A path exemption for the guard's own file would be a hole somebody
// eventually widens.
//
// And the one that is NOT here, deliberately: the bare word this capability is
// named for. It is the opening fence marker in the workflow, in the core
// toolchain module, in the canonical agent rules and in every gated file in the
// repository, so a bare-word residue token would fail every render of every
// profile. The reserved package scope and the guard script are the tokens, and
// both were verified against the tracked tree before they were reserved.
const PACKAGE_SCOPE = ["@tan", "stack/"].join("");
const PLUGIN_CALL = ["tanstack", "Start"].join("");
const HANDLER_CALL = ["create", "StartHandler"].join("");
const ROUTE_TREE_BASENAME = ["route", "Tree.gen.ts"].join("");

/** The needles, exported so a fixture can build a workspace out of them. */
export const NEEDLES = {
	scope: PACKAGE_SCOPE,
	pluginCall: PLUGIN_CALL,
	handlerCall: HANDLER_CALL,
	routeTree: ROUTE_TREE_BASENAME,
} as const;

export interface StartSsrDeterminism {
	timezone: string;
	locale: string;
}

export interface StartSsrPolicy {
	mode: "buffered" | "streaming";
	streamingWaiver: { reason: string } | null;
	methods: string[];
	methodRejection: { status: number; allowHeader: string };
	cacheControl: string;
	determinism: StartSsrDeterminism;
}

export interface StartServiceBinding {
	binding: string;
	service: string;
}

export interface StartWorkerPolicy {
	compatibilityDate: string;
	compatibilityFlags: string[];
	workersDev: boolean;
	previewUrls: boolean;
	serviceBindings: StartServiceBinding[];
	forbiddenBindingKinds: string[];
	harnessOnlyVariables: string[];
}

export interface StartBuildPolicy {
	outputDirectory: string;
	clientDirectory: string;
	serverModule: string;
	builtConfigPath: string;
	assetsDirectory: string;
	assetsPrefix: string;
	buildTimeVariables: string[];
}

export interface StartRouterPolicy {
	defaultPreload: boolean;
	defaultErrorComponent: boolean;
	scrollRestoration: boolean;
	caseSensitive: boolean;
}

export interface StartApp {
	id: string;
	directory: string;
	basePath: string;
	routerBasepath: string;
	assetsDir: string;
	serverEntry: string;
	clientEntry: string;
	routerModule: string;
	routeTree: string;
	wranglerConfig: string;
	ambientDeclarations: string[];
	clientOnlyModules: string[];
	proxyRouteId: string | null;
}

export interface StartSurface {
	schemaVersion: 1;
	mode: "skeleton" | "active";
	tsconfigPath: string;
	devServer: "wrangler" | "vite";
	viteDevWaiver: { reason: string } | null;
	proxyRegistryPath: string;
	types: string[];
	forbiddenTypes: string[];
	ssr: StartSsrPolicy;
	worker: StartWorkerPolicy;
	build: StartBuildPolicy;
	router: StartRouterPolicy;
	apps: StartApp[];
}

/** What the tree looks like, independent of what the registry claims. */
export type SurfaceShape =
	| "route-tree"
	| "framework-dependency"
	| "framework-call"
	| "extending-project";

export interface SurfaceSignal {
	path: string;
	shape: SurfaceShape;
	detail: string;
}

export interface TreeState {
	/** `active` the moment ANY declared-surface shape exists anywhere. */
	mode: "skeleton" | "active";
	signals: SurfaceSignal[];
	/** How many files the walk actually read. Zero is a failure, not a pass. */
	scanned: number;
	errors: string[];
}

export interface StartContractOptions {
	/** Reserved for the legs that need a binary or a Git object. */
	root?: string;
}

export interface StartReport {
	errors: string[];
	notices: string[];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function textOf(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Whether this tree is the template itself rather than a project rendered from
 * it. The parameter file is the marker every other consumer already uses, and
 * the distinction matters because the renderer removes capability fences along
 * with the blocks it keeps — so "the step is fenced" is only ever a question
 * about the source tree.
 */
function isTemplateTree(root: string): boolean {
	return exists(resolve(root, "template-parameters.toml"));
}

function posixPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
	const index = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	return index > slash ? path.slice(index) : "";
}

function excluded(path: string): boolean {
	return path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

export function isSourceFile(path: string): boolean {
	return SOURCE_EXTENSIONS.has(extensionOf(path));
}

export function isShipped(path: string): boolean {
	return !UNSHIPPED.some((pattern) => pattern.test(path));
}

/** A repository-relative path joined against another one, POSIX-style. */
export function joinRelative(from: string, target: string): string {
	const segments = from.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
}

function trackedFiles(root: string): string[] | undefined {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\0").filter(Boolean);
}

/**
 * Every file this guard is allowed to have an opinion about.
 *
 * The index is the authority where there is one, because "committed" is the
 * question every rule here actually asks — this stack's generated route tree is
 * governed as a committed artefact, so "is it tracked" is a rule and not an
 * implementation detail. A rendered fixture is not a Git repository, so the
 * fallback is a pruned directory walk, and both paths share one exclusion list.
 */
export function enumerateFiles(root: string): string[] {
	const tracked = trackedFiles(root);
	if (tracked) return tracked.filter((path) => !excluded(path)).sort();
	const found: string[] = [];
	const walk = (directory: string, depth: number): void => {
		if (depth > 12) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const child = join(directory, entry.name);
			if (entry.isDirectory()) walk(child, depth + 1);
			else if (entry.isFile()) found.push(posixPath(root, child));
		}
	};
	walk(root, 0);
	return found.sort();
}

/** Whether the tracked index knows this path, when there is a tracked index. */
export function isTracked(root: string, path: string): boolean | undefined {
	const tracked = trackedFiles(root);
	if (!tracked) return undefined;
	return tracked.includes(path);
}

type TypeScriptApi = typeof import("typescript");
type Node = import("typescript").Node;
type SourceFile = import("typescript").SourceFile;

let compiler: TypeScriptApi | undefined;
let compilerResolved = false;

/**
 * The catalog-pinned compiler, resolved lazily and through `createRequire`.
 *
 * A regex over TypeScript is a substring search wearing a contract's clothes.
 * Here it would also be the wrong tool for the question: this stack's marker is
 * a CALL, and a call appears in prose, in a changelog and in a commented-out
 * line without being one.
 */
export function typescript(): TypeScriptApi | undefined {
	if (compilerResolved) return compiler;
	compilerResolved = true;
	try {
		const loaded = createRequire(import.meta.url)("typescript") as
			| Partial<TypeScriptApi>
			| undefined;
		// The SHAPE is checked and not merely the resolution. A rendered project
		// has no `node_modules` until it installs, and a resolver that answers with
		// something that is not the compiler would make every syntax leg below
		// return "found nothing" — the vacuous pass this guard exists to refuse.
		compiler =
			typeof loaded?.createSourceFile === "function" &&
			typeof loaded.forEachChild === "function" &&
			loaded.ScriptTarget !== undefined
				? (loaded as TypeScriptApi)
				: undefined;
	} catch {
		compiler = undefined;
	}
	return compiler;
}

export function parseSource(
	path: string,
	source: string,
): SourceFile | undefined {
	const api = typescript();
	if (!api) return undefined;
	return api.createSourceFile(
		path,
		source,
		api.ScriptTarget.Latest,
		true,
		path.endsWith("x") ? api.ScriptKind.TSX : api.ScriptKind.TS,
	);
}

export function eachNode(node: Node, visit: (node: Node) => void): void {
	const api = typescript();
	if (!api) return;
	const walk = (current: Node): void => {
		visit(current);
		api.forEachChild(current, walk);
	};
	walk(node);
}

/**
 * Whether a source file CALLS one of this stack's two entry helpers.
 *
 * Read off the AST and never off the text, so that a changelog paragraph naming
 * the plugin is not an application and a fixture that mentions the handler in a
 * string is not one either.
 */
export function callsFrameworkEntry(
	path: string,
	source: string,
): string | undefined {
	const api = typescript();
	const file = parseSource(path, source);
	if (!api || !file) return undefined;
	let found: string | undefined;
	eachNode(file, (node) => {
		if (found !== undefined || !api.isCallExpression(node)) return;
		const callee = node.expression;
		if (!api.isIdentifier(callee)) return;
		if (callee.text === PLUGIN_CALL || callee.text === HANDLER_CALL)
			found = callee.text;
	});
	return found;
}

/** Whether the manifest depends on this stack's package scope, in any section. */
export function declaresFrameworkDependency(
	manifest: JsonRecord,
): string | undefined {
	const sections: JsonRecord[] = [
		isRecord(manifest["dependencies"]) ? manifest["dependencies"] : {},
		isRecord(manifest["devDependencies"]) ? manifest["devDependencies"] : {},
		isRecord(manifest["optionalDependencies"])
			? manifest["optionalDependencies"]
			: {},
	];
	const workspaces = isRecord(manifest["workspaces"])
		? manifest["workspaces"]
		: {};
	if (isRecord(workspaces["catalog"])) sections.push(workspaces["catalog"]);
	for (const section of sections) {
		for (const name of Object.keys(section)) {
			if (name.startsWith(PACKAGE_SCOPE)) return name;
		}
	}
	return undefined;
}

/** Every path a `tsconfig*.json` extends, resolved against its own location. */
export function extendedConfigs(path: string, source: string): string[] {
	let value: unknown;
	try {
		value = Bun.JSONC.parse(source) as unknown;
	} catch {
		return [];
	}
	if (!isRecord(value)) return [];
	const declared = value["extends"];
	const entries =
		typeof declared === "string" ? [declared] : strings(declared ?? []);
	return entries
		.filter((entry) => entry.startsWith("."))
		.map((entry) => joinRelative(path, entry));
}

function isTsconfig(path: string): boolean {
	const basename = basenameOf(path);
	return basename.startsWith("tsconfig") && basename.endsWith(".json");
}

/**
 * What the tree actually carries, derived and never declared.
 *
 * This is the half of the reconciliation the registry cannot lie about. Four
 * shapes, each the visible consequence of an application of this stack
 * existing: a generated route tree at any depth, a dependency on the framework
 * scope in any manifest section, a source file that calls one of the two entry
 * helpers, and a project that extends the shared base — which is the one shape
 * that turns the base from a file nothing compiles into a file something does.
 */
export function deriveTreeState(
	root: string,
	contract?: StartSurface,
): TreeState {
	const files = enumerateFiles(root);
	const signals: SurfaceSignal[] = [];
	const errors: string[] = [];
	if (files.length === 0)
		errors.push(
			`start: the tracked-file scan found nothing under ${root}; a rule with no input has answered nothing`,
		);
	const basePath = contract?.tsconfigPath ?? RESERVED_TSCONFIG_PATH;
	let compilerMissing = false;
	for (const path of files) {
		if (basenameOf(path) === ROUTE_TREE_BASENAME) {
			signals.push({
				path,
				shape: "route-tree",
				detail: `${path} is a generated route tree, and its presence is what marks this project as carrying an application of this stack`,
			});
		}
		if (basenameOf(path) === "package.json") {
			let manifest: JsonRecord | undefined;
			try {
				manifest = JSON.parse(textOf(resolve(root, path))) as JsonRecord;
			} catch {
				manifest = undefined;
			}
			const declared = manifest && declaresFrameworkDependency(manifest);
			if (declared !== undefined)
				signals.push({
					path,
					shape: "framework-dependency",
					detail: `${path} depends on ${declared}`,
				});
		}
		if (isTsconfig(path) && path !== basePath) {
			const extended = extendedConfigs(path, textOf(resolve(root, path)));
			if (extended.includes(basePath))
				signals.push({
					path,
					shape: "extending-project",
					detail: `${path} extends ${basePath}, so the shared base is compiled by something`,
				});
		}
		if (!isSourceFile(path) || !isShipped(path)) continue;
		const source = textOf(resolve(root, path));
		if (source === "") continue;
		if (typescript() === undefined) {
			compilerMissing = true;
			continue;
		}
		const called = callsFrameworkEntry(path, source);
		if (called !== undefined)
			signals.push({
				path,
				shape: "framework-call",
				detail: `${path} calls ${called}`,
			});
	}
	if (compilerMissing)
		errors.push(
			`start: the TypeScript compiler API is unavailable; run bun install before ${GUARD_SCRIPT}`,
		);
	signals.sort((left, right) =>
		`${left.path}:${left.shape}`.localeCompare(`${right.path}:${right.shape}`),
	);
	return {
		mode: signals.length > 0 ? "active" : "skeleton",
		signals,
		scanned: files.length,
		errors,
	};
}

/**
 * The committed declaration, read and shape-checked against its own schema.
 *
 * Returns `undefined` when the registry is absent or unreadable; the caller
 * turns that into a named error rather than into a skipped leg.
 */
export async function readStartSurface(
	root: string,
): Promise<{ contract?: StartSurface; errors: string[] }> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`start: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`start: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`start: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`start: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `start: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { contract: value as StartSurface, errors };
}

/**
 * The registry is the only one, and every declared thing is declared once.
 *
 * A second registry anywhere in the tree is the same defect as a second matrix
 * universe registry: two files claiming to be the authority means neither is.
 * The same applies one level down — an application id declared twice, a
 * directory claimed twice, a public prefix claimed twice, or one proxy route id
 * claimed by two applications, all leave two answers to a question the registry
 * exists to answer once.
 */
export function validateSoleDeclarations(
	files: string[],
	contract: StartSurface | undefined,
): string[] {
	const errors: string[] = [];
	for (const path of files) {
		if (path === REGISTRY_PATH) continue;
		if (basenameOf(path) === REGISTRY_PATH)
			errors.push(
				`start: ${path} is a second application surface registry; ${REGISTRY_PATH} is the only one`,
			);
	}
	if (!contract) return errors.sort();
	const seenId = new Set<string>();
	for (const app of contract.apps) {
		if (seenId.has(app.id))
			errors.push(`start: ${app.id} is declared twice as an application`);
		seenId.add(app.id);
	}
	const seenDirectory = new Map<string, string>();
	for (const app of contract.apps) {
		const declared = seenDirectory.get(app.directory);
		if (declared !== undefined)
			errors.push(
				`start: the directory ${app.directory} is claimed by both ${declared} and ${app.id}`,
			);
		else seenDirectory.set(app.directory, app.id);
	}
	const seenBasePath = new Map<string, string>();
	for (const app of contract.apps) {
		const declared = seenBasePath.get(app.basePath);
		if (declared !== undefined)
			errors.push(
				`start: the public prefix ${app.basePath} is claimed by both ${declared} and ${app.id}`,
			);
		else seenBasePath.set(app.basePath, app.id);
	}
	const seenRoute = new Map<string, string>();
	for (const app of contract.apps) {
		if (app.proxyRouteId === null) continue;
		const declared = seenRoute.get(app.proxyRouteId);
		if (declared !== undefined)
			errors.push(
				`start: the proxy route ${app.proxyRouteId} is claimed by both ${declared} and ${app.id}`,
			);
		else seenRoute.set(app.proxyRouteId, app.id);
	}
	return errors.sort();
}

/**
 * The declared mode against the derived one, in both directions.
 *
 * This is what keeps every leg below it from being a no-op. A query over a tree
 * with no application is trivially true, so "found nothing, passed" would be the
 * normal outcome for a template that generates none — and a rule whose normal
 * outcome is silence is not a rule. This is not a hypothetical here: the shared
 * base this registry governs has been wrong since it was written and every gate
 * has been green, because nothing in the repository compiles it.
 */
export function reconcileMode(
	contract: StartSurface,
	state: TreeState,
): string[] {
	const errors: string[] = [...state.errors];
	if (contract.mode === "skeleton") {
		for (const signal of state.signals)
			errors.push(
				`start: ${REGISTRY_PATH} declares skeleton mode but ${signal.detail}`,
			);
		if (contract.apps.length > 0)
			errors.push(
				`start: ${REGISTRY_PATH} declares skeleton mode but declares ${contract.apps.length} applications`,
			);
		return errors.sort();
	}
	if (contract.apps.length === 0)
		errors.push(
			`start: ${REGISTRY_PATH} declares active mode but declares no application`,
		);
	if (state.mode === "skeleton")
		errors.push(
			`start: ${REGISTRY_PATH} declares active mode but no tracked file carries a generated route tree, a framework dependency, a framework entry call or a project extending ${contract.tsconfigPath}`,
		);
	return errors.sort();
}

/**
 * The capability fence a line sits inside, or `"absent"` when the line is not
 * in the file at all.
 *
 * The renderer has no inverse fence: a fenced block is simply gone, with no
 * `else` branch. So "the step is fenced" and "the step exists" are two
 * different failures with two different fixes, and collapsing them would send
 * the reader to the wrong file.
 */
export function fencedCapabilityOf(
	source: string,
	needle: string,
): string | "absent" | undefined {
	let current: string | undefined;
	for (const line of source.split("\n")) {
		const start = /^\s*#\s*capability:start\s+([a-z0-9_]+)\s*$/.exec(line);
		if (start?.[1]) {
			current = start[1];
			continue;
		}
		if (/^\s*#\s*capability:end\s+[a-z0-9_]+\s*$/.test(line)) {
			current = undefined;
			continue;
		}
		if (line.includes(needle)) return current;
	}
	return "absent";
}

function contractJobStep(
	source: string,
	invocation: string,
): JsonRecord | undefined {
	let workflow: unknown;
	try {
		workflow = Bun.YAML.parse(source) as unknown;
	} catch {
		return undefined;
	}
	if (!isRecord(workflow)) return undefined;
	const jobs = workflow["jobs"];
	if (!isRecord(jobs)) return undefined;
	const job = jobs[CONTRACT_JOB];
	if (!isRecord(job)) return undefined;
	return records(job["steps"]).find(
		(step) =>
			typeof step["run"] === "string" && step["run"].includes(invocation),
	);
}

/**
 * Everything a declaration promises exists, and everything the guard needs in
 * order to be run at all.
 *
 * A contract module that ships downstream and is never executed there is
 * documentation with an import statement, so the package script, the workflow
 * step and the fence around it are all part of the contract.
 */
export async function validateWiring(
	root: string,
	contract: StartSurface | undefined,
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of GATED_PATHS) {
		if (!exists(resolve(root, path))) errors.push(`start: ${path} is missing`);
	}
	const manifestPath = resolve(root, "package.json");
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`start: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const fence = fencedCapabilityOf(source, invocation);
		if (fence === "absent")
			errors.push(
				`start: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else {
			// The fence is a fact about the TEMPLATE, not about a render: the renderer
			// deletes the markers along with the blocks it keeps, so a generated
			// project's step is correctly unfenced.
			if (isTemplateTree(root) && fence !== CAPABILITY)
				errors.push(
					`start: the \`${invocation}\` step must sit inside a ${CAPABILITY} capability fence`,
				);
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`start: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`start: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	if (contract && !exists(resolve(root, contract.tsconfigPath)))
		errors.push(
			`start: ${REGISTRY_PATH} declares ${contract.tsconfigPath}, which is missing`,
		);
	return errors.sort();
}

/**
 * Template ownership, which is where a capability's files become a capability.
 *
 * The `copy` entries must precede the `scripts/template/**` omit catch-all or
 * the render drops the guard while `package.json` still declares the script —
 * which the fixture suite catches as a DIFFERENT error and sends you looking in
 * the wrong file. The reserved TypeScript base is gated here even though nothing
 * extends it, because Stage 0 reserved it before anything existed to put in it
 * and a reservation nothing asserts is a reservation nobody maintains.
 */
export async function validateOwnership(root: string): Promise<string[]> {
	const errors: string[] = [];
	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (!exists(ownershipPath)) return errors;
	const ownership = (await Bun.file(ownershipPath).json()) as JsonRecord;
	const rules = records(ownership["ownershipRules"]);
	const templateCatchAll = rules.findIndex(
		(entry) => entry["pattern"] === "scripts/template/**",
	);
	const rootCatchAll = rules.findIndex((entry) => entry["pattern"] === "*");
	for (const pattern of GATED_PATHS) {
		const index = rules.findIndex((entry) => entry["pattern"] === pattern);
		const blocking = pattern.startsWith("scripts/template/")
			? templateCatchAll
			: rootCatchAll;
		if (
			index < 0 ||
			(blocking >= 0 && index > blocking) ||
			rules[index]?.["renderPolicy"] !== "copy"
		)
			errors.push(`start: template ownership must cover ${pattern}`);
	}
	const artifacts = records(ownership["artifactRules"]);
	for (const pattern of [...GATED_PATHS, RESERVED_TSCONFIG_PATH]) {
		const rule = artifacts.find((entry) => entry["pattern"] === pattern);
		const requires = Array.isArray(rule?.["requiresAll"])
			? rule["requiresAll"]
			: [];
		if (!requires.includes(CAPABILITY))
			errors.push(`start: ${pattern} must be gated by the capability`);
	}
	const packageRules = records(ownership["packageRules"]);
	const packageRule = packageRules.find(
		(entry) => entry["capability"] === CAPABILITY,
	);
	const packageScripts = Array.isArray(packageRule?.["scripts"])
		? packageRule["scripts"]
		: [];
	if (!packageScripts.includes(GUARD_SCRIPT))
		errors.push(
			`start: the ${CAPABILITY} package rule must strip the ${GUARD_SCRIPT} script`,
		);
	const signatures = isRecord(ownership["capabilitySignatures"])
		? ownership["capabilitySignatures"]
		: {};
	const signature = isRecord(signatures[CAPABILITY])
		? signatures[CAPABILITY]
		: {};
	const signaturePaths = strings(signature["paths"]);
	for (const pattern of [...GATED_PATHS, RESERVED_TSCONFIG_PATH]) {
		if (!signaturePaths.includes(pattern))
			errors.push(`start: ${pattern} must be a declared capability signature`);
	}
	const signatureTokens = strings(signature["tokens"]);
	// The package scope JOINS the Stage 0 reservation rather than replacing it.
	// The reserved string names a package that no longer exists — the pre-release
	// name of this framework — so the reservation cannot fire at all, while the
	// scope is the shape a real dependency actually carries. The reserved string
	// stays in the array so it remains legible in the diff and in the record.
	for (const token of [PACKAGE_SCOPE, GUARD_SCRIPT]) {
		if (!signatureTokens.includes(token))
			errors.push(
				`start: ${token} must be a declared capability signature token`,
			);
	}
	const inventory = isRecord(ownership["capabilityInventory"])
		? ownership["capabilityInventory"]
		: {};
	for (const field of ["absent", "advertisedOnly"]) {
		if (strings(inventory[field]).includes(CAPABILITY))
			errors.push(
				`start: ${CAPABILITY} ships a guard surface and must leave the ${field} inventory`,
			);
	}
	return errors.sort();
}

/**
 * The development runtime, declared and not assumed.
 *
 * The measurement this rule exists for belongs to the repository that runs four
 * of these applications in production: it drives the BUILT worker under the
 * pinned command-line tool rather than a bundler dev server, and it wrote down
 * both reasons — the harness then exercises the production artefact, and the
 * whole class of dev-server-only module-resolution failures disappears, because
 * under a bundler dev server the worker runtime resolves modules at request time
 * and internal subpath imports fail the server render with `Cannot find module`
 * while the build bundles them.
 *
 * It is a waivable refusal rather than a silent notice, so the guard prints the
 * reason it was given and the next reader inherits the argument. And a waiver
 * that lifts nothing is refused in turn: a stale exemption widens itself.
 */
export function validateDevServerPolicy(contract: StartSurface): StartReport {
	if (contract.devServer !== "vite")
		return {
			errors:
				contract.viteDevWaiver === null
					? []
					: [
							`start: ${REGISTRY_PATH} carries a development server waiver that lifts nothing; a stale exemption widens itself`,
						],
			notices: [],
		};
	if (contract.viteDevWaiver === null)
		return {
			errors: [
				`start: ${REGISTRY_PATH} declares a bundler development server; the built worker under the pinned command-line tool is the declared runtime, because a dev server resolves modules at request time and fails the server render with a module-resolution error the build does not have`,
			],
			notices: [],
		};
	return {
		errors: [],
		notices: [
			`start: the bundler development server is declared under a waiver: ${contract.viteDevWaiver.reason}`,
		],
	};
}

/**
 * The declared proxy route ids against the development proxy registry.
 *
 * This is the whole of what a declared capability dependency buys, and the
 * boundary is exact: the file is READ AS DATA, with a named notice when it is
 * absent, and the module that owns it is never imported. The parameter file
 * that declares the dependency edge does not render, so the guarantee that both
 * capabilities travel together expires at generation — and a downstream project
 * that deletes the proxy registry, an entirely ordinary thing to do when it
 * decides it does not want a development proxy, would turn a static import into
 * a module-load crash. A crash is not a diagnostic: this guard would not report
 * a problem, it would fail to start.
 */
export function reconcileProxyRegistry(
	root: string,
	contract: StartSurface,
): StartReport {
	const path = contract.proxyRegistryPath;
	const declared = contract.apps.flatMap((app) =>
		app.proxyRouteId === null ? [] : [{ app: app.id, route: app.proxyRouteId }],
	);
	const full = resolve(root, path);
	if (!exists(full))
		return {
			errors: [],
			notices:
				declared.length === 0
					? [
							`start: ${path} is absent, so the development proxy route table was declared elsewhere and not reconciled`,
						]
					: declared.map(
							(entry) =>
								`start: ${path} is absent, so the declared proxy route ${entry.route} was declared and not reconciled`,
						),
		};
	let value: unknown;
	try {
		value = JSON.parse(textOf(full)) as unknown;
	} catch {
		return {
			errors: [],
			notices: [
				`start: ${path} does not parse as JSON, so the declared proxy routes were declared and not reconciled`,
			],
		};
	}
	if (!isRecord(value))
		return {
			errors: [],
			notices: [
				`start: ${path} does not carry an object, so the declared proxy routes were declared and not reconciled`,
			],
		};
	const routes = records(value["routes"]);
	const ids = new Set(
		routes.flatMap((route) =>
			typeof route["id"] === "string" ? [route["id"]] : [],
		),
	);
	const errors = declared
		.filter((entry) => !ids.has(entry.route))
		.map(
			(entry) =>
				`start: the application ${entry.app} declares the proxy route ${entry.route}, which ${path} does not declare`,
		);
	const notices: string[] = [];
	// A forwarding route beside a bundler development server is a refusal that
	// already exists, in the guard that owns that registry. Two sentences for one
	// defect send the reader to two files, so this half is a notice.
	if (
		contract.devServer === "vite" &&
		routes.some((route) => route["ws"] === true)
	)
		notices.push(
			`start: ${path} declares a forwarding route beside a bundler development server; that combination is refused by the guard that owns ${path} and is not re-refused here`,
		);
	return { errors: errors.sort(), notices };
}

// ── The shared TypeScript base ─────────────────────────────────────────────

/** Everything a `tsconfig*.json` resolves to once its extends chain is walked. */
export interface EffectiveTsconfig {
	options: JsonRecord;
	include: string[];
	chain: string[];
	problems: string[];
}

/**
 * The effective compiler options of a configuration file, parents first.
 *
 * Read through the chain and never off the one file, because that is where the
 * whole argument for extending lives: a base that restates a weaker option set
 * looks strict when you read its own keys and is not, and a base that inherits
 * a strict set states nothing at all in the file you are reading.
 */
export function effectiveTsconfig(
	root: string,
	path: string,
	seen: Set<string> = new Set(),
): EffectiveTsconfig {
	const problems: string[] = [];
	if (seen.has(path))
		return { options: {}, include: [], chain: [], problems: [] };
	seen.add(path);
	const source = textOf(resolve(root, path));
	if (source === "")
		return {
			options: {},
			include: [],
			chain: [path],
			problems: [`start: ${path} is missing or unreadable`],
		};
	let value: unknown;
	try {
		value = Bun.JSONC.parse(source) as unknown;
	} catch {
		return {
			options: {},
			include: [],
			chain: [path],
			problems: [`start: ${path} must parse as JSON with comments`],
		};
	}
	if (!isRecord(value))
		return {
			options: {},
			include: [],
			chain: [path],
			problems: [`start: ${path} must contain an object`],
		};
	let options: JsonRecord = {};
	const chain: string[] = [];
	for (const parent of extendedConfigs(path, source)) {
		const resolved = effectiveTsconfig(root, parent, seen);
		options = { ...options, ...resolved.options };
		chain.push(...resolved.chain);
		problems.push(...resolved.problems);
	}
	const own = isRecord(value["compilerOptions"])
		? value["compilerOptions"]
		: {};
	options = { ...options, ...own };
	chain.push(path);
	const include = Array.isArray(value["include"])
		? strings(value["include"])
		: [];
	return { options, include, chain, problems };
}

/**
 * Whether a `compilerOptions.types` entry resolves to anything at all.
 *
 * The package root is deliberately NOT a fallback. The defect this rule exists
 * for is a SUBPATH that the package does not export: the package itself was
 * installed and resolvable, so accepting the package root would answer "found
 * it" for the exact string that made the compiler fail.
 */
export function typeEntryCandidates(entry: string): string[] {
	const parts = entry.split("/");
	const packageName = entry.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? entry);
	const bare = packageName.startsWith("@")
		? packageName.slice(1).replace("/", "__")
		: packageName;
	const ambient = entry === packageName ? [`@types/${bare}/package.json`] : [];
	return [`${entry}/package.json`, entry, ...ambient];
}

export function resolvesTypeEntry(root: string, entry: string): boolean {
	let require_: NodeJS.Require;
	try {
		require_ = createRequire(resolve(root, "package.json"));
	} catch {
		return false;
	}
	for (const candidate of typeEntryCandidates(entry)) {
		try {
			require_.resolve(candidate);
			return true;
		} catch {
			// Each candidate is a separate question, and a miss is an answer.
		}
	}
	return false;
}

/** Whether a resolver is available at all, so a miss is a miss and not a blind. */
function resolverAvailable(root: string): boolean {
	try {
		createRequire(resolve(root, "package.json")).resolve("typescript");
		return true;
	} catch {
		return false;
	}
}

/** The effective option values this stack requires, whatever states them. */
const REQUIRED_COMPILER_OPTIONS = {
	noEmit: true,
	isolatedModules: true,
	strict: true,
} as const;

const REQUIRED_MODULE_RESOLUTION = "bundler";

/**
 * The shared TypeScript base, which is the artefact this stage was named after.
 *
 * Four rules and one deliberate omission. The file must be one this repository
 * exclusively owns — an ordinary in-tree file, not a symlink, with exactly one
 * hard link — because a guard that reads a symlink or a hardlinked twin
 * validates a file it does not own. It must EXTEND the repository base rather
 * than restate a weaker set beside it. Every `types` entry must resolve and none
 * may be forbidden, which is the rule that closes the class the reserved entry
 * opened. And every concrete filename in `include` must correspond to an
 * artefact some declared application produces, because an include entry that can
 * never match is a claim about a file layout — and if it were the only matching
 * pattern the compiler would exit TS18003 rather than typecheck nothing.
 *
 * The omission is `baseUrl`: the core toolchain guard already refuses it in
 * every `tsconfig*.json` in the tree, and this guard names that coverage in a
 * notice rather than putting a second sentence on one defect.
 */
export function validateTypeScriptBase(
	root: string,
	contract: StartSurface,
): StartReport {
	const path = contract.tsconfigPath;
	const errors: string[] = [];
	const notices: string[] = [];
	const full = resolve(root, path);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(full);
	} catch {
		// The missing-file refusal belongs to the wiring leg, which names the
		// registry that promised it. Two refusals for one fact would send the
		// reader to two files.
		return { errors, notices };
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
		errors.push(
			`start: ${path} must be an independent ordinary in-tree file with exactly one hard link`,
		);
		return { errors, notices };
	}
	try {
		if (realpathSync(full) !== join(realpathSync(root), ...path.split("/")))
			errors.push(
				`start: ${path} canonical path rebinds outside the path the registry declared`,
			);
	} catch {
		// An unresolvable canonical path is the missing-file case again.
	}

	const effective = effectiveTsconfig(root, path);
	errors.push(...effective.problems);
	if (!effective.chain.includes(REPOSITORY_TSCONFIG_BASE))
		errors.push(
			`start: ${path} must extend ${REPOSITORY_TSCONFIG_BASE}; a base that restates a weaker option set beside the repository base calls itself strict without being it`,
		);

	const declaredTypes = strings(effective.options["types"] ?? []);
	if (JSON.stringify(declaredTypes) !== JSON.stringify(contract.types))
		errors.push(
			`start: ${path} declares the types ${JSON.stringify(declaredTypes)} and ${REGISTRY_PATH} declares ${JSON.stringify(contract.types)}`,
		);
	const resolvable = resolverAvailable(root);
	for (const entry of declaredTypes) {
		if (contract.forbiddenTypes.includes(entry)) {
			errors.push(
				`start: ${path} declares the forbidden type entry ${entry}; removing it would fix this file and leave the class open, which is why the entry is declared forbidden rather than merely deleted`,
			);
			continue;
		}
		if (!resolvable) {
			notices.push(
				`start: no module resolver is available under ${root}, so the type entry ${entry} was declared and not resolved`,
			);
			continue;
		}
		if (!resolvesTypeEntry(root, entry))
			errors.push(
				`start: ${path} declares the type entry ${entry}, which does not resolve; the build never reads this list and only the typechecker does, so an unresolvable entry is green everywhere a build is the proof`,
			);
	}

	if (typeof effective.options["jsx"] !== "string")
		errors.push(`start: ${path} must declare jsx`);
	const moduleResolution = effective.options["moduleResolution"];
	if (
		typeof moduleResolution !== "string" ||
		moduleResolution.toLowerCase() !== REQUIRED_MODULE_RESOLUTION
	)
		errors.push(
			`start: ${path} must resolve modules as ${REQUIRED_MODULE_RESOLUTION}`,
		);
	for (const [option, expected] of Object.entries(REQUIRED_COMPILER_OPTIONS)) {
		if (effective.options[option] !== expected)
			errors.push(`start: ${path} must set ${option} to ${String(expected)}`);
	}

	const produced = new Set(
		contract.apps.flatMap((app) => [
			basenameOf(app.serverEntry),
			basenameOf(app.clientEntry),
			basenameOf(app.routerModule),
			basenameOf(app.routeTree),
			basenameOf(app.wranglerConfig),
			...app.ambientDeclarations.map(basenameOf),
		]),
	);
	for (const entry of effective.include) {
		if (entry.includes("*") || entry.includes("?")) continue;
		if (!entry.includes(".")) continue;
		if (!produced.has(basenameOf(entry)))
			errors.push(
				`start: ${path} includes ${entry}, which no declared application produces; an include entry that can never match is a claim about a file layout that no longer exists`,
			);
	}

	return { errors: [...new Set(errors)].sort(), notices };
}

/**
 * The rules that hold for this stack and live in CORE, named rather than
 * duplicated.
 *
 * Two of them. `baseUrl` is refused in every `tsconfig*.json` in the tree by the
 * core toolchain guard, and the shared base this registry governs is inside that
 * glob today — so re-checking it here would put two sentences on one defect and
 * leave the reader guessing which file to edit. And the coupled dependency
 * family this stack joins belongs to the capability this one DEPENDS ON: the
 * family must hold whenever that capability is enabled, whether or not anything
 * of this stack is, so its rules are core and fenced there rather than here.
 */
export function coreCrossReferences(contract: StartSurface): string[] {
	return [
		`start: baseUrl is refused in every tsconfig by ${CORE_TOOLCHAIN_SCRIPT}, which already covers ${contract.tsconfigPath}; it is not re-checked here`,
		`start: the coupled build-tool and worker-runtime pin family is owned by ${CORE_TOOLCHAIN_SCRIPT}, because it must hold whenever that capability is enabled and this one is not`,
	];
}

/**
 * The whole application surface contract, with the notices the caller prints.
 *
 * The order is the safety property. An unreadable registry stops everything,
 * because every leg below reads it; a mode disagreement stops everything too,
 * because every leg below is written for one of the two worlds and would answer
 * the wrong question in the other.
 */
export async function inspectStartContract(
	root = resolve(import.meta.dir, "../.."),
	_options: StartContractOptions = {},
): Promise<StartReport> {
	const notices: string[] = [];
	const { contract, errors: registryErrors } = await readStartSurface(root);
	if (!contract)
		return { errors: [...new Set(registryErrors)].sort(), notices };

	const state = deriveTreeState(root, contract);
	const reconciliation = reconcileMode(contract, state);
	if (reconciliation.length > 0)
		return {
			errors: [...new Set([...registryErrors, ...reconciliation])].sort(),
			notices,
		};

	const proxy = reconcileProxyRegistry(root, contract);
	notices.push(...proxy.notices);
	const devServer = validateDevServerPolicy(contract);
	notices.push(...devServer.notices);
	const typescriptBase = validateTypeScriptBase(root, contract);
	notices.push(...typescriptBase.notices);
	notices.push(...coreCrossReferences(contract));

	const errors = [
		...registryErrors,
		...validateSoleDeclarations(enumerateFiles(root), contract),
		...(await validateWiring(root, contract)),
		...(await validateOwnership(root)),
		...proxy.errors,
		...devServer.errors,
		...typescriptBase.errors,
	];
	return { errors: [...new Set(errors)].sort(), notices };
}

/** The error half, in the shape `validate.ts` aggregates. */
export async function validateStartContract(
	root = resolve(import.meta.dir, "../.."),
	options: StartContractOptions = {},
): Promise<string[]> {
	return (await inspectStartContract(root, options)).errors;
}
