import { validateWorktreeContract } from "./worktree-contract";

const errors = await validateWorktreeContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated worktree runtime contract keys, generator equality, devcontainer coherence, fingerprint authority, script boundary, and ownership wiring.",
);
