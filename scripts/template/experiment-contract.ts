// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON and YAML are strict records.
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "experiments.json";
export const REGISTRY_SCHEMA_PATH = "experiments.schema.json";
export const GUARD_CONTRACT = "scripts/template/experiment-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-experiment.ts";
export const GUARD_SCRIPT = "experiments:check";

// Every file this stage adds, and the only list of them.
//
// There is no `CAPABILITY` constant beside it, and its absence is the decision
// this whole module turns on. `apps/**` and `libs/**` are project-owned and
// present in every render of every profile, so a hygiene rule over them that
// could be switched off would be absent from exactly the trees that have the
// directories it governs. This surface is CORE: no fence, no signature, no
// residue token, one unfenced workflow step, and these four files in every
// render. The ownership leg below asserts all four of those negatives, because
// a core guard that quietly acquires a capability entry vanishes from a default
// project while the workflow step that calls it stays behind.
export const CORE_PATHS = [
	REGISTRY_PATH,
	REGISTRY_SCHEMA_PATH,
	GUARD_CONTRACT,
	GUARD_ENTRYPOINT,
] as const;

const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CONTRACT_JOB = "ci";
const MANIFEST_PATH = "package.json";
const MOON_WORKSPACE_PATH = ".moon/workspace.yml";

// Directories no tree walk descends into. `tmp/` is where `template:fixtures`
// renders, and a rendered fixture carries a full copy of this tree — a walk into
// one would invent an `apps/` layout that does not exist and flip the derived
// mode to `active`. `graphify-out/` is tracked here, so it has to be pruned out
// of the tracked list as well as out of the walk.
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"tmp",
	"graphify-out",
	"dist",
]);

// The seven exception surfaces. An experiment cannot weaken a guard by
// existing; it weakens one by adding an exception, and every exception surface
// in this repository is a short, committed, enumerable list. The count is the
// anti-vacuity anchor: `apps/` and `libs/` hold a `.gitkeep` in this repository
// and in every rendered project, so a guard that counted EXPERIMENTS would
// report zero, pass, and be indistinguishable from an absent rule. This guard
// counts SURFACES INSPECTED, which is seven on an empty tree and zero only when
// something is badly wrong.
export const SURFACES = [
	"manifest",
	"moon",
	"typecheck",
	"formatter",
	"ignore",
	"ci",
	"universe",
] as const;

export type Surface = (typeof SURFACES)[number];

export const SURFACE_COUNT = SURFACES.length;

export interface ReservedDirectory {
	directory: string;
	/**
	 * The ownership pattern that reserves this directory, rather than the name of
	 * the capability that owns it.
	 *
	 * That is a measured constraint and not a preference. Capability names travel
	 * as residue tokens, one of the three reserved directories belongs to a
	 * capability whose own name IS its token, and this registry ships to every
	 * rendered project including the ones that disable it. The pattern is a path
	 * signature, which the anti-residue scan matches by a file's location and
	 * never by its contents, so it is safe to write down here and it points at
	 * the one place the capability is named.
	 */
	ownershipPattern: string;
}

export interface ToleratedWorkflowFailure {
	workflow: string;
	job: string;
	reason: string;
}

export interface ExperimentPolicy {
	workspaceGlobs: string[];
	projectGlobs: string[];
	typecheckProject: string;
	typecheckIncludes: string[];
	typecheckExcludes: string[];
	formatterConfig: string;
	formatterNegations: string[];
	formatterOverrides: string[];
	ignoreFile: string;
	toleratedIgnorePatterns: string[];
	universeRegistryPath: string;
	workflowRoot: string;
	toleratedWorkflowFailures: ToleratedWorkflowFailure[];
	reservedDirectories: ReservedDirectory[];
	findingsRoots: string[];
	retirementAllowList: string[];
}

export interface ExperimentPromotion {
	ownershipRule: string;
	universeId: string;
	testGlob: string;
	documentation: string;
}

export interface Waiver {
	reason: string;
}

export interface Experiment {
	id: string;
	directory: string;
	status: "disposable" | "promoted";
	opened: string;
	findings: string | null;
	findingsWaiver: Waiver | null;
	promotion: ExperimentPromotion | null;
}

export interface RetiredExperiment {
	id: string;
	directory: string;
	retiredAt: string;
	findings: string | null;
	findingsWaiver: Waiver | null;
	aliases: string[];
}

export interface ExperimentRegistry {
	schemaVersion: 1;
	mode: "skeleton" | "active";
	policy: ExperimentPolicy;
	experiments: Experiment[];
	retired: RetiredExperiment[];
}

export interface TreeState {
	/** `active` the moment a non-reserved directory lives under a workspace glob. */
	mode: "skeleton" | "active";
	/** Every directory found under the workspace globs, reserved ones included. */
	directories: string[];
	/** The subset that is not a capability's reserved name. */
	experimentDirectories: string[];
	/** How many files the enumeration actually read. Zero is a failure. */
	files: number;
	/** True when the enumeration went through the Git index rather than a walk. */
	tracked: boolean;
	errors: string[];
	notices: string[];
}

export interface SurfaceInspection {
	surface: Surface;
	path: string;
	present: boolean;
	errors: string[];
	notices: string[];
}

export interface SurfaceReport {
	inspections: SurfaceInspection[];
	/** The anti-vacuity anchor: surfaces inspected, never experiments found. */
	scanned: number;
	errors: string[];
	notices: string[];
}

export interface ExperimentReport {
	errors: string[];
	notices: string[];
}

export interface ExperimentContractOptions {
	root?: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	const found: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") found.push(entry);
		// moon also accepts the object form `{ id: 'ui', scope: 'production' }`.
		else if (isRecord(entry) && typeof entry["id"] === "string")
			found.push(entry["id"]);
	}
	return found;
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
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

function parseYaml(source: string): JsonRecord | undefined {
	try {
		const value = Bun.YAML.parse(source) as unknown;
		if (value === null || value === undefined) return {};
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function posixPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function excluded(path: string): boolean {
	return path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

/**
 * Whether this tree is the template itself rather than a project rendered from
 * it. The parameter file is the marker every other consumer already uses, and
 * the distinction matters for exactly one rule: the renderer strips capability
 * fence markers along with the blocks it keeps, so "this step is unfenced" is
 * only ever a question about the source tree.
 */
function isTemplateTree(root: string): boolean {
	return exists(resolve(root, "template-parameters.toml"));
}

// Tracked files only where there is an index, read through Git so the scan sees
// exactly what a clone receives. `undefined` means this tree is not a repository
// — a rendered fixture before `git init` — and the caller says so out loud
// rather than reporting a clean result it never established.
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
 * The index is the authority where there is one, because "what is committed" is
 * the question every rule here actually asks — a retired experiment's residue is
 * a fact about the tree a clone receives, not about a developer's scratch files.
 * A rendered project is not a Git repository until its first commit, so the
 * fallback is a pruned directory walk, and both paths share one exclusion list.
 */
export function enumerateFiles(root: string): {
	files: string[];
	tracked: boolean;
} {
	const tracked = trackedFiles(root);
	if (tracked)
		return {
			files: tracked.filter((path) => !excluded(path)).sort(),
			tracked: true,
		};
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
	return { files: found.sort(), tracked: false };
}

/**
 * The committed declaration, read and shape-checked against its own schema.
 *
 * Returns `undefined` when the registry is absent or unreadable; the caller
 * turns that into a named error rather than into a skipped leg.
 */
export async function readExperimentRegistry(root: string): Promise<{
	registry?: ExperimentRegistry;
	errors: string[];
}> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`experiment: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`experiment: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`experiment: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`experiment: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `experiment: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { registry: value as ExperimentRegistry, errors };
}

/**
 * The registry is the only one, and every declared thing is declared once.
 *
 * A second registry anywhere in the tree — even a well-meaning
 * `experiments.backup.json` — leaves two answers to the question this file
 * exists to answer once. The same applies one level down: an id declared twice,
 * a directory claimed twice, or an id that appears in both the live list and the
 * retired one, all mean the lifecycle has two states at once.
 */
export function validateSoleDeclarations(
	files: string[],
	registry: ExperimentRegistry | undefined,
): string[] {
	const errors: string[] = [];
	const wildcard = new Bun.Glob("experiment*.json");
	for (const path of files) {
		if (path === REGISTRY_PATH || path === REGISTRY_SCHEMA_PATH) continue;
		const rootLevel = !path.includes("/");
		if (
			basenameOf(path) === REGISTRY_PATH ||
			(rootLevel && wildcard.match(path))
		)
			errors.push(
				`experiment: ${path} is a second experiment lifecycle registry; ${REGISTRY_PATH} is the only one`,
			);
	}
	if (!registry) return errors.sort();
	const seenId = new Map<string, string>();
	for (const entry of registry.experiments) {
		if (seenId.has(entry.id))
			errors.push(`experiment: ${entry.id} is declared twice`);
		else seenId.set(entry.id, "live");
	}
	for (const entry of registry.retired) {
		const where = seenId.get(entry.id);
		if (where === "live")
			errors.push(
				`experiment: ${entry.id} is declared as live and as retired at the same time`,
			);
		else if (where === "retired")
			errors.push(`experiment: ${entry.id} is retired twice`);
		else seenId.set(entry.id, "retired");
	}
	const seenDirectory = new Map<string, string>();
	for (const entry of registry.experiments) {
		const declared = seenDirectory.get(entry.directory);
		if (declared !== undefined)
			errors.push(
				`experiment: the directory ${entry.directory} is claimed by both ${declared} and ${entry.id}`,
			);
		else seenDirectory.set(entry.directory, entry.id);
	}
	return errors.sort();
}

function reservedDirectorySet(registry: ExperimentRegistry): Set<string> {
	return new Set(
		registry.policy.reservedDirectories.map((entry) => entry.directory),
	);
}

/**
 * What the tree carries, derived and never declared.
 *
 * A directory becomes an experiment by living under the workspace globs: there
 * it automatically inherits Moon's lint, typecheck, test and build tasks, joins
 * `package.json#workspaces`, and enters the typechecker's include list. That is
 * the strictness this stage preserves, and it is also why the predicate is a
 * directory predicate rather than a content one — the `.gitkeep` files that keep
 * `apps/` and `libs/` in the tree are not experiments and have to be named as
 * the exception they are.
 */
export function deriveTreeState(
	root: string,
	registry?: ExperimentRegistry,
): TreeState {
	const { files, tracked } = enumerateFiles(root);
	const errors: string[] = [];
	const notices: string[] = [];
	if (files.length === 0)
		errors.push(
			`experiment: the file enumeration found nothing under ${root}; a rule with no input has answered nothing`,
		);
	if (!tracked)
		notices.push(
			`experiment: ${root} is not a Git repository, so the enumeration fell back to a directory walk and no rule here is answering about the committed tree`,
		);
	const globs = registry?.policy.workspaceGlobs ?? ["apps/*", "libs/*"];
	const roots = new Set(
		globs
			.map((glob) => glob.split("/")[0] ?? "")
			.filter((segment) => segment !== "" && !segment.includes("*")),
	);
	const reserved = registry
		? reservedDirectorySet(registry)
		: new Set<string>();
	const directories = new Set<string>();
	for (const path of files) {
		const segments = path.split("/");
		if (segments.length < 3) continue;
		const [top, name] = segments;
		if (!top || !name || !roots.has(top)) continue;
		// A directory holding only a `.gitkeep` is the empty skeleton this
		// template ships, not an experiment. It is named rather than inferred,
		// because "the directory has files in it" would make the two committed
		// placeholders flip the derived mode of every rendered project.
		if (basenameOf(path) === ".gitkeep") continue;
		directories.add(`${top}/${name}`);
	}
	const all = [...directories].sort();
	const experimentDirectories = all.filter(
		(directory) => !reserved.has(directory),
	);
	return {
		mode: experimentDirectories.length > 0 ? "active" : "skeleton",
		directories: all,
		experimentDirectories,
		files: files.length,
		tracked,
		errors,
		notices,
	};
}

/**
 * The declared mode against the derived one, in both directions, first.
 *
 * This is what keeps every leg below it from being a no-op, and it is also the
 * derived scope floor. A hand-typed count of expected directories goes stale the
 * first time somebody deletes one; a count derived from the tree on every run
 * cannot. The two directions are two different defects, and only implementing
 * the first is the mistake that matters: a directory nobody declared is an
 * undeclared experiment, and a declaration whose directory is gone is a removal
 * that never finished — and it is the second one a deletion produces.
 */
export function reconcileMode(
	registry: ExperimentRegistry,
	state: TreeState,
): string[] {
	const errors: string[] = [...state.errors];
	const declared = new Set(
		registry.experiments.map((entry) => entry.directory),
	);
	for (const directory of state.experimentDirectories) {
		if (!declared.has(directory))
			errors.push(
				`experiment: ${directory} is a workspace directory that ${REGISTRY_PATH} does not declare; an undeclared experiment is one nothing governs`,
			);
	}
	const present = new Set(state.directories);
	for (const entry of registry.experiments) {
		if (!present.has(entry.directory))
			errors.push(
				`experiment: ${entry.id} declares ${entry.directory}, which holds no tracked file; move the record to the retired list rather than deleting it`,
			);
	}
	if (registry.mode === "skeleton") {
		if (registry.experiments.length > 0)
			errors.push(
				`experiment: ${REGISTRY_PATH} declares skeleton mode but declares ${registry.experiments.length} experiments`,
			);
	} else if (registry.experiments.length === 0)
		errors.push(
			`experiment: ${REGISTRY_PATH} declares active mode but declares no experiment`,
		);
	if (registry.mode !== state.mode)
		errors.push(
			`experiment: ${REGISTRY_PATH} declares ${registry.mode} mode but the tree state derived from the workspace globs is ${state.mode}`,
		);
	return errors.sort();
}

/**
 * The capability fence a line sits inside, or `"absent"` when the line is not in
 * the file at all.
 *
 * This guard's step must be inside NO fence, which is the inverse of every gated
 * guard's assertion and the mechanical form of the decision that this surface is
 * core. A fenced step would be deleted from exactly the renders that still
 * received the four files and the package script.
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
	const workflow = parseYaml(source);
	if (!workflow) return undefined;
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
 * Everything this guard needs in order to be run at all.
 *
 * A contract module that ships downstream and is never executed there is
 * documentation with an import statement. The package script and the workflow
 * step are part of the contract, and so — for this stage alone — is the absence
 * of a fence around either.
 */
export async function validateWiring(
	root: string,
	registry: ExperimentRegistry | undefined,
): Promise<string[]> {
	const errors: string[] = [];
	for (const path of CORE_PATHS) {
		if (!exists(resolve(root, path)))
			errors.push(`experiment: ${path} is missing`);
	}
	const manifestPath = resolve(root, MANIFEST_PATH);
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`experiment: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const fence = fencedCapabilityOf(source, invocation);
		if (fence === "absent")
			errors.push(
				`experiment: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else {
			// The fence is a fact about the TEMPLATE, not about a render: the
			// renderer deletes the markers along with the blocks it keeps, so a
			// generated project's step is correctly unfenced either way.
			if (isTemplateTree(root) && fence !== undefined)
				errors.push(
					`experiment: the \`${invocation}\` step must not sit inside the ${fence} capability fence; this surface is core and ships in every render`,
				);
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`experiment: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`experiment: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	if (registry && !exists(resolve(root, registry.policy.typecheckProject)))
		errors.push(
			`experiment: ${REGISTRY_PATH} declares ${registry.policy.typecheckProject}, which is missing`,
		);
	return errors.sort();
}

/**
 * Template ownership, and the four negatives that keep this surface core.
 *
 * The `copy` entries must precede the `scripts/template/**` omit catch-all, or
 * the render drops the guard while `package.json` still declares the script. And
 * the negatives below are the mechanical form of the stage's central decision:
 * an `artifactRules` entry would gate the files, a `packageRules` entry would
 * strip the script from a render that still had them, and a
 * `capabilitySignatures` entry would make the guard's own path or its script
 * name a residue token — in a repository where 35 tracked files already carry
 * the word this domain is named for, most of them shipping by default.
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
	for (const pattern of CORE_PATHS) {
		const index = rules.findIndex((entry) => entry["pattern"] === pattern);
		const blocking = pattern.startsWith("scripts/template/")
			? templateCatchAll
			: rootCatchAll;
		if (
			index < 0 ||
			(blocking >= 0 && index > blocking) ||
			rules[index]?.["renderPolicy"] !== "copy"
		)
			errors.push(`experiment: template ownership must copy ${pattern}`);
	}
	for (const rule of records(ownership["artifactRules"])) {
		const pattern = rule["pattern"];
		if (
			typeof pattern === "string" &&
			(CORE_PATHS as readonly string[]).includes(pattern)
		)
			errors.push(
				`experiment: ${pattern} must not be a gated artifact; this surface ships in every render`,
			);
	}
	for (const rule of records(ownership["packageRules"])) {
		if (!strings(rule["scripts"]).includes(GUARD_SCRIPT)) continue;
		errors.push(
			`experiment: no package rule may strip the ${GUARD_SCRIPT} script; the render would keep the workflow step that calls it`,
		);
	}
	const signatures = isRecord(ownership["capabilitySignatures"])
		? ownership["capabilitySignatures"]
		: {};
	const reserved = new Set<string>();
	for (const [capability, value] of Object.entries(signatures)) {
		if (!isRecord(value)) continue;
		for (const path of strings(value["paths"])) {
			reserved.add(path);
			if ((CORE_PATHS as readonly string[]).includes(path))
				errors.push(
					`experiment: ${path} must not be a ${capability} capability signature path`,
				);
		}
		for (const token of strings(value["tokens"])) {
			if (token === GUARD_SCRIPT)
				errors.push(
					`experiment: ${GUARD_SCRIPT} must not be a ${capability} capability signature token`,
				);
			// The other direction, and the one that actually bites. These four
			// files ship to EVERY render, and the anti-residue scan over a render
			// whose capability is off is a plain substring search over every file
			// in it. So a core file that merely MENTIONS another capability's
			// token — in a comment, in a schema description, in a policy value —
			// fails the render rather than this guard, which is a page of
			// generated-output noise pointing at the wrong file. Refusing it here
			// names the file, the token and the capability in one sentence.
			for (const path of CORE_PATHS) {
				const source = textOf(resolve(root, path));
				if (source !== "" && source.includes(token))
					errors.push(
						`experiment: ${path} must not contain the ${capability} signature token ${token}; this file ships to every render, including the ones that disable it`,
					);
			}
		}
	}
	for (const rule of records(ownership["artifactRules"])) {
		const pattern = rule["pattern"];
		if (typeof pattern === "string") reserved.add(pattern);
	}
	const registry = await readExperimentRegistry(root);
	for (const entry of registry.registry?.policy.reservedDirectories ?? []) {
		if (!reserved.has(entry.ownershipPattern))
			errors.push(
				`experiment: ${entry.directory} claims the ownership pattern ${entry.ownershipPattern}, which no artifact rule or capability signature declares`,
			);
	}
	return errors.sort();
}

function surfaceOf(
	surface: Surface,
	path: string,
	present: boolean,
): SurfaceInspection {
	return { surface, path, present, errors: [], notices: [] };
}

/**
 * The seven exception surfaces, inspected and counted.
 *
 * `scanned` is the count of surfaces this function actually opened, and it is
 * the number the caller refuses zero of. It is deliberately NOT the count of
 * experiments: with `experiments: []` — which is what this template ships and
 * what a freshly rendered project has — an experiment count would be zero, the
 * guard would be green, and the rule would be indistinguishable from an absent
 * one.
 */
export async function inspectSurfaces(
	root: string,
	registry: ExperimentRegistry,
): Promise<SurfaceReport> {
	const policy = registry.policy;
	const inspections: SurfaceInspection[] = [];

	const manifest = surfaceOf(
		"manifest",
		MANIFEST_PATH,
		exists(resolve(root, MANIFEST_PATH)),
	);
	if (!manifest.present)
		manifest.errors.push(`experiment: ${MANIFEST_PATH} is missing`);
	inspections.push(manifest);

	const moon = surfaceOf(
		"moon",
		MOON_WORKSPACE_PATH,
		exists(resolve(root, MOON_WORKSPACE_PATH)),
	);
	if (!moon.present)
		moon.errors.push(`experiment: ${MOON_WORKSPACE_PATH} is missing`);
	inspections.push(moon);

	const typecheck = surfaceOf(
		"typecheck",
		policy.typecheckProject,
		exists(resolve(root, policy.typecheckProject)),
	);
	if (!typecheck.present)
		typecheck.errors.push(`experiment: ${policy.typecheckProject} is missing`);
	inspections.push(typecheck);

	const formatter = surfaceOf(
		"formatter",
		policy.formatterConfig,
		exists(resolve(root, policy.formatterConfig)),
	);
	if (!formatter.present)
		formatter.errors.push(`experiment: ${policy.formatterConfig} is missing`);
	inspections.push(formatter);

	const ignore = surfaceOf(
		"ignore",
		policy.ignoreFile,
		exists(resolve(root, policy.ignoreFile)),
	);
	if (!ignore.present)
		ignore.errors.push(`experiment: ${policy.ignoreFile} is missing`);
	inspections.push(ignore);

	const ci = surfaceOf(
		"ci",
		policy.workflowRoot,
		isDirectory(resolve(root, policy.workflowRoot)),
	);
	if (!ci.present)
		ci.errors.push(`experiment: ${policy.workflowRoot} is missing`);
	inspections.push(ci);

	// The universe registry is the one surface that is legitimately absent: it is
	// gated on a capability that defaults to false, so most rendered projects do
	// not have it. Absence is a NAMED notice rather than a refusal, and the
	// surface is still inspected — the question was asked and answered.
	const universe = surfaceOf(
		"universe",
		policy.universeRegistryPath,
		exists(resolve(root, policy.universeRegistryPath)),
	);
	if (!universe.present)
		universe.notices.push(
			`experiment: ${policy.universeRegistryPath} is absent, so no declared experiment was reconciled against a CI universe`,
		);
	inspections.push(universe);

	const errors = inspections.flatMap((entry) => entry.errors).sort();
	const notices = inspections.flatMap((entry) => entry.notices).sort();
	const scanned = inspections.length;
	if (scanned === 0)
		errors.push(
			"experiment: no exception surface was inspected; a lock over nothing is a pass nobody earned",
		);
	return { inspections, scanned, errors, notices };
}

/**
 * Every leg, in the order the requirement enumerates them, with the notices kept
 * separate from the refusals.
 *
 * "Checked nothing", "found nothing wrong" and "another guard owns this" produce
 * the same exit status and are not the same claim, so the third channel is not a
 * convenience.
 */
export async function inspectExperimentContract(
	root = resolve(import.meta.dir, "../.."),
	_options: ExperimentContractOptions = {},
): Promise<ExperimentReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const { registry, errors: registryErrors } =
		await readExperimentRegistry(root);
	errors.push(...registryErrors);
	const { files } = enumerateFiles(root);
	errors.push(...validateSoleDeclarations(files, registry));
	if (!registry) return { errors: [...new Set(errors)].sort(), notices };

	const state = deriveTreeState(root, registry);
	notices.push(...state.notices);
	// Mode reconciliation runs FIRST and its failure is the first error: every
	// leg below reads the registry as if it described the tree, and running them
	// over a registry that demonstrably does not would print a page of
	// consequences for one cause.
	const modeErrors = reconcileMode(registry, state);
	errors.push(...modeErrors);
	if (modeErrors.length > 0)
		return {
			errors: [...new Set(errors)].sort(),
			notices: [...new Set(notices)].sort(),
		};

	errors.push(...(await validateWiring(root, registry)));
	errors.push(...(await validateOwnership(root)));

	const surfaces = await inspectSurfaces(root, registry);
	errors.push(...surfaces.errors);
	notices.push(...surfaces.notices);

	return {
		errors: [...new Set(errors)].sort(),
		notices: [...new Set(notices)].sort(),
	};
}

export async function validateExperimentContract(
	root = resolve(import.meta.dir, "../.."),
	options: ExperimentContractOptions = {},
): Promise<string[]> {
	return (await inspectExperimentContract(root, options)).errors;
}
