import { resolve } from "node:path";
import { validateStageZeroEvidence } from "./evidence";
import { validateJsonSchema } from "./json-schema";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	ParameterValidationError,
	parseToml,
	resolveFixtureParameters,
} from "./parameters";
import { validateToolchainContract } from "./toolchain";
import { validateStageOneEvidence } from "./toolchain-evidence";

export interface ValidationReport {
	schemaVersion: 1;
	status: "pass" | "fail";
	parameterFile: string;
	schemaFile: string;
	evidenceFile: string;
	evidenceSchemaFile: string;
	toolchainEvidenceFile: string;
	toolchainEvidenceSchemaFile: string;
	fixtures: Array<{ name: string; status: "pass" | "fail"; errors: string[] }>;
	errors: string[];
}

export async function validateAll(
	root = resolve(import.meta.dir, "../.."),
): Promise<ValidationReport> {
	const report: ValidationReport = {
		schemaVersion: 1,
		status: "pass",
		parameterFile: "template-parameters.toml",
		schemaFile: "template-parameters.schema.json",
		evidenceFile: "evidence/stage-0-baseline.json",
		evidenceSchemaFile: "evidence/stage-0-baseline.schema.json",
		toolchainEvidenceFile: "evidence/stage-1-toolchain.json",
		toolchainEvidenceSchemaFile: "evidence/stage-1-toolchain.schema.json",
		fixtures: [],
		errors: [],
	};
	try {
		const rawParameters = await parseToml(resolve(root, report.parameterFile));
		const schema = (await Bun.file(
			resolve(root, report.schemaFile),
		).json()) as Record<string, unknown>;
		const schemaErrors = validateJsonSchema(rawParameters, schema);
		if (schemaErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...schemaErrors.map((error) => `schema: ${error}`));
		}
		const parameters = await loadTemplateParameters(root);
		for (const fixtureName of parameters.generation.fixture_names) {
			try {
				const fixture = await loadFixtureDefinition(
					root,
					fixtureName,
					parameters,
				);
				resolveFixtureParameters(parameters, fixture);
				report.fixtures.push({ name: fixtureName, status: "pass", errors: [] });
			} catch (error) {
				report.status = "fail";
				const errors =
					error instanceof ParameterValidationError
						? error.issues
						: [error instanceof Error ? error.message : String(error)];
				report.fixtures.push({ name: fixtureName, status: "fail", errors });
				report.errors.push(
					...errors.map((message) => `${fixtureName}: ${message}`),
				);
			}
		}
		const evidenceErrors = await validateStageZeroEvidence(root);
		if (evidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...evidenceErrors.map((error) => `stage-0 evidence: ${error}`),
			);
		}
		const toolchainErrors = await validateToolchainContract(root);
		if (toolchainErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...toolchainErrors.map((error) => `toolchain: ${error}`),
			);
		}
		const toolchainEvidenceErrors = await validateStageOneEvidence(root);
		if (toolchainEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...toolchainEvidenceErrors.map((error) => `stage-1 evidence: ${error}`),
			);
		}
	} catch (error) {
		report.status = "fail";
		if (error instanceof ParameterValidationError)
			report.errors.push(...error.issues);
		else
			report.errors.push(
				error instanceof Error ? error.message : String(error),
			);
	}
	return report;
}

if (import.meta.main) {
	const json = process.argv.includes("--json");
	const report = await validateAll();
	if (json) console.log(JSON.stringify(report, null, 2));
	else if (report.status === "pass") {
		console.log(
			`Validated ${report.parameterFile}, ${report.evidenceFile}, ${report.toolchainEvidenceFile}, and ${report.fixtures.length} fixtures.`,
		);
	} else {
		console.error(
			`Template parameter validation failed:\n- ${report.errors.join("\n- ")}`,
		);
	}
	process.exitCode = report.status === "pass" ? 0 : 1;
}
