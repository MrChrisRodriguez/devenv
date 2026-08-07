// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { redactEnvironment } from "../collect-stage-ten-b-evidence";
import {
	expectedStageTenBCommands,
	MUTATION_LEGS,
	REQUIRED_CI_MUTATIONS,
	REQUIRED_MUTATIONS,
	REQUIRED_OPENSPEC_MUTATIONS,
	REQUIRED_VALIDATIONS,
	STAGE_TEN_B_COMMAND_IDS,
	validateStageTenBEvidence,
	validateStageTenBEvidenceValue,
} from "../stage-ten-b-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-10b-telemetry.json";
const SCHEMA = "evidence/stage-10b-telemetry.schema.json";

describe("Stage 10B telemetry and external write evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageTenBEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageTenBCommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_TEN_B_COMMAND_IDS.length);
		// The three validations the record pins are the package scripts this stage
		// exposes and extends, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		const telemetry = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/telemetry.test.ts"),
		).text();
		for (const verdict of REQUIRED_MUTATIONS)
			expect(telemetry).toContain(verdict);
		// The core halves live in the core suites, because the rules they exercise
		// must hold in every render and therefore may not name a capability token.
		const ci = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/ci.test.ts"),
		).text();
		for (const verdict of REQUIRED_CI_MUTATIONS) expect(ci).toContain(verdict);
		const openspec = await Bun.file(
			resolve(ROOT, "scripts/template/__tests__/openspec.test.ts"),
		).text();
		for (const verdict of REQUIRED_OPENSPEC_MUTATIONS)
			expect(openspec).toContain(verdict);
	});

	test("every leg filter still names a test that exists", async () => {
		// A `-t` filter that matches nothing is a green run over an empty set,
		// which is the one way a per-leg capture can lie about what it exercised.
		for (const leg of Object.values(MUTATION_LEGS)) {
			const source = await Bun.file(resolve(ROOT, leg.testFile)).text();
			expect(source).toContain(leg.pattern);
		}
	});

	test("redacts every telemetry credential out of the captured environment", () => {
		// Planted, because a redaction nothing exercises is a redaction nobody has
		// seen work. The value is a fixture, and neither it nor its name may
		// survive into the environment a captured command receives.
		const planted = ["s3cret", "0".repeat(24)].join("");
		const { environment, redactedKeys } = redactEnvironment({
			PATH: "/usr/bin",
			SENTRY_AUTH_TOKEN: planted,
			SENTRY_DSN: "https://example.invalid/1",
			TELEMETRY_UPLOAD_TOKEN: planted,
			HOME: "/home/agent",
			SENTRYLIKE_BUT_NOT: "kept",
		});
		expect(redactedKeys).toEqual([
			"SENTRY_AUTH_TOKEN",
			"SENTRY_DSN",
			"TELEMETRY_UPLOAD_TOKEN",
		]);
		expect(environment["PATH"]).toBe("/usr/bin");
		expect(environment["HOME"]).toBe("/home/agent");
		// A name that merely starts with the same letters is not the family, and a
		// redaction that swallowed it would quietly break an unrelated capture.
		expect(environment["SENTRYLIKE_BUT_NOT"]).toBe("kept");
		expect(Object.keys(environment)).not.toContain("SENTRY_AUTH_TOKEN");
		// The value appears nowhere at all — not under another key, not in the
		// names list. This is the assertion the whole function exists for.
		expect(JSON.stringify({ environment, redactedKeys })).not.toContain(
			planted,
		);
	});

	test("no committed log carries a telemetry credential", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as {
			commands: Array<{ stdoutPath: string; stderrPath: string }>;
		};
		expect(evidence.commands.length).toBeGreaterThan(0);
		for (const command of evidence.commands) {
			for (const path of [command.stdoutPath, command.stderrPath]) {
				const text = await Bun.file(resolve(ROOT, path)).text();
				expect(text).not.toMatch(/\bSENTRY_[A-Z0-9_]*\s*=\s*\S/);
			}
		}
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
			return await validateStageTenBEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command telemetry-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const telemetry = guards["telemetry"];
				if (telemetry)
					telemetry["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard telemetry evidence drifted");

		// A leg whose filter matched nothing is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const suites = value["suites"] as Array<Record<string, unknown>>;
				const leg = suites.find(
					(entry) => entry["commandId"] === "surface-confinement",
				);
				if (leg) leg["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite surface-confinement drifted");

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
				if (cloud) cloud["telemetryStepPresent"] = true;
			}),
		).toContain("semantic: rendered cloud telemetry evidence drifted");

		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const full = fixtures.find((entry) => entry["name"] === "full");
				if (full)
					full["packageScripts"] = (full["packageScripts"] as string[]).filter(
						(name) => name !== "telemetry:check",
					);
			}),
		).toContain("semantic: rendered full telemetry evidence drifted");

		// The signature tokens are the fact the gating exists for. A render that
		// carried one anywhere is the failure this record exists to have looked
		// for.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["telemetryTokenFiles"] = 1;
			}),
		).toContain("semantic: rendered minimal telemetry evidence drifted");

		// Adding a job is the thing this stage promised not to do: Stage 8A's new
		// lane turned a green historical capture into a reported fabrication.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["addedJobs"] = 1;
			}),
		).toContain("semantic: Stage 10B must add no job to the required lane");

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
		).toContain("semantic: Stage 10B rollback is not complete");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
