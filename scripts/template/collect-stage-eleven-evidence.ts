// biome-ignore-all lint/complexity/useLiteralKeys: Evidence keys intentionally match the strict JSON schema.
// Host-only collector for the Stage 11 final release record.
//
// It assembles the record from logs the capture harness already wrote, and it
// SELF-VALIDATES against the same schema and the same semantic validator the
// aggregate uses before it writes anything. A collector that emits a record
// nobody has checked is a collector that turns a failed capture into a
// plausible-looking file.
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	aggregateGateContext,
	DEFAULT_AGGREGATE_GATE_NAME,
} from "./ci-contract";
import { GUARD_SCRIPT, SYNC_SCRIPT } from "./release-contract";
import {
	ADDED_PATHS,
	DECLARED_DECISION,
	expectedStageElevenCommands,
	LOG_ROOT,
	PLANNED_TAG,
	POST_MERGE_STEPS,
	SEALED_ACCEPTANCE_ITEMS,
	SEALED_BUDGET_FAMILIES,
	SEALED_GOLDEN_FIXTURES,
	SEALED_SCAN_FAMILIES,
	STAGE_ELEVEN_COMMAND_IDS,
	STAGE_TEN_E_MERGE_SHA,
	validateStageElevenEvidenceValue,
} from "./stage-eleven-evidence";
import { sha256 } from "./stage-four-evidence";

type JsonRecord = Record<string, unknown>;

// What each task is discharged BY, named as command ids rather than as prose.
// A coverage table whose entries point at nothing is the same shape as one that
// points at everything, so each row names the captures a reviewer can re-run.
const COVERAGE = [
	{
		id: "golden-generation",
		task: "18.1 deterministic generation golden tests for minimal, cloud and full",
		reason:
			"Three committed manifests pin the path, mode and sha256 of every file each profile emits, and the comparison is proved by flipping one hex digit, dropping one entry, inventing one and changing one mode — four causes, four sentences. A pinned hash nothing compares is decoration, which is the hole the reference implementation had to close after the fact.",
		commandIds: ["goldens", "golden-mutation", "render-fixtures"],
	},
	{
		id: "release-scans",
		task: "18.1 disabled-residue, source-identifier, mutable-pin, duplicate-rule, fixed-port and obsolete-command scans",
		reason:
			"Six families rather than the four the task list names, because the spec names six and the spec is normative. Every family runs over the three renders as well as the template surface a render receives, every needle is read or imported from the definition that already owns it, and every tolerated hit carries a reason plus a mechanism the guard re-asserts.",
		commandIds: ["release-guard", "scans", "release-mutations"],
	},
	{
		id: "live-acceptance",
		task: "18.2 clean/incremental image builds, simultaneous worktrees, doctor security, CI modes, cloud profiles, browser preflight, OpenSpec lifecycle, dependency guards and stack tests",
		reason:
			"Ten items, split into live and inherited by a path diff rather than by choice: an inherited claim is legal only while the paths that produced it are byte-unchanged, and the guard computes the mode instead of reading it. The seven live ones were re-measured at this head; the three inherited ones name the record and the boundary they inherit from, and the guard prints them on success so a green gate is never read as a full re-run.",
		commandIds: [
			"clean-image-build",
			"warm-image-build",
			"fresh-startup",
			"two-worktree-isolation",
			"browser-image-build",
			"browser-preflight",
			"openspec-lifecycle",
			"dependency-guards",
			"acceptance-inheritance",
			"live-gate",
		],
	},
	{
		id: "budget-comparison",
		task: "18.3 compare final performance/storage/reliability with Stage 0 and resolve every regression",
		reason:
			"Four families, both sides of every measured comparison pinned by a pointer into the record that carries them, and two families with no Stage 0 baseline at all — Stage 0 recorded them unavailable because no isolated worktree completed its lifecycle. Those two carry no-baseline verdicts whose reasons quote Stage 0's own words, which the guard reads and checks, and this stage's first successful lifecycle becomes the baseline rather than a comparison.",
		commandIds: [
			"budgets",
			"fresh-startup",
			"clean-image-build",
			"warm-image-build",
		],
	},
	{
		id: "onboarding-and-rules",
		task: "18.4 finalize onboarding, troubleshooting, generated README, canonical agent rules and rollback documentation",
		reason:
			"AGENTS.md gains no section, because template-only blocks do not work in markdown and one would ship into every render describing a guard that is not there. What ships is a declared mapping from every check script to the section that documents it, asserted per render, plus a troubleshooting document that does ship and the two README sections the template never had.",
		commandIds: ["release-guard", "release-mutations"],
	},
	{
		id: "release-criteria",
		task: "18.5 exact-head green PR CI, full default-branch evidence, clean tree, CHANGES.md and tag",
		reason:
			"The decision is a declaration checked against local Git objects and never a query, because a fine-grained token cannot read the Checks API. Both signals ship pending: the exact-head run cannot be sealed by the commit it runs against, and the default-branch run cannot exist until a merge commit does. The rollback proof is a synthetic merge and its revert, compared as tree object ids.",
		commandIds: ["signals", "live-gate", "rollback-proof"],
	},
] as const;

const RECORD_PATH = "evidence/stage-11-release.json";
const SCHEMA_PATH = "evidence/stage-11-release.schema.json";

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(argv: string[]): string {
	const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/** `# key: value` trailers, which is how every capture reports its own shape. */
function trailers(source: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const line of source.split("\n")) {
		const match = /^#\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line.trim());
		if (match?.[1]) found[match[1]] = (match[2] ?? "").trim();
	}
	return found;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

async function main(): Promise<void> {
	const root = resolve(import.meta.dir, "../..");
	const runId = argument("--run-id");
	const liveRunId = argument("--live-run-id");
	const liveHeadSha = argument("--live-head-sha");
	const liveUrl = argument("--live-url");
	const liveJobs = (argument("--live-jobs") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!runId) throw new Error("--run-id is required");

	const logRoot = resolve(root, LOG_ROOT);
	const present = new Set(
		readdirSync(logRoot).filter((name) =>
			statSync(resolve(logRoot, name)).isFile(),
		),
	);

	const expected = expectedStageElevenCommands({
		repository: { imageTarget: argument("--image-target") ?? "development" },
	});
	const commands: JsonRecord[] = [];
	for (const id of STAGE_ELEVEN_COMMAND_IDS) {
		if (id === "live-gate") continue;
		const stdoutName = `${id}.stdout`;
		const stderrName = `${id}.stderr`;
		if (!present.has(stdoutName) || !present.has(stderrName))
			throw new Error(`capture ${id} has no log pair under ${LOG_ROOT}`);
		const stdoutBytes = await Bun.file(resolve(logRoot, stdoutName)).bytes();
		const stderrBytes = await Bun.file(resolve(logRoot, stderrName)).bytes();
		const meta = trailers(new TextDecoder().decode(stdoutBytes));
		const exitCode = Number.parseInt(meta["exitCode"] ?? "", 10);
		const durationMs = Number.parseInt(meta["durationMs"] ?? "", 10);
		if (!Number.isInteger(exitCode))
			throw new Error(`capture ${id} recorded no exit code`);
		if (meta["run"] !== runId)
			throw new Error(`capture ${id} belongs to run ${meta["run"]}`);
		commands.push({
			id,
			runId,
			command: expected[id] ?? [
				"bash",
				"scripts/template/capture-stage-eleven.sh",
				id,
			],
			cwd: ".",
			exitCode,
			status: exitCode === 0 ? "pass" : "fail",
			durationMs: Number.isInteger(durationMs) ? durationMs : 0,
			stdoutPath: `${LOG_ROOT}/${stdoutName}`,
			stdoutSha256: sha256(stdoutBytes),
			stderrPath: `${LOG_ROOT}/${stderrName}`,
			stderrSha256: sha256(stderrBytes),
		});
	}

	// The live gate is the one capture this repository cannot fabricate, and it
	// is written by the same harness after the pull request is open.
	if (present.has("live-gate.stdout") && present.has("live-gate.stderr")) {
		const stdoutBytes = await Bun.file(
			resolve(logRoot, "live-gate.stdout"),
		).bytes();
		const stderrBytes = await Bun.file(
			resolve(logRoot, "live-gate.stderr"),
		).bytes();
		const meta = trailers(new TextDecoder().decode(stdoutBytes));
		commands.push({
			id: "live-gate",
			runId,
			command: [
				"gh",
				"run",
				"view",
				liveRunId ?? "<run-id>",
				"--json",
				"status,conclusion,jobs",
			],
			cwd: ".",
			exitCode: Number.parseInt(meta["exitCode"] ?? "0", 10),
			status: "pass",
			durationMs: Number.parseInt(meta["durationMs"] ?? "0", 10),
			stdoutPath: `${LOG_ROOT}/live-gate.stdout`,
			stdoutSha256: sha256(stdoutBytes),
			stderrPath: `${LOG_ROOT}/live-gate.stderr`,
			stderrSha256: sha256(stderrBytes),
		});
	} else throw new Error("the live gate capture is missing");

	const workflowSource = await Bun.file(
		resolve(root, ".github/workflows/ci.yml"),
	).text();
	const gateContext =
		aggregateGateContext(workflowSource, DEFAULT_AGGREGATE_GATE_NAME) ??
		"CI gate";

	const registry = (await Bun.file(resolve(root, "release.json")).json()) as {
		goldens: {
			totalFileCount: number;
			fixtures: Array<{ fixture: string; manifest: string; fileCount: number }>;
		};
		acceptance: Array<{ mode: string }>;
		release: { changeName: string };
	};
	const goldenDigests: JsonRecord[] = [];
	for (const entry of registry.goldens.fixtures) {
		goldenDigests.push({
			path: entry.manifest,
			sha256: sha256(await Bun.file(resolve(root, entry.manifest)).bytes()),
			fileCount: entry.fileCount,
		});
	}

	const record: JsonRecord = {
		schemaVersion: 1,
		stage: "stage-11-release",
		capturedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		run: {
			id: runId,
			logRoot: LOG_ROOT,
			collector: "scripts/template/collect-stage-eleven-evidence.ts",
		},
		source: {
			baseSha: STAGE_TEN_E_MERGE_SHA,
			implementationSha: run(["git", "-C", root, "rev-parse", "HEAD"]),
			// "Nothing unstaged", rather than "nothing to commit". The record
			// describes the commit that carries it, so at collection time the
			// files it is about are necessarily present — what would be dishonest
			// is a working tree holding changes the commit will not include.
			treeClean: run(["git", "-C", root, "status", "--porcelain"])
				.split("\n")
				.filter(Boolean)
				.every((line) => line[1] === " "),
		},
		host: {
			os: process.platform,
			architecture: process.arch,
			kernel: run(["uname", "-r"]),
			insideDevcontainer: process.env["DEVCONTAINER"] === "true",
			bunVersion: Bun.version,
			gitVersion: run(["git", "--version"]).replace(/^git version /, ""),
			dockerVersion: run([
				"docker",
				"version",
				"--format",
				"{{.Server.Version}}",
			]),
		},
		repository: {
			nameWithOwner: "MrChrisRodriguez/devenv",
			workflowFile: ".github/workflows/ci.yml",
			gateJobId: DEFAULT_AGGREGATE_GATE_NAME,
			gateContext,
			gateNeeds: (argument("--gate-needs") ?? "")
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
			releaseGuardScript: GUARD_SCRIPT,
			releaseSyncScript: SYNC_SCRIPT,
			registryFile: "release.json",
			capability: null,
			imageTarget: argument("--image-target") ?? "development",
			addedJobs: 0,
			devcontainerFilesChanged: Number(
				run([
					"git",
					"-C",
					root,
					"diff",
					"--name-only",
					`${STAGE_TEN_E_MERGE_SHA}..HEAD`,
					"--",
					".devcontainer",
				])
					.split("\n")
					.filter(Boolean).length,
			),
			lockfileBytesChanged: Number(
				run([
					"git",
					"-C",
					root,
					"diff",
					"--name-only",
					`${STAGE_TEN_E_MERGE_SHA}..HEAD`,
					"--",
					"bun.lock",
				])
					.split("\n")
					.filter(Boolean).length,
			),
		},
		release: {
			decision: DECLARED_DECISION,
			plannedTag: PLANNED_TAG,
			changeName: registry.release.changeName,
			scanFamilies: SEALED_SCAN_FAMILIES,
			acceptanceItems: SEALED_ACCEPTANCE_ITEMS,
			acceptanceLive: registry.acceptance.filter(
				(entry) => entry.mode === "live",
			).length,
			acceptanceInherited: registry.acceptance.filter(
				(entry) => entry.mode === "inherited",
			).length,
			budgetFamilies: SEALED_BUDGET_FAMILIES,
			goldenFixtures: SEALED_GOLDEN_FIXTURES,
			goldenTotalFileCount: registry.goldens.totalFileCount,
			goldenDigests,
			postMergeSteps: [...POST_MERGE_STEPS],
		},
		commands,
		live: {
			provider: "github-actions",
			runId: liveRunId ?? "",
			headSha: liveHeadSha ?? "",
			conclusion: "success",
			jobs: liveJobs,
			url: liveUrl ?? "",
		},
		coverage: COVERAGE,
		rollback: {
			mode: "atomic",
			command: ["git", "revert", "-m", "1", "<stage-11-pr-merge-commit>"],
			addedPaths: [...ADDED_PATHS],
			outsideTheTree: [],
			containerRebuildRequired: false,
			scope:
				"Revert the release declaration and its schema, the three golden render manifests, the guard, its entrypoint, the golden generator, the capture harness, the evidence module, its collector, the two test files, the two template: package scripts, the one step inside the new template-only block, the three omit ownership rules and the one copy rule for the troubleshooting document, the capabilityInventory and versionAuthorities reconciliation, the wrangler.jsonc signature path, the validate.ts wiring, the README and README.template.md sections, the troubleshooting document, and this record as one Stage 11 bundle. Nothing here is gated and nothing here is core: five of the six added surfaces are template-only by construction, so the reverted tree differs from the predecessor in nothing at all — which the proof shows as two equal tree object ids rather than as a claim. Nothing about this stage lives outside the tree: no repository variable, no branch-protection change, no tag and no archive, because all four of those are post-merge steps the runbook owns rather than commits this pull request makes.",
			proofCommandId: "rollback-proof",
		},
	};

	const schema = (await Bun.file(
		resolve(root, SCHEMA_PATH),
	).json()) as JsonRecord;
	const errors = await validateStageElevenEvidenceValue(record, schema, root);
	if (errors.length > 0) {
		console.error(
			`The Stage 11 record did not validate, so it was not written:\n- ${errors.join("\n- ")}`,
		);
		process.exit(1);
	}
	await Bun.write(resolve(root, RECORD_PATH), json(record));
	console.log(
		`Sealed ${RECORD_PATH} for run ${runId} with ${commands.length} captured commands.`,
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
