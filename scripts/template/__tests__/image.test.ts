// biome-ignore-all lint/complexity/useLiteralKeys: Mutation fixtures use dynamic keys.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	selectArchitectureChecksums,
	validateImageContract,
} from "../image-contract";
import { loadTemplateParameters } from "../parameters";
import {
	filterCapabilityBlocks,
	loadTemplateOwnership,
	renderFixture,
} from "../render-fixture";

const ROOT = resolve(import.meta.dir, "../../..");

const CONTRACT_FILES = [
	".dockerignore",
	".prototools",
	"package.json",
	"renovate.json",
	"template-parameters.toml",
	"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	".claude/settings.json",
	".cursor/mcp.json",
	".claude/skills/graphify/SKILL.md",
	".codex/skills/graphify/SKILL.md",
	".gemini/skills/graphify/SKILL.md",
	".devcontainer/Dockerfile",
	".devcontainer/configs/.shell_common",
	".devcontainer/configs/gemini-watchdog",
	".devcontainer/devcontainer-fingerprint.sh",
	".devcontainer/devcontainer-lock.json",
	".devcontainer/devcontainer.json",
	".devcontainer/prototools.auxiliary",
	".devcontainer/prototools.foundation",
	".devcontainer/on-create.sh",
	".devcontainer/on-create/setup-ccstatusline.sh",
	".devcontainer/on-create/setup-claude-octopus.sh",
	".devcontainer/on-create/setup-claude-warp.sh",
	".devcontainer/on-create/setup-claude.sh",
	".devcontainer/on-create/setup-common.sh",
	".devcontainer/on-create/setup-context7.sh",
	".devcontainer/on-create/setup-codex.sh",
	".devcontainer/on-create/setup-gemini.sh",
	".devcontainer/on-create/setup-graphify.sh",
	".devcontainer/on-create/setup-proto.sh",
] as const;

async function contractFixture(): Promise<string> {
	const temporary = await mkdtemp(resolve(tmpdir(), "devenv-image-contract-"));
	for (const path of CONTRACT_FILES) {
		const destination = resolve(temporary, path);
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(resolve(ROOT, path), destination);
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
	const errors = await validateImageContract(root);
	expect(errors).toContain(expected);
	console.log(`[stage2-observed] ${expected}`);
	await Bun.write(target, original);
	expect(await validateImageContract(root)).toEqual([]);
}

describe("devcontainer image contract", () => {
	test("passes the real tree and rejects known-bad image mutations", async () => {
		expect(await validateImageContract(ROOT)).toEqual([]);
		const temporary = await contractFixture();
		try {
			expect(await validateImageContract(temporary)).toEqual([]);
			await mutate(
				temporary,
				".devcontainer/prototools.auxiliary",
				(source) => `bun = "1.3.13"\n${source}`,
				"image: Proto partition duplicates tools.bun",
			);
			await mutate(
				temporary,
				".devcontainer/prototools.foundation",
				(source) => source.replace('python = "3.14.2"\n', ""),
				"image: Proto partition tool union differs from .prototools",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replaceAll(
						"DELTA_SHA256_ARM64=937781aa",
						"DELTA_SHA256_ARM64=invalid_",
					),
				"image: delta arm64 checksum is missing or malformed",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace(
						`releases/download/v\${RTK_VERSION}`,
						"releases/latest/download",
					),
				"image: Dockerfile contains a mutable download source",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replaceAll(
						"/etc/profile.d/devenv-path.sh",
						"/tmp/known-bad-path.sh",
					),
				"image: login shells omit the image-owned tool PATH",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) => `${source}\nproto use\n`,
				"image: setup-proto mutates the image-owned toolchain",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) => source.replace("DEVCONTAINER_FINGERPRINT_BUN=", ""),
				"image: setup-proto omits DEVCONTAINER_FINGERPRINT_BUN",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) =>
					source.replace(
						'image_bun="$image_proto_home/tools/bun/$bun_version/bun"',
						'image_bun="$image_proto_home/shims/bun"',
					),
				"image: setup-proto must not fingerprint through a Proto shim",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) =>
					source.replace(
						'/usr/bin/env -i DEVCONTAINER_FINGERPRINT_BUN="$image_bun"',
						'DEVCONTAINER_FINGERPRINT_BUN="$image_bun"',
					),
				"image: setup-proto must isolate the fingerprint environment",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) =>
					source.replace(
						'repo_root="/workspace"',
						'source /workspace/.devcontainer/on-create/setup-common.sh\nrepo_root="/workspace"',
					),
				"image: image verifier must not source checkout helpers",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) =>
					source.replace(
						'repo_root="/workspace"',
						String.raw`repo_root="\${DEVCONTAINER_REPO_ROOT:-/workspace}"`,
					),
				"image: setup-proto trusts forbidden DEVCONTAINER_REPO_ROOT override",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-proto.sh",
				(source) =>
					source.replace(
						'image_contract_dir="/usr/local/share/devenv-image"',
						String.raw`image_contract_dir="\${DEVCONTAINER_IMAGE_CONTRACT_DIR:-/usr/local/share/devenv-image}"`,
					),
				"image: setup-proto trusts forbidden DEVCONTAINER_IMAGE_CONTRACT_DIR override",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace('"-u",\n\t\t"BASH_ENV",', '"BASH_ENV_NOT_SCRUBBED",'),
				"image: onCreateCommand must scrub shell startup code before privileged Bash",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace('"BUN_OPTIONS"', '"BUN_OPTIONS_NOT_SCRUBBED"'),
				"image: onCreateCommand must scrub shell startup code before privileged Bash",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace(
						'"mounts": [',
						`"mounts": [\n\t\t"source=proto-home-\${devcontainerId},target=/home/vscode/.proto,type=volume",`,
					),
				"image: active devcontainer must not mount Proto storage",
			);
			await mutate(
				temporary,
				".devcontainer/devcontainer.json",
				(source) =>
					source.replace(
						"/usr/local/share/devenv-image/setup-proto.sh",
						"/workspace/.devcontainer/on-create/setup-proto.sh",
					),
				"image: onCreateCommand must run the image-owned verifier before checkout code",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace("CONTEXT7_VERSION=3.2.3", "CONTEXT7_VERSION=latest"),
				"agents: CONTEXT7_VERSION must have one immutable Docker authority",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace("OCTOPUS_COMMIT=f42f34a8", "OCTOPUS_COMMIT=mutable__"),
				"agents: OCTOPUS_COMMIT must have one immutable Docker authority",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace("WARP_SHA256=054607a8", "WARP_SHA256=invalid_"),
				"agents: WARP_SHA256 must have one immutable Docker authority",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-claude-octopus.sh",
				(source) => `${source}\ngit clone https://example.invalid/octopus\n`,
				"agents: setup-claude-octopus.sh contains a floating runtime fetch",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-claude-octopus.sh",
				(source) =>
					source.replace(
						"/workspace/.codex/skills",
						"/workspace/.missing-codex-skills",
					),
				"agents: setup-claude-octopus.sh must reject project/shared skill collisions",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-claude-warp.sh",
				(source) => source.replace("cmp -s", "test -r"),
				"agents: setup-claude-warp.sh must verify local marketplace and installed source authorities",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-claude-warp.sh",
				(source) => `${source}\ntimeout 30s claude plugin list --json\n`,
				"agents: setup-claude-warp.sh must fail closed on registration errors",
			);
			await mutate(
				temporary,
				".claude/settings.json",
				(source) =>
					source.replace('"command": "context7-mcp"', '"command": "bunx"'),
				"agents: .claude/settings.json must invoke the image-owned Context7 launcher",
			);
			await mutate(
				temporary,
				".devcontainer/configs/.shell_common",
				(source) =>
					source.replace(
						"$HOME/.proto/shims:$HOME/.proto/bin:$HOME/.local/bin",
						"$HOME/.local/bin:$HOME/.proto/shims:$HOME/.proto/bin",
					),
				"agents: bash non-login PATH must prefer workspace and Proto before image launchers",
			);
			await mutate(
				temporary,
				".devcontainer/configs/gemini-watchdog",
				(source) =>
					source.replace(
						"/home/vscode/.payloads/gemini/bin/gemini",
						"/home/vscode/.local/bin/gemini-real",
					),
				"agents: Gemini watchdog omits absolute real payload",
			);
			await mutate(
				temporary,
				".devcontainer/configs/gemini-watchdog",
				(source) => source.replace("detached: true", "detached: false"),
				"agents: Gemini watchdog omits dedicated child process group",
			);
			await mutate(
				temporary,
				".devcontainer/Dockerfile",
				(source) =>
					source.replace(
						"/home/vscode/.local/bin/gemini",
						"/home/vscode/.local/bin/gemini-watchdog",
					),
				"agents: Dockerfile must install the Gemini watchdog at /home/vscode/.local/bin/gemini",
			);
			await mutate(
				temporary,
				".devcontainer/on-create/setup-gemini.sh",
				(source) =>
					source.replace(
						'cmp -s "$gemini_wrapper_source" "$gemini_wrapper"',
						'test -x "$gemini_wrapper"',
					),
				"agents: setup-gemini must verify watchdog and real payload",
			);
			await mutate(
				temporary,
				"docs/devcontainer-upgrade/stage-0/template-ownership.json",
				(source) =>
					source.replace(
						'"pattern": ".devcontainer/configs/gemini-watchdog",\n\t\t\t"requiresAll": ["gemini"]',
						'"pattern": ".devcontainer/configs/gemini-watchdog",\n\t\t\t"requiresAll": []',
					),
				"agents: Gemini watchdog ownership must require Gemini",
			);

			const sharedGraphify = resolve(
				temporary,
				".agents/skills/graphify/SKILL.md",
			);
			await mkdir(dirname(sharedGraphify), { recursive: true });
			await copyFile(
				resolve(ROOT, ".codex/skills/graphify/SKILL.md"),
				sharedGraphify,
			);
			const duplicateSkills = await validateImageContract(temporary);
			expect(duplicateSkills).toContain(
				"agents: codex discovers duplicate skill graphify: .agents/skills/graphify/SKILL.md, .codex/skills/graphify/SKILL.md",
			);
			expect(duplicateSkills).toContain(
				"agents: shared .agents/skills/graphify duplicates agent-specific discovery",
			);
			await rm(resolve(temporary, ".agents"), {
				recursive: true,
				force: true,
			});
			expect(await validateImageContract(temporary)).toEqual([]);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("selects independently pinned checksum branches", async () => {
		const source = await Bun.file(
			resolve(ROOT, ".devcontainer/Dockerfile"),
		).text();
		const amd64 = selectArchitectureChecksums(source, "amd64");
		const arm64 = selectArchitectureChecksums(source, "arm64");
		for (const owner of ["delta", "rtk", "claude"]) {
			expect(amd64[owner]).toMatch(/^[0-9a-f]{64}$/);
			expect(arm64[owner]).toMatch(/^[0-9a-f]{64}$/);
			expect(amd64[owner]).not.toBe(arm64[owner]);
		}
		console.log(
			"[stage2-observed] amd64 and arm64 checksum branches are complete and independently selected",
		);
	});

	test("fingerprint is deterministic and changes with a definition input", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-fingerprint-"));
		try {
			for (const path of [
				".dockerignore",
				".prototools",
				".devcontainer/devcontainer-fingerprint.sh",
				".devcontainer/devcontainer.json",
			]) {
				const destination = resolve(temporary, path);
				await mkdir(dirname(destination), { recursive: true });
				await copyFile(resolve(ROOT, path), destination);
			}
			const script = resolve(
				temporary,
				".devcontainer/devcontainer-fingerprint.sh",
			);
			const fingerprint = (): string => {
				const result = Bun.spawnSync(["bash", script, temporary]);
				expect(result.exitCode).toBe(0);
				return result.stdout.toString().trim();
			};
			const first = fingerprint();
			expect(first).toMatch(/^[0-9a-f]{64}$/);
			expect(fingerprint()).toBe(first);
			await Bun.write(
				resolve(temporary, ".devcontainer/devcontainer.json"),
				'{"knownBad":true}\n',
			);
			expect(fingerprint()).not.toBe(first);
			console.log(
				"[stage2-observed] complete definition fingerprint is deterministic and detects mutation",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	test("Gemini capability owns and renders the watchdog atomically", async () => {
		const parameters = await loadTemplateParameters(ROOT);
		const capabilities = structuredClone(parameters.capabilities.defaults);
		capabilities["gemini"] = false;
		const dockerfile = await Bun.file(
			resolve(ROOT, ".devcontainer/Dockerfile"),
		).text();
		const disabled = filterCapabilityBlocks(dockerfile, capabilities);
		expect(disabled).not.toContain("gemini_payload");
		expect(disabled).not.toContain("gemini-watchdog");

		const ownership = await loadTemplateOwnership(ROOT);
		expect(ownership.artifactRules).toContainEqual({
			pattern: ".devcontainer/configs/gemini-watchdog",
			requiresAll: ["gemini"],
		});
	});

	test("rendered minimal and full images match capability selection", async () => {
		const temporary = await mkdtemp(resolve(tmpdir(), "devenv-image-render-"));
		try {
			const minimal = resolve(temporary, "minimal");
			const full = resolve(temporary, "full");
			await renderFixture({
				root: ROOT,
				fixtureName: "minimal",
				output: minimal,
			});
			await renderFixture({ root: ROOT, fixtureName: "full", output: full });
			expect(await validateImageContract(minimal)).toEqual([]);
			expect(await validateImageContract(full)).toEqual([]);
			const minimalDockerfile = await Bun.file(
				resolve(minimal, ".devcontainer/Dockerfile"),
			).text();
			expect(minimalDockerfile).not.toContain("playwright_browser");
			expect(minimalDockerfile).not.toContain("context7_payload");
			expect(minimalDockerfile).not.toContain("octopus_payload");
			expect(minimalDockerfile).not.toContain("warp_payload");
			expect(minimalDockerfile).toContain(
				".devcontainer/configs/gemini-watchdog /home/vscode/.local/bin/gemini",
			);
			expect(
				await Bun.file(
					resolve(minimal, ".devcontainer/configs/gemini-watchdog"),
				).exists(),
			).toBe(true);
			expect(
				await Bun.file(
					resolve(minimal, ".devcontainer/on-create/setup-context7.sh"),
				).exists(),
			).toBe(false);
			expect(
				await Bun.file(
					resolve(minimal, ".devcontainer/on-create/setup-claude-octopus.sh"),
				).exists(),
			).toBe(false);
			expect(
				await Bun.file(
					resolve(minimal, ".devcontainer/on-create/setup-claude-warp.sh"),
				).exists(),
			).toBe(false);
			const fullDockerfile = await Bun.file(
				resolve(full, ".devcontainer/Dockerfile"),
			).text();
			expect(fullDockerfile).toContain("development_browser");
			expect(fullDockerfile).toContain("context7_payload");
			expect(fullDockerfile).toContain("octopus_payload");
			expect(fullDockerfile).toContain("warp_payload");
			expect(fullDockerfile).toContain(
				".devcontainer/configs/gemini-watchdog /home/vscode/.local/bin/gemini",
			);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
