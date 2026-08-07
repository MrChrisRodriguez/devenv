import { validateFormsContract } from "./forms-contract";

const errors = await validateFormsContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the api contract registry, its declared mode against the tree, guard wiring, and template ownership.",
);
