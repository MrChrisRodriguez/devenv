import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildProjectGraph, type ProjectGraph } from "./graph-contract";

// The markers that bound the generated region of a project's moon.yml. Only the
// text between them is owned by the generator; every other line in the file is
// hand-written and is copied through untouched, which is what makes it safe to
// regenerate a file that also carries tasks, tags, or a language declaration.
const BLOCK_START = "# graph:generated:start";
const BLOCK_END = "# graph:generated:end";

const HEADER = [
	BLOCK_START,
	"# dependsOn below is DERIVED from this project's package.json manifest and",
	"# its source imports by scripts/template/generate-graph.ts. Do not edit it by",
	"# hand: run `bun run graph:generate`. Every line outside these two markers is",
	"# hand-written and is preserved across regeneration.",
];

const EMPTY_NOTE =
	"# No cross-project dependency was derived. dependsOn is omitted rather than\n# written empty, so this file states nothing it cannot justify.";

export const STALE_MESSAGE =
	"generated moon.yml is stale — run bun run graph:generate";

export interface GeneratedConfig {
	/** Repository-relative path of the project config the generator owns. */
	path: string;
	/** The full file contents the generator would write. */
	contents: string;
	/** The contents currently committed, or "" when the file does not exist. */
	current: string;
}

export interface GenerationPlan {
	graph: ProjectGraph;
	configs: GeneratedConfig[];
	/** Configs whose committed contents differ from the generated contents. */
	drift: string[];
}

function renderBlock(dependsOn: readonly string[]): string {
	const lines = [...HEADER];
	if (dependsOn.length === 0) lines.push(EMPTY_NOTE);
	else {
		lines.push("dependsOn:");
		for (const id of dependsOn) lines.push(`  - '${id}'`);
	}
	lines.push(BLOCK_END);
	return lines.join("\n");
}

/**
 * Splice the generated block into a file, preserving everything else.
 *
 * A file that already carries the markers has the region between them replaced
 * in place, so the block keeps whatever position a maintainer gave it. A file
 * without them gets the block at the top, because a generated region that moves
 * around between runs is a diff nobody can review.
 */
export function spliceGeneratedBlock(current: string, block: string): string {
	const lines = current === "" ? [] : current.split("\n");
	const start = lines.findIndex((line) => line.trim() === BLOCK_START);
	const end = lines.findIndex((line) => line.trim() === BLOCK_END);
	if (start >= 0 && end > start) {
		const replaced = [
			...lines.slice(0, start),
			...block.split("\n"),
			...lines.slice(end + 1),
		];
		return `${replaced.join("\n").replace(/\n+$/, "")}\n`;
	}
	if (start >= 0 || end >= 0)
		throw new Error(
			"moon.yml carries an unbalanced graph:generated block; repair it by hand",
		);
	const remainder = current.replace(/^\n+/, "").replace(/\n+$/, "");
	return remainder === "" ? `${block}\n` : `${block}\n\n${remainder}\n`;
}

/**
 * Work out what every generated moon.yml should contain, and which committed
 * ones disagree.
 *
 * Only glob-discovered projects are generated. The root project is declared
 * through `projects.sources` and its moon.yml is hand-written core
 * configuration — it carries the inherited-task exclusion that keeps `moon run
 * :lint` from linting the repository once per project — so the generator states
 * no opinion about it.
 */
export async function planGeneratedConfigs(
	root: string,
): Promise<GenerationPlan> {
	const graph = await buildProjectGraph(root);
	const configs: GeneratedConfig[] = [];
	for (const project of graph.projects) {
		if (project.origin !== "glob") continue;
		const path = `${project.source}/moon.yml`;
		const file = Bun.file(resolve(root, path));
		const current = (await file.exists()) ? await file.text() : "";
		const dependsOn = [
			...new Set(
				graph.edges
					.filter((edge) => edge.from === project.id)
					.map((edge) => edge.to),
			),
		].sort();
		configs.push({
			path,
			current,
			contents: spliceGeneratedBlock(current, renderBlock(dependsOn)),
		});
	}
	configs.sort((left, right) => left.path.localeCompare(right.path));
	return {
		graph,
		configs,
		drift: configs
			.filter((config) => config.contents !== config.current)
			.map((config) => `graph: ${config.path}: ${STALE_MESSAGE}`),
	};
}

export async function writeGeneratedConfigs(root: string): Promise<string[]> {
	const plan = await planGeneratedConfigs(root);
	const written: string[] = [];
	for (const config of plan.configs) {
		if (config.contents === config.current) continue;
		const target = resolve(root, config.path);
		await mkdir(dirname(target), { recursive: true });
		await Bun.write(target, config.contents);
		written.push(config.path);
	}
	return written;
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const plan = await planGeneratedConfigs(root);
	if (plan.graph.errors.length > 0) {
		for (const error of plan.graph.errors) console.error(error);
		process.exit(1);
	}
	const written = await writeGeneratedConfigs(root);
	console.log(
		written.length === 0
			? `Every generated moon.yml is current (${plan.configs.length} project configs, ${plan.graph.projects.length} projects).`
			: `Regenerated ${written.join(", ")}.`,
	);
}
