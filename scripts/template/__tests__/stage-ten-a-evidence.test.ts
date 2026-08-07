// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageTenACommands,
	MUTATION_LEGS,
	REQUIRED_CI_MUTATIONS,
	REQUIRED_MUTATIONS,
	REQUIRED_VALIDATIONS,
	STAGE_TEN_A_COMMAND_IDS,
	validateStageTenAEvidence,
	validateStageTenAEvidenceValue,
} from "../stage-ten-a-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-10a-api-contract.json";
const SCHEMA = "evidence/stage-10a-api-contract.schema.json";

describe("Stage 10A shared schema and API contract evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageTenAEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageTenACommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_TEN_A_COMMAND_IDS.length);
		// The two validations the record pins are the package scripts this stage
		// exposes and extends, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		const forms = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/forms.test.ts"),
		).text();
		for (const verdict of REQUIRED_MUTATIONS) expect(forms).toContain(verdict);
		const ci = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/ci.test.ts"),
		).text();
		for (const verdict of REQUIRED_CI_MUTATIONS) expect(ci).toContain(verdict);
	});

	test("every leg filter still names a test that exists", async () => {
		// A `-t` filter that matches nothing is a green run over an empty set,
		// which is the one way a per-leg capture can lie about what it exercised.
		const forms = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/forms.test.ts"),
		).text();
		for (const pattern of Object.values(MUTATION_LEGS))
			expect(forms).toContain(pattern);
	});

	test("rejects command, guard, suite, render, live and rollback fabrication", async () => {
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
			return await validateStageTenAEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command forms-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const forms = guards["forms"];
				if (forms) forms["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard forms evidence drifted");

		// A leg whose filter matched nothing is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const suites = value["suites"] as Array<Record<string, unknown>>;
				const leg = suites.find(
					(entry) => entry["commandId"] === "browser-safety-matrix",
				);
				if (leg) leg["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite browser-safety-matrix drifted");

		// The declared mode is the hinge the whole guard turns on, and the record
		// is making a claim about the registry as it stood at capture time.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["declaredMode"] = "active";
			}),
		).toContain("semantic: the sealed declared mode drifted");

		// Capability isolation, in both directions: a leaked step where the
		// capability is off, and a lost script where it is on.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["formsStepPresent"] = true;
			}),
		).toContain("semantic: rendered cloud contract evidence drifted");

		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const full = fixtures.find((entry) => entry["name"] === "full");
				if (full)
					full["packageScripts"] = (full["packageScripts"] as string[]).filter(
						(name) => name !== "forms:check",
					);
			}),
		).toContain("semantic: rendered full contract evidence drifted");

		// The three-character residue token is the fact that shaped the stage. A
		// render that carried it anywhere is the failure this record exists to
		// have looked for.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["schemaLibraryTokenFiles"] = 1;
			}),
		).toContain("semantic: rendered minimal contract evidence drifted");

		// Adding a job is the thing this stage promised not to do: Stage 8A's new
		// lane turned a green historical capture into a reported fabrication.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["addedJobs"] = 1;
			}),
		).toContain("semantic: Stage 10A must add no job to the required lane");

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
		).toContain("semantic: Stage 10A rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
