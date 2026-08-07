import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CANONICAL_FILE,
	planMirrors,
	sharedBlocks,
} from "./agent-rules-contract";

/**
 * Regenerate every mirror region from the canonical `AGENTS.md`.
 *
 * This is the ONLY way a mirror is allowed to change. Editing `CLAUDE.md` or
 * `GEMINI.md` by hand produces two rules that agree until the day one of them
 * is updated, and `rules:check` exists to make that day today rather than
 * whenever somebody notices.
 *
 * `--check` reports what would change without writing, which is what the guard
 * and the tests use to prove the generator is idempotent.
 */
export async function syncAgentRules(
	root = resolve(import.meta.dir, "../.."),
	options: { write?: boolean } = {},
): Promise<{ changed: string[] }> {
	const canonical = sharedBlocks(
		readFileSync(resolve(root, CANONICAL_FILE), "utf8"),
	);
	if (canonical.errors.length > 0) throw new Error(canonical.errors.join("\n"));
	const changed: string[] = [];
	for (const entry of planMirrors(root, canonical.blocks)) {
		const current = readFileSync(entry.path, "utf8");
		if (current === entry.content) continue;
		changed.push(entry.surface.file);
		if (options.write !== false) await Bun.write(entry.path, entry.content);
	}
	return { changed };
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	const result = await syncAgentRules(resolve(import.meta.dir, "../.."), {
		write: !check,
	});
	if (result.changed.length === 0) {
		console.log(`Agent rule mirrors are current with ${CANONICAL_FILE}.`);
	} else if (check) {
		console.error(
			`Agent rule mirrors have drifted from ${CANONICAL_FILE}:\n- ${result.changed.join("\n- ")}`,
		);
		process.exit(1);
	} else {
		console.log(
			`Regenerated from ${CANONICAL_FILE}:\n- ${result.changed.join("\n- ")}`,
		);
	}
}
