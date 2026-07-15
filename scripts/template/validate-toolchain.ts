import { validateToolchainContract } from "./toolchain";
import { validateStageOneEvidence } from "./toolchain-evidence";

const errors = [
	...(await validateToolchainContract()),
	...(await validateStageOneEvidence()),
];

if (errors.length > 0) {
	for (const error of [...new Set(errors)].sort()) console.error(error);
	process.exit(1);
}

console.log(
	"Validated exact Proto, catalog, lock, feature, TypeScript, PATH, and Stage 1 evidence contracts.",
);
