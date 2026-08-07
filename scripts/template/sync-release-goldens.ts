// The ONLY thing that writes a golden manifest.
//
// `template:release-check` never writes: a comparison that repairs the thing it
// compares is not a comparison. Regeneration is a named command rather than an
// environment variable on the checking run for the same reason — an `UPDATE=1`
// that silently rewrites the expectation turns a review into a formality.
//
// It mirrors `rules:sync` deliberately, down to the refusal message naming the
// command, because it is the same contract: a generator plus a drift check over
// a committed artefact, and a reader who knows one knows the other.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	declaredFixtures,
	GOLDEN_ROOT,
	type GoldenDeclaration,
	type GoldenFile,
	REGISTRY_PATH,
	type ReleaseRegistry,
	readReleaseRegistry,
	SYNC_SCRIPT,
} from "./release-contract";
import { renderFixture } from "./render-fixture";

// What a golden deliberately does NOT capture, named in the artefact itself.
// Without this list the first cross-machine mismatch gets "fixed" by deleting
// the golden, because nobody can tell a real diff from nondeterminism.
const VOLATILE_FIELDS_EXCLUDED = [
	"the capture time: a manifest records what a render contains, never when it was taken",
	"the output directory: every render writes to a fresh temporary path and the manifest is relative to it",
	"fixture-manifest.json: the render writes it from this manifest, so it cannot appear inside it",
	"the omitted-path LIST: only its count is pinned, because the list is the template's own tracked set and belongs to the ownership rules",
	"file ordering: entries follow the renderer's own target sort, so a reordering is not representable here",
];

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

export async function syncReleaseGoldens(root: string): Promise<string[]> {
	const written: string[] = [];
	const { registry } = await readReleaseRegistry(root);
	const directory = registry?.goldens.directory ?? GOLDEN_ROOT;
	const fixtures = declaredFixtures(root);
	if (fixtures.length === 0)
		throw new Error(
			"release: no fixture definition was found, so there is nothing to pin",
		);
	await mkdir(resolve(root, directory), { recursive: true });
	const declarations: GoldenDeclaration[] = [];
	const output = await mkdtemp(resolve(tmpdir(), "devenv-release-sync-"));
	try {
		for (const fixture of fixtures) {
			const { manifest } = await renderFixture({
				root,
				fixtureName: fixture,
				output: resolve(output, fixture),
				force: true,
			});
			const golden: GoldenFile = {
				schemaVersion: 1,
				regenerateWith: `bun run ${SYNC_SCRIPT}`,
				volatileFieldsExcluded: VOLATILE_FIELDS_EXCLUDED,
				manifest,
			};
			const path = `${directory}/${fixture}.json`;
			await Bun.write(resolve(root, path), json(golden));
			written.push(path);
			declarations.push({
				fixture,
				manifest: path,
				fileCount: manifest.files.length,
				omittedCount: manifest.omittedCount,
				enabledCount: manifest.enabledCapabilities.length,
				disabledCount: manifest.disabledCapabilities.length,
			});
		}
	} finally {
		await rm(output, { recursive: true, force: true });
	}
	// The declaration is regenerated beside the goldens, because the two are one
	// artefact: a count that disagrees with the manifest it describes is what the
	// cross-check exists to catch, and leaving a human to retype three numbers
	// after every regeneration is how that check starts firing for reasons nobody
	// meant. The cross-check still earns its keep — it catches a HAND edit and a
	// partial regeneration, which is what it was written for.
	if (registry) {
		const next: ReleaseRegistry = {
			...registry,
			goldens: {
				...registry.goldens,
				totalFileCount: declarations.reduce(
					(sum, entry) => sum + entry.fileCount,
					0,
				),
				fixtures: declarations,
			},
		};
		await Bun.write(resolve(root, REGISTRY_PATH), json(next));
		written.push(REGISTRY_PATH);
	}
	const formatter = resolve(root, "node_modules/.bin/biome");
	const result = Bun.spawnSync({
		cmd: [process.execPath, formatter, "format", "--write", ...written],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`Golden formatting failed:\n${result.stdout.toString()}${result.stderr.toString()}`,
		);
	return written;
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	try {
		const written = await syncReleaseGoldens(root);
		console.log(
			`Regenerated ${written.length} files: ${written.join(", ")}. Review the diff before committing; a golden is an expectation, not an output.`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
