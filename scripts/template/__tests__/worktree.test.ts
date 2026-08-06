// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Mutations quote the literal ${localEnv:} and shell substitutions the runtime carries.
import { describe, expect, test } from "bun:test";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { validateWorktreeContract } from "../worktree-contract";

const ROOT = resolve(import.meta.dir, "../../..");
const RUNTIME_FILES = [
	"contract.toml",
	"lib.sh",
	"lock.sh",
	"env.sh",
	"ensure.sh",
	"exec.sh",
	"manifest.sh",
	"services.sh",
	"up.sh",
	"down.sh",
	"cleanup.sh",
	"selftest.sh",
	"doctor.sh",
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
		printf '%s\\n' "$*" >>"$state/ps.log"
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
	rm)
		printf '%s\\n' "$*" >>"$state/rm.log"
		[ -f "$state/sticky" ] || rm -f "$state/owned"
		exit 0
		;;
	volume)
		case "\${2:-}" in
			ls)
				[ ! -f "$state/volumes" ] || cat "$state/volumes"
				exit 0
				;;
			rm)
				printf '%s\\n' "$*" >>"$state/volume-rm.log"
				if [ -f "$state/volumes" ] && [ ! -f "$state/sticky" ]; then
					shift 2
					for name in "$@"; do
						[ "$name" != "--force" ] || continue
						grep -vx "$name" "$state/volumes" >"$state/volumes.next" || true
						mv "$state/volumes.next" "$state/volumes"
					done
				fi
				exit 0
				;;
		esac
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

	// The mkdir backend creates the lock directory first and records its owner an
	// instant later. Treating that window as free let a second caller steal a live
	// lock, and two holders of the registry lock is exactly one lost
	// read-modify-write, so the ownerless window must read as stale-by-age.
	//
	// Which backend runs is otherwise a property of the host - Linux has flock(1)
	// and macOS does not - so the backend is pinned here rather than inherited,
	// and both are exercised on every platform.
	test("a lock is never stolen before its owner record is written", async () => {
		const fixture = await harness();
		const lock = resolve(fixture.root, "state/portable.lock");
		const acquire = (timeout: number, overrides: Record<string, string> = {}) =>
			Bun.spawnSync(
				[
					"bash",
					"-c",
					'. "$1/scripts/worktree/lock.sh"; portable_lock_acquire "$2" "$3" || exit 1; portable_lock_release',
					"bash",
					ROOT,
					lock,
					String(timeout),
				],
				{
					cwd: fixture.root,
					env: {
						...runtimeEnvironment(fixture.home),
						PORTABLE_LOCK_BACKEND: "mkdir",
						...overrides,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		try {
			await mkdir(`${lock}.d`, { recursive: true });
			const contended = acquire(2);
			expect(contended.exitCode).not.toBe(0);
			expect(contended.stderr.toString()).toContain("timed out after 2s");

			// A complete record naming a process that is provably gone is the one
			// case that still reclaims immediately: that is what the pid is for.
			await Bun.write(`${lock}.d/owner`, "999999 1\n");
			expect(acquire(2).exitCode).toBe(0);

			// And an ownerless directory older than the staleness threshold is
			// reclaimed by age rather than deadlocking every later caller.
			await mkdir(`${lock}.d`, { recursive: true });
			expect(acquire(2, { WORKTREE_LOCK_STALE_SECONDS: "0" }).exitCode).toBe(0);

			// The flock backend has no window to race: the lock is a kernel lock on
			// an open descriptor, so it carries no owner record and a stray lock
			// directory is not its business at all.
			await mkdir(`${lock}.d`, { recursive: true });
			const withFlock = acquire(2, { PORTABLE_LOCK_BACKEND: "flock" });
			if (Bun.which("flock")) {
				expect(withFlock.exitCode).toBe(0);
				expect(await Bun.file(lock).exists()).toBe(true);
			} else {
				// No flock(1) on this host, so asking for it must fail loudly rather
				// than silently fall back to a different set of guarantees.
				expect(withFlock.exitCode).not.toBe(0);
			}
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
			// Only the mkdir backend's lock is a directory whose absence means
			// released. The flock backend's file is a rendezvous point that outlives
			// every holder on purpose: unlinking it would let a later caller lock a
			// fresh inode while an older one still holds the unlinked one. What must
			// be true on both is that the lock is no longer HELD, which the recovery
			// below is the honest test of.
			expect(
				await Bun.file(resolve(alpha, ".dev/state/run/ensure.lock.d")).exists(),
			).toBe(false);

			// A released lock means the next caller proceeds instead of timing out.
			// The short timeout is what makes this an assertion rather than a wait:
			// a still-held lock fails here in seconds instead of hanging.
			await rm(resolve(tooling.state, "fail"));
			const recovered = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling, {
					WORKTREE_ENSURE_LOCK_TIMEOUT_SECONDS: "5",
				}),
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

			// Absence is declared in the contract rather than staged by pruning PATH:
			// a CI runner ships a real docker in /usr/bin, so a PATH-based "missing
			// engine" is missing only on the machines that already agree with us.
			// Naming an engine that cannot exist exercises the same `command -v`.
			await rewriteContract(alpha, (source) =>
				source.replace(
					'container_engine = "docker"',
					'container_engine = "devenv-absent-engine"',
				),
			);
			const withoutEngine = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(withoutEngine.exitCode).toBe(6);
			expect(withoutEngine.stderr).toContain(
				"the devenv-absent-engine container engine is unavailable",
			);
			expect(withoutEngine.stderr).toContain("Docker Desktop");

			// Engine present, CLI absent: the error has to name the package the host
			// is missing, not just the command.
			await rewriteContract(alpha, (source) =>
				source
					.replace(
						'container_engine = "devenv-absent-engine"',
						'container_engine = "docker"',
					)
					.replace(
						'container_cli = "devcontainer"',
						'container_cli = "devenv-absent-cli"',
					),
			);
			const withoutCli = run(
				alpha,
				fixture.home,
				"ensure.sh",
				[],
				toolingEnvironment(fixture, tooling),
			);
			expect(withoutCli.exitCode).toBe(6);
			expect(withoutCli.stderr).toContain(
				"the devenv-absent-cli CLI is unavailable",
			);
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

	test("refuses ready-only work rather than starting a container", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			const sentinel = resolve(fixture.root, "hook-command-ran");

			// Nothing has reconciled this checkout, so the ready-only caller must
			// stop at the refusal: no `devcontainer up`, no `docker exec`, and above
			// all no requested command.
			const refused = Bun.spawnSync(
				[
					"bash",
					resolve(alpha, "scripts/worktree/exec.sh"),
					"--require-ready",
					"touch",
					sentinel,
				],
				{
					cwd: alpha,
					env: {
						...runtimeEnvironment(fixture.home),
						...toolingEnvironment(fixture, tooling),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(refused.exitCode).toBe(7);
			expect(refused.stderr.toString()).toContain(
				"Worktree bridge: this checkout's container is not ready",
			);
			expect(refused.stderr.toString()).toContain(
				"bash scripts/worktree/up.sh",
			);
			expect(await upLog(tooling)).toEqual([]);
			expect(await Bun.file(resolve(tooling.state, "exec.log")).exists()).toBe(
				false,
			);
			expect(await Bun.file(sentinel).exists()).toBe(false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("runs ready-only work through the container it already has", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			await markReady(fixture, alpha, tooling);

			const bridged = Bun.spawnSync(
				[
					"bash",
					resolve(alpha, "scripts/worktree/exec.sh"),
					"--require-ready",
					"bunx",
					"commitlint",
					"--edit",
					".git/COMMIT_EDITMSG",
				],
				{
					cwd: alpha,
					env: {
						...runtimeEnvironment(fixture.home),
						...toolingEnvironment(fixture, tooling),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(bridged.stderr.toString()).toBe("");
			expect(bridged.exitCode).toBe(0);

			// Exactly one container exec, carrying the command unchanged, and no
			// lifecycle work at all.
			const invocations = (
				await Bun.file(resolve(tooling.state, "exec.log")).text()
			)
				.trim()
				.split("\n");
			expect(invocations).toHaveLength(1);
			expect(invocations[0]).toContain(
				`${CONTAINER_ID} /usr/bin/bash /workspace/scripts/worktree/exec.sh -- bunx commitlint --edit .git/COMMIT_EDITMSG`,
			);
			expect(await upLog(tooling)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("accepts ready-only as a no-op inside the container", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			const log = resolve(fixture.root, "bridge.log");
			const workspaceBin = resolve(alpha, "node_modules/.bin");
			const environment = resolve(fixture.root, "environment.sh");
			await writeExecutable(environment, ENVIRONMENT_STUB);
			await mkdir(workspaceBin, { recursive: true });

			// Readiness is a host-side question. Inside the container the flag is
			// consumed and the command runs in place, exit status intact.
			const executed = run(
				alpha,
				fixture.home,
				"exec.sh",
				["--require-ready", "bash", "-c", 'printf "ran"; exit 42'],
				{
					...toolingEnvironment(fixture, tooling),
					DEVCONTAINER: "true",
					DEVCONTAINER_ENVIRONMENT_FILE: environment,
					BRIDGE_LOG: log,
					WORKSPACE_BIN: workspaceBin,
				},
			);
			expect(executed.exitCode).toBe(42);
			expect(executed.stdout).toBe("ran");
			expect(await bridgeLog(log)).toEqual(["sourced", "activated"]);
			expect(await Bun.file(resolve(tooling.state, "exec.log")).exists()).toBe(
				false,
			);
			expect(await upLog(tooling)).toEqual([]);
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

			// The ready-only flag does not open a hole in option parsing.
			const stillRefused = run(fixture.main, fixture.home, "exec.sh", [
				"--require-ready",
				"--known-bad",
			]);
			expect(stillRefused.exitCode).toBe(2);
			expect(stillRefused.stderr).toContain(
				"Usage: bash scripts/worktree/exec.sh",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);
});

// Husky v9 wiring, reproduced exactly: core.hooksPath points at .husky/_, whose
// per-hook wrapper runs the committed hook with `sh -e` from the top of the
// working tree. The hooks are POSIX sh because that is what actually executes
// them.
const HUSKY_WRAPPER = `#!/usr/bin/env sh
n=$(basename "$0")
export PATH="node_modules/.bin:$PATH"
sh -e ".husky/$n" "$@"
c=$?
[ $c != 0 ] && echo "husky - $n script failed (code $c)"
exit $c
`;

// A bridge stand-in. These tests are about what the hooks ask for, not about
// Docker: the stub records the exact argv, resolves the commit-message path the
// way a container would have to, and answers with whatever status the test set.
const HOOK_BRIDGE_STUB = `#!/usr/bin/env bash
set -u
printf 'invoke %s\\n' "$*" >>"$BRIDGE_LOG"
last="\${!#}"
if [ -f "$last" ]; then
	printf 'message-file %s\\n' "$last" >>"$BRIDGE_LOG"
	printf 'message-body %s\\n' "$(cat "$last")" >>"$BRIDGE_LOG"
fi
status="\${BRIDGE_EXIT:-0}"
if [ "$status" != "0" ]; then
	echo "Worktree bridge: this checkout's container is not ready; run bash scripts/worktree/up.sh" >&2
fi
exit "$status"
`;

const HOOK_FALLBACK_STUB = `#!/usr/bin/env bash
set -u
printf 'bunx %s\\n' "$*" >>"$FALLBACK_LOG"
exit 0
`;

interface HookFixture {
	root: string;
	main: string;
	bin: string;
	bridgeLog: string;
	fallbackLog: string;
}

function hookEnvironment(
	fixture: HookFixture,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		PATH: `${fixture.bin}:${process.env["PATH"] ?? ""}`,
		HOME: resolve(fixture.root, "home"),
		TMPDIR: process.env["TMPDIR"] ?? "/tmp",
		LANG: "C",
		BRIDGE_LOG: fixture.bridgeLog,
		FALLBACK_LOG: fixture.fallbackLog,
		...overrides,
	};
}

function gitRun(
	cwd: string,
	environment: Record<string, string>,
	...args: string[]
): RunResult {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// `bridge: false` reproduces a project rendered without the devcontainer
// capability: scripts/worktree does not exist at all, so the hooks' run-time file
// test is the only thing that can decide.
async function hookFixture(options: { bridge: boolean }): Promise<HookFixture> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-hooks-"));
	const main = resolve(root, "main");
	const bin = resolve(root, "bin");
	await mkdir(resolve(root, "home"), { recursive: true });
	for (const name of ["commit-msg", "pre-commit"] as const) {
		const destination = resolve(main, ".husky", name);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, ".husky", name), destination);
		await chmod(destination, 0o755);
		await writeExecutable(resolve(main, ".husky/_", name), HUSKY_WRAPPER);
	}
	await writeExecutable(resolve(bin, "bunx"), HOOK_FALLBACK_STUB);
	if (options.bridge)
		await writeExecutable(
			resolve(main, "scripts/worktree/exec.sh"),
			HOOK_BRIDGE_STUB,
		);
	const fixture: HookFixture = {
		root,
		main,
		bin,
		bridgeLog: resolve(root, "bridge.log"),
		fallbackLog: resolve(root, "fallback.log"),
	};
	const environment = hookEnvironment(fixture);
	gitRun(main, environment, "init", "-q", "-b", "main");
	gitRun(main, environment, "config", "user.email", "hooks@example.test");
	gitRun(main, environment, "config", "user.name", "Hook Fixture");
	gitRun(main, environment, "config", "core.hooksPath", ".husky/_");
	gitRun(main, environment, "add", "-A");
	const seeded = gitRun(
		main,
		environment,
		"commit",
		"--no-verify",
		"-qm",
		"chore: seed",
	);
	expect(seeded.exitCode).toBe(0);
	return fixture;
}

async function hookLog(path: string): Promise<string[]> {
	if (!(await Bun.file(path).exists())) return [];
	return (await Bun.file(path).text()).trim().split("\n").filter(Boolean);
}

describe("worktree git hook routing", () => {
	test("routes commitlint and lint-staged through the ready-only bridge", async () => {
		const fixture = await hookFixture({ bridge: true });
		try {
			const environment = hookEnvironment(fixture);
			await Bun.write(resolve(fixture.main, "feature.txt"), "one\n");
			gitRun(fixture.main, environment, "add", "feature.txt");
			const committed = gitRun(
				fixture.main,
				environment,
				"commit",
				"-m",
				"feat(hooks): route through the bridge",
			);
			expect(committed.exitCode).toBe(0);

			const invocations = await hookLog(fixture.bridgeLog);
			expect(invocations).toContain("invoke --require-ready bunx lint-staged");
			const commitlint = invocations.find((line) =>
				line.startsWith("invoke --require-ready bunx commitlint --edit "),
			);
			expect(commitlint).toBeDefined();
			// The bridge is never asked to build: hooks are not a build trigger.
			const asked = invocations.filter((line) => line.startsWith("invoke "));
			expect(asked).toHaveLength(2);
			expect(
				asked.every((line) => line.startsWith("invoke --require-ready ")),
			).toBe(true);
			// Whatever Git handed over resolved to the real message.
			expect(invocations).toContain(
				"message-body feat(hooks): route through the bridge",
			);
			expect(await hookLog(fixture.fallbackLog)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("reaches the commit message file from a linked worktree", async () => {
		const fixture = await hookFixture({ bridge: true });
		try {
			const environment = hookEnvironment(fixture);
			const linked = resolve(fixture.root, "worktrees/alpha");
			expect(
				gitRun(
					fixture.main,
					environment,
					"worktree",
					"add",
					"-q",
					linked,
					"-b",
					"alpha",
				).exitCode,
			).toBe(0);

			await Bun.write(resolve(linked, "linked.txt"), "two\n");
			gitRun(linked, environment, "add", "linked.txt");
			const committed = gitRun(
				linked,
				environment,
				"commit",
				"-m",
				"feat(hooks): commit from a linked worktree",
			);
			expect(committed.exitCode).toBe(0);

			const invocations = await hookLog(fixture.bridgeLog);
			const messageFile = invocations
				.find((line) => line.startsWith("message-file "))
				?.slice("message-file ".length);
			expect(messageFile).toBeDefined();
			// A linked worktree's message file lives under the shared Git common
			// directory, which ensure.sh mounts inside the container at this exact
			// absolute path. That is why the hook forwards "$1" unchanged.
			const commonDirectory = gitRun(
				linked,
				environment,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			).stdout.trim();
			expect(resolve(linked, messageFile ?? "")).toStartWith(
				`${commonDirectory}/`,
			);
			expect(invocations).toContain(
				"message-body feat(hooks): commit from a linked worktree",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("keeps the graphify staging guard on the host and ahead of the bridge", async () => {
		const fixture = await hookFixture({ bridge: true });
		try {
			const environment = hookEnvironment(fixture);
			await Bun.write(resolve(fixture.main, "graphify-out/graph.json"), "{}\n");
			await Bun.write(resolve(fixture.main, "feature.txt"), "three\n");
			gitRun(fixture.main, environment, "add", "-A");
			const refused = gitRun(
				fixture.main,
				environment,
				"commit",
				"-m",
				"feat(hooks): mixed graph and feature",
			);
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain(
				"graphify-out/graph.json is staged alongside non-graphify files",
			);
			// Pure Git plumbing, so it answers while the container is down — and it
			// answers before the bridge is consulted at all.
			expect(await hookLog(fixture.bridgeLog)).toEqual([]);
			expect(
				gitRun(
					fixture.main,
					environment,
					"rev-list",
					"--count",
					"HEAD",
				).stdout.trim(),
			).toBe("1");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("falls back to direct tooling when the runtime is not rendered", async () => {
		const fixture = await hookFixture({ bridge: false });
		try {
			const environment = hookEnvironment(fixture);
			await Bun.write(resolve(fixture.main, "feature.txt"), "four\n");
			gitRun(fixture.main, environment, "add", "feature.txt");
			const committed = gitRun(
				fixture.main,
				environment,
				"commit",
				"-m",
				"feat(hooks): direct tooling",
			);
			expect(committed.exitCode).toBe(0);

			const direct = await hookLog(fixture.fallbackLog);
			expect(direct).toContain("bunx lint-staged");
			expect(
				direct.some((line) => line.startsWith("bunx commitlint --edit ")),
			).toBe(true);
			expect(await hookLog(fixture.bridgeLog)).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("refuses the commit when this checkout has no ready container", async () => {
		const fixture = await hookFixture({ bridge: true });
		try {
			const environment = hookEnvironment(fixture, { BRIDGE_EXIT: "7" });
			await Bun.write(resolve(fixture.main, "feature.txt"), "five\n");
			gitRun(fixture.main, environment, "add", "feature.txt");
			const refused = gitRun(
				fixture.main,
				environment,
				"commit",
				"-m",
				"feat(hooks): refused while the container is down",
			);
			expect(refused.exitCode).not.toBe(0);
			// The refusal reaches the terminal unswallowed, and Husky reports the
			// hook's own status rather than flattening it.
			expect(refused.stderr).toContain(
				"this checkout's container is not ready",
			);
			expect(`${refused.stdout}${refused.stderr}`).toContain(
				"pre-commit script failed (code 7)",
			);
			// Above all: the commit did not land.
			expect(
				gitRun(
					fixture.main,
					environment,
					"rev-list",
					"--count",
					"HEAD",
				).stdout.trim(),
			).toBe("1");

			// The documented escape hatch still works.
			const forced = gitRun(
				fixture.main,
				environment,
				"commit",
				"--no-verify",
				"-m",
				"feat(hooks): escape hatch",
			);
			expect(forced.exitCode).toBe(0);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);
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

interface ServiceSpec {
	name: string;
	basePort: number;
	dependsOn: string[];
	expectation?: string;
}

// A synthetic registry. Declaration order is deliberately not dependency order,
// so a passing order assertion proves a sort rather than a coincidence.
function servicesToml(specs: ServiceSpec[]): string {
	return [
		`services = [${specs.map((spec) => `"${spec.name}"`).join(", ")}]`,
		...specs.flatMap((spec) => [
			`service_${spec.name}_kind = "backend"`,
			`service_${spec.name}_base_port = ${spec.basePort}`,
			`service_${spec.name}_depends_on = [${spec.dependsOn
				.map((name) => `"${name}"`)
				.join(", ")}]`,
			`service_${spec.name}_directory = "apps/${spec.name}"`,
			`service_${spec.name}_command = "bun server.ts"`,
			`service_${spec.name}_health_path = "/health"`,
			`service_${spec.name}_health_expectation = "${spec.expectation ?? "json-status-ok"}"`,
			`service_${spec.name}_profiles = ["full"]`,
		]),
	].join("\n");
}

async function declareServices(
	worktree: string,
	specs: ServiceSpec[],
	server: (spec: ServiceSpec) => string,
): Promise<void> {
	// Always start from the committed contract: a second declaration in one test
	// must replace the first rather than silently do nothing.
	const pristine = await Bun.file(
		resolve(ROOT, "scripts/worktree/contract.toml"),
	).text();
	await Bun.write(
		resolve(worktree, "scripts/worktree/contract.toml"),
		pristine.replace("services = []", servicesToml(specs)),
	);
	for (const spec of specs) {
		await Bun.write(
			resolve(worktree, `apps/${spec.name}/server.ts`),
			server(spec),
		);
	}
}

// A fake service: it announces itself, optionally waits, then answers its health
// path with whatever body the test wants to hold the runtime to.
function fakeService(
	name: string,
	options: { body?: string; delayMs?: number; exitAfterMs?: number } = {},
): string {
	const body = options.body ?? '{"status":"ok"}';
	return `import { appendFileSync } from "node:fs";
const log = process.env["ORDER_LOG"] as string;
appendFileSync(log, "start ${name}\\n");
setTimeout(() => {
	Bun.serve({
		port: Number(process.env["PORT"]),
		fetch: () =>
			new Response(${JSON.stringify(body)}, {
				headers: { "content-type": "application/json" },
			}),
	});
	appendFileSync(log, "ready ${name}\\n");
	${
		options.exitAfterMs === undefined
			? ""
			: `setTimeout(() => process.exit(0), ${options.exitAfterMs});`
	}
}, ${options.delayMs ?? 0});
`;
}

const DEPENDENT_SERVICES: ServiceSpec[] = [
	{ name: "renderer", basePort: 39103, dependsOn: ["platform"] },
	{ name: "gateway", basePort: 39101, dependsOn: [] },
	{ name: "platform", basePort: 39102, dependsOn: ["gateway"] },
];

function stopServices(worktree: string, home: string): void {
	run(worktree, home, "services.sh", ["stop"]);
}

async function probePort(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(2_000),
		});
		await response.text();
		return response.ok;
	} catch {
		return false;
	}
}

// Whether the port is still being served, polled until it settles on the
// expected answer. Stopping is judged here rather than by the recorded pid: the
// listener is frequently a grandchild of whatever pid the launch recorded, and a
// killed leader stays signalable until something reaps it, so a pid check can
// report a running service that is gone and a gone service that is running.
async function serviceAnswers(
	port: number,
	expected: boolean,
	timeoutMs = 10_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let answered = await probePort(port);
	while (answered !== expected && Date.now() < deadline) {
		await Bun.sleep(100);
		answered = await probePort(port);
	}
	return answered;
}

function devcontainerIdentity(worktree: string): string {
	const payload = JSON.stringify({
		"devcontainer.config_file": resolve(
			worktree,
			".devcontainer/devcontainer.json",
		),
		"devcontainer.local_folder": worktree,
	});
	const alphabet = "0123456789abcdefghijklmnopqrstuv";
	let value = 0n;
	for (const byte of new Bun.CryptoHasher("sha256").update(payload).digest())
		value = (value << 8n) | BigInt(byte);
	let digits = "";
	while (value > 0n) {
		digits = `${alphabet[Number(value % 32n)]}${digits}`;
		value /= 32n;
	}
	return digits.padStart(52, "0");
}

const VOLUME_PREFIXES = ["agent-config", "shell-history"] as const;

async function declareVolumes(worktree: string): Promise<string[]> {
	await Bun.write(
		resolve(worktree, ".devcontainer/devcontainer.json"),
		`${JSON.stringify(
			{
				name: "Fixture",
				remoteUser: "vscode",
				mounts: VOLUME_PREFIXES.map(
					(prefix) =>
						`source=${prefix}-\${devcontainerId},target=/home/vscode/${prefix},type=volume`,
				),
			},
			null,
			"\t",
		)}\n`,
	);
	const identity = devcontainerIdentity(worktree);
	return VOLUME_PREFIXES.map((prefix) => `${prefix}-${identity}`);
}

describe("worktree service lifecycle", () => {
	test("starts services in declared dependency order", async () => {
		const fixture = await harness();
		const alpha = await addWorktree(fixture, "agent/worktrees/alpha", "alpha");
		try {
			await declareServices(alpha, DEPENDENT_SERVICES, (spec) =>
				fakeService(spec.name),
			);
			const log = resolve(fixture.root, "order.log");

			const ordered = run(alpha, fixture.home, "services.sh", ["order"]);
			expect(ordered.exitCode).toBe(0);
			expect(ordered.stdout.trim().split("\n")).toEqual([
				"gateway",
				"platform",
				"renderer",
			]);

			const started = run(alpha, fixture.home, "services.sh", ["start"], {
				ORDER_LOG: log,
				DEVENV_SERVICE_START_TIMEOUT: "40",
			});
			expect(started.exitCode).toBe(0);
			// Every service is gated on the previous one becoming healthy, so the
			// interleaving is the proof: no service starts before its dependency is
			// ready.
			expect(await bridgeLog(log)).toEqual([
				"start gateway",
				"ready gateway",
				"start platform",
				"ready platform",
				"start renderer",
				"ready renderer",
			]);

			const status = run(alpha, fixture.home, "services.sh", ["status"]);
			expect(status.stdout).toContain("gateway\trunning\t39101");
			expect(status.stdout).toContain("renderer\trunning\t39103");
		} finally {
			stopServices(alpha, fixture.home);
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("rejects an unrelated HTTP 200 that does not match the health contract", async () => {
		const fixture = await harness();
		const alpha = await addWorktree(fixture, "agent/worktrees/alpha", "alpha");
		try {
			const specs: ServiceSpec[] = [
				{ name: "gateway", basePort: 39111, dependsOn: [] },
			];
			await declareServices(alpha, specs, (spec) =>
				fakeService(spec.name, { body: '{"ok":true}' }),
			);
			const log = resolve(fixture.root, "order.log");

			const refused = run(alpha, fixture.home, "services.sh", ["start"], {
				ORDER_LOG: log,
				DEVENV_SERVICE_START_TIMEOUT: "6",
			});
			expect(refused.exitCode).not.toBe(0);
			// A 200 is not readiness. The declared expectation is the contract.
			expect(refused.stderr).toContain(
				"did not satisfy json-status-ok at /health",
			);
			expect(await bridgeLog(log)).toEqual(["start gateway", "ready gateway"]);
			// A failed start leaves nothing running behind it.
			expect(
				await Bun.file(
					resolve(alpha, ".dev/state/run/services/gateway.pid"),
				).exists(),
			).toBe(false);
		} finally {
			stopServices(alpha, fixture.home);
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("fails fast when a service dies before or after readiness", async () => {
		const fixture = await harness();
		const alpha = await addWorktree(fixture, "agent/worktrees/alpha", "alpha");
		try {
			const log = resolve(fixture.root, "order.log");
			await declareServices(
				alpha,
				[{ name: "gateway", basePort: 39121, dependsOn: [] }],
				() =>
					'import { appendFileSync } from "node:fs";\n' +
					'appendFileSync(process.env["ORDER_LOG"] as string, "start gateway\\n");\n' +
					"process.exit(3);\n",
			);
			const early = run(alpha, fixture.home, "services.sh", ["start"], {
				ORDER_LOG: log,
				DEVENV_SERVICE_START_TIMEOUT: "20",
			});
			expect(early.exitCode).not.toBe(0);
			expect(early.stderr).toContain("exited before it became ready");

			// A dependency that dies while a later service is still starting fails the
			// whole run: a stack missing a service is not a running stack.
			await rm(log, { force: true });
			await declareServices(
				alpha,
				[
					{ name: "gateway", basePort: 39122, dependsOn: [] },
					{ name: "platform", basePort: 39123, dependsOn: ["gateway"] },
				],
				(spec) =>
					spec.name === "gateway"
						? fakeService("gateway", { exitAfterMs: 1_500 })
						: fakeService("platform", { delayMs: 15_000 }),
			);
			const late = run(alpha, fixture.home, "services.sh", ["start"], {
				ORDER_LOG: log,
				DEVENV_SERVICE_START_TIMEOUT: "40",
			});
			expect(late.exitCode).not.toBe(0);
			expect(late.stderr).toContain(
				"service 'gateway' exited while 'platform' was starting",
			);
		} finally {
			stopServices(alpha, fixture.home);
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("staggered mode replaces readiness gates with bounded delays", async () => {
		const fixture = await harness();
		const alpha = await addWorktree(fixture, "agent/worktrees/alpha", "alpha");
		try {
			const log = resolve(fixture.root, "order.log");
			// These services never answer their health path. Readiness gates would
			// time out; staggered mode is exactly the diagnostic that does not care.
			await declareServices(alpha, DEPENDENT_SERVICES, (spec) =>
				fakeService(spec.name, { delayMs: 600_000 }),
			);

			const staggered = run(alpha, fixture.home, "services.sh", ["start"], {
				ORDER_LOG: log,
				DEVENV_STARTUP_MODE: "staggered",
				DEVENV_STAGGER_SECONDS: "1",
			});
			expect(staggered.exitCode).toBe(0);
			expect(staggered.stderr).toContain("staggered mode: waiting 1s");
			expect(staggered.stderr).toContain("staggered mode: waiting 2s");
			expect(staggered.stderr).not.toContain("is ready on port");
			expect(await bridgeLog(log)).toEqual([
				"start gateway",
				"start platform",
				"start renderer",
			]);
		} finally {
			stopServices(alpha, fixture.home);
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("a cycle in depends_on exits 2", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			await declareServices(
				alpha,
				[
					{ name: "gateway", basePort: 39131, dependsOn: ["platform"] },
					{ name: "platform", basePort: 39132, dependsOn: ["gateway"] },
				],
				(spec) => fakeService(spec.name),
			);

			const cyclic = run(alpha, fixture.home, "services.sh", ["order"]);
			expect(cyclic.exitCode).toBe(2);
			expect(cyclic.stderr).toContain("cycle among");
			expect(cyclic.stderr).toContain("gateway");
			expect(cyclic.stderr).toContain("platform");

			// An undeclared dependency is the same class of contract error.
			await declareServices(
				alpha,
				[{ name: "gateway", basePort: 39133, dependsOn: ["absent"] }],
				(spec) => fakeService(spec.name),
			);
			const dangling = run(alpha, fixture.home, "services.sh", ["order"]);
			expect(dangling.exitCode).toBe(2);
			expect(dangling.stderr).toContain("which is not declared");

			const rejected = run(alpha, fixture.home, "services.sh", ["known-bad"]);
			expect(rejected.exitCode).toBe(2);
			expect(rejected.stderr).toContain(
				"Usage: bash scripts/worktree/services.sh",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("a template with no services starts the container and reports no services", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			const caddy = await stubCaddy(fixture);

			const up = run(
				alpha,
				fixture.home,
				"up.sh",
				[],
				toolingEnvironment(fixture, tooling, caddyEnvironment(caddy)),
			);
			expect(up.exitCode).toBe(0);
			expect(up.stderr).toContain("no services are declared");
			expect(up.stderr).toContain("devenv-agent-alpha is up");
			expect(await upLog(tooling)).toHaveLength(1);
			// The route is published even with nothing to route to yet: the container
			// is the thing that answers.
			const manifest = (await Bun.file(
				manifestPath(fixture.home, "devenv-agent-alpha"),
			).json()) as Manifest;
			expect(manifest.status).toBe("active");
			expect(
				await Bun.file(
					snippetPath(fixture.home, "devenv-agent-alpha"),
				).exists(),
			).toBe(true);

			const rejected = run(alpha, fixture.home, "up.sh", ["--known-bad"]);
			expect(rejected.exitCode).toBe(2);
			expect(rejected.stderr).toContain("Usage: bash scripts/worktree/up.sh");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("down stops services and keeps the registry entry and ports", async () => {
		const fixture = await harness();
		const alpha = await addWorktree(fixture, "agent/worktrees/alpha", "alpha");
		try {
			const caddy = await stubCaddy(fixture);
			await declareServices(alpha, DEPENDENT_SERVICES, (spec) =>
				fakeService(spec.name),
			);
			const log = resolve(fixture.root, "order.log");
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
			expect(
				run(alpha, fixture.home, "services.sh", ["start"], {
					ORDER_LOG: log,
					DEVENV_SERVICE_START_TIMEOUT: "40",
				}).exitCode,
			).toBe(0);
			// The port is the question, not the pid. A recorded pid can be a shell
			// that forked the real listener, and a killed leader lingers as a zombie
			// until something reaps it, so on both counts "is anything still
			// answering" is the only assertion that means what it says.
			expect(await serviceAnswers(39101, true)).toBe(true);

			// Inside the container the shutdown is the one that actually stops the
			// processes; on the host it is delegated across the boundary.
			const insideDown = run(alpha, fixture.home, "down.sh", [], {
				DEVCONTAINER: "true",
			});
			expect(insideDown.exitCode).toBe(0);
			for (const port of [39101, 39102, 39103]) {
				expect(`${port}:${await serviceAnswers(port, false)}`).toBe(
					`${port}:false`,
				);
			}
			expect(
				await Bun.file(resolve(alpha, ".dev/state/run/services")).exists(),
			).toBe(false);

			const environmentBefore = await generatedEnvironment(alpha);
			const registryBefore = await Bun.file(registryPath(fixture.home)).text();
			const hostDown = run(
				alpha,
				fixture.home,
				"down.sh",
				[],
				caddyEnvironment(caddy),
			);
			expect(hostDown.exitCode).toBe(0);
			expect(hostDown.stderr).toContain("run cleanup.sh to release them");
			// Ports survive a stop, so the same worktree comes back on the same URLs.
			expect(await generatedEnvironment(alpha)).toBe(environmentBefore);
			expect(await Bun.file(registryPath(fixture.home)).text()).toBe(
				registryBefore,
			);
			const manifest = (await Bun.file(
				manifestPath(fixture.home, "devenv-agent-alpha"),
			).json()) as Manifest;
			expect(manifest.status).toBe("inactive");
			expect(String(manifest.hostPort)).toBe(
				environmentValue(environmentBefore, "DEVENV_PUBLISHED_HOST_PORT"),
			);
		} finally {
			stopServices(alpha, fixture.home);
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("cleanup removes only this worktree's resources and exits nonzero when any remain", async () => {
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
			const tooling = await stubTooling(fixture, alpha);
			const caddy = await stubCaddy(fixture);
			const scoped = await declareVolumes(alpha);
			await Bun.write(
				resolve(tooling.state, "volumes"),
				`${[...scoped, "someone-elses-volume"].join("\n")}\n`,
			);
			for (const worktree of [alpha, bravo]) {
				expect(run(worktree, fixture.home, "env.sh").exitCode).toBe(0);
				expect(
					run(
						worktree,
						fixture.home,
						"manifest.sh",
						["active"],
						caddyEnvironment(caddy),
					).exitCode,
				).toBe(0);
				await Bun.write(resolve(worktree, ".dev/persistence/state.db"), "data");
			}
			await markReady(fixture, alpha, tooling);

			const cleaned = run(
				alpha,
				fixture.home,
				"cleanup.sh",
				[],
				toolingEnvironment(fixture, tooling, caddyEnvironment(caddy)),
			);
			expect(cleaned.exitCode).toBe(0);
			expect(cleaned.stderr).toContain(
				"removed every resource owned by devenv-agent-alpha",
			);

			for (const path of [
				resolve(alpha, ".dev/state"),
				resolve(alpha, ".dev/persistence"),
				manifestPath(fixture.home, "devenv-agent-alpha"),
				snippetPath(fixture.home, "devenv-agent-alpha"),
			]) {
				expect(await Bun.file(path).exists()).toBe(false);
			}
			expect(Object.keys((await readRegistry(fixture.home)).entries)).toEqual([
				"devenv-agent-bravo",
			]);

			// The sibling worktree is untouched: its state, route, and ports all
			// survive a neighbour's cleanup.
			for (const path of [
				resolve(bravo, ".dev/state/worktree.env"),
				resolve(bravo, ".dev/persistence/state.db"),
				manifestPath(fixture.home, "devenv-agent-bravo"),
				snippetPath(fixture.home, "devenv-agent-bravo"),
			]) {
				expect(await Bun.file(path).exists()).toBe(true);
			}
			// Removal is by exact name, derived from this checkout's own container
			// identity. A volume belonging to anything else is never named.
			const volumeRemovals = await bridgeLog(
				resolve(tooling.state, "volume-rm.log"),
			);
			expect(volumeRemovals.sort()).toEqual(
				scoped.map((name) => `volume rm --force ${name}`).sort(),
			);
			expect(await Bun.file(resolve(tooling.state, "volumes")).text()).toBe(
				"someone-elses-volume\n",
			);
			const removals = await bridgeLog(resolve(tooling.state, "rm.log"));
			expect(removals).toHaveLength(1);
			const queries = (await bridgeLog(resolve(tooling.state, "ps.log"))).join(
				"\n",
			);
			expect(queries).toContain(alpha);
			expect(queries).not.toContain(bravo);

			// A cleanup whose removals silently fail must not report success.
			const charlie = await addWorktree(
				fixture,
				"agent/worktrees/charlie",
				"charlie",
			);
			expect(run(charlie, fixture.home, "env.sh").exitCode).toBe(0);
			await markReady(fixture, charlie, tooling);
			await Bun.write(resolve(tooling.state, "sticky"), "");
			const incomplete = run(
				charlie,
				fixture.home,
				"cleanup.sh",
				[],
				toolingEnvironment(fixture, tooling, caddyEnvironment(caddy)),
			);
			expect(incomplete.exitCode).toBe(1);
			expect(incomplete.stderr).toContain("survived cleanup");
			expect(incomplete.stderr).toContain(`container ${CONTAINER_ID}`);
			expect(incomplete.stderr).toContain(
				"cleanup is incomplete for devenv-agent-charlie",
			);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 180_000);

	test("cleanup runs the declared legacy cleanup commands", async () => {
		const fixture = await harness();
		try {
			const alpha = await addWorktree(
				fixture,
				"agent/worktrees/alpha",
				"alpha",
			);
			const tooling = await stubTooling(fixture, alpha);
			const caddy = await stubCaddy(fixture);
			const sentinel = resolve(fixture.root, "legacy-ran");
			await rewriteContract(alpha, (source) =>
				source.replace(
					"legacy_cleanup_commands = []",
					`legacy_cleanup_commands = ["touch ${sentinel}", "touch ${sentinel}.second"]`,
				),
			);
			expect(run(alpha, fixture.home, "env.sh").exitCode).toBe(0);

			const cleaned = run(
				alpha,
				fixture.home,
				"cleanup.sh",
				[],
				toolingEnvironment(fixture, tooling, caddyEnvironment(caddy)),
			);
			expect(cleaned.exitCode).toBe(0);
			expect(await Bun.file(sentinel).exists()).toBe(true);
			expect(await Bun.file(`${sentinel}.second`).exists()).toBe(true);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);

	test("no runtime script hardcodes a volume prefix or the persistence path", async () => {
		const configuration = await Bun.file(
			resolve(ROOT, ".devcontainer/devcontainer.json"),
		).text();
		const prefixes = [
			...configuration.matchAll(
				/source=([A-Za-z0-9][A-Za-z0-9_.-]*)-\$\{devcontainerId\}/g,
			),
		].flatMap((match) => (match[1] ? [match[1]] : []));
		expect(prefixes.length).toBeGreaterThan(0);
		const parameters = Bun.TOML.parse(
			await Bun.file(resolve(ROOT, "template-parameters.toml")).text(),
		) as { paths: { mutable_persistence: string } };
		const persistence = parameters.paths.mutable_persistence;

		for (const name of RUNTIME_FILES) {
			if (!name.endsWith(".sh")) continue;
			const source = await Bun.file(
				resolve(ROOT, "scripts/worktree", name),
			).text();
			for (const prefix of prefixes) {
				expect(`${name}:${source.includes(prefix)}`).toBe(`${name}:false`);
			}
			// The generated persistence root reaches scripts through the contract and
			// the generated environment, never as a literal.
			expect(`${name}:${source.includes(persistence)}`).toBe(`${name}:false`);
		}
	});
});

// The doctor's published inventory, in emission order. The doctor prints this
// same list from --list-checks, so a check that is added, removed, or reordered
// has to be reflected here on purpose rather than by accident.
const DOCTOR_CHECK_INVENTORY = [
	"host.context",
	"host.command.git",
	"host.command.engine",
	"host.command.cli",
	"host.command.python3",
	"host.command.curl",
	"host.engine-daemon",
] as const;

interface DoctorCheck {
	id: string;
	status: string;
	summary: string;
	detail: string;
	remediation: string;
}

interface DoctorReport {
	schemaVersion: number;
	workspace: {
		id: string;
		family: string;
		offset: string;
		repoRoot: string;
	};
	checks: DoctorCheck[];
	summary: { pass: number; warn: number; fail: number; skip: number };
	exitCode: number;
}

function doctorReport(result: RunResult): DoctorReport {
	return JSON.parse(result.stdout) as DoctorReport;
}

function doctorCheck(report: DoctorReport, id: string): DoctorCheck {
	const found = report.checks.find((check) => check.id === id);
	if (!found) throw new Error(`The doctor emitted no ${id} check`);
	return found;
}

// A PATH holding nothing but the named utilities. Removing a host tool is the
// only honest way to exercise the doctor's degradation paths, and stubbing the
// tools it does find keeps the result the same on a laptop with Docker and in
// CI without it.
const TOOL_STUB = `#!/usr/bin/env bash
exit 0
`;

const NARROW_UTILITIES = [
	"bash",
	"cat",
	"dirname",
	"grep",
	"head",
	"sed",
	"tr",
	"env",
	"uname",
] as const;

async function narrowTooling(
	fixture: Harness,
	name: string,
	stubbed: string[],
): Promise<string> {
	const bin = resolve(fixture.root, `narrow-${name}`);
	await mkdir(bin, { recursive: true });
	for (const utility of NARROW_UTILITIES) {
		const source = Bun.which(utility);
		if (!source) continue;
		await symlink(source, resolve(bin, utility));
	}
	for (const tool of stubbed) {
		const path = resolve(bin, tool);
		await Bun.write(path, TOOL_STUB);
		await chmod(path, 0o755);
	}
	return bin;
}

async function treeListing(root: string): Promise<string[]> {
	return (await readdir(root, { recursive: true })).sort();
}

describe("worktree doctor", () => {
	test("rejects invalid arguments before running a single check", async () => {
		const fixture = await harness();
		try {
			for (const args of [
				["--timeout", "0"],
				["--timeout"],
				["--timeout=31"],
				["--timeout", "abc"],
				["--bogus"],
			]) {
				const refused = run(fixture.main, fixture.home, "doctor.sh", args);
				expect(`${args.join(" ")}:${refused.exitCode}`).toBe(
					`${args.join(" ")}:2`,
				);
				expect(refused.stdout).toBe("");
			}
			const bounded = run(fixture.main, fixture.home, "doctor.sh", [
				"--timeout",
				"0",
			]);
			expect(bounded.stderr).toContain("timeout must be between 1 and 30");
			const unknown = run(fixture.main, fixture.home, "doctor.sh", ["--bogus"]);
			expect(unknown.stderr).toContain(
				"Usage: bash scripts/worktree/doctor.sh",
			);
			const help = run(fixture.main, fixture.home, "doctor.sh", ["--help"]);
			expect(help.exitCode).toBe(0);
			expect(help.stderr).toContain("host-only and read-only");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);

	test("lists its check inventory without probing or writing", async () => {
		const fixture = await harness();
		try {
			const before = await treeListing(fixture.main);
			const listed = run(fixture.main, fixture.home, "doctor.sh", [
				"--list-checks",
			]);
			expect(listed.exitCode).toBe(0);
			expect(listed.stderr).toBe("");
			expect(listed.stdout.trim().split("\n")).toEqual([
				...DOCTOR_CHECK_INVENTORY,
			]);
			expect(await treeListing(fixture.main)).toEqual(before);
			// Listing is not diagnosing: no probe ran, so no state was consulted and
			// the generated environment was never created.
			expect(
				await Bun.file(
					resolve(fixture.main, ".dev/state/worktree.env"),
				).exists(),
			).toBe(false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);

	test("emits one stable JSON document whose checks follow the inventory", async () => {
		const fixture = await harness();
		try {
			const bin = await narrowTooling(fixture, "healthy", [
				"git",
				"docker",
				"devcontainer",
				"python3",
				"curl",
			]);
			const result = run(fixture.main, fixture.home, "doctor.sh", ["--json"], {
				PATH: bin,
			});
			const report = doctorReport(result);
			const contract = Bun.TOML.parse(
				await Bun.file(resolve(ROOT, "scripts/worktree/contract.toml")).text(),
			) as Record<string, unknown>;

			expect(report.schemaVersion).toBe(
				Number(contract["doctor_schema_version"]),
			);
			expect(report.checks.map((check) => check.id)).toEqual([
				...DOCTOR_CHECK_INVENTORY,
			]);
			for (const check of report.checks) {
				expect(Object.keys(check).sort()).toEqual([
					"detail",
					"id",
					"remediation",
					"status",
					"summary",
				]);
				expect(["PASS", "WARN", "FAIL", "SKIP"]).toContain(check.status);
			}
			expect(report.summary.pass).toBe(DOCTOR_CHECK_INVENTORY.length);
			expect(report.exitCode).toBe(result.exitCode);
			expect(result.exitCode).toBe(0);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);

	test("refuses to diagnose a host from inside the container", async () => {
		const fixture = await harness();
		try {
			const json = run(fixture.main, fixture.home, "doctor.sh", ["--json"], {
				DEVCONTAINER: "true",
			});
			const report = doctorReport(json);
			expect(json.exitCode).toBe(1);
			expect(
				report.checks.map((check) => ({ id: check.id, status: check.status })),
			).toEqual([{ id: "host.context", status: "FAIL" }]);
			expect(report.exitCode).toBe(1);

			const human = run(fixture.main, fixture.home, "doctor.sh", [], {
				DEVCONTAINER: "true",
			});
			expect(human.exitCode).toBe(1);
			expect(human.stdout).toContain("[FAIL] host.context");
			expect(human.stdout).toContain("Summary: 0 pass, 0 warn, 1 fail, 0 skip");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);

	test("strict mode changes the exit code and nothing else", async () => {
		const fixture = await harness();
		try {
			// curl bounds the optional route probes only, so its absence is a warning
			// rather than a failure — the exact shape --strict exists to promote.
			const bin = await narrowTooling(fixture, "nocurl", [
				"git",
				"docker",
				"devcontainer",
				"python3",
			]);
			const normal = run(fixture.main, fixture.home, "doctor.sh", ["--json"], {
				PATH: bin,
			});
			const strict = run(
				fixture.main,
				fixture.home,
				"doctor.sh",
				["--json", "--strict"],
				{ PATH: bin },
			);
			const normalReport = doctorReport(normal);
			const strictReport = doctorReport(strict);

			expect(doctorCheck(normalReport, "host.command.curl").status).toBe(
				"WARN",
			);
			expect(normal.exitCode).toBe(0);
			expect(strict.exitCode).toBe(1);
			expect(strictReport.checks).toEqual(normalReport.checks);
			expect(strictReport.summary).toEqual(normalReport.summary);
			expect(normalReport.exitCode).toBe(0);
			expect(strictReport.exitCode).toBe(1);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("worktree runtime selftest", () => {
	test("runs the hermetic worktree selftest", () => {
		const result = Bun.spawnSync(["bash", "scripts/worktree/selftest.sh"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Worktree selftest: passed");
		// The selftest is hermetic by contract: it must leave no generated state in
		// the checkout it was run from.
		expect(result.stdout.toString()).toContain(
			"the host fingerprint equals the image-owned authority",
		);
	}, 180_000);

	test("rejects unsupported arguments at every entry point", async () => {
		const fixture = await harness();
		try {
			for (const script of [
				"env.sh",
				"ensure.sh",
				"exec.sh",
				"manifest.sh",
				"services.sh",
				"up.sh",
				"down.sh",
				"cleanup.sh",
				"selftest.sh",
				"doctor.sh",
			]) {
				const refused = run(fixture.main, fixture.home, script, [
					"--known-bad",
				]);
				expect(`${script}:${refused.exitCode}`).toBe(`${script}:2`);
				expect(refused.stderr).toContain(
					`Usage: bash scripts/worktree/${script}`,
				);
				expect(refused.stdout).toBe("");
			}
			// A missing subcommand is the same answer, not a default action.
			for (const script of ["manifest.sh", "services.sh"]) {
				const bare = run(fixture.main, fixture.home, script);
				expect(`${script}:${bare.exitCode}`).toBe(`${script}:2`);
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	}, 120_000);
});

const CONTRACT_FILES = [
	"package.json",
	"template-parameters.toml",
	"template-parameters.schema.json",
	"AGENTS.md",
	".devcontainer/devcontainer.json",
	".devcontainer/devcontainer-fingerprint.sh",
	".codex/cloud/contract.toml",
	".github/workflows/ci.yml",
	"scripts/sync-devcontainer.sh",
	"scripts/template/worktree-contract.ts",
	"scripts/template/validate-worktree.ts",
	"scripts/worktree/contract.toml",
	"scripts/worktree/lib.sh",
	"scripts/worktree/lock.sh",
	"scripts/worktree/env.sh",
	"scripts/worktree/ensure.sh",
	"scripts/worktree/exec.sh",
	"scripts/worktree/manifest.sh",
	"scripts/worktree/services.sh",
	"scripts/worktree/up.sh",
	"scripts/worktree/down.sh",
	"scripts/worktree/cleanup.sh",
	"scripts/worktree/selftest.sh",
	"scripts/worktree/doctor.sh",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	".husky/commit-msg",
	".husky/pre-commit",
	".devcontainer/on-create.sh",
	"init-host.sh",
	"README.md",
	"README.template.md",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(
		resolve(tmpdir(), "devenv-worktree-contract-"),
	);
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
		// The guard asserts the executable bit Git records for every runtime
		// script, so the fixture reproduces it rather than inheriting whatever the
		// copy landed with.
		if (path.startsWith("scripts/worktree/") && path.endsWith(".sh"))
			await chmod(destination, 0o755);
	}
	// The legacy-launcher scan reads tracked files through Git, so the fixture has
	// to be a repository or the scan abstains and the mutations below prove
	// nothing. Staging is enough: `git grep` reads the working tree.
	const environment = {
		PATH: process.env["PATH"] ?? "",
		HOME: temporary,
	};
	for (const args of [
		["init", "-q", "-b", "main"],
		["add", "-A"],
	]) {
		const result = Bun.spawnSync(["git", "-C", temporary, ...args], {
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error(`git ${args.join(" ")} failed in the contract fixture`);
	}
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
	if (path.endsWith(".sh")) await chmod(target, 0o755);
	expect(await validateWorktreeContract(root)).toContain(expected);
	await Bun.write(target, original);
	if (path.endsWith(".sh")) await chmod(target, 0o755);
	expect(await validateWorktreeContract(root)).toEqual([]);
}

describe("worktree runtime contract guard", () => {
	test("passes the source tree and rejects known-bad runtime mutations", async () => {
		expect(await validateWorktreeContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateWorktreeContract(temporary)).toEqual([]);

			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) =>
					source.replace(
						"published_container_port = 8080",
						"published_container_port = 80",
					),
				"worktree: published_container_port must be between 1024 and 65535",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) => source.replace("manifest_schema_version = 1\n", ""),
				"worktree: contract key manifest_schema_version is missing",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) => `${source}unknown_key = "x"\n`,
				"worktree: contract key unknown_key is unknown",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) =>
					source.replace(
						'local_domain_stem = "devenv"',
						'local_domain_stem = "elsewhere"',
					),
				"worktree: contract drifted from template-parameters.toml",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) =>
					source.replace(
						'direct_host = "127.0.0.1"',
						'direct_host = "0.0.0.0"',
					),
				"worktree: direct_host must be 127.0.0.1",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) =>
					source.replace(
						'friendly_domain_pattern = "{workspace}.{project}.localhost"',
						'friendly_domain_pattern = "{project}.localhost"',
					),
				"worktree: friendly_domain_pattern must contain {workspace}",
			);
			await mutate(
				temporary,
				"scripts/worktree/contract.toml",
				(source) => source.replace(', ".devcontainer"]', "]"),
				"worktree: definition fingerprint inputs drifted from the image authority",
			);

			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace(
						"127.0.0.1:${localEnv:DEVENV_PUBLISHED_HOST_PORT}:8080",
						"127.0.0.1:9999:8080",
					),
				"worktree: devcontainer.json must publish 8080 on 127.0.0.1",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace('"remoteUser": "vscode"', '"remoteUser": "node"'),
				"worktree: development_user must equal devcontainer.json remoteUser",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace(
						'"DEVCONTAINER_WORKTREE_ENV_FILE": "/workspace/.dev/state/worktree.container.env"',
						'"DEVCONTAINER_WORKTREE_ENV_FILE": "/workspace/other.env"',
					),
				"worktree: devcontainer.json must point DEVCONTAINER_WORKTREE_ENV_FILE at /workspace/.dev/state/worktree.container.env",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) => source.replace('"prepare-container-env"', '"prepare-env"'),
				"worktree: devcontainer.json must keep the prepare-container-env initializeCommand",
			);

			// Host orchestration moved above the in-container test would try to start
			// a container from inside one, forever.
			await mutate(
				temporary,
				"scripts/worktree/exec.sh",
				(source) =>
					source.replace(
						'\nif [ "${DEVCONTAINER:-}" = "true" ]; then',
						'\nexec "$CONTAINER_ENGINE" exec "$container_id" "$@"\nif [ "${DEVCONTAINER:-}" = "true" ]; then',
					),
				"worktree: bridge must dispatch cloud and container paths before host orchestration",
			);
			await mutate(
				temporary,
				"scripts/worktree/ensure.sh",
				(source) =>
					source.replace(
						'\t\t--filter "label=${CONFIG_FILE_LABEL}=${CONFIG_PATH}" 2>/dev/null |',
						"\t\t2>/dev/null |",
					),
				"worktree: ensure must own containers by checkout and config path",
			);
			await mutate(
				temporary,
				"scripts/worktree/cleanup.sh",
				(source) =>
					source.replace(
						"\tremove_scoped_volumes\n",
						"\tdocker volume prune -f\n\tremove_scoped_volumes\n",
					),
				"worktree: scripts/worktree/cleanup.sh must not run an unscoped prune",
			);
			await mutate(
				temporary,
				"scripts/worktree/env.sh",
				(source) =>
					source.replace(
						'\tif in_container; then\n\t\twt_die "port allocation is a host-side operation; the container reads the generated environment instead"\n\tfi\n',
						"",
					),
				"worktree: allocation must refuse to write the registry inside a container",
			);
			await mutate(
				temporary,
				"scripts/worktree/up.sh",
				(source) =>
					source.replace(
						"report_routes() {\n",
						'report_routes() {\n\tlocal persistence=".dev/persistence"\n',
					),
				"worktree: scripts/worktree/up.sh bypasses the generated persistence root",
			);
			await mutate(
				temporary,
				"scripts/sync-devcontainer.sh",
				(source) => source.replace(/^.*scripts\/worktree\/\*\).*\n/m, ""),
				"worktree: template ownership must cover the runtime",
			);
			await mutate(
				temporary,
				"scripts/worktree/lib.sh",
				(source) => `${source}fi\n`,
				"worktree: scripts/worktree/lib.sh has a bash syntax error",
			);

			// The entrypoint cutover. A hook that reaches project tooling directly
			// runs it against whatever the host happens to have installed.
			await mutate(
				temporary,
				".husky/commit-msg",
				(source) =>
					source.replace(
						'bash scripts/worktree/exec.sh --require-ready bunx commitlint --edit "$1"',
						'bunx commitlint --edit "$1"',
					),
				"worktree: git hooks must run project tooling through the bridge",
			);
			// A hook that may start a container turns every commit into a build.
			await mutate(
				temporary,
				".husky/pre-commit",
				(source) =>
					source.replace(
						"exec.sh --require-ready bunx lint-staged",
						"exec.sh bunx lint-staged",
					),
				"worktree: git hooks must not start a container",
			);
			// Without the arm the hooks' flag falls through to the reconciling path.
			await mutate(
				temporary,
				"scripts/worktree/exec.sh",
				(source) =>
					source.replace(
						'\t\t--require-ready)\n\t\t\tREQUIRE_READY="true"\n\t\t\tshift\n\t\t\t;;\n',
						"",
					),
				"worktree: bridge must expose a ready-only mode for hooks",
			);
			await mutate(
				temporary,
				"init-host.sh",
				(source) =>
					source.replace(
						"brew install devcontainer",
						`brew install dev${"pod"}`,
					),
				"worktree: init-host.sh still installs the superseded launcher",
			);
			await mutate(
				temporary,
				"init-host.sh",
				(source) =>
					source.replace("    brew install devcontainer\n", "    true\n"),
				"worktree: onboarding must install the container CLI",
			);
			await mutate(
				temporary,
				"README.template.md",
				(source) =>
					source.replaceAll(
						"bash scripts/worktree/exec.sh",
						"bash scripts/worktree/run.sh",
					),
				"worktree: onboarding must document the bridge as the entry point",
			);
			// The non-vacuous half: a tracked file that still names the superseded
			// launcher is a fact no document can talk its way out of. This file is
			// not on the guard's allow-list, so the two mutations that need the
			// literal token assemble it instead of writing it.
			await mutate(
				temporary,
				".devcontainer/on-create.sh",
				(source) => `${source}\ndev${"pod"} up .\n`,
				"worktree: .devcontainer/on-create.sh still routes onboarding through the superseded launcher",
			);
			await mutate(
				temporary,
				"AGENTS.md",
				(source) =>
					source.replace(
						"- This runtime is the entry point, not an addition to one.",
						"- This runtime is additive during the soak.",
					),
				"worktree: agent rules must describe the cutover, not the soak",
			);

			// The executable bit is part of the contract: a runtime script Git
			// records as 0644 cannot be run by the callers that depend on it.
			const bridge = resolve(temporary, "scripts/worktree/exec.sh");
			await chmod(bridge, 0o644);
			expect(await validateWorktreeContract(temporary)).toContain(
				"worktree: scripts/worktree/exec.sh must be executable",
			);
			await chmod(bridge, 0o755);
			expect(await validateWorktreeContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 300_000);

	test("requires the cloud keys only when the cloud capability ships", async () => {
		const temporary = await contractFixture();
		try {
			// Removing the cloud contract makes the fenced keys residue rather than
			// contract, and the guard has to say so in both directions.
			await rm(resolve(temporary, ".codex/cloud/contract.toml"));
			const errors = await validateWorktreeContract(temporary);
			expect(errors).toContain(
				"worktree: contract key cloud_doctor_command is unknown",
			);
			expect(errors).toContain(
				"worktree: contract key cloud_marker_variable is unknown",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);
});
