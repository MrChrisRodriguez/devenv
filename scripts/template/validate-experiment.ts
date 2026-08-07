import { inspectExperimentContract } from "./experiment-contract";

const { errors, notices } = await inspectExperimentContract();
// Notices are printed whether the run passes or fails. A leg that could not
// compare has to say so out loud, and so does a rule that lives somewhere else:
// "checked nothing", "found nothing wrong" and "another guard owns this" produce
// the same exit status and are not the same claim.
for (const notice of notices) console.warn(notice);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the experiment lifecycle registry, its declared mode against the tree in both directions, guard wiring, template ownership, the seven strictness exception surfaces, containment and registration, CI universe membership, the promotion artefacts, the retirement residue scan, and the findings records.",
);
