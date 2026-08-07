// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	expectedStageTenCCommands,
	HARNESS_BIND_PORT,
	HARNESS_LISTENERS,
	MUTATION_LEGS,
	REQUIRED_MUTATIONS,
	REQUIRED_VALIDATIONS,
	STAGE_TEN_C_COMMAND_IDS,
	validateStageTenCEvidence,
	validateStageTenCEvidenceValue,
} from "../stage-ten-c-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-10c-proxy.json";
const SCHEMA = "evidence/stage-10c-proxy.schema.json";
const HARNESS = "scripts/template/__tests__/fixtures/websocket-harness.ts";

describe("Stage 10C development server and proxy evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageTenCEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageTenCCommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_TEN_C_COMMAND_IDS.length);
		// The three validations the record pins are the package scripts this stage
		// exposes and reconciles against, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		// Every leg points at one suite, and that is not an oversight: this stage
		// adds no core rule at all, so there is no unfenced behaviour for a core
		// suite to exercise.
		const proxy = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/proxy.test.ts"),
		).text();
		for (const verdict of REQUIRED_MUTATIONS) expect(proxy).toContain(verdict);
	});

	test("every leg filter still names a test that exists", async () => {
		// A `-t` filter that matches nothing is a green run over an empty set,
		// which is the one way a per-leg capture can lie about what it exercised.
		for (const leg of Object.values(MUTATION_LEGS)) {
			const source = await Bun.file(resolve(ROOT, leg.testFile)).text();
			expect(source).toContain(leg.pattern);
		}
	});

	test("the harness still binds every listener on an ephemeral port", async () => {
		// The sealed number is the DECLARED bind and never the ephemeral value one
		// run happened to receive. This is the assertion that keeps it honest: the
		// record's claim is checkable against the fixture it describes.
		const harness = await Bun.file(resolve(ROOT, HARNESS)).text();
		expect(harness.split('hostname: "127.0.0.1",').length - 1).toBe(
			HARNESS_LISTENERS,
		);
		expect(harness.split(`port: ${HARNESS_BIND_PORT},`).length - 1).toBe(
			HARNESS_LISTENERS,
		);
	});

	test("no committed log carries an ephemeral port as a sealed value", async () => {
		// The record seals `harnessBindPort: 0`, so nothing in it may quietly carry
		// a real ephemeral port as though it were a declared one.
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as {
			source: Record<string, unknown>;
		};
		expect(evidence.source["harnessBindPort"]).toBe(0);
		expect(evidence.source["publishedContainerPort"]).toBe(8080);
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
			return await validateStageTenCEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command proxy-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const proxy = guards["proxy"];
				if (proxy) proxy["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard proxy evidence drifted");

		// A leg whose filter matched nothing is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const suites = value["suites"] as Array<Record<string, unknown>>;
				const leg = suites.find(
					(entry) => entry["commandId"] === "websocket-handshake",
				);
				if (leg) leg["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite websocket-handshake drifted");

		// The declared mode is the hinge the whole guard turns on, and the record
		// is making a claim about the registry as it stood at capture time.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["declaredMode"] = "active";
			}),
		).toContain("semantic: the sealed declared mode drifted");

		// The published port is the whole reachability argument, and it has three
		// authorities that must agree.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["publishedContainerPort"] = 8081;
			}),
		).toContain(
			"semantic: the published container port is not the one every authority declares",
		);

		// The sealed harness bind, claimed as a real ephemeral value.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["harnessBindPort"] = 5173;
			}),
		).toContain(
			`semantic: ${HARNESS} no longer binds ${HARNESS_LISTENERS} loopback listeners on an ephemeral port`,
		);

		// Capability isolation, in both directions: a leaked step where the
		// capability is off, and a lost script where it is on.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["proxyStepPresent"] = true;
			}),
		).toContain("semantic: rendered cloud proxy evidence drifted");

		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const full = fixtures.find((entry) => entry["name"] === "full");
				if (full)
					full["packageScripts"] = (full["packageScripts"] as string[]).filter(
						(name) => name !== "proxy:check",
					);
			}),
		).toContain("semantic: rendered full proxy evidence drifted");

		// The signature tokens are the fact the gating exists for. A render that
		// carried one anywhere is the failure this record exists to have looked
		// for.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["proxyTokenFiles"] = 1;
			}),
		).toContain("semantic: rendered minimal proxy evidence drifted");

		// Adding a job is the thing this stage promised not to do: Stage 8A's new
		// lane turned a green historical capture into a reported fabrication.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["addedJobs"] = 1;
			}),
		).toContain("semantic: Stage 10C must add no job to the required lane");

		// The one thing that would have cost a container rebuild.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["devcontainerFilesChanged"] = 1;
			}),
		).toContain(
			"semantic: Stage 10C changed a definition fingerprint input under .devcontainer",
		);

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
		).toContain("semantic: Stage 10C rollback is not complete");

		// ... and the rebuild claim is the one this stage exists to be able to
		// make. Flipping it has to fail rather than quietly widen the cost.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				rollback["containerRebuildRequired"] = true;
			}),
		).toContain("semantic: Stage 10C rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
