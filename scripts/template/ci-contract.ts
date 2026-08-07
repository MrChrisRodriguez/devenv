// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML and JSON are strict records.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: The guard matches runner expressions verbatim.
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const WORKFLOW_DIRECTORY = ".github/workflows";
const ACTION_DIRECTORY = ".github/actions";
const AUTOMATION_ROOT = ".github";
const PARAMETER_PATH = "template-parameters.toml";
const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";
const SYNC_SCRIPT = "scripts/sync-devcontainer.sh";
const HELPER_DIRECTORY = "scripts/ci";
const GATE_SCRIPT = "scripts/ci/aggregate-gate.sh";
const GUARD_CONTRACT = "scripts/template/ci-contract.ts";
const GUARD_ENTRYPOINT = "scripts/template/validate-ci.ts";
const GUARD_SCRIPT = "ci:check";

// The job id of the one required status check, used when this tree carries no
// template-parameters.toml to declare it — which is every rendered project.
// The recorded branch-protection CONTEXT is not this id: it is the `name:` of
// that job, read below, because branch protection matches display names.
export const DEFAULT_AGGREGATE_GATE_NAME = "ci-gate";

// The third-party action that installs Bun, and the complete set of inputs it
// declares. GitHub Actions silently ignores an input an action does not declare,
// so a `cache:` here would look like caching and cache nothing, forever — which
// is why the allowlist is the whole list rather than a deny list.
const SETUP_ACTION = "oven-sh/setup-bun";
const SETUP_ACTION_INPUTS = [
	"bun-version",
	"bun-version-file",
	"bun-download-url",
	"registries",
	"registry-url",
	"scope",
	"no-cache",
	"token",
] as const;

// The moon toolchain, and the one job allowed to need it. `setup-moon` wraps the
// third-party installer for the same reason `setup-bun` wraps its own: one owner
// of "how a job gets this toolchain", verified against .prototools at runtime.
const MOON_SETUP_ACTION = "moonrepo/setup-toolchain";
const MOON_ACTION_DIRECTORY = `${ACTION_DIRECTORY}/setup-moon`;
const MOON_ACTION = `${MOON_ACTION_DIRECTORY}/action.yml`;
const GRAPH_JOB = "moon-graph";

// The job that decides which entries the heavy lane's matrix has, and the job
// ids that must never read it.
//
// Only the ID is named here, never the capability or the mode variable: this
// file is copied into EVERY rendered project, and the anti-residue scan is a
// plain substring search for a disabled capability's signature tokens over
// every file of that render. A job id is not a signature token; the mode
// variable is, which is why every mode-aware rule lives in the gated
// affected-contract module instead.
const SELECTOR_JOB = "affected";

// A selection decides what is CHECKED. A job that ships, tags or promotes
// something must run against the whole tree, because "this pull request did not
// touch that project" is a statement about a diff and not about a release. The
// rule is a negative requirement: no such job exists here today, and it is
// encoded so that adding one wired to the selector is rejected rather than
// reviewed.
const DELIVERY_JOB = /deploy|release|publish|promote/;

// The job that carries the contract guards — the checks whose cost is fixed
// rather than scaling with the project graph. Only the ID is named here, never
// any guard's script name: this file is copied into EVERY rendered project, and
// a capability's script name is a signature token that a project which disabled
// the capability would fail on. Which guards the job runs is each capability's
// own business; that it runs them, and that nothing ships without it, is this
// file's.
const CONTRACT_JOB = "ci";

const NEEDS_OUTPUT = /needs\.([A-Za-z0-9_-]+)\.outputs\./g;
const FROM_JSON = /fromJSON\s*\(/g;

// Jobs that are allowed to claim ownership of repository history. `fetch-depth`
// is cheap to add and expensive to reason about: a second job that deepens its
// clone means two jobs now depend on ancestry and neither says why. Every entry
// carries the reason, and a job outside this list may not set the key at all.
const HISTORY_OWNERS = [
	{
		workflow: ".github/workflows/ci.yml",
		job: "ci",
		reason:
			"template:validate re-checks sealed ancestry with git merge-base --is-ancestor",
	},
	{
		workflow: ".github/workflows/ci.yml",
		job: "affected",
		reason:
			"the affected diff needs the pull request's true merge base, which a shallow clone cannot resolve",
	},
	{
		workflow: ".github/workflows/ci.yml",
		job: "project",
		reason:
			"the suite this job runs re-checks sealed evidence ancestry with git merge-base --is-ancestor and builds synthetic merges, neither of which a shallow clone can answer",
	},
] as const;

// Steps that may fail without failing their job. The list is empty and is meant
// to stay empty: a step allowed to fail is a step nobody reads, and it reports
// green for every regression the project will ever have rather than only for the
// case somebody added the flag for. An entry has to carry a written reason.
const TOLERATED_FAILURES: ReadonlyArray<{
	workflow: string;
	job: string;
	reason: string;
}> = [];

// Package runtimes this repository does not own. `bunx` is deliberately absent:
// it is Bun's own runner and installs nothing a second time.
const FOREIGN_RUNTIMES = [
	/(?:^|[;&|(\s])(?:npm|npx|pnpm|yarn)(?:\s|$)/,
	/(?:^|[;&|(\s])corepack(?:\s|$)/,
] as const;

// Remote build execution reaches a workflow through the environment, so the scan
// is over every file under .github rather than over a job's `env:` block alone.
const REMOTE_EXECUTION = /MOON_REMOTE_[A-Z0-9_]*/;

// The runner variable a job's outputs are written through, assembled at
// runtime so this file is not itself a match for the scan below. A guard that
// matched its own source would need a path exemption, and a path exemption is a
// hole somebody eventually widens.
const OUTPUT_VARIABLE = ["GITHUB", "OUTPUT"].join("_");

// The credential context, and the trigger that hands it to a fork.
//
// Every rule below is a NEGATIVE requirement today: no workflow in this
// repository references the secrets context at all, and none declares the fork
// trigger. That is exactly why they are written now — a rule added alongside
// the first deployment job is a rule written by the person who wanted the job.
//
// Nothing here names a capability, a guard script or a package script. This
// file is copied into EVERY rendered project and the anti-residue scan is a
// plain substring search for a disabled capability's signature tokens.
const SECRETS_CONTEXT = /\bsecrets\./;
const SECRETS_INTERPOLATION = "${{ secrets.";
const FORK_WRITABLE_TRIGGER = "pull_request_target";

const IMMUTABLE_REFERENCE = /@[0-9a-f]{40}$/;
const RUNNER_EXPRESSION = /\$\{\{\s*(?:env|secrets|vars|needs|matrix)\./;
const BUN_CACHE_PATH = /^\s+~\/\.bun\/install\/cache\s*$/m;
const FIXED_SLEEP = /(?:^|[;&|(\s])sleep\s+[0-9]/;
const RETRY_LOOP =
	/\b(?:while|until|for)\b[\s\S]{0,200}?\b(?:retry|attempt)\b/i;
const EVENT_INTERPOLATION = "${{ github.event.";

interface Step {
	name?: string;
	uses?: string;
	if?: string;
	run?: string;
	with?: JsonRecord;
	env?: JsonRecord;
}

interface Job {
	name?: string;
	needs?: string | string[];
	if?: string;
	steps?: Step[];
	strategy?: unknown;
	env?: JsonRecord;
	"timeout-minutes"?: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function list(record: JsonRecord, key: string): string[] {
	const value = record[key];
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

async function readText(path: string): Promise<string> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : "";
}

// YAML comments describe the policy; only the uncommented lines are the policy.
// Both directions matter here: a comment explaining why there is no `branches:`
// filter must not read as one, and a comment naming another workflow must not
// read as a dependency on it.
function stripComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
}

// The renderer's capability markers, reimplemented here rather than imported:
// this guard ships to rendered projects that never receive the renderer, so a
// top-level import of it would make `ci:check` fail to load downstream instead
// of running. The syntax is the renderer's, deliberately.
function stripCapabilityBlocks(source: string): string {
	const marker = /^\s*#\s*capability:(start|end)\s+[a-z0-9_]+\s*$/;
	const output: string[] = [];
	let inside = false;
	for (const line of source.split("\n")) {
		const match = marker.exec(line);
		if (match) {
			inside = match[1] === "start";
			continue;
		}
		if (!inside) output.push(line);
	}
	return output.join("\n");
}

function parseYaml(source: string): JsonRecord | undefined {
	try {
		const value = Bun.YAML.parse(source) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function jobsOf(value: JsonRecord): Record<string, Job> {
	const jobs = value["jobs"];
	if (!isRecord(jobs)) return {};
	const found: Record<string, Job> = {};
	for (const [id, job] of Object.entries(jobs)) {
		if (isRecord(job)) found[id] = job as Job;
	}
	return found;
}

function stepsOf(job: Job): Step[] {
	return Array.isArray(job.steps)
		? job.steps.filter((step): step is Step => isRecord(step))
		: [];
}

// Whether a parsed fragment reaches for the credential context anywhere inside
// it. The whole fragment is serialised rather than walked key by key: a
// credential reaches a step through `env:`, through `with:`, through a nested
// mapping and through a list, and a rule that only knew the first spelling
// would be defeated by the second.
function referencesSecrets(value: unknown): boolean {
	return value !== undefined && SECRETS_CONTEXT.test(JSON.stringify(value));
}

function needsOf(job: Job): string[] {
	if (typeof job.needs === "string") return [job.needs];
	return Array.isArray(job.needs)
		? job.needs.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/**
 * Whether `from` waits for `target`, through any chain of `needs`.
 *
 * Transitive rather than direct on purpose: funnelling a lane through an
 * aggregate gate is the correct shape here, and a rule that demanded a direct
 * edge would push people to add a second, wrong one beside it. Visited nodes
 * are tracked so a cycle — which the runner rejects anyway — cannot hang the
 * guard that would have reported it.
 */
function dependsOn(
	jobs: Record<string, Job>,
	from: string,
	target: string,
): boolean {
	const seen = new Set<string>();
	const queue = [...needsOf(jobs[from] ?? {})];
	while (queue.length > 0) {
		const next = queue.shift();
		if (next === undefined || seen.has(next)) continue;
		seen.add(next);
		if (next === target) return true;
		queue.push(...needsOf(jobs[next] ?? {}));
	}
	return false;
}

// The `pull_request` `branches:` filter matches the pull request's BASE branch,
// so `branches: [main]` runs ZERO jobs on a stacked pull request — not a
// narrower run, no run at all — and the pull request then presents a page with
// no checks on it, which reads as "nothing to see here" rather than as "nothing
// ran". Both spellings count, in block and in flow form; a comment discussing
// the filter does not.
function hasBaseBranchFilter(block: string): boolean {
	return /(?:^|[{,\s])["']?branches(?:-ignore)?["']?\s*:/m.test(
		stripComments(block),
	);
}

// Read out of the text rather than the parse, because the question is about the
// literal `on:` block a maintainer edits: a flow mapping, a quoted key and a
// commented-out line all parse to the same tree but are three different edits.
function pullRequestBlocks(source: string): string[] {
	const lines = source.split("\n");
	const blocks: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const header = /^(\s*)pull_request:/.exec(line);
		if (!header) continue;
		const indent = (header[1] ?? "").length;
		const body = [line];
		for (let next = index + 1; next < lines.length; next += 1) {
			const candidate = lines[next] ?? "";
			if (candidate.trim() === "") {
				body.push(candidate);
				continue;
			}
			if ((/^\s*/.exec(candidate)?.[0] ?? "").length <= indent) break;
			body.push(candidate);
		}
		blocks.push(body.join("\n"));
	}
	return blocks;
}

function concurrencyBlock(source: string): string | undefined {
	return /^concurrency:\s*\n((?:^[ \t]+.*(?:\n|$))+)/m.exec(source)?.[1];
}

// Every `needs` entry has to name a job the same file declares, in the tree as
// committed AND in the tree a project without any capability would render. A
// fenced job whose fenced `needs` entry was forgotten produces a workflow that
// depends on a job that is not there; fencing the whole list produces a gate
// with no dependencies, which reports success on a run in which nothing
// happened. Exported so a render test can run it over a rendered file directly.
export function validateWorkflowGraph(
	source: string,
	path = `${WORKFLOW_DIRECTORY}/ci.yml`,
): string[] {
	const errors: string[] = [];
	const variants: Array<[string, string]> = [
		["", source],
		[" with every capability disabled", stripCapabilityBlocks(source)],
	];
	for (const [variant, text] of variants) {
		const value = parseYaml(text);
		if (!value) {
			errors.push(`ci: ${path} must parse as YAML${variant}`);
			continue;
		}
		const jobs = jobsOf(value);
		for (const [id, job] of Object.entries(jobs)) {
			const needs = needsOf(job);
			if (job.needs !== undefined && needs.length === 0)
				errors.push(
					`ci: ${path} job ${id} has no dependency left${variant || " in the file as committed"}`,
				);
			for (const need of needs) {
				if (!Object.hasOwn(jobs, need))
					errors.push(
						`ci: ${path} job ${id} needs ${need}, which the file does not declare${variant}`,
					);
			}
		}
	}
	return errors;
}

// The branch-protection context is the gate job's DISPLAY NAME, not its id.
// Exported so evidence that records "the required context" derives it from the
// committed workflow instead of restating it.
export function aggregateGateContext(
	source: string,
	gateId = DEFAULT_AGGREGATE_GATE_NAME,
): string | undefined {
	const value = parseYaml(source);
	if (!value) return undefined;
	const name = jobsOf(value)[gateId]?.name;
	return typeof name === "string" && name !== "" ? name : undefined;
}

function workflowFiles(root: string): string[] {
	try {
		return readdirSync(resolve(root, WORKFLOW_DIRECTORY))
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.sort()
			.map((name) => `${WORKFLOW_DIRECTORY}/${name}`);
	} catch {
		return [];
	}
}

function actionFiles(root: string): string[] {
	try {
		return readdirSync(resolve(root, ACTION_DIRECTORY), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => `${ACTION_DIRECTORY}/${entry.name}/action.yml`)
			.sort();
	} catch {
		return [];
	}
}

function automationFiles(root: string): string[] {
	try {
		return readdirSync(resolve(root, AUTOMATION_ROOT), { recursive: true })
			.map((entry) => String(entry))
			.map((entry) => `${AUTOMATION_ROOT}/${entry}`)
			.sort();
	} catch {
		return [];
	}
}

// A `uses:` reference is either a path into this repository — which the render
// carries or omits as a unit — or a third party, which must be frozen at a
// commit. A tag is a moving target with a friendly name: whoever can move it can
// change what every workflow in this repository executes.
function checkReference(
	path: string,
	reference: string,
	errors: string[],
): void {
	if (reference.startsWith("./")) return;
	if (reference.startsWith("docker://")) {
		errors.push(`ci: ${path} must not run a container action from a registry`);
		return;
	}
	if (!IMMUTABLE_REFERENCE.test(reference))
		errors.push(`ci: ${path} must pin ${reference} to an immutable commit`);
}

async function checkStepBodies(
	path: string,
	label: string,
	steps: Step[],
	errors: string[],
	root: string,
): Promise<void> {
	for (const step of steps) {
		const body = step.run ?? "";
		if (body !== "") {
			// A fixed sleep is a guess about somebody else's machine, and a retry
			// loop written inline cannot be executed by a test. Both belong in a
			// committed script with a bound on each attempt.
			if (FIXED_SLEEP.test(body))
				errors.push(`ci: ${path} ${label} must not sleep in a workflow body`);
			if (RETRY_LOOP.test(body))
				errors.push(`ci: ${path} ${label} must not retry in a workflow body`);
			// Event metadata is attacker-influenced text. It may reach a step as an
			// `env:` value; interpolated into a `run:` body it is spliced into the
			// script the runner executes.
			if (body.includes(EVENT_INTERPOLATION))
				errors.push(
					`ci: ${path} ${label} must not interpolate event metadata into a shell body`,
				);
			// The same reasoning, one turn sharper. Attacker-influenced text spliced
			// into a script is an injection; a CREDENTIAL spliced into one is the
			// credential written into the command the runner executes, where a
			// `set -x`, a crash dump or an error message prints it. A credential
			// reaches a step through `env:`, and only through `env:`.
			if (body.includes(SECRETS_INTERPOLATION))
				errors.push(
					`ci: ${path} ${label} must not interpolate a credential into a shell body`,
				);
			if (FOREIGN_RUNTIMES.some((pattern) => pattern.test(body)))
				errors.push(
					`ci: ${path} ${label} must not invoke a foreign package runtime`,
				);
		}

		// A credential belongs to the step that uses it. A step that receives one
		// and declares no `if:` runs on every event that reaches the job, which is
		// the spec sentence made concrete at the one layer a workflow can be
		// checked at: credential presence alone must not authorize the write.
		if (
			(referencesSecrets(step.env) || referencesSecrets(step.with)) &&
			step.if === undefined
		)
			errors.push(
				`ci: ${path} ${label} passes a credential to an unconditional step; credential presence alone must not authorize a write`,
			);

		const reference = step.uses;
		if (reference === undefined) continue;
		checkReference(path, reference, errors);
		if (/^actions\/setup-node(?:@|$)/.test(reference))
			errors.push(`ci: ${path} ${label} must not install a second runtime`);
		const supplied = isRecord(step.with) ? Object.keys(step.with) : [];
		if (reference.startsWith(`${SETUP_ACTION}@`)) {
			for (const key of supplied) {
				if (!(SETUP_ACTION_INPUTS as readonly string[]).includes(key))
					errors.push(
						`ci: ${path} passes unsupported input ${key} to ${SETUP_ACTION}`,
					);
			}
		}
		if (reference.startsWith("./")) {
			const local = resolve(root, reference.slice(2), "action.yml");
			if (!(await exists(local))) {
				errors.push(
					`ci: ${path} uses ${reference}, which is not a committed action`,
				);
				continue;
			}
			const declared = parseYaml(await readText(local));
			const inputs = isRecord(declared?.["inputs"]) ? declared["inputs"] : {};
			for (const key of supplied) {
				if (!Object.hasOwn(inputs, key))
					errors.push(
						`ci: ${path} passes unsupported input ${key} to ${reference}`,
					);
			}
		}
	}
}

// Every `include`/`exclude` entry is resolved against the directory holding the
// project file, which is what makes `./**/*.ts` in a nested project mean the
// nested subtree rather than the repository.
function matchesPattern(relativePath: string, pattern: string): boolean {
	const cleaned = pattern.replace(/^\.\//, "").replace(/\/$/, "");
	if (cleaned === "") return false;
	if (!/[*?]/.test(cleaned))
		return relativePath === cleaned || relativePath.startsWith(`${cleaned}/`);
	const segments = cleaned.split("/");
	let expression = "";
	segments.forEach((segment, index) => {
		const last = index === segments.length - 1;
		// `a/**/b` also matches `a/b`: the doubled star stands for any number of
		// intervening directories, including none.
		if (segment === "**") {
			expression += last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
			return;
		}
		expression += segment
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replaceAll("*", "[^/]*")
			.replaceAll("?", "[^/]");
		if (!last) expression += "/";
	});
	return new RegExp(`^${expression}$`).test(relativePath);
}

interface Project {
	path: string;
	directory: string;
	include: string[];
	exclude: string[];
}

function coversFile(project: Project, file: string): boolean {
	if (project.directory !== "" && !file.startsWith(`${project.directory}/`))
		return false;
	const relativePath =
		project.directory === "" ? file : file.slice(project.directory.length + 1);
	if (!project.include.some((pattern) => matchesPattern(relativePath, pattern)))
		return false;
	return !project.exclude.some((pattern) =>
		matchesPattern(relativePath, pattern),
	);
}

// Tracked files only, read through Git so the scan sees exactly what a clone
// receives. `undefined` means this tree is not a repository — a rendered fixture
// before `git init` — and the scan abstains rather than reporting a clean result
// it never established.
function trackedFiles(root: string, pattern: string): string[] | undefined {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", pattern], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\0").filter(Boolean);
}

// Every tracked file that writes a value into a job's outputs. `git grep`
// rather than a directory walk for the same reason `trackedFiles` uses Git: the
// scan has to see exactly what a clone receives. Exit 1 is "no match", exit 0
// is "these files"; anything else means this tree is not a repository and the
// scan abstains rather than reporting a clean result it never established.
// The scope is the file types a runner can EXECUTE. That is not an exemption
// list — prose cannot write a job output, so a changelog entry explaining this
// very rule is not a second selector, and narrowing to executables is what lets
// the rule stay free of per-path escapes.
const EXECUTABLE_PATHSPECS = [
	"*.sh",
	"*.bash",
	"*.ts",
	"*.tsx",
	"*.js",
	"*.mjs",
	"*.cjs",
	"*.py",
	"*.yml",
	"*.yaml",
] as const;

function outputWriters(root: string, needle: string): string[] | undefined {
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"grep",
			"-I",
			"-l",
			"-F",
			needle,
			"--",
			...EXECUTABLE_PATHSPECS,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (result.exitCode === 1) return [];
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\n").filter(Boolean).sort();
}

export async function validateCiContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const workflows = workflowFiles(root);
	// A tree with no workflows has no CI surface to guard. Every rendered project
	// receives one, so this is the "not a project yet" case rather than a hole.
	if (workflows.length === 0) return errors;

	const packageJson = (await exists(resolve(root, "package.json")))
		? ((await Bun.file(resolve(root, "package.json")).json()) as JsonRecord)
		: {};
	const scripts = isRecord(packageJson["scripts"])
		? packageJson["scripts"]
		: {};

	// The gate's job id is a template parameter in this repository and a constant
	// downstream: a rendered project carries no template-parameters.toml, so the
	// contract falls back to the same value the renderer wrote.
	let gateId = DEFAULT_AGGREGATE_GATE_NAME;
	const parameterPath = resolve(root, PARAMETER_PATH);
	const isTemplateRepository = await exists(parameterPath);
	if (isTemplateRepository) {
		try {
			const parameters = Bun.TOML.parse(
				await Bun.file(parameterPath).text(),
			) as JsonRecord;
			const declared = isRecord(parameters["ci"])
				? parameters["ci"]["aggregate_gate_name"]
				: undefined;
			if (typeof declared === "string" && declared !== "") gateId = declared;
		} catch {
			errors.push(`ci: ${PARAMETER_PATH} must parse as TOML`);
		}
	}

	const sources = new Map<string, string>();
	for (const path of workflows)
		sources.set(path, await readText(resolve(root, path)));

	for (const [path, source] of sources) {
		errors.push(...validateWorkflowGraph(source, path));
		const value = parseYaml(source);
		if (!value) continue;
		const uncommented = stripComments(source);

		// Triggers. Every lane a pull request can reach obeys the same policy,
		// gating or not: a non-gating lane that silently stops running on stacked
		// pull requests is still a lane nobody notices going quiet.
		const triggers = isRecord(value["on"]) ? value["on"] : {};
		const blocks = pullRequestBlocks(source);
		if (Object.hasOwn(triggers, "pull_request")) {
			if (blocks.length === 0)
				errors.push(`ci: ${path} pull_request trigger must be readable`);
			for (const block of blocks) {
				if (hasBaseBranchFilter(block))
					errors.push(`ci: ${path} pull_request must not filter base branches`);
				// Comment-stripped for the same reason the filter scan is: the
				// paragraph explaining why the type is listed is not the listing.
				if (!stripComments(block).includes("ready_for_review"))
					errors.push(
						`ci: ${path} pull_request types must include ready_for_review`,
					);
			}
			if (!Object.hasOwn(triggers, "workflow_dispatch"))
				errors.push(`ci: ${path} must be dispatchable for a manual re-run`);
			// Draft and ready runs belong in separate cancellation lanes. In one
			// lane the ready_for_review run cancels the draft run it supersedes, and
			// those cancelled draft jobs stay attached to the exact head commit, so
			// the head reads red after every ready-state job has passed.
			const concurrency = concurrencyBlock(source) ?? "";
			if (
				!concurrency.includes("github.ref") ||
				!concurrency.includes("github.event.pull_request.draft") ||
				!concurrency.includes("'draft' || 'ready'")
			)
				errors.push(
					`ci: ${path} must separate draft and ready cancellation lanes`,
				);
			if (!concurrency.includes("cancel-in-progress: true"))
				errors.push(`ci: ${path} must cancel superseded runs`);
		}
		// A fork-writable credential context. `pull_request_target` runs with the
		// base repository's secrets against a head the fork controls, and it is
		// read out of the uncommented text rather than out of the parse because
		// the list form and the mapping form are two different edits that produce
		// the same tree — while a comment explaining why the trigger is banned is
		// not an instance of it.
		if (uncommented.includes(FORK_WRITABLE_TRIGGER))
			errors.push(
				`ci: ${path} must not declare a ${FORK_WRITABLE_TRIGGER} trigger; a fork-writable credential context has no legitimate use in a template`,
			);
		if (!Object.hasOwn(value, "permissions"))
			errors.push(`ci: ${path} must declare least-privilege permissions`);

		// A credential belongs to the step that uses it. Declared at the workflow
		// level it is in the environment of every step of every job — including
		// the ones that run a third-party action, a build tool's plugin chain and
		// whatever those load — so the blast radius of one compromised dependency
		// becomes the whole file rather than one step.
		if (referencesSecrets(value["env"]))
			errors.push(
				`ci: ${path} must not expose a credential in a workflow-level env block`,
			);

		// Tolerance. The allowlist is consulted rather than assumed empty so that
		// adding an entry is a deliberate, reviewable act.
		for (const match of uncommented.matchAll(
			/^\s*continue-on-error:\s*(\S+)/gm,
		)) {
			if (match[1] === "false") continue;
			if (TOLERATED_FAILURES.some((entry) => entry.workflow === path)) continue;
			errors.push(`ci: ${path} must not tolerate a failing step`);
		}

		// Caching. Restoring Bun's global cache repeats the two operations that
		// make a cold install cold and evicts the caches that do pay for
		// themselves; the rationale lives in the composite action's header.
		if (BUN_CACHE_PATH.test(source))
			errors.push(`ci: ${path} must not cache an extracted dependency tree`);

		if (REMOTE_EXECUTION.test(uncommented))
			errors.push(`ci: ${path} must not configure remote build execution`);

		// The Bun authority is one-way and every hop is checkable. A workflow may
		// only relay the top-level pin; a literal here would be a second authority
		// sitting outside the version guard.
		const assignments = [
			...source.matchAll(/^[^\S\n]*bun-version:[^\S\n]*(\S.*?)[^\S\n]*$/gm),
		].flatMap((match) => (match[1] ? [match[1]] : []));
		for (const assignment of assignments) {
			if (assignment !== "${{ env.BUN_VERSION }}")
				errors.push(
					`ci: ${path} must pass bun-version through env.BUN_VERSION`,
				);
		}
		if (assignments.length > 0) {
			const environment = isRecord(value["env"]) ? value["env"] : {};
			if (typeof environment["BUN_VERSION"] !== "string")
				errors.push(`ci: ${path} must declare a top-level BUN_VERSION`);
		}

		const workflowJobs = jobsOf(value);
		for (const [id, job] of Object.entries(workflowJobs)) {
			// An unbounded job cannot fail; it can only hang until the platform
			// cancels it, and a cancellation reaches the gate as a failure with no
			// diagnosis attached.
			if (typeof job["timeout-minutes"] !== "number")
				errors.push(`ci: ${path} job ${id} must declare timeout-minutes`);
			const owner = HISTORY_OWNERS.find(
				(entry) => entry.workflow === path && entry.job === id,
			);
			const depths = stepsOf(job).flatMap((step) =>
				isRecord(step.with) && Object.hasOwn(step.with, "fetch-depth")
					? [step.with["fetch-depth"]]
					: [],
			);
			if (owner === undefined && depths.length > 0)
				errors.push(
					`ci: ${path} job ${id} must not claim ownership of repository history`,
				);
			if (owner !== undefined && !depths.includes(0))
				errors.push(`ci: ${path} job ${id} must check out full history`);
			// The same rule one level down, and the job level is the one people
			// reach for: it looks scoped and is not. Every step of the job receives
			// it, and the step that needed it is indistinguishable from the four
			// that did not.
			if (referencesSecrets(job.env))
				errors.push(
					`ci: ${path} job ${id} must not expose a credential in a job-level env block`,
				);
			const steps = stepsOf(job);
			await checkStepBodies(path, `job ${id}`, steps, errors, root);
			// The composite action is the sole owner of "how a job gets Bun". A
			// direct call is a second owner that drifts on its own schedule.
			for (const step of steps) {
				if (step.uses?.startsWith(`${SETUP_ACTION}@`))
					errors.push(
						`ci: ${path} must reach Bun through the committed action`,
					);
				// Same rule, same reason, for the second toolchain: an inline
				// installer is a second owner of the moon version, and it sits
				// outside the assertion that checks it against .prototools.
				if (step.uses?.startsWith(`${MOON_SETUP_ACTION}@`))
					errors.push(
						`ci: ${path} must reach moon through the committed action`,
					);
			}
			if (
				id === GRAPH_JOB &&
				!steps.some((step) => step.uses === `./${MOON_ACTION_DIRECTORY}`)
			)
				errors.push(
					`ci: ${path} job ${GRAPH_JOB} must reach moon through the committed action`,
				);

			// --- Outputs, and who may read them ------------------------------
			// A job that reads another job's outputs but does not declare it in
			// `needs` reads EMPTY rather than failing: GitHub populates the
			// context from declared dependencies only. So the lane starts
			// silently, with a matrix built from nothing, and looks exactly like
			// a lane that had nothing to do.
			const consumed = new Set<string>();
			for (const match of JSON.stringify(job).matchAll(NEEDS_OUTPUT))
				if (match[1]) consumed.add(match[1]);
			const declared = new Set(needsOf(job));
			for (const producer of consumed) {
				if (!declared.has(producer))
					errors.push(
						`ci: ${path} job ${id} reads outputs from ${producer} without declaring it in needs`,
					);
			}
			// A selection decides what is CHECKED, never what is SHIPPED. "This
			// pull request did not touch that project" is a statement about a
			// diff, and a delivery lane that believed it would ship a tree
			// nothing verified.
			const delivers =
				DELIVERY_JOB.test(id) || Object.hasOwn(job, "environment");
			if (consumed.has(SELECTOR_JOB) && delivers)
				errors.push(
					`ci: ${path} job ${id} delivers and must not select what it runs`,
				);
			// ... and the same reasoning reaches one job further. A lane that holds
			// a credential is a lane that can change something outside this
			// repository, whatever its id says, so it may not decide for itself
			// what it runs either.
			if (consumed.has(SELECTOR_JOB) && referencesSecrets(job))
				errors.push(
					`ci: ${path} job ${id} receives a credential and must not select what it runs`,
				);
			// ... and the same job must not ship a tree the contract guards never
			// saw. A delivery lane is the ONE path on which a broken contract
			// reaches users, so the dependency is required — transitively, because
			// funnelling through an aggregate gate is the correct shape and a rule
			// that demanded a direct edge would push people to add a wrong one.
			//
			// No such job exists in this repository today, which is exactly why the
			// rule is written now: a rule added alongside the first delivery job is
			// a rule written by the person who wanted the job.
			if (delivers && id !== CONTRACT_JOB) {
				if (!Object.hasOwn(workflowJobs, CONTRACT_JOB))
					errors.push(
						`ci: ${path} job ${id} delivers from a workflow that declares no ${CONTRACT_JOB} job to gate it`,
					);
				else if (!dependsOn(workflowJobs, id, CONTRACT_JOB))
					errors.push(
						`ci: ${path} job ${id} delivers and must depend on ${CONTRACT_JOB}`,
					);
			}
			// `fromJSON` turns a string into structure. Anywhere but a matrix
			// value that is a decision made from data the job did not compute,
			// and the one place it is legitimate is the place a selection is
			// consumed.
			const strategy = isRecord(job["strategy"]) ? job["strategy"] : {};
			const matrix = isRecord(strategy["matrix"]) ? strategy["matrix"] : {};
			const calls = (text: string): number =>
				[...text.matchAll(FROM_JSON)].length;
			if (calls(JSON.stringify(job)) !== calls(JSON.stringify(matrix)))
				errors.push(
					`ci: ${path} job ${id} may only call fromJSON in a matrix value`,
				);
		}
	}

	// Composite actions. Their metadata is a template the runner evaluates in
	// full before a single step runs, and a composite action has no env, secrets,
	// vars, needs or matrix context — so one such expression anywhere in the
	// file, prose included, fails the action to LOAD and reddens every caller.
	for (const path of actionFiles(root)) {
		const source = await readText(resolve(root, path));
		if (source === "") continue;
		if (RUNNER_EXPRESSION.test(source))
			errors.push(`ci: ${path} must not name an unavailable context`);
		// timeout-minutes is unsupported on composite steps: written here it is
		// ignored rather than rejected, so the bound would be imaginary.
		if (/^\s*timeout-minutes:/m.test(stripComments(source)))
			errors.push(`ci: ${path} must not bound a composite step`);
		for (const match of stripComments(source).matchAll(
			/^\s*continue-on-error:\s*(\S+)/gm,
		)) {
			if (match[1] === "false") continue;
			errors.push(`ci: ${path} must not tolerate a failing step`);
		}
		const value = parseYaml(source);
		if (!value) {
			errors.push(`ci: ${path} must parse as YAML`);
			continue;
		}
		const inputs = isRecord(value["inputs"]) ? value["inputs"] : {};
		const runs = isRecord(value["runs"]) ? value["runs"] : {};
		const steps = Array.isArray(runs["steps"])
			? runs["steps"].filter((step): step is Step => isRecord(step))
			: [];
		await checkStepBodies(path, "step", steps, errors, root);
		for (const assignment of [
			...source.matchAll(/^[^\S\n]*bun-version:[^\S\n]*(\S.*?)[^\S\n]*$/gm),
		].flatMap((match) => (match[1] ? [match[1]] : []))) {
			if (assignment !== "${{ inputs.bun-version }}")
				errors.push(`ci: ${path} must relay bun-version from its own input`);
		}
		if (path === MOON_ACTION) {
			// No inputs at all. .prototools is the one authority for the moon
			// version — setup-toolchain reads it when `moon-version` is empty — so
			// an input here would be a second authority sitting outside the
			// toolchain guard, and a caller could ask for a moon this repository
			// does not pin. That includes bun-version: a job needing both
			// toolchains uses both committed actions rather than folding one into
			// the other.
			for (const key of Object.keys(inputs))
				errors.push(
					`ci: ${path} must not declare the input ${key}; .prototools is the only version authority`,
				);
			// An installed toolchain is only an intention until the binary agrees
			// with the authority, which is what makes this action self-verifying
			// rather than merely obedient.
			const asserts = steps.some(
				(step) =>
					(step.run ?? "").includes(".prototools") &&
					(step.run ?? "").includes("moon --version"),
			);
			if (!asserts)
				errors.push(
					`ci: ${path} must assert the installed moon against .prototools`,
				);
		}

		const bunVersion = inputs["bun-version"];
		if (isRecord(bunVersion)) {
			// `required: true` is NOT enforced by the runner for composite actions,
			// and an empty version makes setup-bun quietly install "latest" — the
			// exact silent drift the action exists to kill. A default here would be
			// a second authority sitting outside the version guard.
			if (
				bunVersion["required"] !== true ||
				Object.hasOwn(bunVersion, "default")
			)
				errors.push(
					`ci: ${path} must declare bun-version required without a default`,
				);
			const asserts = steps.some(
				(step) =>
					(step.run ?? "").includes("inputs.bun-version") &&
					/\[\s*-z\s/.test(step.run ?? ""),
			);
			if (!asserts) errors.push(`ci: ${path} must refuse an empty bun-version`);
		}
	}

	// The aggregate gate. One workflow owns it; every other job in that file
	// funnels into it, and it always reports so a skipped lane can never strand
	// a required check in a pending state no further push can clear.
	const gateEntry = [...sources].find(([, source]) =>
		Object.hasOwn(jobsOf(parseYaml(source) ?? {}), gateId),
	);
	if (!gateEntry) {
		errors.push(`ci: no workflow declares the aggregate gate ${gateId}`);
	} else {
		const [gatePath, gateSource] = gateEntry;
		const jobs = jobsOf(parseYaml(gateSource) ?? {});
		const gate = jobs[gateId] as Job;
		if (aggregateGateContext(gateSource, gateId) === undefined)
			errors.push(
				"ci: the aggregate gate must declare the display name branch protection requires",
			);
		if (gate.if !== "${{ always() }}")
			errors.push("ci: the aggregate gate must report with always()");
		const expected = Object.keys(jobs).filter((id) => id !== gateId);
		const declared = needsOf(gate);
		if ([...declared].sort().join(",") !== [...expected].sort().join(","))
			errors.push(
				`ci: the aggregate gate must depend on every job in ${gatePath}`,
			);
		// Named separately from the membership rule above so the failure reads as
		// what it is. The graph oracle is the only job whose absence from `needs`
		// is invisible in the run — every other lane's output is obviously
		// missing, while a graph that was never verified looks exactly like a
		// graph that was.
		if (Object.hasOwn(jobs, GRAPH_JOB) && !declared.includes(GRAPH_JOB))
			errors.push(
				"ci: the aggregate gate must depend on the moon graph oracle",
			);
		// Named separately for the same reason, and it is the sharper case. A
		// selector that failed makes the lanes below it SKIP, and a skipped lane
		// reads as a pass to the verdict script — so a selection nothing gates on
		// is a page that goes green precisely when the selection was wrong.
		if (Object.hasOwn(jobs, SELECTOR_JOB) && !declared.includes(SELECTOR_JOB))
			errors.push(
				"ci: the aggregate gate must depend on the affected selector",
			);
		const verdict = stepsOf(gate).at(-1);
		const environment = isRecord(verdict?.env) ? verdict.env : {};
		// The verdict is derived from join(needs.*.result) rather than from a
		// hand-maintained list, so a new job can only be forgotten in `needs` —
		// which the membership check above owns.
		if (environment["RESULTS"] !== "${{ join(needs.*.result, ',') }}")
			errors.push(
				"ci: the aggregate gate must derive its verdict from join(needs.*.result)",
			);
		if (environment["DRAFT"] !== "${{ github.event.pull_request.draft }}")
			errors.push(
				"ci: the aggregate gate must read the draft flag through env",
			);
		if (
			verdict?.run?.trim() !== `bash ${GATE_SCRIPT}` ||
			!(await exists(resolve(root, GATE_SCRIPT)))
		)
			errors.push(
				"ci: the aggregate gate must run the committed verdict script",
			);
		// Cross-workflow isolation. A non-gating, real-network lane must never be
		// able to redden the required check: an upstream registry outage is not a
		// defect in the pull request under review.
		const gateBody = stripComments(gateSource);
		for (const other of sources.keys()) {
			if (other === gatePath) continue;
			const basename = other.slice(other.lastIndexOf("/") + 1);
			if (gateBody.includes(other) || gateBody.includes(basename))
				errors.push(
					`ci: the gating workflow must not depend on the non-gating ${other}`,
				);
		}
	}

	for (const path of automationFiles(root)) {
		if (!/\.(?:ya?ml|sh|json|toml)$/.test(path)) continue;
		if (workflows.includes(path)) continue;
		if (REMOTE_EXECUTION.test(await readText(resolve(root, path))))
			errors.push(`ci: ${path} must not configure remote build execution`);
	}

	// Compiler coverage. This rule is about the TEMPLATE repository's own tracked
	// sources: every one of them belongs to a committed TypeScript project, and CI
	// really runs the compiler over each project.
	//
	// A rendered project is deliberately exempt. Its scripts/template guard
	// modules are validated by being EXECUTED rather than by being compiled
	// standalone: the rendered ci.yml runs one dedicated package script per
	// guard it received — `toolchain:check`, `image:check`, `worktree:check`,
	// `ci:check`, and the capability-gated guards that project enabled — and each
	// of those loads and runs the module. The rendered root project excludes
	// scripts/template exactly as this one does, and the template's own project
	// file for that subtree is template tooling the render omits, so demanding a
	// standalone compile downstream would mean shipping a project file for a
	// subtree the project does not own.
	if (isTemplateRepository) {
		const trackedSources = trackedFiles(root, "*.ts");
		const trackedProjects = trackedFiles(root, "*tsconfig.json");
		if (trackedSources !== undefined && trackedProjects !== undefined) {
			const projects: Project[] = [];
			for (const path of trackedProjects) {
				let declaration: JsonRecord;
				try {
					declaration = (await Bun.file(
						resolve(root, path),
					).json()) as JsonRecord;
				} catch {
					errors.push(`ci: ${path} must parse as JSON`);
					continue;
				}
				const directory = dirname(path) === "." ? "" : dirname(path);
				projects.push({
					path,
					directory,
					include: list(declaration, "include"),
					exclude: list(declaration, "exclude"),
				});
			}
			for (const file of trackedSources) {
				if (projects.some((project) => coversFile(project, file))) continue;
				errors.push(
					`ci: ${file} is outside every committed TypeScript project`,
				);
			}
			// A project nothing compiles is a project that only looks like coverage.
			// The command is resolved one hop through the committed helpers, because
			// the root project is checked by a wrapper script rather than inline.
			const helpers = new Map<string, string>();
			for (const name of ["run-typecheck.sh", "run-tests.sh"]) {
				helpers.set(
					name,
					await readText(resolve(root, `${HELPER_DIRECTORY}/${name}`)),
				);
			}
			const gateSource = gateEntry?.[1] ?? "";
			for (const project of projects) {
				const runner = Object.entries(scripts).find(([, command]) => {
					if (typeof command !== "string") return false;
					let expanded = command;
					for (const [name, body] of helpers) {
						if (command.includes(name)) expanded += `\n${body}`;
					}
					return new RegExp(
						`-p\\s+${project.path.replace(/[.]/g, "\\.")}(?:\\s|$)`,
					).test(expanded);
				});
				if (!runner) {
					errors.push(`ci: no package script typechecks ${project.path}`);
					continue;
				}
				if (!gateSource.includes(`bun run ${runner[0]}`))
					errors.push(
						`ci: the gating workflow must run ${runner[0]} to typecheck ${project.path}`,
					);
			}
		}
	}

	// One selector, or none. A job's outputs decide what the lanes downstream of
	// it run, so two files writing them are two authorities on "what must be
	// checked" — and they disagree exactly once, quietly, in the direction of
	// running less. The rule is deliberately "at most one" rather than "exactly
	// one": a project that selects nothing has no writer at all, and demanding
	// one would make the absence of a feature a contract violation.
	const writers = outputWriters(root, OUTPUT_VARIABLE);
	if (writers !== undefined && writers.length > 1)
		errors.push(
			`ci: only one committed file may write job outputs; found ${writers.join(", ")}`,
		);

	// Wiring. The guard is only a guard if something runs it.
	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
		if (!(await exists(resolve(root, path))))
			errors.push(`ci: ${path} is missing`);
	}
	if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
		errors.push("ci: package script must expose the dedicated workflow guard");
	if (!(gateEntry?.[1] ?? "").includes(`bun run ${GUARD_SCRIPT}`))
		errors.push("ci: the gating workflow must run the workflow policy guard");

	// Downstream sync excludes every scripts/* path by default, so the committed
	// helpers need an explicit include or their declared merge policy is a lie.
	const sync = await readText(resolve(root, SYNC_SCRIPT));
	if (sync !== "" && !sync.includes(`${HELPER_DIRECTORY}/*)`))
		errors.push("ci: template ownership must cover the committed ci helpers");

	const ownershipPath = resolve(root, OWNERSHIP_PATH);
	if (await exists(ownershipPath)) {
		const ownership = (await Bun.file(ownershipPath).json()) as JsonRecord;
		const rules = records(ownership["ownershipRules"]);
		const catchAll = rules.findIndex(
			(entry) => entry["pattern"] === "scripts/template/**",
		);
		for (const pattern of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
			const index = rules.findIndex((entry) => entry["pattern"] === pattern);
			if (
				index < 0 ||
				(catchAll >= 0 && index > catchAll) ||
				rules[index]?.["renderPolicy"] !== "copy"
			)
				errors.push("ci: template ownership must cover the workflow guard");
		}
	}

	return errors;
}
