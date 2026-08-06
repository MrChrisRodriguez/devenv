// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageFiveBCommands,
	validateStageFiveBEvidence,
	validateStageFiveBEvidenceValue,
} from "../stage-five-b-evidence";

const ROOT = resolve(import.meta.dir, "../../..");

describe("Stage 5B entrypoint cutover evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageFiveBEvidence(ROOT)).toEqual([]);
	});

	test("rejects command, routing, refusal, cleanup, and rollback fabrication", async () => {
		const original = (await Bun.file(
			resolve(ROOT, "evidence/stage-5b-cutover.json"),
		).json()) as Record<string, unknown>;
		const schema = (await Bun.file(
			resolve(ROOT, "evidence/stage-5b-cutover.schema.json"),
		).json()) as Record<string, unknown>;
		const validateMutation = async (
			mutate: (value: Record<string, unknown>) => void,
		): Promise<string[]> => {
			const value = structuredClone(original);
			mutate(value);
			return validateStageFiveBEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command cutover-guard drifted");

		// A hook that ran on the host proves nothing about the cutover: the whole
		// point is that project tooling now runs in the container this checkout owns.
		expect(
			await validateMutation((value) => {
				const journey = value["journey"] as Record<string, unknown>;
				journey["hookExecutionOs"] = "Darwin";
			}),
		).toContain("semantic: hook routing evidence drifted");

		expect(
			await validateMutation((value) => {
				const journey = value["journey"] as Record<string, unknown>;
				journey["hookContainerId"] = "0".repeat(64);
			}),
		).toContain("semantic: hook routing evidence drifted");

		expect(
			await validateMutation((value) => {
				const boundary = value["boundary"] as Record<string, unknown>;
				boundary["commandExecuted"] = true;
			}),
		).toContain("semantic: refusal evidence drifted");

		// The journey clone and its isolated HOME are derived from the recorded
		// temporary root, so a record cannot claim a journey that ran somewhere
		// else — and the validator never consults the tree it is running in.
		expect(
			await validateMutation((value) => {
				const run = value["run"] as Record<string, unknown>;
				run["temporaryRoot"] = "/private/tmp/devenv-stage5b-stage5b-elsewhere";
			}),
		).toContain("semantic: fresh-clone evidence drifted");

		// The real checkout's registry, manifests, and routes have to be identical
		// before and after; a second clone that touched them is the failure mode
		// the isolated HOME exists to prevent.
		expect(
			await validateMutation((value) => {
				const cleanup = value["cleanup"] as Record<string, unknown>;
				cleanup["mainCheckoutStateDigest"] = "0".repeat(64);
			}),
		).toContain("semantic: cleanup evidence drifted");

		expect(
			await validateMutation((value) => {
				const legacy = value["legacy"] as Record<string, unknown>;
				legacy["allowListed"] = [];
			}),
		).toContain("semantic: legacy orchestration scan evidence drifted");

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
			resolve(ROOT, "evidence/stage-5b-cutover.json"),
		).json()) as Record<string, unknown>;
		expect(Object.keys(expectedStageFiveBCommands(evidence))).toHaveLength(15);
	});
});
