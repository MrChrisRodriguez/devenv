import { resolve } from "node:path";
import { validateBrowserContract } from "./browser-contract";
import { validateStageZeroEvidence } from "./evidence";
import { validateStageTwoEvidence } from "./image-evidence";
import { validateJsonSchema } from "./json-schema";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	ParameterValidationError,
	parseToml,
	resolveFixtureParameters,
} from "./parameters";
import { validateStageThreeEvidence } from "./stage-three-evidence";
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
	imageEvidenceFile: string;
	imageEvidenceSchemaFile: string;
	runtimeEvidenceFile: string;
	runtimeEvidenceSchemaFile: string;
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
		imageEvidenceFile: "evidence/stage-2-image.json",
		imageEvidenceSchemaFile: "evidence/stage-2-image.schema.json",
		runtimeEvidenceFile: "evidence/stage-3-runtimes.json",
		runtimeEvidenceSchemaFile: "evidence/stage-3-runtimes.schema.json",
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
		const browserErrors = await validateBrowserContract(root);
		if (browserErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...browserErrors.map((error) => `browser: ${error}`));
		}
		const toolchainEvidenceErrors = await validateStageOneEvidence(root);
		if (toolchainEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...toolchainEvidenceErrors.map((error) => `stage-1 evidence: ${error}`),
			);
		}
		const imageEvidenceErrors = await validateStageTwoEvidence(root);
		if (imageEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...imageEvidenceErrors.map((error) => `stage-2 evidence: ${error}`),
			);
		}
		const runtimeEvidenceErrors = await validateStageThreeEvidence(root);
		if (runtimeEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...runtimeEvidenceErrors.map((error) => `stage-3 evidence: ${error}`),
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
			`Validated ${report.parameterFile}, ${report.evidenceFile}, ${report.toolchainEvidenceFile}, ${report.imageEvidenceFile}, ${report.runtimeEvidenceFile}, and ${report.fixtures.length} fixtures.`,
		);
	} else {
		console.error(
			`Template parameter validation failed:\n- ${report.errors.join("\n- ")}`,
		);
	}
	process.exitCode = report.status === "pass" ? 0 : 1;
}
