import { inspectProxyContract } from "./proxy-contract";

const { errors, notices } = await inspectProxyContract();
// Notices are printed whether the run passes or fails. A leg that could not
// compare has to say so out loud: "checked nothing" and "found nothing wrong"
// produce the same exit status and are not the same claim.
for (const notice of notices) console.warn(notice);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the proxy route registry, its declared mode against the tree, guard wiring, template ownership, and the published port and friendly domain against the worktree runtime contract.",
);
