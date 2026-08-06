import { validateCiContract } from "./ci-contract";

const errors = await validateCiContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated workflow trigger policy, bootstrap ownership, action pins, job bounds, failure tolerance, aggregate gate membership, shell injection surface, history ownership, compiler coverage, and guard wiring.",
);
