// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageFiveCommands,
	validateStageFiveEvidence,
	validateStageFiveEvidenceValue,
} from "../stage-five-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 5A isolated worktree runtime evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageFiveEvidence(ROOT)).toEqual([]);
	});

	test("rejects command, isolation, boundary, cleanup, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-5-worktree.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-5-worktree.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageFiveEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command contract-guard drifted");

		// Two worktrees that share an offset are one worktree wearing two names.
		expect(
			await validateMutation((value) => {
				const worktrees = value["worktrees"] as Array<Record<string, unknown>>;
				if (worktrees[0] && worktrees[1])
					worktrees[1]["offset"] = worktrees[0]["offset"];
			}),
		).toContain("semantic: worktree isolation evidence drifted");

		expect(
			await validateMutation((value) => {
				const worktrees = value["worktrees"] as Array<Record<string, unknown>>;
				if (worktrees[1]) worktrees[1]["devcontainerId"] = "0".repeat(52);
			}),
		).toContain("semantic: worktree isolation evidence drifted");

		expect(
			await validateMutation((value) => {
				const boundary = value["boundary"] as Record<string, unknown>;
				boundary["commandExecuted"] = true;
			}),
		).toContain("semantic: container ownership boundary evidence drifted");

		// A linked worktree's Git metadata lives OUTSIDE the checkout, which is the
		// whole reason the runtime bind mounts it. Claiming a common directory
		// inside the captured worktree root describes a plain clone, not a linked
		// worktree, and must be rejected — without the validator ever consulting
		// the absolute location of the tree it happens to be running in.
		expect(
			await validateMutation((value) => {
				const run = value["run"] as Record<string, unknown>;
				run["temporaryRoot"] = "/Users/mrcr/Code/templates";
			}),
		).toContain(
			"repository: linked-worktree Git evidence differs from its log",
		);

		expect(
			await validateMutation((value) => {
				const cleanup = value["cleanup"] as Record<string, unknown>;
				cleanup["remaining"] = ["container 0123456789ab"];
			}),
		).toContain("semantic: cleanup evidence drifted");

		expect(
			await validateMutation((value) => {
				const ensure = value["ensure"] as Record<string, unknown>;
				ensure["warmDurationMs"] = ensure["coldDurationMs"];
			}),
		).toContain("semantic: container ensure evidence drifted");

		expect(
			await validateMutation((value) => {
				const routing = value["routing"] as Record<string, unknown>;
				routing["friendlyRouteVerified"] = !routing["friendlyRouteVerified"];
			}),
		).toContain("semantic: routing evidence drifted");

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
			resolve(ROOT, "evidence/stage-5-worktree.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageFiveCommands(evidence))).toHaveLength(19);
	});
});
