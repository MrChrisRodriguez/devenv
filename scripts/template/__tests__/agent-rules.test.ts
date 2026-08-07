import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	AGENT_SURFACES,
	CANONICAL_FILE,
	DELEGATION_SOURCE,
	generatedBlocks,
	REPLACED_ARTIFACTS,
	regenerateVendorArtifacts,
	sharedBlocks,
	VENDOR_ARTIFACTS,
	validateAgentRulesContract,
} from "../agent-rules-contract";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	resolveFixtureParameters,
} from "../parameters";
import { filterAgentRuleLines } from "../render-fixture";
import { syncAgentRules } from "../sync-agent-rules";

const ROOT = resolve(import.meta.dir, "../../..");

const COPIED = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	".claude/CLAUDE.md",
	"package.json",
	"template-parameters.toml",
];

/**
 * A copy of this repository's real rule surface, not a stand-in for it.
 *
 * Every mutation below is a mutation of the actual canonical file and the
 * actual mirrors, because the interesting failures are all about text that
 * agrees today: a synthetic fixture with two invented blocks would prove that
 * the comparison works, not that these files are wired to it.
 */
async function rulesRepository(
	options: { openspec?: boolean } = {},
): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "devenv-agent-rules-"));
	await mkdir(resolve(root, ".claude"), { recursive: true });
	await mkdir(resolve(root, "scripts/template"), { recursive: true });
	await mkdir(resolve(root, ".codex"), { recursive: true });
	for (const path of COPIED)
		await Bun.write(resolve(root, path), Bun.file(resolve(ROOT, path)));
	for (const name of [
		"agent-rules-contract.ts",
		"validate-agent-rules.ts",
		"sync-agent-rules.ts",
	])
		await Bun.write(
			resolve(root, "scripts/template", name),
			"export const placeholder = 1;\n",
		);
	await Bun.write(resolve(root, ".codex/hooks.json"), "{}\n");
	if (options.openspec) {
		await Bun.write(
			resolve(root, "openspec/config.yaml"),
			Bun.file(resolve(ROOT, "openspec/config.yaml")),
		);
		await Bun.write(
			resolve(root, DELEGATION_SOURCE),
			Bun.file(resolve(ROOT, DELEGATION_SOURCE)),
		);
		for (const path of VENDOR_ARTIFACTS)
			await Bun.write(resolve(root, path), Bun.file(resolve(ROOT, path)));
		// A shim inside the fixture's own node_modules, so the regeneration runs
		// the same pinned binary this repository does.
		await mkdir(resolve(root, "node_modules/.bin"), { recursive: true });
		const shim = resolve(root, "node_modules/.bin/openspec");
		await Bun.write(
			shim,
			`#!/usr/bin/env bash\nexec node ${resolve(ROOT, "node_modules/@fission-ai/openspec/bin/openspec.js")} "$@"\n`,
		);
		await chmod(shim, 0o755);
	}
	return root;
}

async function withRules(
	body: (root: string) => Promise<void>,
	options: { openspec?: boolean } = {},
): Promise<void> {
	const root = await rulesRepository(options);
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function text(root: string, path: string): Promise<string> {
	return Bun.file(resolve(root, path)).text();
}

describe("canonical cross-agent rules", () => {
	test("this repository's canonical file and every mirror agree", async () => {
		expect(await validateAgentRulesContract(ROOT)).toEqual([]);
	});

	test("rules:sync is a no-op on a synchronized tree", async () => {
		const result = await syncAgentRules(ROOT, { write: false });
		expect(result.changed).toEqual([]);
	});

	test("every declared surface exists and declares only known blocks", async () => {
		const canonical = sharedBlocks(await text(ROOT, CANONICAL_FILE));
		expect(canonical.errors).toEqual([]);
		expect([...canonical.blocks.keys()].sort()).toEqual([
			"graphify-rules",
			"graphify-skill",
			"openspec-lifecycle",
		]);
		for (const surface of AGENT_SURFACES) {
			expect(await Bun.file(resolve(ROOT, surface.file)).exists()).toBe(true);
			for (const id of surface.blocks)
				expect(canonical.blocks.has(id)).toBe(true);
		}
		// The negative half of the table, stated as a value rather than as a habit.
		const codex = AGENT_SURFACES.find((surface) => surface.agent === "codex");
		expect(codex?.file).toBe(CANONICAL_FILE);
		expect(codex?.blocks).toEqual([]);
		expect(codex?.openspecArtifacts).toBe(false);
	});

	test("a hand-edited mirror is named with the file and the block", async () => {
		await withRules(async (root) => {
			const path = resolve(root, "CLAUDE.md");
			await Bun.write(
				path,
				(await text(root, "CLAUDE.md")).replace(
					"- Archive dates are UTC",
					"- Archive dates are local",
				),
			);
			const errors = await validateAgentRulesContract(root);
			expect(errors).toContain(
				"agent-rules: CLAUDE.md has drifted from AGENTS.md in openspec-lifecycle; run `bun run rules:sync`",
			);
		});
	});

	test("a canonical edit fails until rules:sync propagates it", async () => {
		await withRules(async (root) => {
			await Bun.write(
				resolve(root, CANONICAL_FILE),
				(await text(root, CANONICAL_FILE)).replace(
					"- Archive dates are UTC",
					"- Archive dates are always UTC",
				),
			);
			const before = await validateAgentRulesContract(root);
			expect(
				before.some((error) =>
					error.startsWith("agent-rules: CLAUDE.md has drifted"),
				),
			).toBe(true);
			expect(
				before.some((error) =>
					error.startsWith("agent-rules: GEMINI.md has drifted"),
				),
			).toBe(true);
			const synced = await syncAgentRules(root);
			expect(synced.changed.sort()).toEqual(["CLAUDE.md", "GEMINI.md"]);
			expect(await validateAgentRulesContract(root)).toEqual([]);
			expect(await text(root, "CLAUDE.md")).toContain(
				"- Archive dates are always UTC",
			);
			// And it stays a no-op afterwards.
			expect((await syncAgentRules(root, { write: false })).changed).toEqual(
				[],
			);
		});
	});

	test("a missing mirror region names the generator rather than guessing", async () => {
		await withRules(async (root) => {
			const source = await text(root, "GEMINI.md");
			const start = source.indexOf(
				"<!-- generated:start openspec-lifecycle -->",
			);
			const end =
				source.indexOf("<!-- generated:end openspec-lifecycle -->") +
				"<!-- generated:end openspec-lifecycle -->".length;
			await Bun.write(
				resolve(root, "GEMINI.md"),
				source.slice(0, start) + source.slice(end),
			);
			expect(await validateAgentRulesContract(root)).toContain(
				"agent-rules: GEMINI.md is missing the generated region openspec-lifecycle; run `bun run rules:sync`",
			);
		});
	});

	test("a mirror region the canonical file does not declare for it is rejected", async () => {
		await withRules(async (root) => {
			await Bun.write(
				resolve(root, ".claude/CLAUDE.md"),
				`${await text(root, ".claude/CLAUDE.md")}\n<!-- generated:start openspec-lifecycle -->\nborrowed\n<!-- generated:end openspec-lifecycle -->\n`,
			);
			expect(await validateAgentRulesContract(root)).toContain(
				"agent-rules: .claude/CLAUDE.md carries the generated region openspec-lifecycle, which AGENTS.md does not declare for it",
			);
		});
	});

	test("canonical text restated outside a generated region is rejected", async () => {
		await withRules(async (root) => {
			const canonical = sharedBlocks(await text(root, CANONICAL_FILE));
			const line = (canonical.blocks.get("graphify-rules") as string)
				.split("\n")
				.find((candidate) => candidate.startsWith("- After modifying code"));
			expect(line).toBeString();
			await Bun.write(
				resolve(root, "GEMINI.md"),
				`${await text(root, "GEMINI.md")}\n## Reminders\n\n${line}\n`,
			);
			expect(await validateAgentRulesContract(root)).toContain(
				"agent-rules: GEMINI.md restates canonical text from graphify-rules outside its generated region",
			);
		});
	});

	test("an OpenSpec artifact under .codex fails, because codex receives none", async () => {
		await withRules(async (root) => {
			await mkdir(resolve(root, ".codex/skills/openspec-archive-change"), {
				recursive: true,
			});
			await Bun.write(
				resolve(root, ".codex/skills/openspec-archive-change/SKILL.md"),
				"---\nname: openspec-archive-change\n---\n",
			);
			const errors = await validateAgentRulesContract(root);
			expect(
				errors.some(
					(error) =>
						error.includes(".codex/skills/openspec-archive-change/SKILL.md") &&
						error.includes("codex receives no OpenSpec artifacts"),
				),
			).toBe(true);
		});
	});

	test("this repository's .codex names no OpenSpec artifact", async () => {
		const errors = await validateAgentRulesContract(ROOT);
		expect(errors.filter((error) => error.includes(".codex/"))).toEqual([]);
	});

	test("no canonical block depends on a line the renderer's filter drops", async () => {
		// AGENTS.md is the only rule file `filterAgentRuleLines` touches, so a
		// canonical line it removes would survive in the mirrors and the two would
		// disagree in exactly the renders that disable a capability.
		const parameters = await loadTemplateParameters(ROOT);
		const canonical = sharedBlocks(await text(ROOT, CANONICAL_FILE));
		for (const fixtureName of ["minimal", "cloud", "full"]) {
			const fixture = await loadFixtureDefinition(
				ROOT,
				fixtureName,
				parameters,
			);
			const resolved = resolveFixtureParameters(parameters, fixture);
			for (const [id, body] of canonical.blocks) {
				expect(
					`${fixtureName}:${id}:${filterAgentRuleLines(body, resolved)}`,
				).toBe(`${fixtureName}:${id}:${body}`);
			}
		}
	});

	test("every generated region in this tree is a block the canonical file owns", async () => {
		const canonical = sharedBlocks(await text(ROOT, CANONICAL_FILE));
		for (const surface of AGENT_SURFACES) {
			if (surface.file === CANONICAL_FILE) continue;
			const mirror = generatedBlocks(await text(ROOT, surface.file));
			expect(mirror.errors).toEqual([]);
			expect([...mirror.blocks.keys()]).toEqual(surface.blocks);
			for (const [id, body] of mirror.blocks)
				expect(body).toBe(canonical.blocks.get(id) as string);
		}
	});
});

describe("generated OpenSpec commands and skills", () => {
	test("all fourteen match the pinned CLI plus the declared overlay", async () => {
		const regenerated = regenerateVendorArtifacts(ROOT);
		expect(regenerated.errors).toEqual([]);
		expect([...regenerated.files.keys()].sort()).toEqual(
			[...VENDOR_ARTIFACTS].sort(),
		);
		for (const [path, content] of regenerated.files)
			expect(`${path}:${await text(ROOT, path)}`).toBe(`${path}:${content}`);
	}, 60_000);

	test("regeneration is byte-identical across two runs", async () => {
		const first = regenerateVendorArtifacts(ROOT);
		const second = regenerateVendorArtifacts(ROOT);
		expect(first.errors).toEqual([]);
		expect(second.errors).toEqual([]);
		expect([...second.files.entries()]).toEqual([...first.files.entries()]);
	}, 60_000);

	test("every artifact carries the regeneration header", async () => {
		for (const path of VENDOR_ARTIFACTS) {
			const source = await text(ROOT, path);
			expect(source).toContain(
				"<!-- Canonical rules live in AGENTS.md. Regenerate with `bun run rules:sync`; never edit by hand. -->",
			);
			// After the frontmatter, never before it: a comment above the opening
			// `---` makes the frontmatter invisible to everything that reads it.
			expect(source.startsWith("---\n")).toBe(true);
			expect(source.indexOf("<!-- Generated from")).toBeGreaterThan(
				source.indexOf("\n---\n", 4),
			);
		}
	});

	test("both archive surfaces delegate to the wrapper", async () => {
		expect(REPLACED_ARTIFACTS).toEqual([
			".claude/commands/opsx/archive.md",
			".claude/skills/openspec-archive-change/SKILL.md",
		]);
		for (const path of REPLACED_ARTIFACTS) {
			const source = await text(ROOT, path);
			expect(source).toContain("bash scripts/openspec/archive.sh --change");
			expect(source).toContain("do not call `openspec archive` yourself");
		}
	});

	test("the vendor archive procedure appears nowhere in this tree", async () => {
		// Assembled, so this assertion is not itself the thing it forbids.
		const procedure = ["mv", "openspec/changes"].join(" ");
		const result = Bun.spawnSync(
			["git", "-C", ROOT, "grep", "-lI", "-F", "-e", procedure],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(result.stdout.toString().trim()).toBe("");
		expect(result.exitCode).toBe(1);
	});

	test("a hand-edited artifact is named by the guard", async () => {
		await withRules(
			async (root) => {
				expect(await validateAgentRulesContract(root)).toEqual([]);
				await Bun.write(
					resolve(root, ".claude/commands/opsx/new.md"),
					`${await text(root, ".claude/commands/opsx/new.md")}\n\nHand written.\n`,
				);
				expect(await validateAgentRulesContract(root)).toContain(
					"agent-rules: .claude/commands/opsx/new.md does not match the pinned CLI plus this repository's declared overlay; run `bun run rules:sync`",
				);
			},
			{ openspec: true },
		);
	}, 60_000);

	test("a deleted artifact names the generator", async () => {
		await withRules(
			async (root) => {
				await rm(resolve(root, ".claude/skills/openspec-explore/SKILL.md"));
				expect(await validateAgentRulesContract(root)).toContain(
					"agent-rules: .claude/skills/openspec-explore/SKILL.md is missing; run `bun run rules:sync`",
				);
			},
			{ openspec: true },
		);
	}, 60_000);

	test("an artifact in a project with no OpenSpec marker is rejected", async () => {
		await withRules(async (root) => {
			await mkdir(resolve(root, ".claude/commands/opsx"), { recursive: true });
			await Bun.write(
				resolve(root, ".claude/commands/opsx/archive.md"),
				"---\nname: leaked\n---\n",
			);
			expect(await validateAgentRulesContract(root)).toContain(
				"agent-rules: .claude/commands/opsx/archive.md exists in a project that has no openspec/config.yaml",
			);
		});
	});

	test("the vendor procedure is rejected wherever it reappears", async () => {
		await withRules(async (root) => {
			await Bun.write(
				resolve(root, "scripts/reminder.md"),
				`Then run ${["mv", "openspec/changes"].join(" ")}/<name> archive/.\n`,
			);
			const errors = await validateAgentRulesContract(root);
			expect(
				errors.some(
					(error) =>
						error.includes("scripts/reminder.md") &&
						error.includes("archiving goes through the wrapper"),
				),
			).toBe(true);
		});
	});
});
