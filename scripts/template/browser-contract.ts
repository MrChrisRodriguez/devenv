// biome-ignore-all lint/complexity/useLiteralKeys: Contract records use dynamic keys.
import { resolve } from "node:path";
import { resolvedOccurrences, resolvedVersions } from "./toolchain";

type JsonRecord = Record<string, unknown>;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_BROWSER_LIBRARIES = [
	"fonts-freefont-ttf",
	"fonts-ipafont-gothic",
	"fonts-liberation",
	"fonts-noto-color-emoji",
	"fonts-tlwg-loma-otf",
	"fonts-unifont",
	"fonts-wqy-zenhei",
	"libasound2t64",
	"libatk-bridge2.0-0t64",
	"libatk1.0-0t64",
	"libatspi2.0-0t64",
	"libcairo2",
	"libcups2t64",
	"libdbus-1-3",
	"libdrm2",
	"libfontconfig1",
	"libfreetype6",
	"libgbm1",
	"libglib2.0-0t64",
	"libnspr4",
	"libnss3",
	"libpango-1.0-0",
	"libx11-6",
	"libxcb1",
	"libxcomposite1",
	"libxdamage1",
	"libxext6",
	"libxfixes3",
	"libxkbcommon0",
	"libxrandr2",
] as const;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord {
	const entry = value[key];
	return isRecord(entry) ? entry : {};
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	if (!isRecord(value)) throw new Error(`${path} must contain an object`);
	return value;
}

function stageBody(source: string, name: string): string | undefined {
	const stages = [
		...source.matchAll(/^FROM\s+[^\s]+\s+AS\s+([a-z0-9_]+)\s*$/gim),
	];
	const index = stages.findIndex((match) => match[1]?.toLowerCase() === name);
	if (index < 0) return undefined;
	const start = (stages[index]?.index ?? 0) + (stages[index]?.[0].length ?? 0);
	const end = stages[index + 1]?.index ?? source.length;
	return source.slice(start, end);
}

function commandText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(String).join(" ");
	return "";
}

export async function validateBrowserContract(
	root = resolve(import.meta.dir, "../.."),
): Promise<string[]> {
	const errors: string[] = [];
	const packageJson = await readJson(resolve(root, "package.json"));
	const catalog = recordAt(recordAt(packageJson, "workspaces"), "catalog");
	const devDependencies = recordAt(packageJson, "devDependencies");
	const scripts = recordAt(packageJson, "scripts");
	const packagePin = catalog["@playwright/test"];
	const supported = packagePin !== undefined;
	const parameterPath = resolve(root, "template-parameters.toml");
	const templateSource = await Bun.file(parameterPath).exists();
	const selected = templateSource
		? recordAt(
				recordAt(
					Bun.TOML.parse(await Bun.file(parameterPath).text()) as JsonRecord,
					"capabilities",
				),
				"defaults",
			)["playwright"] === true
		: supported;
	const dockerfilePath = resolve(root, ".devcontainer/Dockerfile");
	const dockerfile = await Bun.file(dockerfilePath).text();
	const devcontainer = await readJson(
		resolve(root, ".devcontainer/devcontainer.json"),
	);
	const build = recordAt(devcontainer, "build");
	const preflightPath = resolve(root, "scripts/browser-preflight.ts");
	const guardPath = resolve(root, "scripts/template/validate-browser.ts");
	const contractPath = resolve(root, "scripts/template/browser-contract.ts");

	if (!supported) {
		for (const [path, label] of [
			[preflightPath, "browser preflight"],
			[guardPath, "browser guard entrypoint"],
			[contractPath, "browser contract"],
		] as const) {
			if (await Bun.file(path).exists())
				errors.push(`browser: disabled capability leaves ${label}`);
		}
		if (devDependencies["@playwright/test"] !== undefined)
			errors.push("browser: disabled capability leaves @playwright/test");
		if (
			scripts["browser:check"] !== undefined ||
			scripts["browser:preflight"] !== undefined
		)
			errors.push("browser: disabled capability leaves package scripts");
		if (/playwright|browser-preflight/i.test(dockerfile))
			errors.push("browser: disabled capability leaves image payload residue");
		if (
			commandText(devcontainer["postCreateCommand"]).includes(
				"browser:preflight",
			)
		)
			errors.push("browser: disabled capability leaves post-create preflight");
		if (build["target"] !== "development")
			errors.push(
				"browser: disabled capability must select development target",
			);
		return errors;
	}

	if (typeof packagePin !== "string" || !EXACT_VERSION.test(packagePin))
		errors.push("browser: package catalog pin must be exact");
	if (devDependencies["@playwright/test"] !== "catalog:")
		errors.push("browser: @playwright/test must consume the catalog pin");
	if (scripts["browser:check"] !== "bun scripts/template/validate-browser.ts")
		errors.push("browser: package script must expose the dedicated pin guard");
	if (scripts["browser:preflight"] !== "bun scripts/browser-preflight.ts")
		errors.push("browser: package script must expose the runtime preflight");

	const lockPath = resolve(root, "bun.lock");
	if (!(await Bun.file(lockPath).exists())) {
		errors.push("browser: bun.lock is missing");
	} else if (typeof packagePin === "string") {
		const lock = await Bun.file(lockPath).text();
		for (const packageName of [
			"@playwright/test",
			"playwright",
			"playwright-core",
		]) {
			const occurrences = resolvedOccurrences(lock, packageName);
			const versions = resolvedVersions(lock, packageName);
			if (occurrences.length !== 1 || versions[0] !== packagePin) {
				errors.push(
					`browser: ${packageName} must resolve once at ${packagePin} (found ${versions.join(", ") || "none"})`,
				);
			}
		}
	}

	const dockerPins = [
		...dockerfile.matchAll(/^ARG PLAYWRIGHT_VERSION=([^\s#]+)\s*$/gm),
	].flatMap((match) => (match[1] ? [match[1]] : []));
	if (dockerPins.length !== 1 || dockerPins[0] !== packagePin)
		errors.push("browser: Docker pin must equal the package catalog pin");
	const payloadStage = stageBody(dockerfile, "playwright_browser") ?? "";
	const runtimeStage = stageBody(dockerfile, "development_browser") ?? "";
	if (!payloadStage)
		errors.push("browser: isolated Playwright payload stage is missing");
	if (!runtimeStage)
		errors.push("browser: isolated browser runtime stage is missing");
	if (!payloadStage.includes("playwright@" + "$" + "{PLAYWRIGHT_VERSION}"))
		errors.push("browser: image installer does not consume the Docker pin");
	if (!payloadStage.includes("install --only-shell chromium"))
		errors.push("browser: image must install only the Chromium headless shell");
	if (!payloadStage.includes("ffmpeg"))
		errors.push("browser: image payload does not verify baked FFmpeg");
	if (!payloadStage.includes("headless_shell"))
		errors.push("browser: image payload does not verify the headless shell");
	if (!runtimeStage.includes("--from=playwright_browser"))
		errors.push("browser: runtime stage does not assemble the pinned payload");
	for (const library of REQUIRED_BROWSER_LIBRARIES) {
		if (!runtimeStage.includes(`\n\t\t${library}`))
			errors.push(`browser: runtime stage omits ${library}`);
	}

	if (!(await Bun.file(preflightPath).exists())) {
		errors.push("browser: repository-local preflight is missing");
	} else {
		const preflight = await Bun.file(preflightPath).text();
		for (const [token, label] of [
			["chromium.launch", "launch"],
			["page.goto", "page load"],
			["page.title", "title verification"],
			['locator("main").textContent', "content verification"],
			["page.close", "page close"],
			["browser.close", "browser close"],
			["PLAYWRIGHT_BROWSERS_PATH", "payload ownership"],
		] as const) {
			if (!preflight.includes(token))
				errors.push(`browser: preflight omits ${label}`);
		}
		if (/https?:\/\//.test(preflight))
			errors.push(
				"browser: preflight must not require external network access",
			);
	}

	const expectedTarget = selected ? "development_browser" : "development";
	if (build["target"] !== expectedTarget)
		errors.push(`browser: selected profile must target ${expectedTarget}`);
	const postCreate = commandText(devcontainer["postCreateCommand"]);
	if (selected && !postCreate.includes("bun run browser:preflight"))
		errors.push("browser: selected profile omits post-create preflight");
	if (!selected && postCreate.includes("browser:preflight"))
		errors.push("browser: unselected profile runs post-create preflight");

	return errors;
}
