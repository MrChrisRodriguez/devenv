import { inspectFormsContract } from "./forms-contract";

const { errors, notices } = await inspectFormsContract();
// Notices are printed whether the run passes or fails. A gate that could not
// compare — no merge base, a contract artifact new in this branch — has to say
// so out loud: "compared nothing" and "found nothing wrong" produce the same
// exit status and are not the same claim.
for (const notice of notices) console.warn(notice);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the api contract registry, its declared mode against the tree, guard wiring, template ownership, browser safety, generated-artifact drift, and additive-only evolution.",
);
