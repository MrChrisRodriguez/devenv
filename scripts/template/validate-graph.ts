// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { resolve } from "node:path";
import { planGeneratedConfigs } from "./generate-graph";
import {
	compareDeclaredEdges,
	MOON_QUERY_ARGV,
	type ProjectGraph,
	validateUniverseRegistry,
} from "./graph-contract";

// The binary the live leg calls, and the only injection point for it. A test
// cannot install moon, and a guard whose failure paths are never executed is a
// guard nobody has checked, so the name is read from the environment and
// defaults to the real thing.
const MOON_BIN = "MOON_BIN";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reconcile the independently built graph with the one moon reports.
 *
 * Every abnormal outcome is a failure, deliberately: a query that exits
 * non-zero, prints nothing, prints something that is not JSON, or prints JSON
 * in a shape this guard does not recognise has told us NOTHING about the graph.
 * Treating any of those as "no drift found" is how a live oracle turns into a
 * step that always passes — which is worse than not having it, because the CI
 * page then claims the graph was verified.
 */
export async function reconcileWithMoon(
	root: string,
	graph: ProjectGraph,
): Promise<string[]> {
	const binary = process.env[MOON_BIN] ?? "moon";
	const invocation = `${binary} ${MOON_QUERY_ARGV.join(" ")}`;
	const result = Bun.spawnSync([binary, ...MOON_QUERY_ARGV], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		return [
			`graph: ${invocation} exited ${result.exitCode}: ${result.stderr.toString().trim().split("\n").at(-1) ?? ""}`,
		];
	const stdout = result.stdout.toString().trim();
	if (stdout === "") return [`graph: ${invocation} produced no output`];
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return [`graph: ${invocation} did not produce JSON`];
	}
	if (!isRecord(value) || !Array.isArray(value["projects"]))
		return [`graph: ${invocation} did not report a projects array`];

	const reported = new Map<string, string[]>();
	for (const entry of value["projects"]) {
		if (
			!isRecord(entry) ||
			typeof entry["id"] !== "string" ||
			typeof entry["source"] !== "string"
		)
			return [`graph: ${invocation} reported a project in an unexpected shape`];
		const dependencies = Array.isArray(entry["dependencies"])
			? entry["dependencies"]
			: [];
		const targets: string[] = [];
		for (const dependency of dependencies) {
			if (!isRecord(dependency) || typeof dependency["id"] !== "string")
				return [
					`graph: ${invocation} reported a dependency in an unexpected shape`,
				];
			targets.push(dependency["id"]);
		}
		reported.set(entry["id"], targets.sort());
	}

	const errors: string[] = [];
	const derived = new Set(graph.projects.map((project) => project.id));
	for (const id of reported.keys()) {
		if (!derived.has(id))
			errors.push(
				`graph: moon reports the project ${id}, which the committed graph does not declare`,
			);
	}
	for (const id of derived) {
		if (!reported.has(id))
			errors.push(
				`graph: moon does not report the project ${id}, which the committed graph declares`,
			);
	}
	for (const [id, targets] of reported) {
		if (!derived.has(id)) continue;
		const expected = [
			...new Set(
				graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to),
			),
		].sort();
		for (const target of targets) {
			if (!expected.includes(target))
				errors.push(
					`graph: moon reports the edge ${id} -> ${target}, which nothing in the manifests or sources justifies`,
				);
		}
		for (const target of expected) {
			if (!targets.includes(target))
				errors.push(
					`graph: moon does not report the derived edge ${id} -> ${target}`,
				);
		}
	}
	return errors.sort();
}

/**
 * The whole graph contract, in two legs.
 *
 * Leg 1 is hermetic and always runs: it rebuilds the graph from the manifests
 * and the sources, compares it with what the committed moon.yml files declare,
 * checks the generated configs are current, and validates the matrix universe
 * registry. It needs no moon binary, which is what lets it run in the required
 * lane, in `template:validate`, and on a developer host that has neither moon
 * nor proto.
 *
 * Leg 2 is live and runs only with `--query`: it asks moon for the graph and
 * reconciles the two answers. It is the only leg that can catch a disagreement
 * between what this repository believes and what moon actually does — a moon
 * upgrade that changes glob semantics, say — and it is exactly the leg that
 * needs a real toolchain, so it lives in its own fenced CI job.
 */
export async function validateGraphContract(
	root = resolve(import.meta.dir, "../.."),
	options: { query?: boolean } = {},
): Promise<string[]> {
	const plan = await planGeneratedConfigs(root);
	const errors = [
		...compareDeclaredEdges(plan.graph),
		...plan.drift,
		...(await validateUniverseRegistry(root, plan.graph)),
	];
	// The live leg is skipped when the hermetic leg already failed: moon reads
	// the same files, so it would restate the same defect in less useful words.
	if (options.query && errors.length === 0)
		errors.push(...(await reconcileWithMoon(root, plan.graph)));
	return errors;
}

if (import.meta.main) {
	const query = process.argv.includes("--query");
	const errors = await validateGraphContract(
		resolve(import.meta.dir, "../.."),
		{
			query,
		},
	);
	if (errors.length > 0) {
		for (const error of errors) console.error(error);
		process.exit(1);
	}
	console.log(
		query
			? "Validated the project graph, generated project configs, matrix universe registry, and moon's own view of the graph."
			: "Validated the project graph, generated project configs, and matrix universe registry.",
	);
}
