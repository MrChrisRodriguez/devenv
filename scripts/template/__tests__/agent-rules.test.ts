import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	AGENT_SURFACES,
	CANONICAL_FILE,
	generatedBlocks,
	sharedBlocks,
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
async function rulesRepository(): Promise<string> {
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
	return root;
}

async function withRules(body: (root: string) => Promise<void>): Promise<void> {
	const root = await rulesRepository();
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
