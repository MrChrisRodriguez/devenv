// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON and YAML are strict records.

import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { IMMUTABLE_REFERENCE } from "./ci-contract";
import { validateJsonSchema } from "./json-schema";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	resolveFixtureParameters,
	type TemplateParameters,
} from "./parameters";
import {
	loadTemplateOwnership,
	type RenderManifest,
	type ResidueReport,
	renderFixture,
	scanDisabledResidue,
	type TemplateOwnership,
} from "./render-fixture";
import { IMMUTABLE_PLUGIN } from "./toolchain";
import { LEGACY_LAUNCHER } from "./worktree-contract";

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
const BASELINE_RECORD = "evidence/stage-0-baseline.json";

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
	scans: ScanDeclaration[];
	topLevelWorkspaces: {
		allowed: string[];
		exceptions: Array<{ directory: string; reason: string }>;
	};
	syncBoundary: {
		script: string;
		risk: string;
		mergeDeclaredButExcluded: number;
		reason: string;
	};
	deferrals: DeferralDeclaration[];
	agentRuleSections: Array<{ script: string; section: string }>;
	acceptance: AcceptanceDeclaration[];
	budgets: BudgetDeclaration[];
	signals: SignalDeclaration[];
}

/**
 * The six scan families the requirement names, in its own order.
 *
 * `tasks.md` names four of them; `spec.md` names six, and the spec is the
 * normative artefact. The two it omits — fixed source ports and obsolete
 * commands — are also the two cheapest: one reads a TOML table that already
 * exists and one imports a constant that already exists.
 */
export const SCAN_IDS = [
	"source-identifier",
	"fixed-source-port",
	"mutable-pin",
	"obsolete-command",
	"duplicate-rule-skill",
	"disabled-residue",
] as const;

export type ScanId = (typeof SCAN_IDS)[number];

/**
 * A tolerated hit, with the mechanism that makes it safe named mechanically.
 *
 * A guard biases toward FALSE POSITIVES: a canonical token appearing only in a
 * comment gets flagged and is resolved with an entry here, rather than with a
 * cleverer matcher. A string-literal-aware stripper is the thing that silently
 * stops matching, and a scan that stops matching is worse than no scan.
 *
 * `mechanism` is what stops the entry outliving its justification: every needle
 * it names must still be present in the file it names, so the exemption dies
 * with the code that earned it.
 */
export interface ScanAllowEntry {
	path: string;
	token: string;
	reason: string;
	mechanism: Array<{ path: string; needle: string }>;
}

export interface ScanExemption {
	path: string;
	reason: string;
}

export interface ScanDeclaration {
	id: ScanId;
	authority: string;
	ownedBy: string | null;
	allow: ScanAllowEntry[];
	knownExemptions: ScanExemption[];
}

export interface DeferralDeclaration {
	id: string;
	recordedBy: string;
	blockingFacts: string[];
	unblockedWhen: string[];
}

export interface RenderedFixture {
	fixture: string;
	root: string;
	manifest: RenderManifest;
	residue: ResidueReport;
	parameters: TemplateParameters;
}

export interface ScanSurface {
	label: string;
	root: string;
	files: string[];
}

export interface ScanFinding {
	scan: ScanId;
	surface: string;
	path: string;
	token: string;
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
	options: { render?: boolean; renders?: RenderedFixture[] } = {},
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
	const output =
		options.renders === undefined
			? await mkdtemp(resolve(tmpdir(), "devenv-release-goldens-"))
			: undefined;
	try {
		const rendered =
			options.renders ??
			(
				await renderAllFixtures(
					root,
					declared.map((entry) => entry.fixture),
					output as string,
				)
			).renders;
		const renderedRoots = new Map(
			rendered.map((item) => [item.fixture, item.root]),
		);
		for (const entry of declared) {
			const golden = goldens.get(entry.fixture);
			if (!golden) continue;
			const render = rendered.find((item) => item.fixture === entry.fixture);
			if (!render) {
				errors.push(
					`release: the ${entry.fixture} fixture did not render, so its golden was not compared`,
				);
				continue;
			}
			const manifest = render.manifest;
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
			const renderRoot = renderedRoots.get(entry.fixture);
			if (renderRoot !== undefined) {
				let scripts: string[] = [];
				try {
					const generated = (await Bun.file(
						resolve(renderRoot, MANIFEST_PATH),
					).json()) as JsonRecord;
					scripts = isRecord(generated["scripts"])
						? Object.keys(generated["scripts"])
						: [];
				} catch {
					errors.push(
						`release: the ${entry.fixture} render has no readable ${MANIFEST_PATH}`,
					);
				}
				const sections = validateAgentSections(
					registry,
					scripts,
					textOf(resolve(renderRoot, "AGENTS.md")),
					`the ${entry.fixture} render`,
				);
				errors.push(...sections.errors);
				notices.push(...sections.notices);
			}
		}
	} finally {
		if (output) await rm(output, { recursive: true, force: true });
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

// ── the six scan families ─────────────────────────────────────────────────
//
// Every one of them runs over the three RENDERS, which is the new thing: the
// requirement says "scan outputs", and every existing scan in this repository
// runs over the template tree. Four of them also run over the template tree,
// because a source-identifier scan that stops at the render boundary is weaker
// than it should be — but the template surface is narrowed to the files a
// render actually receives, so `evidence/`, `docs/`, `CHANGES.md` and
// `openspec/` are out of scope by construction rather than by allow-list.
//
// And every one of them CROSS-REFERENCES the module that already owns its
// sentence rather than restating it. Two refusals for one defect send the
// reader to two files.

/** Render every declared fixture once, for the goldens and the scans alike. */
export async function renderAllFixtures(
	root: string,
	fixtures: string[],
	output: string,
): Promise<{ renders: RenderedFixture[]; errors: string[] }> {
	const renders: RenderedFixture[] = [];
	const errors: string[] = [];
	const parameters = await loadTemplateParameters(root);
	for (const fixture of fixtures) {
		try {
			const target = resolve(output, fixture);
			const result = await renderFixture({
				root,
				fixtureName: fixture,
				output: target,
				force: true,
			});
			const definition = await loadFixtureDefinition(root, fixture, parameters);
			renders.push({
				fixture,
				root: target,
				manifest: result.manifest,
				residue: result.residue,
				parameters: resolveFixtureParameters(parameters, definition),
			});
		} catch (error) {
			errors.push(
				`release: the ${fixture} fixture did not render: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { renders, errors };
}

function matchesPath(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (pattern.endsWith("/")) return path.startsWith(pattern);
	try {
		return new Bun.Glob(pattern).match(path);
	} catch {
		return false;
	}
}

/**
 * The template tree's scan surface: the files a render actually receives.
 *
 * Narrowing by render policy rather than by allow-list is what keeps the
 * source-identifier allow-list down to three entries. `evidence/` carries host
 * paths from real captures and `CHANGES.md` names the repository this template
 * mirrors; both are omitted from every render, so neither is a finding and
 * neither needs an exemption saying so.
 */
export async function templateScanSurface(
	root: string,
	files: string[],
): Promise<ScanSurface> {
	const ownership = await loadTemplateOwnership(root);
	const received = files.filter((path) => {
		const rule = ownership.ownershipRules.find((candidate) =>
			matchesPath(candidate.pattern, path),
		);
		return rule !== undefined && rule.renderPolicy !== "omit";
	});
	return { label: "the template tree", root, files: received };
}

/** Every file of a rendered tree, pruned the same way every walk here is. */
export function renderScanSurface(render: RenderedFixture): ScanSurface {
	return {
		label: `the ${render.fixture} render`,
		root: render.root,
		files: render.manifest.files.map((entry) => entry.path),
	};
}

function stringLiteralsIn(block: string): string[] {
	const found: string[] = [];
	const pattern = /(['"])((?:\\.|(?!\1).)*)\1/g;
	let match = pattern.exec(block);
	while (match) {
		found.push((match[2] ?? "").replace(/\\(.)/g, "$1"));
		match = pattern.exec(block);
	}
	return found;
}

/**
 * The forbidden-token list, ASSEMBLED from the renderer at run time.
 *
 * It is read out of `render-fixture.ts` rather than imported, because the
 * renderer does not export it and this stage may not touch the file it exists
 * to measure. Reading it has a second property worth having: a needle list that
 * silently became empty is the most dangerous failure a scan can have, so an
 * unreadable or empty block is a refusal rather than a clean sweep.
 */
export function forbiddenIdentifierTokens(source: string): string[] {
	const anchor = source.indexOf("GLOBAL_FORBIDDEN_TOKENS");
	if (anchor < 0) return [];
	const open = source.indexOf("[", anchor);
	const close = source.indexOf("]", open);
	if (open < 0 || close < 0) return [];
	return stringLiteralsIn(source.slice(open + 1, close));
}

/** Every port the parameter file advertises, plus the published container one. */
export function declaredPorts(parameters: TemplateParameters): number[] {
	return [
		...new Set([
			...parameters.advertised_ports.map((entry) => entry.port),
			parameters.routing.published_container_port,
		]),
	].sort((left, right) => left - right);
}

interface ScanContext {
	identifierTokens: string[];
	ports: number[];
}

async function readTextFile(root: string, path: string): Promise<string> {
	try {
		return await Bun.file(resolve(root, path)).text();
	} catch {
		return "";
	}
}

function actionReferences(source: string): string[] {
	const found: string[] = [];
	for (const line of source.split("\n")) {
		const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
		if (match?.[1]) found.push(match[1]);
	}
	return found;
}

function pluginLocators(source: string): string[] {
	const found: string[] = [];
	let inPlugins = false;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			inPlugins = trimmed === "[plugins]";
			continue;
		}
		if (!inPlugins) continue;
		const match = /^[A-Za-z0-9_-]+\s*=\s*"([^"]+)"/.exec(trimmed);
		if (match?.[1]) found.push(match[1]);
	}
	return found;
}

/**
 * Every content scan over one surface, in one pass over its files.
 *
 * The scan reports the number of files it READ, and zero is a refusal. A sweep
 * that enumerated nothing and reported success is the vacuous pass this whole
 * requirement exists to name.
 */
export async function scanSurface(
	surface: ScanSurface,
	context: ScanContext,
): Promise<{ findings: ScanFinding[]; scanned: number }> {
	const findings: ScanFinding[] = [];
	const portPattern =
		context.ports.length > 0
			? new RegExp(`\\b(?:${context.ports.join("|")})\\b`)
			: undefined;
	let scanned = 0;
	for (const path of surface.files) {
		const content = await readTextFile(surface.root, path);
		if (content === "") continue;
		scanned += 1;
		for (const token of context.identifierTokens) {
			if (content.includes(token))
				findings.push({
					scan: "source-identifier",
					surface: surface.label,
					path,
					token,
				});
		}
		if (portPattern) {
			const match = portPattern.exec(content);
			if (match)
				findings.push({
					scan: "fixed-source-port",
					surface: surface.label,
					path,
					token: match[0],
				});
		}
		if (content.includes(LEGACY_LAUNCHER))
			findings.push({
				scan: "obsolete-command",
				surface: surface.label,
				path,
				token: LEGACY_LAUNCHER,
			});
		if (/^\.github\/(?:workflows|actions)\/.+\.ya?ml$/.test(path)) {
			for (const reference of actionReferences(content)) {
				if (reference.startsWith("./")) continue;
				if (IMMUTABLE_REFERENCE.test(reference)) continue;
				findings.push({
					scan: "mutable-pin",
					surface: surface.label,
					path,
					token: reference,
				});
			}
		}
		if (path === ".prototools") {
			for (const locator of pluginLocators(content)) {
				if (IMMUTABLE_PLUGIN.test(locator)) continue;
				findings.push({
					scan: "mutable-pin",
					surface: surface.label,
					path,
					token: locator,
				});
			}
		}
	}
	return { findings, scanned };
}

/**
 * Skill and command directories, counted across every agent surface.
 *
 * The duplicate-NORMATIVE-TEXT half of this requirement already has an owner,
 * and this leg emits a notice naming it rather than writing the rule twice.
 * What nobody owns is the other half: `graphify` is a skill directory under
 * three agent surfaces at once, which is correct and intended, and until now
 * nothing asserted that it was intended. A fourth copy — or a second name
 * appearing twice — is indistinguishable from that by inspection.
 */
export function skillDirectories(files: string[]): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const path of files) {
		const match = /^(\.[a-z]+)\/(?:skills|commands)\/([^/]+)\//.exec(path);
		if (!match?.[1] || !match[2]) continue;
		const surfaces = found.get(match[2]) ?? [];
		if (!surfaces.includes(match[1])) surfaces.push(match[1]);
		found.set(match[2], surfaces.sort());
	}
	return found;
}

function declarationOf(
	registry: ReleaseRegistry,
	id: ScanId,
): ScanDeclaration | undefined {
	return registry.scans.find((entry) => entry.id === id);
}

function tolerated(
	declaration: ScanDeclaration | undefined,
	finding: ScanFinding,
): boolean {
	if (!declaration) return false;
	if (
		declaration.knownExemptions.some((entry) =>
			matchesPath(entry.path, finding.path),
		)
	)
		return true;
	return declaration.allow.some(
		(entry) =>
			matchesPath(entry.path, finding.path) && entry.token === finding.token,
	);
}

/**
 * The six families, run and reconciled with what the registry declares.
 */
export async function validateScans(
	root: string,
	registry: ReleaseRegistry,
	renders: RenderedFixture[],
	files: string[],
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	for (const id of SCAN_IDS) {
		if (!declarationOf(registry, id))
			errors.push(
				`release: ${REGISTRY_PATH} declares no ${id} scan; the requirement names six families and a missing one is a clause nobody discharged`,
			);
	}
	for (const declaration of registry.scans) {
		if (!(SCAN_IDS as readonly string[]).includes(declaration.id))
			errors.push(
				`release: ${REGISTRY_PATH} declares the ${declaration.id} scan, which is not one of the six the requirement names`,
			);
		if (declaration.ownedBy)
			notices.push(
				`release: the ${declaration.id} scan cross-references ${declaration.ownedBy}, which owns that sentence for the template tree; this scan adds the render surface`,
			);
		// An exemption whose justification has been deleted is a widened rule
		// wearing an allow-list's clothes.
		for (const entry of declaration.allow) {
			for (const mechanism of entry.mechanism) {
				const source = textOf(resolve(root, mechanism.path));
				if (source === "" || !source.includes(mechanism.needle))
					errors.push(
						`release: the ${declaration.id} allowance for ${entry.token} in ${entry.path} cites ${mechanism.path}, which no longer contains \`${mechanism.needle}\`; the exemption dies with the mechanism that earned it`,
					);
			}
		}
	}

	const rendererSource = textOf(
		resolve(root, "scripts/template/render-fixture.ts"),
	);
	const identifierTokens = forbiddenIdentifierTokens(rendererSource);
	if (identifierTokens.length === 0)
		errors.push(
			"release: the source-identifier needle list read out of scripts/template/render-fixture.ts is empty; a scan with no needles reports success over everything",
		);
	const parameters = await loadTemplateParameters(root);
	const ports = declaredPorts(parameters);
	if (ports.length === 0)
		errors.push(
			"release: template-parameters.toml advertises no port, so the fixed-source-port scan has no needles",
		);
	const context: ScanContext = { identifierTokens, ports };

	const surfaces: ScanSurface[] = [
		await templateScanSurface(root, files),
		...renders.map(renderScanSurface),
	];
	for (const surface of surfaces) {
		const { findings, scanned } = await scanSurface(surface, context);
		if (scanned === 0)
			errors.push(
				`release: the scan of ${surface.label} read no file at all; a sweep over nothing is a pass nobody earned`,
			);
		for (const finding of findings) {
			if (tolerated(declarationOf(registry, finding.scan), finding)) continue;
			errors.push(
				`release: the ${finding.scan} scan found ${finding.token} in ${surface.label} at ${finding.path}`,
			);
		}
		notices.push(
			`release: the source-identifier, fixed-source-port, mutable-pin and obsolete-command scans read ${scanned} files of ${surface.label}`,
		);
	}

	// ── duplicate rules and skills ──────────────────────────────────────────
	const duplicates = declarationOf(registry, "duplicate-rule-skill");
	notices.push(
		"release: duplicate normative rule TEXT is refused by rules:check, which owns that sentence; this scan covers the skill and command directories nothing else reads",
	);
	for (const surface of surfaces) {
		const directories = skillDirectories(surface.files);
		if (surface.label === "the template tree" && directories.size === 0)
			errors.push(
				"release: no skill or command directory was found in the template tree, so the duplicate scan compared nothing",
			);
		for (const [name, agents] of directories) {
			if (agents.length < 2) continue;
			if (
				duplicates?.knownExemptions.some((entry) =>
					matchesPath(entry.path, name),
				)
			)
				continue;
			errors.push(
				`release: the skill ${name} exists under ${agents.join(", ")} in ${surface.label} and ${REGISTRY_PATH} does not declare the duplication as intended`,
			);
		}
		notices.push(
			`release: the duplicate-rule-skill scan inspected ${directories.size} skill and command directories of ${surface.label}`,
		);
	}

	// ── disabled-capability residue ─────────────────────────────────────────
	const ownership = await loadTemplateOwnership(root);
	for (const render of renders) {
		let report: ResidueReport;
		try {
			report = await scanDisabledResidue(
				render.root,
				render.parameters,
				ownership,
			);
		} catch (error) {
			errors.push(
				`release: the disabled-residue scan of the ${render.fixture} render did not run: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (report.status !== "pass")
			errors.push(
				`release: the disabled-residue scan of the ${render.fixture} render found ${report.findings.length} findings, first ${report.findings[0]?.signature} in ${report.findings[0]?.path}`,
			);
		if (report.scannedFiles === 0)
			errors.push(
				`release: the disabled-residue scan of the ${render.fixture} render read no file at all`,
			);
		// The hole inside the function that implements the anti-vacuity
		// requirement. `scanDisabledResidue` refuses zero FILES and has never
		// refused zero disabled capabilities — and the `full` fixture enables
		// everything, so its residue scan has been structurally vacuous since the
		// day it was written. That is not a defect in `full`; it is a fact about
		// it, and the caller is where it gets said out loud.
		const disabled = render.manifest.disabledCapabilities.length;
		if (disabled > 0 && report.scannedDisabledCapabilities === 0)
			errors.push(
				`release: the ${render.fixture} render disables ${disabled} capabilities and its residue scan scanned none of them; a residue scan with no disabled capability is a pass nobody earned`,
			);
		if (disabled === 0)
			notices.push(
				`release: the ${render.fixture} render disables no capability, so its residue scan is vacuous by construction rather than by defect and proves nothing about residue`,
			);
		else
			notices.push(
				`release: the ${render.fixture} residue scan covered ${report.scannedFiles} files for ${report.scannedDisabledCapabilities} disabled capabilities with a signature`,
			);
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * The deferrals, recorded WITH a mechanical assertion rather than as a note.
 *
 * `graphify` is the program's anchor deferral, parked at this stage by Stage 9
 * and re-parked by Stage 10E. It is not closed here, and the reason is
 * measured: two of its three surfaces cannot carry a capability fence at all,
 * because a fence in this repository is a line comment and `tsconfig.json` and
 * `.claude/settings.json` are strict JSON; and a signature added today would
 * sit INERT, because the residue scan selects default-FALSE capabilities that
 * have a signature and `graphify` defaults to true. So the assertion is the
 * inertness itself: the moment the default flips or the selection changes, this
 * refusal fires and the deferral has to be decided rather than inherited.
 */
export async function validateDeferrals(
	root: string,
	registry: ReleaseRegistry,
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	if (registry.deferrals.length === 0)
		errors.push(
			`release: ${REGISTRY_PATH} records no deferral at all; the program carries a ledger and an empty one is a claim nobody checked`,
		);
	for (const entry of registry.deferrals) {
		if (entry.blockingFacts.length === 0)
			errors.push(
				`release: the ${entry.id} deferral names no blocking fact, so nothing says why it is still open`,
			);
		if (entry.unblockedWhen.length === 0)
			errors.push(
				`release: the ${entry.id} deferral names no condition under which it becomes possible, so nothing will ever close it`,
			);
		notices.push(
			`release: ${entry.id} stays deferred, recorded by ${entry.recordedBy}, and this run asserted the facts that keep it open`,
		);
	}
	const parameters = await loadTemplateParameters(root);
	const ownership = await loadTemplateOwnership(root);
	const graphify = registry.deferrals.find((entry) => entry.id === "graphify");
	if (graphify) {
		const selected = Object.entries(parameters.capabilities.defaults)
			.filter(([, enabled]) => !enabled)
			.map(([capability]) => capability)
			.filter((capability) => ownership.capabilitySignatures[capability]);
		if (parameters.capabilities.defaults["graphify"] !== true)
			errors.push(
				"release: graphify no longer defaults to true, so the signature the graphify deferral calls inert would now be scanned; decide the deferral rather than inheriting it",
			);
		if (ownership.capabilitySignatures["graphify"] !== undefined)
			errors.push(
				"release: graphify has acquired a capability signature while the graphify deferral still records it as absent; the deferral and the ownership file disagree",
			);
		if (selected.includes("graphify"))
			errors.push(
				"release: graphify is now inside the disabled-residue scan's selected set, which the graphify deferral records as impossible",
			);
		notices.push(
			`release: the disabled-residue scan selects ${selected.length} default-false capabilities that carry a signature, and graphify is not one of them`,
		);
		// The path half of the fence already works and needs nothing; naming the
		// rules is what stops a future reader concluding the surface is unfenced.
		for (const pattern of [
			".claude/skills/graphify/**",
			".codex/skills/graphify/**",
			".gemini/skills/graphify/**",
			".devcontainer/on-create/setup-graphify.sh",
		]) {
			const rule = ownership.artifactRules.find(
				(entry) => entry.pattern === pattern,
			);
			if (!rule || !rule.requiresAll.includes("graphify"))
				errors.push(
					`release: ${pattern} is no longer gated on graphify, and the graphify deferral records it as already covered`,
				);
		}
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * The top-level blind spot, closed with the narrow version 10E wrote for it.
 *
 * A second workspace hiding outside the workspace globs is a RELEASE defect
 * rather than an experiment one: it is a tree the release gate renders and no
 * guard reads. The rule is three lines and it would have caught nothing in
 * either repository, which is a fair argument that it catches nothing here —
 * so the anti-vacuity anchor is the number of top-level directories inspected
 * and never the number of violations found.
 */
export function validateTopLevelWorkspaces(
	registry: ReleaseRegistry,
	files: string[],
): ReleaseReport {
	const errors: string[] = [];
	const notices: string[] = [];
	const directories = new Set<string>();
	const manifests = new Set<string>();
	for (const path of files) {
		const segments = path.split("/");
		if (segments.length < 2 || !segments[0]) continue;
		directories.add(segments[0]);
		if (segments.length === 2 && segments[1] === MANIFEST_PATH)
			manifests.add(segments[0]);
	}
	if (directories.size === 0)
		errors.push(
			"release: the tracked tree has no top-level directory at all, so the layout rule inspected nothing",
		);
	const allowed = new Set([
		...registry.topLevelWorkspaces.allowed,
		...registry.topLevelWorkspaces.exceptions.map((entry) => entry.directory),
	]);
	for (const directory of [...manifests].sort()) {
		if (allowed.has(directory)) continue;
		errors.push(
			`release: ${directory}/${MANIFEST_PATH} makes ${directory} a workspace outside ${registry.topLevelWorkspaces.allowed.join(" and ")}; declare it or move it, because a package nothing globs is a tree no guard reads`,
		);
	}
	notices.push(
		`release: the top-level layout rule inspected ${directories.size} tracked directories and found ${manifests.size} carrying a ${MANIFEST_PATH}`,
	);
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * Shell `case` semantics, which are not glob semantics.
 *
 * `scripts/*` in a `case` matches `scripts/template/foo.ts`, because the shell
 * pattern's `*` crosses `/`. Reading the table with a globber that does not
 * would produce the opposite answer for every entry that matters.
 */
export function shellCaseExcludes(source: string, path: string): boolean {
	const body = source.slice(source.indexOf("is_excluded()"));
	for (const line of body.split("\n")) {
		if (line.includes("esac")) break;
		const match = /^\s*([^)\s][^)]*)\)\s*return\s+([01])\s*;;/.exec(line);
		if (!match?.[1] || !match[2]) continue;
		for (const pattern of match[1].split("|")) {
			const expression = new RegExp(
				`^${pattern
					.trim()
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".")}$`,
			);
			if (expression.test(path)) return match[2] === "0";
		}
	}
	return false;
}

/**
 * The sync boundary, as a RATCHET rather than as an equality.
 *
 * `template-ownership.json` declares thirty-five `scripts/template/*.ts` files
 * as `syncPolicy: merge`, and `sync-devcontainer.sh` excludes every one of them
 * through its `scripts/*` case arm. That is not news: `knownBoundaryRisks[0]`
 * says it in writing — "any further template-owned script under scripts/ still
 * requires the same paired cutover ... or its declared syncPolicy merge is a
 * lie". Closing it means rewriting the sync script's exclusion table in the
 * stage that closes the program, which is the wrong stage for it.
 *
 * So the count is declared and asserted, which is the half that is worth
 * having: a thirty-sixth file joining the silent set is a refusal naming it,
 * and the risk stops being a paragraph nobody re-reads.
 */
export async function validateSyncBoundary(
	root: string,
	registry: ReleaseRegistry,
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const source = textOf(resolve(root, registry.syncBoundary.script));
	if (source === "") {
		notices.push(
			`release: ${registry.syncBoundary.script} is absent, so the sync boundary was not reconciled`,
		);
		return { errors, notices };
	}
	const ownership = await loadTemplateOwnership(root);
	const silent: string[] = [];
	for (const rule of ownership.ownershipRules) {
		if (!rule.pattern.startsWith("scripts/")) continue;
		if (rule.pattern.endsWith("/**") || rule.pattern.endsWith("*")) continue;
		if (rule.syncPolicy !== "merge" || rule.renderPolicy !== "copy") continue;
		if (shellCaseExcludes(source, rule.pattern)) silent.push(rule.pattern);
	}
	if (silent.length !== registry.syncBoundary.mergeDeclaredButExcluded)
		errors.push(
			`release: ${silent.length} tracked scripts declare syncPolicy merge and are excluded by ${registry.syncBoundary.script}, but ${REGISTRY_PATH} declares ${registry.syncBoundary.mergeDeclaredButExcluded}; first ${silent.sort()[0]}`,
		);
	notices.push(
		`release: ${silent.length} template-owned scripts declare a merge sync policy that ${registry.syncBoundary.script} excludes, which ${registry.syncBoundary.risk} already records; this run asserts the count rather than widening the script`,
	);
	return { errors: errors.sort(), notices: notices.sort() };
}

// ── 18.2's ten acceptance items, DERIVED rather than chosen ───────────────
//
// All ten already have a sealed record. Re-running all ten is days of live
// capture that would re-prove Stages 1 through 10 at a head where most of their
// surfaces have not moved; not re-running them and saying "Stage 2 proved it"
// is a claim about a commit rather than about HEAD. So each item declares the
// paths that produced its record and the commit that sealed it, and the guard
// runs the diff: an inherited claim is legal only while the paths that produced
// it are byte-unchanged. `mode` is therefore not a choice — it is a
// consequence, and this function is what computes it.
export const ACCEPTANCE_ITEMS = [
	"exact-head-ci",
	"full-default-branch-ci",
	"image-build",
	"two-worktree-isolation",
	"doctor-security",
	"cloud-profiles",
	"browser-preflight",
	"openspec-lifecycle",
	"dependency-guards",
	"enabled-stack-tests",
] as const;

export type AcceptanceItem = (typeof ACCEPTANCE_ITEMS)[number];

export interface AcceptanceDeclaration {
	id: AcceptanceItem;
	item: string;
	evidenceRecord: string;
	boundarySha: string;
	ownedPaths: string[];
	mode: "live" | "inherited";
	liveCommand: string | null;
	knownNonDefects: string[];
}

export const BUDGET_FAMILIES = [
	"warm command latency",
	"startup/readiness",
	"clean and incremental rebuild behavior",
	"second-worktree disk growth",
] as const;

export interface BudgetSide {
	record: string;
	pointer: string;
	value: number;
	unit: "seconds" | "milliseconds" | "bytes";
	normalized: number;
}

export interface BudgetDeclaration {
	id: string;
	specFamily: (typeof BUDGET_FAMILIES)[number];
	baselineStatus: "measured" | "unavailable";
	baselineMeasurement: string;
	baseline: BudgetSide | null;
	final: BudgetSide | null;
	delta: number | null;
	verdict: "improved" | "unchanged" | "regressed" | "no-baseline";
	exception: { reason: string } | null;
}

export interface SignalDeclaration {
	id: string;
	kind: "pr-exact-head" | "default-branch-full";
	status: "pending" | "captured";
	sha: string | null;
	runId: string | null;
	capturedAt: string | null;
}

/** Paths under a boundary that have moved since it, or `undefined` on abstention. */
export function changedSince(
	root: string,
	boundary: string,
	paths: string[],
): string[] | undefined {
	const output = git(root, [
		"diff",
		"--name-only",
		`${boundary}..HEAD`,
		"--",
		...paths,
	]);
	if (output === undefined) return undefined;
	return output === "" ? [] : output.split("\n").filter(Boolean).sort();
}

/**
 * The acceptance table, with the split computed and never declared.
 *
 * And the inherited list is printed on SUCCESS, because "the release gate is
 * green" must never be readable as "everything was re-measured at this head".
 */
export async function validateAcceptance(
	root: string,
	registry: ReleaseRegistry,
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const declared = new Set(registry.acceptance.map((entry) => entry.id));
	for (const item of ACCEPTANCE_ITEMS) {
		if (!declared.has(item))
			errors.push(
				`release: ${REGISTRY_PATH} declares no acceptance record for ${item}; the full-fixture scenario names ten and a missing one is a signal nobody produced`,
			);
	}
	for (const entry of registry.acceptance) {
		if (!(ACCEPTANCE_ITEMS as readonly string[]).includes(entry.id))
			errors.push(
				`release: ${REGISTRY_PATH} declares the acceptance item ${entry.id}, which the requirement does not name`,
			);
		if (entry.ownedPaths.length === 0) {
			errors.push(
				`release: the ${entry.id} acceptance record owns no path, so nothing could ever falsify its inheritance`,
			);
			continue;
		}
		for (const path of entry.ownedPaths) {
			if (!exists(resolve(root, path)))
				errors.push(
					`release: the ${entry.id} acceptance record owns ${path}, which does not exist`,
				);
		}
		if (!exists(resolve(root, entry.evidenceRecord)))
			errors.push(
				`release: the ${entry.id} acceptance record names ${entry.evidenceRecord}, which does not exist`,
			);
		const kind = git(root, ["cat-file", "-t", entry.boundarySha]);
		if (kind !== "commit") {
			errors.push(
				`release: the ${entry.id} acceptance record pins the boundary ${entry.boundarySha}, which is not a commit in this repository`,
			);
			continue;
		}
		const changed = changedSince(root, entry.boundarySha, entry.ownedPaths);
		if (changed === undefined) {
			// An abstention is not a pass. A guard that cannot run the diff has not
			// established that the inherited claim still holds.
			notices.push(
				`release: the inheritance diff for ${entry.id} could not run, so its mode was asserted against nothing`,
			);
			continue;
		}
		if (changed.length > 0 && entry.mode !== "live")
			errors.push(
				`release: the ${entry.id} acceptance record claims an inherited result, but ${changed.length} of its owned paths have moved since ${entry.boundarySha}, first ${changed[0]}; an inherited claim is legal only while the paths that produced it are byte-unchanged`,
			);
		if (changed.length === 0 && entry.mode !== "inherited")
			errors.push(
				`release: the ${entry.id} acceptance record claims a live result, and none of its owned paths has moved since ${entry.boundarySha}; the mode is a consequence of the diff rather than a choice`,
			);
		if (entry.mode === "live" && (entry.liveCommand ?? "") === "")
			errors.push(
				`release: the ${entry.id} acceptance record is live and names no command, so nothing says what was re-measured`,
			);
		if (entry.mode === "inherited" && entry.liveCommand !== null)
			errors.push(
				`release: the ${entry.id} acceptance record is inherited and names a live command; one of the two is wrong`,
			);
		if (entry.mode === "inherited")
			notices.push(
				`release: ${entry.id} is INHERITED from ${entry.evidenceRecord} at ${entry.boundarySha}, and this run proved only that its owned paths are byte-unchanged since then`,
			);
		for (const nonDefect of entry.knownNonDefects)
			notices.push(`release: ${entry.id} expects ${nonDefect}`);
	}
	const inherited = registry.acceptance.filter(
		(entry) => entry.mode === "inherited",
	).length;
	notices.push(
		`release: ${inherited} of ${registry.acceptance.length} acceptance items are inherited rather than re-measured at this head; a green release gate is not a claim that everything was run again`,
	);
	return { errors: errors.sort(), notices: notices.sort() };
}

const UNIT_TO_CANONICAL: Record<BudgetSide["unit"], number> = {
	seconds: 1,
	milliseconds: 0.001,
	bytes: 1,
};

function pointerValue(value: unknown, pointer: string): unknown {
	let current = value;
	for (const segment of pointer.split(".")) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

/**
 * The budget table, and the honest answer to five measurements that were never
 * taken.
 *
 * Five of Stage 0's ten families are recorded `"unavailable"` — no isolated
 * worktree completed its lifecycle, so there is no readiness time and no valid
 * warm-command baseline. Two of the four families the requirement names are
 * among them. The requirement's own escape hatch is "unless an explicit
 * reviewed budget exception explains the trade-off", so those two carry the
 * verdict `no-baseline` and an exception whose reason must QUOTE the Stage 0
 * record's own words — the guard reads the record and checks the quotation, so
 * the exception cannot drift away from the fact that justifies it.
 *
 * The alternative was comparing this head's warm-command latency against
 * `failedLifecycleExecLatency`, a number Stage 0 itself labels as belonging to
 * a container that FAILED its lifecycle. That comparison would produce a
 * spectacular apparent improvement and mean nothing.
 */
export async function validateBudgets(
	root: string,
	registry: ReleaseRegistry,
): Promise<ReleaseReport> {
	const errors: string[] = [];
	const notices: string[] = [];
	const families = new Set(registry.budgets.map((entry) => entry.specFamily));
	for (const family of BUDGET_FAMILIES) {
		if (!families.has(family))
			errors.push(
				`release: ${REGISTRY_PATH} declares no budget for ${family}, which the requirement names by name`,
			);
	}
	if (registry.budgets.length === 0) {
		errors.push(
			"release: the budget table is empty; a comparison over nothing is a pass nobody earned",
		);
		return { errors, notices };
	}
	const records_ = new Map<string, unknown>();
	const load = async (path: string): Promise<unknown> => {
		if (!records_.has(path)) {
			try {
				records_.set(path, JSON.parse(textOf(resolve(root, path))) as unknown);
			} catch {
				records_.set(path, undefined);
			}
		}
		return records_.get(path);
	};
	for (const entry of registry.budgets) {
		const check = async (side: BudgetSide, label: string): Promise<void> => {
			const record = await load(side.record);
			if (record === undefined) {
				errors.push(
					`release: the ${entry.id} budget names ${side.record} as its ${label} record, which did not parse`,
				);
				return;
			}
			const found = pointerValue(record, side.pointer);
			if (found !== side.value)
				errors.push(
					`release: the ${entry.id} budget declares a ${label} of ${side.value} at ${side.record}#${side.pointer}, which carries ${JSON.stringify(found)}; a pin nothing compares is decoration`,
				);
			const canonical = side.value * UNIT_TO_CANONICAL[side.unit];
			if (Math.abs(canonical - side.normalized) > 1e-6)
				errors.push(
					`release: the ${entry.id} budget normalizes its ${label} to ${side.normalized}, and ${side.value} ${side.unit} is ${canonical}`,
				);
		};
		if (entry.baselineStatus === "measured") {
			if (!entry.baseline || !entry.final) {
				errors.push(
					`release: the ${entry.id} budget declares a measured baseline and omits one of its two sides`,
				);
				continue;
			}
			await check(entry.baseline, "baseline");
			await check(entry.final, "final");
			const delta = entry.final.normalized - entry.baseline.normalized;
			if (entry.delta === null || Math.abs(delta - entry.delta) > 1e-6)
				errors.push(
					`release: the ${entry.id} budget declares a delta of ${entry.delta} and its two sides differ by ${delta}`,
				);
			const verdict =
				delta < 0 ? "improved" : delta > 0 ? "regressed" : "unchanged";
			if (entry.verdict !== verdict)
				errors.push(
					`release: the ${entry.id} budget declares the verdict ${entry.verdict} and its measurements say ${verdict}`,
				);
			if (verdict === "regressed" && (entry.exception?.reason ?? "") === "")
				errors.push(
					`release: the ${entry.id} budget regressed and carries no reviewed exception; release is blocked until the regression is corrected or an exception is approved`,
				);
			if (verdict !== "regressed" && entry.exception !== null)
				errors.push(
					`release: the ${entry.id} budget did not regress and carries an exception; an exemption with nothing to exempt widens itself`,
				);
			notices.push(
				`release: ${entry.id} moved from ${entry.baseline.normalized} to ${entry.final.normalized} and is ${verdict}`,
			);
			continue;
		}
		// An unavailable baseline. The verdict is `no-baseline`, the reason has to
		// quote the record that says why, and this head's measurement — when there
		// is one — becomes the FIRST baseline rather than a comparison.
		if (entry.verdict !== "no-baseline")
			errors.push(
				`release: the ${entry.id} budget has no Stage 0 baseline and declares the verdict ${entry.verdict}; there is nothing to compare against`,
			);
		if (entry.baseline !== null || entry.delta !== null)
			errors.push(
				`release: the ${entry.id} budget has no Stage 0 baseline and declares one anyway`,
			);
		const reason = entry.exception?.reason ?? "";
		if (reason === "") {
			errors.push(
				`release: the ${entry.id} budget has no baseline and no documented exception; an unmeasured family is a gap somebody has to accept in writing`,
			);
			continue;
		}
		const baselineRecord = await load(BASELINE_RECORD);
		const recorded = pointerValue(
			baselineRecord,
			`measurements.${entry.baselineMeasurement}.reason`,
		);
		if (typeof recorded !== "string")
			errors.push(
				`release: the ${entry.id} budget names the Stage 0 measurement ${entry.baselineMeasurement}, which records no reason`,
			);
		else if (!reason.includes(recorded))
			errors.push(
				`release: the ${entry.id} budget's exception does not quote the Stage 0 record, which says: ${recorded}`,
			);
		else
			notices.push(
				`release: ${entry.id} has NO Stage 0 baseline and is recorded as no-baseline rather than compared; the first measurement taken at this head becomes the baseline`,
			);
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * The two required signals, DECLARED and never queried.
 *
 * A fine-grained token cannot read the Checks API — `commits/{sha}/check-runs`
 * answers 403 and there is no grantable toggle — so a guard that asked GitHub
 * whether a commit was green would abstain in exactly the environment it was
 * written for. The run ids come from the human who watched them go green, the
 * shas are checked against local Git objects, and a signal that has not been
 * captured yet says `pending` rather than pretending.
 *
 * The exact-head rule has TWO anchors and the decision is what selects between
 * them. While the tree is a `candidate` the anchor is `HEAD`: the tree under
 * review must be the tree the green run belongs to, which is the whole of
 * "release only from exact green head". Once the tree is `released` that anchor
 * is unreachable rather than strict — the flip is a commit, a commit moves
 * `HEAD`, and no commit can carry its own object id — so a released tree that
 * still anchored on `HEAD` would be a state machine with no legal terminal
 * state, refusing `candidate` because the tag exists and `released` because the
 * head moved. The released anchor is therefore the tag itself: the reviewed
 * head must be a commit the release CONTAINS. That is checkable against local
 * Git objects like everything else here, it is what the runbook actually did —
 * tag the merge commit whose second parent is the reviewed head — and it is a
 * narrower claim than "some commit in this repository", not a wider one.
 */
export function validateSignals(
	root: string,
	registry: ReleaseRegistry,
): ReleaseReport {
	const errors: string[] = [];
	const notices: string[] = [];
	for (const kind of ["pr-exact-head", "default-branch-full"] as const) {
		if (!registry.signals.some((entry) => entry.kind === kind))
			errors.push(
				`release: ${REGISTRY_PATH} declares no ${kind} signal, and the requirement names both`,
			);
	}
	const head = git(root, ["rev-parse", "HEAD"]);
	for (const entry of registry.signals) {
		if (entry.status === "pending") {
			if (
				entry.sha !== null ||
				entry.runId !== null ||
				entry.capturedAt !== null
			)
				errors.push(
					`release: the ${entry.id} signal is pending and carries a sha, a run id or a capture time; a pending signal records nothing`,
				);
			if (registry.decision === "released")
				errors.push(
					`release: ${REGISTRY_PATH} declares the released decision while the ${entry.id} signal is still pending`,
				);
			notices.push(
				`release: the ${entry.id} signal is PENDING; it is a post-merge artefact and the runbook is what fills it in`,
			);
			continue;
		}
		if (
			entry.sha === null ||
			entry.runId === null ||
			entry.capturedAt === null
		) {
			errors.push(
				`release: the ${entry.id} signal is captured and omits its sha, its run id or its capture time`,
			);
			continue;
		}
		if (git(root, ["cat-file", "-t", entry.sha]) !== "commit")
			errors.push(
				`release: the ${entry.id} signal names ${entry.sha}, which is not a commit in this repository`,
			);
		else if (entry.kind === "pr-exact-head") {
			if (registry.decision === "released") {
				const tag = registry.release.plannedTag;
				const contained = Bun.spawnSync([
					"git",
					"-C",
					root,
					"merge-base",
					"--is-ancestor",
					entry.sha,
					tag,
				]);
				if (contained.exitCode !== 0)
					errors.push(
						`release: the ${entry.id} signal belongs to ${entry.sha}, which ${tag} does not contain; a release cut from a commit its own green run does not cover is not an exact-head release`,
					);
			} else if (head !== undefined && entry.sha !== head)
				errors.push(
					`release: the ${entry.id} signal belongs to ${entry.sha} and HEAD is ${head}; a green run for a different commit is not an exact-head signal`,
				);
		}
		notices.push(
			`release: the ${entry.id} signal is captured at ${entry.sha} as run ${entry.runId}, asserted against local Git objects and never against a Checks API this guard may not read`,
		);
	}
	return { errors: errors.sort(), notices: notices.sort() };
}

/**
 * The capability inventory, reconciled and then ASSERTED.
 *
 * Six stages recorded that `alwaysEmittedPartial` still lists `"moon"`, a name
 * that has not been a capability since PR #21, and every one of them left it
 * for the same honest reason: nothing validated the block. This is the stage
 * where "nothing validates it" stops being a reason and becomes the defect —
 * the release gate is the thing that reads ownership metadata for a living, and
 * an inventory wrong by six entries is the definition of an unfinalized one.
 *
 * The assertion is set equality against the parameter file's supported list,
 * with no name in two buckets. That is what stops it going stale again.
 */
export async function validateCapabilityInventory(
	root: string,
): Promise<string[]> {
	const errors: string[] = [];
	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (!exists(ownershipPath)) return errors;
	const ownership = (await Bun.file(ownershipPath).json()) as JsonRecord;
	const inventory = isRecord(ownership["capabilityInventory"])
		? ownership["capabilityInventory"]
		: undefined;
	if (!inventory) {
		errors.push(
			`release: ${OWNERSHIP_PATH} declares no capabilityInventory at all`,
		);
		return errors;
	}
	const parameters = await loadTemplateParameters(root);
	const supported = new Set(Object.keys(parameters.capabilities.supported));
	const seen = new Map<string, string>();
	for (const bucket of ["alwaysEmittedPartial", "advertisedOnly", "absent"]) {
		for (const name of strings(inventory[bucket])) {
			const first = seen.get(name);
			if (first !== undefined)
				errors.push(
					`release: capabilityInventory lists ${name} in both ${first} and ${bucket}; a capability is in one bucket or the inventory means nothing`,
				);
			else seen.set(name, bucket);
			if (!supported.has(name))
				errors.push(
					`release: capabilityInventory lists ${name} in ${bucket}, and template-parameters.toml supports no such capability`,
				);
		}
	}
	for (const name of [...supported].sort()) {
		if (!seen.has(name))
			errors.push(
				`release: capabilityInventory places ${name} in no bucket, so the inventory describes fewer capabilities than the template has`,
			);
	}
	return errors.sort();
}

/**
 * The version authorities, whose `currentRisk` strings were all false.
 *
 * Five of the six described the PRE-migration template — "latest, ranges, and
 * catalog bypasses coexist", "floating major tags and Node lts; lock absent",
 * "mutable base/latest downloads and missing checksums" — and every one of them
 * was resolved by Stages 1 through 3 and 7. `template-ownership.json` is a live
 * registry rather than sealed evidence; five stages have edited it. A file the
 * release gate reads, carrying false present-tense claims, is precisely what
 * "finalize" means here. So the field becomes `historicalRisk`, each entry
 * gains the stage that resolved it and a present-tense `authorityRule`, and the
 * guard refuses the old field name outright.
 */
export async function validateVersionAuthorities(
	root: string,
): Promise<string[]> {
	const errors: string[] = [];
	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (!exists(ownershipPath)) return errors;
	const ownership = (await Bun.file(ownershipPath).json()) as JsonRecord;
	const authorities = records(ownership["versionAuthorities"]);
	if (authorities.length === 0) {
		errors.push(
			`release: ${OWNERSHIP_PATH} declares no version authority at all`,
		);
		return errors;
	}
	for (const entry of authorities) {
		const domain = typeof entry["domain"] === "string" ? entry["domain"] : "?";
		if (entry["currentRisk"] !== undefined)
			errors.push(
				`release: the ${domain} version authority still carries currentRisk, a present-tense claim about a template that no longer exists; record it as historicalRisk with the stage that resolved it`,
			);
		for (const field of ["historicalRisk", "resolvedBy", "authorityRule"]) {
			if (typeof entry[field] !== "string" || entry[field] === "")
				errors.push(
					`release: the ${domain} version authority declares no ${field}`,
				);
		}
		const authority = entry["authority"];
		if (typeof authority === "string") {
			for (const path of authority.split(" and ")) {
				if (path.includes("*") || path.includes("$")) continue;
				if (!exists(resolve(root, path)))
					errors.push(
						`release: the ${domain} version authority names ${path}, which does not exist`,
					);
			}
		}
	}
	return errors.sort();
}

/**
 * Every guard a render receives is described by a section of that render's
 * AGENTS.md, and the release gate is described by none of them.
 *
 * "Finalize canonical agent rules" is discharged as a COMPLETENESS assertion
 * over the sections that already exist rather than as a new section, and the
 * reason is mechanical rather than stylistic: `stripTemplateOnlyBlocks` matches
 * a `#`-comment form, and in markdown `# template-only:start release` renders
 * as an H1. Template-only blocks do not work in markdown. A `## Release
 * Ownership` section would therefore ship into every render, describing a guard
 * that is not there — an agent instruction for a capability the project does
 * not have, which is the thing the capability model forbids.
 *
 * So the rule is the mapping instead, and it has a live subject. Fifteen
 * `*:check` scripts exist; fourteen `## … Ownership` sections describe them and
 * `rules:check` is described by `## Canonical Agent Rules`, so the mapping is
 * not derivable from the names and has to be declared. The guard asserts the
 * declaration covers every script, that every named section exists, and — the
 * half that matters — that for each render, every `*:check` script that
 * SURVIVED into it has a section that survived with it. The release gate's own
 * script is exempt by construction, because the `template:` prefix keeps it out
 * of every render: the assertion proves this stage's central decision from the
 * other side.
 */
export function validateAgentSections(
	registry: ReleaseRegistry,
	manifestScripts: string[],
	agentRules: string,
	label: string,
): ReleaseReport {
	const errors: string[] = [];
	const notices: string[] = [];
	const declared = new Map(
		registry.agentRuleSections.map((entry) => [entry.script, entry.section]),
	);
	const checks = manifestScripts.filter((script) => script.endsWith(":check"));
	if (checks.length === 0)
		errors.push(
			`release: ${label} declares no ${"*"}:check script at all, so the ownership mapping compared nothing`,
		);
	for (const script of checks) {
		const section = declared.get(script);
		if (section === undefined) {
			errors.push(
				`release: ${label} runs ${script} and ${REGISTRY_PATH} maps it to no AGENTS.md section; a guard nothing documents is one nobody can be told about`,
			);
			continue;
		}
		if (!agentRules.includes(section))
			errors.push(
				`release: ${label} keeps ${script} and its AGENTS.md section ${section} did not survive with it`,
			);
	}
	for (const [script, section] of declared) {
		if (script === GUARD_SCRIPT || script === SYNC_SCRIPT) {
			errors.push(
				`release: ${REGISTRY_PATH} maps ${script} to the AGENTS.md section ${section}; this surface is template-only and appears in no render, so a section describing it would ship where the guard does not`,
			);
		}
	}
	notices.push(
		`release: ${checks.length} ${"*"}:check scripts survive into ${label} and each is described by a section of its AGENTS.md`,
	);
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

	const topLevel = validateTopLevelWorkspaces(registry, files);
	errors.push(...topLevel.errors);
	notices.push(...topLevel.notices);

	const syncBoundary = await validateSyncBoundary(root, registry);
	errors.push(...syncBoundary.errors);
	notices.push(...syncBoundary.notices);

	const deferrals = await validateDeferrals(root, registry);
	errors.push(...deferrals.errors);
	notices.push(...deferrals.notices);

	errors.push(...(await validateCapabilityInventory(root)));
	errors.push(...(await validateVersionAuthorities(root)));

	const acceptance = await validateAcceptance(root, registry);
	errors.push(...acceptance.errors);
	notices.push(...acceptance.notices);

	const budgets = await validateBudgets(root, registry);
	errors.push(...budgets.errors);
	notices.push(...budgets.notices);

	const signals = validateSignals(root, registry);
	errors.push(...signals.errors);
	notices.push(...signals.notices);

	if (options.renders === false) {
		const goldens = await validateGoldens(root, registry, { render: false });
		errors.push(...goldens.errors);
		notices.push(...goldens.notices);
		notices.push(
			"release: the six scan families did not run; they read the rendered trees and this caller asked for the hermetic legs only",
		);
		return {
			errors: [...new Set(errors)].sort(),
			notices: [...new Set(notices)].sort(),
		};
	}

	// One render, two consumers. The goldens compare it and the scans read it,
	// and rendering three fixtures twice in one command buys nothing.
	const output = await mkdtemp(resolve(tmpdir(), "devenv-release-"));
	try {
		const { renders, errors: renderErrors } = await renderAllFixtures(
			root,
			registry.goldens.fixtures.map((entry) => entry.fixture),
			output,
		);
		errors.push(...renderErrors);
		const goldens = await validateGoldens(root, registry, { renders });
		errors.push(...goldens.errors);
		notices.push(...goldens.notices);
		const scans = await validateScans(root, registry, renders, files);
		errors.push(...scans.errors);
		notices.push(...scans.notices);
	} finally {
		await rm(output, { recursive: true, force: true });
	}

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
