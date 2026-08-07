import { inspectReleaseContract } from "./release-contract";

const { errors, notices } = await inspectReleaseContract();
// Notices are printed whether the run passes or fails. A leg that could not
// compare has to say so out loud, and so does a rule that lives somewhere else:
// "checked nothing", "found nothing wrong" and "another guard owns this"
// produce the same exit status and are not the same claim. The inherited
// acceptance list prints here too, so a green release gate is never mistaken
// for "everything was re-measured at this head".
for (const notice of notices) console.warn(notice);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the release declaration, its decision against the tree, the template-only wiring and its four asserted negatives, the three golden render manifests, the six scan families over every render, the top-level layout rule, the sync boundary ratchet, the recorded deferrals, the capability inventory and version authorities, the ten acceptance items and their derived inheritance, the four budget families, and the two declared CI signals.",
);
