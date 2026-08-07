import { validateAffectedContract } from "./affected-contract";

const errors = await validateAffectedContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated affected-selection guard wiring, matrix universe registry, template ownership, and the recorded initial selection mode.",
);
