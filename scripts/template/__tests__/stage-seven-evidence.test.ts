// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageSevenCommands,
	validateStageSevenEvidence,
	validateStageSevenEvidenceValue,
} from "../stage-seven-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 7 CI bootstrap evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageSevenEvidence(ROOT)).toEqual([]);
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

		// The live runs are only evidence for the file this repository ships if the
		// gate in that file depends on exactly the jobs those runs reported.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = (repository["gateNeeds"] as string[]).slice(
					1,
				);
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
