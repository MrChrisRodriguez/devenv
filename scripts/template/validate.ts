import { resolve } from "node:path";
import { validateAffectedContract } from "./affected-contract";
import { validateAgentRulesContract } from "./agent-rules-contract";
import { validateBrowserContract } from "./browser-contract";
import { validateCiContract } from "./ci-contract";
import { validateCloudContract } from "./cloud-contract";
import { validateStageZeroEvidence } from "./evidence";
import { validateFormsContract } from "./forms-contract";
import { validateStageTwoEvidence } from "./image-evidence";
import { validateJsonSchema } from "./json-schema";
import { validateOpenspecContract } from "./openspec-contract";
import {
	loadFixtureDefinition,
	loadTemplateParameters,
	ParameterValidationError,
	parseToml,
	resolveFixtureParameters,
} from "./parameters";
import { validateStageEightAEvidence } from "./stage-eight-a-evidence";
import { validateStageEightBEvidence } from "./stage-eight-b-evidence";
import { validateStageFiveBEvidence } from "./stage-five-b-evidence";
import { validateStageFiveEvidence } from "./stage-five-evidence";
import { validateStageFourEvidence } from "./stage-four-evidence";
import { validateStageNineEvidence } from "./stage-nine-evidence";
import { validateStageSevenEvidence } from "./stage-seven-evidence";
import { validateStageSixEvidence } from "./stage-six-evidence";
import { validateStageTenAEvidence } from "./stage-ten-a-evidence";
import { validateStageTenBEvidence } from "./stage-ten-b-evidence";
import { validateStageThreeEvidence } from "./stage-three-evidence";
import { validateTelemetryContract } from "./telemetry-contract";
import { validateToolchainContract } from "./toolchain";
import { validateStageOneEvidence } from "./toolchain-evidence";
import { validateGraphContract } from "./validate-graph";
import { validateWorktreeContract } from "./worktree-contract";

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
	cloudEvidenceFile: string;
	cloudEvidenceSchemaFile: string;
	worktreeEvidenceFile: string;
	worktreeEvidenceSchemaFile: string;
	cutoverEvidenceFile: string;
	cutoverEvidenceSchemaFile: string;
	doctorEvidenceFile: string;
	doctorEvidenceSchemaFile: string;
	ciEvidenceFile: string;
	ciEvidenceSchemaFile: string;
	graphEvidenceFile: string;
	graphEvidenceSchemaFile: string;
	affectedEvidenceFile: string;
	affectedEvidenceSchemaFile: string;
	openspecEvidenceFile: string;
	openspecEvidenceSchemaFile: string;
	contractEvidenceFile: string;
	contractEvidenceSchemaFile: string;
	telemetryEvidenceFile: string;
	telemetryEvidenceSchemaFile: string;
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
		cloudEvidenceFile: "evidence/stage-4-cloud.json",
		cloudEvidenceSchemaFile: "evidence/stage-4-cloud.schema.json",
		worktreeEvidenceFile: "evidence/stage-5-worktree.json",
		worktreeEvidenceSchemaFile: "evidence/stage-5-worktree.schema.json",
		cutoverEvidenceFile: "evidence/stage-5b-cutover.json",
		cutoverEvidenceSchemaFile: "evidence/stage-5b-cutover.schema.json",
		doctorEvidenceFile: "evidence/stage-6-doctor.json",
		doctorEvidenceSchemaFile: "evidence/stage-6-doctor.schema.json",
		ciEvidenceFile: "evidence/stage-7-ci.json",
		ciEvidenceSchemaFile: "evidence/stage-7-ci.schema.json",
		graphEvidenceFile: "evidence/stage-8a-moon-graph.json",
		graphEvidenceSchemaFile: "evidence/stage-8a-moon-graph.schema.json",
		affectedEvidenceFile: "evidence/stage-8b-affected-selection.json",
		affectedEvidenceSchemaFile:
			"evidence/stage-8b-affected-selection.schema.json",
		openspecEvidenceFile: "evidence/stage-9-openspec.json",
		openspecEvidenceSchemaFile: "evidence/stage-9-openspec.schema.json",
		contractEvidenceFile: "evidence/stage-10a-api-contract.json",
		contractEvidenceSchemaFile: "evidence/stage-10a-api-contract.schema.json",
		telemetryEvidenceFile: "evidence/stage-10b-telemetry.json",
		telemetryEvidenceSchemaFile: "evidence/stage-10b-telemetry.schema.json",
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
		const cloudErrors = await validateCloudContract(root);
		if (cloudErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...cloudErrors);
		}
		const worktreeErrors = await validateWorktreeContract(root);
		if (worktreeErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...worktreeErrors);
		}
		const ciErrors = await validateCiContract(root);
		if (ciErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...ciErrors);
		}
		// The hermetic leg only: `template:validate` runs on a developer host
		// that has neither moon nor proto, and a leg that needs a binary would be
		// skipped there rather than run — which is the same as not having it.
		const graphErrors = await validateGraphContract(root);
		if (graphErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...graphErrors);
		}
		const affectedErrors = await validateAffectedContract(root);
		if (affectedErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...affectedErrors);
		}
		// The hermetic leg only, for the same reason as the graph oracle above:
		// the live leg drives the pinned CLI, and a host running
		// `template:validate` before `bun install` would skip it rather than run
		// it — which is the same as not having it.
		const openspecErrors = await validateOpenspecContract(root);
		if (openspecErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...openspecErrors);
		}
		// The shared schema and API contract. Hermetic by construction: it reads
		// a committed declaration and reconciles it with the tracked tree, so it
		// needs no schema library, no generator and no server of its own.
		const formsErrors = await validateFormsContract(root);
		if (formsErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...formsErrors);
		}
		// The telemetry and external-write contract. Hermetic by construction for
		// the same reason: it reads a committed declaration and reconciles it with
		// the tracked tree, so it needs no telemetry account, no credential and no
		// network to answer.
		const telemetryErrors = await validateTelemetryContract(root);
		if (telemetryErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...telemetryErrors);
		}
		// Hermetic again: the vendor-artifact leg spawns the pinned CLI, which
		// `rules:check` owns.
		const agentRulesErrors = await validateAgentRulesContract(root, {
			vendor: false,
		});
		if (agentRulesErrors.length > 0) {
			report.status = "fail";
			report.errors.push(...agentRulesErrors);
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
		const cloudEvidenceErrors = await validateStageFourEvidence(root);
		if (cloudEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...cloudEvidenceErrors.map((error) => `stage-4 evidence: ${error}`),
			);
		}
		const worktreeEvidenceErrors = await validateStageFiveEvidence(root);
		if (worktreeEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...worktreeEvidenceErrors.map((error) => `stage-5a evidence: ${error}`),
			);
		}
		const cutoverEvidenceErrors = await validateStageFiveBEvidence(root);
		if (cutoverEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...cutoverEvidenceErrors.map((error) => `stage-5b evidence: ${error}`),
			);
		}
		const doctorEvidenceErrors = await validateStageSixEvidence(root);
		if (doctorEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...doctorEvidenceErrors.map((error) => `stage-6 evidence: ${error}`),
			);
		}
		const ciEvidenceErrors = await validateStageSevenEvidence(root);
		if (ciEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...ciEvidenceErrors.map((error) => `stage-7 evidence: ${error}`),
			);
		}
		const graphEvidenceErrors = await validateStageEightAEvidence(root);
		if (graphEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...graphEvidenceErrors.map((error) => `stage-8a evidence: ${error}`),
			);
		}
		const affectedEvidenceErrors = await validateStageEightBEvidence(root);
		if (affectedEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...affectedEvidenceErrors.map((error) => `stage-8b evidence: ${error}`),
			);
		}
		const openspecEvidenceErrors = await validateStageNineEvidence(root);
		if (openspecEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...openspecEvidenceErrors.map((error) => `stage-9 evidence: ${error}`),
			);
		}
		const contractEvidenceErrors = await validateStageTenAEvidence(root);
		if (contractEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...contractEvidenceErrors.map(
					(error) => `stage-10a evidence: ${error}`,
				),
			);
		}
		const telemetryEvidenceErrors = await validateStageTenBEvidence(root);
		if (telemetryEvidenceErrors.length > 0) {
			report.status = "fail";
			report.errors.push(
				...telemetryEvidenceErrors.map(
					(error) => `stage-10b evidence: ${error}`,
				),
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
			`Validated ${report.parameterFile}, ${report.evidenceFile}, ${report.toolchainEvidenceFile}, ${report.imageEvidenceFile}, ${report.runtimeEvidenceFile}, ${report.cloudEvidenceFile}, ${report.worktreeEvidenceFile}, ${report.cutoverEvidenceFile}, ${report.doctorEvidenceFile}, ${report.ciEvidenceFile}, ${report.graphEvidenceFile}, ${report.affectedEvidenceFile}, ${report.openspecEvidenceFile}, ${report.contractEvidenceFile}, ${report.telemetryEvidenceFile}, and ${report.fixtures.length} fixtures.`,
		);
	} else {
		console.error(
			`Template parameter validation failed:\n- ${report.errors.join("\n- ")}`,
		);
	}
	process.exitCode = report.status === "pass" ? 0 : 1;
}
