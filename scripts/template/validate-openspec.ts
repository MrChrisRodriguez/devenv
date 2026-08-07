// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { resolve } from "node:path";
import {
	inspectOpenspec,
	type OpenspecInspection,
	type OpenspecRoot,
	validateOpenspecContract,
} from "./openspec-contract";

type JsonRecord = Record<string, unknown>;

// The binary the live legs call, and the only injection point for it. A test
// cannot make the CLI lie on demand, and a guard whose failure paths are never
// executed is a guard nobody has checked, so the path is read from the
// environment and defaults to the repository-local install.
const OPENSPEC_BIN = "OPENSPEC_BIN";
const REPOSITORY_BINARY = "node_modules/.bin/openspec";
const CATALOG_PACKAGE = "@fission-ai/openspec";

// Telemetry is opt-OUT in this CLI: unset, it posts to PostHog from every
// invocation, including the ones a required CI lane makes. All three switches
// are set because the CLI has changed which one it honours between releases,
// and a guard must never depend on the network to answer.
const QUIET_ENVIRONMENT: Record<string, string> = {
	OPENSPEC_TELEMETRY: "0",
	DO_NOT_TRACK: "1",
	CI: "true",
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Invocation {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function invoke(binary: string, argv: string[], cwd: string): Invocation {
	const result = Bun.spawnSync([binary, ...argv], {
		cwd,
		env: { ...process.env, ...QUIET_ENVIRONMENT },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

/**
 * The pinned, repository-local binary — or a named failure.
 *
 * "Whatever `openspec` is on PATH" is not a pin: a globally installed CLI of a
 * different version validates a different schema and reports the same green
 * summary while doing so. The binary must live inside THIS repository's
 * `node_modules`, and it must agree with the catalog entry that put it there.
 */
export async function resolveOpenspecCli(
	root: string,
): Promise<{ binary?: string; errors: string[] }> {
	const errors: string[] = [];
	const override = process.env[OPENSPEC_BIN];
	const binary = override ?? resolve(root, REPOSITORY_BINARY);
	if (!(await Bun.file(binary).exists())) {
		errors.push(
			`openspec: the pinned CLI is missing at ${binary}; run \`bun install\``,
		);
		return { errors };
	}
	const inside = resolve(root, "node_modules");
	if (!resolve(binary).startsWith(`${inside}/`)) {
		errors.push(
			`openspec: ${binary} is outside ${inside}; a global CLI is not a pin`,
		);
		return { errors };
	}
	const manifest = resolve(root, "package.json");
	let pinned: string | undefined;
	if (await Bun.file(manifest).exists()) {
		const value = (await Bun.file(manifest).json()) as JsonRecord;
		const workspaces = isRecord(value["workspaces"]) ? value["workspaces"] : {};
		const catalog = isRecord(workspaces["catalog"])
			? workspaces["catalog"]
			: {};
		const entry = catalog[CATALOG_PACKAGE];
		if (typeof entry === "string") pinned = entry;
	}
	if (!pinned) {
		errors.push(
			`openspec: package.json must pin ${CATALOG_PACKAGE} in workspaces.catalog`,
		);
		return { errors };
	}
	const version = invoke(binary, ["--version"], root);
	if (version.exitCode !== 0) {
		errors.push(
			`openspec: ${binary} --version exited ${version.exitCode}: ${version.stderr.trim().split("\n").at(-1) ?? ""}`,
		);
		return { errors };
	}
	const reported = version.stdout.trim().split("\n").at(-1)?.trim() ?? "";
	if (reported !== pinned) {
		errors.push(
			`openspec: ${binary} reports ${reported || "no version"}, but this repository pins ${pinned}`,
		);
		return { errors };
	}
	return { binary, errors };
}

function parseJson(
	invocation: Invocation,
	label: string,
): { value?: unknown; errors: string[] } {
	if (invocation.exitCode !== 0) {
		return {
			errors: [
				`openspec: ${label} exited ${invocation.exitCode}: ${invocation.stderr.trim().split("\n").at(-1) ?? ""}`,
			],
		};
	}
	const stdout = invocation.stdout.trim();
	if (stdout === "")
		return { errors: [`openspec: ${label} produced no output`] };
	try {
		return { value: JSON.parse(stdout), errors: [] };
	} catch {
		return { errors: [`openspec: ${label} did not produce JSON`] };
	}
}

/**
 * Drive the CLI once per enumerated root and reconcile both answers.
 *
 * Every abnormal outcome is a failure. That is not defensiveness: the two
 * commands here are the ones whose SUCCESS is least informative. `list --json`
 * happily prints an empty set, and `validate --all --strict` exits 0 over zero
 * items and never inspects an archive — so "the CLI was happy" is compatible
 * with a tree in which every change has been deleted. The independent
 * enumeration is what makes the exit status mean something, and the item sets
 * must match EXACTLY in both directions.
 */
export async function reconcileWithCli(
	root: string,
	binary: string,
	entry: OpenspecRoot,
): Promise<string[]> {
	const errors: string[] = [];
	const cwd = resolve(root, entry.workingDirectory);

	const listed = parseJson(
		invoke(binary, ["list", "--json"], cwd),
		`\`openspec list --json\` in ${entry.workingDirectory}`,
	);
	errors.push(...listed.errors);
	if (listed.value !== undefined) {
		if (!isRecord(listed.value) || !Array.isArray(listed.value["changes"])) {
			errors.push(
				`openspec: \`openspec list --json\` in ${entry.workingDirectory} did not report a changes array`,
			);
		} else {
			const reported: string[] = [];
			for (const change of listed.value["changes"]) {
				if (!isRecord(change) || typeof change["name"] !== "string") {
					errors.push(
						`openspec: \`openspec list --json\` in ${entry.workingDirectory} reported a change in an unexpected shape`,
					);
					reported.length = 0;
					break;
				}
				reported.push(change["name"]);
			}
			errors.push(
				...compare(
					entry,
					"active change",
					entry.changes.map((change) => change.name),
					reported,
				),
			);
		}
	}

	const validated = parseJson(
		invoke(binary, ["validate", "--all", "--strict", "--json"], cwd),
		`\`openspec validate --all --strict --json\` in ${entry.workingDirectory}`,
	);
	errors.push(...validated.errors);
	if (validated.value === undefined) return errors.sort();
	if (!isRecord(validated.value) || !Array.isArray(validated.value["items"])) {
		errors.push(
			`openspec: \`openspec validate --all\` in ${entry.workingDirectory} did not report an items array`,
		);
		return errors.sort();
	}
	const ids: string[] = [];
	for (const item of validated.value["items"]) {
		if (
			!isRecord(item) ||
			typeof item["id"] !== "string" ||
			typeof item["valid"] !== "boolean"
		) {
			errors.push(
				`openspec: \`openspec validate --all\` in ${entry.workingDirectory} reported an item in an unexpected shape`,
			);
			return errors.sort();
		}
		ids.push(item["id"]);
		if (!item["valid"]) {
			const issues = Array.isArray(item["issues"]) ? item["issues"].length : 0;
			errors.push(
				`openspec: ${item["id"]} in ${entry.workingDirectory} failed strict validation with ${issues} issue(s)`,
			);
		}
	}
	// Anti-vacuity. A root that validated nothing has told us nothing, and the
	// summary total is checked against OUR count rather than against the item
	// array the same command printed — otherwise the CLI would be agreeing with
	// itself.
	const expected = [
		...entry.changes.map((change) => change.name),
		...entry.specs,
	];
	if (expected.length === 0) {
		errors.push(
			`openspec: ${entry.directory} declares no change and no spec; the guard would validate nothing`,
		);
	}
	errors.push(...compare(entry, "validated item", expected, ids));
	const summary = validated.value["summary"];
	const totals =
		isRecord(summary) && isRecord(summary["totals"]) ? summary["totals"] : {};
	if (totals["items"] !== expected.length) {
		errors.push(
			`openspec: \`openspec validate --all\` in ${entry.workingDirectory} counted ${String(totals["items"])} items where ${entry.directory} declares ${expected.length}`,
		);
	}
	return errors.sort();
}

function compare(
	entry: OpenspecRoot,
	label: string,
	expected: string[],
	reported: string[],
): string[] {
	const errors: string[] = [];
	const declared = new Set(expected);
	const seen = new Set(reported);
	for (const name of seen) {
		if (!declared.has(name))
			errors.push(
				`openspec: the CLI reports the ${label} ${name} in ${entry.workingDirectory}, which ${entry.directory} does not contain`,
			);
	}
	for (const name of declared) {
		if (!seen.has(name))
			errors.push(
				`openspec: the CLI does not report the ${label} ${name}, which ${entry.directory} contains`,
			);
	}
	return errors;
}

export async function validateOpenspec(
	root = resolve(import.meta.dir, "../.."),
	options: { cli?: boolean; now?: Date } = {},
): Promise<{
	errors: string[];
	notices: string[];
	inspection: OpenspecInspection;
}> {
	const now = options.now ?? new Date();
	const inspection = await inspectOpenspec(root, now);
	const errors = await validateOpenspecContract(root, now);
	// The live legs are skipped when the hermetic ones already failed: the CLI
	// reads the same directories, so it would restate the same defect in less
	// useful words — and drive itself over a tree the guard has already rejected.
	if (options.cli === false || errors.length > 0)
		return { errors, notices: inspection.notices, inspection };
	const resolved = await resolveOpenspecCli(root);
	if (!resolved.binary || resolved.errors.length > 0) {
		return {
			errors: [...errors, ...resolved.errors].sort(),
			notices: inspection.notices,
			inspection,
		};
	}
	const live: string[] = [];
	for (const entry of inspection.roots)
		live.push(...(await reconcileWithCli(root, resolved.binary, entry)));
	return {
		errors: [...errors, ...live].sort(),
		notices: inspection.notices,
		inspection,
	};
}

if (import.meta.main) {
	const cli = !process.argv.includes("--no-cli");
	const result = await validateOpenspec(resolve(import.meta.dir, "../.."), {
		cli,
	});
	// Notices print on the way past whether the run passes or fails. A completion
	// notice is the one output here that is not a verdict: it is the tree telling
	// the operator that the next step is an archive, and suppressing it on
	// failure would hide it exactly when the operator is reading the output.
	for (const notice of result.notices) console.log(notice);
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(error);
		process.exit(1);
	}
	const roots = result.inspection.roots.length;
	const items = result.inspection.roots.reduce(
		(total, entry) => total + entry.changes.length + entry.specs.length,
		0,
	);
	console.log(
		cli
			? `Validated ${items} OpenSpec item(s) across ${roots} root(s) with the pinned repository-local CLI.`
			: `Validated the OpenSpec lifecycle contract across ${roots} root(s) without the CLI.`,
	);
}
