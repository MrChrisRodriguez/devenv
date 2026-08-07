// biome-ignore-all lint/complexity/useLiteralKeys: Parsed TOML and JSON are strict records.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildProjectGraph,
	classifyPath,
	dependentsOf,
	type MatrixUniverse,
	type ProjectGraph,
	readUniverseRegistry,
	validateUniverseRegistry,
} from "./graph-contract";

type JsonRecord = Record<string, unknown>;

const PARAMETER_PATH = "template-parameters.toml";
const REGISTRY_PATH = "ci-matrix-universes.json";
const GUARD_CONTRACT = "scripts/template/affected-contract.ts";
const GUARD_ENTRYPOINT = "scripts/template/validate-affected.ts";
const GUARD_SCRIPT = "affected:check";
const OWNERSHIP_PATH =
	"docs/devcontainer-upgrade/stage-0/template-ownership.json";

// The environment variable that decides whether a selection is even attempted,
// and the value that turns it on. Both live HERE and in no core module: the
// name is a pre-declared Stage 0 capability signature token, and the residue
// scan is a plain `includes()` over every file of a render whose capability is
// off — so one mention inside `ci-contract.ts`, which ships to every project,
// would fail the minimal fixture by construction.
export const MODE_VARIABLE = "MOON_AFFECTED_MODE";
export const MODE_SELECTING = "moon";

// The only events a narrow selection is ever computed for.
//
// Everything else — a push to the default branch, a schedule, a deployment, a
// manual dispatch, and every event this table has never heard of — is FULL.
// That is not caution about the listed events, it is the shape of the question:
// a selection needs a BASE to diff against, and only these two carry one that
// describes the change under review. A push to `main` has a base that describes
// the previous merge, which is a different question with the same syntax.
const SELECTABLE_EVENTS = ["pull_request", "merge_group"] as const;

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Why a selection came out the way it did. Stable; tests assert on it. */
export type AffectedReason =
	| "mode-not-selecting"
	| "event-not-selectable"
	| "base-sha-malformed"
	| "base-sha-unknown"
	| "head-sha-malformed"
	| "head-sha-unknown"
	| "merge-base-failed"
	| "diff-failed"
	| "no-changed-files"
	| "global-input"
	| "moon-disagreed"
	| "affected";

export interface AffectedSelection {
	/** `full` runs every project in every universe; `narrow` runs the closure. */
	mode: "full" | "narrow";
	reason: AffectedReason;
	/** One entry per universe in the registry, each a sorted project list. */
	universes: Record<string, string[]>;
	/** Human-readable detail, in the order it was discovered. */
	annotations: string[];
	/**
	 * The changed paths that produced the seeds — documentation and everything
	 * else excluded. This is what the moon reconciliation leg pipes to the
	 * binary, so that moon is asked about the SAME input rather than about the
	 * whole diff: a docs file handed to moon resolves to whichever project
	 * contains it, and moon has no notion of documentation to exclude it with.
	 * Empty for every `full` outcome, which is also why moon is never consulted
	 * on one.
	 */
	seedFiles: string[];
	/** The closure this selection intersected each universe with. */
	selected: string[];
}

export interface AffectedInput {
	root: string;
	/** The mode variable's value, exactly as the environment carried it. */
	mode?: string | undefined;
	eventName?: string | undefined;
	baseSha?: string | undefined;
	headSha?: string | undefined;
}

/**
 * The one failure this selector does not fail open on.
 *
 * Every other ambiguity resolves to FULL, because running everything is always
 * a safe answer. An invalid universe registry is the exception: without it we
 * do not KNOW the full set, so "emit FULL" would emit EMPTY — every project
 * silently skipped on the sole required gate, reported green. The caller is
 * required to let this propagate and produce no output at all.
 */
export class AffectedPreflightError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(
			`affected: the matrix universe registry is not usable:\n${issues.join("\n")}`,
		);
		this.name = "AffectedPreflightError";
		this.issues = issues;
	}
}

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function git(root: string, args: string[]): GitResult {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString().trim(),
	};
}

function fullUniverses(universes: MatrixUniverse[]): Record<string, string[]> {
	const output: Record<string, string[]> = {};
	for (const universe of universes)
		output[universe.id] = [...universe.projects];
	return output;
}

function intersected(
	universes: MatrixUniverse[],
	selected: ReadonlySet<string>,
): Record<string, string[]> {
	const output: Record<string, string[]> = {};
	for (const universe of universes)
		output[universe.id] = universe.projects.filter((project) =>
			selected.has(project),
		);
	return output;
}

/**
 * Which projects a pull request's changes reach, derived from the COMMITTED
 * graph and nothing else.
 *
 * This is the authority. Moon is asked the same question separately and may
 * only WIDEN the answer to FULL when it disagrees — it never narrows it. The
 * asymmetry is the whole design: the graph oracle exists because a guard that
 * asked moon what the graph is could only ever agree with moon, and a selector
 * that adopted moon's number would inherit exactly that circularity on the one
 * decision that can skip the required suite.
 *
 * The order below is the safety property, not a style. Read it as a series of
 * reasons to give up on narrowing, each of which resolves to FULL:
 *
 *  1. the registry preflight, which is the one fail-CLOSED step (see above);
 *  2. the mode is not `moon` — the rollback switch, and the default;
 *  3. the event carries no base that describes the change under review;
 *  4. the base or head commit is not a 40-hex object this clone actually has;
 *  5. the merge base or the diff itself failed;
 *  6. any changed path is global — it changes what every project builds;
 *  7. the diff found nothing, which is not evidence that nothing changed.
 *
 * Only a diff that survives all seven produces a narrow answer: the projects
 * owning the changed files, plus every project transitively depending on them,
 * intersected with each universe.
 */
export async function selectAffected(
	input: AffectedInput,
): Promise<AffectedSelection> {
	const { root } = input;
	const graph = await buildProjectGraph(root);

	// (1) Fail-closed preflight. Nothing below may run on a registry we cannot
	// trust, because every fail-open path emits the registry's own contents.
	const registryErrors = await validateUniverseRegistry(root, graph);
	if (registryErrors.length > 0)
		throw new AffectedPreflightError(registryErrors);
	const universes = await readUniverseRegistry(root);
	if (universes === undefined || universes.length === 0)
		throw new AffectedPreflightError([
			`affected: ${REGISTRY_PATH} declares no universe to select from`,
		]);

	const annotations: string[] = [];
	const full = (reason: AffectedReason, detail: string): AffectedSelection => ({
		mode: "full",
		reason,
		universes: fullUniverses(universes),
		annotations: [...annotations, detail],
		seedFiles: [],
		selected: [
			...new Set(universes.flatMap((universe) => universe.projects)),
		].sort(),
	});

	// (2) The switch. Any case, any surrounding whitespace, and unset.
	const mode = (input.mode ?? "").trim().toLowerCase();
	if (mode !== MODE_SELECTING)
		return full(
			"mode-not-selecting",
			`mode ${JSON.stringify(input.mode ?? "")} is not ${MODE_SELECTING}`,
		);

	// (3) The event table.
	const eventName = (input.eventName ?? "").trim();
	if (!(SELECTABLE_EVENTS as readonly string[]).includes(eventName))
		return full(
			"event-not-selectable",
			`event ${JSON.stringify(eventName)} carries no base for a selection`,
		);

	// (4) Both endpoints, validated as text before either reaches git and then
	// as objects this clone really has. A base sha that is merely well-formed
	// resolves to nothing on a shallow or single-branch checkout, and `git diff`
	// against a missing object is a failure with a confident-looking message.
	const baseSha = (input.baseSha ?? "").trim();
	const headSha = (input.headSha ?? "").trim();
	if (!COMMIT_SHA.test(baseSha))
		return full(
			"base-sha-malformed",
			`base ${JSON.stringify(baseSha)} is not a commit sha`,
		);
	if (!COMMIT_SHA.test(headSha))
		return full(
			"head-sha-malformed",
			`head ${JSON.stringify(headSha)} is not a commit sha`,
		);
	if (git(root, ["cat-file", "-e", `${baseSha}^{commit}`]).exitCode !== 0)
		return full(
			"base-sha-unknown",
			`base ${baseSha} is not a commit in this clone`,
		);
	if (git(root, ["cat-file", "-e", `${headSha}^{commit}`]).exitCode !== 0)
		return full(
			"head-sha-unknown",
			`head ${headSha} is not a commit in this clone`,
		);

	// (5) The merge base, then the diff. Diffing base..head directly would
	// attribute every commit the base branch gained since the branch point to
	// this pull request — which is wrong in the widening direction on `main`
	// and wrong in both directions on a stacked pull request.
	const mergeBase = git(root, ["merge-base", baseSha, headSha]);
	if (mergeBase.exitCode !== 0)
		return full(
			"merge-base-failed",
			`git merge-base ${baseSha} ${headSha} failed: ${mergeBase.stderr}`,
		);
	const base = mergeBase.stdout.trim();
	if (!COMMIT_SHA.test(base))
		return full(
			"merge-base-failed",
			`git merge-base produced ${JSON.stringify(base)}`,
		);
	annotations.push(`merge base ${base}`);

	// `--no-renames` so a rename yields the old path AND the new one: a file
	// moved out of a project still changes that project. `-z` so a path with a
	// newline in it cannot forge an extra entry; Bun hands back the raw bytes
	// and the exit status separately, so an empty-but-successful diff is
	// distinguishable from a failure without a temporary file.
	const diff = git(root, [
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		base,
		headSha,
	]);
	if (diff.exitCode !== 0)
		return full(
			"diff-failed",
			`git diff ${base}..${headSha} failed: ${diff.stderr}`,
		);
	const changed = diff.stdout.split("\0").filter((path) => path !== "");

	// (6) Classification. `docs` contributes nothing; a project contributes its
	// owner; anything global — or anything no project claims, which classifies
	// as global — ends the selection.
	//
	// One owner is special and also ends it: the project whose source is the
	// repository itself. Every workspace here has one (`sources.root: '.'`
	// keeps the graph non-empty), it CONTAINS every other project, and it is
	// what an unrecognised top-level file falls to. Treating that as a narrow
	// seed would say "a brand-new root config affects the root project only",
	// which is exactly the silent skip a catch-all exists to prevent — and it
	// is also what makes the moon reconciliation comparable, since a project
	// rooted at `.` is affected by literally every changed file.
	const seeds = new Set<string>();
	const seedFiles: string[] = [];
	const repositoryWide = new Set(
		graph.projects
			.filter((project) => project.source === ".")
			.map((project) => project.id),
	);
	for (const path of changed) {
		const classification = classifyPath(path, graph.projects);
		if (classification.scope === "global")
			return full("global-input", `${path} is a global input`);
		if (classification.scope === "docs") continue;
		if (classification.project === undefined) continue;
		if (repositoryWide.has(classification.project))
			return full(
				"global-input",
				`${path} belongs to ${classification.project}, whose source is the whole repository`,
			);
		seeds.add(classification.project);
		seedFiles.push(path);
	}

	// (7) A diff that found nothing has not established that nothing changed —
	// it has established that this comparison found nothing, which is also what
	// a wrong base looks like.
	if (changed.length === 0)
		return full(
			"no-changed-files",
			`${base}..${headSha} reported no changed files`,
		);

	const selected = new Set(dependentsOf(graph, seeds));
	annotations.push(
		`${changed.length} changed file(s), seeds [${[...seeds].sort().join(", ")}], closure [${[...selected].sort().join(", ")}]`,
	);
	return {
		mode: "narrow",
		reason: "affected",
		universes: intersected(universes, selected),
		annotations,
		seedFiles: [...seedFiles].sort(),
		selected: [...selected].sort(),
	};
}

/**
 * Widen a selection to the full universe set, keeping its annotations.
 *
 * The moon reconciliation leg calls this, and it is here rather than there so
 * "widening" has exactly one implementation: a caller that rebuilt the full
 * matrix by hand could get it subtly wrong in the one direction that matters.
 */
export async function widenToFull(
	root: string,
	selection: AffectedSelection,
	reason: AffectedReason,
	detail: string,
): Promise<AffectedSelection> {
	const universes = await readUniverseRegistry(root);
	if (universes === undefined || universes.length === 0)
		throw new AffectedPreflightError([
			`affected: ${REGISTRY_PATH} declares no universe to widen to`,
		]);
	return {
		mode: "full",
		reason,
		universes: fullUniverses(universes),
		annotations: [...selection.annotations, detail],
		seedFiles: [],
		selected: [
			...new Set(universes.flatMap((universe) => universe.projects)),
		].sort(),
	};
}

/** Render a selection for a step log or a job summary. */
export function describeSelection(selection: AffectedSelection): string {
	const lines = [
		`selection: ${selection.mode} (${selection.reason})`,
		...selection.annotations.map((annotation) => `  - ${annotation}`),
		...Object.entries(selection.universes).map(
			([id, projects]) => `  ${id} = [${projects.join(", ")}]`,
		),
	];
	return lines.join("\n");
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

const WORKFLOW_DIRECTORY = ".github/workflows";

async function workflowSources(root: string): Promise<Map<string, string>> {
	const sources = new Map<string, string>();
	let names: string[];
	try {
		names = readdirSync(resolve(root, WORKFLOW_DIRECTORY)).filter(
			(name) => name.endsWith(".yml") || name.endsWith(".yaml"),
		);
	} catch {
		return sources;
	}
	for (const name of names.sort()) {
		const path = `${WORKFLOW_DIRECTORY}/${name}`;
		sources.set(path, await Bun.file(resolve(root, path)).text());
	}
	return sources;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * The affected-selection contract: everything mode-aware, in the one module a
 * project without the capability never receives.
 *
 * Splitting these rules out of `ci-contract.ts` is not tidiness. That file is
 * `renderPolicy: copy` into EVERY project, and the anti-residue scan is a plain
 * substring search for this capability's signature tokens over every file of a
 * render whose capability is off — so a single mention of the mode variable
 * there would fail the minimal fixture, forever, with no way to fence it.
 */
export async function validateAffectedContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];

	// Wiring. A guard nothing runs is not a guard.
	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
		if (!(await exists(resolve(root, path))))
			errors.push(`affected: ${path} is missing`);
	}
	const manifestPath = resolve(root, "package.json");
	const manifest = (await exists(manifestPath))
		? ((await Bun.file(manifestPath).json()) as JsonRecord)
		: {};
	const scripts = isRecord(manifest["scripts"]) ? manifest["scripts"] : {};
	if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
		errors.push(
			`affected: package script ${GUARD_SCRIPT} must expose the dedicated selection guard`,
		);
	// ... and something has to run it. A contract module that ships downstream
	// and is never executed there is documentation with an import statement.
	const workflows = await workflowSources(root);
	if (
		workflows.size > 0 &&
		![...workflows.values()].some((source) =>
			source.includes(`bun run ${GUARD_SCRIPT}`),
		)
	)
		errors.push(`affected: a workflow must run ${GUARD_SCRIPT}`);

	// The registry the selector fails closed on. `affected:check` is the place
	// that failure is cheap to see; discovering it from a CI job is the place it
	// is expensive.
	const graph: ProjectGraph = await buildProjectGraph(root);
	errors.push(
		...(await validateUniverseRegistry(root, graph)).map(
			(error) => `affected: ${error.replace(/^graph: /, "")}`,
		),
	);

	// Ownership. The three gated modules are copied downstream, and the entries
	// must precede the `scripts/template/**` omit catch-all or the render drops
	// the guard while the package script still calls it.
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
				errors.push(`affected: template ownership must cover ${pattern}`);
		}
		const artifacts = records(ownership["artifactRules"]);
		for (const pattern of [GUARD_CONTRACT, GUARD_ENTRYPOINT]) {
			const rule = artifacts.find((entry) => entry["pattern"] === pattern);
			const requires = Array.isArray(rule?.["requiresAll"])
				? rule["requiresAll"]
				: [];
			if (!requires.includes("moon_affected_selection"))
				errors.push(`affected: ${pattern} must be gated by the capability`);
		}
	}

	// The parameter that records what the repository variable defaults to. It
	// cannot be `moon` here — the capability is off by default and two of three
	// fixtures disable it — so this rule is about the value being STATED, and
	// the workflow's own fallback is checked against it once the lane exists.
	const parameterPath = resolve(root, PARAMETER_PATH);
	if (await exists(parameterPath)) {
		try {
			const parameters = Bun.TOML.parse(
				await Bun.file(parameterPath).text(),
			) as JsonRecord;
			const declared = isRecord(parameters["ci"])
				? parameters["ci"]["affected_mode_initial"]
				: undefined;
			if (typeof declared !== "string" || declared === "")
				errors.push(
					`affected: ${PARAMETER_PATH} must declare [ci] affected_mode_initial`,
				);
		} catch {
			errors.push(`affected: ${PARAMETER_PATH} must parse as TOML`);
		}
	}

	return errors;
}
