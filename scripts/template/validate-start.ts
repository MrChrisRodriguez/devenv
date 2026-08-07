import { inspectStartContract } from "./start-contract";

const { errors, notices } = await inspectStartContract();
// Notices are printed whether the run passes or fails. A leg that could not
// compare has to say so out loud, and so does a rule that lives somewhere else:
// "checked nothing", "found nothing wrong" and "another guard owns this"
// produce the same exit status and are not the same claim.
for (const notice of notices) console.warn(notice);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the application surface registry, its declared mode against the tree, guard wiring, template ownership, the development runtime policy, and the declared proxy routes against the development proxy registry.",
);
