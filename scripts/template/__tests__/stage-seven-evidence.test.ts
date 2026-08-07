// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	expectedStageSevenCommands,
	validateStageSevenEvidence,
	validateStageSevenEvidenceValue,
} from "../stage-seven-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const CI_WORKFLOW = ".github/workflows/ci.yml";

// The gate's dependency list, read the way the validator reads it. Duplicated
// here rather than exported, because a test that imported the function under
// test would agree with it by construction.
function gateNeedsOf(source: string): string[] {
	const value = Bun.YAML.parse(source) as Record<string, unknown>;
	const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
	const needs = jobs["ci-gate"]?.["needs"];
	return Array.isArray(needs)
		? needs.filter((entry): entry is string => typeof entry === "string")
		: [];
}

describe("Stage 7 CI bootstrap evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageSevenEvidence(ROOT)).toEqual([]);
	});

	// A later stage may add a gating job; this record is still a true statement
	// about the three lanes that existed when it was captured. Re-resolving its
	// run shape against the current workflow reported a green historical capture
	// as fabrication the moment Stage 8A added `moon-graph`, with the only repair
	// being to re-run three live workflows for a claim nothing had falsified.
	test("accepts a gate that grew a lane after the capture", async () => {
		const evidence = (await Bun.file(
			resolve(ROOT, "evidence/stage-7-ci.json"),
		).json()) as { repository: { gateNeeds: string[] } };
		const workflow = await Bun.file(resolve(ROOT, CI_WORKFLOW)).text();
		const current = gateNeedsOf(workflow);
		// The premise of this test, asserted rather than assumed: the committed
		// gate is a STRICT superset of the sealed one.
		for (const need of evidence.repository.gateNeeds)
			expect(current).toContain(need);
		expect(current.length).toBeGreaterThan(
			evidence.repository.gateNeeds.length,
		);
		expect(await validateStageSevenEvidence(ROOT)).toEqual([]);
	});

	// The other direction is not growth. A sealed lane the gate no longer
	// declares means this record's runs are evidence for a workflow the
	// repository stopped shipping.
	test("rejects a gate that dropped a sealed lane", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-stage7-"));
		try {
			// Only what the validator reads out of the tree: the sealed logs and
			// the committed workflow. Everything else is absent on purpose, so the
			// control below is what proves the verdict came from the mutation.
			await cp(
				resolve(ROOT, "evidence/stage-7-ci-run"),
				resolve(temporary, "evidence/stage-7-ci-run"),
				{ recursive: true },
			);
			await mkdir(resolve(temporary, ".github/workflows"), { recursive: true });
			const original = await Bun.file(resolve(ROOT, CI_WORKFLOW)).text();
			const value = (await Bun.file(
				resolve(ROOT, "evidence/stage-7-ci.json"),
			).json()) as Record<string, unknown>;
			const schema = (await Bun.file(
				resolve(ROOT, "evidence/stage-7-ci.schema.json"),
			).json()) as Record<string, unknown>;
			const identity =
				"semantic: recorded gate identity is not the committed one";

			await Bun.write(resolve(temporary, CI_WORKFLOW), original);
			expect(
				await validateStageSevenEvidenceValue(value, schema, temporary),
			).not.toContain(identity);

			await Bun.write(
				resolve(temporary, CI_WORKFLOW),
				original.replace(
					"      # capability:start playwright\n      - browser\n      # capability:end playwright\n",
					"",
				),
			);
			expect(
				await validateStageSevenEvidenceValue(value, schema, temporary),
			).toContain(identity);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("rejects command, gate, live-run, protection, and coverage fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-7-ci.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-7-ci.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageSevenEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command ci-guard drifted");

		// The gate's decision table is the whole contract. A record claiming a
		// failing upstream result was tolerated is describing a different script.
		expect(
			await validateMutation((value) => {
				const semantics = value["gateSemantics"] as Record<string, unknown>;
				const cases = semantics["cases"] as Array<Record<string, unknown>>;
				const failing = cases.find(
					(entry) => entry["name"] === "ready-one-job-failed",
				);
				if (failing) failing["observedExitCode"] = 0;
			}),
		).toContain("semantic: gate case ready-one-job-failed drifted");

		// The green run is the only thing in this record that says the gate can go
		// green at all, and it has to say so about the reviewed commit.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				if (live["green"]) live["green"]["gateConclusion"] = "failure";
			}),
		).toContain("semantic: live green run evidence drifted");

		// The negative control only means something if exactly one job failed and
		// the gate failed because of it.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				if (live["red"]) live["red"]["failedJob"] = "Build devcontainer image";
			}),
		).toContain("semantic: live red run evidence drifted");

		// A draft whose gate read upstream results at all did not fail closed: it
		// reached the results check, which on an all-skipped run would pass.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				if (live["draft"])
					live["draft"]["upstreamResults"] = "success,success,success";
			}),
		).toContain("semantic: live draft run evidence drifted");

		// Branch protection matches a job's DISPLAY name. A record naming the job id
		// would describe a required check that no run ever reports.
		expect(
			await validateMutation((value) => {
				const protection = value["branchProtection"] as Record<string, unknown>;
				protection["contexts"] = ["ci-gate"];
			}),
		).toContain("semantic: branch protection evidence drifted");

		// The one declared not-applicable category is the honest part of the map.
		// Promoting it to "proven" without a command is the vacuous claim this
		// record exists to make impossible.
		expect(
			await validateMutation((value) => {
				const coverage = value["coverage"] as Array<Record<string, unknown>>;
				const declared = coverage.find(
					(entry) => entry["id"] === "service-readiness-probes",
				);
				if (declared) declared["status"] = "proven";
			}),
		).toContain("semantic: Stage 7 coverage map drifted");

		// The run shape is anchored on the record's OWN gateNeeds, so the record
		// still has to agree with itself: three sealed runs that each reported
		// three upstream jobs cannot belong to a gate the same record says had
		// two.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = (repository["gateNeeds"] as string[]).slice(
					1,
				);
			}),
		).toContain("semantic: live green run evidence drifted");

		// And a sealed lane the committed gate never declares is a record about
		// some other workflow, whichever direction the disagreement runs in.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = [
					...(repository["gateNeeds"] as string[]),
					"ghost",
				];
			}),
		).toContain("semantic: recorded gate identity is not the committed one");

		// A minimal render has no browser job, so a gate that needed one would
		// depend on a job that is not there.
		expect(
			await validateMutation((value) => {
				const graph = value["renderGraph"] as Record<string, unknown>;
				const fixtures = graph["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal)
					minimal["gateNeeds"] = [
						...(minimal["gateNeeds"] as string[]),
						"browser",
					];
			}),
		).toContain("semantic: rendered workflow graph evidence drifted");

		// A mutation suite that reported failures is not a passing suite.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				if (guards["mutations"]) guards["mutations"]["passCount"] = 99;
			}),
		).toContain("semantic: workflow guard evidence drifted");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(
			resolve(ROOT, "evidence/stage-7-ci.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageSevenCommands(evidence))).toHaveLength(9);
	});
});
