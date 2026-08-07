// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageTenECommands,
	MUTATION_LEGS,
	REQUIRED_MUTATIONS,
	REQUIRED_VALIDATIONS,
	RESERVED_DIRECTORIES,
	SEALED_POLICY,
	SEALED_SURFACE_COUNT,
	STAGE_TEN_E_COMMAND_IDS,
	validateStageTenEEvidence,
	validateStageTenEEvidenceValue,
} from "../stage-ten-e-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-10e-experiments.json";
const SCHEMA = "evidence/stage-10e-experiments.schema.json";
const EXPERIMENT_TEST = "scripts/template/__tests__/experiment.test.ts";
const REGISTRY = "experiments.json";

describe("Stage 10E experiment hygiene evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageTenEEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageTenECommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_TEN_E_COMMAND_IDS.length);
		// The two validations the record pins are the package scripts this stage
		// exposes and reconciles against, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		// The sealed diagnostics are literal FRAGMENTS rather than whole sentences,
		// and that is not laziness: every refusal this guard produces names an
		// experiment id AND a surface path, so it is assembled with template
		// interpolation and the complete sentence never appears anywhere in the
		// suite's source. Sealing it would bind the record to a string no file
		// contains — which is what the two previous stages' collectors caught
		// before they wrote anything.
		const source = await Bun.file(resolve(ROOT, EXPERIMENT_TEST)).text();
		for (const verdict of REQUIRED_MUTATIONS) expect(source).toContain(verdict);
	});

	test("every leg filter still names a test that exists", async () => {
		// A `-t` filter that matches nothing is a green run over an empty set,
		// which is the one way a per-leg capture can lie about what it exercised.
		for (const leg of Object.values(MUTATION_LEGS)) {
			const source = await Bun.file(resolve(ROOT, leg.testFile)).text();
			expect(source).toContain(leg.pattern);
		}
	});

	test("the sealed policy is the committed one, surface for surface", async () => {
		// The stage's deliverable is this block rather than a list of experiments.
		// With `experiments: []` a record that sealed the count of experiments
		// would seal zero and prove nothing at all.
		const registry = (await Bun.file(resolve(ROOT, REGISTRY)).json()) as {
			mode: string;
			policy: Record<string, unknown>;
			experiments: unknown[];
			retired: unknown[];
		};
		expect(registry.mode).toBe("skeleton");
		expect(registry.experiments).toEqual([]);
		expect(registry.retired).toEqual([]);
		expect(registry.policy).toEqual(
			JSON.parse(JSON.stringify(SEALED_POLICY)) as Record<string, unknown>,
		);
		expect(registry.policy["reservedDirectories"]).toEqual(
			JSON.parse(JSON.stringify(RESERVED_DIRECTORIES)) as unknown,
		);
		expect(SEALED_SURFACE_COUNT).toBe(7);
	});

	test("the record seals declared values rather than one machine's numbers", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as {
			source: Record<string, unknown>;
			repository: Record<string, unknown>;
			surfaces: Record<string, unknown>;
		};
		expect(evidence.source["surfaceCount"]).toBe(7);
		expect(evidence.source["lockfileBytesChanged"]).toBe(0);
		expect(evidence.source["workspaceDirectoriesAdded"]).toBe(0);
		expect(evidence.surfaces["scanned"]).toBe(7);
		expect(evidence.repository["addedJobs"]).toBe(0);
		expect(evidence.repository["devcontainerFilesChanged"]).toBe(0);
		expect(evidence.repository["huskyFilesChanged"]).toBe(0);
		// The decision the whole stage turns on, sealed as a value rather than left
		// implicit in the absence of a field.
		expect(evidence.repository["capability"]).toBeNull();
	});

	test("rejects command, guard, surface, render, live and rollback fabrication", async () => {
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
			return await validateStageTenEEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command experiment-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const guard = guards["experiment"];
				if (guard) guard["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard experiment evidence drifted");

		// A leg whose filter matched nothing is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const suites = value["suites"] as Array<Record<string, unknown>>;
				const leg = suites.find(
					(entry) => entry["commandId"] === "retirement-residue",
				);
				if (leg) leg["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite retirement-residue drifted");

		// The deliverable. A policy that no longer matches the committed registry
		// describes a tree that does not exist.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				const policy = source["policy"] as Record<string, unknown>;
				policy["workspaceGlobs"] = ["apps/*"];
			}),
		).toContain(
			"semantic: the sealed exception-surface policy is not the committed one",
		);
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				const reserved = source["reservedDirectories"] as Array<
					Record<string, unknown>
				>;
				if (reserved[0]) reserved[0]["ownershipPattern"] = "libs/**";
			}),
		).toContain("semantic: the sealed reserved directories drifted");

		// The anti-vacuity anchor. Seven surfaces inspected is the claim; any other
		// number is a different guard.
		expect(
			await validateMutation((value) => {
				const surfaces = value["surfaces"] as Record<string, unknown>;
				surfaces["scanned"] = 6;
			}),
		).toContain("semantic: the sealed surface count is not 7");
		expect(
			await validateMutation((value) => {
				const surfaces = value["surfaces"] as Record<string, unknown>;
				surfaces["inspected"] = [
					"universe",
					"ci",
					"ignore",
					"formatter",
					"typecheck",
					"moon",
					"manifest",
				];
			}),
		).toContain(
			"repository: the seven exception surfaces no longer inspect clean",
		);

		// The lockfile and the empty workspace, which are what make this a rule
		// rather than a pin and a contract rather than a seed.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["lockfileBytesChanged"] = 12;
			}),
		).toContain("semantic: Stage 10E changed the lockfile");
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["workspaceDirectoriesAdded"] = 1;
			}),
		).toContain("semantic: Stage 10E added a workspace directory");

		// Core, not capability — asserted in the INVERSE direction of every stage
		// since 10A. A render that lost the guard is the failure; a render that
		// carried it is the point.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["guardStepPresent"] = false;
			}),
		).toContain("semantic: rendered minimal experiment evidence drifted");
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["corePaths"] = ["experiments.json"];
			}),
		).toContain("semantic: rendered cloud experiment evidence drifted");
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const full = fixtures.find((entry) => entry["name"] === "full");
				if (full) full["surfacesScanned"] = 0;
			}),
		).toContain("semantic: rendered full experiment evidence drifted");
		// The negative that must stay empty. There is no signature, so a finding
		// here would mean a later stage gated this surface without moving the
		// record with it.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal)
					minimal["coreResidueFindings"] = [
						{
							capability: "graphify",
							path: "experiments.json",
							signature: "experiments.json",
							kind: "path",
						},
					];
			}),
		).toContain("semantic: rendered minimal experiment evidence drifted");

		// Adding a job is the thing this stage promised not to do: Stage 8A's new
		// lane turned a green historical capture into a reported fabrication.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["addedJobs"] = 1;
			}),
		).toContain("semantic: Stage 10E must add no job to the required lane");

		// The two things that would have cost a container rebuild — and the second
		// is the edit this stage was most tempted to make.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["devcontainerFilesChanged"] = 1;
			}),
		).toContain(
			"semantic: Stage 10E changed a definition fingerprint input under .devcontainer or a git hook",
		);
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["huskyFilesChanged"] = 1;
			}),
		).toContain(
			"semantic: Stage 10E changed a definition fingerprint input under .devcontainer or a git hook",
		);

		// The decision the stage turns on, claimed away.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["capability"] = "experiments";
			}),
		).toContain("semantic: recorded gate identity is not the committed one");

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
		).toContain("semantic: Stage 10E rollback is not complete");

		// ... and the rebuild claim is the one this stage exists to be able to
		// make. Flipping it has to fail rather than quietly widen the cost.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				rollback["containerRebuildRequired"] = true;
			}),
		).toContain("semantic: Stage 10E rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["addedPathsRemoved"] = false;
			}),
		).toContain("semantic: Stage 10E rollback proof drifted");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
