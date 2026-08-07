// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageNineCommands,
	REQUIRED_MUTATIONS,
	REQUIRED_VALIDATIONS,
	STAGE_NINE_COMMAND_IDS,
	validateStageNineEvidence,
	validateStageNineEvidenceValue,
} from "../stage-nine-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-9-openspec.json";
const SCHEMA = "evidence/stage-9-openspec.schema.json";

describe("Stage 9 OpenSpec lifecycle evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageNineEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageNineCommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_NINE_COMMAND_IDS.length);
		// The three validations the record pins are the package scripts this stage
		// exposes, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		const suite = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/openspec.test.ts"),
		).text();
		for (const verdict of REQUIRED_MUTATIONS) expect(suite).toContain(verdict);
	});

	test("rejects command, guard, lifecycle, render, live and rollback fabrication", async () => {
		const original = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const schema = (await Bun.file(resolve(ROOT, SCHEMA)).json()) as Record<
			string,
			unknown
		>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return await validateStageNineEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command openspec-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const openspec = guards["openspec"];
				if (openspec) openspec["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard openspec evidence drifted");

		// A suite with no passing tests is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const refusals = guards["archiveRefusals"];
				if (refusals) refusals["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite archive-refusals drifted");

		// The half of an archive that is not a directory move. A lifecycle that
		// moved the change without applying its delta specs is the exact failure
		// a mis-passed --skip-specs produces.
		expect(
			await validateMutation((value) => {
				const lifecycle = value["lifecycle"] as Record<string, unknown>;
				const result = lifecycle["result"] as Record<string, unknown>;
				result["mainSpecRequirementApplied"] = false;
			}),
		).toContain("semantic: Stage 9 lifecycle proof is not complete");

		// The second, unfinished change is the property that makes the wrapper
		// safe to run against a tree with work in flight.
		expect(
			await validateMutation((value) => {
				const lifecycle = value["lifecycle"] as Record<string, unknown>;
				const result = lifecycle["result"] as Record<string, unknown>;
				result["secondChangeUntouched"] = false;
			}),
		).toContain("semantic: Stage 9 lifecycle proof is not complete");

		// The duplicate-destination refusal is the one the CLI reports as success.
		expect(
			await validateMutation((value) => {
				const lifecycle = value["lifecycle"] as Record<string, unknown>;
				const result = lifecycle["result"] as Record<string, unknown>;
				result["secondRunExitCode"] = 0;
			}),
		).toContain("semantic: Stage 9 lifecycle proof is not complete");

		// The standing constraint, and the one claim this record must never be
		// able to make falsely.
		expect(
			await validateMutation((value) => {
				const lifecycle = value["lifecycle"] as Record<string, unknown>;
				const result = lifecycle["result"] as Record<string, unknown>;
				result["templateChangeStillActive"] = false;
			}),
		).toContain("semantic: Stage 9 lifecycle proof is not complete");

		// A lifecycle claim that its bound log does not carry.
		expect(
			await validateMutation((value) => {
				const lifecycle = value["lifecycle"] as Record<string, unknown>;
				const result = lifecycle["result"] as Record<string, unknown>;
				result["committedPathCount"] = 999;
			}),
		).toContain("semantic: Stage 9 lifecycle evidence drifted");

		// Capability isolation, in both directions: a leaked surface, and a
		// project that lost the CORE cross-agent rules step.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["openspecStepPresent"] = true;
			}),
		).toContain("semantic: rendered cloud lifecycle evidence drifted");

		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal)
					minimal["packageScripts"] = (
						minimal["packageScripts"] as string[]
					).filter((name) => name !== "rules:check");
			}),
		).toContain("semantic: rendered minimal lifecycle evidence drifted");

		// The fourteen artifacts are a shape, not a number somebody typed.
		expect(
			await validateMutation((value) => {
				const artifacts = value["vendorArtifacts"] as Record<string, unknown>;
				artifacts["replaced"] = [".claude/commands/opsx/archive.md"];
			}),
		).toContain("semantic: Stage 9 generated-artifact evidence drifted");

		// The live capture is a fact about the reviewed boundary and nothing else.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const gate = live["live-gate"] as { run: Record<string, unknown> };
				gate.run["headSha"] = "0".repeat(40);
			}),
		).toContain("semantic: live live-gate evidence drifted");

		// Every sealed dependency has to have reported, which is what makes a
		// green gate mean the lanes ran rather than that the gate was happy.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const gate = live["live-gate"] as { run: Record<string, unknown> };
				gate.run["upstreamResults"] = "success";
			}),
		).toContain("semantic: live live-gate evidence drifted");

		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = [
					...(repository["gateNeeds"] as string[]),
					"a-lane-that-does-not-exist",
				];
			}),
		).toContain("semantic: recorded gate identity is not the committed one");

		// Nothing about this stage lives outside the tree, and claiming otherwise
		// would invent an operator step nobody has to take.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				rollback["outsideTheTree"] = ["some repository variable"];
			}),
		).toContain("semantic: Stage 9 rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
