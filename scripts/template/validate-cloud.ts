import { validateCloudContract } from "./cloud-contract";

const errors = await validateCloudContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated Codex Cloud contract pins, persisted paths, fingerprint inputs, script boundary, and workflow wiring coherence.",
);
