// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { resolve } from "node:path";
import {
	AffectedPreflightError,
	type AffectedSelection,
	describeSelection,
	MODE_SELECTING,
	MODE_VARIABLE,
	selectAffected,
	widenToFull,
} from "./affected-contract";
import { MOON_AFFECTED_ARGV } from "./graph-contract";

// The binary the reconciliation leg calls, and the only injection point for it.
// A test cannot install moon, and a leg whose failure paths are never executed
// is a leg nobody has checked — so the name is read from the environment and
// defaults to the real thing, exactly as the graph oracle's live leg does.
const MOON_BIN = "MOON_BIN";

/**
 * The exit code that means "the fail-CLOSED preflight tripped".
 *
 * It has to be distinguishable from every other failure, because the shell
 * entrypoint answers them in opposite directions: any ordinary fault becomes
 * the FULL matrix and a green job, while this one becomes a red job and NO
 * output at all. A single "non-zero" would collapse the two and turn the one
 * deliberate hard stop into a silent full-green run.
 */
export const PREFLIGHT_EXIT_CODE = 2;

export interface SelectorEnvironment {
	[key: string]: string | undefined;
}

/**
 * Resolve the selector's inputs from the environment alone.
 *
 * Never from command-line interpolation. Pull-request metadata is
 * attacker-influenced text, and the workflow guard already rejects a `run:`
 * body that splices `github.event.*` into a shell command — so the base sha
 * arrives the same way the gate's draft flag does.
 */
export function readSelectorEnvironment(environment: SelectorEnvironment): {
	mode: string | undefined;
	eventName: string | undefined;
	baseSha: string | undefined;
	headSha: string | undefined;
} {
	return {
		mode: environment[MODE_VARIABLE],
		eventName: environment["EVENT_NAME"],
		baseSha: environment["BASE_SHA"],
		headSha: environment["HEAD_SHA"],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MoonRun =
	| { ok: true; exitCode: number; stdout: string; stderr: string }
	| { ok: false; message: string };

/**
 * Ask moon the same question and refuse to be narrower than its answer allows.
 *
 * The direction is the whole point. Moon may only WIDEN a selection to FULL; it
 * can never narrow one, and its number is never adopted. A selector that took
 * moon's set would be certifying moon from moon's own declarations — the exact
 * circularity Stage 8A's independent graph builder exists to avoid — on the one
 * decision in this repository that can skip the required suite.
 *
 * So *every* abnormal outcome is a widening: a binary that is not there, a
 * non-zero exit, silence, output that is not JSON, JSON in a shape this leg does
 * not recognise, a set narrower than ours, and a set wider than ours. Each has
 * told us NOTHING about what is affected, and "we learned nothing" must not read
 * as "the narrow answer is confirmed".
 *
 * Three details make the comparison meaningful rather than merely strict:
 *
 *   * moon is fed the SEED files, not the whole diff. It has no notion of
 *     documentation, so a changed `.md` would resolve to whichever project
 *     contains it and disagree on every documentation-only pull request.
 *   * an empty seed list means moon is not called at all. With empty stdin
 *     `moon query projects --affected` does not answer "nothing"; it falls back
 *     to working-tree detection, which on a clean CI checkout is a confident,
 *     silent "run nothing" with exit 0.
 *   * projects whose source is the whole repository are excluded from moon's
 *     answer, because moon reports them affected by every changed file. Our
 *     selector already refuses to narrow when one of them owns a change, so
 *     excluding them here compares like with like rather than papering over a
 *     disagreement.
 *
 * `MOON_BASE`/`MOON_HEAD` carry the resolved merge base and head. They have the
 * highest precedence in moon's own base resolution, which matters because moon
 * honours `GITHUB_BASE_REF` over the workspace's pinned `vcs.defaultBranch` —
 * so without them a stacked pull request could be diffed against a branch this
 * selection never looked at.
 */
export async function reconcileWithMoon(
	root: string,
	selection: AffectedSelection,
	headSha: string | undefined,
): Promise<AffectedSelection> {
	if (selection.mode !== "narrow") return selection;
	const binary = process.env[MOON_BIN] ?? "moon";
	const invocation = `${binary} ${MOON_AFFECTED_ARGV.join(" ")}`;
	if (selection.seedFiles.length === 0)
		return {
			...selection,
			annotations: [
				...selection.annotations,
				`${invocation} not consulted: no project file changed, and an empty file list would make it answer from the working tree instead`,
			],
		};

	const widen = (detail: string): Promise<AffectedSelection> =>
		widenToFull(root, selection, "moon-disagreed", detail);

	const result = ((): MoonRun => {
		try {
			const run = Bun.spawnSync([binary, ...MOON_AFFECTED_ARGV], {
				cwd: root,
				stdin: Buffer.from(`${selection.seedFiles.join("\n")}\n`),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					...(selection.mergeBase === undefined
						? {}
						: { MOON_BASE: selection.mergeBase }),
					...(headSha === undefined ? {} : { MOON_HEAD: headSha }),
				},
			});
			return {
				ok: true,
				exitCode: run.exitCode,
				stdout: run.stdout.toString(),
				stderr: run.stderr.toString(),
			};
		} catch (error) {
			// A binary that is not on PATH throws here rather than exiting
			// non-zero, and "moon is not installed" is exactly the case a runner
			// hits when the setup step was skipped or failed.
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	})();
	if (!result.ok)
		return await widen(`${invocation} could not be run: ${result.message}`);
	if (result.exitCode !== 0)
		return await widen(
			`${invocation} exited ${result.exitCode}: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
		);
	const stdout = result.stdout.trim();
	if (stdout === "") return await widen(`${invocation} produced no output`);
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return await widen(`${invocation} did not produce JSON`);
	}
	if (!isRecord(value) || !Array.isArray(value["projects"]))
		return await widen(`${invocation} did not report a projects array`);
	const excluded = new Set(selection.repositoryWide);
	const reported: string[] = [];
	for (const entry of value["projects"]) {
		if (!isRecord(entry) || typeof entry["id"] !== "string")
			return await widen(
				`${invocation} reported a project in an unexpected shape`,
			);
		if (!excluded.has(entry["id"])) reported.push(entry["id"]);
	}
	const moonSet = [...new Set(reported)].sort();
	const ours = [...selection.selected].sort();
	if (moonSet.join(",") !== ours.join(","))
		return await widen(
			`${invocation} reported [${moonSet.join(", ")}] where the committed graph derived [${ours.join(", ")}]`,
		);
	return {
		...selection,
		annotations: [
			...selection.annotations,
			`${invocation} agrees: [${moonSet.join(", ")}]`,
		],
	};
}

/**
 * Compute the selection that is emitted, plus the selection that WOULD have
 * been emitted if the mode variable were set.
 *
 * The second half is the shadow phase, and it is the mode switch itself rather
 * than a second implementation: while the variable is unset every run still
 * computes a real narrow answer and prints it, while emitting the full matrix.
 * Building a separate shadow selector in order to delete it would leave a
 * deletion commit as its only artefact; this way the comparison is available
 * from the first run and there is nothing to remove afterwards.
 */
export async function runSelector(
	root: string,
	environment: SelectorEnvironment,
): Promise<{ emitted: AffectedSelection; shadow: AffectedSelection }> {
	const input = readSelectorEnvironment(environment);
	const derived = await selectAffected({ root, ...input });
	const emitted = await reconcileWithMoon(root, derived, input.headSha);
	if (emitted.mode === "narrow") return { emitted, shadow: emitted };
	// Only worth recomputing when the MODE is what held the answer back. Every
	// other full outcome — an unusable base, a global input, an event with no
	// base, a moon that disagreed — would come out the same with the variable
	// set, and printing "it would have been full" is not a comparison.
	if (emitted.reason !== "mode-not-selecting")
		return { emitted, shadow: emitted };
	// The shadow queries moon too. A shadow that skipped the reconciliation
	// would report a narrow answer the flipped run might refuse, which is the
	// one thing the shadow phase exists to rule out before the flip.
	const shadow = await reconcileWithMoon(
		root,
		await selectAffected({ root, ...input, mode: MODE_SELECTING }),
		input.headSha,
	);
	return { emitted, shadow };
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const wantsJson = process.argv.includes("--json");
	try {
		const { emitted, shadow } = await runSelector(root, process.env);
		// The human-readable half goes to stderr so stdout stays a clean
		// document: the shell entrypoint parses one and relays the other into the
		// job summary, in BOTH modes.
		console.error(describeSelection(emitted));
		if (shadow !== emitted)
			console.error(
				`would have selected with ${MODE_VARIABLE}=${MODE_SELECTING}:\n${describeSelection(shadow)}`,
			);
		if (wantsJson) console.log(JSON.stringify(emitted));
	} catch (error) {
		if (error instanceof AffectedPreflightError) {
			for (const issue of error.issues) console.error(issue);
			// No output, and a code the caller can tell apart from a crash.
			process.exit(PREFLIGHT_EXIT_CODE);
		}
		throw error;
	}
}
