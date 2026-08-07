// biome-ignore-all lint/complexity/useLiteralKeys: Evidence mutation keys intentionally match JSON.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	BUILD_TOOL_PEER_RANGE,
	CLOUDFLARE_FAMILY,
	expectedStageTenDCommands,
	HARNESS_BIND_PORT,
	HARNESS_LISTENERS,
	MUTATION_LEGS,
	REQUIRED_FAMILY_MUTATIONS,
	REQUIRED_MUTATIONS,
	REQUIRED_VALIDATIONS,
	STAGE_TEN_D_COMMAND_IDS,
	validateStageTenDEvidence,
	validateStageTenDEvidenceValue,
} from "../stage-ten-d-evidence";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = "evidence/stage-10d-start.json";
const SCHEMA = "evidence/stage-10d-start.schema.json";
const HARNESS = "scripts/template/__tests__/fixtures/start-ssr-harness.ts";
const START_TEST = "scripts/template/__tests__/start.test.ts";
const FAMILY_TEST = "scripts/template/__tests__/toolchain.test.ts";

describe("Stage 10D TanStack Start and server render evidence", () => {
	test("validates the committed exact-command and raw-log record", async () => {
		expect(await validateStageTenDEvidence(ROOT)).toEqual([]);
	});

	test("derives all command authorities from the evidence context", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as Record<
			string,
			unknown
		>;
		const commands = expectedStageTenDCommands(evidence);
		expect(Object.keys(commands)).toHaveLength(STAGE_TEN_D_COMMAND_IDS.length);
		// The three validations the record pins are the package scripts this stage
		// exposes and reconciles against, not a paraphrase of them.
		for (const [id, argv] of Object.entries(REQUIRED_VALIDATIONS))
			expect(commands[id as keyof typeof commands]).toEqual([...argv]);
	});

	test("every sealed refusal is still asserted by a committed test", async () => {
		// The sealed diagnostics are literal FRAGMENTS rather than whole sentences,
		// and that is not laziness: almost every refusal this guard produces is
		// assembled with template interpolation, so the complete sentence never
		// appears anywhere in the suite's source and sealing it would bind the
		// record to a string no file contains.
		const start = await Bun.file(resolve(ROOT, START_TEST)).text();
		for (const verdict of REQUIRED_MUTATIONS) expect(start).toContain(verdict);
		// ... and the family refusals live in a DIFFERENT suite, because the
		// coupled pin family is a core rule fenced on the capability this one
		// depends on rather than a gated one.
		const family = await Bun.file(resolve(ROOT, FAMILY_TEST)).text();
		for (const verdict of REQUIRED_FAMILY_MUTATIONS)
			expect(family).toContain(verdict);
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
		expect(harness.split("hostname: LOOPBACK,").length - 1).toBe(
			HARNESS_LISTENERS,
		);
		expect(harness.split(`port: ${HARNESS_BIND_PORT},`).length - 1).toBe(
			HARNESS_LISTENERS,
		);
	});

	test("the sealed family is the one the lockfile actually resolves", async () => {
		// Six members, every one resolving exactly once, and the build tool's
		// resolution inside the range the PLUGIN itself declares. The range is read
		// out of the lockfile rather than typed into the record, so an upgrade that
		// widened or narrowed it cannot go unnoticed.
		const lock = await Bun.file(resolve(ROOT, "bun.lock")).text();
		for (const [name, version] of Object.entries(CLOUDFLARE_FAMILY)) {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const found = [
				...lock.matchAll(new RegExp(`\\["${escaped}@([^"\\s]+)"`, "g")),
			].map((match) => match[1]);
			expect(found).toEqual([version]);
		}
		expect(lock).toContain(`"vite": "${BUILD_TOOL_PEER_RANGE}"`);
		expect(
			Bun.semver.satisfies(CLOUDFLARE_FAMILY.vite, BUILD_TOOL_PEER_RANGE),
		).toBe(true);
	});

	test("the record seals declared values rather than one machine's numbers", async () => {
		const evidence = (await Bun.file(resolve(ROOT, EVIDENCE)).json()) as {
			source: Record<string, unknown>;
			repository: Record<string, unknown>;
		};
		expect(evidence.source["harnessBindPort"]).toBe(0);
		expect(evidence.source["lockfileChanged"]).toBe(false);
		expect(evidence.repository["addedJobs"]).toBe(0);
		expect(evidence.repository["devcontainerFilesChanged"]).toBe(0);
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
			return await validateStageTenDEvidenceValue(value, schema, ROOT);
		};

		expect(
			await validateMutation((value) => {
				const commands = value["commands"] as Array<Record<string, unknown>>;
				if (commands[0]) commands[0]["command"] = ["true"];
			}),
		).toContain("semantic: command start-guard drifted");

		// A guard summary the bound log does not contain is a summary of a run
		// that did not happen.
		expect(
			await validateMutation((value) => {
				const guards = value["guards"] as Record<
					string,
					Record<string, unknown>
				>;
				const start = guards["start"];
				if (start) start["summary"] = "Validated absolutely everything.";
			}),
		).toContain("semantic: guard start evidence drifted");

		// A leg whose filter matched nothing is a citation of nothing.
		expect(
			await validateMutation((value) => {
				const suites = value["suites"] as Array<Record<string, unknown>>;
				const leg = suites.find(
					(entry) => entry["commandId"] === "ssr-read-through-proxy",
				);
				if (leg) leg["passCount"] = 0;
			}),
		).toContain("semantic: mutation suite ssr-read-through-proxy drifted");

		// The two policy decisions this stage exists to make explicit.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["devServer"] = "vite";
			}),
		).toContain(
			"repository: start-surface.json no longer declares the wrangler development runtime without a waiver",
		);
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["ssrMode"] = "streaming";
			}),
		).toContain(
			"repository: start-surface.json no longer declares a buffered server render without a waiver",
		);

		// The repair. The entry is declared FORBIDDEN rather than merely removed,
		// because removing it fixes one file and leaves the class open.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["forbiddenTypes"] = ["@tanstack/react-router/global"];
			}),
		).toContain(
			"semantic: @tanstack/react-router/globals is no longer declared forbidden",
		);

		// The coupled family, with the resolution the lockfile actually chose.
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				const family = source["cloudflareFamily"] as Record<string, string>;
				family["vite"] = "7.0.0";
			}),
		).toContain(
			"repository: bun.lock no longer resolves vite exactly once at 8.1.4",
		);
		expect(
			await validateMutation((value) => {
				const source = value["source"] as Record<string, unknown>;
				source["buildToolPeerRange"] = "^8.0.0";
			}),
		).toContain(
			"semantic: the sealed build tool peer range is not the plugin's declared one",
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

		// The executed compiler proof. TS2688 is the defect this stage repairs and
		// a build-based proof would have been green against the broken file.
		expect(
			await validateMutation((value) => {
				const proof = value["typecheckProof"] as Record<string, unknown>;
				proof["mutationDiagnostic"] = "TS2307";
			}),
		).toContain("semantic: Stage 10D typecheck proof drifted");

		// Capability isolation, in both directions: a leaked step where the
		// capability is off, and a lost script where it is on.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["startStepPresent"] = true;
			}),
		).toContain("semantic: rendered cloud start evidence drifted");

		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const full = fixtures.find((entry) => entry["name"] === "full");
				if (full)
					full["packageScripts"] = (full["packageScripts"] as string[]).filter(
						(name) => name !== "start:check",
					);
			}),
		).toContain("semantic: rendered full start evidence drifted");

		// The signature tokens are the fact the gating exists for. A render that
		// carried one anywhere is the failure this record exists to have looked
		// for.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const minimal = fixtures.find((entry) => entry["name"] === "minimal");
				if (minimal) minimal["startTokenFiles"] = 1;
			}),
		).toContain("semantic: rendered minimal start evidence drifted");

		// ... and the half that proves the SPLIT: the coupled pin family is core,
		// fenced on the capability this one depends on, so it must survive into the
		// render where Cloudflare is on and this capability is off.
		expect(
			await validateMutation((value) => {
				const renders = value["renderFixtures"] as Record<string, unknown>;
				const fixtures = renders["fixtures"] as Array<Record<string, unknown>>;
				const cloud = fixtures.find((entry) => entry["name"] === "cloud");
				if (cloud) cloud["buildToolFamilyPresent"] = false;
			}),
		).toContain("semantic: rendered cloud start evidence drifted");

		// Adding a job is the thing this stage promised not to do: Stage 8A's new
		// lane turned a green historical capture into a reported fabrication.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["addedJobs"] = 1;
			}),
		).toContain("semantic: Stage 10D must add no job to the required lane");

		// The one thing that would have cost a container rebuild.
		expect(
			await validateMutation((value) => {
				const repository = value["repository"] as Record<string, unknown>;
				repository["devcontainerFilesChanged"] = 1;
			}),
		).toContain(
			"semantic: Stage 10D changed a definition fingerprint input under .devcontainer",
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
		).toContain("semantic: Stage 10D rollback is not complete");

		// ... and the rebuild claim is the one this stage exists to be able to
		// make. Flipping it has to fail rather than quietly widen the cost.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				rollback["containerRebuildRequired"] = true;
			}),
		).toContain("semantic: Stage 10D rollback is not complete");

		// The asymmetric half of the rollback: the shared TypeScript base is a
		// Stage 0 artefact this stage REPAIRS, so a revert restores the broken
		// version rather than deleting the file.
		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["repairedTsconfigRestored"] = false;
			}),
		).toContain("semantic: Stage 10D rollback proof drifted");

		expect(
			await validateMutation((value) => {
				const rollback = value["rollback"] as Record<string, unknown>;
				const proof = rollback["proof"] as Record<string, unknown>;
				proof["revertedTree"] = "0".repeat(40);
			}),
		).toContain("repository: rollback proof differs from its bound log");
	});
});
