import { resolve } from "node:path";
import { loadTemplateParameters } from "./parameters";
import { renderFixture } from "./render-fixture";

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const outputRoot = resolve(
		process.argv[2] ?? resolve(root, "tmp/generated-fixtures"),
	);
	const parameters = await loadTemplateParameters(root);
	const reports = [];
	for (const fixtureName of parameters.generation.fixture_names) {
		const result = await renderFixture({
			root,
			fixtureName,
			output: resolve(outputRoot, fixtureName),
			force: true,
		});
		reports.push({
			fixture: fixtureName,
			files: result.manifest.files.length,
			omitted: result.manifest.omittedCount,
			residue: result.residue.status,
		});
	}
	console.log(JSON.stringify({ schemaVersion: 1, fixtures: reports }, null, 2));
}
