// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
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
	if (contract.mode === "skeleton") {
		for (const signal of state.signals)
			errors.push(
				`forms: ${REGISTRY_PATH} declares skeleton mode but ${signal.detail}`,
			);
		return errors.sort();
	}
	const declared =
		contract.schemaPackages.length +
		contract.formModules.length +
		contract.serverParsers.length +
		(contract.openapi === null ? 0 : 1);
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

/**
 * The whole shared-schema and API contract, in the shape `validate.ts`
 * aggregates.
 *
 * The order is the safety property. An unreadable registry stops everything,
 * because every leg below reads it; a mode disagreement stops everything too,
 * because every leg below is written for one of the two worlds and would answer
 * the wrong question in the other.
 */
export async function validateFormsContract(
	root = resolve(import.meta.dir, "../.."),
	_options: FormsContractOptions = {},
): Promise<string[]> {
	const { contract, errors: registryErrors } = await readApiContract(root);
	if (!contract) return [...new Set(registryErrors)].sort();

	const state = deriveTreeState(root);
	const reconciliation = reconcileMode(contract, state);
	if (reconciliation.length > 0)
		return [...new Set([...registryErrors, ...reconciliation])].sort();

	const errors = [
		...registryErrors,
		...validateSoleDeclarations(enumerateFiles(root), contract),
		...(await validateWiring(root, contract)),
		...(await validateOwnership(root)),
	];
	return [...new Set(errors)].sort();
}
