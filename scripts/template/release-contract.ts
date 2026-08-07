// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON and YAML are strict records.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./json-schema";
import { type RenderManifest, renderFixture } from "./render-fixture";

type JsonRecord = Record<string, unknown>;

export const REGISTRY_PATH = "release.json";
export const REGISTRY_SCHEMA_PATH = "release.schema.json";
export const GUARD_CONTRACT = "scripts/template/release-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-release.ts";
export const GOLDEN_SYNC_ENTRYPOINT =
	"scripts/template/sync-release-goldens.ts";

// The two package scripts, and their prefix is the decision this module turns
// on rather than a naming preference.
//
// `renderPackage` deletes every `template:`-prefixed script from a rendered
// manifest, and that is the ONLY mechanism in this repository that removes a
// script from a render without a capability behind it. This surface has no
// capability — it must not have one, because its three inputs are omitted from
// every render — so the prefix is what makes the omission real. It is the same
// decision the workflow step makes with a `template-only` block, spelled for a
// manifest instead of for YAML.
export const GUARD_SCRIPT = "template:release-check";
export const SYNC_SCRIPT = "template:release-sync";

// The workflow block name. One block per subject, and the renderer refuses a
// nested one, so this may never be spelled the same as the baseline block.
export const TEMPLATE_ONLY_BLOCK = "stage-eleven-release";

export const GOLDEN_ROOT = "fixtures/golden";

/**
 * Every file this stage adds, and the only list of them.
 *
 * There is no `CORE_PATHS` constant beside it and no capability either, which
 * is a third category the program has not used before. The gate reads fixture
 * definitions, golden manifests and a release declaration; all three are
 * omitted from every render, so a rendered project would receive a command
 * whose inputs are absent. The ownership leg below asserts that each of these
 * five paths is omitted from every render and that none of them has acquired a
 * capability entry of any kind — the inverse of a gated guard's assertion, and
 * the mechanical form of this stage's central decision.
 */
export const TEMPLATE_ONLY_PATHS = [
	REGISTRY_PATH,
	REGISTRY_SCHEMA_PATH,
	GUARD_CONTRACT,
	GUARD_ENTRYPOINT,
	GOLDEN_SYNC_ENTRYPOINT,
] as const;

const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const CONTRACT_JOB = "ci";
const MANIFEST_PATH = "package.json";
const VALIDATOR_PATH = "scripts/template/validate.ts";
const CHANGELOG_PATH = "CHANGES.md";
const FIXTURE_ROOT = "fixtures/template";

// Directories no walk descends into. `tmp/` is where `template:fixtures`
// renders and a rendered fixture carries a copy of this tree; `graphify-out/`
// is tracked here, so it has to leave the tracked list as well as the walk.
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"tmp",
	"graphify-out",
	"dist",
]);

export interface GoldenDeclaration {
	fixture: string;
	manifest: string;
	fileCount: number;
	omittedCount: number;
	enabledCount: number;
	disabledCount: number;
}

export interface ReleaseRegistry {
	schemaVersion: 1;
	decision: "candidate" | "released";
	auditedSource: { commit: string; tree: string; capturedAt: string };
	release: {
		plannedTag: string;
		changelogHeading: string;
		changeName: string;
		templateRefMechanism: string;
	};
	goldens: {
		directory: string;
		regenerateWith: string;
		totalFileCount: number;
		fixtures: GoldenDeclaration[];
	};
}

export interface GoldenFile {
	schemaVersion: 1;
	regenerateWith: string;
	volatileFieldsExcluded: string[];
	manifest: RenderManifest;
}

/**
 * A golden mismatch, CLASSIFIED rather than reported flat.
 *
 * Four causes need four different responses, and reporting all of them as
 * "the golden drifted" over a manifest of two hundred entries makes the most
 * alarming case the easiest to dismiss. A file appearing is a new template
 * artefact; a file vanishing is an ownership rule that started omitting; a
 * digest moving is a substitution that changed — or one that stopped
 * happening, which is the failure a structure-only expectation cannot see; a
 * mode moving is an executable bit.
 */
export type GoldenDriftKind = "added" | "removed" | "content" | "mode";

export interface GoldenDrift {
	fixture: string;
	kind: GoldenDriftKind;
	path: string;
	expected?: string;
	actual?: string;
}

export interface ReleaseReport {
	errors: string[];
	notices: string[];
}

export interface ReleaseContractOptions {
	root?: string;
	/** Skip the three renders. Used only by callers that already rendered. */
	renders?: boolean;
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
 * Tracked files, or `undefined` when this tree is not a repository.
 *
 * An abstention is not a pass. Every leg here that reaches for Git says so out
 * loud when it cannot answer rather than reporting a clean result it never
 * established.
 */
export function trackedFiles(root: string): string[] | undefined {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout
		.toString()
		.split("\0")
		.filter(Boolean)
		.filter((path) => !excluded(path))
		.sort();
}

/** The pruned directory walk the enumeration falls back to outside a repository. */
export function walkFiles(root: string): string[] {
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

function git(root: string, argv: string[]): string | undefined {
	const result = Bun.spawnSync(["git", "-C", root, ...argv], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().trim();
}

/**
 * The committed declaration, read and shape-checked against its own schema.
 *
 * `undefined` means the registry is absent or unreadable, and the caller turns
 * that into a named error rather than into a skipped leg.
 */
export async function readReleaseRegistry(root: string): Promise<{
	registry?: ReleaseRegistry;
	errors: string[];
}> {
	const errors: string[] = [];
	const registryPath = resolve(root, REGISTRY_PATH);
	const schemaPath = resolve(root, REGISTRY_SCHEMA_PATH);
	if (!exists(registryPath)) {
		errors.push(`release: ${REGISTRY_PATH} is missing`);
		return { errors };
	}
	let value: unknown;
	try {
		value = JSON.parse(textOf(registryPath)) as unknown;
	} catch {
		errors.push(`release: ${REGISTRY_PATH} must parse as JSON`);
		return { errors };
	}
	if (!exists(schemaPath)) {
		errors.push(`release: ${REGISTRY_SCHEMA_PATH} is missing`);
		return { errors };
	}
	let schema: JsonRecord;
	try {
		schema = JSON.parse(textOf(schemaPath)) as JsonRecord;
	} catch {
		errors.push(`release: ${REGISTRY_SCHEMA_PATH} must parse as JSON`);
		return { errors };
	}
	const schemaErrors = validateJsonSchema(value, schema);
	if (schemaErrors.length > 0) {
		errors.push(
			...schemaErrors.map((error) => `release: ${REGISTRY_PATH} ${error}`),
		);
		return { errors };
	}
	return { registry: value as ReleaseRegistry, errors };
}

/**
 * The registry is the only one.
 *
 * A second declaration anywhere in the tree — even a well-meaning
 * `release.backup.json` — leaves two answers to the question this file exists
 * to answer once, and a release gate is the last place that can afford two.
 */
export function validateSoleDeclarations(files: string[]): string[] {
	const errors: string[] = [];
	const wildcard = new Bun.Glob("release*.json");
	for (const path of files) {
		if (path === REGISTRY_PATH || path === REGISTRY_SCHEMA_PATH) continue;
		const rootLevel = !path.includes("/");
		if (
			basenameOf(path) === REGISTRY_PATH ||
			(rootLevel && wildcard.match(path))
		)
			errors.push(
				`release: ${path} is a second release declaration; ${REGISTRY_PATH} is the only one`,
			);
	}
	return errors.sort();
}

/**
 * The declared decision against what the tree supports, FIRST and
 * short-circuiting.
 *
 * Every leg below reads the registry as if it described this tree, and running
 * them over a declaration that demonstrably does not would print a page of
 * consequences for one cause. The `released` refusal is the one that matters:
 * the tag it names cannot exist until a merge commit does, so a tree that
 * declares itself released while carrying no such tag is a record trying to
 * upgrade its own gate.
 */
export function reconcileDecision(
	root: string,
	registry: ReleaseRegistry,
): string[] {
	const errors: string[] = [];
	const tags = git(root, ["tag", "--list", registry.release.plannedTag]);
	if (registry.decision === "released") {
		if (tags === undefined)
			errors.push(
				`release: ${REGISTRY_PATH} declares the released decision and this tree is not a Git repository, so the tag ${registry.release.plannedTag} could not be resolved`,
			);
		else if (tags === "")
			errors.push(
				`release: ${REGISTRY_PATH} declares the released decision but ${registry.release.plannedTag} is not a tag in this repository; a record never upgrades its own gate`,
			);
	} else if (tags !== undefined && tags !== "")
		errors.push(
			`release: ${registry.release.plannedTag} already exists but ${REGISTRY_PATH} still declares the candidate decision`,
		);
	const commit = registry.auditedSource.commit;
	const kind = git(root, ["cat-file", "-t", commit]);
	if (kind === undefined)
		errors.push(
			`release: ${REGISTRY_PATH} pins the audited commit ${commit}, which is not an object in this repository`,
		);
	else if (kind !== "commit")
		errors.push(
			`release: ${REGISTRY_PATH} pins the audited commit ${commit}, which is a ${kind} rather than a commit`,
		);
	else {
		const ancestor = Bun.spawnSync([
			"git",
			"-C",
			root,
			"merge-base",
			"--is-ancestor",
			commit,
			"HEAD",
		]);
		if (ancestor.exitCode !== 0)
			errors.push(
				`release: ${REGISTRY_PATH} pins the audited commit ${commit}, which is not an ancestor of HEAD`,
			);
		const tree = git(root, ["rev-parse", `${commit}^{tree}`]);
		if (tree !== undefined && tree !== registry.auditedSource.tree)
			errors.push(
				`release: ${REGISTRY_PATH} pins the audited tree ${registry.auditedSource.tree} but ${commit} carries ${tree}`,
			);
	}
	const changelog = textOf(resolve(root, CHANGELOG_PATH));
	if (
		changelog !== "" &&
		!changelog.includes(registry.release.changelogHeading)
	)
		errors.push(
			`release: ${CHANGELOG_PATH} carries no ${registry.release.changelogHeading} heading, so the tag and the changelog disagree`,
		);
	return errors.sort();
}

/**
 * The `template-only` block a line sits inside, or `"absent"` when the line is
 * not in the file at all.
 *
 * This guard's step must be inside ONE, which is the inverse of a core guard's
 * assertion and the inverse again of a gated one's. The renderer deletes the
 * block and everything in it, so a step outside would ship into projects that
 * received neither the script nor the module it runs.
 */
export function templateOnlyBlockOf(
	source: string,
	needle: string,
): string | "absent" | undefined {
	let current: string | undefined;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		const start = /^#\s*template-only:start\s+([a-z0-9-]+)$/.exec(trimmed);
		if (start?.[1]) {
			current = start[1];
			continue;
		}
		if (/^#\s*template-only:end\s+[a-z0-9-]+$/.test(trimmed)) {
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
 * A contract module nothing executes is documentation with an import
 * statement. The two package scripts, the workflow step, the block around it
 * and the validator call are all part of the contract.
 */
export async function validateWiring(root: string): Promise<string[]> {
	const errors: string[] = [];
	for (const path of TEMPLATE_ONLY_PATHS) {
		if (!exists(resolve(root, path)))
			errors.push(`release: ${path} is missing`);
	}
	const manifestPath = resolve(root, MANIFEST_PATH);
	if (exists(manifestPath)) {
		const manifest = (await Bun.file(manifestPath).json()) as JsonRecord;
		const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`release: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
		if (scripts[SYNC_SCRIPT] !== `bun ${GOLDEN_SYNC_ENTRYPOINT}`)
			errors.push(
				`release: package script ${SYNC_SCRIPT} must run ${GOLDEN_SYNC_ENTRYPOINT}`,
			);
		for (const name of [GUARD_SCRIPT, SYNC_SCRIPT]) {
			if (!name.startsWith("template:"))
				errors.push(
					`release: the package script ${name} must carry the template: prefix, which is what removes it from every rendered manifest`,
				);
		}
	}
	const workflowPath = resolve(root, WORKFLOW_PATH);
	if (exists(workflowPath)) {
		const source = textOf(workflowPath);
		const invocation = `bun run ${GUARD_SCRIPT}`;
		const block = templateOnlyBlockOf(source, invocation);
		if (block === "absent")
			errors.push(
				`release: the ${CONTRACT_JOB} job must run \`${invocation}\` in the required lane`,
			);
		else if (block === undefined)
			errors.push(
				`release: the \`${invocation}\` step must sit inside the ${TEMPLATE_ONLY_BLOCK} template-only block; this surface ships in no render and a step outside would survive into projects that received neither the script nor the module`,
			);
		else if (block !== TEMPLATE_ONLY_BLOCK)
			errors.push(
				`release: the \`${invocation}\` step sits inside the ${block} template-only block but this surface declares ${TEMPLATE_ONLY_BLOCK}`,
			);
		if (block !== "absent") {
			const step = contractJobStep(source, invocation);
			if (step === undefined)
				errors.push(
					`release: the \`${invocation}\` step must live in the ${CONTRACT_JOB} job, whose cost does not scale with the project graph`,
				);
			else if (step["if"] !== undefined)
				errors.push(
					`release: the \`${invocation}\` step must not be conditional`,
				);
		}
	}
	const validator = textOf(resolve(root, VALIDATOR_PATH));
	if (validator !== "" && !validator.includes("validateReleaseContract"))
		errors.push(
			`release: ${VALIDATOR_PATH} must call validateReleaseContract, or the hermetic aggregate never runs this guard`,
		);
	return errors.sort();
}

/**
 * Template ownership, and the four negatives that keep this surface
 * template-only.
 *
 * The positives are ordinary: the two root JSON files and the golden directory
 * carry explicit `omit` rules ahead of the final `*` catch-all, and the two
 * script modules carry NO rule at all — they fall to the `scripts/template/**`
 * omit catch-all, which is one line of absence rather than one line of code.
 *
 * The negatives are the decision. An `artifactRules` entry would gate these
 * files on a capability and make the gate something a project could switch on;
 * a `packageRules` entry would strip the script from a render that still had
 * the module; a `capabilitySignatures` claim would turn the word this domain is
 * named for into a residue token in a repository where sixty-nine tracked files
 * already carry it; and a `copy` ownership rule would ship a command whose
 * three inputs are all omitted.
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
	for (const pattern of [
		REGISTRY_PATH,
		REGISTRY_SCHEMA_PATH,
		`${GOLDEN_ROOT}/**`,
	]) {
		const index = rules.findIndex((entry) => entry["pattern"] === pattern);
		if (index < 0) {
			errors.push(
				`release: template ownership must declare ${pattern} ahead of the * catch-all`,
			);
			continue;
		}
		if (rootCatchAll >= 0 && index > rootCatchAll)
			errors.push(
				`release: template ownership declares ${pattern} behind the * catch-all, which never matches`,
			);
		if (rules[index]?.["renderPolicy"] !== "omit")
			errors.push(`release: template ownership must omit ${pattern}`);
	}
	for (const pattern of [
		GUARD_CONTRACT,
		GUARD_ENTRYPOINT,
		GOLDEN_SYNC_ENTRYPOINT,
	]) {
		const index = rules.findIndex((entry) => entry["pattern"] === pattern);
		if (index < 0) continue;
		if (rules[index]?.["renderPolicy"] === "copy")
			errors.push(
				`release: template ownership must not copy ${pattern}; this surface ships in no render and its inputs are omitted from all three`,
			);
		if (templateCatchAll >= 0 && index > templateCatchAll)
			errors.push(
				`release: template ownership declares ${pattern} behind the scripts/template/** catch-all, which never matches`,
			);
	}
	const templateOnly = new Set<string>(TEMPLATE_ONLY_PATHS);
	for (const rule of records(ownership["artifactRules"])) {
		const pattern = rule["pattern"];
		if (typeof pattern !== "string") continue;
		if (templateOnly.has(pattern) || pattern.startsWith(`${GOLDEN_ROOT}/`))
			errors.push(
				`release: ${pattern} must not be a gated artifact; this surface has no capability and ships in no render`,
			);
	}
	for (const rule of records(ownership["packageRules"])) {
		for (const script of strings(rule["scripts"])) {
			if (script !== GUARD_SCRIPT && script !== SYNC_SCRIPT) continue;
			errors.push(
				`release: no package rule may strip the ${script} script; the template: prefix already removes it from every render and a capability rule would tie it to one`,
			);
		}
	}
	const signatures = isRecord(ownership["capabilitySignatures"])
		? ownership["capabilitySignatures"]
		: {};
	for (const [capability, value] of Object.entries(signatures)) {
		if (!isRecord(value)) continue;
		for (const path of strings(value["paths"])) {
			if (templateOnly.has(path) || path.startsWith(`${GOLDEN_ROOT}/`))
				errors.push(
					`release: ${path} must not be a ${capability} capability signature path`,
				);
		}
		for (const token of strings(value["tokens"])) {
			if (token === GUARD_SCRIPT || token === SYNC_SCRIPT)
				errors.push(
					`release: ${token} must not be a ${capability} capability signature token`,
				);
		}
	}
	return errors.sort();
}

function goldenPathOf(registry: ReleaseRegistry, fixture: string): string {
	const declared = registry.goldens.fixtures.find(
		(entry) => entry.fixture === fixture,
	);
	return declared?.manifest ?? `${registry.goldens.directory}/${fixture}.json`;
}

async function readGolden(
	root: string,
	path: string,
): Promise<{ golden?: GoldenFile; error?: string }> {
	const target = resolve(root, path);
	if (!exists(target)) return { error: `release: ${path} is missing` };
	try {
		const value = JSON.parse(textOf(target)) as GoldenFile;
		if (
			value.schemaVersion !== 1 ||
			!isRecord(value.manifest) ||
			!Array.isArray(value.manifest.files)
		)
			return { error: `release: ${path} is not a golden render manifest` };
		return { golden: value };
	} catch {
		return { error: `release: ${path} must parse as JSON` };
	}
}

/**
 * A committed expectation against a fresh render, with every difference named
 * by its cause and its first offending path.
 */
export function classifyGoldenDrift(
	fixture: string,
	expected: RenderManifest,
	actual: RenderManifest,
): GoldenDrift[] {
	const drift: GoldenDrift[] = [];
	const expectedFiles = new Map(
		expected.files.map((entry) => [entry.path, entry]),
	);
	const actualFiles = new Map(actual.files.map((entry) => [entry.path, entry]));
	for (const [path, entry] of actualFiles) {
		if (!expectedFiles.has(path)) drift.push({ fixture, kind: "added", path });
		else {
			const before = expectedFiles.get(path);
			if (!before) continue;
			if (before.mode !== entry.mode)
				drift.push({
					fixture,
					kind: "mode",
					path,
					expected: before.mode,
					actual: entry.mode,
				});
			if (before.sha256 !== entry.sha256)
				drift.push({
					fixture,
					kind: "content",
					path,
					expected: before.sha256,
					actual: entry.sha256,
				});
		}
	}
	for (const path of expectedFiles.keys()) {
		if (!actualFiles.has(path)) drift.push({ fixture, kind: "removed", path });
	}
	return drift.sort((left, right) =>
		`${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`),
	);
}

const DRIFT_SENTENCE: Record<GoldenDriftKind, string> = {
	added: "renders a file the golden does not carry",
	removed: "no longer renders a file the golden carries",
	content: "renders different bytes for a file the golden carries",
	mode: "renders a different mode for a file the golden carries",
};

/** Every fixture named in the parameter file, read from the fixture directory. */
export function declaredFixtures(root: string): string[] {
	const directory = resolve(root, FIXTURE_ROOT);
	if (!exists(directory)) return [];
	return readdirSync(directory)
		.filter((name) => name.endsWith(".toml"))
		.map((name) => name.slice(0, -".toml".length))
		.sort();
}

/**
 * The goldens, compared against renders produced now.
 *
 * A pinned digest nothing compares is decoration: a manifest can name a hash
 * that matches no file in the tree and stay green forever. This is the
 * comparison, and the mutation suite beside it is what proves the comparison
 * runs.
 */
export async function validateGoldens(
	root: string,
	registry: ReleaseRegistry,
	options: { render?: boolean } = {},
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const declared = registry.goldens.fixtures;
	if (declared.length === 0) {
		errors.push(
			"release: no fixture declares a golden manifest; an expectation over nothing is a pass nobody earned",
		);
		return { errors, notices };
	}
	const fixtures = declaredFixtures(root);
	for (const fixture of fixtures) {
		if (!declared.some((entry) => entry.fixture === fixture))
			errors.push(
				`release: ${FIXTURE_ROOT}/${fixture}.toml has no declared golden manifest`,
			);
	}
	for (const entry of declared) {
		if (!exists(resolve(root, `${FIXTURE_ROOT}/${entry.fixture}.toml`)))
			errors.push(
				`release: ${REGISTRY_PATH} declares a golden for ${entry.fixture}, which is not a fixture definition`,
			);
		if (
			entry.manifest !== `${registry.goldens.directory}/${entry.fixture}.json`
		)
			errors.push(
				`release: the ${entry.fixture} golden must live at ${registry.goldens.directory}/${entry.fixture}.json`,
			);
	}
	const total = declared.reduce((sum, entry) => sum + entry.fileCount, 0);
	if (total !== registry.goldens.totalFileCount)
		errors.push(
			`release: the declared golden file counts sum to ${total} but ${REGISTRY_PATH} declares ${registry.goldens.totalFileCount}; a half-updated golden is a refusal rather than a smaller diff`,
		);
	if (registry.goldens.regenerateWith !== `bun run ${SYNC_SCRIPT}`)
		errors.push(
			`release: ${REGISTRY_PATH} must name \`bun run ${SYNC_SCRIPT}\` as the regeneration command`,
		);
	const goldens = new Map<string, GoldenFile>();
	for (const entry of declared) {
		const { golden, error } = await readGolden(root, entry.manifest);
		if (error || !golden) {
			if (error) errors.push(error);
			continue;
		}
		goldens.set(entry.fixture, golden);
		if (golden.manifest.files.length !== entry.fileCount)
			errors.push(
				`release: ${entry.manifest} carries ${golden.manifest.files.length} files but ${REGISTRY_PATH} declares ${entry.fileCount}`,
			);
		if (golden.manifest.files.length === 0)
			errors.push(
				`release: ${entry.manifest} pins no file at all; a golden over nothing is a pass nobody earned`,
			);
		if (golden.regenerateWith !== registry.goldens.regenerateWith)
			errors.push(
				`release: ${entry.manifest} must name ${registry.goldens.regenerateWith} as its regeneration command`,
			);
		if (golden.volatileFieldsExcluded.length === 0)
			errors.push(
				`release: ${entry.manifest} must name what it does NOT pin, or the first cross-machine mismatch gets fixed by deleting the golden`,
			);
	}
	if (options.render === false) {
		notices.push(
			"release: the golden comparison did not render; the committed manifests were shape-checked and not compared",
		);
		return { errors: errors.sort(), notices: notices.sort() };
	}
	const output = await mkdtemp(resolve(tmpdir(), "devenv-release-goldens-"));
	try {
		for (const entry of declared) {
			const golden = goldens.get(entry.fixture);
			if (!golden) continue;
			let manifest: RenderManifest;
			try {
				const result = await renderFixture({
					root,
					fixtureName: entry.fixture,
					output: resolve(output, entry.fixture),
					force: true,
				});
				manifest = result.manifest;
			} catch (error) {
				errors.push(
					`release: the ${entry.fixture} fixture did not render: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (manifest.omittedCount !== entry.omittedCount)
				errors.push(
					`release: the ${entry.fixture} render omits ${manifest.omittedCount} tracked paths but ${REGISTRY_PATH} declares ${entry.omittedCount}`,
				);
			if (manifest.enabledCapabilities.length !== entry.enabledCount)
				errors.push(
					`release: the ${entry.fixture} render enables ${manifest.enabledCapabilities.length} capabilities but ${REGISTRY_PATH} declares ${entry.enabledCount}`,
				);
			if (manifest.disabledCapabilities.length !== entry.disabledCount)
				errors.push(
					`release: the ${entry.fixture} render disables ${manifest.disabledCapabilities.length} capabilities but ${REGISTRY_PATH} declares ${entry.disabledCount}`,
				);
			const drift = classifyGoldenDrift(
				entry.fixture,
				golden.manifest,
				manifest,
			);
			const seen = new Set<GoldenDriftKind>();
			for (const item of drift) {
				if (seen.has(item.kind)) continue;
				seen.add(item.kind);
				const count = drift.filter((other) => other.kind === item.kind).length;
				errors.push(
					`release: the ${entry.fixture} fixture ${DRIFT_SENTENCE[item.kind]}, first at ${item.path} (${count} of this kind); regenerate with \`${registry.goldens.regenerateWith}\` and review the diff`,
				);
			}
			// The template-only assertion, from the other side. Every previous
			// stage proved its guard was PRESENT in the renders that enabled it;
			// this one proves its guard is present in none of them.
			for (const path of [...TEMPLATE_ONLY_PATHS, entry.manifest]) {
				if (manifest.files.some((file) => file.path === path))
					errors.push(
						`release: the ${entry.fixture} render carries ${path}, which is template-only and must appear in no render`,
					);
			}
			notices.push(
				`release: the ${entry.fixture} golden pinned ${manifest.files.length} rendered files and ${manifest.omittedCount} omitted template paths`,
			);
		}
	} finally {
		await rm(output, { recursive: true, force: true });
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * Every leg, in the order the requirement enumerates them, with the notices
 * kept separate from the refusals.
 *
 * "Checked nothing", "found nothing wrong" and "another guard owns this"
 * produce the same exit status and are not the same claim.
 */
export async function inspectReleaseContract(
	root = resolve(import.meta.dir, "../.."),
	options: ReleaseContractOptions = {},
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const { registry, errors: registryErrors } = await readReleaseRegistry(root);
	errors.push(...registryErrors);
	const tracked = trackedFiles(root);
	if (tracked === undefined)
		notices.push(
			`release: ${root} is not a Git repository, so the enumeration fell back to a directory walk and no rule here is answering about the committed tree`,
		);
	const files = tracked ?? walkFiles(root);
	errors.push(...validateSoleDeclarations(files));
	if (!registry) return { errors: [...new Set(errors)].sort(), notices };

	// Decision reconciliation runs FIRST and short-circuits, because every leg
	// below reads the registry as if it described this tree.
	const decisionErrors = reconcileDecision(root, registry);
	errors.push(...decisionErrors);
	if (decisionErrors.length > 0)
		return {
			errors: [...new Set(errors)].sort(),
			notices: [...new Set(notices)].sort(),
		};

	errors.push(...(await validateWiring(root)));
	errors.push(...(await validateOwnership(root)));

	const goldens = await validateGoldens(
		root,
		registry,
		options.renders === undefined ? {} : { render: options.renders },
	);
	errors.push(...goldens.errors);
	notices.push(...goldens.notices);

	return {
		errors: [...new Set(errors)].sort(),
		notices: [...new Set(notices)].sort(),
	};
}

export async function validateReleaseContract(
	root = resolve(import.meta.dir, "../.."),
	options: ReleaseContractOptions = {},
): Promise<string[]> {
	return (await inspectReleaseContract(root, options)).errors;
}
