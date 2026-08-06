import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { validateCloudContract } from "../cloud-contract";

const ROOT = resolve(import.meta.dir, "../../..");
const CONTRACT_FILES = [
	"package.json",
	"bun.lock",
	"template-parameters.toml",
	".prototools",
	".devcontainer/Dockerfile",
	".devcontainer/proto-checksums.txt",
	".devcontainer/install-proto.sh",
	".codex/cloud/contract.toml",
	".codex/cloud/lib.sh",
	".codex/cloud/bootstrap.sh",
	".codex/cloud/doctor.sh",
	".codex/cloud/exec.sh",
	".codex/cloud/selftest.sh",
	"scripts/template/cloud-contract.ts",
	"scripts/template/validate-cloud.ts",
	".github/workflows/ci.yml",
	".github/workflows/codex-cloud-smoke.yml",
	"AGENTS.md",
	"evidence/stage-3-runtimes.json",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-cloud-contract-"));
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
		// The guard asserts the executable bit that Git records for every cloud
		// script, so the fixture has to reproduce it rather than inherit whatever
		// mode the copy happened to land with.
		if (path.endsWith(".sh")) {
			await chmod(destination, 0o755);
			const mode = (await stat(destination)).mode & 0o777;
			expect(mode).toBe(0o755);
		}
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
	expect(await validateCloudContract(root)).toContain(expected);
	await Bun.write(target, original);
	if (path.endsWith(".sh")) await chmod(target, 0o755);
	expect(await validateCloudContract(root)).toEqual([]);
}

describe("codex cloud contract", () => {
	test("passes the source tree and rejects known-bad cloud contract mutations", async () => {
		expect(await validateCloudContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateCloudContract(temporary)).toEqual([]);

			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace('tool_bun = "1.3.13"', 'tool_bun = "latest"'),
				"cloud: tool_bun must use an exact version",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace('tool_node = "24.18.0"', 'tool_node = "24.18.1"'),
				"cloud: tool node must match .prototools (expected 24.18.0, got 24.18.1)",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						"3f13534217fcf315c0579db6e1f87edd022d850144d9f3b0957a29586de34838",
						"0".repeat(64),
					),
				"cloud: proto checksum for x86_64-unknown-linux-gnu must match .devcontainer/proto-checksums.txt",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						"85406d411687412b729ef21f58f8ac2ddafa9e51eafc8ec1b4772af1b6ab98db",
						"not-a-hash",
					),
				"cloud: proto_sha256_aarch64_linux must be a lowercase sha-256 digest",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) => source.replace('default_profile = "core"\n', ""),
				"cloud: contract key default_profile is missing",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) => `${source}unknown_key = "x"\n`,
				"cloud: contract key unknown_key is unknown",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						'browser_playwright_version = "1.59.1"',
						'browser_playwright_version = "1.59.2"',
					),
				"cloud: browser pin must equal the package catalog and Docker pins",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						'browser_reference_marker_path = "/home/vscode/.payloads/browser/.devenv-playwright-version"',
						'browser_reference_marker_path = "/home/vscode/.payloads/browser/.other"',
					),
				"cloud: Stage 3 browser handoff drifted",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						'graphify_version = "0.9.16"',
						'graphify_version = "0.9.17"',
					),
				"cloud: graphify version must match the Docker authority",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace('"package.json", "bun.lock", ', '"package.json", '),
				"cloud: fingerprint inputs drifted",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						'secret_allow_list = ["ANTHROPIC_API_KEY", ',
						'secret_allow_list = ["ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN", ',
					),
				"cloud: secret allow-list must not carry deployment credentials",
			);
			await mutate(
				temporary,
				".codex/cloud/contract.toml",
				(source) =>
					source.replace(
						'persisted_environment = "~/.config/devenv/codex-cloud.env"',
						'persisted_environment = "~/.config/other/codex-cloud.env"',
					),
				"cloud: persisted paths must be derived from one project slug",
			);
			await mutate(
				temporary,
				".codex/cloud/bootstrap.sh",
				(source) =>
					source.replace('cd "$REPO_ROOT"', 'docker ps\ncd "$REPO_ROOT"'),
				"cloud: .codex/cloud/bootstrap.sh must not invoke docker in cloud",
			);
			await mutate(
				temporary,
				".codex/cloud/doctor.sh",
				(source) =>
					source.replace(
						"quiet=false\n",
						"quiet=false\nproto install --yes jq\n",
					),
				"cloud: doctor must be read-only",
			);
			await mutate(
				temporary,
				".codex/cloud/exec.sh",
				(source) =>
					source.replace(
						'\tbash "$CLOUD_DIR/doctor.sh" --quiet\n\texec "$@"\n',
						'\texec "$@"\n\tbash "$CLOUD_DIR/doctor.sh" --quiet\n',
					),
				"cloud: exec must verify cloud before executing",
			);
			await mutate(
				temporary,
				".codex/cloud/bootstrap.sh",
				(source) => `${source}fi\n`,
				"cloud: .codex/cloud/bootstrap.sh has a bash syntax error",
			);
			await mutate(
				temporary,
				".github/workflows/codex-cloud-smoke.yml",
				(source) =>
					source.replace(
						"  pull_request:\n    paths:",
						"  pull_request:\n    branches: [main]\n    paths:",
					),
				"cloud: smoke pull_request must not filter base branches",
			);
			await mutate(
				temporary,
				".github/workflows/codex-cloud-smoke.yml",
				(source) =>
					source.replace('BUN_VERSION: "1.3.13"', 'BUN_VERSION: "1.3.14"'),
				"cloud: workflow Bun pin must equal the cloud contract",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}, 180_000);

	test("runs the hermetic cloud bootstrap selftest", () => {
		const result = Bun.spawnSync(["bash", ".codex/cloud/selftest.sh"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Codex cloud selftest: passed");
	}, 120_000);

	test("rejects unsupported doctor and exec arguments", () => {
		const doctor = Bun.spawnSync(
			["bash", ".codex/cloud/doctor.sh", "--known-bad"],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(doctor.exitCode).toBe(2);
		expect(doctor.stderr.toString()).toContain(
			"Usage: bash .codex/cloud/doctor.sh [--quiet]",
		);
		const exec = Bun.spawnSync(["bash", ".codex/cloud/exec.sh"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(exec.exitCode).toBe(2);
		expect(exec.stderr.toString()).toContain(
			"Usage: bash .codex/cloud/exec.sh <command> [arguments...]",
		);
	});

	test("rejects an unsupported bootstrap profile", () => {
		const result = Bun.spawnSync(
			["bash", ".codex/cloud/bootstrap.sh", "known-bad"],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain(
			"Codex cloud bootstrap: unsupported profile 'known-bad'",
		);
	});
});
