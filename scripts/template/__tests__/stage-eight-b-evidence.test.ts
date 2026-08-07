// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MOON_AFFECTED_ARGV } from "../graph-contract";
import {
	expectedStageEightBCommands,
	STAGE_EIGHT_B_COMMAND_IDS,
	validateStageEightBEvidence,
	validateStageEightBEvidenceValue,
} from "../stage-eight-b-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-8b-affected-selection.json";
const SCHEMA = "evidence/stage-8b-affected-selection.schema.json";

describe("Stage 8B affected selection evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageEightBEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		expect(Object.keys(expectedStageEightBCommands(evidence))).toHaveLength(
			STAGE_EIGHT_B_COMMAND_IDS.length,
		);
		// The record seals the argv the selector pins, and the query command it
		// recorded is the one built from that argv. A record for some other
		// invocation would be evidence about a command nothing issues.
		const selection = evidence["selection"] as { queryArgv: string[] };
		expect(selection.queryArgv).toEqual([...MOON_AFFECTED_ARGV]);
	});

	test("rejects command, query, selector, render, live and rollback fabrication", async () => {
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
			return await validateStageEightBEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command affected-guard drifted");

		// The pinned argv is the whole point of the reconciliation leg, and it is
		// not a free field: the expected query invocation is DERIVED from it, so a
		// record that widened the argv is immediately a record whose sealed command
		// is not the one that argv produces.
		expect(
			await validateMutation((value) => {
				const selection = value["selection"] as Record<string, unknown>;
				selection["queryArgv"] = ["query", "projects", "--affected", "--json"];
			}),
		).toContain("semantic: command moon-affected-query drifted");

		// The empty-stdin hazard is sealed in both directions. A record claiming
		// moon answered nothing on a dirty tree would be claiming the guard this
		// selector is built around is unnecessary.
		expect(
			await validateMutation((value) => {
				const selection = value["selection"] as Record<string, unknown>;
				selection["emptyStdinDirtyProjects"] = "";
			}),
		).toContain("semantic: Stage 8B moon affected-query evidence drifted");

		// A leaf and the deepest library reaching the same set would mean
		// `--downstream deep` was doing nothing.
		expect(
			await validateMutation((value) => {
				const selection = value["selection"] as Record<string, unknown>;
				selection["leafProjects"] = selection["deepProjects"];
			}),
		).toContain("semantic: Stage 8B moon affected-query evidence drifted");

		// The selector's own answers are what the record is about. A documentation
		// change that selected something would be the capability doing the one
		// thing it must never do.
		expect(
			await validateMutation((value) => {
				const selector = value["selector"] as Record<string, unknown>;
				const cases = selector["cases"] as Array<Record<string, unknown>>;
				const docs = cases.find((entry) => entry["name"] === "docs");
				if (docs) docs["selected"] = ["web"];
			}),
		).toContain("semantic: Stage 8B selector evidence drifted");

		// ... and moon must never be consulted for one, because an empty file list
		// makes it answer from the working tree instead.
		expect(
			await validateMutation((value) => {
				const selector = value["selector"] as Record<string, unknown>;
				const cases = selector["cases"] as Array<Record<string, unknown>>;
				const docs = cases.find((entry) => entry["name"] === "docs");
				if (docs) docs["moonConsulted"] = true;
			}),
		).toContain("semantic: Stage 8B selector evidence drifted");

		// Capability isolation is the claim a leaked module would falsify.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["modeTokenPresent"] = true;
			}),
		).toContain("semantic: rendered minimal selection evidence drifted");

		// ... and so, in the opposite direction, is a project that lost its heavy
		// lane. That is the failure fencing the two jobs would have caused.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["heavyLanePresent"] = false;
			}),
		).toContain("semantic: rendered cloud selection evidence drifted");

		// The documentation-only cycle is the only thing in this record that says
		// the capability does anything at all: an empty matrix and a skipped lane.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const docs = live["live-gate-docs"];
				if (docs) docs["heavyLaneRan"] = true;
			}),
		).toContain("semantic: live live-gate-docs evidence drifted");

		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const docs = live["live-gate-docs"];
				if (docs) docs["universeLine"] = "ci = [root]";
			}),
		).toContain("semantic: live live-gate-docs evidence drifted");

		// The shadow narration exists exactly while the variable is unset.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const full = live["live-gate-full"];
				if (full) full["shadowNarration"] = false;
			}),
		).toContain("semantic: live live-gate-full evidence drifted");

		// The flip is a variable change and nothing else: the two cycles that
		// bracket it ran against the same tree.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const moon = live["live-gate-moon"] as {
					run: Record<string, unknown>;
				};
				moon.run["headSha"] = "0".repeat(40);
			}),
		).toContain("semantic: the live cycles did not bracket the mode flip");

		// The gate identity still has to name both new lanes.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = (repository["gateNeeds"] as string[]).filter(
					(need) => need !== "project",
				);
			}),
		).toContain("semantic: recorded gate identity is not the committed one");

		// This is the first stage with something outside the tree, and the order
		// of the rollback is part of the record rather than part of the prose.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				rollback["outsideTheTree"] = [];
			}),
		).toContain("semantic: Stage 8B rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
