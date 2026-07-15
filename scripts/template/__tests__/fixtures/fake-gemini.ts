#!/usr/bin/env bun
// biome-ignore-all lint/complexity/useLiteralKeys: Strict TypeScript requires indexed environment access.

const mode = process.env["FAKE_GEMINI_MODE"] ?? "args";
const args = process.argv.slice(2);

function emit(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function keepAlive(): Promise<void> {
	await new Promise<void>(() => undefined);
}

async function spawnDescendant(): Promise<number> {
	const pidFile = process.env["FAKE_GEMINI_DESCENDANT_PID_FILE"];
	if (!pidFile) throw new Error("descendant PID file is required");
	const child = Bun.spawn({
		cmd: [process.execPath, import.meta.path, "--descendant"],
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, FAKE_GEMINI_MODE: "descendant" },
	});
	child.unref();
	await Bun.write(pidFile, `${child.pid}\n`);
	return child.pid;
}

if (mode === "descendant" || args[0] === "--descendant") {
	process.on("SIGTERM", () => undefined);
	process.on("SIGINT", () => undefined);
	await keepAlive();
}

switch (mode) {
	case "args":
		process.stdout.write(`${JSON.stringify(args)}\n`);
		break;
	case "stream-args":
		emit({ type: "message", role: "assistant", content: JSON.stringify(args) });
		break;
	case "success":
		emit({ type: "init", session_id: "fake", model: "fake" });
		emit({
			type: "message",
			role: "assistant",
			content: "\u001b[31mhello\u001b[0m\u0007",
		});
		emit({
			type: "tool_use",
			tool_id: "tool-1",
			tool_name: "read_file",
			parameters: {},
		});
		emit({
			type: "tool_result",
			tool_id: "tool-1",
			status: "success",
			output: "ok",
		});
		emit({
			type: "error",
			severity: "warning",
			message: "\u001b[33mcareful\u001b[0m\u0007",
		});
		emit({ type: "message", role: "assistant", content: " world" });
		emit({ type: "result", status: "success" });
		break;
	case "activity":
		emit({ type: "init" });
		await Bun.sleep(90);
		emit({ type: "message", role: "assistant", content: "working" });
		await Bun.sleep(90);
		emit({
			type: "tool_use",
			tool_id: "tool-activity",
			tool_name: "shell",
		});
		await Bun.sleep(90);
		emit({
			type: "tool_result",
			tool_id: "tool-activity",
			status: "success",
		});
		await Bun.sleep(90);
		emit({ type: "message", role: "assistant", content: " done" });
		break;
	case "malformed-chatter":
		for (let index = 0; index < 8; index += 1) {
			process.stdout.write("{not-json}\n");
			emit({ type: "message", role: "assistant", content: 42 });
			emit({ type: "tool_use", tool_id: "", tool_name: "" });
			await Bun.sleep(40);
		}
		await Bun.sleep(60_000);
		break;
	case "malformed-then-valid":
		process.stdout.write("{not-json}\n");
		emit({ type: "message", role: "assistant", content: "valid" });
		break;
	case "oversized-partial":
		process.stdout.write("x".repeat(32 * 1024));
		await Bun.sleep(60_000);
		break;
	case "silent-resistant":
		process.on("SIGTERM", () => undefined);
		process.on("SIGINT", () => undefined);
		await spawnDescendant();
		await keepAlive();
		break;
	case "leader-exits":
		await spawnDescendant();
		process.exitCode = 23;
		break;
	case "exit-42":
		emit({ type: "message", role: "assistant", content: "failed" });
		process.exitCode = 42;
		break;
	case "signal":
		emit({ type: "message", role: "assistant", content: "signalled" });
		await Bun.sleep(20);
		process.kill(process.pid, "SIGTERM");
		await Bun.sleep(60_000);
		break;
	default:
		throw new Error(`unknown fake Gemini mode: ${mode}`);
}
