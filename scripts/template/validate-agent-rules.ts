import { resolve } from "node:path";
import { validateAgentRulesContract } from "./agent-rules-contract";

const errors = await validateAgentRulesContract(
	resolve(import.meta.dir, "../.."),
);
if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log(
	"Validated the canonical agent rules, every generated mirror region, the fourteen artifacts regenerated from the pinned CLI, the required surface table, and the agents that receive no OpenSpec artifacts.",
);
