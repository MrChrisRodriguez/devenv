// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Workflow fixtures and mutations quote runner expressions verbatim.
import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { validateCiContract, validateWorkflowGraph } from "../ci-contract";
import { renderFixture } from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");
const ACTION_PATH = ".github/actions/setup-bun/action.yml";
const MOON_ACTION_PATH = ".github/actions/setup-moon/action.yml";
const RETRY_SCRIPT = resolve(ROOT, "scripts/ci/bun-install-retry.sh");
const BUILD_RETRY_SCRIPT = resolve(ROOT, "scripts/ci/docker-build-retry.sh");
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SMOKE_WORKFLOW = ".github/workflows/codex-cloud-smoke.yml";
const WORKFLOWS = [CI_WORKFLOW, SMOKE_WORKFLOW] as const;

// Everything validateCiContract reads. The fixture is a real Git repository
// because two of the rules — compiler coverage and its "tracked file" scope —
// are answered out of the index rather than out of a directory walk.
const CONTRACT_FILES = [
	"package.json",
	"template-parameters.toml",
	"tsconfig.json",
	"scripts/template/tsconfig.json",
	"scripts/browser-preflight.ts",
	"scripts/template/ci-contract.ts",
	"scripts/template/validate-ci.ts",
	"scripts/sync-devcontainer.sh",
	"scripts/ci/aggregate-gate.sh",
	"scripts/ci/bun-install-retry.sh",
	"scripts/ci/run-tests.sh",
	"scripts/ci/run-typecheck.sh",
	"scripts/ci/affected-matrices.sh",
	ACTION_PATH,
	MOON_ACTION_PATH,
	CI_WORKFLOW,
	SMOKE_WORKFLOW,
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

interface CompositeStep {
	name?: string;
	uses?: string;
	if?: string;
	run?: string;
}

async function actionSource(): Promise<string> {
	return await Bun.file(resolve(ROOT, ACTION_PATH)).text();
}

async function actionSteps(): Promise<CompositeStep[]> {
	const value = Bun.YAML.parse(await actionSource()) as Record<string, unknown>;
	const runs = value["runs"] as Record<string, unknown>;
	return runs["steps"] as CompositeStep[];
}

async function stepBody(name: string): Promise<string> {
	const step = (await actionSteps()).find((entry) => entry.name === name);
	if (!step?.run) throw new Error(`composite step ${name} has no run body`);
	return step.run;
}

async function temporaryDirectory(): Promise<string> {
	return await mkdtemp(resolve(tmpdir(), "devenv-ci-"));
}

// A stand-in for a real toolchain binary, so a shell body committed in this
// repository can be executed for what it does rather than read for what it says.
async function fakeBinary(
	root: string,
	name: string,
	body: string,
): Promise<string> {
	const binDirectory = resolve(root, "bin");
	await mkdir(binDirectory, { recursive: true });
	const path = resolve(binDirectory, name);
	await Bun.write(path, `#!/usr/bin/env bash\n${body}\n`);
	await chmod(path, 0o755);
	return binDirectory;
}

function runScript(
	script: string,
	options: { cwd: string; env?: Record<string, string>; args?: string[] },
): { exitCode: number; output: string } {
	const result = Bun.spawnSync({
		cmd: ["bash", script, ...(options.args ?? [])],
		cwd: options.cwd,
		env: { ...process.env, ...(options.env ?? {}) },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		output: `${result.stdout.toString()}${result.stderr.toString()}`,
	};
}

// A deliberately narrow environment: HOME points inside the fixture so no
// developer's global Git configuration can change what the index contains.
function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: { PATH: process.env["PATH"] ?? "", HOME: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
}

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-ci-contract-"));
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
		if (path.endsWith(".sh")) await chmod(destination, 0o755);
	}
	git(temporary, "init", "-q", "-b", "main");
	git(temporary, "add", "-A");
	return temporary;
}

async function mutate(
	root: string,
	path: string,
	transform: (source: string) => string,
	expected: string,
): Promise<void> {
	const target = resolve(root, path);
	const original = await Bun.file(target).text();
	const changed = transform(original);
	if (changed === original) throw new Error(`Mutation did not change ${path}`);
	await Bun.write(target, changed);
	expect(await validateCiContract(root)).toContain(expected);
	await Bun.write(target, original);
	expect(await validateCiContract(root)).toEqual([]);
}

// The other half of a non-vacuous scan: an edit that merely looks like the
// forbidden one has to be accepted, or the rule is a substring search wearing a
// contract's clothes.
async function tolerate(
	root: string,
	path: string,
	transform: (source: string) => string,
): Promise<void> {
	const target = resolve(root, path);
	const original = await Bun.file(target).text();
	const changed = transform(original);
	if (changed === original) throw new Error(`Mutation did not change ${path}`);
	await Bun.write(target, changed);
	expect(await validateCiContract(root)).toEqual([]);
	await Bun.write(target, original);
}

async function withTrackedFile(
	root: string,
	path: string,
	contents: string,
	expected: string,
): Promise<void> {
	const target = resolve(root, path);
	await mkdir(dirname(target), { recursive: true });
	await Bun.write(target, contents);
	git(root, "add", "-A");
	expect(await validateCiContract(root)).toContain(expected);
	await rm(target);
	git(root, "add", "-A");
	expect(await validateCiContract(root)).toEqual([]);
}

describe("workflow policy contract", () => {
	test("passes the real tree and rejects known-bad ci mutations", async () => {
		expect(await validateCiContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateCiContract(temporary)).toEqual([]);

			// --- Triggers -----------------------------------------------------
			// A `branches:` filter on pull_request matches the PR's BASE branch,
			// so a stacked pull request runs ZERO jobs and shows a page with no
			// checks on it. Every spelling of it has to be caught.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"  pull_request:\n",
						"  pull_request:\n    branches: [main]\n",
					),
				"ci: .github/workflows/ci.yml pull_request must not filter base branches",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"  pull_request:\n",
						'  pull_request:\n    "branches": [main]\n',
					),
				"ci: .github/workflows/ci.yml pull_request must not filter base branches",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"  pull_request:\n",
						"  pull_request:\n    branches-ignore: [release]\n",
					),
				"ci: .github/workflows/ci.yml pull_request must not filter base branches",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						/ {2}pull_request:\n(?:.*\n)*? {4}types: \[[^\]]*\]\n/,
						"  pull_request: { types: [opened, ready_for_review], branches: [main] }\n",
					),
				"ci: .github/workflows/ci.yml pull_request must not filter base branches",
			);
			// ... and a comment that discusses the filter is documentation.
			await tolerate(temporary, CI_WORKFLOW, (source) =>
				source.replace(
					"  pull_request:\n",
					"  pull_request:\n    # branches: [main] would run zero jobs on a stacked PR\n",
				),
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace(", ready_for_review]", "]"),
				"ci: .github/workflows/ci.yml pull_request types must include ready_for_review",
			);
			// One cancellation lane means the ready_for_review run cancels the draft
			// run it supersedes, leaving cancelled jobs attached to the same head.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"  group: ci-${{ github.ref }}-${{ github.event_name == 'pull_request' && github.event.pull_request.draft && 'draft' || 'ready' }}",
						"  group: ci-${{ github.ref }}",
					),
				"ci: .github/workflows/ci.yml must separate draft and ready cancellation lanes",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"cancel-in-progress: true",
						"cancel-in-progress: false",
					),
				"ci: .github/workflows/ci.yml must cancel superseded runs",
			);

			// --- Bounds and tolerance -----------------------------------------
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace("    timeout-minutes: 20\n", ""),
				"ci: .github/workflows/ci.yml job ci must declare timeout-minutes",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"        run: bunx biome check --no-errors-on-unmatched .\n",
						"        run: bunx biome check --no-errors-on-unmatched .\n        continue-on-error: true\n",
					),
				"ci: .github/workflows/ci.yml must not tolerate a failing step",
			);

			// --- Bootstrap ownership -------------------------------------------
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
						"actions/checkout@v4",
					),
				"ci: .github/workflows/ci.yml must pin actions/checkout@v4 to an immutable commit",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      - uses: ./.github/actions/setup-bun\n",
						"      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n",
					),
				"ci: .github/workflows/ci.yml must reach Bun through the committed action",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"bun-version: ${{ env.BUN_VERSION }}",
						'bun-version: "1.3.13"',
					),
				"ci: .github/workflows/ci.yml must pass bun-version through env.BUN_VERSION",
			);
			// Actions silently ignore an input they do not declare, so a phantom
			// cache reads as cached and caches nothing, forever.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"          bun-version: ${{ env.BUN_VERSION }}\n",
						'          bun-version: ${{ env.BUN_VERSION }}\n          cache: "true"\n',
					),
				"ci: .github/workflows/ci.yml passes unsupported input cache to ./.github/actions/setup-bun",
			);
			await mutate(
				temporary,
				ACTION_PATH,
				(source) =>
					source.replace(
						"        bun-version: ${{ inputs.bun-version }}\n",
						'        bun-version: ${{ inputs.bun-version }}\n        cache: "true"\n',
					),
				"ci: .github/actions/setup-bun/action.yml passes unsupported input cache to oven-sh/setup-bun",
			);
			await mutate(
				temporary,
				ACTION_PATH,
				(source) =>
					source.replace(
						"    required: true\n",
						'    required: true\n    default: "latest"\n',
					),
				"ci: .github/actions/setup-bun/action.yml must declare bun-version required without a default",
			);
			// Composite metadata is evaluated in full before any step runs, and a
			// composite action has none of these contexts: one such expression, in
			// prose or not, fails the action to LOAD and reddens every caller.
			await mutate(
				temporary,
				ACTION_PATH,
				(source) =>
					source.replace(
						"the dollar-and-double-brace form",
						"${{ env.BUN_VERSION }}",
					),
				"ci: .github/actions/setup-bun/action.yml must not name an unavailable context",
			);

			// --- The aggregate gate ---------------------------------------------
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace("      - image\n", ""),
				"ci: the aggregate gate must depend on every job in .github/workflows/ci.yml",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace("    if: ${{ always() }}", "    if: ${{ success() }}"),
				"ci: the aggregate gate must report with always()",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"RESULTS: ${{ join(needs.*.result, ',') }}",
						"RESULTS: ${{ needs.ci.result }}",
					),
				"ci: the aggregate gate must derive its verdict from join(needs.*.result)",
			);
			// A fenced job and its fenced `needs` entry disappear together or the
			// rendered workflow depends on a job that is not there.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      # capability:start playwright\n      - browser\n      # capability:end playwright\n",
						"      - browser\n",
					),
				"ci: .github/workflows/ci.yml job ci-gate needs browser, which the file does not declare with every capability disabled",
			);
			// --- The moon graph lane ------------------------------------------
			// A graph that was never verified looks exactly like a graph that was,
			// so the oracle's absence from `needs` gets its own verdict.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      # capability:start moon_affected_selection\n      - moon-graph\n      # capability:end moon_affected_selection\n",
						"",
					),
				"ci: the aggregate gate must depend on the moon graph oracle",
			);
			// A fenced job and its fenced `needs` entry disappear together, in
			// this direction too: fencing only the job leaves the gate depending
			// on something a rendered workflow does not declare.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      # capability:start moon_affected_selection\n      - moon-graph\n      # capability:end moon_affected_selection\n",
						"      - moon-graph\n",
					),
				"ci: .github/workflows/ci.yml job ci-gate needs moon-graph, which the file does not declare with every capability disabled",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      - uses: ./.github/actions/setup-moon\n",
						"      - uses: moonrepo/setup-toolchain@261c62cb5b0f580c7be7c8cd0f023a2e96756095 # v0.6.4\n",
					),
				"ci: .github/workflows/ci.yml must reach moon through the committed action",
			);
			await mutate(
				temporary,
				MOON_ACTION_PATH,
				(source) =>
					source.replace(
						"moonrepo/setup-toolchain@261c62cb5b0f580c7be7c8cd0f023a2e96756095",
						"moonrepo/setup-toolchain@v0.6.4",
					),
				"ci: .github/actions/setup-moon/action.yml must pin moonrepo/setup-toolchain@v0.6.4 to an immutable commit",
			);
			// The installed toolchain is only an intention until the binary agrees
			// with .prototools.
			await mutate(
				temporary,
				MOON_ACTION_PATH,
				(source) =>
					source.replace(
						"        actual=\"$(moon --version | awk '{ print $2 }')\"\n",
						'        actual="$pinned"\n',
					),
				"ci: .github/actions/setup-moon/action.yml must assert the installed moon against .prototools",
			);
			// A version input here would be a second authority outside the
			// toolchain guard — including a bun-version one.
			await mutate(
				temporary,
				MOON_ACTION_PATH,
				(source) =>
					source.replace(
						"runs:\n",
						'inputs:\n  bun-version:\n    description: "Bun version"\n    required: true\n\nruns:\n',
					),
				"ci: .github/actions/setup-moon/action.yml must not declare the input bun-version; .prototools is the only version authority",
			);

			// The real file names the non-gating lane only inside comments; naming
			// it anywhere executable would let a registry outage redden a PR.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"          DRAFT: ${{ github.event.pull_request.draft }}\n",
						"          DRAFT: ${{ github.event.pull_request.draft }}\n          SMOKE: .github/workflows/codex-cloud-smoke.yml\n",
					),
				"ci: the gating workflow must not depend on the non-gating .github/workflows/codex-cloud-smoke.yml",
			);

			// --- Shell bodies ----------------------------------------------------
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"        run: bun run toolchain:check",
						"        run: |\n          sleep 5\n          bun run toolchain:check",
					),
				"ci: .github/workflows/ci.yml job ci must not sleep in a workflow body",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"        run: bun run image:check",
						'        run: echo "${{ github.event.pull_request.title }}"',
					),
				"ci: .github/workflows/ci.yml job ci must not interpolate event metadata into a shell body",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"        run: bunx biome check",
						"        run: npx biome check",
					),
				"ci: .github/workflows/ci.yml job project must not invoke a foreign package runtime",
			);

			// --- Ownership and isolation ------------------------------------------
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n\n      - name: Build selected image target",
						"actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          fetch-depth: 0\n\n      - name: Build selected image target",
					),
				"ci: .github/workflows/ci.yml job image must not claim ownership of repository history",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						'  BUN_VERSION: "1.3.13"',
						'  BUN_VERSION: "1.3.13"\n  MOON_REMOTE_HOST: "grpc://cache.example"',
					),
				"ci: .github/workflows/ci.yml must not configure remote build execution",
			);
			await mutate(
				temporary,
				SMOKE_WORKFLOW,
				(source) =>
					source.replace(
						"            ~/.proto\n",
						"            ~/.proto\n            ~/.bun/install/cache\n",
					),
				"ci: .github/workflows/codex-cloud-smoke.yml must not cache an extracted dependency tree",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      - name: Validate workflow policy contract\n        run: bun run ci:check\n\n",
						"",
					),
				"ci: the gating workflow must run the workflow policy guard",
			);

			// --- The selection lane ------------------------------------------------
			// A selector that failed makes the lanes below it SKIP, and a skipped
			// lane reads as a pass to the verdict script — so a selection nothing
			// gates on goes green precisely when the selection was wrong.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace("      - affected\n", ""),
				"ci: the aggregate gate must depend on the affected selector",
			);
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace("      - project\n", ""),
				"ci: the aggregate gate must depend on every job in .github/workflows/ci.yml",
			);
			// A job that reads another job's outputs without declaring it in
			// `needs` reads EMPTY rather than failing, so the lane starts with a
			// matrix built from nothing and looks exactly like a lane with nothing
			// to do.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) => source.replace("    needs: [affected]\n", ""),
				"ci: .github/workflows/ci.yml job project reads outputs from affected without declaring it in needs",
			);
			// `fromJSON` outside a matrix value is a decision made from data the
			// job did not compute.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"    if: ${{ !github.event.pull_request.draft && needs.affected.outputs.ci != '[]' }}\n    strategy:",
						"    if: ${{ !github.event.pull_request.draft && fromJSON(needs.affected.outputs.ci)[0] != '' }}\n    strategy:",
					),
				"ci: .github/workflows/ci.yml job project may only call fromJSON in a matrix value",
			);
			// A selection decides what is CHECKED, never what is SHIPPED: a
			// delivery lane that skipped a project would ship a tree nothing
			// verified. No such job exists here, so the rule is proved by adding
			// one — in both spellings it recognises.
			for (const [id, extra] of [
				["deploy", ""],
				["ship", "    environment: production\n"],
			] as const) {
				await mutate(
					temporary,
					CI_WORKFLOW,
					(source) =>
						source.replace(
							"  # ── The heavy lane ",
							[
								`  ${id}:`,
								`    name: Ship it`,
								"    runs-on: ubuntu-latest",
								"    timeout-minutes: 5",
								"    needs: [affected]",
								extra.trimEnd(),
								"    if: ${{ !github.event.pull_request.draft }}",
								"    steps:",
								"      - name: Ship",
								"        env:",
								"          SELECTED: ${{ needs.affected.outputs.ci }}",
								'        run: echo "$SELECTED"',
								"",
								"  # ── The heavy lane ",
							]
								.filter((line) => line !== "")
								.join("\n"),
						),
					`ci: .github/workflows/ci.yml job ${id} delivers and must not select what it runs`,
				);
			}
			// ... and the same job must not ship a tree the contract guards never
			// saw. A delivery lane is the ONE path on which a broken contract
			// reaches users, so the dependency is required in both spellings — and
			// it is required TRANSITIVELY, because funnelling through the aggregate
			// gate is the correct shape and a rule demanding a direct edge would
			// push people to add a second, wrong one beside it.
			for (const [id, extra] of [
				["deploy", ""],
				["ship", "    environment: production\n"],
			] as const) {
				const job = (needs: string): string =>
					[
						`  ${id}:`,
						"    name: Ship it",
						"    runs-on: ubuntu-latest",
						"    timeout-minutes: 5",
						needs,
						extra.trimEnd(),
						"    if: ${{ !github.event.pull_request.draft }}",
						"    steps:",
						"      - name: Ship",
						'        run: echo "shipping"',
						"",
						"  # ── The heavy lane ",
					]
						.filter((line) => line !== "")
						.join("\n");
				await mutate(
					temporary,
					CI_WORKFLOW,
					(source) =>
						source.replace("  # ── The heavy lane ", job("    needs: [image]")),
					`ci: .github/workflows/ci.yml job ${id} delivers and must depend on ci`,
				);
				// The same job reaching the contract guards through a chain is legal;
				// the only complaint left is the aggregate gate noticing a job it
				// does not yet depend on.
				const original = await Bun.file(resolve(temporary, CI_WORKFLOW)).text();
				await Bun.write(
					resolve(temporary, CI_WORKFLOW),
					original.replace("  # ── The heavy lane ", job("    needs: [ci]")),
				);
				expect(await validateCiContract(temporary)).toEqual([
					"ci: the aggregate gate must depend on every job in .github/workflows/ci.yml",
				]);
				await Bun.write(resolve(temporary, CI_WORKFLOW), original);
				expect(await validateCiContract(temporary)).toEqual([]);
			}
			// A delivery workflow with no contract guard job at all cannot satisfy
			// the dependency, and that is the hole rather than an excuse for one.
			await mutate(
				temporary,
				SMOKE_WORKFLOW,
				(source) =>
					`${source}\n  release:\n    name: Release\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - name: Ship\n        run: echo "shipping"\n`,
				"ci: .github/workflows/codex-cloud-smoke.yml job release delivers from a workflow that declares no ci job to gate it",
			);
			// A job outside the history-owner list may not deepen its clone, and
			// the two that are on it must actually do so.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"          # recorded in the workflow guard's HISTORY_OWNERS list.\n          fetch-depth: 0\n",
						"          # recorded in the workflow guard's HISTORY_OWNERS list.\n          fetch-depth: 1\n",
					),
				"ci: .github/workflows/ci.yml job affected must check out full history",
			);
			// The heavy lane owns history for a different reason, and it earned
			// the entry the hard way: the three steps moved here out of a job that
			// had always had full history, and the sealed-evidence tests went red
			// on the first real run without it.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"          # workflow guard's HISTORY_OWNERS list.\n          fetch-depth: 0\n",
						"          # workflow guard's HISTORY_OWNERS list.\n          fetch-depth: 1\n",
					),
				"ci: .github/workflows/ci.yml job project must check out full history",
			);

			// --- Credentials -------------------------------------------------------
			// Every rule here is a negative requirement today: no workflow in this
			// repository references the credential context at all. That is exactly
			// why they are written now — a rule added alongside the first
			// deployment job is a rule written by the person who wanted the job.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      - name: Validate toolchain contract\n",
						'      - name: Print a credential\n        run: echo "${{ secrets.EXAMPLE_TOKEN }}"\n\n      - name: Validate toolchain contract\n',
					),
				"ci: .github/workflows/ci.yml job ci must not interpolate a credential into a shell body",
			);
			// Declared at the workflow level a credential is in the environment of
			// every step of every job, including the ones that run a third-party
			// action and whatever that action loads.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						'env:\n  BUN_VERSION: "1.3.13"\n',
						'env:\n  BUN_VERSION: "1.3.13"\n  EXAMPLE_TOKEN: ${{ secrets.EXAMPLE_TOKEN }}\n',
					),
				"ci: .github/workflows/ci.yml must not expose a credential in a workflow-level env block",
			);
			// The job level looks scoped and is not: the step that needed it is
			// indistinguishable from the four that did not.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"    timeout-minutes: 20\n",
						"    timeout-minutes: 20\n    env:\n      EXAMPLE_TOKEN: ${{ secrets.EXAMPLE_TOKEN }}\n",
					),
				"ci: .github/workflows/ci.yml job ci must not expose a credential in a job-level env block",
			);
			// The spec sentence at the one layer a workflow can be checked at:
			// credential presence alone must not authorize the write.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"      - name: Validate toolchain contract\n        run: bun run toolchain:check\n",
						"      - name: Validate toolchain contract\n        run: bun run toolchain:check\n        env:\n          EXAMPLE_TOKEN: ${{ secrets.EXAMPLE_TOKEN }}\n",
					),
				"ci: .github/workflows/ci.yml job ci passes a credential to an unconditional step; credential presence alone must not authorize a write",
			);
			// ... and the same step with an `if:` is legal, or the rule would be a
			// ban on credentials rather than a rule about how they are used.
			await tolerate(temporary, CI_WORKFLOW, (source) =>
				source.replace(
					"      - name: Validate toolchain contract\n        run: bun run toolchain:check\n",
					"      - name: Validate toolchain contract\n        if: ${{ github.ref == 'refs/heads/main' }}\n        run: bun run toolchain:check\n        env:\n          EXAMPLE_TOKEN: ${{ secrets.EXAMPLE_TOKEN }}\n",
				),
			);
			// A fork-writable credential context runs with the base repository's
			// secrets against a head the fork controls.
			await mutate(
				temporary,
				CI_WORKFLOW,
				(source) =>
					source.replace(
						"  workflow_dispatch:\n",
						"  workflow_dispatch:\n  pull_request_target:\n    types: [opened]\n",
					),
				"ci: .github/workflows/ci.yml must not declare a pull_request_target trigger; a fork-writable credential context has no legitimate use in a template",
			);

			// --- One selector ------------------------------------------------------
			// A job's outputs decide what the lanes below it run, so two committed
			// files writing them are two authorities on "what must be checked" —
			// and they disagree exactly once, quietly, toward running less. The
			// variable name is assembled so this test file is not itself a writer.
			await withTrackedFile(
				temporary,
				"scripts/ci/second-selector.sh",
				`#!/usr/bin/env bash\necho "ci=[]" >> "$\{${["GITHUB", "OUTPUT"].join("_")}}"\n`,
				"ci: only one committed file may write job outputs; found scripts/ci/affected-matrices.sh, scripts/ci/second-selector.sh",
			);

			// --- Compiler coverage -------------------------------------------------
			// A tracked source no project claims is a file the compiler never sees,
			// which is exactly the hole a root tsconfig was added to close.
			await withTrackedFile(
				temporary,
				"tools/stray.ts",
				"export const stray = 1;\n",
				"ci: tools/stray.ts is outside every committed TypeScript project",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);

	test("keeps every rendered workflow's dependency graph whole", async () => {
		const temporary = await temporaryDirectory();
		try {
			for (const fixtureName of ["minimal", "cloud", "full"]) {
				const output = resolve(temporary, fixtureName);
				await renderFixture({ root: ROOT, fixtureName, output });
				const directory = resolve(output, ".github/workflows");
				const files = await readdir(directory);
				expect(files.length).toBeGreaterThan(0);
				for (const file of files) {
					const source = await Bun.file(resolve(directory, file)).text();
					// Every rendered workflow still has to be YAML at all: a fence that
					// removed a mapping's last key produces a file the runner rejects
					// before it reports anything.
					expect(
						Bun.YAML.parse(source) as Record<string, unknown>,
					).toBeObject();
					expect(
						validateWorkflowGraph(source, `.github/workflows/${file}`),
					).toEqual([]);
				}
			}
			// A project without the capability renders neither the job nor the
			// gate's dependency on it — and nothing else that names it either.
			const minimal = await Bun.file(
				resolve(temporary, "minimal/.github/workflows/ci.yml"),
			).text();
			expect(minimal).not.toContain("browser");
			// Same for the graph lane: neither the job, nor the gate's dependency
			// on it, nor the hermetic step in the `ci` job.
			expect(minimal).not.toContain("moon-graph");
			expect(minimal).not.toContain("graph:check");
			expect(minimal).not.toContain("setup-moon");
			// The selection lane, both halves. The mode variable and the selector
			// step are fenced; the `affected` and `project` JOBS are not, because
			// fencing them would leave a project without the capability with no
			// lint, no compiler and no suite at all. What such a project renders is
			// the seam with nothing in it, and the matrix falls back to one entry.
			expect(minimal).not.toContain("MOON_AFFECTED_MODE");
			expect(minimal).not.toContain("affected-matrices");
			expect(minimal).toContain("  affected:");
			expect(minimal).toContain("  project:");
			expect(minimal).toContain(
				"fromJSON(needs.affected.outputs.ci || '[\"repository\"]')",
			);
			expect(minimal).toContain("bash scripts/ci/run-tests.sh");
			expect(minimal).toContain("bun run typecheck");
			const full = await Bun.file(
				resolve(temporary, "full/.github/workflows/ci.yml"),
			).text();
			expect(full).toContain("moon-graph");
			expect(full).toContain("bun run graph:check --query");
			expect(full).toContain("bash scripts/ci/affected-matrices.sh");
			expect(full).toContain("MOON_AFFECTED_MODE");
			// The contract guard is one FENCED STEP in the existing `ci` job and
			// never a job of its own: its cost is fixed rather than scaling with
			// the graph, every sealed record's run-shape assertions are anchored on
			// the gate's own `needs`, and the renderer has no inverse fence — so a
			// step that leaked into a project without the capability would be an
			// invocation of a script that project's manifest does not declare.
			expect(minimal).not.toContain("forms:check");
			expect(full).toContain("bun run forms:check");
			const contractJob = (
				Bun.YAML.parse(full) as {
					jobs: Record<string, { steps?: Array<{ run?: string }> }>;
				}
			).jobs;
			expect(Object.keys(contractJob)).not.toContain("forms");
			expect(
				(contractJob["ci"]?.steps ?? []).some((step) =>
					(step.run ?? "").includes("bun run forms:check"),
				),
			).toBe(true);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);
});

describe("CI bootstrap action", () => {
	test("routes its install through the committed retry wrapper", async () => {
		const steps = await actionSteps();
		const install = steps.find((step) => step.name === "Install dependencies");
		expect(install?.run?.trim()).toBe("bash scripts/ci/bun-install-retry.sh");
		expect(install?.if).toBe("inputs.install != 'false'");
	});

	test("refuses an empty Bun version and accepts a supplied one", async () => {
		const body = await stepBody("Assert bun-version was supplied");
		const temporary = await temporaryDirectory();
		try {
			for (const [supplied, expected] of [
				["", 1],
				["1.3.13", 0],
			] as const) {
				const script = resolve(temporary, "assert-input.sh");
				await Bun.write(
					script,
					body.replaceAll("${{ inputs.bun-version }}", supplied),
				);
				const result = runScript(script, { cwd: temporary });
				expect(result.exitCode).toBe(expected);
				if (expected === 1) expect(result.output).toContain("::error::");
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("verifies the installed Bun against the pinned manifest", async () => {
		const body = await stepBody(
			"Assert the installed Bun matches the pinned toolchain",
		);
		const temporary = await temporaryDirectory();
		try {
			const script = resolve(temporary, "assert-pin.sh");
			await Bun.write(script, body);
			const workspace = resolve(temporary, "workspace");
			await mkdir(workspace, { recursive: true });
			const binDirectory = await fakeBinary(
				temporary,
				"bun",
				'[ "$1" = "--version" ] && echo "1.3.13"',
			);
			const env = { PATH: `${binDirectory}:${process.env["PATH"] ?? ""}` };

			// A missing authority is a hard failure, not a skipped check.
			const missing = runScript(script, { cwd: workspace, env });
			expect(missing.exitCode).toBe(1);
			expect(missing.output).toContain(".prototools is missing");

			await Bun.write(resolve(workspace, ".prototools"), 'bun = "1.3.13"\n');
			expect(runScript(script, { cwd: workspace, env }).exitCode).toBe(0);

			// The caller's input is only an intention until the binary agrees.
			await Bun.write(resolve(workspace, ".prototools"), 'bun = "1.3.14"\n');
			const drifted = runScript(script, { cwd: workspace, env });
			expect(drifted.exitCode).toBe(1);
			expect(drifted.output).toContain("differs from the .prototools pin");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("moon bootstrap action", () => {
	async function moonStepBody(name: string): Promise<string> {
		const value = Bun.YAML.parse(
			await Bun.file(resolve(ROOT, MOON_ACTION_PATH)).text(),
		) as Record<string, unknown>;
		const runs = value["runs"] as Record<string, unknown>;
		const step = (runs["steps"] as CompositeStep[]).find(
			(entry) => entry.name === name,
		);
		if (!step?.run) throw new Error(`composite step ${name} has no run body`);
		return step.run;
	}

	test("creates the base refs moon resolves before it is installed", async () => {
		// Under CI, moon resolves `git merge-base <defaultBranch> HEAD` eagerly,
		// and GitHub's single-branch checkout has no `main` — so the probe dies
		// with `fatal: ambiguous argument 'main'` before any task runs. The step
		// is executed here for what it does rather than read for what it says.
		const body = await moonStepBody("Ensure moon can resolve its VCS base ref");
		const temporary = await temporaryDirectory();
		try {
			const script = resolve(temporary, "ensure-base.sh");
			await Bun.write(script, body);

			const setup = async (options: {
				remote?: boolean;
				defaultBranch?: string;
			}): Promise<string> => {
				const workspace = resolve(
					temporary,
					`w-${Math.random().toString(36).slice(2)}`,
				);
				await mkdir(resolve(workspace, ".moon"), { recursive: true });
				await Bun.write(
					resolve(workspace, ".moon/workspace.yml"),
					`vcs:\n  defaultBranch: '${options.defaultBranch ?? "main"}'\n`,
				);
				git(workspace, "init", "-q", "-b", "detached-ci-ref");
				await Bun.write(resolve(workspace, "file.txt"), "x\n");
				git(workspace, "add", "-A");
				git(
					workspace,
					"-c",
					"user.email=a@b.c",
					"-c",
					"user.name=a",
					"commit",
					"-qm",
					"base",
				);
				if (options.remote)
					git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
				return workspace;
			};

			// GitHub's single-branch checkout: no local `main` at all.
			const bare = await setup({});
			expect(
				runScript(script, { cwd: bare, env: { HOME: bare } }).exitCode,
			).toBe(0);
			expect(
				Bun.spawnSync([
					"git",
					"-C",
					bare,
					"show-ref",
					"--verify",
					"refs/heads/main",
				]).exitCode,
			).toBe(0);

			// A remote-tracking ref is preferred over HEAD when one exists.
			const withRemote = await setup({ remote: true });
			expect(
				runScript(script, { cwd: withRemote, env: { HOME: withRemote } })
					.exitCode,
			).toBe(0);

			// A stacked pull request needs the base ref GitHub names too, because
			// moon honours it over the workspace's pinned default branch.
			const stacked = await setup({});
			expect(
				runScript(script, {
					cwd: stacked,
					env: { HOME: stacked, GITHUB_BASE_REF: "feature/parent" },
				}).exitCode,
			).toBe(0);
			expect(
				Bun.spawnSync([
					"git",
					"-C",
					stacked,
					"show-ref",
					"--verify",
					"refs/heads/feature/parent",
				]).exitCode,
			).toBe(0);

			// ... and a base ref that is not a branch name is refused rather than
			// handed to `git branch`.
			const hostile = await setup({});
			const refused = runScript(script, {
				cwd: hostile,
				env: { HOME: hostile, GITHUB_BASE_REF: "--force" },
			});
			expect(refused.exitCode).toBe(1);
			expect(refused.output).toContain("::error::");

			// The default branch is read from the workspace declaration, not
			// assumed: a repository that gates on `trunk` gets `trunk`.
			const trunk = await setup({ defaultBranch: "trunk" });
			expect(
				runScript(script, { cwd: trunk, env: { HOME: trunk } }).exitCode,
			).toBe(0);
			expect(
				Bun.spawnSync([
					"git",
					"-C",
					trunk,
					"show-ref",
					"--verify",
					"refs/heads/trunk",
				]).exitCode,
			).toBe(0);

			// A workspace with no declared default branch is a hard failure, not a
			// silently skipped step: the ref it would have created is the one moon
			// is about to ask for.
			const undeclared = await setup({});
			await Bun.write(resolve(undeclared, ".moon/workspace.yml"), "vcs: {}\n");
			expect(
				runScript(script, { cwd: undeclared, env: { HOME: undeclared } })
					.exitCode,
			).toBe(1);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("bounded dependency install", () => {
	test("kills a hung install, caps the attempts, and reports the timeout", async () => {
		const temporary = await temporaryDirectory();
		try {
			const workspace = resolve(temporary, "workspace");
			await mkdir(workspace, { recursive: true });
			await Bun.write(resolve(workspace, "bun.lock"), "{}\n");
			const binDirectory = await fakeBinary(temporary, "bun", "sleep 60");
			const started = Date.now();
			const result = runScript(RETRY_SCRIPT, {
				cwd: workspace,
				env: {
					PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
					BUN_INSTALL_TIMEOUT_SEC: "1",
					BUN_INSTALL_ATTEMPTS: "2",
					BUN_INSTALL_RETRY_SLEEP_SEC: "0",
				},
			});
			const elapsed = Date.now() - started;
			// A hang is only bounded if it is killed and surfaced as 124 rather
			// than left to consume the job's whole budget.
			expect(result.exitCode).toBe(124);
			expect(result.output).toContain("exit 124, hang");
			expect(result.output).toContain("attempt 2/2");
			expect(result.output).not.toContain("attempt 3/");
			expect(elapsed).toBeLessThan(30_000);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 60_000);

	test("retries a failing install and surfaces its real exit code", async () => {
		const temporary = await temporaryDirectory();
		try {
			const workspace = resolve(temporary, "workspace");
			await mkdir(workspace, { recursive: true });
			await Bun.write(resolve(workspace, "bun.lock"), "{}\n");
			const binDirectory = await fakeBinary(temporary, "bun", "exit 7");
			const result = runScript(RETRY_SCRIPT, {
				cwd: workspace,
				env: {
					PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
					BUN_INSTALL_ATTEMPTS: "2",
					BUN_INSTALL_RETRY_SLEEP_SEC: "0",
				},
			});
			expect(result.exitCode).toBe(7);
			expect(result.output).toContain("failed (exit 7)");
			expect(result.output).toContain("after 2 attempts");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);

	test("preserves the frozen and first-lock install semantics", async () => {
		const temporary = await temporaryDirectory();
		try {
			const workspace = resolve(temporary, "workspace");
			await mkdir(workspace, { recursive: true });
			const argumentLog = resolve(temporary, "arguments");
			const binDirectory = await fakeBinary(
				temporary,
				"bun",
				`printf '%s\\n' "$*" >> "${argumentLog}"\n[ -n "\${FAKE_BUN_SKIP_LOCK:-}" ] || printf '{}\\n' > bun.lock`,
			);
			const env = {
				PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
				BUN_INSTALL_ATTEMPTS: "1",
				BUN_INSTALL_RETRY_SLEEP_SEC: "0",
			};

			// A freshly rendered project has no lock and must create its first one.
			expect(runScript(RETRY_SCRIPT, { cwd: workspace, env }).exitCode).toBe(0);
			expect(await Bun.file(resolve(workspace, "bun.lock")).exists()).toBe(
				true,
			);
			expect(await Bun.file(argumentLog).text()).toBe("install\n");

			// With a lock present the install may never rewrite it.
			expect(runScript(RETRY_SCRIPT, { cwd: workspace, env }).exitCode).toBe(0);
			expect(await Bun.file(argumentLog).text()).toBe(
				"install\ninstall --frozen-lockfile\n",
			);

			// A first install that leaves no lock behind is not a success.
			await rm(resolve(workspace, "bun.lock"));
			const silent = runScript(RETRY_SCRIPT, {
				cwd: workspace,
				env: { ...env, FAKE_BUN_SKIP_LOCK: "1" },
			});
			expect(silent.exitCode).toBe(1);
			expect(silent.output).toContain("without writing bun.lock");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("bounded image build", () => {
	test("kills a hung build, caps the attempts, and reports the timeout", async () => {
		const temporary = await temporaryDirectory();
		try {
			const binDirectory = await fakeBinary(temporary, "docker", "sleep 60");
			const started = Date.now();
			const result = runScript(BUILD_RETRY_SCRIPT, {
				cwd: temporary,
				env: {
					PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
					DOCKER_BUILD_TIMEOUT_SEC: "1",
					DOCKER_BUILD_ATTEMPTS: "2",
					DOCKER_BUILD_RETRY_SLEEP_SEC: "0",
				},
			});
			const elapsed = Date.now() - started;
			// A stalled registry pull is only bounded if it is killed and surfaced
			// as 124 rather than left to consume the job's whole budget.
			expect(result.exitCode).toBe(124);
			expect(result.output).toContain("exit 124, hang");
			expect(result.output).toContain("attempt 2/2");
			expect(result.output).not.toContain("attempt 3/");
			expect(elapsed).toBeLessThan(30_000);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 60_000);

	test("retries a failing build and surfaces its real exit code", async () => {
		const temporary = await temporaryDirectory();
		try {
			const binDirectory = await fakeBinary(temporary, "docker", "exit 7");
			const result = runScript(BUILD_RETRY_SCRIPT, {
				cwd: temporary,
				env: {
					PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
					DOCKER_BUILD_ATTEMPTS: "2",
					DOCKER_BUILD_RETRY_SLEEP_SEC: "0",
				},
			});
			expect(result.exitCode).toBe(7);
			expect(result.output).toContain("failed (exit 7)");
			expect(result.output).toContain("after 2 attempts");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);

	test("forwards the build arguments verbatim and stops on success", async () => {
		const temporary = await temporaryDirectory();
		try {
			const argumentLog = resolve(temporary, "arguments");
			const binDirectory = await fakeBinary(
				temporary,
				"docker",
				`printf '%s\\n' "$*" >> "${argumentLog}"`,
			);
			const result = runScript(BUILD_RETRY_SCRIPT, {
				cwd: temporary,
				args: ["--target", "development", "--tag", "probe", "."],
				env: {
					PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
					DOCKER_BUILD_ATTEMPTS: "3",
					DOCKER_BUILD_RETRY_SLEEP_SEC: "0",
				},
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("succeeded on attempt 1/3");
			// The wrapper owns bounding and retries and NOTHING else: the command
			// the fake saw must be the caller's argument list, once, unedited.
			expect(await Bun.file(argumentLog).text()).toBe(
				"build --target development --tag probe .\n",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("aggregate gate", () => {
	const GATE_SCRIPT = resolve(ROOT, "scripts/ci/aggregate-gate.sh");

	function runGate(results: string, draft: string): number {
		return Bun.spawnSync({
			cmd: ["bash", GATE_SCRIPT],
			cwd: ROOT,
			env: { ...process.env, RESULTS: results, DRAFT: draft },
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode;
	}

	test("derives its verdict from the upstream results", () => {
		// The matrix runs against the committed script, not a paraphrase of it.
		expect(runGate("success,skipped", "false")).toBe(0);
		expect(runGate("success,success", "")).toBe(0);
		expect(runGate("success,failure", "false")).toBe(1);
		// A cancelled job is an unbounded job or a superseded run, never a pass.
		expect(runGate("success,cancelled", "false")).toBe(1);
		// Nothing fed the gate: a green here would be a gate over nothing.
		expect(runGate("", "false")).toBe(1);
	});

	test("refuses to go green on a draft even when every job was skipped", () => {
		// Gating jobs carry `if: !draft`, so on a draft they all report skipped and
		// the results check alone would pass — letting the PR merge the instant it
		// is marked ready, before anything revalidated it.
		expect(runGate("skipped,skipped", "true")).toBe(1);
		const result = Bun.spawnSync({
			cmd: ["bash", GATE_SCRIPT],
			cwd: ROOT,
			env: { ...process.env, RESULTS: "skipped,skipped", DRAFT: "true" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toContain("Mark it ready for review");
	});

	test("skips every gating job on a draft", async () => {
		const parameters = Bun.TOML.parse(
			await Bun.file(resolve(ROOT, "template-parameters.toml")).text(),
		) as Record<string, Record<string, unknown>>;
		const gateId = String(parameters["ci"]?.["aggregate_gate_name"]);
		const value = Bun.YAML.parse(
			await Bun.file(resolve(ROOT, CI_WORKFLOW)).text(),
		) as Record<string, unknown>;
		const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
		// The gate itself is exempt: it is the job that has to keep reporting when
		// every other one was skipped.
		expect(jobs[gateId]?.["name"]).toBe("CI gate");
		for (const [id, job] of Object.entries(jobs)) {
			if (id === gateId) continue;
			// Every gating job carries the draft guard. The heavy lane carries one
			// more clause — an empty matrix means there is nothing to run — so the
			// assertion is "starts with the draft guard" rather than "is only the
			// draft guard", which would forbid the selection outright.
			expect([id, job["if"]]).toEqual([
				id,
				expect.stringContaining("${{ !github.event.pull_request.draft"),
			]);
		}
	});
});

describe("failure tolerance", () => {
	test("runs the suite and the compiler through their committed wrappers", async () => {
		const value = Bun.YAML.parse(
			await Bun.file(resolve(ROOT, CI_WORKFLOW)).text(),
		) as Record<string, unknown>;
		const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
		// The three steps whose cost scales with the project graph live in the
		// matrix job; the contract job keeps every fixed-cost guard and nothing
		// that a selection could ever skip.
		const steps = jobs["project"]?.["steps"] as CompositeStep[];
		const bodies = steps.map((step) => step.run ?? "");
		expect(bodies).toContain("bash scripts/ci/run-tests.sh");
		expect(bodies).toContain("bun run typecheck");
		const contractBodies = (jobs["ci"]?.["steps"] as CompositeStep[]).map(
			(step) => step.run ?? "",
		);
		expect(contractBodies).toContain("bun run ci:check");
		expect(contractBodies).not.toContain("bun run typecheck");
		expect(contractBodies).not.toContain("bash scripts/ci/run-tests.sh");
		// bun test through the wrapper is a superset of the template suite, so
		// listing template:test as well ran the same tests twice.
		expect(bodies.join("\n")).not.toContain("bun run template:test");
		const scripts = (
			(await Bun.file(resolve(ROOT, "package.json")).json()) as {
				scripts: Record<string, string>;
			}
		).scripts;
		expect(scripts["typecheck"]).toBe("bash scripts/ci/run-typecheck.sh");
		expect(scripts["ci:check"]).toBe("bun scripts/template/validate-ci.ts");
	});

	test("separates an empty suite from a failing one", async () => {
		const temporary = await temporaryDirectory();
		try {
			const script = resolve(ROOT, "scripts/ci/run-tests.sh");
			// No test files at all: reported, not failed.
			const empty = runScript(script, { cwd: temporary });
			expect(empty.exitCode).toBe(0);
			expect(empty.output).toContain("::notice::");

			await Bun.write(
				resolve(temporary, "green.test.ts"),
				'import { expect, test } from "bun:test";\ntest("green", () => {\n\texpect(1).toBe(1);\n});\n',
			);
			expect(runScript(script, { cwd: temporary }).exitCode).toBe(0);

			// A suite that ran and failed must never look like a suite that was
			// not there — that is the whole failure mode continue-on-error had.
			await Bun.write(
				resolve(temporary, "red.test.ts"),
				'import { expect, test } from "bun:test";\ntest("red", () => {\n\texpect(1).toBe(2);\n});\n',
			);
			const failing = runScript(script, { cwd: temporary });
			expect(failing.exitCode).toBe(1);
			expect(failing.output).not.toContain("::notice::");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 60_000);

	// The case above can only ever exercise whichever wording THIS machine's Bun
	// emits, and the two are not the same: macOS builds say `error: 0 test files
	// matching ...`, the Linux runners CI uses say `No tests found!`. A wrapper
	// that classifies only the local one is green on a laptop and red on every
	// runner, so both are driven here through a stand-in `bun` — together with a
	// real failure that merely quotes the same words, which must still fail.
	test("classifies every wording of an empty suite and nothing else", async () => {
		const temporary = await temporaryDirectory();
		try {
			const script = resolve(ROOT, "scripts/ci/run-tests.sh");
			const run = async (body: string) => {
				const binDirectory = await fakeBinary(temporary, "bun", body);
				return runScript(script, {
					cwd: temporary,
					env: { PATH: `${binDirectory}:${process.env["PATH"] ?? ""}` },
				});
			};
			for (const report of [
				'echo "error: 0 test files matching **{.test,.spec}.{js,ts} in --cwd=/x"',
				'echo "No tests found!"',
			]) {
				const absorbed = await run(`${report}\nexit 1`);
				expect(absorbed.exitCode).toBe(0);
				expect(absorbed.output).toContain("::notice::");
			}
			const quoted = await run(
				'echo "(fail) reports No tests found! for the empty case"\nexit 1',
			);
			expect(quoted.exitCode).toBe(1);
			expect(quoted.output).not.toContain("::notice::");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 60_000);

	test("separates an empty compiler run from a failing one", async () => {
		const temporary = await temporaryDirectory();
		try {
			await Bun.write(
				resolve(temporary, "tsconfig.json"),
				`${JSON.stringify({ include: ["src/**/*.ts"] }, null, "\t")}\n`,
			);
			const script = resolve(ROOT, "scripts/ci/run-typecheck.sh");
			// TS18003 is the one tsc failure that means "there was nothing to
			// check"; every other diagnostic means the check found something.
			const empty = runScript(script, { cwd: temporary });
			expect(empty.exitCode).toBe(0);
			expect(empty.output).toContain("::notice::");

			await mkdir(resolve(temporary, "src"), { recursive: true });
			await Bun.write(
				resolve(temporary, "src/broken.ts"),
				"export const answer: number = 'not a number';\n",
			);
			const failing = runScript(script, { cwd: temporary });
			expect(failing.exitCode).not.toBe(0);
			expect(failing.output).not.toContain("::notice::");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);

	test("keeps the trigger and tolerance policy identical in both lanes", async () => {
		for (const path of WORKFLOWS) {
			const source = await Bun.file(resolve(ROOT, path)).text();
			// The contract owns these rules; this asserts the non-gating lane is
			// really inside its scope rather than quietly exempted.
			expect(source).toContain("ready_for_review");
			expect(source).not.toMatch(/^\s*continue-on-error:/m);
			expect(source).toContain("uses: ./.github/actions/setup-bun");
		}
	});
});
