// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageThreeCommands,
	validateStageThreeEvidence,
	validateStageThreeEvidenceValue,
} from "../stage-three-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 3 runtime evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageThreeEvidence(ROOT)).toEqual([]);
	});

	test("rejects command, pin, observation, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-3-runtimes.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-3-runtimes.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageThreeEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command warm-browser-build drifted");

		expect(
			await validateMutation((value) => {
				const pins = (value["image"] as Record<string, unknown>)[
					"pins"
				] as Record<string, unknown>;
				pins["playwright"] = "1.59.2";
			}),
		).toContain(
			"repository: Playwright evidence differs from package/Docker authority",
		);

		expect(
			await validateMutation((value) => {
				const comparison = value["comparison"] as Record<string, unknown>;
				comparison["secondWorktreeObservedBytes"] = 0;
			}),
		).toContain(
			"repository: performance/storage evidence differs from its bound logs",
		);

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
			resolve(ROOT, "evidence/stage-3-runtimes.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageThreeCommands(evidence))).toHaveLength(14);
	});
});
