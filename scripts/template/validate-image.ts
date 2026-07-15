import { validateImageContract } from "./image-contract";

const errors = await validateImageContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated image stages, Proto partitions, immutable payloads, feature ownership, and runtime refusal.",
);
