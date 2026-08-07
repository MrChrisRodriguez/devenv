// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML and JSON are strict records.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

type JsonRecord = Record<string, unknown>;

const OPENSPEC_DIRECTORY = "openspec";
const CONFIG_FILE = "config.yaml";
const CHANGES_DIRECTORY = "changes";
const ARCHIVE_DIRECTORY = "archive";
const SPECS_DIRECTORY = "specs";
const SPEC_FILE = "spec.md";

// Every artifact a change must carry, restated here rather than delegated. An
// ENUMERATION has to stand on its own: `validate --all` exits 0 over an empty
// set, so a guard that only asked the CLI would report success for a change
// directory somebody had emptied.
const CHANGE_REQUIRED_FILES = [".openspec.yaml", "proposal.md", "tasks.md"];

// Directories the root walk never descends into. `tmp/` is where
// `template:fixtures` renders, and a rendered fixture carries its own
// `openspec/config.yaml` — walking into it would invent a phantom root that no
// commit owns and that `git ls-files` has never heard of.
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"tmp",
	"graphify-out",
	"dist",
]);

// `<YYYY>-<MM>-<DD>-<change-name>`, the shape `openspec archive` writes. The
// date is captured in three groups rather than one blob so the guard can reject
// a value that looks like a date and is not one.
const ARCHIVE_ENTRY = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;

const ADDED_SECTION = /^##\s+ADDED\s+Requirements\s*$/i;
const SECTION_HEADING = /^##\s+/;
const REQUIREMENT_HEADING = /^###\s+Requirement:\s*(.+?)\s*$/;

const COMPLETE_TASK = /^\s*-\s*\[x\]\s/i;
const INCOMPLETE_TASK = /^\s*-\s*\[\s\]\s/;

export const ARCHIVE_WRAPPER = "scripts/openspec/archive.sh";
export const GUARD_SCRIPT = "openspec:check";
export const GUARD_CONTRACT = "scripts/template/openspec-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-openspec.ts";

export interface OpenspecChange {
	name: string;
	directory: string;
	missingFiles: string[];
	totalTasks: number;
	completeTasks: number;
	remainingTasks: number;
	deltaCapabilities: string[];
}

export interface OpenspecArchivedChange {
	entry: string;
	directory: string;
	date: string;
	name: string;
	deltaCapabilities: string[];
}

export interface OpenspecRoot {
	/** Repository-relative path of the `openspec` directory itself. */
	directory: string;
	/** Repository-relative directory the CLI must be invoked from. */
	workingDirectory: string;
	/** Repository-relative path of the initialization marker. */
	config: string;
	tracked: boolean;
	changes: OpenspecChange[];
	archived: OpenspecArchivedChange[];
	specs: string[];
}

export interface OpenspecInspection {
	roots: OpenspecRoot[];
	errors: string[];
	notices: string[];
	gitTracked: boolean;
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

function subdirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function entryNames(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

function textOf(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function posixPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function trackedFiles(root: string): Set<string> | undefined {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return new Set(result.stdout.toString().split("\0").filter(Boolean));
}

function deltaCapabilities(changeDirectory: string): string[] {
	const specsDirectory = join(changeDirectory, SPECS_DIRECTORY);
	return subdirectories(specsDirectory).filter((capability) =>
		exists(join(specsDirectory, capability, SPEC_FILE)),
	);
}

function taskCounts(path: string): { total: number; complete: number } {
	let total = 0;
	let complete = 0;
	for (const line of textOf(path).split("\n")) {
		if (COMPLETE_TASK.test(line)) {
			total += 1;
			complete += 1;
		} else if (INCOMPLETE_TASK.test(line)) {
			total += 1;
		}
	}
	return { total, complete };
}

function readRoot(root: string, directory: string): OpenspecRoot {
	const changesDirectory = join(directory, CHANGES_DIRECTORY);
	const specsDirectory = join(directory, SPECS_DIRECTORY);
	const changes: OpenspecChange[] = [];
	for (const name of subdirectories(changesDirectory)) {
		if (name === ARCHIVE_DIRECTORY) continue;
		const changeDirectory = join(changesDirectory, name);
		const tasks = taskCounts(join(changeDirectory, "tasks.md"));
		changes.push({
			name,
			directory: posixPath(root, changeDirectory),
			missingFiles: CHANGE_REQUIRED_FILES.filter(
				(file) => !exists(join(changeDirectory, file)),
			),
			totalTasks: tasks.total,
			completeTasks: tasks.complete,
			remainingTasks: tasks.total - tasks.complete,
			deltaCapabilities: deltaCapabilities(changeDirectory),
		});
	}
	const archived: OpenspecArchivedChange[] = [];
	const archiveDirectory = join(changesDirectory, ARCHIVE_DIRECTORY);
	for (const entry of subdirectories(archiveDirectory)) {
		const match = ARCHIVE_ENTRY.exec(entry);
		const entryDirectory = join(archiveDirectory, entry);
		archived.push({
			entry,
			directory: posixPath(root, entryDirectory),
			date: match ? `${match[1]}-${match[2]}-${match[3]}` : "",
			name: match?.[4] ?? "",
			deltaCapabilities: deltaCapabilities(entryDirectory),
		});
	}
	const specs = subdirectories(specsDirectory).filter((capability) =>
		exists(join(specsDirectory, capability, SPEC_FILE)),
	);
	return {
		directory: posixPath(root, directory),
		workingDirectory: posixPath(root, dirname(directory)) || ".",
		config: posixPath(root, join(directory, CONFIG_FILE)),
		tracked: false,
		changes,
		archived,
		specs,
	};
}

/**
 * Every OpenSpec root in this tree, found by walking rather than by asking.
 *
 * The CLI has no root discovery at all: every command resolves against `'.'`,
 * so "multi-root" is not a question it can answer — it is something this
 * repository enumerates and then drives, one `cwd` per root. The walk is the
 * authority; the CLI is the second opinion.
 */
export function enumerateOpenspecRoots(root: string): OpenspecRoot[] {
	const found: OpenspecRoot[] = [];
	const walk = (directory: string, depth: number): void => {
		if (depth > 8) return;
		for (const name of subdirectories(directory)) {
			if (EXCLUDED_DIRECTORIES.has(name)) continue;
			const child = join(directory, name);
			if (name === OPENSPEC_DIRECTORY && exists(join(child, CONFIG_FILE))) {
				found.push(readRoot(root, child));
				continue;
			}
			walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return found.sort((left, right) =>
		left.directory.localeCompare(right.directory),
	);
}

/** Requirement names under an `## ADDED Requirements` heading of a delta spec. */
export function addedRequirements(source: string): string[] {
	const names: string[] = [];
	let inside = false;
	for (const line of source.split("\n")) {
		if (ADDED_SECTION.test(line)) {
			inside = true;
			continue;
		}
		if (inside && SECTION_HEADING.test(line)) {
			inside = false;
			continue;
		}
		if (!inside) continue;
		const match = REQUIREMENT_HEADING.exec(line);
		if (match?.[1]) names.push(match[1]);
	}
	return names;
}

/** Every `### Requirement:` name in a main spec, ADDED heading or not. */
export function declaredRequirements(source: string): string[] {
	const names: string[] = [];
	for (const line of source.split("\n")) {
		const match = REQUIREMENT_HEADING.exec(line);
		if (match?.[1]) names.push(match[1]);
	}
	return names;
}

/** The UTC archive directory name the CLI would write for `change` today. */
export function archiveEntryName(change: string, now = new Date()): string {
	return `${now.toISOString().slice(0, 10)}-${change}`;
}

export interface ArchiveAssessment {
	change: string;
	/** Repository-relative destination, computed in UTC exactly as the CLI does. */
	destination: string;
	destinationExists: boolean;
	deltaCapabilities: string[];
	/**
	 * True when the change carries no delta specs at all. `--skip-specs` is only
	 * ever correct in that case: passed with deltas present it archives the
	 * proposal and silently drops the requirements the proposal promised.
	 */
	skipSpecs: boolean;
	remainingTasks: number;
	/** ADDED requirements per capability that the main specs do not carry yet. */
	unappliedRequirements: Array<{ capability: string; requirement: string }>;
	errors: string[];
}

/**
 * Everything the wrapper must know before it may call the CLI.
 *
 * The destination pre-check is the load-bearing half. `ArchiveCommand` applies
 * the delta specs to `openspec/specs/**` BEFORE it looks at whether
 * `archive/<date>-<name>` already exists, and it RETURNS 0 when it does — so a
 * second run leaves the main specs rewritten, the change still active, and an
 * exit status that says everything went fine.
 */
export function assessArchive(
	root: string,
	rootDirectory: string,
	change: string,
	now = new Date(),
): ArchiveAssessment {
	const errors: string[] = [];
	const openspecDirectory = resolve(root, rootDirectory);
	const changeDirectory = join(openspecDirectory, CHANGES_DIRECTORY, change);
	const destination = posixPath(
		root,
		join(
			openspecDirectory,
			CHANGES_DIRECTORY,
			ARCHIVE_DIRECTORY,
			archiveEntryName(change, now),
		),
	);
	if (!isDirectory(changeDirectory)) {
		errors.push(
			`openspec: ${change} is not an active change in ${rootDirectory}`,
		);
	}
	const capabilities = deltaCapabilities(changeDirectory);
	const tasks = taskCounts(join(changeDirectory, "tasks.md"));
	const unapplied: ArchiveAssessment["unappliedRequirements"] = [];
	for (const capability of capabilities) {
		const delta = textOf(
			join(changeDirectory, SPECS_DIRECTORY, capability, SPEC_FILE),
		);
		const main = textOf(
			join(openspecDirectory, SPECS_DIRECTORY, capability, SPEC_FILE),
		);
		const declared = new Set(declaredRequirements(main));
		for (const requirement of addedRequirements(delta)) {
			if (!declared.has(requirement))
				unapplied.push({ capability, requirement });
		}
	}
	return {
		change,
		destination,
		destinationExists: exists(resolve(root, destination)),
		deltaCapabilities: capabilities,
		skipSpecs: capabilities.length === 0,
		remainingTasks: tasks.total - tasks.complete,
		unappliedRequirements: unapplied,
		errors,
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYaml(source: string): JsonRecord | undefined {
	try {
		const value = Bun.YAML.parse(source) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function usableArchiveDate(entry: OpenspecArchivedChange, now: Date): boolean {
	const parsed = new Date(`${entry.date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return false;
	if (parsed.toISOString().slice(0, 10) !== entry.date) return false;
	// Compared in UTC on both sides. The CLI stamps `new Date().toISOString()`,
	// so a local-time comparison would call a perfectly ordinary archive "in the
	// future" for the several hours a day on which the two dates disagree.
	return entry.date <= now.toISOString().slice(0, 10);
}

/**
 * The hermetic half of the OpenSpec lifecycle contract.
 *
 * It needs no CLI, no network and no container, which is what lets it live in
 * `template:validate` and on a developer host. The live half — resolving the
 * pinned binary, driving it once per root, and reconciling its item set with
 * this enumeration — is `validate-openspec.ts`, because a guard that only asked
 * the CLI would inherit the CLI's own blind spots: `validate --all` exits 0 with
 * zero items and never looks at an archive at all.
 */
export async function inspectOpenspec(
	root: string,
	now = new Date(),
): Promise<OpenspecInspection> {
	const errors: string[] = [];
	const notices: string[] = [];
	const roots = enumerateOpenspecRoots(root);
	const tracked = trackedFiles(root);
	if (tracked) {
		for (const entry of roots) entry.tracked = tracked.has(entry.config);
	}
	if (roots.length === 0) {
		errors.push(
			"openspec: no openspec/config.yaml exists; the lifecycle guard has nothing to validate",
		);
	}
	for (const entry of roots) {
		if (parseYaml(textOf(resolve(root, entry.config))) === undefined)
			errors.push(`openspec: ${entry.config} must parse as YAML`);
		if (tracked && !entry.tracked)
			errors.push(`openspec: ${entry.config} is not tracked by git`);

		const activeNames = new Set(entry.changes.map((change) => change.name));
		for (const change of entry.changes) {
			for (const file of change.missingFiles)
				errors.push(`openspec: ${change.directory} is missing ${file}`);
			if (change.totalTasks > 0 && change.remainingTasks === 0) {
				notices.push(
					`openspec: ${change.directory} has no remaining tasks; archive it with \`bash ${ARCHIVE_WRAPPER} --change ${change.name}\``,
				);
			}
		}

		for (const archived of entry.archived) {
			if (archived.entry === ARCHIVE_DIRECTORY) {
				errors.push(
					`openspec: ${archived.directory} nests an archive inside the archive`,
				);
				continue;
			}
			if (!ARCHIVE_ENTRY.test(archived.entry)) {
				errors.push(
					`openspec: ${archived.directory} must be named <YYYY-MM-DD>-<change>`,
				);
				continue;
			}
			if (!usableArchiveDate(archived, now))
				errors.push(
					`openspec: ${archived.directory} carries the unusable archive date ${archived.date}`,
				);
			if (activeNames.has(archived.name))
				errors.push(
					`openspec: ${archived.name} is both an active change and archived at ${archived.directory}`,
				);
			if (entryNames(resolve(root, archived.directory)).length === 0)
				errors.push(
					`openspec: ${archived.directory} is an empty archive entry`,
				);
			for (const capability of archived.deltaCapabilities) {
				const delta = textOf(
					resolve(
						root,
						archived.directory,
						SPECS_DIRECTORY,
						capability,
						SPEC_FILE,
					),
				);
				const main = textOf(
					resolve(
						root,
						entry.directory,
						SPECS_DIRECTORY,
						capability,
						SPEC_FILE,
					),
				);
				const declared = new Set(declaredRequirements(main));
				for (const requirement of addedRequirements(delta)) {
					if (declared.has(requirement)) continue;
					errors.push(
						`openspec: ${archived.directory} archived the ADDED requirement "${requirement}" that never reached ${entry.directory}/${SPECS_DIRECTORY}/${capability}/${SPEC_FILE}`,
					);
				}
			}
		}
	}
	return { roots, errors, notices, gitTracked: tracked !== undefined };
}

// The step has to be unconditional inside the required lane. `openspec/**`
// classifies as documentation in the affected-selection oracle, so a lifecycle
// guard living in a job a selection can narrow would be skipped by exactly the
// pull requests that change a change.
async function validateWorkflowPolicy(root: string): Promise<string[]> {
	const errors: string[] = [];
	const path = resolve(root, ".github/workflows/ci.yml");
	if (!(await Bun.file(path).exists())) return errors;
	const workflow = parseYaml(textOf(path));
	const jobs = workflow?.["jobs"];
	if (!isRecord(jobs)) return errors;
	const job = jobs["ci"];
	if (!isRecord(job)) return errors;
	const steps = Array.isArray(job["steps"]) ? job["steps"] : [];
	const step = steps
		.filter(isRecord)
		.find(
			(candidate) =>
				typeof candidate["run"] === "string" &&
				candidate["run"].includes(`bun run ${GUARD_SCRIPT}`),
		);
	if (!step) {
		errors.push(
			`openspec: the ci job must run \`bun run ${GUARD_SCRIPT}\` in the required lane`,
		);
		return errors;
	}
	if (step["if"] !== undefined)
		errors.push(
			`openspec: the \`bun run ${GUARD_SCRIPT}\` step must not be conditional`,
		);
	return errors;
}

async function validateWiring(root: string): Promise<string[]> {
	const errors: string[] = [];
	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
		if (!(await Bun.file(resolve(root, path)).exists()))
			errors.push(`openspec: ${path} is missing`);
	}
	const manifest = resolve(root, "package.json");
	if (await Bun.file(manifest).exists()) {
		const value = (await Bun.file(manifest).json()) as JsonRecord;
		const scripts = isRecord(value["scripts"]) ? value["scripts"] : {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`openspec: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
	}
	return errors;
}

/**
 * The whole hermetic contract, in the shape `validate.ts` aggregates.
 *
 * Completion notices are deliberately NOT errors and never reach this list. A
 * change whose tasks are all done is the expected, correct state between the
 * last implementation commit and the archive commit; failing on it would make
 * the guard red for the one window in which everything is right.
 */
export async function validateOpenspecContract(
	root = resolve(import.meta.dir, "../.."),
	now = new Date(),
): Promise<string[]> {
	const inspection = await inspectOpenspec(root, now);
	return [
		...inspection.errors,
		...(await validateWorkflowPolicy(root)),
		...(await validateWiring(root)),
	].sort();
}
