// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "external-writes.json";
export const REGISTRY_SCHEMA_PATH = "external-writes.schema.json";
export const GUARD_CONTRACT = "scripts/template/telemetry-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-telemetry.ts";
export const GUARD_SCRIPT = "telemetry:check";

// The capability that owns every file this stage adds. Named here and in no
// core module: `ci-contract.ts` ships to EVERY rendered project, and the
// anti-residue scan is a plain substring search over every file of a render
// whose capability is off.
export const CAPABILITY = "sentry";

// Where a downstream project's telemetry configuration goes. Stage 0 reserved
// the path before anything existed to put in it, and the reservation is where
// the artifact WOULD live rather than a promise to create one. The registry's
// `configModules[]` accepts any declared root, so the reservation is
// load-bearing without being prescriptive: the reference implementation splits
// its own facade across a shared tier and a browser tier and has no directory
// by this name at all.
export const RESERVED_TELEMETRY_ROOT = "libs/observability";

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

// Directories no tree walk descends into. `tmp/` is where `template:fixtures`
// renders and a rendered fixture carries a full copy of this tree — walking
// into one would invent a telemetry configuration module that no commit owns
// and flip the derived mode to `active`. `graphify-out/` is tracked here, so it
// has to be pruned out of the tracked list as well as out of the walk.
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

// Everything a runner or a shell can EXECUTE. The write-shape scan is scoped to
// these because prose cannot push a commit: a changelog paragraph explaining
// this very rule is not an instance of it, and narrowing to executables is what
// lets the rule stay free of per-path escapes.
const EXECUTABLE_EXTENSIONS = new Set([
	...SOURCE_EXTENSIONS,
	".bash",
	".sh",
	".yaml",
	".yml",
]);

// Files nobody ships. A test may hand-write any shape it likes, because the
// shape is the thing under test.
const UNSHIPPED = [
	/\.test\.[cm]?[jt]sx?$/,
	/\.spec\.[cm]?[jt]sx?$/,
	/(?:^|\/)__mocks__\//,
	/(?:^|\/)__tests__\//,
];

// ── Needles ────────────────────────────────────────────────────────────────
// Every one of them is assembled at run time, because this guard scans a tree
// that contains this guard. A path exemption for the guard's own file would be
// a hole somebody eventually widens.
const SDK_SCOPE = ["@", "sentry", "/"].join("");
const SDK_NAMESPACE = ["Sen", "try"].join("");
const INITIALIZER = `${SDK_NAMESPACE}.${["in", "it"].join("")}(`;
const USER_BINDING = `${SDK_NAMESPACE}.${["set", "User"].join("")}(`;
const LOGGER_NAMESPACE = `${SDK_NAMESPACE}.${["log", "ger"].join("")}.`;
const METRICS_NAMESPACE = `${SDK_NAMESPACE}.${["met", "rics"].join("")}.`;

/** The needles, exported so a fixture can build a workspace out of them. */
export const NEEDLES = {
	scope: SDK_SCOPE,
	initializer: INITIALIZER,
	setUser: USER_BINDING,
	logger: LOGGER_NAMESPACE,
	metrics: METRICS_NAMESPACE,
} as const;

// A remote mutation, spelled in parts so that the array declaring it is not
// itself a line in command position. Word order matters: `git push` is a write
// and `echo "  git push -u origin HEAD"` is an instruction printed to a human,
// and a scan that could not tell them apart would make writing the instruction
// impossible.
const WRITE_SHAPES: ReadonlyArray<{ id: string; parts: readonly string[] }> = [
	{ id: "git-push", parts: ["git", "\\s+", "push", "\\b"] },
	{
		id: "worker-deploy",
		parts: ["wrangler", "\\s+", "(?:pages\\s+)?", "deploy", "\\b"],
	},
	{ id: "release-create", parts: ["gh", "\\s+", "release", "\\s+", "create"] },
	{
		id: "registry-publish",
		parts: ["(?:npm|bun|pnpm|yarn)", "\\s+", "publish", "\\b"],
	},
	{
		id: "http-mutation",
		parts: [
			"curl",
			"\\b[^\\n]*",
			"(?:-X|--request)",
			"\\s*",
			"(?:POST|PUT|PATCH|DELETE)",
		],
	},
];

/**
 * A command in COMMAND POSITION, which is the only place a word is a write.
 *
 * `"git push",` is an entry in a ban list and `note "… && git push -u origin"`
 * is a self-healing menu printed after a rejection; neither pushes anything.
 * Anchoring to the start of a line — after an optional YAML list dash, an
 * optional `run:` key and any shell keywords — is what separates the command
 * from every text that merely names it.
 */
function commandPosition(pattern: string): RegExp {
	return new RegExp(
		`^[ \\t-]*(?:run:[ \\t]*)?(?:[|>]-?[ \\t]*)?(?:(?:if|elif|while|until|then|else|do)[ \\t]+)*(?:![ \\t]*)*(?:${pattern})`,
		"m",
	);
}

export interface ConfigModule {
	path: string;
	tier: "browser" | "server";
}

export interface TelemetryUpload {
	command: string;
	releaseVariable: string;
	tokenVariable: string;
	scope: "client" | "server";
}

export interface TelemetryDeclaration {
	configModules: ConfigModule[];
	scrubModule: string;
	sendDefaultPii: false;
	tunnel: string | null;
	dsnVariable: string;
	upload: TelemetryUpload | null;
}

export interface DeclaredWrite {
	id: string;
	path: string;
	kind: "git" | "http" | "cli";
	command: string;
	intent: string;
	credentials: string[];
	verify: string;
	allowedHosts: string[];
}

export interface GovernedElsewhere {
	path: string;
	authority: string;
}

export interface ExternalWrites {
	schemaVersion: 1;
	mode: "skeleton" | "active";
	telemetry: TelemetryDeclaration | null;
	writes: DeclaredWrite[];
	allowedHosts: string[];
	governedElsewhere: GovernedElsewhere[];
}

/** What the tree looks like, independent of what the registry claims. */
export type SurfaceShape =
	| "reserved-path"
	| "sdk-import"
	| "sdk-initializer"
	| "undeclared-write";

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

export interface TelemetryContractOptions {
	/** Reserved for the legs that need a binary or a Git object. */
	root?: string;
}

export interface TelemetryReport {
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

export function isExecutableFile(path: string): boolean {
	return EXECUTABLE_EXTENSIONS.has(extensionOf(path));
}

export function isShipped(path: string): boolean {
	return !UNSHIPPED.some((pattern) => pattern.test(path));
}

function insideRoot(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
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

let compiler: TypeScriptApi | undefined;
let compilerResolved = false;

/**
 * The catalog-pinned compiler, resolved lazily and through `createRequire`.
 *
 * A regex over TypeScript is a substring search wearing a contract's clothes.
 * `typescript` is already a catalog entry and a devDependency here, so the AST
 * is free; the load is lazy and failure is reported as a named error rather
 * than thrown, because a guard that cannot read the tree must say so.
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

/**
 * Every module specifier a source file names, from the AST and never from a
 * regex.
 *
 * All five spellings count: `import … from`, `export … from`, `import x =
 * require(…)`, a dynamic `import(…)`, and a bare side-effect import. A leg that
 * only knew about the first would pass an SDK that reached the browser bundle
 * through the fourth.
 */
export function moduleSpecifiers(
	path: string,
	source: string,
): string[] | undefined {
	const api = typescript();
	if (!api) return undefined;
	const kind = path.endsWith("x") ? api.ScriptKind.TSX : api.ScriptKind.TS;
	const file = api.createSourceFile(
		path,
		source,
		api.ScriptTarget.Latest,
		true,
		kind,
	);
	const found: string[] = [];
	const literal = (node: unknown): string | undefined =>
		node !== undefined && api.isStringLiteralLike(node as never)
			? (node as { text: string }).text
			: undefined;
	const walk = (node: import("typescript").Node): void => {
		if (api.isImportDeclaration(node) || api.isExportDeclaration(node)) {
			const specifier = literal(node.moduleSpecifier);
			if (specifier !== undefined) found.push(specifier);
		}
		if (api.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (api.isExternalModuleReference(reference)) {
				const specifier = literal(reference.expression);
				if (specifier !== undefined) found.push(specifier);
			}
		}
		if (api.isCallExpression(node)) {
			const argument = literal(node.arguments[0]);
			const callee = node.expression;
			if (argument !== undefined) {
				if (callee.kind === api.SyntaxKind.ImportKeyword) found.push(argument);
				else if (api.isIdentifier(callee) && callee.text === "require")
					found.push(argument);
			}
		}
		api.forEachChild(node, walk);
	};
	walk(file);
	return found;
}

export function importsSdk(specifiers: string[]): boolean {
	return specifiers.some((specifier) => specifier.startsWith(SDK_SCOPE));
}

/**
 * The half of a file a shell or a runner actually executes.
 *
 * The negative rules read this half only. A comment explaining why a remote
 * write must be declared is not a remote write, and a rule that cannot tell the
 * difference makes writing the explanation impossible.
 */
export function executableHalf(path: string, source: string): string {
	const comment = isSourceFile(path) ? /^\s*(?:\/\/|\/\*|\*)/ : /^\s*#/;
	return source
		.split("\n")
		.filter((line) => !comment.test(line))
		.join("\n");
}

/** Every write shape a file performs, by id. */
export function writeShapesOf(path: string, source: string): string[] {
	const code = executableHalf(path, source);
	return WRITE_SHAPES.filter((shape) =>
		commandPosition(shape.parts.join("")).test(code),
	).map((shape) => shape.id);
}

/**
 * What the tree actually carries, derived and never declared.
 *
 * This is the half of the reconciliation the registry cannot lie about. Four
 * shapes, each of which is the visible consequence of a telemetry surface or a
 * remote write existing: a file under the reserved configuration root, a file
 * importing the SDK scope, a file calling the SDK initializer, and a file
 * performing a write shape that neither `writes[]` nor `governedElsewhere[]`
 * names.
 */
export function deriveTreeState(
	root: string,
	contract?: ExternalWrites,
): TreeState {
	const files = enumerateFiles(root);
	const signals: SurfaceSignal[] = [];
	const errors: string[] = [];
	if (files.length === 0)
		errors.push(
			`telemetry: the tracked-file scan found nothing under ${root}; a rule with no input has answered nothing`,
		);
	const declaredWrites = new Set(
		(contract?.writes ?? []).map((entry) => entry.path),
	);
	const governed = new Set(
		(contract?.governedElsewhere ?? []).map((entry) => entry.path),
	);
	let compilerMissing = false;
	for (const path of files) {
		if (insideRoot(RESERVED_TELEMETRY_ROOT, path)) {
			signals.push({
				path,
				shape: "reserved-path",
				detail: `${path} lives under the reserved telemetry configuration root ${RESERVED_TELEMETRY_ROOT}`,
			});
		}
		const source = textOf(resolve(root, path));
		if (source === "") continue;
		if (isExecutableFile(path) && isShipped(path)) {
			const shapes = writeShapesOf(path, source);
			if (
				shapes.length > 0 &&
				!declaredWrites.has(path) &&
				!governed.has(path)
			) {
				signals.push({
					path,
					shape: "undeclared-write",
					detail: `${path} performs the remote write ${shapes.join(", ")} that ${REGISTRY_PATH} does not declare`,
				});
			}
		}
		if (!isSourceFile(path)) continue;
		if (executableHalf(path, source).includes(INITIALIZER)) {
			signals.push({
				path,
				shape: "sdk-initializer",
				detail: `${path} calls the telemetry SDK initializer`,
			});
		}
		const specifiers = moduleSpecifiers(path, source);
		if (specifiers === undefined) {
			compilerMissing = true;
			continue;
		}
		if (importsSdk(specifiers)) {
			signals.push({
				path,
				shape: "sdk-import",
				detail: `${path} imports the telemetry SDK`,
			});
		}
	}
	if (compilerMissing)
		errors.push(
			`telemetry: the TypeScript compiler API is unavailable; run bun install before ${GUARD_SCRIPT}`,
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
export async function readExternalWrites(
	root: string,
): Promise<{ contract?: ExternalWrites; errors: string[] }> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`telemetry: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`telemetry: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`telemetry: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`telemetry: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `telemetry: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { contract: value as ExternalWrites, errors };
}

/**
 * The registry is the only one, and every declared thing is declared once.
 *
 * A second registry anywhere in the tree is the same defect as a second matrix
 * universe registry: two files claiming to be the authority means neither is.
 * The same applies one level down — a write declared twice, or a path that is
 * both declared here and delegated to another authority, leaves two answers to
 * "who governs this file".
 */
export function validateSoleDeclarations(
	files: string[],
	contract: ExternalWrites | undefined,
): string[] {
	const errors: string[] = [];
	for (const path of files) {
		if (path === REGISTRY_PATH) continue;
		if (path.slice(path.lastIndexOf("/") + 1) === REGISTRY_PATH)
			errors.push(
				`telemetry: ${path} is a second external write registry; ${REGISTRY_PATH} is the only one`,
			);
	}
	if (!contract) return errors.sort();
	const seenId = new Map<string, string>();
	for (const entry of contract.writes) {
		const declared = seenId.get(entry.id);
		if (declared !== undefined)
			errors.push(
				`telemetry: ${entry.path} is a second write named ${entry.id}; ${declared} is the only one`,
			);
		else seenId.set(entry.id, entry.path);
	}
	const seenPath = new Set<string>();
	for (const entry of contract.writes) {
		if (seenPath.has(entry.path))
			errors.push(`telemetry: ${entry.path} is declared twice as a write`);
		seenPath.add(entry.path);
	}
	for (const entry of contract.governedElsewhere) {
		if (seenPath.has(entry.path))
			errors.push(
				`telemetry: ${entry.path} is both a declared write and governed elsewhere; one file has one authority`,
			);
	}
	const seenModule = new Set<string>();
	for (const entry of contract.telemetry?.configModules ?? []) {
		if (seenModule.has(entry.path))
			errors.push(
				`telemetry: ${entry.path} is declared twice as a configuration module`,
			);
		seenModule.add(entry.path);
	}
	return errors.sort();
}

/**
 * The declared mode against the derived one, in both directions.
 *
 * This is what keeps every leg below it from being a no-op. A query over a tree
 * with no telemetry is trivially true, so "found nothing, passed" would be the
 * normal outcome for a template that ships no application — and a rule whose
 * normal outcome is silence is not a rule. Instead the registry states which of
 * the two worlds this is, and a tree that grew a surface while the registry
 * still said `skeleton` fails by name, as does a registry that declares a
 * surface the tree does not have.
 */
export function reconcileMode(
	contract: ExternalWrites,
	state: TreeState,
): string[] {
	const errors: string[] = [...state.errors];
	const declared =
		contract.writes.length + (contract.telemetry === null ? 0 : 1);
	if (contract.mode === "skeleton") {
		for (const signal of state.signals)
			errors.push(
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but ${signal.detail}`,
			);
		// The same assertion from the registry's side. A skeleton that declares a
		// telemetry configuration has already left skeleton, and every leg below
		// would then be asked a question about a world the mode says does not
		// exist.
		if (declared > 0)
			errors.push(
				`telemetry: ${REGISTRY_PATH} declares skeleton mode but declares a telemetry or write surface`,
			);
		return errors.sort();
	}
	if (declared === 0)
		errors.push(
			`telemetry: ${REGISTRY_PATH} declares active mode but declares no telemetry configuration and no external write`,
		);
	if (state.mode === "skeleton")
		errors.push(
			`telemetry: ${REGISTRY_PATH} declares active mode but no tracked file carries a telemetry surface or an external write`,
		);
	return errors.sort();
}

/** Every repository-relative path the registry promises. */
export function declaredPaths(contract: ExternalWrites | undefined): string[] {
	if (!contract) return [];
	const telemetry = contract.telemetry;
	const paths = [
		...(telemetry === null
			? []
			: [
					...telemetry.configModules.map((entry) => entry.path),
					telemetry.scrubModule,
				]),
		...contract.writes.map((entry) => entry.path),
		...contract.governedElsewhere.flatMap((entry) => [
			entry.path,
			entry.authority,
		]),
	];
	return [...new Set(paths)].sort();
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
	contract: ExternalWrites | undefined,
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of GATED_PATHS) {
		if (!exists(resolve(root, path)))
			errors.push(`telemetry: ${path} is missing`);
	}
	const manifestPath = resolve(root, "package.json");
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`telemetry: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const fence = fencedCapabilityOf(source, invocation);
		if (fence === "absent")
			errors.push(
				`telemetry: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else {
			// The fence is a fact about the TEMPLATE, not about a render: the
			// renderer deletes the markers along with the blocks it keeps, so a
			// generated project's step is correctly unfenced.
			if (isTemplateTree(root) && fence !== CAPABILITY)
				errors.push(
					`telemetry: the \`${invocation}\` step must sit inside a ${CAPABILITY} capability fence`,
				);
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`telemetry: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`telemetry: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	for (const declared of declaredPaths(contract)) {
		if (!exists(resolve(root, declared)))
			errors.push(
				`telemetry: ${REGISTRY_PATH} declares ${declared}, which is missing`,
			);
	}
	return errors.sort();
}

/**
 * Template ownership, which is where a capability's files become a capability.
 *
 * The `copy` entries must precede the `scripts/template/**` omit catch-all or
 * the render drops the guard while `package.json` still declares the script —
 * which the fixture suite catches as a DIFFERENT error and sends you looking in
 * the wrong file. The reserved configuration root is gated here even though
 * nothing creates it, so the first downstream project to use it is governed
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
			errors.push(`telemetry: template ownership must cover ${pattern}`);
	}
	const artifacts = records(ownership["artifactRules"]);
	for (const pattern of [...GATED_PATHS, `${RESERVED_TELEMETRY_ROOT}/**`]) {
		const rule = artifacts.find((entry) => entry["pattern"] === pattern);
		const requires = Array.isArray(rule?.["requiresAll"])
			? rule["requiresAll"]
			: [];
		if (!requires.includes(CAPABILITY))
			errors.push(`telemetry: ${pattern} must be gated by the capability`);
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
			`telemetry: the ${CAPABILITY} package rule must strip the ${GUARD_SCRIPT} script`,
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
	for (const pattern of [...GATED_PATHS, `${RESERVED_TELEMETRY_ROOT}/**`]) {
		if (!signaturePaths.includes(pattern))
			errors.push(
				`telemetry: ${pattern} must be a declared capability signature`,
			);
	}
	const signatureTokens = Array.isArray(signature["tokens"])
		? signature["tokens"]
		: [];
	// The SDK scope is the reservation Stage 0 made; the guard script is this
	// stage's own addition and behaves exactly as every other capability's does.
	// Neither the capability NAME nor the registry filename is a token: both
	// appear, or could appear, in core prose and in a core module's deployment
	// credential pattern.
	for (const token of [SDK_SCOPE, GUARD_SCRIPT]) {
		if (!signatureTokens.includes(token))
			errors.push(
				`telemetry: ${token} must be a declared capability signature token`,
			);
	}
	const inventory = isRecord(ownership["capabilityInventory"])
		? ownership["capabilityInventory"]
		: {};
	const absent = Array.isArray(inventory["absent"]) ? inventory["absent"] : [];
	if (absent.includes(CAPABILITY))
		errors.push(
			`telemetry: ${CAPABILITY} ships a guard surface and must leave the absent inventory`,
		);
	return errors.sort();
}

/**
 * Delegated authority, reconciled in both directions.
 *
 * This is the entry that stops the write-shape scan from being a scan with
 * nothing to find. The tree DOES contain a remote write; it is named here, its
 * rules live in a module that predates this registry, and both facts are
 * checked: an authority that is not a file is a promise nobody can read, and a
 * delegated path that performs no write at all is a stale entry that quietly
 * widens the exemption.
 */
export function validateGovernedElsewhere(
	root: string,
	contract: ExternalWrites,
): string[] {
	const errors: string[] = [];
	for (const entry of contract.governedElsewhere) {
		if (!exists(resolve(root, entry.authority))) {
			errors.push(
				`telemetry: ${entry.path} names the authority ${entry.authority}, which is not a file`,
			);
			continue;
		}
		const source = textOf(resolve(root, entry.path));
		if (source === "") continue;
		if (writeShapesOf(entry.path, source).length === 0)
			errors.push(
				`telemetry: ${entry.path} is exempted as governed elsewhere but performs no remote write; a stale exemption widens itself`,
			);
		if (!textOf(resolve(root, entry.authority)).includes(entry.path))
			errors.push(
				`telemetry: ${entry.authority} does not name ${entry.path}; an authority that never reads the file it governs governs nothing`,
			);
	}
	return errors.sort();
}

type Node = import("typescript").Node;

interface ParsedModule {
	path: string;
	source: string;
	file: import("typescript").SourceFile;
}

function parseModule(root: string, path: string): ParsedModule | undefined {
	const api = typescript();
	if (!api) return undefined;
	const source = textOf(resolve(root, path));
	if (source === "") return undefined;
	return {
		path,
		source,
		file: api.createSourceFile(
			path,
			source,
			api.ScriptTarget.Latest,
			true,
			path.endsWith("x") ? api.ScriptKind.TSX : api.ScriptKind.TS,
		),
	};
}

function eachNode(node: Node, visit: (node: Node) => void): void {
	const api = typescript();
	if (!api) return;
	const walk = (current: Node): void => {
		visit(current);
		api.forEachChild(current, walk);
	};
	walk(node);
}

/** Every ancestor of a node, innermost first, stopping below the source file. */
function ancestors(node: Node): Node[] {
	const api = typescript();
	const found: Node[] = [];
	if (!api) return found;
	let current = node.parent;
	while (current && !api.isSourceFile(current)) {
		found.push(current);
		current = current.parent;
	}
	return found;
}

function namesAny(text: string, names: Iterable<string>): boolean {
	for (const name of names) {
		if (
			new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:$|[^A-Za-z0-9_$])`).test(text)
		)
			return true;
	}
	return false;
}

/**
 * The declared modules a telemetry surface may live in.
 *
 * This is an ALLOWLIST and never a denylist. A denylist over SDK entry points
 * is a list of the call sites somebody already found, and the first spelling
 * nobody thought of ships an identity into a crash report. A project that adds
 * a module extends the allowlist by DECLARING it — which is also the reference
 * implementation's rule, written into its own allowlist header: never weaken
 * the guard's patterns to work around a violation here; fix the call site
 * instead.
 */
function declaredModules(contract: ExternalWrites): Set<string> {
	const telemetry = contract.telemetry;
	if (telemetry === null) return new Set();
	return new Set([
		...telemetry.configModules.map((entry) => entry.path),
		telemetry.scrubModule,
	]);
}

/**
 * SDK confinement, ported refusal by refusal.
 *
 * In `skeleton` mode the allowed set is empty, which is exactly the assertion
 * that mode makes: the SDK appears nowhere at all. The user binding is banned
 * in BOTH modes and in every file, declared or not — it is the one call whose
 * whole purpose is to attach an identity to a report that leaves the building.
 */
export function validateSurfaceConfinement(
	root: string,
	contract: ExternalWrites,
): string[] {
	const errors: string[] = [];
	const allowed = declaredModules(contract);
	for (const path of enumerateFiles(root)) {
		if (!isSourceFile(path) || !isShipped(path)) continue;
		const source = textOf(resolve(root, path));
		if (source === "") continue;
		// The executable half only, here as everywhere else. A comment that names
		// the banned call in order to explain why it is banned is not an instance
		// of it, and a rule that could not tell the difference would make writing
		// the explanation impossible.
		const code = executableHalf(path, source);
		if (code.includes(USER_BINDING))
			errors.push(
				`telemetry: ${path} binds a telemetry user identity; the SDK's user binding attaches an identity to every report and is banned everywhere`,
			);
		if (allowed.has(path)) continue;
		const specifiers = moduleSpecifiers(path, source);
		if (specifiers !== undefined && importsSdk(specifiers))
			errors.push(
				`telemetry: ${path} imports the telemetry SDK outside a declared configuration module`,
			);
		if (code.includes(INITIALIZER))
			errors.push(
				`telemetry: ${path} calls the telemetry SDK initializer outside a declared configuration module`,
			);
		if (code.includes(LOGGER_NAMESPACE) || code.includes(METRICS_NAMESPACE))
			errors.push(
				`telemetry: ${path} reaches the telemetry SDK's structured logger or metrics namespace outside a declared configuration module`,
			);
	}
	return [...new Set(errors)].sort();
}

/**
 * Local names bound to an environment variable, resolved one hop.
 *
 * A gate almost never reads `process.env.X` twice; it reads it once into a
 * local and then decides. One hop is what makes the dominance rule below a
 * statement about the DECISION rather than about the read.
 */
function envBindings(module: ParsedModule, variable: string): Set<string> {
	const api = typescript();
	const found = new Set<string>([variable]);
	if (!api) return found;
	eachNode(module.file, (node) => {
		if (!api.isVariableDeclaration(node) || !api.isIdentifier(node.name))
			return;
		const initializer = node.initializer;
		if (!initializer) return;
		if (namesAny(initializer.getText(module.file), [variable]))
			found.add(node.name.text);
	});
	return found;
}

/**
 * The truth table, as a projection onto the AST.
 *
 * The reference writes it as nine lines of a real function, so there is nothing
 * to infer there — the behaviour IS the code. A template has no such function,
 * so the static half asserts the SHAPE the table must have and the suite
 * executes the table itself against a recorder.
 *
 * Three rules, and each one names the state it protects. Something must read
 * both halves, or the gate is on one half and therefore on nothing. No read of
 * the credential may sit in a branch the intent does not dominate — that is the
 * projection of `disable: !release || !authToken`, and it is the rule that
 * keeps a leaked token in a developer shell from minting a phantom release.
 * And the partial state must be LOUD: a build that silently skips the upload
 * is a build nobody notices skipping it.
 */
export function validateTruthTable(
	root: string,
	contract: ExternalWrites,
): string[] {
	const api = typescript();
	const telemetry = contract.telemetry;
	const upload = telemetry?.upload;
	if (!telemetry || !upload || !api) return [];
	const errors: string[] = [];
	// The gate is `intent x credential`, never an environment flag. A source-map
	// upload that can reach the server bundle is a different artifact leaving the
	// building than the one the scope declares.
	if (upload.scope !== "client")
		errors.push(
			`telemetry: ${REGISTRY_PATH} declares the upload scope ${upload.scope}; an upload that can reach the server bundle is a refusal`,
		);
	let gated = false;
	let warned = false;
	for (const entry of telemetry.configModules) {
		const module = parseModule(root, entry.path);
		if (!module) continue;
		const release = envBindings(module, upload.releaseVariable);
		const token = envBindings(module, upload.tokenVariable);
		const readsRelease = namesAny(module.source, release);
		const readsToken = namesAny(module.source, token);
		if (readsRelease && readsToken) gated = true;
		if (!readsToken) continue;
		eachNode(module.file, (node) => {
			const isName =
				(api.isIdentifier(node) && token.has(node.text)) ||
				(api.isStringLiteralLike(node) &&
					token.has((node as { text: string }).text));
			if (!isName) return;
			const chain = ancestors(node);
			// The binding site itself is not a use. `const authToken =
			// process.env.…` reads the credential in order to have it; the question
			// this rule asks is what the module DOES with it afterwards.
			if (
				chain.some(
					(parent) =>
						api.isVariableDeclaration(parent) &&
						api.isIdentifier(parent.name) &&
						token.has(parent.name.text),
				)
			)
				return;
			if (
				chain.some((parent) => namesAny(parent.getText(module.file), release))
			)
				return;
			errors.push(
				`telemetry: ${entry.path} reads ${upload.tokenVariable} in a branch ${upload.releaseVariable} does not dominate; the gate is intent times credential`,
			);
		});
		eachNode(module.file, (node) => {
			if (!api.isCallExpression(node)) return;
			const callee = node.expression.getText(module.file);
			if (!/\.warn$/.test(callee) && !node.getText(module.file).includes("::"))
				return;
			const dominating = ancestors(node).flatMap((parent) =>
				api.isIfStatement(parent)
					? [parent.expression.getText(module.file)]
					: api.isConditionalExpression(parent)
						? [parent.condition.getText(module.file)]
						: [],
			);
			if (
				dominating.some(
					(condition) =>
						namesAny(condition, release) && namesAny(condition, token),
				)
			)
				warned = true;
		});
	}
	if (!gated)
		errors.push(
			`telemetry: no declared configuration module reads both ${upload.releaseVariable} and ${upload.tokenVariable}; an upload gated on one half is gated on nothing`,
		);
	if (!warned)
		errors.push(
			`telemetry: no declared configuration module warns from a branch that reads both ${upload.releaseVariable} and ${upload.tokenVariable}; a build that silently skips the upload is a build nobody notices`,
		);
	return [...new Set(errors)].sort();
}

/**
 * Every declared write, against the file that performs it.
 *
 * The spec sentence is the second rule: credential presence alone must not
 * authorize a remote write, so the file has to read a named intent as well as
 * its credentials. The verifier is the fourth: a separate, read-only command,
 * never a flag on the write — a verifier that shares the writer's code path can
 * only confirm what the writer already believed, and one that mutates confirms
 * nothing but its own effect.
 */
export function validateDeclaredWrites(
	root: string,
	contract: ExternalWrites,
): string[] {
	const errors: string[] = [];
	const commands = new Set(contract.writes.map((entry) => entry.command));
	const uploadCommand = contract.telemetry?.upload?.command;
	for (const entry of contract.writes) {
		const source = textOf(resolve(root, entry.path));
		const code = source === "" ? "" : executableHalf(entry.path, source);
		if (source !== "" && writeShapesOf(entry.path, source).length === 0)
			errors.push(
				`telemetry: ${entry.path} is declared as the write ${entry.id} but performs no remote write`,
			);
		if (source !== "" && !code.includes(entry.intent))
			errors.push(
				`telemetry: ${entry.path} never reads the intent ${entry.intent}; a credential is not an authorization`,
			);
		for (const credential of entry.credentials) {
			if (source !== "" && !code.includes(credential))
				errors.push(
					`telemetry: ${entry.path} declares the credential ${credential} and never reads it`,
				);
		}
		if (entry.verify === entry.command || commands.has(entry.verify))
			errors.push(
				`telemetry: the write ${entry.id} verifies with its own write command; verification is a separate command, never a flag on the write`,
			);
		if (uploadCommand !== undefined && entry.verify === uploadCommand)
			errors.push(
				`telemetry: the write ${entry.id} verifies with the declared upload command; verification is a separate command, never a flag on the write`,
			);
		if (
			WRITE_SHAPES.some((shape) =>
				commandPosition(shape.parts.join("")).test(entry.verify),
			)
		)
			errors.push(
				`telemetry: the write ${entry.id} declares a verify command that is itself a remote write; a verifier that mutates confirms only its own effect`,
			);
		if (source !== "" && !code.includes(entry.verify))
			errors.push(
				`telemetry: ${entry.path} never runs the declared verify command ${entry.verify}; an unread final state is an unasserted one`,
			);
	}
	return [...new Set(errors)].sort();
}

/**
 * The whole telemetry and external-write contract, with the notices the caller
 * prints.
 *
 * The order is the safety property. An unreadable registry stops everything,
 * because every leg below reads it; a mode disagreement stops everything too,
 * because every leg below is written for one of the two worlds and would answer
 * the wrong question in the other.
 */
export async function inspectTelemetryContract(
	root = resolve(import.meta.dir, "../.."),
	_options: TelemetryContractOptions = {},
): Promise<TelemetryReport> {
	const notices: string[] = [];
	const { contract, errors: registryErrors } = await readExternalWrites(root);
	if (!contract)
		return { errors: [...new Set(registryErrors)].sort(), notices };

	const state = deriveTreeState(root, contract);
	const reconciliation = reconcileMode(contract, state);
	if (reconciliation.length > 0)
		return {
			errors: [...new Set([...registryErrors, ...reconciliation])].sort(),
			notices,
		};

	const errors = [
		...registryErrors,
		...validateSoleDeclarations(enumerateFiles(root), contract),
		...(await validateWiring(root, contract)),
		...(await validateOwnership(root)),
		...validateGovernedElsewhere(root, contract),
		...validateSurfaceConfinement(root, contract),
		...validateTruthTable(root, contract),
		...validateDeclaredWrites(root, contract),
	];
	return { errors: [...new Set(errors)].sort(), notices };
}

/** The error half, in the shape `validate.ts` aggregates. */
export async function validateTelemetryContract(
	root = resolve(import.meta.dir, "../.."),
	options: TelemetryContractOptions = {},
): Promise<string[]> {
	return (await inspectTelemetryContract(root, options)).errors;
}
