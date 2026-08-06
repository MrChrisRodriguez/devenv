// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageFourCommands,
	validateStageFourEvidence,
	validateStageFourEvidenceValue,
} from "../stage-four-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 4 Codex Cloud evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageFourEvidence(ROOT)).toEqual([]);
	});

	test("rejects command, pin, boundary, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-4-cloud.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-4-cloud.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageFourEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command contract-guard drifted");

		expect(
			await validateMutation((value) => {
				const tools = (value["contract"] as Record<string, unknown>)[
					"tools"
				] as Record<string, unknown>;
				tools["bun"] = "1.3.14";
			}),
		).toContain("repository: cloud pin evidence differs from its authority");

		expect(
			await validateMutation((value) => {
				const boundary = value["boundary"] as Record<string, unknown>;
				boundary["commandExecuted"] = true;
			}),
		).toContain("semantic: cloud execution boundary evidence drifted");

		expect(
			await validateMutation((value) => {
				const idempotency = value["idempotency"] as Record<string, unknown>;
				idempotency["fingerprint"] = "0".repeat(64);
			}),
		).toContain(
			"repository: bootstrap idempotency evidence differs from its bound logs",
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
			resolve(ROOT, "evidence/stage-4-cloud.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageFourCommands(evidence))).toHaveLength(13);
	});
});
