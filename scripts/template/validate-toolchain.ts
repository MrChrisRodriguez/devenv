import { resolve } from "node:path";
import { validateToolchainContract } from "./toolchain";

const root = resolve(import.meta.dir, "../..");
const errors = await validateToolchainContract(root);
const evidencePath = resolve(root, "evidence/stage-1-toolchain.json");
const evidenceSchemaPath = resolve(
	root,
	"evidence/stage-1-toolchain.schema.json",
);
const validatesEvidence =
	(await Bun.file(evidencePath).exists()) &&
	(await Bun.file(evidenceSchemaPath).exists());
if (validatesEvidence) {
	const { validateStageOneEvidence } = await import("./toolchain-evidence");
	errors.push(...(await validateStageOneEvidence(root)));
}

if (errors.length > 0) {
	for (const error of [...new Set(errors)].sort()) console.error(error);
	process.exit(1);
}

console.log(
	`Validated exact Proto, catalog, lock, feature, TypeScript, and PATH contracts${validatesEvidence ? " with Stage 1 evidence" : ""}.`,
);
