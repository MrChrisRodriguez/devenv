// biome-ignore-all lint/complexity/useLiteralKeys: Parsed JSON is a strict record.
import { resolve } from "node:path";
import {
	AffectedPreflightError,
	type AffectedSelection,
	describeSelection,
	MODE_SELECTING,
	MODE_VARIABLE,
	selectAffected,
} from "./affected-contract";

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
	const emitted = await selectAffected({ root, ...input });
	if (emitted.mode === "narrow") return { emitted, shadow: emitted };
	// Only worth recomputing when the MODE is what held the answer back. Every
	// other full outcome — an unusable base, a global input, an event with no
	// base — would come out the same with the variable set, and printing "it
	// would have been full" is not a comparison.
	if (emitted.reason !== "mode-not-selecting")
		return { emitted, shadow: emitted };
	const shadow = await selectAffected({
		root,
		...input,
		mode: MODE_SELECTING,
	});
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
