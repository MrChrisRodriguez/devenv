import { validateBrowserContract } from "./browser-contract";

const errors = await validateBrowserContract();
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated Playwright package, lock, image payload, capability wiring, and runtime preflight coherence.",
);
