// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML is a strict record.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Workflow fixtures quote runner expressions verbatim.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { filterCapabilityBlocks } from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");
const ACTION_PATH = ".github/actions/setup-bun/action.yml";
const RETRY_SCRIPT = resolve(ROOT, "scripts/ci/bun-install-retry.sh");
const WORKFLOWS = [
	".github/workflows/ci.yml",
	".github/workflows/codex-cloud-smoke.yml",
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
	options: { cwd: string; env?: Record<string, string> },
): { exitCode: number; output: string } {
	const result = Bun.spawnSync({
		cmd: ["bash", script],
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

describe("CI bootstrap action", () => {
	test("declares one required, defaultless Bun version input", async () => {
		const value = Bun.YAML.parse(await actionSource()) as Record<
			string,
			unknown
		>;
		const inputs = value["inputs"] as Record<string, Record<string, unknown>>;
		const bunVersion = inputs["bun-version"];
		expect(bunVersion).toBeDefined();
		expect(bunVersion?.["required"]).toBe(true);
		// A default here would be a second Bun authority sitting outside the
		// version guard, which reads bun-version assignments and nothing else.
		expect(Object.hasOwn(bunVersion ?? {}, "default")).toBe(false);
		expect(inputs["install"]?.["default"]).toBe("true");
	});

	test("writes no unavailable context expression into its metadata", async () => {
		// Composite metadata is a template the runner evaluates in full before any
		// step runs, and a composite action has none of these contexts. One such
		// expression anywhere in the file - a `with:` value or a documentation
		// sentence alike - fails the action to LOAD and reddens every caller.
		const source = await actionSource();
		expect(source).not.toMatch(/\$\{\{\s*(?:env|secrets|vars|needs|matrix)\./);
	});

	test("pins its third-party action to an immutable commit", async () => {
		const steps = await actionSteps();
		const setup = steps.find((step) =>
			step.uses?.includes("oven-sh/setup-bun"),
		);
		expect(setup?.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
		const install = steps.find((step) => step.name === "Install dependencies");
		expect(install?.run?.trim()).toBe("bash scripts/ci/bun-install-retry.sh");
		expect(install?.if).toBe("inputs.install != 'false'");
		// timeout-minutes is unsupported on composite steps; a bound written here
		// would be silently ignored rather than rejected.
		expect(await actionSource()).not.toMatch(/^\s*timeout-minutes:/m);
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

describe("workflow bootstrap wiring", () => {
	test("routes every job through the committed action at a pinned ref", async () => {
		for (const path of WORKFLOWS) {
			const source = await Bun.file(resolve(ROOT, path)).text();
			// The action is the sole owner of "how a job gets Bun"; a direct
			// setup-bun call is a second owner that drifts on its own schedule.
			expect(source).not.toMatch(/uses:\s*oven-sh\/setup-bun/);
			expect(source).toContain("uses: ./.github/actions/setup-bun");
			expect(source).toMatch(/^env:\n(?:.*\n)*?\s+BUN_VERSION: "1\.3\.13"$/m);
			for (const match of source.matchAll(/bun-version:\s*(\S.*)$/gm))
				expect(match[1]).toBe("${{ env.BUN_VERSION }}");
			for (const match of source.matchAll(/^\s+-?\s*uses:\s*(\S+)/gm)) {
				const reference = match[1] ?? "";
				if (reference.startsWith("./")) continue;
				expect(reference).toMatch(/@[0-9a-f]{40}$/);
			}
		}
	});
});

// The `pull_request` `branches:` filter matches the PR's BASE branch. A stacked
// pull request therefore matches nothing, runs zero jobs, and presents a page
// with no checks on it at all — which reads as "nothing to see here" rather than
// as "nothing ran". Detecting it needs both spellings, and comments that merely
// discuss the filter must not count as one.
function hasBaseBranchFilter(block: string): boolean {
	const uncommented = block
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	return /(?:^|[{,\s])["']?branches(?:-ignore)?["']?\s*:/m.test(uncommented);
}

function pullRequestBlocks(source: string): string[] {
	const lines = source.split("\n");
	const blocks: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const header = /^(\s*)pull_request:/.exec(line);
		if (!header) continue;
		const indent = (header[1] ?? "").length;
		const body = [line];
		for (let next = index + 1; next < lines.length; next += 1) {
			const candidate = lines[next] ?? "";
			if (candidate.trim() === "") {
				body.push(candidate);
				continue;
			}
			if ((/^\s*/.exec(candidate)?.[0] ?? "").length <= indent) break;
			body.push(candidate);
		}
		blocks.push(body.join("\n"));
	}
	return blocks;
}

describe("pull request trigger policy", () => {
	test("detects a base-branch filter in either spelling", () => {
		expect(hasBaseBranchFilter("  pull_request:\n    branches: [main]\n")).toBe(
			true,
		);
		expect(
			hasBaseBranchFilter('  pull_request: { "branches-ignore": [release] }'),
		).toBe(true);
		expect(
			hasBaseBranchFilter(
				"  pull_request:\n    # branches: would break stacked PRs\n    types: [opened]\n",
			),
		).toBe(false);
	});

	test("triggers every lane on any base branch and on readiness", async () => {
		for (const path of WORKFLOWS) {
			const source = await Bun.file(resolve(ROOT, path)).text();
			const blocks = pullRequestBlocks(source);
			expect(blocks.length).toBeGreaterThan(0);
			for (const block of blocks) {
				expect(hasBaseBranchFilter(block)).toBe(false);
				expect(block).toContain("ready_for_review");
			}
			const triggers = (Bun.YAML.parse(source) as Record<string, unknown>)[
				"on"
			] as Record<string, unknown>;
			expect(Object.hasOwn(triggers, "workflow_dispatch")).toBe(true);
		}
	});

	test("keeps draft and ready runs in separate cancellation lanes", async () => {
		for (const path of WORKFLOWS) {
			const source = await Bun.file(resolve(ROOT, path)).text();
			const concurrency = /^concurrency:\s*\n((?:^[ \t]+.*(?:\n|$))+)/m.exec(
				source,
			)?.[1];
			expect(concurrency).toBeDefined();
			expect(concurrency).toContain("github.ref");
			expect(concurrency).toContain("github.event.pull_request.draft");
			expect(concurrency).toContain("'draft' || 'ready'");
			expect(concurrency).toContain("cancel-in-progress: true");
		}
	});

	test("bounds every job and skips every gating job on a draft", async () => {
		const parameters = Bun.TOML.parse(
			await Bun.file(resolve(ROOT, "template-parameters.toml")).text(),
		) as Record<string, Record<string, unknown>>;
		const gateName = parameters["ci"]?.["aggregate_gate_name"];
		for (const path of WORKFLOWS) {
			const value = Bun.YAML.parse(
				await Bun.file(resolve(ROOT, path)).text(),
			) as Record<string, unknown>;
			const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
			for (const [id, job] of Object.entries(jobs)) {
				// An unbounded job cannot fail; it can only hang until the platform
				// cancels it, which the aggregate gate reads as a failure with no
				// diagnosis attached.
				expect(typeof job["timeout-minutes"]).toBe("number");
				if (id === gateName) continue;
				if (path.endsWith("codex-cloud-smoke.yml")) continue;
				expect(job["if"]).toBe("${{ !github.event.pull_request.draft }}");
			}
		}
	});
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

	test("depends on every other job and always reports", async () => {
		const parameters = Bun.TOML.parse(
			await Bun.file(resolve(ROOT, "template-parameters.toml")).text(),
		) as Record<string, Record<string, unknown>>;
		const gateId = String(parameters["ci"]?.["aggregate_gate_name"]);
		const source = await Bun.file(resolve(ROOT, WORKFLOWS[0])).text();
		const jobs = (Bun.YAML.parse(source) as Record<string, unknown>)[
			"jobs"
		] as Record<string, Record<string, unknown>>;
		const gate = jobs[gateId];
		expect(gate).toBeDefined();
		expect(gate?.["name"]).toBe("CI gate");
		// Without always() a skipped upstream leaves the required check pending
		// forever, which no further push can clear.
		expect(gate?.["if"]).toBe("${{ always() }}");
		// Membership: forgetting a job here is how a gate silently stops gating.
		expect(gate?.["needs"]).toEqual(
			Object.keys(jobs).filter((id) => id !== gateId),
		);
		const steps = gate?.["steps"] as CompositeStep[];
		const verdict = steps.at(-1) as Record<string, unknown>;
		expect(verdict["run"]).toBe("bash scripts/ci/aggregate-gate.sh");
		const env = verdict["env"] as Record<string, string>;
		expect(env["RESULTS"]).toBe("${{ join(needs.*.result, ',') }}");
		expect(env["DRAFT"]).toBe("${{ github.event.pull_request.draft }}");
	});

	test("keeps a need outside every capability fence", async () => {
		const source = await Bun.file(resolve(ROOT, WORKFLOWS[0])).text();
		// A fenced job and its fenced `needs` entry have to disappear together, or
		// the rendered workflow depends on a job that is not there.
		const stripped = filterCapabilityBlocks(source, {});
		const value = Bun.YAML.parse(stripped) as Record<string, unknown>;
		const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
		expect(Object.hasOwn(jobs, "browser")).toBe(false);
		const needs = jobs["ci-gate"]?.["needs"] as string[];
		expect(needs).not.toContain("browser");
		// Never fence a needs list into emptiness: a gate with no dependencies
		// reports success on a run in which nothing happened.
		expect(needs.length).toBeGreaterThan(0);
		for (const need of needs) expect(Object.hasOwn(jobs, need)).toBe(true);
	});

	test("interpolates no event metadata into a shell body", async () => {
		for (const path of WORKFLOWS) {
			const value = Bun.YAML.parse(
				await Bun.file(resolve(ROOT, path)).text(),
			) as Record<string, unknown>;
			const jobs = value["jobs"] as Record<string, Record<string, unknown>>;
			for (const job of Object.values(jobs)) {
				for (const step of (job["steps"] ?? []) as CompositeStep[]) {
					// Event metadata is attacker-influenced text. It may reach a step
					// as an `env:` value, never spliced into the script itself.
					expect(step.run ?? "").not.toContain("${{ github.event.");
				}
			}
		}
	});
});
