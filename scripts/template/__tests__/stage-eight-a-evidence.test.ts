// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MOON_QUERY_ARGV } from "../graph-contract";
import {
	expectedStageEightACommands,
	STAGE_EIGHT_A_COMMAND_IDS,
	validateStageEightAEvidence,
	validateStageEightAEvidenceValue,
} from "../stage-eight-a-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 8A moon graph evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageEightAEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(
			resolve(ROOT, "evidence/stage-8a-moon-graph.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageEightACommands(evidence))).toHaveLength(
			STAGE_EIGHT_A_COMMAND_IDS.length,
		);
		// The record seals the argv the guard pins, and the moon-query command it
		// recorded is the one built from that argv. A record for some other
		// invocation would be evidence about a command nothing issues.
		const graph = evidence["graph"] as { queryArgv: string[] };
		expect(graph.queryArgv).toEqual([...MOON_QUERY_ARGV]);
	});

	test("rejects command, graph, registry, render, gate, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-8a-moon-graph.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-8a-moon-graph.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return await validateStageEightAEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command graph-guard drifted");

		// The pinned argv is the whole point of the live leg, and it is not a free
		// field: the expected moon-query invocation is DERIVED from it, so a
		// record that widened the argv is immediately a record whose sealed
		// command is not the one that argv produces.
		expect(
			await validateMutation((value) => {
				const graph = value["graph"] as Record<string, unknown>;
				graph["queryArgv"] = ["query", "projects", "--json"];
			}),
		).toContain("semantic: command moon-query drifted");

		// The sealed graph is what moon printed, not what the record wishes it
		// had printed.
		expect(
			await validateMutation((value) => {
				const graph = value["graph"] as Record<string, unknown>;
				const projects = graph["projects"] as Array<Record<string, unknown>>;
				projects.push({ id: "ghost", source: "apps/ghost" });
			}),
		).toContain("semantic: Stage 8A graph evidence drifted");

		// Every project belongs to exactly one universe. A project the registry
		// forgets is a project no lane ever builds.
		expect(
			await validateMutation((value) => {
				const registry = value["registry"] as Record<string, unknown>;
				const universes = registry["universes"] as Array<
					Record<string, unknown>
				>;
				if (universes[0]) universes[0]["projects"] = ["ghost"];
			}),
		).toContain("semantic: Stage 8A universe registry evidence drifted");

		// The toolchain the live legs ran against has to agree with the pin the
		// same record carries.
		expect(
			await validateMutation((value) => {
				const host = value["host"] as Record<string, unknown>;
				host["moonVersion"] = "9.9.9";
			}),
		).toContain("semantic: Stage 8A toolchain evidence drifted");

		// Capability isolation is the claim a leaked registry would falsify.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["registryPresent"] = true;
			}),
		).toContain("semantic: rendered minimal graph evidence drifted");

		// ... and so is a gating job a project without the capability received.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud)
					cloud["gateNeeds"] = [
						...(cloud["gateNeeds"] as string[]),
						"moon-graph",
					];
			}),
		).toContain("semantic: rendered cloud graph evidence drifted");

		// The live run is the only thing in this record that says the graph
		// oracle can gate at all, and it has to say so about the reviewed commit.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				if (live["gate"]) live["gate"]["gateConclusion"] = "failure";
			}),
		).toContain("semantic: live gate run evidence drifted");

		// A run that reported fewer jobs than the gate depended on is a run in
		// which a lane silently did not report.
		expect(
			await validateMutation((value) => {
				const live = value["live"] as Record<string, Record<string, unknown>>;
				const gate = live["gate"] as Record<string, unknown>;
				gate["jobs"] = (gate["jobs"] as unknown[]).slice(1);
			}),
		).toContain("semantic: live gate run evidence drifted");

		// The gate identity still has to name the graph job.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["gateNeeds"] = (repository["gateNeeds"] as string[]).filter(
					(need) => need !== "moon-graph",
				);
			}),
		).toContain("semantic: recorded gate identity is not the committed one");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
