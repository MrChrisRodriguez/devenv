import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const WATCHDOG = resolve(ROOT, ".devcontainer/configs/gemini-watchdog");
const FAKE_GEMINI = resolve(import.meta.dir, "fixtures/fake-gemini.ts");

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

let temporary = "";

beforeAll(async () => {
	temporary = await mkdtemp(resolve(tmpdir(), "devenv-gemini-watchdog-"));
});

afterAll(async () => {
	await rm(temporary, { recursive: true, force: true });
});

function environment(
	mode: string,
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		...process.env,
		FAKE_GEMINI_MODE: mode,
		GEMINI_WATCHDOG_REAL_BINARY: FAKE_GEMINI,
		GEMINI_WATCHDOG_IDLE_SECONDS: "0.22",
		GEMINI_WATCHDOG_TERM_GRACE_SECONDS: "0.05",
		GEMINI_WATCHDOG_MAX_PARTIAL_BYTES: "1024",
		...overrides,
	} as Record<string, string>;
}

function spawnWatchdog(
	args: string[],
	mode: string,
	overrides: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
	return Bun.spawn({
		cmd: [process.execPath, WATCHDOG, ...args],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: environment(mode, overrides),
	});
}

async function collect(
	child: ReturnType<typeof Bun.spawn>,
	boundMs = 4_000,
): Promise<RunResult> {
	if (
		!(child.stdout instanceof ReadableStream) ||
		!(child.stderr instanceof ReadableStream)
	) {
		throw new Error("watchdog test process streams were not captured");
	}
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`watchdog test exceeded ${boundMs}ms`));
		}, boundMs);
	});
	const exitCode = await Promise.race([child.exited, timeout]).finally(() => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	});
	return { exitCode, stdout: await stdout, stderr: await stderr };
}

async function run(
	args: string[],
	mode: string,
	overrides: Record<string, string> = {},
): Promise<RunResult> {
	return collect(spawnWatchdog(args, mode, overrides));
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await Bun.file(path).exists()) {
			const pid = Number((await Bun.file(path).text()).trim());
			if (Number.isSafeInteger(pid) && pid > 1) return pid;
		}
		await Bun.sleep(10);
	}
	throw new Error(`fake Gemini did not publish descendant PID at ${path}`);
}

function processIsLive(pid: number): boolean {
	const result = Bun.spawnSync({
		cmd: ["ps", "-o", "stat=", "-p", String(pid)],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return false;
	const state = result.stdout.toString().trim();
	return state.length > 0 && !/^[ZX]/.test(state);
}

async function expectProcessGone(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (!processIsLive(pid)) return;
		await Bun.sleep(10);
	}
	expect(processIsLive(pid)).toBe(false);
}

describe("Gemini headless watchdog", () => {
	test("passes interactive, version, interactive-prompt, explicit-format, and bypass calls through unchanged", async () => {
		for (const [args, overrides] of [
			[[], {}],
			[["--version"], {}],
			[["--prompt-interactive", "hello"], {}],
			[["-p", "hello", "--output-format", "json"], {}],
			[["-p", "hello"], { GEMINI_WATCHDOG_BYPASS: "1" }],
		] as Array<[string[], Record<string, string>]>) {
			const result = await run(args, "args", overrides);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(args);
			expect(result.stderr).toBe("");
		}
	});

	test("adds stream-json only for a headless prompt", async () => {
		const args = ["-p", "describe the tree", "--model", "fake"];
		const result = await run(args, "stream-args");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([
			...args,
			"--output-format",
			"stream-json",
		]);
	});

	test("re-emits only sanitized assistant text", async () => {
		const result = await run(["--prompt", "hello"], "success");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world\n");
		expect(result.stdout).not.toContain("tool_use");
		expect(result.stdout).not.toContain("\u001B");
		expect(result.stderr).toBe("[WARNING] careful\n");
	});

	test("valid assistant and tool activity reset the idle bound", async () => {
		const result = await run(["-p", "work"], "activity");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("working done\n");
		expect(result.stderr).not.toContain("terminating process group");
	});

	test("malformed events do not reset the idle bound or leak to stdout", async () => {
		const result = await run(["-p", "work"], "malformed-chatter");
		expect(result.exitCode).toBe(124);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ignored malformed JSON stream event");
		expect(result.stderr).toContain("terminating process group");
		expect(
			result.stderr.split("further stream diagnostics suppressed"),
		).toHaveLength(2);
	});

	test("continues safely after a malformed event when valid text follows", async () => {
		const result = await run(["-p", "work"], "malformed-then-valid");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("valid\n");
		expect(result.stderr).toContain("ignored malformed JSON stream event");
	});

	test("discards an oversized partial line within the configured bound", async () => {
		const result = await run(["-p", "work"], "oversized-partial", {
			GEMINI_WATCHDOG_MAX_PARTIAL_BYTES: "128",
		});
		expect(result.exitCode).toBe(124);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"discarded stream line larger than 128 bytes",
		);
	});

	test("idle timeout TERM/grace/KILL removes a resistant process group", async () => {
		const pidFile = resolve(
			temporary,
			`timeout-descendant-${crypto.randomUUID()}`,
		);
		const child = spawnWatchdog(["-p", "work"], "silent-resistant", {
			FAKE_GEMINI_DESCENDANT_PID_FILE: pidFile,
		});
		const descendantPid = await waitForPid(pidFile);
		const result = await collect(child);
		expect(result.exitCode).toBe(124);
		expect(result.stderr).toContain("terminating process group");
		await expectProcessGone(descendantPid);
	});

	test("a missing real binary exits 127", async () => {
		const missing = resolve(temporary, "missing-gemini");
		const result = await run(["-p", "work"], "success", {
			GEMINI_WATCHDOG_REAL_BINARY: missing,
		});
		expect(result.exitCode).toBe(127);
		expect(result.stderr).toContain("real Gemini binary is missing");
	});

	test("propagates normal and signal child exits", async () => {
		const normal = await run(["-p", "work"], "exit-42");
		expect(normal.exitCode).toBe(42);
		const signalled = await run(["-p", "work"], "signal");
		expect(signalled.exitCode).toBe(143);
	});

	test("forwarded TERM cleans the full child group and exits 143", async () => {
		const pidFile = resolve(
			temporary,
			`signal-descendant-${crypto.randomUUID()}`,
		);
		const child = spawnWatchdog(["-p", "work"], "silent-resistant", {
			FAKE_GEMINI_DESCENDANT_PID_FILE: pidFile,
			GEMINI_WATCHDOG_IDLE_SECONDS: "5",
		});
		const descendantPid = await waitForPid(pidFile);
		child.kill("SIGTERM");
		const result = await collect(child);
		expect(result.exitCode).toBe(143);
		await expectProcessGone(descendantPid);
	});

	test("normal leader exit still leaves no descendant behind", async () => {
		const pidFile = resolve(
			temporary,
			`normal-descendant-${crypto.randomUUID()}`,
		);
		const child = spawnWatchdog(["-p", "work"], "leader-exits", {
			FAKE_GEMINI_DESCENDANT_PID_FILE: pidFile,
		});
		const descendantPid = await waitForPid(pidFile);
		const result = await collect(child);
		expect(result.exitCode).toBe(23);
		await expectProcessGone(descendantPid);
	});

	test("rejects invalid watchdog bounds without starting Gemini", async () => {
		const result = await run(["-p", "work"], "success", {
			GEMINI_WATCHDOG_MAX_PARTIAL_BYTES: "0",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			"GEMINI_WATCHDOG_MAX_PARTIAL_BYTES must be greater than 0",
		);
	});
});
