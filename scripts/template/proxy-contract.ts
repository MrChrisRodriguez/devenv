// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "proxy-routes.json";
export const REGISTRY_SCHEMA_PATH = "proxy-routes.schema.json";
export const GUARD_CONTRACT = "scripts/template/proxy-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-proxy.ts";
export const GUARD_SCRIPT = "proxy:check";

// The capability that owns every file this stage adds. Named here and in no
// core module, for the reason every gated guard names it in exactly one place:
// `ci-contract.ts` ships to EVERY rendered project and the anti-residue scan is
// a plain substring search over every file of a render whose capability is off.
export const CAPABILITY = "vite_websocket_proxy";

// Where a downstream project's Vite configuration goes. Stage 0 reserved the
// path before anything existed to put in it, and the reservation is where the
// artifact WOULD live rather than a promise to create one: this template ships
// no application, so it ships no configuration either.
export const RESERVED_CONFIG_PATH = "vite.config.ts";

// Every file this capability adds, and the only list of them. Ownership,
// gating, residue and the wiring assertions all read it, so a fifth file cannot
// be added in one place and forgotten in the others.
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
const WORKTREE_CONTRACT_PATH = "scripts/worktree/contract.toml";

// Directories no tree walk descends into. `tmp/` is where `template:fixtures`
// renders and a rendered fixture carries a full copy of this tree — walking
// into one would invent a Vite configuration that no commit owns and flip the
// derived mode to `active`. `graphify-out/` is tracked here, so it has to be
// pruned out of the tracked list as well as out of the walk.
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
// shape is the thing under test — including a proxy table built to be refused.
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
// And the one that is NOT here, deliberately: the formatted token `ws:<space>
// true` that Stage 0 reserved as a residue signature. It is a whitespace-
// sensitive substring of formatted source — `ws:true`, `ws : true`, `"ws": true`
// and a line-broken object all evade it — so it is fit for an anti-residue scan
// and unfit as this guard's mechanism. Every structural rule below reads the
// TypeScript AST instead.
const DEV_SERVER_KEY = ["ser", "ver"].join("");
const PREVIEW_SERVER_KEY = ["pre", "view"].join("");
const PROXY_KEY = ["pro", "xy"].join("");
const CONFIG_BASENAME = ["vite", ".config."].join("");

/** The needles, exported so a fixture can build a workspace out of them. */
export const NEEDLES = {
	server: DEV_SERVER_KEY,
	preview: PREVIEW_SERVER_KEY,
	proxy: PROXY_KEY,
	configBasename: CONFIG_BASENAME,
} as const;

export interface ProxyRoute {
	id: string;
	path: string;
	target: string;
	ws: boolean;
	changeOrigin: boolean;
	secure: boolean;
	rewrite: string | null;
}

export interface ProxyUpstream {
	id: string;
	port: number;
	description: string;
}

export interface HmrOverride {
	protocol: "ws" | "wss" | null;
	host: string | null;
	clientPort: number | null;
	reason: string;
}

export interface ProxyServer {
	port: number;
	host: boolean | string;
	strictPort: boolean;
	allowedHosts: string[];
	hmr: HmrOverride | null;
	origin: string | null;
	frontedBy: string | null;
}

export interface ProxyRoutes {
	schemaVersion: 1;
	mode: "skeleton" | "active";
	configPath: string;
	runtime: "bun" | "node";
	wsRuntimeWaiver: { reason: string } | null;
	publishedContainerPort: number;
	friendlyDomainPattern: string;
	server: ProxyServer | null;
	preview: ProxyServer | null;
	routes: ProxyRoute[];
	upstreams: ProxyUpstream[];
}

/** What the tree looks like, independent of what the registry claims. */
export type SurfaceShape =
	| "config-file"
	| "build-tool-dependency"
	| "proxy-table";

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

export interface ProxyContractOptions {
	/** Reserved for the legs that need a binary or a Git object. */
	root?: string;
}

export interface ProxyReport {
	errors: string[];
	notices: string[];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
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

/** Whether a path is a Vite configuration file at any depth. */
export function isViteConfig(path: string): boolean {
	const basename = path.slice(path.lastIndexOf("/") + 1);
	return (
		basename.startsWith(CONFIG_BASENAME) &&
		basename.length > CONFIG_BASENAME.length
	);
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
 * question every rule here actually asks. A rendered fixture is not a Git
 * repository, so the fallback is a pruned directory walk — and both paths run
 * through the same exclusion list.
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

type TypeScriptApi = typeof import("typescript");
type Node = import("typescript").Node;
type SourceFile = import("typescript").SourceFile;
type ObjectLiteral = import("typescript").ObjectLiteralExpression;
type Expression = import("typescript").Expression;

let compiler: TypeScriptApi | undefined;
let compilerResolved = false;

/**
 * The catalog-pinned compiler, resolved lazily and through `createRequire`.
 *
 * A regex over TypeScript is a substring search wearing a contract's clothes,
 * and here it would be worse than usual: the token this capability reserves is
 * whitespace-sensitive, so a formatter setting could evade a text rule while
 * leaving the defect exactly where it was.
 */
function typescript(): TypeScriptApi | undefined {
	if (compilerResolved) return compiler;
	compilerResolved = true;
	try {
		compiler = createRequire(import.meta.url)("typescript") as TypeScriptApi;
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

/** An expression with its parentheses, `as` clauses and `satisfies` removed. */
export function unwrap(expression: Expression): Expression {
	const api = typescript();
	if (!api) return expression;
	let current: Expression = expression;
	for (;;) {
		if (api.isParenthesizedExpression(current)) current = current.expression;
		else if (api.isAsExpression(current)) current = current.expression;
		else if (api.isSatisfiesExpression(current)) current = current.expression;
		else if (api.isTypeAssertionExpression(current))
			current = current.expression;
		else return current;
	}
}

/** The name a property assignment binds, from an identifier or a string key. */
export function propertyName(node: Node): string | undefined {
	const api = typescript();
	if (!api) return undefined;
	if (!api.isPropertyAssignment(node)) return undefined;
	const name = node.name;
	if (api.isIdentifier(name)) return name.text;
	if (api.isStringLiteralLike(name)) return name.text;
	return undefined;
}

/** The property assignment a given object literal binds under `name`. */
export function propertyOf(
	object: ObjectLiteral,
	name: string,
): import("typescript").PropertyAssignment | undefined {
	const api = typescript();
	if (!api) return undefined;
	for (const member of object.properties) {
		if (!api.isPropertyAssignment(member)) continue;
		if (propertyName(member) === name) return member;
	}
	return undefined;
}

/** The object literal a property binds, or undefined when it binds anything else. */
export function objectPropertyOf(
	object: ObjectLiteral,
	name: string,
): ObjectLiteral | undefined {
	const api = typescript();
	const property = propertyOf(object, name);
	if (!api || !property) return undefined;
	const value = unwrap(property.initializer);
	return api.isObjectLiteralExpression(value) ? value : undefined;
}

/**
 * Whether a source file declares a development or preview proxy table.
 *
 * Read off the AST and never off the text, so that a changelog paragraph about
 * proxy tables is not one and a fixture that names the shape in a string is not
 * one either. The shape is precise: a property named for one of the two servers
 * whose value is an object literal carrying a `proxy` property.
 */
export function declaresProxyTable(path: string, source: string): boolean {
	const api = typescript();
	const file = parseSource(path, source);
	if (!api || !file) return false;
	let found = false;
	eachNode(file, (node) => {
		if (found || !api.isObjectLiteralExpression(node)) return;
		for (const key of [DEV_SERVER_KEY, PREVIEW_SERVER_KEY]) {
			const nested = objectPropertyOf(node, key);
			if (nested && propertyOf(nested, PROXY_KEY)) found = true;
		}
	});
	return found;
}

/** Whether the manifest pins the build tool directly, in either section. */
export function declaresBuildTool(manifest: JsonRecord): boolean {
	const tool = ["vi", "te"].join("");
	const devDependencies = isRecord(manifest["devDependencies"])
		? manifest["devDependencies"]
		: {};
	if (tool in devDependencies) return true;
	const workspaces = isRecord(manifest["workspaces"])
		? manifest["workspaces"]
		: {};
	const catalog = isRecord(workspaces["catalog"]) ? workspaces["catalog"] : {};
	return tool in catalog;
}

/**
 * What the tree actually carries, derived and never declared.
 *
 * This is the half of the reconciliation the registry cannot lie about. Three
 * shapes, each of which is the visible consequence of a development server
 * existing: a Vite configuration file at any depth — its PRESENCE is what marks
 * a project as having a frontend, which is the reference implementation's own
 * predicate — a direct dependency on the build tool, and a source file that
 * declares a proxy table.
 */
export function deriveTreeState(
	root: string,
	contract?: ProxyRoutes,
): TreeState {
	const files = enumerateFiles(root);
	const signals: SurfaceSignal[] = [];
	const errors: string[] = [];
	if (files.length === 0)
		errors.push(
			`proxy: the tracked-file scan found nothing under ${root}; a rule with no input has answered nothing`,
		);
	let compilerMissing = false;
	for (const path of files) {
		if (isViteConfig(path)) {
			signals.push({
				path,
				shape: "config-file",
				detail: `${path} is a build-tool configuration file, and its presence is what marks this project as having a development server`,
			});
		}
		if (path === "package.json") {
			let manifest: JsonRecord | undefined;
			try {
				manifest = JSON.parse(textOf(resolve(root, path))) as JsonRecord;
			} catch {
				manifest = undefined;
			}
			if (manifest && declaresBuildTool(manifest)) {
				signals.push({
					path,
					shape: "build-tool-dependency",
					detail: `${path} pins the build tool as a direct dependency`,
				});
			}
		}
		if (!isSourceFile(path) || !isShipped(path)) continue;
		const source = textOf(resolve(root, path));
		if (source === "") continue;
		if (typescript() === undefined) {
			compilerMissing = true;
			continue;
		}
		if (declaresProxyTable(path, source)) {
			signals.push({
				path,
				shape: "proxy-table",
				detail: `${path} declares a development or preview proxy table`,
			});
		}
	}
	if (compilerMissing)
		errors.push(
			`proxy: the TypeScript compiler API is unavailable; run bun install before ${GUARD_SCRIPT}`,
		);
	// The declared configuration path counts as a signal only when it is really
	// there. A registry that names a file nothing created has not created one.
	if (
		contract &&
		contract.configPath !== "" &&
		exists(resolve(root, contract.configPath))
	) {
		if (!signals.some((signal) => signal.path === contract.configPath))
			signals.push({
				path: contract.configPath,
				shape: "config-file",
				detail: `${contract.configPath} is the declared build-tool configuration file and exists`,
			});
	}
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
export async function readProxyRoutes(
	root: string,
): Promise<{ contract?: ProxyRoutes; errors: string[] }> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`proxy: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`proxy: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`proxy: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`proxy: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `proxy: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { contract: value as ProxyRoutes, errors };
}

/**
 * The registry is the only one, and every declared thing is declared once.
 *
 * A second registry anywhere in the tree is the same defect as a second matrix
 * universe registry: two files claiming to be the authority means neither is.
 * The same applies one level down — a route id declared twice, a path claimed
 * twice, or an upstream port declared under two ids, all leave two answers to a
 * question the registry exists to answer once.
 */
export function validateSoleDeclarations(
	files: string[],
	contract: ProxyRoutes | undefined,
): string[] {
	const errors: string[] = [];
	for (const path of files) {
		if (path === REGISTRY_PATH) continue;
		if (path.slice(path.lastIndexOf("/") + 1) === REGISTRY_PATH)
			errors.push(
				`proxy: ${path} is a second proxy route registry; ${REGISTRY_PATH} is the only one`,
			);
	}
	if (!contract) return errors.sort();
	const seenId = new Map<string, string>();
	for (const route of contract.routes) {
		const declared = seenId.get(route.id);
		if (declared !== undefined)
			errors.push(
				`proxy: ${route.path} is a second route named ${route.id}; ${declared} is the only one`,
			);
		else seenId.set(route.id, route.path);
	}
	const seenPath = new Set<string>();
	for (const route of contract.routes) {
		if (seenPath.has(route.path))
			errors.push(`proxy: ${route.path} is declared twice as a route`);
		seenPath.add(route.path);
	}
	const seenUpstream = new Map<number, string>();
	for (const upstream of contract.upstreams) {
		const declared = seenUpstream.get(upstream.port);
		if (declared !== undefined)
			errors.push(
				`proxy: the upstream port ${upstream.port} is declared as both ${declared} and ${upstream.id}`,
			);
		else seenUpstream.set(upstream.port, upstream.id);
	}
	return errors.sort();
}

/**
 * The declared mode against the derived one, in both directions.
 *
 * This is what keeps every leg below it from being a no-op. A query over a tree
 * with no development server is trivially true, so "found nothing, passed"
 * would be the normal outcome for a template that ships no application — and a
 * rule whose normal outcome is silence is not a rule. Instead the registry
 * states which of the two worlds this is, and a tree that grew a configuration
 * while the registry still said `skeleton` fails by name, as does a registry
 * that declares a surface the tree does not have.
 */
export function reconcileMode(
	contract: ProxyRoutes,
	state: TreeState,
): string[] {
	const errors: string[] = [...state.errors];
	const declared =
		contract.routes.length +
		(contract.server === null ? 0 : 1) +
		(contract.preview === null ? 0 : 1);
	if (contract.mode === "skeleton") {
		for (const signal of state.signals)
			errors.push(
				`proxy: ${REGISTRY_PATH} declares skeleton mode but ${signal.detail}`,
			);
		// The same assertion from the registry's side. A skeleton that declares a
		// server has already left skeleton, and every leg below would then be asked
		// a question about a world the mode says does not exist.
		if (declared > 0)
			errors.push(
				`proxy: ${REGISTRY_PATH} declares skeleton mode but declares a server, a preview server or a route`,
			);
		if (contract.upstreams.length > 0)
			errors.push(
				`proxy: ${REGISTRY_PATH} declares skeleton mode but declares an upstream`,
			);
		return errors.sort();
	}
	if (contract.server === null || contract.preview === null)
		errors.push(
			`proxy: ${REGISTRY_PATH} declares active mode but leaves the development or preview server null`,
		);
	if (contract.routes.length === 0)
		errors.push(
			`proxy: ${REGISTRY_PATH} declares active mode but declares no route`,
		);
	if (state.mode === "skeleton")
		errors.push(
			`proxy: ${REGISTRY_PATH} declares active mode but no tracked file carries a build-tool configuration or a proxy table`,
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
	contract: ProxyRoutes | undefined,
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of GATED_PATHS) {
		if (!exists(resolve(root, path))) errors.push(`proxy: ${path} is missing`);
	}
	const manifestPath = resolve(root, "package.json");
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`proxy: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const fence = fencedCapabilityOf(source, invocation);
		if (fence === "absent")
			errors.push(
				`proxy: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else {
			// The fence is a fact about the TEMPLATE, not about a render: the renderer
			// deletes the markers along with the blocks it keeps, so a generated
			// project's step is correctly unfenced.
			if (isTemplateTree(root) && fence !== CAPABILITY)
				errors.push(
					`proxy: the \`${invocation}\` step must sit inside a ${CAPABILITY} capability fence`,
				);
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`proxy: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`proxy: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	if (
		contract &&
		contract.mode === "active" &&
		!exists(resolve(root, contract.configPath))
	)
		errors.push(
			`proxy: ${REGISTRY_PATH} declares ${contract.configPath}, which is missing`,
		);
	return errors.sort();
}

/**
 * Template ownership, which is where a capability's files become a capability.
 *
 * The `copy` entries must precede the `scripts/template/**` omit catch-all or
 * the render drops the guard while `package.json` still declares the script —
 * which the fixture suite catches as a DIFFERENT error and sends you looking in
 * the wrong file. The reserved configuration path is gated here even though
 * nothing creates it, so the first downstream project to write one is governed
 * from its first commit rather than from the commit somebody noticed.
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
			errors.push(`proxy: template ownership must cover ${pattern}`);
	}
	const artifacts = records(ownership["artifactRules"]);
	for (const pattern of [...GATED_PATHS, RESERVED_CONFIG_PATH]) {
		const rule = artifacts.find((entry) => entry["pattern"] === pattern);
		const requires = Array.isArray(rule?.["requiresAll"])
			? rule["requiresAll"]
			: [];
		if (!requires.includes(CAPABILITY))
			errors.push(`proxy: ${pattern} must be gated by the capability`);
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
			`proxy: the ${CAPABILITY} package rule must strip the ${GUARD_SCRIPT} script`,
		);
	const signatures = isRecord(ownership["capabilitySignatures"])
		? ownership["capabilitySignatures"]
		: {};
	const signature = isRecord(signatures[CAPABILITY])
		? signatures[CAPABILITY]
		: {};
	const signaturePaths = Array.isArray(signature["paths"])
		? signature["paths"]
		: [];
	// The nested glob joins the Stage 0 reservation rather than replacing it. The
	// reserved string is an exact filename with no glob, so `apps/web/vite.config.ts`
	// and a root `vite.config.mts` both slip past it — and the reservation stays
	// legible in the diff and in the sealed record by being left alone.
	for (const pattern of [
		...GATED_PATHS,
		RESERVED_CONFIG_PATH,
		`**/${CONFIG_BASENAME}*`,
	]) {
		if (!signaturePaths.includes(pattern))
			errors.push(`proxy: ${pattern} must be a declared capability signature`);
	}
	const signatureTokens = Array.isArray(signature["tokens"])
		? signature["tokens"]
		: [];
	// The guard script only. The capability NAME is deliberately not a token here
	// — unlike every previous stage, this capability's Stage 0 token is a code
	// shape rather than a package name, so `vite_websocket_proxy` and even the
	// tool's name may appear in core prose without failing the residue scan.
	if (!signatureTokens.includes(GUARD_SCRIPT))
		errors.push(
			`proxy: ${GUARD_SCRIPT} must be a declared capability signature token`,
		);
	const inventory = isRecord(ownership["capabilityInventory"])
		? ownership["capabilityInventory"]
		: {};
	const absent = Array.isArray(inventory["absent"]) ? inventory["absent"] : [];
	if (absent.includes(CAPABILITY))
		errors.push(
			`proxy: ${CAPABILITY} ships a guard surface and must leave the absent inventory`,
		);
	return errors.sort();
}

/** One scalar out of the worktree runtime contract, without a TOML parser. */
function tomlScalar(source: string, key: string): string | undefined {
	const match = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(source);
	const raw = match?.[1];
	if (raw === undefined) return undefined;
	return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

/**
 * The declared reachability numbers against the worktree runtime contract.
 *
 * A gated guard must not hard-depend on a file another capability owns:
 * `scripts/worktree/contract.toml` is gated on `devcontainer`, and
 * `template-parameters.toml` does not render at all — so the numbers this
 * registry needs are not reliably readable in a rendered project. The registry
 * declares them, the guard reconciles when the contract is there, and it emits
 * a NAMED NOTICE when it is not. "Checked nothing" and "found nothing wrong"
 * produce the same exit status and are not the same claim.
 */
export function reconcileWorktreeContract(
	root: string,
	contract: ProxyRoutes,
): ProxyReport {
	const path = resolve(root, WORKTREE_CONTRACT_PATH);
	if (!exists(path))
		return {
			errors: [],
			notices: [
				`proxy: ${WORKTREE_CONTRACT_PATH} is absent, so the published port ${contract.publishedContainerPort} and the friendly domain ${contract.friendlyDomainPattern} were declared and not reconciled`,
			],
		};
	const source = textOf(path);
	const errors: string[] = [];
	const port = tomlScalar(source, "published_container_port");
	if (port !== undefined && Number(port) !== contract.publishedContainerPort)
		errors.push(
			`proxy: ${REGISTRY_PATH} declares the published container port ${contract.publishedContainerPort} and ${WORKTREE_CONTRACT_PATH} declares ${port}`,
		);
	const pattern = tomlScalar(source, "friendly_domain_pattern");
	if (pattern !== undefined && pattern !== contract.friendlyDomainPattern)
		errors.push(
			`proxy: ${REGISTRY_PATH} declares the friendly domain pattern ${contract.friendlyDomainPattern} and ${WORKTREE_CONTRACT_PATH} declares ${pattern}`,
		);
	return { errors: errors.sort(), notices: [] };
}

/** Every declared service the worktree runtime contract knows about. */
export function declaredServices(root: string): string[] | undefined {
	const path = resolve(root, WORKTREE_CONTRACT_PATH);
	if (!exists(path)) return undefined;
	const match = /^services\s*=\s*\[([\s\S]*?)\]/m.exec(textOf(path));
	if (!match?.[1]) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "");
}

/**
 * The whole development server and proxy contract, with the notices the caller
 * prints.
 *
 * The order is the safety property. An unreadable registry stops everything,
 * because every leg below reads it; a mode disagreement stops everything too,
 * because every leg below is written for one of the two worlds and would answer
 * the wrong question in the other.
 */
export async function inspectProxyContract(
	root = resolve(import.meta.dir, "../.."),
	_options: ProxyContractOptions = {},
): Promise<ProxyReport> {
	const notices: string[] = [];
	const { contract, errors: registryErrors } = await readProxyRoutes(root);
	if (!contract)
		return { errors: [...new Set(registryErrors)].sort(), notices };

	const state = deriveTreeState(root, contract);
	const reconciliation = reconcileMode(contract, state);
	if (reconciliation.length > 0)
		return {
			errors: [...new Set([...registryErrors, ...reconciliation])].sort(),
			notices,
		};

	const worktree = reconcileWorktreeContract(root, contract);
	notices.push(...worktree.notices);

	const errors = [
		...registryErrors,
		...validateSoleDeclarations(enumerateFiles(root), contract),
		...(await validateWiring(root, contract)),
		...(await validateOwnership(root)),
		...worktree.errors,
	];
	return { errors: [...new Set(errors)].sort(), notices };
}

/** The error half, in the shape `validate.ts` aggregates. */
export async function validateProxyContract(
	root = resolve(import.meta.dir, "../.."),
	options: ProxyContractOptions = {},
): Promise<string[]> {
	return (await inspectProxyContract(root, options)).errors;
}
