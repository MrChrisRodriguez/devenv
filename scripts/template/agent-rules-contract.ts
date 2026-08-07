// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export const CANONICAL_FILE = "AGENTS.md";
export const SYNC_SCRIPT = "rules:sync";
export const GUARD_SCRIPT = "rules:check";
export const GUARD_CONTRACT = "scripts/template/agent-rules-contract.ts";
export const GUARD_ENTRYPOINT = "scripts/template/validate-agent-rules.ts";
export const SYNC_ENTRYPOINT = "scripts/template/sync-agent-rules.ts";

// Line-based HTML comments, matching the renderer's own fence syntax. They are
// comments so every mirror stays valid Markdown, and they are line based
// because `filterCapabilityBlocks` is a line filter: a marker that had to span
// lines would survive a render that dropped one of them.
const SHARED_START = /^<!--\s*shared:start\s+([a-z0-9-]+)\s*-->$/;
const SHARED_END = /^<!--\s*shared:end\s+([a-z0-9-]+)\s*-->$/;
const GENERATED_START = /^<!--\s*generated:start\s+([a-z0-9-]+)\s*-->$/;
const GENERATED_END = /^<!--\s*generated:end\s+([a-z0-9-]+)\s*-->$/;

/**
 * The required agent surfaces, including the one that is a NEGATIVE requirement.
 *
 * Codex's entry is the reason this is a table rather than a glob. "Codex reads
 * the root AGENTS.md and nothing else" is a standing decision, and a decision
 * that lives only in somebody's memory is re-litigated the first time a
 * generator offers to write `.codex/skills/openspec-*`. Recorded here it is a
 * check: `.codex/**` may not name an OpenSpec artifact, and adding one fails.
 */
export interface AgentSurface {
	agent: string;
	/** Where this agent's own rules live, or `AGENTS.md` when it has none. */
	file: string;
	/** Canonical blocks this file mirrors, in order. */
	blocks: string[];
	/** Directory this agent owns, if any. */
	directory?: string;
	/** Whether this agent receives the generated OpenSpec command/skill set. */
	openspecArtifacts: boolean;
}

export const AGENT_SURFACES: AgentSurface[] = [
	{
		agent: "shared",
		file: CANONICAL_FILE,
		blocks: [],
		openspecArtifacts: false,
	},
	{
		agent: "claude",
		file: "CLAUDE.md",
		blocks: ["openspec-lifecycle", "graphify-rules"],
		directory: ".claude",
		openspecArtifacts: true,
	},
	{
		agent: "claude-project",
		file: ".claude/CLAUDE.md",
		blocks: ["graphify-skill"],
		directory: ".claude",
		openspecArtifacts: true,
	},
	{
		agent: "gemini",
		file: "GEMINI.md",
		blocks: ["openspec-lifecycle", "graphify-rules"],
		directory: ".gemini",
		openspecArtifacts: false,
	},
	{
		agent: "codex",
		file: CANONICAL_FILE,
		blocks: [],
		directory: ".codex",
		openspecArtifacts: false,
	},
];

// The heading each generated region gets when `rules:sync` has to create it.
// Kept beside the block ids so a new block cannot be added without deciding
// what the mirrors call it.
export const BLOCK_HEADINGS: Record<string, string> = {
	"openspec-lifecycle": "## OpenSpec Lifecycle Ownership",
	"graphify-rules": "## graphify",
	"graphify-skill": "# graphify",
};

// The capability fence each block sits inside, so a generated region can be
// fenced exactly as its canonical source is. A block with no entry is core.
export const BLOCK_CAPABILITIES: Record<string, string> = {
	"openspec-lifecycle": "openspec",
	"graphify-rules": "graphify",
	"graphify-skill": "graphify",
};

// What an OpenSpec artifact looks like in a path or in prose. `.codex/**` may
// contain neither.
const OPENSPEC_ARTIFACT_TOKENS = ["opsx", "openspec-"];

function textOf(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function filesUnder(directory: string, depth = 0): string[] {
	if (depth > 8) return [];
	const found: string[] = [];
	try {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, String(entry.name));
			if (entry.isDirectory()) found.push(...filesUnder(path, depth + 1));
			else if (entry.isFile()) found.push(path);
		}
	} catch {
		return [];
	}
	return found.sort();
}

function collect(
	source: string,
	start: RegExp,
	end: RegExp,
	label: string,
): { blocks: Map<string, string>; errors: string[] } {
	const blocks = new Map<string, string>();
	const errors: string[] = [];
	let open: string | undefined;
	let body: string[] = [];
	for (const line of source.split("\n")) {
		const opened = start.exec(line.trim());
		const closed = end.exec(line.trim());
		if (opened?.[1]) {
			if (open) errors.push(`agent-rules: nested ${label} block ${opened[1]}`);
			open = opened[1];
			body = [];
			continue;
		}
		if (closed?.[1]) {
			if (open !== closed[1]) {
				errors.push(`agent-rules: mismatched ${label} block ${closed[1]}`);
				open = undefined;
				continue;
			}
			if (blocks.has(open))
				errors.push(`agent-rules: duplicate ${label} block ${open}`);
			blocks.set(open, body.join("\n").trim());
			open = undefined;
			continue;
		}
		if (open) body.push(line);
	}
	if (open) errors.push(`agent-rules: unterminated ${label} block ${open}`);
	return { blocks, errors };
}

/** The canonical blocks `AGENTS.md` declares. */
export function sharedBlocks(source: string): {
	blocks: Map<string, string>;
	errors: string[];
} {
	return collect(source, SHARED_START, SHARED_END, "shared");
}

/** The generated mirror regions a rule file carries. */
export function generatedBlocks(source: string): {
	blocks: Map<string, string>;
	errors: string[];
} {
	return collect(source, GENERATED_START, GENERATED_END, "generated");
}

function fenced(id: string, body: string): string[] {
	const capability = BLOCK_CAPABILITIES[id];
	const lines: string[] = [];
	if (capability) lines.push(`<!-- capability:start ${capability} -->`);
	if (BLOCK_HEADINGS[id]) lines.push(BLOCK_HEADINGS[id] as string, "");
	lines.push(
		`<!-- generated:start ${id} -->`,
		body,
		`<!-- generated:end ${id} -->`,
	);
	if (capability) lines.push(`<!-- capability:end ${capability} -->`);
	return lines;
}

/**
 * Rewrite one mirror file's generated regions from the canonical blocks.
 *
 * Regions that already exist are replaced in place, so a mirror keeps whatever
 * of its own it has around them. A declared region that is missing is appended
 * with its heading and capability fence — bootstrapping is the same operation
 * as maintenance, which is what makes `rules:sync` idempotent.
 */
export function renderMirror(
	existing: string,
	surface: AgentSurface,
	canonical: Map<string, string>,
): string {
	const wanted = surface.blocks.filter((id) => canonical.has(id));
	const output: string[] = [];
	const seen = new Set<string>();
	let open: string | undefined;
	for (const line of existing.split("\n")) {
		const opened = GENERATED_START.exec(line.trim());
		const closed = GENERATED_END.exec(line.trim());
		if (opened?.[1]) {
			open = opened[1];
			const body = canonical.get(open);
			if (body !== undefined && wanted.includes(open)) {
				output.push(line, body);
				seen.add(open);
			}
			continue;
		}
		if (closed?.[1]) {
			if (open === closed[1] && seen.has(open)) output.push(line);
			open = undefined;
			continue;
		}
		if (!open) output.push(line);
	}
	let rendered = output
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
	for (const id of wanted) {
		if (seen.has(id)) continue;
		rendered = `${rendered}\n\n${fenced(id, canonical.get(id) as string).join("\n")}`;
	}
	return `${rendered.trimEnd()}\n`;
}

/** Every mirror this tree should carry, with its rendered content. */
export function planMirrors(
	root: string,
	canonical: Map<string, string>,
): Array<{ surface: AgentSurface; path: string; content: string }> {
	const plan: Array<{ surface: AgentSurface; path: string; content: string }> =
		[];
	for (const surface of AGENT_SURFACES) {
		if (surface.file === CANONICAL_FILE || surface.blocks.length === 0)
			continue;
		const path = resolve(root, surface.file);
		if (!exists(path)) continue;
		plan.push({
			surface,
			path,
			content: renderMirror(textOf(path), surface, canonical),
		});
	}
	return plan;
}

// A canonical line worth checking for duplication: prose, not blank lines,
// fences, headings or list punctuation. Short lines are excluded because a
// two-word line is not evidence of a restated rule.
function normativeLines(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.length > 40 &&
				!line.startsWith("<!--") &&
				!line.startsWith("#") &&
				!line.startsWith("```"),
		);
}

/**
 * The whole cross-agent rules contract.
 *
 * The mirrors are checked against the canonical file rather than against each
 * other, and only for blocks the canonical file still declares — so a rendered
 * project that disabled a capability loses the canonical block and its mirrors
 * together, and the guard stays true in both trees without a second fence.
 */
export async function validateAgentRulesContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const canonicalPath = resolve(root, CANONICAL_FILE);
	if (!exists(canonicalPath)) {
		return [`agent-rules: ${CANONICAL_FILE} is missing`];
	}
	const canonicalSource = textOf(canonicalPath);
	const canonical = sharedBlocks(canonicalSource);
	errors.push(...canonical.errors);
	if (canonical.blocks.size === 0) {
		errors.push(
			`agent-rules: ${CANONICAL_FILE} declares no shared block; the mirrors would be checked against nothing`,
		);
	}
	for (const [id, body] of canonical.blocks) {
		if (body.trim() === "")
			errors.push(`agent-rules: the shared block ${id} is empty`);
		if (!(id in BLOCK_HEADINGS))
			errors.push(
				`agent-rules: the shared block ${id} has no declared heading`,
			);
	}

	const isTemplateRepository = exists(
		resolve(root, "template-parameters.toml"),
	);
	for (const surface of AGENT_SURFACES) {
		if (surface.file === CANONICAL_FILE) continue;
		const path = resolve(root, surface.file);
		if (!exists(path)) {
			// Absence is governed by the artifact rules, which the render tests
			// cover. In THIS repository every surface must exist.
			if (isTemplateRepository)
				errors.push(`agent-rules: ${surface.file} is missing`);
			continue;
		}
		const source = textOf(path);
		const mirror = generatedBlocks(source);
		errors.push(...mirror.errors.map((error) => `${error} in ${surface.file}`));
		const expected = surface.blocks.filter((id) => canonical.blocks.has(id));
		const actual = [...mirror.blocks.keys()];
		for (const id of actual) {
			if (!expected.includes(id))
				errors.push(
					`agent-rules: ${surface.file} carries the generated region ${id}, which ${CANONICAL_FILE} does not declare for it`,
				);
		}
		for (const id of expected) {
			if (!mirror.blocks.has(id)) {
				errors.push(
					`agent-rules: ${surface.file} is missing the generated region ${id}; run \`bun run ${SYNC_SCRIPT}\``,
				);
				continue;
			}
			if (mirror.blocks.get(id) !== canonical.blocks.get(id)) {
				errors.push(
					`agent-rules: ${surface.file} has drifted from ${CANONICAL_FILE} in ${id}; run \`bun run ${SYNC_SCRIPT}\``,
				);
			}
		}
		// Duplicate normative text. A rule restated outside its generated region
		// is a second rule the moment somebody edits one of the two copies, and
		// `rules:sync` would not touch it.
		const outside = renderMirror(source, surface, new Map()).split("\n");
		for (const id of expected) {
			for (const line of normativeLines(canonical.blocks.get(id) as string)) {
				if (outside.some((candidate) => candidate.trim() === line))
					errors.push(
						`agent-rules: ${surface.file} restates canonical text from ${id} outside its generated region`,
					);
			}
		}
	}

	// The negative requirement. Codex's whole surface is the root AGENTS.md.
	for (const surface of AGENT_SURFACES) {
		if (surface.openspecArtifacts || !surface.directory) continue;
		const directory = resolve(root, surface.directory);
		if (!exists(directory)) continue;
		for (const path of filesUnder(directory)) {
			const content = textOf(path);
			for (const token of OPENSPEC_ARTIFACT_TOKENS) {
				if (!content.includes(token)) continue;
				errors.push(
					`agent-rules: ${path.slice(root.length + 1)} names the OpenSpec artifact token "${token}", but ${surface.agent} receives no OpenSpec artifacts`,
				);
			}
		}
	}

	// Wiring. A guard nothing runs is documentation.
	for (const path of [GUARD_CONTRACT, GUARD_ENTRYPOINT, SYNC_ENTRYPOINT]) {
		if (!exists(resolve(root, path)))
			errors.push(`agent-rules: ${path} is missing`);
	}
	const manifest = resolve(root, "package.json");
	if (exists(manifest)) {
		const value = JSON.parse(textOf(manifest)) as JsonRecord;
		const scripts =
			typeof value["scripts"] === "object" && value["scripts"] !== null
				? (value["scripts"] as Record<string, unknown>)
				: {};
		if (scripts[GUARD_SCRIPT] !== `bun ${GUARD_ENTRYPOINT}`)
			errors.push(
				`agent-rules: package script ${GUARD_SCRIPT} must run ${GUARD_ENTRYPOINT}`,
			);
		if (scripts[SYNC_SCRIPT] !== `bun ${SYNC_ENTRYPOINT}`)
			errors.push(
				`agent-rules: package script ${SYNC_SCRIPT} must run ${SYNC_ENTRYPOINT}`,
			);
	}
	return [...new Set(errors)].sort();
}
