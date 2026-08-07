import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	ADDED_PATHS,
	DECLARED_DECISION,
	LOG_ROOT,
	PLANNED_TAG,
	POST_MERGE_STEPS,
	REQUIRED_MUTATIONS,
	SEALED_ACCEPTANCE_ITEMS,
	SEALED_BUDGET_FAMILIES,
	SEALED_SCAN_FAMILIES,
	STAGE_ELEVEN_COMMAND_IDS,
	STAGE_TEN_E_MERGE_SHA,
	validateStageElevenEvidence,
	validateStageElevenEvidenceValue,
} from "../stage-eleven-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const RECORD = resolve(ROOT, "evidence/stage-11-release.json");
const SCHEMA = resolve(ROOT, "evidence/stage-11-release.schema.json");

type JsonRecord = Record<string, unknown>;

async function sealed(): Promise<JsonRecord> {
	return (await Bun.file(RECORD).json()) as JsonRecord;
}

async function schema(): Promise<JsonRecord> {
	return (await Bun.file(SCHEMA).json()) as JsonRecord;
}

/** The sealed record with one field replaced, validated, and never written. */
async function mutated(
	transform: (record: JsonRecord) => JsonRecord,
	expected: string,
): Promise<void> {
	const record = transform(
		JSON.parse(JSON.stringify(await sealed())) as JsonRecord,
	);
	const errors = await validateStageElevenEvidenceValue(
		record,
		await schema(),
		ROOT,
	);
	expect(errors.join("\n")).toContain(expected);
}

describe("Stage 11 final release evidence", () => {
	test("the committed record validates against its own schema and semantics", async () => {
		expect(await validateStageElevenEvidence(ROOT)).toEqual([]);
	}, 60_000);

	test("seals the stage's four negatives rather than describing them", async () => {
		const record = await sealed();
		const rollback = record["rollback"] as JsonRecord;
		const repository = record["repository"] as JsonRecord;
		// Nothing outside the tree, no rebuild, no new job, no lockfile movement.
		// Each of these is a `const` in the schema as well, so the record cannot
		// carry a different value and still parse.
		expect(rollback["outsideTheTree"]).toEqual([]);
		expect(rollback["containerRebuildRequired"]).toBe(false);
		expect(repository["addedJobs"]).toBe(0);
		expect(repository["devcontainerFilesChanged"]).toBe(0);
		expect(repository["lockfileBytesChanged"]).toBe(0);
		// And the capability is null, which is the whole decision: the first
		// surface in the program that is neither gated nor core.
		expect(repository["capability"]).toBeNull();
		expect(
			String(repository["releaseGuardScript"]).startsWith("template:"),
		).toBe(true);
	});

	test("binds every capture to a log pair by digest", async () => {
		const record = await sealed();
		const commands = record["commands"] as JsonRecord[];
		expect(commands.length).toBe(STAGE_ELEVEN_COMMAND_IDS.length);
		for (const entry of commands) {
			expect(entry["status"]).toBe("pass");
			expect(entry["exitCode"]).toBe(0);
			expect(String(entry["stdoutPath"]).startsWith(LOG_ROOT)).toBe(true);
			expect(String(entry["stdoutSha256"])).toMatch(/^[0-9a-f]{64}$/);
			expect(String(entry["stderrSha256"])).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test("refuses a corrupted log digest", async () => {
		// The reference implementation shipped a ledger whose sha256 SHAPE was
		// checked and whose value was never compared to anything. This is the
		// comparison, and flipping one hex digit is what proves it runs.
		await mutated((record) => {
			const commands = record["commands"] as JsonRecord[];
			const first = commands[0] as JsonRecord;
			const digest = String(first["stdoutSha256"]);
			first["stdoutSha256"] =
				`${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
			return record;
		}, "stdout digest drifted");
	}, 60_000);

	test("refuses a record that re-based itself onto another main", async () => {
		await mutated((record) => {
			(record["source"] as JsonRecord)["baseSha"] = "0".repeat(40);
			return record;
		}, "semantic: Stage 11 base is not the Stage 10E merge");
		expect(STAGE_TEN_E_MERGE_SHA).toMatch(/^[0-9a-f]{40}$/);
	}, 60_000);

	test("refuses a released decision and a drifted tag", async () => {
		await mutated((record) => {
			(record["release"] as JsonRecord)["decision"] = "released";
			return record;
		}, "semantic: Stage 11 must ship the candidate decision");
		await mutated((record) => {
			(record["release"] as JsonRecord)["plannedTag"] = "v9.9.9";
			return record;
		}, "semantic: Stage 11 planned tag drifted");
		expect(DECLARED_DECISION).toBe("candidate");
		expect(PLANNED_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
	}, 60_000);

	test("refuses a drifted count on any anti-vacuity anchor", async () => {
		for (const [key, sealedValue] of [
			["scanFamilies", SEALED_SCAN_FAMILIES],
			["acceptanceItems", SEALED_ACCEPTANCE_ITEMS],
			["budgetFamilies", SEALED_BUDGET_FAMILIES],
		] as const) {
			await mutated((record) => {
				(record["release"] as JsonRecord)[key] = sealedValue + 1;
				return record;
			}, "count drifted");
		}
	}, 120_000);

	test("refuses a rollback scope that forgets an added path", async () => {
		await mutated((record) => {
			const rollback = record["rollback"] as JsonRecord;
			rollback["addedPaths"] = (rollback["addedPaths"] as string[]).slice(1);
			return record;
		}, "semantic: Stage 11 added-path set drifted");
		expect([...ADDED_PATHS]).toContain("release.json");
	}, 60_000);

	test("refuses a live job the gate does not need", async () => {
		// Subset identity rather than equality: a lane the gate does not need is
		// a lane this record cannot claim as a required signal.
		await mutated((record) => {
			(record["live"] as JsonRecord)["jobs"] = ["a-lane-nobody-gates-on"];
			return record;
		}, "is not one the gate needs");
	}, 60_000);

	test("refuses a post-merge sequence in another order", async () => {
		await mutated((record) => {
			(record["release"] as JsonRecord)["postMergeSteps"] = [
				...POST_MERGE_STEPS,
			].reverse();
			return record;
		}, "semantic: Stage 11 post-merge sequence drifted");
		// The tag precedes the archive, and that is a decision rather than an
		// accident: tagging the merge commit means the release artefact is the
		// validated tree and never a half-archived one.
		expect(POST_MERGE_STEPS.indexOf("tag-merge-commit")).toBeLessThan(
			POST_MERGE_STEPS.indexOf("archive-change"),
		);
	}, 60_000);

	test("binds its mutation proof by literal fragments and not by interpolation", async () => {
		// Three consecutive stages sealed a sentence built by template
		// interpolation and then could not find it in the log. Every fragment
		// here is a literal substring of a sentence the suite prints.
		for (const fragment of REQUIRED_MUTATIONS)
			expect(fragment.includes("${")).toBe(false);
		const record = await sealed();
		const commands = record["commands"] as JsonRecord[];
		const mutation = commands.find(
			(entry) => entry["id"] === "release-mutations",
		);
		expect(mutation).toBeDefined();
		// The observations are printed rather than asserted-and-discarded, so
		// they land on stdout; the refusal text bun prints on failure lands on
		// stderr and would only be there if the suite were red.
		const log = await Bun.file(
			resolve(ROOT, String(mutation?.["stdoutPath"])),
		).text();
		for (const fragment of REQUIRED_MUTATIONS) expect(log).toContain(fragment);
	}, 60_000);

	test("proves the rollback as two equal tree ids rather than as an intention", async () => {
		const log = await Bun.file(
			resolve(ROOT, `${LOG_ROOT}/rollback-proof.stdout`),
		).text();
		expect(log).toContain("rollbackProven=true");
		expect(log).toContain(`baseSha=${STAGE_TEN_E_MERGE_SHA}`);
		expect(log).toContain("fingerprintInputsChanged=0");
		expect(log).toContain("lockfileChanged=0");
		const base = /baseTree=([0-9a-f]{40})/.exec(log)?.[1];
		const reverted = /revertedTree=([0-9a-f]{40})/.exec(log)?.[1];
		expect(base).toBeDefined();
		expect(reverted).toBe(base as string);
	});

	test("records the live acceptance measurements the host produced", async () => {
		const clean = await Bun.file(
			resolve(ROOT, `${LOG_ROOT}/clean-image-build.stdout`),
		).text();
		const fresh = await Bun.file(
			resolve(ROOT, `${LOG_ROOT}/fresh-startup.stdout`),
		).text();
		const worktrees = await Bun.file(
			resolve(ROOT, `${LOG_ROOT}/two-worktree-isolation.stdout`),
		).text();
		expect(clean).toContain("# exitCode: 0");
		// The first successful lifecycle in the program. Stage 0 recorded fresh
		// startup and readiness as unavailable because neither isolated worktree
		// ever completed one, so this is a baseline rather than a comparison.
		expect(fresh).toContain("# exitCode: 0");
		// Isolation is the claim, and it is two disjoint port sets and two
		// distinct manifests rather than an absence of complaints.
		expect(worktrees).toContain("portsDisjoint=true");
		expect(worktrees).toContain("manifestsDistinct=true");
		expect(worktrees).toContain("bothWorktreesReady=true");
		// The two route probes fail in both slots because `services = []` ships
		// no listener. That is the absence of an application, and the capture
		// classifies it rather than leaving a bare exit code to interpret.
		expect(worktrees).toContain("doctorOneOnlyRouteProbesFailed=true");
		expect(worktrees).toContain("doctorTwoOnlyRouteProbesFailed=true");
	});
});
