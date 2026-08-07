// biome-ignore-all lint/complexity/useLiteralKeys: Parsed YAML and JSON are strict records.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// The moon subcommand that prints the project graph, pinned as ONE constant
// because it is the single place this repository's oracle touches the binary.
//
// It is `moon query projects` with NO `--json`, and that is a verified fact
// about moon 2.3.5 rather than a preference: `moon query projects --json` exits
// 2 with "unexpected argument '--json' found". In moon 2.x the whole `query`
// family emits JSON by definition — `moon query --help` says so in its first
// line — and the flag that used to request it is gone. A guard that kept
// passing `--json` would fail on every run and be "fixed" by deleting the
// query, which is how a live oracle quietly becomes a no-op.
export const MOON_QUERY_ARGV = ["query", "projects"] as const;

// Where the project graph is declared, and the authority every derived edge is
// compared against.
const WORKSPACE_CONFIG = ".moon/workspace.yml";
const PROJECT_CONFIG = "moon.yml";
const PACKAGE_MANIFEST = "package.json";
const PARAMETER_PATH = "template-parameters.toml";
const TSCONFIG_BASE = "tsconfig.base.json";

// Directories that are never part of any project's own sources: build output,
// installed dependencies, caches, and the knowledge-graph artifact tree. Walking
// them would attribute a dependency's own imports to the project that installed
// it.
const IGNORED_DIRECTORIES = new Set([
	".git",
	".moon",
	"dist",
	"graphify-out",
	"node_modules",
	"tmp",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

// Manifest sections that can carry a workspace dependency. `peerDependencies`
// and `optionalDependencies` are included because a `workspace:` protocol value
// is a real edge in any of them; the section a package chooses changes install
// semantics, not who depends on whom.
const MANIFEST_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export type EdgeReason = "manifest" | "import";

export interface GraphProject {
	/** The moon project id: `moon.yml#id`, else the directory basename. */
	id: string;
	/** Repository-relative POSIX source path; `.` for the root project. */
	source: string;
	/** How the project entered the graph — a `globs` match or a `sources` key. */
	origin: "glob" | "source";
	/** `package.json#name`, when this project has a manifest at all. */
	packageName?: string;
	/** `dependsOn` exactly as the committed moon.yml declares it. */
	declaredDependsOn: string[];
	/** Whether a moon.yml is committed for this project. */
	hasConfig: boolean;
}

export interface GraphEdge {
	from: string;
	to: string;
	reason: EdgeReason;
	/** The manifest key or import specifier that produced the edge. */
	evidence: string;
}

export interface ProjectGraph {
	projects: GraphProject[];
	edges: GraphEdge[];
	/** `.moon/workspace.yml#vcs.defaultBranch`, when it is declared. */
	defaultBranch?: string;
	/** Structural problems found while reading the graph's own declarations. */
	errors: string[];
}

export type PathScope = "global" | "project" | "docs";

export interface PathClassification {
	scope: PathScope;
	project?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
	return await Bun.file(path).exists();
}

async function readText(path: string): Promise<string> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : "";
}

async function readJson(path: string): Promise<JsonRecord | undefined> {
	if (!(await exists(path))) return undefined;
	try {
		const value = (await Bun.file(path).json()) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function parseYaml(source: string): JsonRecord | undefined {
	try {
		const value = Bun.YAML.parse(source) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	const found: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") found.push(entry);
		// moon also accepts the object form `{ id: 'ui', scope: 'production' }`.
		else if (isRecord(entry) && typeof entry["id"] === "string")
			found.push(entry["id"]);
	}
	return found;
}

// Expand a moon project glob into the directories it names.
//
// Only directories are followed, and that is the rule moon itself applies: a
// glob that also matched files produced the "Received a file path for a project
// root, must be a directory" warning this repository used to emit once per loose
// file under scripts/. `**` is deliberately unsupported rather than
// approximated — a wrong expansion silently changes the whole graph, so the
// caller is told instead.
function expandGlob(root: string, pattern: string): string[] {
	if (pattern.includes("**")) return [];
	let current: string[] = [""];
	for (const segment of pattern.split("/")) {
		if (segment === "" || segment === ".") continue;
		const matcher = new Bun.Glob(segment);
		const next: string[] = [];
		for (const directory of current) {
			let entries: ReturnType<typeof readdirSync>;
			try {
				entries = readdirSync(resolve(root, directory), {
					withFileTypes: true,
				}) as unknown as ReturnType<typeof readdirSync>;
			} catch {
				continue;
			}
			for (const entry of entries as unknown as Array<{
				name: string;
				isDirectory(): boolean;
			}>) {
				if (!entry.isDirectory()) continue;
				if (IGNORED_DIRECTORIES.has(entry.name)) continue;
				if (!matcher.match(entry.name)) continue;
				next.push(directory === "" ? entry.name : `${directory}/${entry.name}`);
			}
		}
		current = next;
	}
	return current.sort();
}

// Strip comments before anything reads an import out of a source file.
//
// Without this, a commented-out import is an edge: the generator would declare a
// dependency nothing actually uses, and the oracle would then demand it forever.
// The scan is a small state machine rather than a regular expression because the
// two cases that matter — a `//` inside a string such as "https://example.com",
// and a `/*` inside a template literal — are exactly the ones a regex gets
// wrong.
export function stripSourceComments(source: string): string {
	let output = "";
	let index = 0;
	let quote: string | undefined;
	let escaped = false;
	while (index < source.length) {
		const character = source[index] ?? "";
		if (quote !== undefined) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = undefined;
			index += 1;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			output += character;
			index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			index += 2;
			while (
				index < source.length &&
				!(source[index] === "*" && source[index + 1] === "/")
			)
				index += 1;
			index += 2;
			// Keep a separator so `a/*c*/b` cannot become the token `ab`.
			output += " ";
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

// Every form in which one file names another module. The `from` form is bounded
// rather than open-ended so a multi-line `import { … }` list is matched while a
// runaway match cannot span the rest of the file.
const IMPORT_PATTERNS = [
	/\b(?:import|export)\b[\s\S]{0,500}?\bfrom\s*["']([^"'\n]+)["']/g,
	/\bimport\s*["']([^"'\n]+)["']/g,
	/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
	/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
	const stripped = stripSourceComments(source);
	const found = new Set<string>();
	for (const pattern of IMPORT_PATTERNS) {
		for (const match of stripped.matchAll(pattern))
			if (match[1]) found.add(match[1]);
	}
	return [...found].sort();
}

function walkSourceFiles(root: string): string[] {
	const files: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0) {
		const directory = stack.pop() ?? "";
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = readdirSync(resolve(root, directory), {
				withFileTypes: true,
			}) as unknown as Array<{ name: string; isDirectory(): boolean }>;
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
			if (entry.isDirectory()) {
				if (IGNORED_DIRECTORIES.has(entry.name)) continue;
				stack.push(path);
				continue;
			}
			if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)))
				files.push(path);
		}
	}
	return files.sort();
}

function contains(source: string, path: string): boolean {
	if (source === ".") return true;
	return path === source || path.startsWith(`${source}/`);
}

// The project a file belongs to is the DEEPEST one whose source contains it.
// The root project's source is the whole repository, so without "deepest wins"
// every file in every nested project would also be attributed to the root and
// each nested project's imports would become the root's dependencies.
function ownerOf(
	projects: readonly GraphProject[],
	path: string,
): GraphProject | undefined {
	let best: GraphProject | undefined;
	for (const project of projects) {
		if (!contains(project.source, path)) continue;
		if (!best || project.source.length > best.source.length) best = project;
	}
	return best;
}

// The `@<slug>/*` → `libs/*/src` alias declared in tsconfig.base.json, read out
// of the file rather than hardcoded: the renderer rewrites the slug for every
// downstream project, so a literal `@confiador/` here would make this guard
// answer questions about the template while running inside someone else's repo.
async function libraryAliasPrefix(root: string): Promise<string | undefined> {
	const declaration = await readJson(resolve(root, TSCONFIG_BASE));
	const compilerOptions = isRecord(declaration?.["compilerOptions"])
		? declaration["compilerOptions"]
		: undefined;
	const paths = isRecord(compilerOptions?.["paths"])
		? compilerOptions["paths"]
		: undefined;
	if (!paths) return undefined;
	for (const [key, value] of Object.entries(paths)) {
		if (!key.startsWith("@") || !key.endsWith("/*")) continue;
		const targets = strings(value);
		if (
			!targets.some((target) => target.replace(/\\/g, "/").includes("libs/*"))
		)
			continue;
		return key.slice(0, -1);
	}
	return undefined;
}

function resolveSpecifier(
	specifier: string,
	projects: readonly GraphProject[],
	aliasPrefix: string | undefined,
): GraphProject | undefined {
	// Relative specifiers stay inside their own project by construction, and a
	// bare package name that matches nothing here is an external dependency.
	if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
	for (const project of projects) {
		const name = project.packageName;
		if (!name) continue;
		if (specifier === name || specifier.startsWith(`${name}/`)) return project;
	}
	if (aliasPrefix && specifier.startsWith(aliasPrefix)) {
		const remainder = specifier.slice(aliasPrefix.length);
		const library = remainder.split("/")[0] ?? "";
		if (library === "") return undefined;
		return projects.find((project) => project.source === `libs/${library}`);
	}
	return undefined;
}

/**
 * Build the project graph from first principles: the workspace declaration, the
 * package manifests, and the source imports. It never runs moon, which is the
 * point — a guard that asked moon what the graph is could only ever agree with
 * moon.
 */
export async function buildProjectGraph(root: string): Promise<ProjectGraph> {
	const errors: string[] = [];
	const workspaceSource = await readText(resolve(root, WORKSPACE_CONFIG));
	if (workspaceSource === "")
		return {
			projects: [],
			edges: [],
			errors: [`graph: ${WORKSPACE_CONFIG} is missing`],
		};
	const workspace = parseYaml(workspaceSource);
	if (!workspace)
		return {
			projects: [],
			edges: [],
			errors: [`graph: ${WORKSPACE_CONFIG} must parse as YAML`],
		};

	const declaration = workspace["projects"];
	const globs = Array.isArray(declaration)
		? strings(declaration)
		: isRecord(declaration)
			? strings(declaration["globs"])
			: [];
	const sources =
		isRecord(declaration) && isRecord(declaration["sources"])
			? declaration["sources"]
			: {};
	for (const pattern of globs) {
		if (pattern.includes("**"))
			errors.push(
				`graph: ${WORKSPACE_CONFIG} declares the unsupported recursive glob ${pattern}`,
			);
	}

	const discovered: Array<{
		source: string;
		origin: "glob" | "source";
		id?: string;
	}> = [];
	for (const pattern of globs)
		for (const source of expandGlob(root, pattern))
			discovered.push({ source, origin: "glob" });
	for (const [id, value] of Object.entries(sources)) {
		if (typeof value !== "string") continue;
		const source = value.replace(/\/+$/, "") || ".";
		discovered.push({
			source: source === "" ? "." : source,
			origin: "source",
			id,
		});
	}

	const projects: GraphProject[] = [];
	const seen = new Set<string>();
	for (const entry of discovered) {
		if (seen.has(entry.source)) continue;
		seen.add(entry.source);
		const configPath = resolve(
			root,
			entry.source === "."
				? PROJECT_CONFIG
				: `${entry.source}/${PROJECT_CONFIG}`,
		);
		const hasConfig = await exists(configPath);
		const config = hasConfig
			? parseYaml(await readText(configPath))
			: undefined;
		if (hasConfig && !config)
			errors.push(
				`graph: ${entry.source}/${PROJECT_CONFIG} must parse as YAML`,
			);
		const manifest = await readJson(
			resolve(
				root,
				entry.source === "."
					? PACKAGE_MANIFEST
					: `${entry.source}/${PACKAGE_MANIFEST}`,
			),
		);
		const declaredId = config?.["id"];
		const id =
			entry.id ??
			(typeof declaredId === "string" && declaredId !== ""
				? declaredId
				: (entry.source.split("/").at(-1) ?? entry.source));
		const packageName = manifest?.["name"];
		projects.push({
			id,
			source: entry.source,
			origin: entry.origin,
			...(typeof packageName === "string" ? { packageName } : {}),
			declaredDependsOn: strings(config?.["dependsOn"]).sort(),
			hasConfig,
		});
	}
	projects.sort((left, right) => left.id.localeCompare(right.id));
	for (const project of projects) {
		if (projects.filter((other) => other.id === project.id).length > 1)
			errors.push(`graph: more than one project claims the id ${project.id}`);
	}

	// Manifest edges.
	const edges: GraphEdge[] = [];
	const record = (edge: GraphEdge): void => {
		if (edge.from === edge.to) return;
		if (
			edges.some(
				(existing) =>
					existing.from === edge.from &&
					existing.to === edge.to &&
					existing.reason === edge.reason,
			)
		)
			return;
		edges.push(edge);
	};
	for (const project of projects) {
		const manifest = await readJson(
			resolve(
				root,
				project.source === "."
					? PACKAGE_MANIFEST
					: `${project.source}/${PACKAGE_MANIFEST}`,
			),
		);
		if (!manifest) continue;
		for (const section of MANIFEST_SECTIONS) {
			const entries = manifest[section];
			if (!isRecord(entries)) continue;
			for (const [name, value] of Object.entries(entries)) {
				const target = projects.find((other) => other.packageName === name);
				const isWorkspaceProtocol =
					typeof value === "string" && value.startsWith("workspace:");
				if (!target) {
					if (isWorkspaceProtocol)
						errors.push(
							`graph: ${project.id} declares a workspace dependency on ${name}, which is not a project`,
						);
					continue;
				}
				record({
					from: project.id,
					to: target.id,
					reason: "manifest",
					evidence: `${section}.${name}`,
				});
			}
		}
	}

	// Import edges.
	const aliasPrefix = await libraryAliasPrefix(root);
	for (const file of walkSourceFiles(root)) {
		const owner = ownerOf(projects, file);
		if (!owner) continue;
		const source = await readText(resolve(root, file));
		if (source === "") continue;
		for (const specifier of importSpecifiers(source)) {
			const target = resolveSpecifier(specifier, projects, aliasPrefix);
			if (!target || target.id === owner.id) continue;
			record({
				from: owner.id,
				to: target.id,
				reason: "import",
				evidence: specifier,
			});
		}
	}
	edges.sort((left, right) =>
		`${left.from}:${left.to}:${left.reason}:${left.evidence}`.localeCompare(
			`${right.from}:${right.to}:${right.reason}:${right.evidence}`,
		),
	);

	// The default branch has exactly one meaning and must have exactly one
	// value. moon's own default is `master`, so an unstated key is not "no
	// opinion" — it is a silently wrong diff base for every affected query.
	const vcs = isRecord(workspace["vcs"]) ? workspace["vcs"] : undefined;
	const defaultBranch = vcs?.["defaultBranch"];
	if (typeof defaultBranch !== "string" || defaultBranch === "")
		errors.push(`graph: ${WORKSPACE_CONFIG} must declare vcs.defaultBranch`);
	const parameterPath = resolve(root, PARAMETER_PATH);
	if (typeof defaultBranch === "string" && (await exists(parameterPath))) {
		try {
			const parameters = Bun.TOML.parse(
				await Bun.file(parameterPath).text(),
			) as JsonRecord;
			const project = isRecord(parameters["project"])
				? parameters["project"]["default_branch"]
				: undefined;
			if (typeof project === "string" && project !== defaultBranch)
				errors.push(
					`graph: ${WORKSPACE_CONFIG} vcs.defaultBranch ${defaultBranch} differs from ${PARAMETER_PATH} project.default_branch ${project}`,
				);
		} catch {
			errors.push(`graph: ${PARAMETER_PATH} must parse as TOML`);
		}
	}

	return {
		projects,
		edges,
		...(typeof defaultBranch === "string" ? { defaultBranch } : {}),
		errors,
	};
}

/**
 * Compare the derived edges with what the committed moon.yml files declare.
 *
 * The five verdicts are deliberately distinct. A missing edge and an extra edge
 * are opposite drifts and want opposite repairs; an undeclared import is neither
 * — it is a manifest that does not admit a dependency the code already has.
 */
export function compareDeclaredEdges(graph: ProjectGraph): string[] {
	const errors: string[] = [];
	const ids = new Set(graph.projects.map((project) => project.id));
	for (const project of graph.projects) {
		const derived = new Set(
			graph.edges
				.filter((edge) => edge.from === project.id)
				.map((edge) => edge.to),
		);
		for (const target of derived) {
			if (!project.declaredDependsOn.includes(target))
				errors.push(
					`graph: ${project.id} depends on ${target} but its moon.yml does not declare it`,
				);
		}
		for (const declared of project.declaredDependsOn) {
			if (!ids.has(declared)) {
				errors.push(
					`graph: ${project.id} declares a dependency on ${declared}, which is not a project`,
				);
				continue;
			}
			if (!derived.has(declared))
				errors.push(
					`graph: ${project.id} declares a dependency on ${declared} that nothing in its manifest or sources justifies`,
				);
		}
		// An import edge with no manifest edge behind it is code that reaches
		// into another package the manifest never asked for. It resolves today
		// because the workspace hoists everything and breaks the moment the
		// package is built or published on its own.
		for (const edge of graph.edges) {
			if (edge.from !== project.id || edge.reason !== "import") continue;
			const manifested = graph.edges.some(
				(other) =>
					other.from === edge.from &&
					other.to === edge.to &&
					other.reason === "manifest",
			);
			if (!manifested && project.packageName !== undefined)
				errors.push(
					`graph: ${project.id} imports ${edge.evidence} from ${edge.to} without declaring it in ${PACKAGE_MANIFEST}`,
				);
		}
	}
	return [...graph.errors, ...errors].sort();
}

// The sole CI matrix universe registry, and the pattern that proves it is sole.
//
// The filename is fixed rather than configurable: it is the path Stage 0 already
// recorded as this capability's signature, so a project without the capability
// fails its anti-residue scan the moment a copy of this file appears. A second
// registry — even a well-meaning `ci-matrix-universes.backup.json` — would give
// the matrix two authorities that disagree silently, which is why the pattern
// below is a wildcard and the rule is "exactly one".
const REGISTRY_PATH = "ci-matrix-universes.json";
const REGISTRY_PATTERN = "*universes*.json";
const UNIVERSE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MatrixUniverse {
	id: string;
	description?: string;
	projects: string[];
}

// Tracked files only, read through Git so the scan sees exactly what a clone
// receives. `undefined` means this tree is not a repository — a rendered fixture
// before `git init` — and the scan abstains rather than reporting a clean result
// it never established.
function trackedFiles(root: string, pattern: string): string[] | undefined {
	const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", pattern], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString().split("\0").filter(Boolean);
}

/**
 * Validate the CI matrix universe registry against the project graph.
 *
 * The registry answers "which projects does a CI lane run over", and the only
 * useful answer is a total one: every project belongs to EXACTLY one universe.
 * A project in none is a project no lane ever builds — the silent hole this file
 * exists to close — and a project in two is a lane that runs it twice while
 * reporting one result.
 *
 * Absence and a parse failure are hard errors rather than a skipped check. This
 * function only runs where the capability's surface is present, so "the registry
 * is missing" means the surface is half-installed, not absent.
 */
export async function validateUniverseRegistry(
	root: string,
	graph: ProjectGraph,
): Promise<string[]> {
	const errors: string[] = [];
	const path = resolve(root, REGISTRY_PATH);
	if (!(await exists(path))) return [`graph: ${REGISTRY_PATH} is missing`];
	let value: unknown;
	try {
		value = await Bun.file(path).json();
	} catch {
		return [`graph: ${REGISTRY_PATH} must parse as JSON`];
	}
	if (!isRecord(value))
		return [`graph: ${REGISTRY_PATH} must be a JSON object`];
	if (value["schemaVersion"] !== 1)
		errors.push(`graph: ${REGISTRY_PATH} must declare schemaVersion 1`);
	const universes = Array.isArray(value["universes"])
		? value["universes"].filter(isRecord)
		: [];
	if (universes.length === 0)
		errors.push(`graph: ${REGISTRY_PATH} must declare at least one universe`);

	const known = new Set(graph.projects.map((project) => project.id));
	const membership = new Map<string, number>();
	const seenIds = new Set<string>();
	for (const universe of universes) {
		const id = universe["id"];
		if (typeof id !== "string" || !UNIVERSE_ID.test(id)) {
			errors.push(
				`graph: ${REGISTRY_PATH} universe id ${JSON.stringify(id)} must be kebab-case`,
			);
			continue;
		}
		if (seenIds.has(id))
			errors.push(
				`graph: ${REGISTRY_PATH} declares the universe id ${id} more than once`,
			);
		seenIds.add(id);
		const projects = Array.isArray(universe["projects"])
			? universe["projects"].filter(
					(entry): entry is string => typeof entry === "string",
				)
			: [];
		if (projects.length === 0) {
			errors.push(
				`graph: ${REGISTRY_PATH} universe ${id} must list at least one project`,
			);
			continue;
		}
		for (const project of projects) {
			if (!known.has(project))
				errors.push(
					`graph: ${REGISTRY_PATH} universe ${id} lists ${project}, which is not a project`,
				);
			membership.set(project, (membership.get(project) ?? 0) + 1);
		}
	}
	for (const [project, count] of membership) {
		if (count > 1)
			errors.push(
				`graph: ${REGISTRY_PATH} lists the project ${project} more than once`,
			);
	}
	for (const project of known) {
		if (!membership.has(project))
			errors.push(
				`graph: the project ${project} belongs to no universe in ${REGISTRY_PATH}`,
			);
	}

	for (const candidate of trackedFiles(root, REGISTRY_PATTERN) ?? []) {
		if (candidate === REGISTRY_PATH) continue;
		errors.push(
			`graph: ${candidate} is a second matrix universe registry; ${REGISTRY_PATH} is the only one`,
		);
	}
	return errors.sort();
}

// Paths whose change cannot be attributed to one project. Each is here because
// changing it changes what EVERY project builds or how every project is
// checked — so the honest answer is "everything", not "nothing".
const GLOBAL_PATTERNS = [
	".prototools",
	"package.json",
	"bun.lock",
	"tsconfig*.json",
	".moon/**",
	".github/**",
	"ci-matrix-universes.json",
	"scripts/**",
];

// Paths that change no build output at all.
const DOCS_PATTERNS = ["docs/**", "**/*.md", "openspec/**"];

/**
 * Classify one repository-relative path.
 *
 * This is CLASSIFICATION ONLY. It answers "whose change is this", and nothing
 * in this stage turns that answer into a selection — the affected-selection lane
 * is a later stage, and building it on an unproven classifier is how a CI matrix
 * silently stops running the job that mattered.
 *
 * Order matters: documentation is checked first, because a Markdown file under
 * `.github/` or `scripts/` is still documentation; the global list is checked
 * next, because those paths sit inside the root project's source and would
 * otherwise be attributed to it; and anything left over falls to the deepest
 * project that contains it. A path that matches nothing is global, because the
 * conservative answer to "what does this affect" is "everything".
 */
export function classifyPath(
	path: string,
	projects: readonly GraphProject[],
): PathClassification {
	const normalized = path.replace(/^\.\//, "");
	if (DOCS_PATTERNS.some((pattern) => new Bun.Glob(pattern).match(normalized)))
		return { scope: "docs" };
	if (
		GLOBAL_PATTERNS.some((pattern) => new Bun.Glob(pattern).match(normalized))
	)
		return { scope: "global" };
	const owner = ownerOf(projects, normalized);
	if (!owner) return { scope: "global" };
	return { scope: "project", project: owner.id };
}
