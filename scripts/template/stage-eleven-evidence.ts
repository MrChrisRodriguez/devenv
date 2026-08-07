// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Sealed diagnostics are literal fragments of interpolated assertions.
import { resolve } from "node:path";
// The guard's own answer to "what is the required status check called?". The
// record derives the context from the committed workflow rather than restating
// it, so a renamed gate job invalidates the evidence.
import {
	aggregateGateContext,
	DEFAULT_AGGREGATE_GATE_NAME,
} from "./ci-contract";
import { validateJsonSchema } from "./json-schema";
import {
	ACCEPTANCE_ITEMS,
	BUDGET_FAMILIES,
	GUARD_SCRIPT,
	SCAN_IDS,
	SYNC_SCRIPT,
	TEMPLATE_ONLY_PATHS,
} from "./release-contract";
// One digest implementation for every stage record; it is not stage specific.
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

export const STAGE_ELEVEN_COMMAND_IDS = [
	// The gate this stage adds, run whole. Its own output is where the six scan
	// families each report their scanned-file counts and where the inherited
	// acceptance list prints.
	//
	// `template:validate` is deliberately NOT here: it aggregates every hermetic
	// contract INCLUDING this record, so it cannot appear in the record it
	// validates — run before the record exists it fails, and run after it can
	// never seal its own log.
	"release-guard",
	// The committed expectations, the generator that writes them, and the proof
	// that comparing them is not decoration.
	"goldens",
	"golden-mutation",
	// The scan families, the derived acceptance split and the budget table, each
	// exercised on its own. A suite-wide green says the file passed; what this
	// record has to be able to say is that THIS leg was exercised.
	"scans",
	"acceptance-inheritance",
	"budgets",
	"signals",
	// The renders themselves, and the whole refusal matrix over them.
	"render-fixtures",
	"release-mutations",
	// The live acceptance items 18.2 names that the path diff made LIVE rather
	// than inherited. Two of them — the image build and the two-worktree
	// lifecycle — are why this capture is host-only.
	"clean-image-build",
	"warm-image-build",
	// The first successful lifecycle measurement in the program. Stage 0
	// recorded fresh startup and readiness as `"unavailable"` — neither isolated
	// worktree completed its lifecycle — so this capture is not a comparison
	// against a baseline, it IS the baseline, and the budget table records it
	// as such rather than pretending there was something to beat.
	"fresh-startup",
	"two-worktree-isolation",
	"browser-image-build",
	"browser-preflight",
	"openspec-lifecycle",
	"dependency-guards",
	// The one thing in this record this repository cannot fabricate, and the
	// proof that the whole bundle comes back out in one revert.
	"live-gate",
	"rollback-proof",
] as const;

export type StageElevenCommandId = (typeof STAGE_ELEVEN_COMMAND_IDS)[number];

export const LOG_ROOT = "evidence/stage-11-release-run";
const COLLECTOR = "scripts/template/collect-stage-eleven-evidence.ts";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const REGISTRY_PATH = "release.json";
const LOCK_PATH = "bun.lock";
const RELEASE_MUTATION_TEST = "scripts/template/__tests__/release.test.ts";

// The Stage 10E merge on main: this stage's predecessor and the tree the
// rollback proof reverts back to. Sealed rather than resolved, so the record
// cannot quietly re-base itself onto a later main.
export const STAGE_TEN_E_MERGE_SHA = "28f69975f133fb04b203e61709fa543614ede89d";

// Every path this stage adds. A revert has to take all of them back out, which
// is the additive half of the rollback proof. Unlike every predecessor, not one
// of these reaches a rendered project: five are template-only by construction
// and the sixth is the one document that does ship.
export const ADDED_PATHS = [
	"release.json",
	"release.schema.json",
	"fixtures/golden/cloud.json",
	"fixtures/golden/full.json",
	"fixtures/golden/minimal.json",
	"scripts/template/release-contract.ts",
	"scripts/template/validate-release.ts",
	"scripts/template/sync-release-goldens.ts",
	"scripts/template/capture-stage-eleven.sh",
	"scripts/template/stage-eleven-evidence.ts",
	"scripts/template/collect-stage-eleven-evidence.ts",
	"scripts/template/__tests__/release.test.ts",
	"scripts/template/__tests__/fixtures/release-workspaces.ts",
	"scripts/template/__tests__/stage-eleven-evidence.test.ts",
	"evidence/stage-11-release.json",
	"evidence/stage-11-release.schema.json",
	"docs/troubleshooting.md",
] as const;

// The decision the pull request ships. A record that read `released` from a
// tree whose tag does not exist would be a record upgrading its own gate, which
// is the one thing the reference implementation's readiness guard forbids in
// writing.
export const DECLARED_DECISION = "candidate";
export const PLANNED_TAG = "v1.0.0";

// The counts that make this stage's legs non-vacuous, sealed as numbers rather
// than re-derived at validation time. "The guard agreed with the registry" is a
// different claim from "the registry still declares what it declared when this
// evidence was captured", and this record makes the second one.
export const SEALED_SCAN_FAMILIES = SCAN_IDS.length;
export const SEALED_ACCEPTANCE_ITEMS = ACCEPTANCE_ITEMS.length;
export const SEALED_BUDGET_FAMILIES = BUDGET_FAMILIES.length;
export const SEALED_GOLDEN_FIXTURES = 3;

// The five ordered post-merge steps. They are declared here as well as in the
// registry because they are the part of 18.5 that cannot be a commit in this
// pull request, and a sequence somebody follows from memory is not a sequence.
export const POST_MERGE_STEPS = [
	"pr-merges",
	"default-branch-full-run-green",
	"tag-merge-commit",
	"push-tag",
	"archive-change",
] as const;

// Every mutation this stage's suite is required to have exercised. The record
// binds the observation by a LITERAL fragment of each sentence rather than by
// its whole interpolated form: three consecutive stages sealed a sentence built
// by template interpolation and then could not find it in the log.
export const REQUIRED_MUTATIONS = [
	"renders different bytes for a file the golden carries",
	"renders a file the golden does not carry",
	"no longer renders a file the golden carries",
	"renders a different mode for a file the golden carries",
	"a half-updated golden is a refusal rather than a smaller diff",
	"the exemption dies with the mechanism that earned it",
	"an inherited claim is legal only while the paths that produced it are byte-unchanged",
	"the mode is a consequence of the diff rather than a choice",
	"a pin nothing compares is decoration",
	"release is blocked until the regression is corrected or an exception is approved",
	"an exemption with nothing to exempt widens itself",
	"budget's exception does not quote the Stage 0 record",
	"a pending signal records nothing",
	"a green run for a different commit is not an exact-head signal",
	"a capability is in one bucket or the inventory means nothing",
	"still carries currentRisk",
	"this surface is template-only and appears in no render",
] as const;

// What the capture is expected to have OBSERVED rather than refused. Each is a
// literal fragment of a notice the guard prints on a green run, which is the
// half of the output that says what was inherited rather than re-measured.
export const EXPECTED_OBSERVATIONS = [
	"is INHERITED from",
	"acceptance items are inherited rather than re-measured at this head",
	"has NO Stage 0 baseline and is recorded as no-baseline rather than compared",
	"is vacuous by construction rather than by defect",
	"and graphify is not one of them",
	"already records; this run asserts the count rather than widening the script",
	"is PENDING; it is a post-merge artefact and the runbook is what fills it in",
] as const;

// Logs bound by name rather than by command, because they are the outputs the
// semantic assertions below read values out of.
const VALIDATION_LOG_NAMES = [
	"release-guard.stdout",
	"acceptance-inheritance.stdout",
	"budgets.stdout",
	"rollback-proof.stdout",
] as const;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const found = value[key];
	return isRecord(found) ? found : {};
}

function arrayAt(value: JsonRecord, key: string): unknown[] {
	const found = value[key];
	return Array.isArray(found) ? found : [];
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/**
 * Both trailer forms a capture writes: `# key: value` from the harness, and
 * bare `key=value` from a capture script reporting its own findings. Reading
 * only the first form is how a validator ends up asserting against nothing.
 */
function keyValues(source: string): JsonRecord {
	const found: JsonRecord = {};
	for (const line of source.split("\n")) {
		const trailer = /^#\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(
			line.trim(),
		);
		if (trailer?.[1]) {
			found[trailer[1]] = (trailer[2] ?? "").trim();
			continue;
		}
		const pair = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
		if (pair?.[1]) found[pair[1]] = (pair[2] ?? "").trim();
	}
	return found;
}

/**
 * The argv every capture is expected to have run, derived from the record's own
 * sealed values rather than restated.
 *
 * A command list nobody can re-run is a claim about a shell history. Deriving
 * the argv here means a capture taken with a different command fails the record
 * that describes it.
 */
export function expectedStageElevenCommands(
	value: unknown,
): Partial<Record<StageElevenCommandId, string[]>> {
	const record = isRecord(value) ? value : {};
	const repository = recordAt(record, "repository");
	const target =
		typeof repository["imageTarget"] === "string"
			? repository["imageTarget"]
			: "development";
	return {
		"release-guard": ["bun", "run", GUARD_SCRIPT],
		goldens: ["bun", "run", SYNC_SCRIPT],
		"clean-image-build": [
			"docker",
			"build",
			"--progress=plain",
			"--no-cache",
			"--target",
			target,
			"-f",
			".devcontainer/Dockerfile",
			"-t",
			"devenv-stage11:clean",
			".",
		],
		"warm-image-build": [
			"docker",
			"build",
			"--progress=plain",
			"--target",
			target,
			"-f",
			".devcontainer/Dockerfile",
			"-t",
			"devenv-stage11:clean",
			".",
		],
		"browser-image-build": [
			"docker",
			"build",
			"--progress=plain",
			"--target",
			"development_browser",
			"-f",
			".devcontainer/Dockerfile",
			"-t",
			"devenv-stage11:browser",
			".",
		],
		"openspec-lifecycle": ["bun", "run", "openspec:check"],
	};
}

/**
 * The record, checked against its schema and then against everything the schema
 * cannot express.
 *
 * The validator is ENVIRONMENT-AGNOSTIC on purpose: it binds sealed values to
 * other sealed values and to Git objects the record itself names, and it never
 * asks the host what it is. A record that only validates on the machine that
 * captured it proves nothing to a reviewer, and a validator that reached for
 * the network would be one this program's design constraints already forbid.
 */
export async function validateStageElevenEvidenceValue(
	value: unknown,
	schema: JsonRecord,
	root: string,
): Promise<string[]> {
	const errors = validateJsonSchema(value, schema).map(
		(error) => `schema: ${error}`,
	);
	if (!isRecord(value)) return errors;

	const run = recordAt(value, "run");
	const source = recordAt(value, "source");
	const repository = recordAt(value, "repository");
	const release = recordAt(value, "release");
	const rollback = recordAt(value, "rollback");
	const expected = expectedStageElevenCommands(value);
	const commands = arrayAt(value, "commands");
	const logs = new Map<string, string>();
	const ids = commands.flatMap((entry) =>
		isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
	);
	if (!sameValue([...ids].sort(), [...STAGE_ELEVEN_COMMAND_IDS].sort()))
		errors.push("semantic: Stage 11 command set drifted");
	if (new Set(ids).size !== ids.length)
		errors.push("semantic: Stage 11 command IDs are not unique");

	for (const entry of commands) {
		if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"] as StageElevenCommandId;
		if (id in expected && !sameValue(entry["command"], expected[id]))
			errors.push(`semantic: command ${id} drifted`);
		if (entry["runId"] !== run["id"])
			errors.push(`semantic: command ${id} belongs to another run`);
		// Every Stage 11 capture is expected to pass. The refusals are proved by
		// the mutation suite, which passes BY observing them, so a non-zero exit
		// here is a failed capture rather than a proof.
		if (entry["exitCode"] !== 0 || entry["status"] !== "pass")
			errors.push(`semantic: command ${id} did not pass`);
		for (const stream of ["stdout", "stderr"] as const) {
			const path = `${LOG_ROOT}/${id}.${stream}`;
			if (entry[`${stream}Path`] !== path)
				errors.push(`semantic: command ${id} ${stream} path drifted`);
			const file = Bun.file(resolve(root, path));
			if (!(await file.exists()))
				errors.push(`repository: command ${id} ${stream} log is missing`);
			else {
				const bytes = await file.bytes();
				logs.set(`${id}.${stream}`, new TextDecoder().decode(bytes));
				if (entry[`${stream}Sha256`] !== sha256(bytes))
					errors.push(`repository: command ${id} ${stream} digest drifted`);
			}
		}
	}
	const log = (id: string, stream: "stdout" | "stderr"): string =>
		logs.get(`${id}.${stream}`) ?? "";
	for (const name of VALIDATION_LOG_NAMES) {
		if (!logs.has(name))
			errors.push(`repository: validation log ${name} is not bound`);
	}

	// Ancestry, sealed-to-sealed. The predecessor merge is a constant in this
	// module rather than a value the record supplies, so a record that re-based
	// itself onto a later main fails here rather than reading plausibly.
	if (source["baseSha"] !== STAGE_TEN_E_MERGE_SHA)
		errors.push("semantic: Stage 11 base is not the Stage 10E merge");
	if (source["treeClean"] !== true)
		errors.push("semantic: Stage 11 was captured from a dirty tree");

	// The stage's central decision, asserted from the record rather than from
	// the tree: this surface ships in no render, and the paths that make it are
	// the ones the rollback has to remove.
	const added = strings(rollback["addedPaths"]);
	if (!sameValue([...added].sort(), [...ADDED_PATHS].sort()))
		errors.push("semantic: Stage 11 added-path set drifted");
	for (const path of TEMPLATE_ONLY_PATHS) {
		if (!added.includes(path))
			errors.push(
				`semantic: template-only path ${path} is not in the rollback scope`,
			);
	}
	if (rollback["containerRebuildRequired"] !== false)
		errors.push("semantic: Stage 11 must not require a container rebuild");
	if (!sameValue(rollback["outsideTheTree"], []))
		errors.push("semantic: Stage 11 must have nothing outside the tree");
	if (repository["devcontainerFilesChanged"] !== 0)
		errors.push("semantic: Stage 11 must change no devcontainer file");
	if (repository["addedJobs"] !== 0)
		errors.push("semantic: Stage 11 must add no CI job");
	if (repository["lockfileBytesChanged"] !== 0)
		errors.push(`semantic: Stage 11 must not move ${LOCK_PATH}`);

	// The release declaration, sealed and reconciled with this module's own
	// constants. A record that sealed `released` would be describing a tree
	// whose tag cannot exist yet.
	if (release["decision"] !== DECLARED_DECISION)
		errors.push("semantic: Stage 11 must ship the candidate decision");
	if (release["plannedTag"] !== PLANNED_TAG)
		errors.push("semantic: Stage 11 planned tag drifted");
	if (release["scanFamilies"] !== SEALED_SCAN_FAMILIES)
		errors.push("semantic: Stage 11 scan family count drifted");
	if (release["acceptanceItems"] !== SEALED_ACCEPTANCE_ITEMS)
		errors.push("semantic: Stage 11 acceptance item count drifted");
	if (release["budgetFamilies"] !== SEALED_BUDGET_FAMILIES)
		errors.push("semantic: Stage 11 budget family count drifted");
	if (release["goldenFixtures"] !== SEALED_GOLDEN_FIXTURES)
		errors.push("semantic: Stage 11 golden fixture count drifted");
	if (!sameValue(strings(release["postMergeSteps"]), [...POST_MERGE_STEPS]))
		errors.push("semantic: Stage 11 post-merge sequence drifted");
	// The registry's golden digests, bound to the files they name. A pinned
	// digest nothing compares is decoration, and this record is where the
	// comparison happens for the record's own copy of them.
	for (const entry of arrayAt(release, "goldenDigests")) {
		if (!isRecord(entry)) continue;
		const path = entry["path"];
		if (typeof path !== "string") continue;
		const file = Bun.file(resolve(root, path));
		if (!(await file.exists())) {
			errors.push(`repository: golden ${path} is missing`);
			continue;
		}
		if (entry["sha256"] !== sha256(await file.bytes()))
			errors.push(`repository: golden ${path} digest drifted`);
	}

	// Run-shape, anchored on the record's OWN gateNeeds with a subset identity
	// test. The gate context is derived from the committed workflow, so a
	// renamed gate job invalidates the record rather than passing under a new
	// name.
	const workflow = Bun.file(resolve(root, WORKFLOW_PATH));
	if (await workflow.exists()) {
		const context = aggregateGateContext(
			await workflow.text(),
			DEFAULT_AGGREGATE_GATE_NAME,
		);
		if (context !== undefined && repository["gateContext"] !== context)
			errors.push("semantic: Stage 11 gate context drifted from the workflow");
	}
	const gateNeeds = strings(repository["gateNeeds"]);
	if (gateNeeds.length === 0)
		errors.push("semantic: Stage 11 sealed no gate needs");
	const liveJobs = strings(recordAt(value, "live")["jobs"]);
	if (liveJobs.length > 0) {
		// Subset identity rather than equality: the live run reports the lanes
		// that ran, and a lane the gate does not need is a lane this record
		// cannot claim as a required signal.
		for (const job of liveJobs) {
			if (!gateNeeds.includes(job))
				errors.push(`semantic: live job ${job} is not one the gate needs`);
		}
	}

	// The mutation proof, bound by literal fragments. Every one of these is a
	// substring of a sentence the suite prints when it observes the refusal it
	// is named for, and none of them is an interpolated form.
	const mutationLog = [
		log("release-mutations", "stdout"),
		log("release-mutations", "stderr"),
		log("golden-mutation", "stdout"),
		log("golden-mutation", "stderr"),
		log("scans", "stdout"),
		log("scans", "stderr"),
		log("acceptance-inheritance", "stdout"),
		log("acceptance-inheritance", "stderr"),
		log("budgets", "stdout"),
		log("budgets", "stderr"),
		log("signals", "stdout"),
		log("signals", "stderr"),
	].join("\n");
	for (const fragment of REQUIRED_MUTATIONS) {
		if (!mutationLog.includes(fragment))
			errors.push(`semantic: mutation proof is missing ${fragment}`);
	}
	const observationLog = [
		log("release-guard", "stdout"),
		log("release-guard", "stderr"),
		log("acceptance-inheritance", "stdout"),
		log("acceptance-inheritance", "stderr"),
		log("budgets", "stdout"),
		log("budgets", "stderr"),
	].join("\n");
	for (const fragment of EXPECTED_OBSERVATIONS) {
		if (!observationLog.includes(fragment))
			errors.push(`semantic: observation ${fragment} was not captured`);
	}

	// The rollback proof is a synthetic merge and a revert of it, so the claim
	// is about a tree rather than about an intention.
	const rollbackValues = keyValues(log("rollback-proof", "stdout"));
	if (rollbackValues["revertedTree"] !== rollbackValues["baseTree"])
		errors.push(
			"semantic: the reverted tree does not equal the predecessor tree",
		);
	if (rollbackValues["baseSha"] !== STAGE_TEN_E_MERGE_SHA)
		errors.push("semantic: the rollback proof reverted onto another base");

	// The collector must have named itself, or nobody can re-run the capture.
	if (run["collector"] !== COLLECTOR)
		errors.push("semantic: Stage 11 collector path drifted");
	if (run["logRoot"] !== LOG_ROOT)
		errors.push("semantic: Stage 11 log root drifted");
	const registry = Bun.file(resolve(root, REGISTRY_PATH));
	if (!(await registry.exists()))
		errors.push(`repository: ${REGISTRY_PATH} is missing`);
	const suite = Bun.file(resolve(root, RELEASE_MUTATION_TEST));
	if (!(await suite.exists()))
		errors.push(`repository: ${RELEASE_MUTATION_TEST} is missing`);

	return [...new Set(errors)].sort();
}

export async function validateStageElevenEvidence(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const recordPath = resolve(root, "evidence/stage-11-release.json");
	const schemaPath = resolve(root, "evidence/stage-11-release.schema.json");
	const recordFile = Bun.file(recordPath);
	const schemaFile = Bun.file(schemaPath);
	if (!(await recordFile.exists())) return [];
	if (!(await schemaFile.exists()))
		return ["repository: evidence/stage-11-release.schema.json is missing"];
	let value: unknown;
	let schema: JsonRecord;
	try {
		value = (await recordFile.json()) as unknown;
	} catch {
		return ["repository: evidence/stage-11-release.json must parse as JSON"];
	}
	try {
		schema = (await schemaFile.json()) as JsonRecord;
	} catch {
		return [
			"repository: evidence/stage-11-release.schema.json must parse as JSON",
		];
	}
	return validateStageElevenEvidenceValue(value, schema, root);
}
