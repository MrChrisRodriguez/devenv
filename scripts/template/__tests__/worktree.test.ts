import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const RUNTIME_FILES = [
	"contract.toml",
	"lib.sh",
	"lock.sh",
	"env.sh",
	"ensure.sh",
	"exec.sh",
	"manifest.sh",
] as const;

interface Harness {
	root: string;
	home: string;
	main: string;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

// A deliberately narrow environment: the runtime branches on DEVCONTAINER and
// CODEX_CLOUD, so inheriting the ambient environment would make these tests pass
// or fail depending on where they run.
function runtimeEnvironment(
	home: string,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		PATH: process.env["PATH"] ?? "",
		HOME: home,
		TMPDIR: process.env["TMPDIR"] ?? "/tmp",
		LANG: "C",
		...overrides,
	};
}

function run(
	worktree: string,
	home: string,
	script: string,
	args: string[] = [],
	overrides: Record<string, string> = {},
): RunResult {
	const result = Bun.spawnSync(
		["bash", resolve(worktree, "scripts/worktree", script), ...args],
		{
			cwd: worktree,
			env: runtimeEnvironment(home, overrides),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: { PATH: process.env["PATH"] ?? "", HOME: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

async function harness(): Promise<Harness> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-worktree-"));
	const home = resolve(root, "home");
	const main = resolve(root, "main");
	await mkdir(home, { recursive: true });
	await mkdir(resolve(main, "scripts/worktree"), { recursive: true });
	for (const name of RUNTIME_FILES) {
		const destination = resolve(main, "scripts/worktree", name);
		await Bun.write(
			destination,
			Bun.file(resolve(ROOT, "scripts/worktree", name)),
		);
		if (name.endsWith(".sh")) await chmod(destination, 0o755);
	}
	// The definition fingerprint hashes exactly the inputs the contract declares,
	// so the fixture tree has to carry them or every readiness check fails for the
	// wrong reason.
	await Bun.write(resolve(main, ".dockerignore"), "node_modules\n");
	await Bun.write(resolve(main, ".prototools"), 'bun = "1.3.13"\n');
	await Bun.write(
		resolve(main, ".devcontainer/devcontainer.json"),
		`${JSON.stringify({ name: "Fixture", remoteUser: "vscode" }, null, "\t")}\n`,
	);
	await git(main, "init", "-q", "-b", "main");
	await git(main, "config", "user.email", "worktree@example.test");
	await git(main, "config", "user.name", "Worktree Fixture");
	await git(main, "add", "-A");
	await git(main, "commit", "-qm", "runtime");
	return { root, home, main };
}

async function addWorktree(
	harnessRoot: Harness,
	relativePath: string,
	branch: string,
): Promise<string> {
	const path = resolve(harnessRoot.root, relativePath);
	await mkdir(resolve(path, ".."), { recursive: true });
	await git(harnessRoot.main, "worktree", "add", "-q", path, "-b", branch);
	return path;
}

// Four contiguous service ports: the whole point of arbitrating on port sets
// rather than offset numbers is that offsets 5 and 6 collide on real ports when
// the declared bases are adjacent.
const CONTIGUOUS_SERVICES = [
	'services = ["alpha", "bravo", "charlie", "delta"]',
	...["alpha", "bravo", "charlie", "delta"].flatMap((name, index) => [
		`service_${name}_kind = "backend"`,
		`service_${name}_base_port = ${9000 + index}`,
		`service_${name}_depends_on = []`,
		`service_${name}_directory = "apps/${name}"`,
		`service_${name}_command = "bun run dev"`,
		`service_${name}_health_path = "/health"`,
		`service_${name}_health_expectation = "json-status-ok"`,
		`service_${name}_profiles = ["minimal", "cloud", "full"]`,
	]),
].join("\n");

async function rewriteContract(
	worktree: string,
	transform: (source: string) => string,
): Promise<void> {
	const path = resolve(worktree, "scripts/worktree/contract.toml");
	await Bun.write(path, transform(await Bun.file(path).text()));
}

function environmentValue(source: string, key: string): string {
	const match = new RegExp(`^${key}=(.*)$`, "m").exec(source);
	if (!match?.[1]) throw new Error(`No ${key} in the generated environment`);
	return match[1];
}

async function generatedEnvironment(worktree: string): Promise<string> {
	return Bun.file(resolve(worktree, ".dev/state/worktree.env")).text();
}

function registryPath(home: string): string {
	return resolve(home, ".config/devcontainer/ports-registry/ports.json");
}

async function readRegistry(
	home: string,
): Promise<{ schemaVersion: number; entries: Record<string, Entry> }> {
	return Bun.file(registryPath(home)).json();
}

interface Entry {
	path: string;
	family: string;
	offset: number;
	publishedHostPort: number;
	ports: number[];
}

function disjoint(left: number[], right: number[]): boolean {
	const seen = new Set(left);
	return right.every((port) => !seen.has(port));
}

// Stub container tooling. These tests are about the ownership and convergence
// rules, not about Docker: the stubs record what the runtime asked for and
// answer with exactly the state the test set up.
const DOCKER_STUB = `#!/usr/bin/env bash
set -u
state="$STUB_STATE"
case "\${1:-}" in
	info) exit 0 ;;
	ps)
		[ -f "$state/owned" ] || exit 0
		cat "$state/container.id"
		exit 0
		;;
	container)
		[ -f "$state/owned" ] || exit 1
		[ "\${!#}" = "$(cat "$state/container.id")" ] || exit 1
		cat "$state/inspect"
		exit 0
		;;
	exec)
		printf '%s\\n' "$*" >>"$state/exec.log"
		exit 0
		;;
esac
exit 0
`;

const DEVCONTAINER_STUB = `#!/usr/bin/env bash
set -u
state="$STUB_STATE"
printf '%s\\n' "$*" >>"$state/up.log"
if [ -f "$state/fail" ]; then
	echo "stub devcontainer up failed" >&2
	exit 1
fi
cp "$state/inspect.healthy" "$state/inspect"
: >"$state/owned"
exit 0
`;

interface Tooling {
	bin: string;
	state: string;
}

const CONTAINER_ID = "a".repeat(64);

async function stubTooling(
	fixture: Harness,
	worktree: string,
): Promise<Tooling> {
	const bin = resolve(fixture.root, "bin");
	const state = resolve(fixture.root, "stub-state");
	await mkdir(bin, { recursive: true });
	await mkdir(state, { recursive: true });
	for (const [name, source] of [
		["docker", DOCKER_STUB],
		["devcontainer", DEVCONTAINER_STUB],
	] as const) {
		const path = resolve(bin, name);
		await Bun.write(path, source);
		await chmod(path, 0o755);
	}
	await Bun.write(resolve(state, "container.id"), CONTAINER_ID);
	await Bun.write(
		resolve(state, "inspect.healthy"),
		healthyInspect(worktree, gitCommonDirectory(worktree)),
	);
	return { bin, state };
}

function gitCommonDirectory(worktree: string): string {
	const result = Bun.spawnSync(
		[
			"git",
			"-C",
			worktree,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{
			env: { PATH: process.env["PATH"] ?? "", HOME: worktree },
			stdout: "pipe",
		},
	);
	return result.stdout.toString().trim();
}

function healthyInspect(worktree: string, commonDirectory: string): string {
	return [
		"true",
		worktree,
		resolve(worktree, ".devcontainer/devcontainer.json"),
		`${commonDirectory}>${commonDirectory};`,
	].join("\t");
}

function toolingEnvironment(
	fixture: Harness,
	tooling: Tooling,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		PATH: `${tooling.bin}:${process.env["PATH"] ?? ""}`,
		STUB_STATE: tooling.state,
		...overrides,
	};
}

function fingerprint(worktree: string, fixture: Harness): string {
	const result = Bun.spawnSync(
		[
			"bash",
			resolve(worktree, "scripts/worktree/ensure.sh"),
			"--definition-fingerprint",
		],
		{
			cwd: worktree,
			env: runtimeEnvironment(fixture.home),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return result.stdout.toString().trim();
}

// Bring a worktree to the exact state the fast path is supposed to accept:
// generated environment present, ready record agreeing with the recorded id, and
// an owned running container that carries the Git metadata mount.
async function markReady(
	fixture: Harness,
	worktree: string,
	tooling: Tooling,
	overrides: { fingerprint?: string; containerId?: string } = {},
): Promise<void> {
	expect(run(worktree, fixture.home, "env.sh").exitCode).toBe(0);
	const id = overrides.containerId ?? CONTAINER_ID;
	const digest = overrides.fingerprint ?? fingerprint(worktree, fixture);
	await mkdir(resolve(worktree, ".dev/state/run"), { recursive: true });
	await Bun.write(resolve(worktree, ".dev/state/run/container.id"), `${id}\n`);
	await Bun.write(
		resolve(worktree, ".dev/state/run/container.ready"),
		`${id} ${digest}\n`,
	);
	await Bun.write(resolve(tooling.state, "container.id"), CONTAINER_ID);
	await Bun.write(
		resolve(tooling.state, "inspect"),
		await Bun.file(resolve(tooling.state, "inspect.healthy")).text(),
	);
	await Bun.write(resolve(tooling.state, "owned"), "");
}

async function upLog(tooling: Tooling): Promise<string[]> {
	const path = resolve(tooling.state, "up.log");
	if (!(await Bun.file(path).exists())) return [];
	return (await Bun.file(path).text()).trim().split("\n").filter(Boolean);
}

describe("worktree identity and port allocation", () => {
	test("two worktrees receive disjoint port sets and registry entries", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const bravo = await addWorktree(
				fixture,
				"agent/worktrees/bravo",
				"bravo",
			);
			for (const worktree of [alpha, bravo]) {
				await rewriteContract(worktree, (source) =>
					source.replace("services = []", CONTIGUOUS_SERVICES),
				);
			}

			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			expect(run(bravo, fixture.home, "env.sh").exitCode).toBe(0);

			const registry = await readRegistry(fixture.home);
			expect(registry.schemaVersion).toBe(1);
			// The parent directory is a container, not an identity: a worktree under
			// `<owner>/worktrees/<name>` is named for its grandparent.
			expect(Object.keys(registry.entries).sort()).toEqual([
				"devenv-agent-alpha",
				"devenv-agent-bravo",
			]);
			const first = registry.entries["devenv-agent-alpha"] as Entry;
			const second = registry.entries["devenv-agent-bravo"] as Entry;
			expect(first.path).toBe(alpha);
			expect(second.path).toBe(bravo);
			expect(first.offset).not.toBe(second.offset);
			expect(first.ports).toHaveLength(5);
			expect(disjoint(first.ports, second.ports)).toBe(true);

			// The main checkout keeps offset 0 and is never registered.
			expect(run(fixture.main, fixture.home, "env.sh").exitCode).toBe(0);
			expect(
				Object.keys(await readRegistry(fixture.home).then((r) => r.entries)),
			).toHaveLength(2);
			const mainEnvironment = await generatedEnvironment(fixture.main);
			expect(environmentValue(mainEnvironment, "DEVENV_WORKTREE_OFFSET")).toBe(
				"0",
			);
			expect(
				environmentValue(mainEnvironment, "DEVENV_WORKTREE_OFFSET_SOURCE"),
			).toBe("main");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("a recorded offset is adopted byte-identically on regeneration", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const first = await generatedEnvironment(alpha);
			const firstContainer = await Bun.file(
				resolve(alpha, ".dev/state/worktree.container.env"),
			).text();
			const registryBefore = await Bun.file(registryPath(fixture.home)).text();

			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			expect(await generatedEnvironment(alpha)).toBe(first);
			expect(
				await Bun.file(
					resolve(alpha, ".dev/state/worktree.container.env"),
				).text(),
			).toBe(firstContainer);
			// A regeneration that changes nothing must not rewrite the registry.
			expect(await Bun.file(registryPath(fixture.home)).text()).toBe(
				registryBefore,
			);

			// Reporting is a read: it never allocates and never writes.
			const reported = run(alpha, fixture.home, "env.sh", ["--json"]);
			expect(reported.exitCode).toBe(0);
			const report = JSON.parse(reported.stdout) as {
				offset: number;
				workspaceId: string;
				portSet: number[];
			};
			expect(report.workspaceId).toBe("devenv-agent-alpha");
			expect(String(report.offset)).toBe(
				environmentValue(first, "DEVENV_WORKTREE_OFFSET"),
			);
			expect(await generatedEnvironment(alpha)).toBe(first);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("adjacent offsets are rejected when derived port sets overlap", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			await rewriteContract(alpha, (source) =>
				source.replace("services = []", CONTIGUOUS_SERVICES),
			);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const claimed = Number(
				environmentValue(
					await generatedEnvironment(alpha),
					"DEVENV_WORKTREE_OFFSET",
				),
			);
			expect(claimed).toBeGreaterThan(1);

			// A neighbour one offset below overlaps on four of five real ports even
			// though the offset numbers differ. Offset uniqueness would accept it.
			const squatterOffset = claimed - 1;
			const squatterPorts = [8080, 9000, 9001, 9002, 9003].map(
				(base) => base + squatterOffset,
			);
			const registry = await readRegistry(fixture.home);
			registry.entries["devenv-neighbour"] = {
				path: resolve(fixture.root, "neighbour"),
				family: "neighbour",
				offset: squatterOffset,
				publishedHostPort: squatterPorts[0] as number,
				ports: squatterPorts,
			};
			await Bun.write(
				registryPath(fixture.home),
				`${JSON.stringify(registry, null, 2)}\n`,
			);

			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const moved = await readRegistry(fixture.home);
			const relocated = moved.entries["devenv-agent-alpha"] as Entry;
			expect(relocated.offset).not.toBe(claimed);
			expect(relocated.offset).not.toBe(squatterOffset);
			expect(disjoint(relocated.ports, squatterPorts)).toBe(true);
			expect(
				Math.abs(relocated.offset - squatterOffset),
			).toBeGreaterThanOrEqual(4);
			expect(
				environmentValue(
					await generatedEnvironment(alpha),
					"DEVENV_WORKTREE_OFFSET_SOURCE",
				),
			).toBe("alternate");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("two families sanitizing to one workspace id fail loudly", async () => {
		const fixture = await harness();
		try {
			const dotted = await addWorktree(fixture, "team/my.service", "dotted");
			const hyphened = await addWorktree(
				fixture,
				"team/my-service",
				"hyphened",
			);
			expect(run(dotted, fixture.home, "env.sh").exitCode).toBe(0);
			expect(Object.keys((await readRegistry(fixture.home)).entries)).toEqual([
				"devenv-team-my-service",
			]);

			const collided = run(hyphened, fixture.home, "env.sh");
			expect(collided.exitCode).toBe(3);
			expect(collided.stderr).toContain("devenv-team-my-service");
			expect(collided.stderr).toContain(dotted);
			// A refused allocation leaves the incumbent's registry entry untouched.
			const registry = await readRegistry(fixture.home);
			expect(Object.keys(registry.entries)).toEqual(["devenv-team-my-service"]);
			expect((registry.entries["devenv-team-my-service"] as Entry).path).toBe(
				dotted,
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("--release removes the registry entry", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const bravo = await addWorktree(
				fixture,
				"agent/worktrees/bravo",
				"bravo",
			);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			expect(run(bravo, fixture.home, "env.sh").exitCode).toBe(0);

			expect(run(alpha, fixture.home, "env.sh", ["--release"]).exitCode).toBe(
				0,
			);
			expect(Object.keys((await readRegistry(fixture.home)).entries)).toEqual([
				"devenv-agent-bravo",
			]);
			// Releasing twice is not an error, and the main checkout owns nothing to
			// release.
			expect(run(alpha, fixture.home, "env.sh", ["--release"]).exitCode).toBe(
				0,
			);
			const mainRelease = run(fixture.main, fixture.home, "env.sh", [
				"--release",
			]);
			expect(mainRelease.exitCode).toBe(0);
			expect(mainRelease.stderr).toContain("never registered");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("concurrent allocations across worktrees serialize to disjoint sets", async () => {
		const fixture = await harness();
		try {
			const names = ["one", "two", "three", "four"];
			const worktrees: string[] = [];
			for (const name of names) {
				const worktree = await addWorktree(
					fixture,
					`agent/worktrees/${name}`,
					name,
				);
				await rewriteContract(worktree, (source) =>
					source.replace("services = []", CONTIGUOUS_SERVICES),
				);
				worktrees.push(worktree);
			}

			const running = worktrees.map((worktree) =>
				Bun.spawn(["bash", resolve(worktree, "scripts/worktree/env.sh")], {
					cwd: worktree,
					env: runtimeEnvironment(fixture.home),
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			for (const process of running) expect(await process.exited).toBe(0);

			const registry = await readRegistry(fixture.home);
			const entries = Object.values(registry.entries);
			expect(entries).toHaveLength(names.length);
			for (const [index, entry] of entries.entries()) {
				for (const other of entries.slice(index + 1)) {
					expect(disjoint(entry.ports, other.ports)).toBe(true);
				}
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("allocation refuses to write the registry inside a container", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);

			for (const marker of ["DEVCONTAINER", "CODEX_CLOUD"]) {
				const ungenerated = run(alpha, fixture.home, "env.sh", [], {
					[marker]: "true",
				});
				expect(ungenerated.exitCode).not.toBe(0);
				expect(ungenerated.stderr).toContain("generate it on the host first");
				expect(await Bun.file(registryPath(fixture.home)).exists()).toBe(false);

				const forced = run(alpha, fixture.home, "env.sh", ["--force"], {
					[marker]: "true",
				});
				expect(forced.exitCode).not.toBe(0);
				expect(forced.stderr).toContain("host-side operation");
				expect(await Bun.file(registryPath(fixture.home)).exists()).toBe(false);
			}

			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const generated = await generatedEnvironment(alpha);
			const registryBefore = await Bun.file(registryPath(fixture.home)).text();

			const adopted = run(alpha, fixture.home, "env.sh", [], {
				DEVCONTAINER: "true",
			});
			expect(adopted.exitCode).toBe(0);
			expect(adopted.stderr).toContain(
				"adopted the host-generated environment",
			);
			expect(await generatedEnvironment(alpha)).toBe(generated);
			expect(await Bun.file(registryPath(fixture.home)).text()).toBe(
				registryBefore,
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("exhaustion exits 4 and names every registered environment", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const bravo = await addWorktree(
				fixture,
				"agent/worktrees/bravo",
				"bravo",
			);
			for (const worktree of [alpha, bravo]) {
				await rewriteContract(worktree, (source) =>
					source
						.replace(
							/^preferred_offset_modulus = .*$/m,
							"preferred_offset_modulus = 1",
						)
						.replace(
							/^collision_scan_limit = .*$/m,
							"collision_scan_limit = 1",
						),
				);
			}
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);

			const exhausted = run(bravo, fixture.home, "env.sh");
			expect(exhausted.exitCode).toBe(4);
			expect(exhausted.stderr).toContain("no free port offset in 1-1");
			expect(exhausted.stderr).toContain("devenv-agent-alpha");
			expect(exhausted.stderr).toContain(alpha);
			expect(
				await Bun.file(resolve(bravo, ".dev/state/worktree.env")).exists(),
			).toBe(false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("sourcing the runtime library writes nothing", async () => {
		const fixture = await harness();
		try {
			const probe = Bun.spawnSync(
				[
					"bash",
					"-c",
					`. "${resolve(fixture.main, "scripts/worktree/lib.sh")}"; ` +
						`. "${resolve(fixture.main, "scripts/worktree/lock.sh")}"; ` +
						'printf "%s\\n" "$(wt_contract_value project_slug)"',
				],
				{
					cwd: fixture.main,
					env: runtimeEnvironment(fixture.home),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(probe.stderr.toString()).toBe("");
			expect(probe.exitCode).toBe(0);
			expect(probe.stdout.toString().trim()).toBe("devenv");
			expect(await readdir(fixture.home)).toEqual([]);
			expect(await Bun.file(resolve(fixture.main, ".dev")).exists()).toBe(
				false,
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);

	test("the host fingerprint equals the image-owned Bun fingerprint", () => {
		const host = Bun.spawnSync(
			[
				"bash",
				"-c",
				'. "$1/scripts/worktree/lib.sh"; wt_definition_fingerprint',
				"bash",
				ROOT,
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(host.stderr.toString()).toBe("");
		expect(host.exitCode).toBe(0);
		const image = Bun.spawnSync(
			["bash", ".devcontainer/devcontainer-fingerprint.sh", "."],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(image.exitCode).toBe(0);
		expect(host.stdout.toString().trim()).toMatch(/^[0-9a-f]{64}$/);
		expect(host.stdout.toString().trim()).toBe(image.stdout.toString().trim());
	}, 60_000);
});

describe("worktree container ensure", () => {
	test("accepts the recorded running container owned by this worktree", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling);

			const fast = run(
				alpha,
				fixture.home,
				"ensure.sh",
				["--check-ready"],
				toolingEnvironment(fixture, tooling),
			);
			expect(fast.exitCode).toBe(0);
			expect(fast.stdout.trim()).toBe(CONTAINER_ID);
			expect(await upLog(tooling)).toEqual([]);

			// The full path re-checks under the lock and converges without starting
			// anything.
			const full = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(full.exitCode).toBe(0);
			expect(full.stdout.trim()).toBe(CONTAINER_ID);
			expect(await upLog(tooling)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("rejects a ready record whose id, labels, config path, running state, or git mount is wrong", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			const common = gitCommonDirectory(alpha);
			const healthy = healthyInspect(alpha, common);
			const mutations: Array<[string, () => Promise<void>]> = [
				[
					"id shape",
					async () => {
						await Bun.write(
							resolve(alpha, ".dev/state/run/container.id"),
							"not-a-container-id\n",
						);
					},
				],
				[
					"checkout label",
					async () => {
						await Bun.write(
							resolve(tooling.state, "inspect"),
							healthy.replace(alpha, resolve(fixture.root, "someone-else")),
						);
					},
				],
				[
					"config path label",
					async () => {
						await Bun.write(
							resolve(tooling.state, "inspect"),
							healthy.replace(
								resolve(alpha, ".devcontainer/devcontainer.json"),
								resolve(alpha, ".devcontainer/other.json"),
							),
						);
					},
				],
				[
					"running state",
					async () => {
						await Bun.write(
							resolve(tooling.state, "inspect"),
							healthy.replace("true", "false"),
						);
					},
				],
				[
					"git metadata mount",
					async () => {
						await Bun.write(
							resolve(tooling.state, "inspect"),
							healthy.replace(`${common}>${common};`, ""),
						);
					},
				],
			];

			let observed = 0;
			for (const [label, mutate] of mutations) {
				await markReady(fixture, alpha, tooling);
				await mutate();
				const refused = run(
					alpha,
					fixture.home,
					"ensure.sh",
					["--check-ready"],
					toolingEnvironment(fixture, tooling),
				);
				expect(`${label}:${refused.exitCode}`).toBe(`${label}:1`);
				expect(refused.stdout).toBe("");

				const reconciled = run(
					alpha,
					fixture.home,
					"ensure.sh",
					[],
					toolingEnvironment(fixture, tooling),
				);
				expect(`${label}:${reconciled.exitCode}`).toBe(`${label}:0`);
				observed += 1;
				expect(await upLog(tooling)).toHaveLength(observed);
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("rejects a stale definition fingerprint and recreates with --remove-existing-container", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling, { fingerprint: "0".repeat(64) });

			const reconciled = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(reconciled.exitCode).toBe(0);
			expect(reconciled.stderr).toContain("its definition changed");
			const invocations = await upLog(tooling);
			expect(invocations).toHaveLength(1);
			expect(invocations[0]).toContain("--remove-existing-container");
			expect(invocations[0]).toContain(
				`--mount type=bind,source=${gitCommonDirectory(alpha)}`,
			);

			// The recorded fingerprint now matches, so the next call takes the fast
			// path and starts nothing.
			expect(
				run(
					alpha,
					fixture.home,
					"ensure.sh",
					[],
					toolingEnvironment(fixture, tooling),
				).exitCode,
			).toBe(0);
			expect(await upLog(tooling)).toHaveLength(1);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("concurrent stale callers perform exactly one container start and converge", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling, { fingerprint: "0".repeat(64) });

			const callers = [0, 1, 2, 3].map(() =>
				Bun.spawn(["bash", resolve(alpha, "scripts/worktree/ensure.sh")], {
					cwd: alpha,
					env: {
						...runtimeEnvironment(fixture.home),
						...toolingEnvironment(fixture, tooling),
					},
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const outputs: string[] = [];
			for (const caller of callers) {
				expect(await caller.exited).toBe(0);
				outputs.push((await new Response(caller.stdout).text()).trim());
			}
			expect(new Set(outputs)).toEqual(new Set([CONTAINER_ID]));
			expect(await upLog(tooling)).toHaveLength(1);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("releases the lifecycle lock when the container start fails", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			await Bun.write(resolve(tooling.state, "fail"), "");

			const failed = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(failed.exitCode).not.toBe(0);
			expect(failed.stderr).toContain("stub devcontainer up failed");
			for (const leftover of ["ensure.lock", "ensure.lock.d"]) {
				expect(
					await Bun.file(resolve(alpha, ".dev/state/run", leftover)).exists(),
				).toBe(false);
			}

			// A released lock means the next caller proceeds instead of timing out.
			await rm(resolve(tooling.state, "fail"));
			const recovered = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(recovered.exitCode).toBe(0);
			expect(recovered.stdout.trim()).toBe(CONTAINER_ID);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("degrades with an actionable error when the container engine or CLI is absent", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);

			const bare = resolve(fixture.root, "empty-bin");
			await mkdir(bare, { recursive: true });
			const withoutEngine = run(alpha, fixture.home, "ensure.sh", [], {
				PATH: `${bare}:/usr/bin:/bin`,
				STUB_STATE: tooling.state,
			});
			expect(withoutEngine.exitCode).toBe(6);
			expect(withoutEngine.stderr).toContain("docker");

			// Engine present, CLI absent: the error has to name the package the host
			// is missing, not just the command.
			const engineOnly = resolve(fixture.root, "engine-only");
			await mkdir(engineOnly, { recursive: true });
			await Bun.write(
				resolve(engineOnly, "docker"),
				await Bun.file(resolve(tooling.bin, "docker")).text(),
			);
			await chmod(resolve(engineOnly, "docker"), 0o755);
			const withoutCli = run(alpha, fixture.home, "ensure.sh", [], {
				PATH: `${engineOnly}:/usr/bin:/bin`,
				STUB_STATE: tooling.state,
			});
			expect(withoutCli.exitCode).toBe(6);
			expect(withoutCli.stderr).toContain("@devcontainers/cli");
			expect(await upLog(tooling)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("refuses container lifecycle work from inside a container", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling);
			for (const marker of ["DEVCONTAINER", "CODEX_CLOUD"]) {
				const refused = run(
					alpha,
					fixture.home,
					"ensure.sh",
					[],
					toolingEnvironment(fixture, tooling, { [marker]: "true" }),
				);
				expect(refused.exitCode).not.toBe(0);
				expect(refused.stderr).toContain("host-side operation");
			}
			expect(await upLog(tooling)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("rejects unsupported ensure arguments", async () => {
		const fixture = await harness();
		try {
			const refused = run(fixture.main, fixture.home, "ensure.sh", [
				"--known-bad",
			]);
			expect(refused.exitCode).toBe(2);
			expect(refused.stderr).toContain(
				"Usage: bash scripts/worktree/ensure.sh",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);
});

// A stand-in for the canonical container environment. The bridge must source
// this file and let it own PATH and Proto activation instead of reassembling
// either itself.
const ENVIRONMENT_STUB = `#!/usr/bin/env bash
printf 'sourced\\n' >>"$BRIDGE_LOG"
export PATH="$WORKSPACE_BIN:$PATH"
devcontainer_environment_activate_proto() {
	printf 'activated\\n' >>"$BRIDGE_LOG"
}
`;

const CLOUD_LIBRARY_STUB = `#!/usr/bin/env bash
cloud_source_persisted_environment() {
	printf 'persisted\\n' >>"$BRIDGE_LOG"
	return 0
}
`;

const CLOUD_DOCTOR_STUB = `#!/usr/bin/env bash
printf 'doctor %s\\n' "$*" >>"$BRIDGE_LOG"
if [ -f "$CLOUD_UNHEALTHY" ]; then
	echo "stub cloud doctor: unhealthy" >&2
	exit 1
fi
exit 0
`;

async function writeExecutable(path: string, source: string): Promise<void> {
	await mkdir(resolve(path, ".."), { recursive: true });
	await Bun.write(path, source);
	await chmod(path, 0o755);
}

async function bridgeLog(path: string): Promise<string[]> {
	if (!(await Bun.file(path).exists())) return [];
	return (await Bun.file(path).text()).trim().split("\n").filter(Boolean);
}

describe("worktree command bridge", () => {
	test("executes directly inside the devcontainer through the canonical environment", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const log = resolve(fixture.root, "bridge.log");
			const workspaceBin = resolve(alpha, "node_modules/.bin");
			const environment = resolve(fixture.root, "environment.sh");
			await writeExecutable(environment, ENVIRONMENT_STUB);
			await mkdir(workspaceBin, { recursive: true });

			const executed = run(alpha, fixture.home, "exec.sh", ["printf", "ran"], {
				DEVCONTAINER: "true",
				DEVCONTAINER_ENVIRONMENT_FILE: environment,
				BRIDGE_LOG: log,
				WORKSPACE_BIN: workspaceBin,
			});
			expect(executed.exitCode).toBe(0);
			expect(executed.stdout).toBe("ran");
			// Sourced first, activated second, command last: any other order runs
			// project code outside the environment that owns it.
			expect(await bridgeLog(log)).toEqual(["sourced", "activated"]);

			// A missing canonical environment is fatal, not a silent fallback.
			const missing = run(alpha, fixture.home, "exec.sh", ["printf", "ran"], {
				DEVCONTAINER: "true",
				DEVCONTAINER_ENVIRONMENT_FILE: resolve(fixture.root, "absent.sh"),
				BRIDGE_LOG: log,
				WORKSPACE_BIN: workspaceBin,
			});
			expect(missing.exitCode).not.toBe(0);
			expect(missing.stderr).toContain("canonical container environment");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("runs the cloud doctor before executing in a verified cloud", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const log = resolve(fixture.root, "bridge.log");
			const unhealthy = resolve(fixture.root, "unhealthy");
			const sentinel = resolve(fixture.root, "cloud-command-ran");
			await writeExecutable(
				resolve(alpha, ".codex/cloud/lib.sh"),
				CLOUD_LIBRARY_STUB,
			);
			await writeExecutable(
				resolve(alpha, ".codex/cloud/doctor.sh"),
				CLOUD_DOCTOR_STUB,
			);

			const healthy = run(alpha, fixture.home, "exec.sh", ["touch", sentinel], {
				CODEX_CLOUD: "true",
				BRIDGE_LOG: log,
				CLOUD_UNHEALTHY: unhealthy,
			});
			expect(healthy.exitCode).toBe(0);
			expect(await bridgeLog(log)).toEqual(["persisted", "doctor --quiet"]);
			expect(await Bun.file(sentinel).exists()).toBe(true);

			// An unhealthy cloud must abort before the command, not after it.
			await rm(sentinel);
			await Bun.write(unhealthy, "");
			await rm(log);
			const refused = run(alpha, fixture.home, "exec.sh", ["touch", sentinel], {
				CODEX_CLOUD: "true",
				BRIDGE_LOG: log,
				CLOUD_UNHEALTHY: unhealthy,
			});
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain("unhealthy");
			expect(await Bun.file(sentinel).exists()).toBe(false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("preserves exact arguments, the child exit status, and workspace binaries", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const log = resolve(fixture.root, "bridge.log");
			const workspaceBin = resolve(alpha, "node_modules/.bin");
			const systemBin = resolve(fixture.root, "system-bin");
			const environment = resolve(fixture.root, "environment.sh");
			await writeExecutable(environment, ENVIRONMENT_STUB);
			await writeExecutable(
				resolve(workspaceBin, "probe"),
				"#!/usr/bin/env bash\nprintf 'workspace'\n",
			);
			await writeExecutable(
				resolve(systemBin, "probe"),
				"#!/usr/bin/env bash\nprintf 'system'\n",
			);
			const inside = {
				DEVCONTAINER: "true",
				DEVCONTAINER_ENVIRONMENT_FILE: environment,
				BRIDGE_LOG: log,
				WORKSPACE_BIN: workspaceBin,
			};

			const preserved = run(
				alpha,
				fixture.home,
				"exec.sh",
				[
					"bash",
					"-c",
					'printf "%s|" "$@"; exit 42',
					"bash",
					"a b",
					"c'd",
					"$X",
				],
				inside,
			);
			expect(preserved.exitCode).toBe(42);
			expect(preserved.stdout).toBe("a b|c'd|$X|");

			// The environment the bridge sourced decides which binary wins.
			const resolved = run(alpha, fixture.home, "exec.sh", ["probe"], {
				...inside,
				PATH: `${systemBin}:${process.env["PATH"] ?? ""}`,
			});
			expect(resolved.exitCode).toBe(0);
			expect(resolved.stdout).toBe("workspace");

			// No command at all means a login shell, not an error.
			const shell = resolve(fixture.root, "login-shell");
			await writeExecutable(
				shell,
				"#!/usr/bin/env bash\nprintf 'login-shell %s' \"$*\"\n",
			);
			const opened = run(alpha, fixture.home, "exec.sh", [], {
				...inside,
				SHELL: shell,
			});
			expect(opened.exitCode).toBe(0);
			expect(opened.stdout).toBe("login-shell -l");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("maps a nested host directory and passes only allow-listed environment", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling);
			const nested = resolve(alpha, "apps/example");
			await mkdir(nested, { recursive: true });

			const bridged = Bun.spawnSync(
				[
					"bash",
					resolve(alpha, "scripts/worktree/exec.sh"),
					"bun",
					"run",
					"build",
				],
				{
					cwd: nested,
					env: {
						...runtimeEnvironment(fixture.home),
						...toolingEnvironment(fixture, tooling),
						LEAKED_HOST_SECRET: "must-not-cross",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(bridged.stderr.toString()).toBe("");
			expect(bridged.exitCode).toBe(0);

			const invocation = (
				await Bun.file(resolve(tooling.state, "exec.log")).text()
			).trim();
			expect(invocation).toContain("--workdir /workspace/apps/example");
			expect(invocation).toContain("--user vscode");
			expect(invocation).toContain(
				`${CONTAINER_ID} /usr/bin/bash /workspace/scripts/worktree/exec.sh -- bun run build`,
			);
			expect(invocation).not.toContain("must-not-cross");
			expect(invocation).not.toContain("LEAKED_HOST_SECRET");

			const bridgedNames = [...invocation.matchAll(/--env ([A-Z_]+)=/g)].map(
				(match) => match[1],
			);
			expect(bridgedNames.sort()).toEqual([
				"DEVCONTAINER_WORKTREE_ENV_FILE",
				"DEVENV_DIRECT_URL",
				"DEVENV_HOST_WORKTREE_ROOT",
				"DEVENV_PUBLIC_ORIGIN",
				"DEVENV_WORKSPACE_ID",
				"HOME",
			]);
			expect(invocation).toContain(
				"--env DEVCONTAINER_WORKTREE_ENV_FILE=/workspace/.dev/state/worktree.container.env",
			);

			// A directory outside the checkout has no container-relative answer, so
			// it lands at the workspace root rather than being guessed at.
			await rm(resolve(tooling.state, "exec.log"));
			const outside = Bun.spawnSync(
				["bash", resolve(alpha, "scripts/worktree/exec.sh"), "true"],
				{
					cwd: fixture.root,
					env: {
						...runtimeEnvironment(fixture.home),
						...toolingEnvironment(fixture, tooling),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(outside.exitCode).toBe(0);
			expect(
				(await Bun.file(resolve(tooling.state, "exec.log")).text()).trim(),
			).toContain("--workdir /workspace ");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("rejects unsupported bridge arguments", async () => {
		const fixture = await harness();
		try {
			const refused = run(fixture.main, fixture.home, "exec.sh", [
				"--known-bad",
			]);
			expect(refused.exitCode).toBe(2);
			expect(refused.stderr).toContain("Usage: bash scripts/worktree/exec.sh");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);
});

// A host Caddy stand-in. The friendly route is optional by contract, so these
// tests care about what the runtime asked Caddy to do and about what still
// works when Caddy refuses.
const CADDY_STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >>"$CADDY_LOG"
if [ -f "$CADDY_UNHEALTHY" ]; then
	echo "stub caddy: reload rejected" >&2
	exit 1
fi
exit 0
`;

interface Caddy {
	binary: string;
	config: string;
	log: string;
	unhealthy: string;
}

async function stubCaddy(fixture: Harness): Promise<Caddy> {
	const binary = resolve(fixture.root, "caddy-bin/caddy");
	const config = resolve(fixture.root, "Caddyfile");
	await writeExecutable(binary, CADDY_STUB);
	await Bun.write(config, "import caddy/*.caddy\n");
	return {
		binary,
		config,
		log: resolve(fixture.root, "caddy.log"),
		unhealthy: resolve(fixture.root, "caddy-unhealthy"),
	};
}

function caddyEnvironment(caddy: Caddy): Record<string, string> {
	return {
		DEVENV_HOST_CADDY_BIN: caddy.binary,
		DEVENV_HOST_CADDYFILE: caddy.config,
		CADDY_LOG: caddy.log,
		CADDY_UNHEALTHY: caddy.unhealthy,
	};
}

function manifestPath(home: string, workspaceId: string): string {
	return resolve(home, ".config/devcontainer/worktrees", `${workspaceId}.json`);
}

function snippetPath(home: string, workspaceId: string): string {
	return resolve(home, ".config/devcontainer/caddy", `${workspaceId}.caddy`);
}

interface Manifest {
	schemaVersion: number;
	workspaceId: string;
	repoPath: string;
	family: string;
	offset: number;
	containerPort: number;
	hostPort: number;
	directUrl: string;
	friendlyUrl: string;
	friendlyHost: string;
	persistenceRoot: string;
	status: string;
	updatedAt: string;
}

describe("worktree route manifest", () => {
	test("writes an active manifest and Caddy snippet and reloads host Caddy", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const caddy = await stubCaddy(fixture);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const generated = await generatedEnvironment(alpha);
			const port = environmentValue(generated, "DEVENV_PUBLISHED_HOST_PORT");

			const published = run(
				alpha,
				fixture.home,
				"manifest.sh",
				["active"],
				caddyEnvironment(caddy),
			);
			expect(published.exitCode).toBe(0);

			const manifest = (await Bun.file(
				manifestPath(fixture.home, "devenv-agent-alpha"),
			).json()) as Manifest;
			expect(manifest.schemaVersion).toBe(1);
			expect(manifest.status).toBe("active");
			expect(manifest.workspaceId).toBe("devenv-agent-alpha");
			expect(manifest.repoPath).toBe(alpha);
			expect(manifest.family).toBe("agent-alpha");
			expect(manifest.containerPort).toBe(8080);
			expect(String(manifest.hostPort)).toBe(port);
			expect(manifest.directUrl).toBe(`http://127.0.0.1:${port}`);
			expect(manifest.friendlyHost).toBe("agent-alpha.devenv.localhost");
			// The persistence root is the generated one under this checkout, never a
			// literal any script carries.
			expect(manifest.persistenceRoot).toBe(resolve(alpha, ".dev/persistence"));

			const snippet = await Bun.file(
				snippetPath(fixture.home, "devenv-agent-alpha"),
			).text();
			expect(snippet).toContain("http://agent-alpha.devenv.localhost {");
			expect(snippet).toContain(`reverse_proxy 127.0.0.1:${port}`);
			expect(await bridgeLog(caddy.log)).toEqual([
				`reload --config ${caddy.config} --adapter caddyfile`,
			]);
			// Both routes are advertised, and the direct one is the authority.
			expect(published.stderr).toContain(`direct URL http://127.0.0.1:${port}`);
			expect(published.stderr).toContain(
				"friendly URL http://agent-alpha.devenv.localhost",
			);

			// `env` reports the same paths it just wrote, in a form a shell can eval.
			const reported = run(
				alpha,
				fixture.home,
				"manifest.sh",
				["env"],
				caddyEnvironment(caddy),
			);
			expect(reported.exitCode).toBe(0);
			// The reported path is canonical: symlinked temporary roots are resolved
			// before anything is written, so the value names the real file.
			expect(reported.stdout).toMatch(
				/^export DEVENV_MANIFEST_PATH=\/\S+\/worktrees\/devenv-agent-alpha\.json$/m,
			);
			expect(reported.stdout).toContain(
				`export DEVENV_PUBLISHED_HOST_PORT=${port}`,
			);
			const state = await Bun.file(
				resolve(alpha, ".dev/state/run/manifest.env"),
			).text();
			expect(state).toContain("DEVENV_WORKSPACE_ID=devenv-agent-alpha");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("marks inactive, removing only the snippet, then removes everything", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const caddy = await stubCaddy(fixture);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			expect(
				run(
					alpha,
					fixture.home,
					"manifest.sh",
					["active"],
					caddyEnvironment(caddy),
				).exitCode,
			).toBe(0);

			const stopped = run(
				alpha,
				fixture.home,
				"manifest.sh",
				["inactive"],
				caddyEnvironment(caddy),
			);
			expect(stopped.exitCode).toBe(0);
			// The manifest survives deactivation carrying the reserved ports; only the
			// route goes away.
			const manifest = (await Bun.file(
				manifestPath(fixture.home, "devenv-agent-alpha"),
			).json()) as Manifest;
			expect(manifest.status).toBe("inactive");
			expect(manifest.hostPort).toBeGreaterThan(8080);
			expect(
				await Bun.file(
					snippetPath(fixture.home, "devenv-agent-alpha"),
				).exists(),
			).toBe(false);
			expect(stopped.stderr).toContain("ports stay reserved");

			const removed = run(
				alpha,
				fixture.home,
				"manifest.sh",
				["remove"],
				caddyEnvironment(caddy),
			);
			expect(removed.exitCode).toBe(0);
			expect(
				await Bun.file(
					manifestPath(fixture.home, "devenv-agent-alpha"),
				).exists(),
			).toBe(false);
			expect(
				await Bun.file(
					snippetPath(fixture.home, "devenv-agent-alpha"),
				).exists(),
			).toBe(false);
			expect(
				await Bun.file(resolve(alpha, ".dev/state/run/manifest.env")).exists(),
			).toBe(false);
			// Every transition reloads the host route table exactly once.
			expect(await bridgeLog(caddy.log)).toHaveLength(3);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("keeps activation usable when the host Caddy reload fails", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const caddy = await stubCaddy(fixture);
			await Bun.write(caddy.unhealthy, "");
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);

			const published = run(
				alpha,
				fixture.home,
				"manifest.sh",
				["active"],
				caddyEnvironment(caddy),
			);
			expect(published.exitCode).toBe(0);
			expect(published.stderr).toContain("host Caddy reload failed");
			const port = environmentValue(
				await generatedEnvironment(alpha),
				"DEVENV_PUBLISHED_HOST_PORT",
			);
			expect(published.stderr).toContain(
				`http://127.0.0.1:${port} is authoritative`,
			);
			const manifest = (await Bun.file(
				manifestPath(fixture.home, "devenv-agent-alpha"),
			).json()) as Manifest;
			expect(manifest.status).toBe("active");

			// No host Caddy at all is the same guarantee, said differently.
			await rm(caddy.unhealthy);
			const withoutCaddy = run(alpha, fixture.home, "manifest.sh", ["active"], {
				DEVENV_HOST_CADDYFILE: resolve(fixture.root, "absent-Caddyfile"),
				PATH: "/usr/bin:/bin",
			});
			expect(withoutCaddy.exitCode).toBe(0);
			expect(withoutCaddy.stderr).toContain("is authoritative");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("publishes atomically, leaving no temporary file behind", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const caddy = await stubCaddy(fixture);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const path = manifestPath(fixture.home, "devenv-agent-alpha");

			const writers = [0, 1, 2, 3].map(() =>
				Bun.spawn(
					["bash", resolve(alpha, "scripts/worktree/manifest.sh"), "active"],
					{
						cwd: alpha,
						env: {
							...runtimeEnvironment(fixture.home),
							...caddyEnvironment(caddy),
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				),
			);
			// A concurrent reader must never observe a partial document.
			let reads = 0;
			while (writers.some((writer) => writer.killed === false) && reads < 200) {
				if (await Bun.file(path).exists()) {
					const snapshot = (await Bun.file(path).json()) as Manifest;
					expect(snapshot.workspaceId).toBe("devenv-agent-alpha");
					reads += 1;
				}
				await Bun.sleep(1);
			}
			for (const writer of writers) expect(await writer.exited).toBe(0);
			expect((await Bun.file(path).json()) as Manifest).toMatchObject({
				status: "active",
			});
			expect(
				await readdir(resolve(fixture.home, ".config/devcontainer/worktrees")),
			).toEqual(["devenv-agent-alpha.json"]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("refuses a manifest path outside the host config root", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);
			const outside = resolve(fixture.root, "escape");
			await rewriteContract(alpha, (source) =>
				source.replace(
					/^manifest_directory = .*$/m,
					`manifest_directory = "${outside}"`,
				),
			);

			const refused = run(alpha, fixture.home, "manifest.sh", ["active"]);
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain("outside the host configuration root");
			// A refused path is never created, let alone written to or deleted.
			expect(await Bun.file(outside).exists()).toBe(false);

			const rejected = run(alpha, fixture.home, "manifest.sh", ["known-bad"]);
			expect(rejected.exitCode).toBe(2);
			expect(rejected.stderr).toContain(
				"Usage: bash scripts/worktree/manifest.sh",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);
});
