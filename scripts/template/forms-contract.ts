// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import {
	type Dirent,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "api-contract.json";
export const REGISTRY_SCHEMA_PATH = "api-contract.schema.json";
export const GUARD_CONTRACT = "scripts/template/forms-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-forms.ts";
export const GUARD_SCRIPT = "forms:check";

// The capability that owns every file this stage adds. Named here and in no
// core module: `ci-contract.ts` and `biome.jsonc` ship to EVERY rendered
// project, and the anti-residue scan is a plain substring search over every
// file of a render whose capability is off.
export const CAPABILITY = "rhf_zod";

// Where a downstream project's shared schema package goes. Stage 0 pre-reserved
// this path for the capability before anything existed to put in it, and the
// reservation is where the artifact WOULD live rather than a promise to create
// one — the `playwright` capability reserves `scripts/browser-preflight.ts` the
// same way and ships no application either.
export const RESERVED_SCHEMA_ROOT = "libs/forms";

// The one external specifier a shared schema package may name. It is also the
// package family `toolchain.ts` already couples, which is what makes this
// capability — and not a new one — the correct gate for the whole stage: the
// contract artifact is rendered FROM the schema registry, so gating the
// response half on a second flag would split one authority across two.
export const SCHEMA_LIBRARY = "zod";

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

// Two needles this guard scans the tracked tree for, assembled at runtime so
// that this file is not itself a match. A guard that matched its own source
// would need a path exemption, and a path exemption is a hole somebody
// eventually widens.
const RESOLVER_BINDING = `${SCHEMA_LIBRARY}Resolver(`;
const GENERATED_MARKER = ["DO", "NOT", "EDIT"].join(" ");

// Directories no tree walk descends into. `tmp/` is where `template:fixtures`
// renders and a rendered fixture carries a full copy of this tree — walking
// into one would invent a schema package that no commit owns. `graphify-out/`
// is tracked here, so it has to be pruned out of the tracked list as well as
// out of the directory walk.
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

export interface SchemaPackage {
	id: string;
	root: string;
	entry: string;
	allowedSpecifiers: string[];
}

export interface OpenapiClient {
	path: string;
	banner: string;
}

export interface OpenapiDeclaration {
	artifact: string;
	generate: string;
	clients: OpenapiClient[];
}

export interface PolicySeam {
	root: string;
	denialModule: string;
	exemptMessages?: string[];
}

export interface FormModule {
	path: string;
	schemas: string[];
}

export interface ServerParser {
	path: string;
	surface: string;
	envelope: string;
	clientMapping?: string;
}

export interface EvolutionEntry {
	operation: string;
	stage: "add" | "migrate" | "remove";
	note: string;
}

export interface ApiContract {
	schemaVersion: 1;
	mode: "skeleton" | "active";
	schemaPackages: SchemaPackage[];
	openapi: OpenapiDeclaration | null;
	policySeam: PolicySeam | null;
	formModules: FormModule[];
	serverParsers: ServerParser[];
	evolution: EvolutionEntry[];
}

/** What the tree looks like, independent of what the registry claims. */
export type SurfaceShape =
	| "reserved-path"
	| "schema-import"
	| "form-binding"
	| "generated-artifact";

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

export interface FormsContractOptions {
	/** Reserved for the legs that need a binary or a Git object. */
	root?: string;
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
 * through the same exclusion list, since a tracked `graphify-out/` would
 * otherwise put a generated knowledge graph in front of a rule about generated
 * artifacts.
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
 * A regex over TypeScript is a substring search wearing a contract's clothes,
 * and `ts-morph` — which the reference implementation uses — would change
 * `bun.lock`. `typescript` is already a catalog entry and a devDependency here,
 * so the AST is free; the load is lazy and failure is reported as a named error
 * rather than thrown, because a guard that cannot read the tree must say so.
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

export function isSourceFile(path: string): boolean {
	return SOURCE_EXTENSIONS.has(extensionOf(path));
}

/**
 * Every module specifier a source file names, from the AST and never from a
 * regex.
 *
 * All five spellings count: `import … from`, `export … from`, `import x =
 * require(…)`, a dynamic `import(…)`, and a bare side-effect import. A leg that
 * only knew about the first would pass a package that reached the server
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

function importsSchemaLibrary(specifiers: string[]): boolean {
	return specifiers.some(
		(specifier) =>
			specifier === SCHEMA_LIBRARY ||
			specifier.startsWith(`${SCHEMA_LIBRARY}/`),
	);
}

// A generated artifact announces itself in its own first lines. Anchoring the
// scan there rather than anywhere in the file is what lets a changelog entry,
// a stage README and this guard's own tests discuss the banner in prose without
// becoming instances of it.
function carriesGeneratedBanner(source: string): boolean {
	return source.split("\n", 5).some((line) => line.includes(GENERATED_MARKER));
}

/**
 * What the tree actually carries, derived and never declared.
 *
 * This is the half of the reconciliation the registry cannot lie about. Four
 * shapes, each of which is the visible consequence of a shared schema surface
 * existing: a file under the reserved package root, a file importing the schema
 * library, a file binding a form resolver, and a file carrying a generated
 * artifact's banner.
 */
export function deriveTreeState(root: string): TreeState {
	const files = enumerateFiles(root);
	const signals: SurfaceSignal[] = [];
	const errors: string[] = [];
	if (files.length === 0)
		errors.push(
			`forms: the tracked-file scan found nothing under ${root}; a rule with no input has answered nothing`,
		);
	let compilerMissing = false;
	for (const path of files) {
		if (
			path === RESERVED_SCHEMA_ROOT ||
			path.startsWith(`${RESERVED_SCHEMA_ROOT}/`)
		) {
			signals.push({
				path,
				shape: "reserved-path",
				detail: `${path} lives under the reserved schema package root ${RESERVED_SCHEMA_ROOT}`,
			});
		}
		const source = textOf(resolve(root, path));
		if (source === "") continue;
		if (extensionOf(path) !== ".md" && carriesGeneratedBanner(source)) {
			signals.push({
				path,
				shape: "generated-artifact",
				detail: `${path} opens with a generated-artifact banner`,
			});
		}
		if (!isSourceFile(path)) continue;
		if (source.includes(RESOLVER_BINDING)) {
			signals.push({
				path,
				shape: "form-binding",
				detail: `${path} binds a form resolver`,
			});
		}
		const specifiers = moduleSpecifiers(path, source);
		if (specifiers === undefined) {
			compilerMissing = true;
			continue;
		}
		if (importsSchemaLibrary(specifiers)) {
			signals.push({
				path,
				shape: "schema-import",
				detail: `${path} imports the shared schema library`,
			});
		}
	}
	if (compilerMissing)
		errors.push(
			`forms: the TypeScript compiler API is unavailable; run bun install before ${GUARD_SCRIPT}`,
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
export async function readApiContract(
	root: string,
): Promise<{ contract?: ApiContract; errors: string[] }> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`forms: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`forms: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`forms: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`forms: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `forms: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { contract: value as ApiContract, errors };
}

/**
 * The registry is the only one, and every declared thing is declared once.
 *
 * A second registry anywhere in the tree is the same defect as a second matrix
 * universe registry: two files claiming to be the authority means neither is.
 * The duplicate-surface rule is 13.1's "remove superseded validators
 * atomically" — there is no handwritten validator in this tree to supersede, so
 * the clause ships as a refusal that holds going forward instead of as an
 * assertion about a past that does not exist.
 */
export function validateSoleDeclarations(
	files: string[],
	contract: ApiContract | undefined,
): string[] {
	const errors: string[] = [];
	for (const path of files) {
		if (path === REGISTRY_PATH) continue;
		if (path.slice(path.lastIndexOf("/") + 1) === REGISTRY_PATH)
			errors.push(
				`forms: ${path} is a second api contract registry; ${REGISTRY_PATH} is the only one`,
			);
	}
	if (!contract) return errors.sort();
	const seenSurface = new Map<string, string>();
	for (const parser of contract.serverParsers) {
		const declared = seenSurface.get(parser.surface);
		if (declared !== undefined)
			errors.push(
				`forms: ${parser.path} is a second validator for ${parser.surface}; ${declared} is the only one`,
			);
		else seenSurface.set(parser.surface, parser.path);
	}
	const seenPackage = new Map<string, string>();
	for (const entry of contract.schemaPackages) {
		const declared = seenPackage.get(entry.id);
		if (declared !== undefined)
			errors.push(
				`forms: ${entry.root} is a second schema package named ${entry.id}; ${declared} is the only one`,
			);
		else seenPackage.set(entry.id, entry.root);
	}
	const seenForm = new Set<string>();
	for (const entry of contract.formModules) {
		if (seenForm.has(entry.path))
			errors.push(`forms: ${entry.path} is declared twice as a form module`);
		seenForm.add(entry.path);
	}
	const seenClient = new Set<string>();
	for (const client of contract.openapi?.clients ?? []) {
		if (seenClient.has(client.path))
			errors.push(
				`forms: ${client.path} is declared twice as a generated client`,
			);
		seenClient.add(client.path);
	}
	return errors.sort();
}

/**
 * The declared mode against the derived one, in both directions.
 *
 * This is what keeps every leg below it from being a no-op. A query over an
 * empty tree is trivially true, so "found nothing, passed" would be the normal
 * outcome for a template that ships no application — and a rule whose normal
 * outcome is silence is not a rule. Instead the registry states which of the
 * two worlds this is, and a tree that grew a surface while the registry still
 * said `skeleton` fails by name, as does a registry that declares a surface the
 * tree does not have.
 */
export function reconcileMode(
	contract: ApiContract,
	state: TreeState,
): string[] {
	const errors: string[] = [...state.errors];
	const declared =
		contract.schemaPackages.length +
		contract.formModules.length +
		contract.serverParsers.length +
		(contract.openapi === null ? 0 : 1);
	if (contract.mode === "skeleton") {
		for (const signal of state.signals)
			errors.push(
				`forms: ${REGISTRY_PATH} declares skeleton mode but ${signal.detail}`,
			);
		// The same assertion from the registry's side. A skeleton that declares a
		// contract artifact has already left skeleton, and every leg below would
		// then be asked a question about a world the mode says does not exist.
		if (declared > 0)
			errors.push(
				`forms: ${REGISTRY_PATH} declares skeleton mode but declares a contract surface`,
			);
		return errors.sort();
	}
	if (declared === 0)
		errors.push(
			`forms: ${REGISTRY_PATH} declares active mode but declares no schema package, contract artifact, form module or server parser`,
		);
	if (state.mode === "skeleton")
		errors.push(
			`forms: ${REGISTRY_PATH} declares active mode but no tracked file carries a shared schema surface`,
		);
	return errors.sort();
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
	contract: ApiContract | undefined,
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of GATED_PATHS) {
		if (!exists(resolve(root, path))) errors.push(`forms: ${path} is missing`);
	}
	const manifestPath = resolve(root, "package.json");
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`forms: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const fence = fencedCapabilityOf(source, invocation);
		if (fence === "absent")
			errors.push(
				`forms: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else {
			// The fence is a fact about the TEMPLATE, not about a render: the
			// renderer deletes the markers along with the blocks it keeps, so a
			// generated project's step is correctly unfenced. `template-parameters.toml`
			// is the one file that says which tree this is, and it is the same
			// marker the workflow's own browser lane already switches on.
			if (isTemplateTree(root) && fence !== CAPABILITY)
				errors.push(
					`forms: the \`${invocation}\` step must sit inside a ${CAPABILITY} capability fence`,
				);
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`forms: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`forms: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	for (const declared of declaredPaths(contract)) {
		if (!exists(resolve(root, declared)))
			errors.push(
				`forms: ${REGISTRY_PATH} declares ${declared}, which is missing`,
			);
	}
	return errors.sort();
}

/** Every repository-relative path the registry promises. */
export function declaredPaths(contract: ApiContract | undefined): string[] {
	if (!contract) return [];
	const paths = [
		...contract.schemaPackages.flatMap((entry) => [entry.root, entry.entry]),
		...(contract.openapi === null
			? []
			: [
					contract.openapi.artifact,
					...contract.openapi.clients.map((client) => client.path),
				]),
		...(contract.policySeam === null
			? []
			: [contract.policySeam.root, contract.policySeam.denialModule]),
		...contract.formModules.map((entry) => entry.path),
		...contract.serverParsers.flatMap((entry) =>
			entry.clientMapping === undefined
				? [entry.path]
				: [entry.path, entry.clientMapping],
		),
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
 * Template ownership, which is where a capability's files become a capability.
 *
 * The `copy` entries must precede the `scripts/template/**` omit catch-all or
 * the render drops the guard while `package.json` still declares the script —
 * which the fixture suite catches as a DIFFERENT error and sends you looking in
 * the wrong file. The reserved package root is gated here even though nothing
 * creates it, so the first downstream project to use it is governed from its
 * first commit rather than from the commit somebody noticed.
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
			errors.push(`forms: template ownership must cover ${pattern}`);
	}
	const artifacts = records(ownership["artifactRules"]);
	for (const pattern of [...GATED_PATHS, `${RESERVED_SCHEMA_ROOT}/**`]) {
		const rule = artifacts.find((entry) => entry["pattern"] === pattern);
		const requires = Array.isArray(rule?.["requiresAll"])
			? rule["requiresAll"]
			: [];
		if (!requires.includes(CAPABILITY))
			errors.push(`forms: ${pattern} must be gated by the capability`);
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
			`forms: the ${CAPABILITY} package rule must strip the ${GUARD_SCRIPT} script`,
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
	for (const pattern of GATED_PATHS) {
		if (!signaturePaths.includes(pattern))
			errors.push(`forms: ${pattern} must be a declared capability signature`);
	}
	const signatureTokens = Array.isArray(signature["tokens"])
		? signature["tokens"]
		: [];
	if (!signatureTokens.includes(GUARD_SCRIPT))
		errors.push(
			`forms: ${GUARD_SCRIPT} must be a declared capability signature token`,
		);
	const inventory = isRecord(ownership["capabilityInventory"])
		? ownership["capabilityInventory"]
		: {};
	const absent = Array.isArray(inventory["absent"]) ? inventory["absent"] : [];
	if (absent.includes(CAPABILITY))
		errors.push(
			`forms: ${CAPABILITY} ships a guard surface and must leave the absent inventory`,
		);
	return errors.sort();
}

function insidePackage(packageRoot: string, candidate: string): boolean {
	return candidate === packageRoot || candidate.startsWith(`${packageRoot}/`);
}

/** Lexical resolution of a relative specifier, with no filesystem involved. */
function resolveRelative(from: string, specifier: string): string {
	const segments = from.split("/").slice(0, -1);
	for (const segment of specifier.split("/")) {
		if (segment === "." || segment === "") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
}

function allowedSpecifier(specifier: string, allowed: string[]): boolean {
	return allowed.some(
		(entry) => specifier === entry || specifier.startsWith(`${entry}/`),
	);
}

/**
 * Browser safety, as an ALLOWLIST.
 *
 * A denylist over server-only modules is the wrong shape: it is a list of the
 * mistakes somebody already made, and the first import nobody thought of ships
 * a database driver into a browser bundle. So a shared schema package may name
 * the schema library, whatever else it declares, and relative paths that
 * resolve INSIDE its own root — `../../shared/src/x` is a specifier that looks
 * local and is not, and it is exactly the one this rule exists to catch.
 *
 * Zero files under a declared package root is a distinct failure rather than a
 * pass: a scan with no input has answered nothing, which is the classic hole in
 * a rule of this shape.
 */
export function validateBrowserSafety(
	root: string,
	contract: ApiContract,
	state: TreeState,
): string[] {
	const errors: string[] = [];
	if (state.scanned === 0)
		return [
			"forms: the browser-safety scan read no file at all; a rule with no input has answered nothing",
		];
	const files = enumerateFiles(root).filter(isSourceFile);
	const roots = contract.schemaPackages.map((entry) => entry.root);
	const outside = (path: string): boolean =>
		!roots.some((packageRoot) => insidePackage(packageRoot, path));

	// The half that holds in BOTH modes, and the whole of the rule in
	// `skeleton`: nothing may reach for the schema library except a package that
	// declared itself. The mode reconciliation above names the same file first
	// and with a different message — that one says the registry is wrong, this
	// one says the file is.
	for (const path of files) {
		if (!outside(path)) continue;
		const specifiers = moduleSpecifiers(path, textOf(resolve(root, path)));
		if (specifiers === undefined) continue;
		if (importsSchemaLibrary(specifiers))
			errors.push(
				`forms: ${path} imports the shared schema library outside a declared schema package`,
			);
	}

	for (const entry of contract.schemaPackages) {
		const owned = files.filter((path) => insidePackage(entry.root, path));
		if (owned.length === 0) {
			errors.push(
				`forms: the schema package ${entry.id} at ${entry.root} contains no file to scan`,
			);
			continue;
		}
		if (!insidePackage(entry.root, entry.entry))
			errors.push(
				`forms: the schema package ${entry.id} declares the entry ${entry.entry}, which is outside ${entry.root}`,
			);
		// The schema library is always legal inside a package whose whole job is
		// to declare schemas; `allowedSpecifiers` extends that, it does not
		// replace it.
		const allowed = [...new Set([SCHEMA_LIBRARY, ...entry.allowedSpecifiers])];
		for (const path of owned) {
			const specifiers = moduleSpecifiers(path, textOf(resolve(root, path)));
			if (specifiers === undefined) continue;
			for (const specifier of specifiers) {
				if (allowedSpecifier(specifier, allowed)) continue;
				if (specifier.startsWith(".")) {
					if (insidePackage(entry.root, resolveRelative(path, specifier)))
						continue;
					errors.push(
						`forms: ${path} imports ${specifier}, which resolves outside the schema package ${entry.id}`,
					);
					continue;
				}
				errors.push(
					`forms: ${path} imports ${specifier}, which the schema package ${entry.id} does not allow`,
				);
			}
		}
	}
	return [...new Set(errors)].sort();
}

// The generator's binary, injectable exactly as `MOON_BIN` and `OPENSPEC_BIN`
// are: a failure path nothing can execute is a failure path nobody has checked.
export const GENERATE_BIN_VARIABLE = "FORMS_GENERATE_BIN";

// The ref the evolution gate diffs against. A template cannot know a downstream
// project's default branch, so it is injectable and then guessed from the
// remote — and when neither answers, the gate says so out loud instead of
// passing quietly.
export const MERGE_BASE_VARIABLE = "FORMS_MERGE_BASE";
const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "main"] as const;

const BIOME_CONFIG = "biome.jsonc";

/**
 * JSONC with its comments removed, which is the only way to read a file whose
 * whole point is that it carries them.
 *
 * Quote state is tracked because a `//` inside a glob string is a glob, not a
 * comment — and a stripper that could not tell the difference would silently
 * truncate the very `includes` list this guard reads.
 */
export function stripJsonComments(source: string): string {
	let output = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index] ?? "";
		const next = source[index + 1] ?? "";
		if (inLine) {
			if (character === "\n") {
				inLine = false;
				output += character;
			}
			continue;
		}
		if (inBlock) {
			if (character === "*" && next === "/") {
				inBlock = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			output += character;
			if (character === "\\") {
				output += next;
				index += 1;
				continue;
			}
			if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			continue;
		}
		if (character === "/" && next === "/") {
			inLine = true;
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			inBlock = true;
			index += 1;
			continue;
		}
		output += character;
	}
	return output;
}

function matchesGlob(pattern: string, path: string): boolean {
	return new Bun.Glob(pattern).match(path);
}

/**
 * Biome must not touch a generated artifact.
 *
 * The compare is byte-for-byte against what the generator emits, so a
 * reformatted artifact is a correct artifact that fails its own gate — and the
 * failure names the file rather than the formatter, which is the wrong place to
 * look. All three tools are checked, not just the formatter: an assist action
 * rewrites a file just as thoroughly.
 *
 * The override is required in BOTH modes. In `skeleton` there is no artifact to
 * cover, and a rule that only ran once one existed would be a rule the first
 * generated artifact ships without.
 */
export async function validateGeneratedOutputPolicy(
	root: string,
	contract: ApiContract,
): Promise<string[]> {
	const path = resolve(root, BIOME_CONFIG);
	if (!exists(path)) return [];
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(textOf(path))) as unknown;
	} catch {
		return [`forms: ${BIOME_CONFIG} must parse as JSON with comments`];
	}
	const overrides = isRecord(value) ? records(value["overrides"]) : [];
	const exempting = overrides.filter((entry) => {
		const off = (key: string): boolean => {
			const section = entry[key];
			return isRecord(section) && section["enabled"] === false;
		};
		return off("linter") && off("formatter") && off("assist");
	});
	if (exempting.length === 0)
		return [
			`forms: ${BIOME_CONFIG} must exempt generated output from the linter, the formatter and the assist actions`,
		];
	const errors: string[] = [];
	for (const artifact of contract.openapi === null
		? []
		: [
				contract.openapi.artifact,
				...contract.openapi.clients.map((client) => client.path),
			]) {
		const covered = exempting.some((entry) =>
			(Array.isArray(entry["includes"]) ? entry["includes"] : []).some(
				(pattern) =>
					typeof pattern === "string" && matchesGlob(pattern, artifact),
			),
		);
		if (!covered)
			errors.push(
				`forms: ${BIOME_CONFIG} must exempt the generated ${artifact} from reformatting`,
			);
	}
	return errors.sort();
}

function readBytes(path: string): Uint8Array | undefined {
	try {
		return new Uint8Array(readFileSync(path));
	} catch {
		return undefined;
	}
}

function sameBytes(
	left: Uint8Array | undefined,
	right: Uint8Array | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.length !== right.length) return false;
	return left.every((byte, index) => byte === right[index]);
}

/** The declared command as an argv, with its binary optionally injected. */
export function generateArgv(command: string): string[] {
	const argv = command.trim().split(/\s+/).filter(Boolean);
	const injected = process.env[GENERATE_BIN_VARIABLE];
	if (injected && argv.length > 0) argv[0] = injected;
	return argv;
}

interface DriftReport {
	errors: string[];
	notices: string[];
}

/**
 * Run the declared generator, read the post-state, then put the tree back.
 *
 * The reference regenerates in memory because its generator lives in the same
 * repository. A template cannot import a downstream project's generator, so the
 * same semantic becomes run-then-compare — and the compare is over the declared
 * artifacts only, from bytes captured before the run, so a drifted repository is
 * never left rewritten by the guard that noticed.
 *
 * The post-state is read IMMEDIATELY after the generator returns and before any
 * restore. A probe that reads its facts after a later step has undone them
 * reports a run that was completely correct as a failure, or worse.
 */
export function runDriftGate(root: string, contract: ApiContract): DriftReport {
	const errors: string[] = [];
	const notices: string[] = [];
	const openapi = contract.openapi;
	if (openapi === null) return { errors, notices };
	const targets = [
		openapi.artifact,
		...openapi.clients.map((client) => client.path),
	];
	const before = new Map<string, Uint8Array | undefined>();
	for (const target of targets)
		before.set(target, readBytes(resolve(root, target)));

	const argv = generateArgv(openapi.generate);
	if (argv.length === 0)
		return {
			errors: [`forms: ${REGISTRY_PATH} declares an empty generator command`],
			notices,
		};
	let result: { exitCode: number; stderr: string } | undefined;
	try {
		const spawned = Bun.spawnSync(argv, {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		result = {
			exitCode: spawned.exitCode,
			stderr: spawned.stderr.toString().trim(),
		};
	} catch (error) {
		result = undefined;
		errors.push(
			`forms: the declared generator \`${openapi.generate}\` could not be executed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Post-state first, restore second, verdict last.
	const after = new Map<string, Uint8Array | undefined>();
	for (const target of targets)
		after.set(target, readBytes(resolve(root, target)));
	for (const target of targets) {
		const original = before.get(target);
		const path = resolve(root, target);
		if (original === undefined) {
			if (after.get(target) !== undefined) unlinkSync(path);
			continue;
		}
		if (!sameBytes(original, after.get(target))) writeFileSync(path, original);
	}

	if (result === undefined) return { errors, notices };
	if (result.exitCode !== 0) {
		errors.push(
			`forms: the declared generator \`${openapi.generate}\` exited ${result.exitCode}${result.stderr === "" ? "" : `: ${result.stderr}`}`,
		);
		return { errors, notices };
	}
	for (const target of targets) {
		if (sameBytes(before.get(target), after.get(target))) continue;
		errors.push(
			`forms: ${target} is a stale generated artifact; run \`${openapi.generate}\` and commit the result`,
		);
	}
	return { errors, notices };
}

/**
 * Every generated client says so in its own first lines.
 *
 * Without the banner the file is indistinguishable from something a person
 * maintains, and the first hand edit to it is a change the generator silently
 * reverts on its next run.
 */
export function validateGeneratedBanners(
	root: string,
	contract: ApiContract,
): string[] {
	const errors: string[] = [];
	for (const client of contract.openapi?.clients ?? []) {
		const source = textOf(resolve(root, client.path));
		if (source === "") continue;
		if (!source.split("\n", 5).some((line) => line.includes(client.banner)))
			errors.push(
				`forms: ${client.path} must open with its declared generated-artifact banner`,
			);
	}
	return errors.sort();
}

interface OperationShape {
	operations: Set<string>;
	properties: Map<string, string>;
	required: Set<string>;
	strictResponses: string[];
}

const HTTP_METHODS = [
	"get",
	"put",
	"post",
	"delete",
	"options",
	"head",
	"patch",
	"trace",
] as const;

function describeSchema(
	node: unknown,
	operation: string,
	pointer: string,
	shape: OperationShape,
	depth: number,
): void {
	if (depth > 12 || !isRecord(node)) return;
	const type = node["type"];
	if (typeof type === "string")
		shape.properties.set(`${operation}${pointer}`, type);
	const required = node["required"];
	if (Array.isArray(required)) {
		for (const name of required)
			if (typeof name === "string")
				shape.required.add(`${operation}${pointer}.${name}`);
	}
	const properties = isRecord(node["properties"]) ? node["properties"] : {};
	for (const [name, child] of Object.entries(properties))
		describeSchema(child, operation, `${pointer}.${name}`, shape, depth + 1);
	const items = node["items"];
	if (items !== undefined)
		describeSchema(items, operation, `${pointer}[]`, shape, depth + 1);
	for (const key of ["allOf", "anyOf", "oneOf"]) {
		const branches = node[key];
		if (!Array.isArray(branches)) continue;
		for (const [index, branch] of branches.entries())
			describeSchema(
				branch,
				operation,
				`${pointer}(${key}:${index})`,
				shape,
				depth + 1,
			);
	}
}

function hasStrictObject(node: unknown, depth = 0): boolean {
	if (depth > 12 || !isRecord(node)) return false;
	if (node["additionalProperties"] === false) return true;
	return Object.values(node).some((child) =>
		Array.isArray(child)
			? child.some((entry) => hasStrictObject(entry, depth + 1))
			: hasStrictObject(child, depth + 1),
	);
}

/** The published contract, reduced to the facts the evolution rules compare. */
export function describeArtifact(source: string): OperationShape | undefined {
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch {
		return undefined;
	}
	const shape: OperationShape = {
		operations: new Set(),
		properties: new Map(),
		required: new Set(),
		strictResponses: [],
	};
	const paths =
		isRecord(value) && isRecord(value["paths"]) ? value["paths"] : {};
	for (const [route, item] of Object.entries(paths)) {
		if (!isRecord(item)) continue;
		for (const method of HTTP_METHODS) {
			const operation = item[method];
			if (!isRecord(operation)) continue;
			const id = `${method.toUpperCase()} ${route}`;
			shape.operations.add(id);
			const body = isRecord(operation["requestBody"])
				? operation["requestBody"]
				: {};
			const bodyContent = isRecord(body["content"]) ? body["content"] : {};
			for (const media of Object.values(bodyContent)) {
				if (isRecord(media))
					describeSchema(media["schema"], id, "#request", shape, 0);
			}
			const responses = isRecord(operation["responses"])
				? operation["responses"]
				: {};
			for (const [status, response] of Object.entries(responses)) {
				if (!isRecord(response)) continue;
				const content = isRecord(response["content"])
					? response["content"]
					: {};
				for (const media of Object.values(content)) {
					if (!isRecord(media)) continue;
					describeSchema(media["schema"], id, `#${status}`, shape, 0);
					// The asymmetry the reference spells out: strict in the tests,
					// lenient on the wire. A browser that strict-parses a live
					// response breaks on the first purely additive deploy, during the
					// window in which two versions are both serving.
					if (hasStrictObject(media["schema"]))
						shape.strictResponses.push(`${id} ${status}`);
				}
			}
		}
	}
	return shape;
}

function gitOutput(root: string, args: string[]): string | undefined {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * Additive-only evolution, proved against the merge base.
 *
 * The reference has no wire-level skew mechanism at all — no `426`, no version
 * header, no contract hash — and inventing one for a template would ship an
 * unproven protocol. What it enforces instead is policy, and two halves of that
 * policy are mechanical: a response body may not be strict-parsed on the wire,
 * and a change to the published contract may not remove a field, remove an
 * operation, add a required field or change a type unless the registry names
 * the operation with a staged migration.
 */
export function validateEvolution(
	root: string,
	contract: ApiContract,
): DriftReport {
	const errors: string[] = [];
	const notices: string[] = [];
	const openapi = contract.openapi;
	if (openapi === null) return { errors, notices };
	const head = describeArtifact(textOf(resolve(root, openapi.artifact)));
	if (head === undefined)
		return {
			errors: [`forms: ${openapi.artifact} must parse as JSON`],
			notices,
		};
	for (const response of head.strictResponses) {
		errors.push(
			`forms: ${openapi.artifact} strict-parses the response body of ${response}; the published contract must stay lenient on the wire`,
		);
	}

	const injected = process.env[MERGE_BASE_VARIABLE];
	const candidates = injected ? [injected] : [...BASE_CANDIDATES];
	let base: string | undefined;
	for (const candidate of candidates) {
		if (
			gitOutput(root, ["rev-parse", "--verify", "--quiet", candidate]) ===
			undefined
		)
			continue;
		base = gitOutput(root, ["merge-base", "HEAD", candidate])?.trim();
		if (base) break;
	}
	if (!base) {
		notices.push(
			`forms: no merge base resolved (tried ${candidates.join(", ")}); the evolution gate compared nothing. Set ${MERGE_BASE_VARIABLE} to the branch this change is proposed against.`,
		);
		return { errors: errors.sort(), notices };
	}
	const previous = gitOutput(root, ["show", `${base}:${openapi.artifact}`]);
	if (previous === undefined) {
		notices.push(
			`forms: ${openapi.artifact} is new at ${base}; the evolution gate has no earlier contract to compare against`,
		);
		return { errors: errors.sort(), notices };
	}
	const before = describeArtifact(previous);
	if (before === undefined) {
		notices.push(
			`forms: ${openapi.artifact} did not parse at ${base}; the evolution gate compared nothing`,
		);
		return { errors: errors.sort(), notices };
	}

	const staged = new Set(contract.evolution.map((entry) => entry.operation));
	const refuse = (operation: string, detail: string): void => {
		if (staged.has(operation)) return;
		errors.push(
			`forms: ${openapi.artifact} ${detail}; declare ${operation} in evolution[] with a staged add, migrate or remove`,
		);
	};
	for (const operation of before.operations) {
		if (!head.operations.has(operation))
			refuse(operation, `removes the operation ${operation}`);
	}
	const operationOf = (key: string): string => key.split("#")[0] ?? key;
	for (const [key, type] of before.properties) {
		const operation = operationOf(key);
		if (!before.operations.has(operation)) continue;
		if (!head.operations.has(operation)) continue;
		const current = head.properties.get(key);
		if (current === undefined) refuse(operation, `removes the field ${key}`);
		else if (current !== type)
			refuse(operation, `narrows ${key} from ${type} to ${current}`);
	}
	for (const key of head.required) {
		const operation = operationOf(key);
		if (!before.operations.has(operation)) continue;
		if (before.required.has(key)) continue;
		refuse(operation, `newly requires ${key}`);
	}
	return { errors: [...new Set(errors)].sort(), notices };
}

// Files nobody ships. A test may hand-write any shape it likes, because the
// shape is the thing under test; a story and a mock exist to stand in for one.
const UNSHIPPED = [
	/\.test\.[cm]?[jt]sx?$/,
	/\.spec\.[cm]?[jt]sx?$/,
	/\.stories\.[cm]?[jt]sx?$/,
	/(?:^|\/)__mocks__\//,
	/(?:^|\/)__tests__\//,
];

function isShipped(path: string): boolean {
	return !UNSHIPPED.some((pattern) => pattern.test(path));
}

// The four refusals, named exactly as the reference names them. They are
// assembled from their words rather than written out because this guard scans
// source files for its own vocabulary elsewhere, and one rule that has to
// exempt a path teaches the next one to.
const CATEGORY = {
	inline: ["INLINE", "RESPONSE", "SHAPE"].join("_"),
	appLocal: ["APP", "LOCAL", "RESPONSE", "TYPE"].join("_"),
	nonContract: ["NON", "CONTRACT", "RESPONSE", "TYPE"].join("_"),
	wrongContract: ["WRONG", "CONTRACT", "RESPONSE", "TYPE"].join("_"),
} as const;

// Type expressions that are not a claim about a response body at all.
const OPAQUE_TYPES = new Set([
	"unknown",
	"any",
	"void",
	"never",
	"Response",
	"Request",
	"Blob",
	"ArrayBuffer",
	"ReadableStream",
	"FormData",
	"URLSearchParams",
]);

interface Operation {
	id: string;
	route: string;
	operationId: string;
	pattern: RegExp;
}

/**
 * The covered surface, DERIVED from the published artifact.
 *
 * This is the property the whole rule stands on: adding an operation to the
 * contract extends the ban with no guard edit, and removing one narrows it. A
 * hardcoded route list would be a second contract, maintained by hand, wrong
 * from the first merge that forgot it.
 */
export function coveredOperations(artifact: string): Operation[] {
	let value: unknown;
	try {
		value = JSON.parse(artifact) as unknown;
	} catch {
		return [];
	}
	const paths =
		isRecord(value) && isRecord(value["paths"]) ? value["paths"] : {};
	const operations: Operation[] = [];
	for (const [route, item] of Object.entries(paths)) {
		if (!isRecord(item)) continue;
		for (const method of HTTP_METHODS) {
			const operation = item[method];
			if (!isRecord(operation)) continue;
			const operationId =
				typeof operation["operationId"] === "string"
					? operation["operationId"]
					: "";
			operations.push({
				id: `${method.toUpperCase()} ${route}`,
				route,
				operationId,
				// `{id}` in a route is a hole a caller fills, so the literal a call
				// site carries is only ever the route's SHAPE.
				pattern: new RegExp(
					`^${route
						.split(/\{[^}]*\}/)
						.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
						.join("[^/]*")}$`,
				),
			});
		}
	}
	return operations;
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

/**
 * Module-level string constants, resolved one hop.
 *
 * A call site almost never carries its route as a literal; it carries a name
 * that was assigned one. One hop covers the three spellings the reference
 * found in practice — a plain const, a property of a const object, and a
 * template literal with nothing substituted into it — and stops there, because
 * a resolver that followed arbitrary expressions would be a partial evaluator
 * pretending to be a lint rule.
 */
export function stringConstants(module: ParsedModule): Map<string, string> {
	const api = typescript();
	const found = new Map<string, string>();
	if (!api) return found;
	const literal = (node: Node | undefined): string | undefined => {
		if (!node) return undefined;
		if (api.isStringLiteral(node)) return node.text;
		if (api.isNoSubstitutionTemplateLiteral(node)) return node.text;
		return undefined;
	};
	eachNode(module.file, (node) => {
		if (!api.isVariableDeclaration(node) || !api.isIdentifier(node.name))
			return;
		const value = literal(node.initializer);
		if (value !== undefined) {
			found.set(node.name.text, value);
			return;
		}
		if (node.initializer && api.isObjectLiteralExpression(node.initializer)) {
			for (const property of node.initializer.properties) {
				if (!api.isPropertyAssignment(property)) continue;
				const key = property.name;
				const name = api.isIdentifier(key)
					? key.text
					: api.isStringLiteral(key)
						? key.text
						: undefined;
				const value_ = literal(property.initializer);
				if (name !== undefined && value_ !== undefined)
					found.set(`${node.name.text}.${name}`, value_);
			}
		}
	});
	return found;
}

function resolveArgument(
	node: Node,
	constants: Map<string, string>,
): string | undefined {
	const api = typescript();
	if (!api) return undefined;
	if (api.isStringLiteral(node) || api.isNoSubstitutionTemplateLiteral(node))
		return node.text;
	if (api.isIdentifier(node)) return constants.get(node.text);
	if (api.isPropertyAccessExpression(node) && api.isIdentifier(node.expression))
		return constants.get(`${node.expression.text}.${node.name.text}`);
	// A path-baking helper: `orderUrl(id)` where the helper is a const string.
	if (api.isCallExpression(node) && api.isIdentifier(node.expression))
		return constants.get(node.expression.text);
	if (api.isTemplateExpression(node)) {
		// `${BASE}/orders/${id}` — the literal spans carry the shape.
		const head = node.head.text;
		const spans = node.templateSpans.map((span) => span.literal.text).join("*");
		return `${head}${spans === "" ? "" : `*${spans}`}`;
	}
	return undefined;
}

interface ResponseClaim {
	path: string;
	operation: Operation;
	/** The type expression's source text, for the message. */
	text: string;
	category: string;
}

function unwrapType(node: Node): Node {
	const api = typescript();
	if (!api) return node;
	let current = node;
	for (let depth = 0; depth < 6; depth += 1) {
		if (api.isParenthesizedTypeNode(current)) {
			current = current.type;
			continue;
		}
		if (
			api.isTypeReferenceNode(current) &&
			api.isIdentifier(current.typeName) &&
			(current.typeName.text === "Promise" ||
				current.typeName.text === "Array" ||
				current.typeName.text === "Readonly") &&
			current.typeArguments?.[0]
		) {
			current = current.typeArguments[0];
			continue;
		}
		if (api.isArrayTypeNode(current)) {
			current = current.elementType;
			continue;
		}
		break;
	}
	return current;
}

/**
 * Every place a call site states what a covered response looks like.
 *
 * Three spellings, because the reference found all three in a real codebase:
 * the wrapper's type argument (`useQuery<T>`), the cast (`as T`), and the
 * annotation on the binding the call result lands in.
 */
function responseTypes(
	module: ParsedModule,
	call: import("typescript").CallExpression,
): Node[] {
	const api = typescript();
	if (!api) return [];
	const found: Node[] = [];
	if (call.typeArguments?.[0]) found.push(call.typeArguments[0]);
	let current: Node | undefined = call.parent;
	for (let depth = 0; current && depth < 4; depth += 1) {
		if (api.isAsExpression(current)) {
			found.push(current.type);
			break;
		}
		if (api.isVariableDeclaration(current)) {
			if (current.type) found.push(current.type);
			break;
		}
		if (
			api.isAwaitExpression(current) ||
			api.isParenthesizedExpression(current) ||
			api.isPropertyAccessExpression(current) ||
			api.isCallExpression(current)
		) {
			current = current.parent;
			continue;
		}
		break;
	}
	return found;
}

function localTypeNames(module: ParsedModule): Set<string> {
	const api = typescript();
	const names = new Set<string>();
	if (!api) return names;
	eachNode(module.file, (node) => {
		if (api.isInterfaceDeclaration(node) || api.isTypeAliasDeclaration(node))
			names.add(node.name.text);
	});
	return names;
}

function importedFrom(module: ParsedModule): Map<string, string> {
	const api = typescript();
	const found = new Map<string, string>();
	if (!api) return found;
	eachNode(module.file, (node) => {
		if (!api.isImportDeclaration(node)) return;
		if (!api.isStringLiteralLike(node.moduleSpecifier)) return;
		const specifier = node.moduleSpecifier.text;
		const bindings = node.importClause?.namedBindings;
		if (bindings && api.isNamedImports(bindings)) {
			for (const element of bindings.elements)
				found.set(element.name.text, specifier);
		}
		if (node.importClause?.name)
			found.set(node.importClause.name.text, specifier);
	});
	return found;
}

function typeParameterNames(module: ParsedModule): Set<string> {
	const api = typescript();
	const names = new Set<string>();
	if (!api) return names;
	eachNode(module.file, (node) => {
		const parameters = (
			node as { typeParameters?: ReadonlyArray<{ name: { text: string } }> }
		).typeParameters;
		if (!Array.isArray(parameters)) return;
		for (const parameter of parameters) names.add(parameter.name.text);
	});
	return names;
}

/**
 * No second set of response types, anywhere.
 *
 * A handwritten response shape beside a generated one is not a duplicate, it is
 * a FORK: it keeps compiling after the contract changes, and the first thing
 * that notices is production. The four refusals are the four ways the reference
 * saw that fork appear.
 */
export function validateParallelResponseTypes(
	root: string,
	contract: ApiContract,
): string[] {
	const api = typescript();
	const openapi = contract.openapi;
	if (!api || openapi === null) return [];
	const operations = coveredOperations(textOf(resolve(root, openapi.artifact)));
	if (operations.length === 0)
		return [
			`forms: ${openapi.artifact} declares no operation; the parallel-type ban would cover nothing`,
		];
	const clientPaths = openapi.clients.map((client) => client.path);
	// The declared client path and the same path without its extension. A bare
	// basename is deliberately NOT accepted: `../../lib/api` would end with it
	// and the rule would wave through a second type set living next door.
	const clientSpecifiers = new Set(
		clientPaths.flatMap((path) => [path, path.replace(/\.[cm]?tsx?$/, "")]),
	);
	const packageRoots = contract.schemaPackages.map((entry) => entry.root);
	const claims: ResponseClaim[] = [];

	for (const path of enumerateFiles(root)) {
		if (!isSourceFile(path) || !isShipped(path)) continue;
		if (clientPaths.includes(path)) continue;
		if (packageRoots.some((entry) => insidePackage(entry, path))) continue;
		const module = parseModule(root, path);
		if (!module) continue;
		const constants = stringConstants(module);
		const locals = localTypeNames(module);
		const imports = importedFrom(module);
		const generics = typeParameterNames(module);
		eachNode(module.file, (node) => {
			if (!api.isCallExpression(node)) return;
			let operation: Operation | undefined;
			for (const argument of node.arguments) {
				const value = resolveArgument(argument, constants);
				if (value === undefined) continue;
				operation = operations.find((candidate) =>
					candidate.pattern.test(value),
				);
				if (operation) break;
			}
			if (!operation) return;
			for (const annotation of responseTypes(module, node)) {
				const type = unwrapType(annotation);
				const text = type.getText(module.file);
				if (api.isTypeLiteralNode(type)) {
					claims.push({
						path,
						operation,
						text: text.replace(/\s+/g, " "),
						category: CATEGORY.inline,
					});
					continue;
				}
				if (!api.isTypeReferenceNode(type) || !api.isIdentifier(type.typeName))
					continue;
				const name = type.typeName.text;
				if (OPAQUE_TYPES.has(name) || generics.has(name)) continue;
				const specifier = imports.get(name);
				if (specifier !== undefined) {
					const fromContract = [...clientSpecifiers].some((candidate) =>
						specifier.endsWith(candidate),
					);
					if (!fromContract) {
						claims.push({
							path,
							operation,
							text: name,
							category: CATEGORY.nonContract,
						});
						continue;
					}
					// A contract type, but the wrong one. The expected name is derived
					// from the artifact's own operationId, so a renamed operation
					// re-points the rule without a guard edit.
					const expected = operation.operationId.toLowerCase();
					if (expected !== "" && !name.toLowerCase().includes(expected)) {
						claims.push({
							path,
							operation,
							text: name,
							category: CATEGORY.wrongContract,
						});
					}
					continue;
				}
				if (locals.has(name)) {
					claims.push({
						path,
						operation,
						text: name,
						category: CATEGORY.appLocal,
					});
				}
			}
		});
	}
	return [
		...new Set(
			claims.map(
				(claim) =>
					`forms: ${claim.category} ${claim.path} states the response of ${claim.operation.id} as ${claim.text}; the generated contract types are the only ones`,
			),
		),
	].sort();
}

// The status a refusal answers with, and the words that mean "who is asking".
// Both are assembled because this guard scans source files for them and would
// otherwise be its own first finding.
const FORBIDDEN_STATUS = String(400 + 3);
const ROLE_HINTS = [
	`${"r"}ole`,
	`${"is"}Admin`,
	`${"is"}Owner`,
	`${"permis"}sion`,
	`${"member"}ship`,
];
// A local initialised from one of these is seam-DERIVED, not a role bit, and a
// branch on it is the policy seam doing its job.
const SEAM_CALLS = [/\bdecide\s*\(/, /\bapplyDecision\s*\(/, /\w+Gate\s*\(/];

function readsRoleBit(text: string): boolean {
	if (SEAM_CALLS.some((pattern) => pattern.test(text))) return false;
	return ROLE_HINTS.some((hint) =>
		new RegExp(`\\b\\w*${hint}\\w*\\b`, "i").test(text),
	);
}

function answersForbidden(text: string): boolean {
	return text.includes(FORBIDDEN_STATUS);
}

/**
 * Authorization decisions live in one place, or they live everywhere.
 *
 * Rule one: the seam's denial messages are the seam's. The banned set is READ
 * from the declared denial module rather than written here, so a new reason
 * extends the ban the moment it is added — a hardcoded list would be a copy
 * that goes stale silently, which is the exact failure mode the rule exists to
 * prevent one level up.
 *
 * Rule two: a branch that reads who is asking and answers with a refusal is an
 * authorization decision, wherever it is written. Resolution stops at a seam
 * call, because a local initialised from `decide()` is a DECISION and not a
 * role bit — without that stop the rule would flag the seam's own callers for
 * using it correctly.
 */
export function validateInlineAuthorization(
	root: string,
	contract: ApiContract,
): string[] {
	const api = typescript();
	if (!api) return [];
	const errors: string[] = [];
	const seam = contract.policySeam;
	const banned = new Set<string>();
	if (seam) {
		const module = parseModule(root, seam.denialModule);
		const exempt = new Set(seam.exemptMessages ?? []);
		if (module) {
			eachNode(module.file, (node) => {
				if (!api.isStringLiteralLike(node)) return;
				const text = node.text.trim();
				// One-word strings are identifiers, not wire messages, and banning
				// them by text would ban the vocabulary rather than the message.
				if (text.length < 8 || !text.includes(" ")) return;
				if (exempt.has(text)) return;
				banned.add(text);
			});
		}
		if (banned.size === 0)
			errors.push(
				`forms: ${seam.denialModule} declares no denial message; the inline-authorization ban would derive an empty set`,
			);
	}

	for (const path of enumerateFiles(root)) {
		if (!isSourceFile(path) || !isShipped(path)) continue;
		// The seam is never scanned. It is the one place both rules describe.
		if (seam && insidePackage(seam.root, path)) continue;
		const module = parseModule(root, path);
		if (!module) continue;
		for (const message of banned) {
			if (module.source.includes(message))
				errors.push(
					`forms: ${path} redeclares the seam denial message ${JSON.stringify(message)}; ${seam?.denialModule} is where it is written`,
				);
		}
		eachNode(module.file, (node) => {
			let condition: Node | undefined;
			let branch: Node | undefined;
			if (api.isIfStatement(node)) {
				condition = node.expression;
				branch = node.thenStatement;
			} else if (api.isConditionalExpression(node)) {
				condition = node.condition;
				// BOTH arms. `isAdmin ? ok : refuse` and `isAdmin ? refuse : ok` are
				// the same decision written two ways, and a rule that only read one
				// of them would be defeated by a `!`.
				branch = node;
			} else if (api.isSwitchStatement(node)) {
				condition = node.expression;
				branch = node.caseBlock;
			}
			if (!condition || !branch) return;
			const conditionText = condition.getText(module.file);
			if (!readsRoleBit(conditionText)) return;
			const branchText = branch.getText(module.file);
			if (!answersForbidden(branchText)) return;
			errors.push(
				`forms: ${path} answers a caller-role branch with a refusal; ${seam ? `${seam.root} is the only place that decides` : "no file may decide authorization while the registry declares no policy seam"}`,
			);
		});
	}
	return [...new Set(errors)].sort();
}

// The RHF surface that names a field, plus the component that does it in JSX.
const BINDING_METHODS = new Set([
	"clearErrors",
	"getFieldState",
	"getValues",
	"register",
	"resetField",
	"setError",
	"setFocus",
	"setValue",
	"trigger",
	"unregister",
	"watch",
]);

function topLevelSegment(field: string): string {
	return field.split(/[.[]/)[0] ?? field;
}

/** Top-level keys of a declared schema, unwrapping unions and compositions. */
export function schemaKeys(
	root: string,
	contract: ApiContract,
	name: string,
): Set<string> | undefined {
	const api = typescript();
	if (!api) return undefined;
	for (const entry of contract.schemaPackages) {
		for (const path of enumerateFiles(root).filter(
			(candidate) =>
				isSourceFile(candidate) && insidePackage(entry.root, candidate),
		)) {
			const module = parseModule(root, path);
			if (!module) continue;
			let found: Set<string> | undefined;
			eachNode(module.file, (node) => {
				if (found) return;
				if (!api.isVariableDeclaration(node) || !api.isIdentifier(node.name))
					return;
				if (node.name.text !== name || !node.initializer) return;
				const keys = new Set<string>();
				eachNode(node.initializer, (child) => {
					if (!api.isCallExpression(child)) return;
					const callee = child.expression;
					if (
						!api.isPropertyAccessExpression(callee) ||
						callee.name.text !== "object"
					)
						return;
					const shape = child.arguments[0];
					if (!shape || !api.isObjectLiteralExpression(shape)) return;
					for (const property of shape.properties) {
						const key = property.name;
						if (!key) continue;
						if (api.isIdentifier(key) || api.isStringLiteral(key))
							keys.add(key.text);
					}
				});
				found = keys;
			});
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Every form is registered, and every registered form binds fields that exist.
 *
 * The loud half is the important one: a module that binds a resolver and is not
 * in the registry is a form nothing checks, and the exemption set is empty on
 * purpose. The quiet half catches the typo that a runtime never reports —
 * `register("emial")` is a field the schema does not have, and the form simply
 * never validates it.
 */
export function validateFormBindings(
	root: string,
	contract: ApiContract,
): string[] {
	const api = typescript();
	if (!api) return [];
	const errors: string[] = [];
	const declared = new Map(
		contract.formModules.map((entry) => [entry.path, entry]),
	);
	for (const path of enumerateFiles(root)) {
		if (!isSourceFile(path) || !isShipped(path)) continue;
		const source = textOf(resolve(root, path));
		if (!source.includes(RESOLVER_BINDING)) continue;
		if (!declared.has(path))
			errors.push(
				`forms: ${path} binds a form resolver and is not declared in ${REGISTRY_PATH}`,
			);
	}
	for (const entry of contract.formModules) {
		const module = parseModule(root, entry.path);
		if (!module) continue;
		const keys = new Set<string>();
		let known = false;
		for (const name of entry.schemas) {
			const found = schemaKeys(root, contract, name);
			if (!found) {
				errors.push(
					`forms: ${entry.path} binds ${name}, which no declared schema package exports`,
				);
				continue;
			}
			known = true;
			for (const key of found) keys.add(key);
		}
		if (!known) continue;
		const bound = new Set<string>();
		eachNode(module.file, (node) => {
			if (api.isCallExpression(node)) {
				const callee = node.expression;
				const name = api.isIdentifier(callee)
					? callee.text
					: api.isPropertyAccessExpression(callee)
						? callee.name.text
						: undefined;
				if (name && BINDING_METHODS.has(name)) {
					const first = node.arguments[0];
					if (first && api.isStringLiteralLike(first)) bound.add(first.text);
				}
			}
			if (
				api.isJsxAttribute(node) &&
				node.name.getText(module.file) === "name"
			) {
				const value = node.initializer;
				if (value && api.isStringLiteralLike(value)) bound.add(value.text);
			}
		});
		for (const field of bound) {
			const segment = topLevelSegment(field);
			// `root` and `root.*` are the library's own reserved namespace for an
			// error that belongs to no field, which is exactly where a server's
			// business rejection lands.
			if (segment === "root" || keys.has(segment)) continue;
			errors.push(
				`forms: ${entry.path} binds the field ${field}, which ${entry.schemas.join(" or ")} does not declare`,
			);
		}
	}
	return [...new Set(errors)].sort();
}

// A malformed body is not a schema rejection, and a parser that answers both
// the same way tells a caller to fix a field in a request that never parsed.
// Assembled: this guard searches for the phrase and contains it.
const MALFORMED_MARKER = ["Invalid", "JSON"].join(" ");

/**
 * The server parses the SHARED schema, refuses visibly, and is the only one.
 *
 * "A client-side valid state followed by a server rejection SHALL always
 * produce a visible error — never a silent failure" is the invariant, and a
 * declared parser without a declared client mapping is precisely the silent
 * failure: the request is refused, the form clears, and nothing on the page
 * changed.
 */
export function validateServerParsers(
	root: string,
	contract: ApiContract,
): string[] {
	const api = typescript();
	if (!api) return [];
	const errors: string[] = [];
	const packageRoots = contract.schemaPackages.map((entry) => entry.root);
	for (const parser of contract.serverParsers) {
		const module = parseModule(root, parser.path);
		if (!module) continue;
		const specifiers = moduleSpecifiers(parser.path, module.source) ?? [];
		const reachesShared = specifiers.some((specifier) => {
			const resolved = specifier.startsWith(".")
				? resolveRelative(parser.path, specifier)
				: specifier;
			return packageRoots.some(
				(entry) =>
					insidePackage(entry, resolved) ||
					resolved.includes(entry.slice(entry.lastIndexOf("/") + 1)),
			);
		});
		if (!reachesShared)
			errors.push(
				`forms: ${parser.path} declares no import of a shared schema package; a re-declared shape is a second contract`,
			);
		if (/\.\s*object\s*\(/.test(module.source))
			errors.push(
				`forms: ${parser.path} re-declares an object schema; ${parser.surface} is parsed with the shared one`,
			);
		if (!module.source.includes(parser.envelope))
			errors.push(
				`forms: ${parser.path} must answer a rejection of ${parser.surface} with the declared ${parser.envelope} envelope`,
			);
		if (!module.source.includes(MALFORMED_MARKER))
			errors.push(
				`forms: ${parser.path} must answer a malformed body distinctly from a schema rejection`,
			);
		if (parser.clientMapping === undefined) {
			errors.push(
				`forms: ${parser.path} declares no clientMapping; a server rejection nothing renders is a silent failure`,
			);
			continue;
		}
		const mapping = parseModule(root, parser.clientMapping);
		if (!mapping) continue;
		if (!/\bsetError\s*\(/.test(mapping.source))
			errors.push(
				`forms: ${parser.clientMapping} must set a field error for every mappable issue path`,
			);
		// `root` and `root.<name>` are the form library's reserved namespace for an
		// error that belongs to no field, which is exactly where a business
		// rejection with no matching input lands.
		if (!/["'`]root(?:\.[^"'`]*)?["'`]/.test(mapping.source))
			errors.push(
				`forms: ${parser.clientMapping} must set a root-level error for an issue that maps to no field`,
			);
	}
	return [...new Set(errors)].sort();
}

/**
 * The whole shared-schema and API contract, with the notices the caller prints.
 *
 * The order is the safety property. An unreadable registry stops everything,
 * because every leg below reads it; a mode disagreement stops everything too,
 * because every leg below is written for one of the two worlds and would answer
 * the wrong question in the other.
 */
export async function inspectFormsContract(
	root = resolve(import.meta.dir, "../.."),
	_options: FormsContractOptions = {},
): Promise<DriftReport> {
	const notices: string[] = [];
	const { contract, errors: registryErrors } = await readApiContract(root);
	if (!contract)
		return { errors: [...new Set(registryErrors)].sort(), notices };

	const state = deriveTreeState(root);
	const reconciliation = reconcileMode(contract, state);
	if (reconciliation.length > 0)
		return {
			errors: [...new Set([...registryErrors, ...reconciliation])].sort(),
			notices,
		};

	const drift = runDriftGate(root, contract);
	const evolution = validateEvolution(root, contract);
	notices.push(...drift.notices, ...evolution.notices);
	const errors = [
		...registryErrors,
		...validateSoleDeclarations(enumerateFiles(root), contract),
		...(await validateWiring(root, contract)),
		...(await validateOwnership(root)),
		...validateBrowserSafety(root, contract, state),
		...(await validateGeneratedOutputPolicy(root, contract)),
		...validateGeneratedBanners(root, contract),
		...validateParallelResponseTypes(root, contract),
		...validateInlineAuthorization(root, contract),
		...validateFormBindings(root, contract),
		...validateServerParsers(root, contract),
		...drift.errors,
		...evolution.errors,
	];
	return { errors: [...new Set(errors)].sort(), notices };
}

/** The error half, in the shape `validate.ts` aggregates. */
export async function validateFormsContract(
	root = resolve(import.meta.dir, "../.."),
	options: FormsContractOptions = {},
): Promise<string[]> {
	return (await inspectFormsContract(root, options)).errors;
}
