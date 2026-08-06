// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageSixCommands,
	validateStageSixEvidence,
	validateStageSixEvidenceValue,
} from "../stage-six-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 6 worktree doctor evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageSixEvidence(ROOT)).toEqual([]);
	});

	test("rejects command, inventory, refusal, non-mutation, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-6-doctor.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-6-doctor.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageSixEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command doctor-guard drifted");

		// The inventory is the doctor's published contract. A record whose order
		// disagrees with the guard, the flag, or the report is not describing the
		// script this repository ships.
		expect(
			await validateMutation((value) => {
				const doctor = value["doctor"] as Record<string, unknown>;
				const ids = [...(doctor["checkIds"] as string[])];
				[ids[0], ids[1]] = [ids[1] as string, ids[0] as string];
				doctor["checkIds"] = ids;
			}),
		).toContain("semantic: doctor check inventory drifted");

		// The whole stage rests on this digest pair. A record that claims the host
		// changed under a read-only command is describing a different command.
		expect(
			await validateMutation((value) => {
				const nonMutation = value["nonMutation"] as Record<string, unknown>;
				nonMutation["afterDigest"] = "0".repeat(64);
			}),
		).toContain("semantic: non-mutation evidence drifted");

		// A refusal that executed is not a refusal.
		expect(
			await validateMutation((value) => {
				const refusals = value["refusals"] as Array<Record<string, unknown>>;
				if (refusals[0]) refusals[0]["commandExecuted"] = true;
			}),
		).toContain("semantic: refusal evidence drifted");

		// Two throwaway worktrees that shared a port would prove the opposite of
		// what this record claims.
		expect(
			await validateMutation((value) => {
				const worktrees = value["worktrees"] as Array<Record<string, unknown>>;
				if (worktrees[1] && worktrees[0])
					worktrees[1]["publishedHostPort"] = worktrees[0]["publishedHostPort"];
			}),
		).toContain("semantic: journey worktree evidence drifted");

		// --strict changes the exit code and nothing else; a record claiming a
		// different checks array is claiming a different flag.
		expect(
			await validateMutation((value) => {
				const strict = value["strict"] as Record<string, unknown>;
				strict["checksIdentical"] = false;
			}),
		).toContain("semantic: strict exit modifier evidence drifted");

		expect(
			await validateMutation((value) => {
				const collision = value["collision"] as Record<string, unknown>;
				collision["afterDigest"] = "0".repeat(64);
			}),
		).toContain("semantic: duplicate port claim evidence drifted");

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
			resolve(ROOT, "evidence/stage-6-doctor.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageSixCommands(evidence))).toHaveLength(17);
	});
});
