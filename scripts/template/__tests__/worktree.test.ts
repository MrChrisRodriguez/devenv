import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const RUNTIME_FILES = ["contract.toml", "lib.sh", "lock.sh", "env.sh"] as const;

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
