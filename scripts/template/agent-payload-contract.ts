// biome-ignore-all lint/complexity/useLiteralKeys: Contract records intentionally use dynamic JSON keys.
import { dirname, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const EFFECTIVE_SKILL_ROOTS = {
	claude: [".claude/skills", ".agents/skills"],
	codex: [".codex/skills", ".agents/skills"],
	gemini: [".gemini/skills", ".agents/skills"],
} as const;

export interface DiscoveredSkill {
	agent: keyof typeof EFFECTIVE_SKILL_ROOTS;
	name: string;
	path: string;
	root: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<JsonRecord> {
	const value = (await Bun.file(path).json()) as unknown;
	if (!isRecord(value)) throw new Error(`${path} must contain an object`);
	return value;
}

function skillName(source: string, path: string): string {
	const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(source)?.[1];
	const declared = frontmatter
		? /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim()
		: undefined;
	return declared || dirname(path).split("/").at(-1) || "";
}

export async function discoverEffectiveSkills(
	root: string,
): Promise<DiscoveredSkill[]> {
	const discovered: DiscoveredSkill[] = [];
	for (const [agent, roots] of Object.entries(EFFECTIVE_SKILL_ROOTS) as Array<
		[keyof typeof EFFECTIVE_SKILL_ROOTS, readonly string[]]
	>) {
		for (const skillRoot of roots) {
			for await (const path of new Bun.Glob(`${skillRoot}/**/SKILL.md`).scan({
				cwd: root,
				dot: true,
				onlyFiles: true,
			})) {
				discovered.push({
					agent,
					name: skillName(await Bun.file(resolve(root, path)).text(), path),
					path,
					root: skillRoot,
				});
			}
		}
	}
	return discovered.sort((left, right) =>
		`${left.agent}:${left.name}:${left.path}`.localeCompare(
			`${right.agent}:${right.name}:${right.path}`,
		),
	);
}

export async function validateSkillDiscovery(
	root: string,
	graphifyEnabled: boolean,
): Promise<string[]> {
	const errors: string[] = [];
	const discovered = await discoverEffectiveSkills(root);
	for (const agent of Object.keys(EFFECTIVE_SKILL_ROOTS) as Array<
		keyof typeof EFFECTIVE_SKILL_ROOTS
	>) {
		const byName = new Map<string, string[]>();
		for (const skill of discovered.filter((entry) => entry.agent === agent)) {
			const normalized = skill.name.toLowerCase();
			byName.set(normalized, [...(byName.get(normalized) ?? []), skill.path]);
		}
		for (const [name, paths] of byName) {
			if (paths.length > 1)
				errors.push(
					`agents: ${agent} discovers duplicate skill ${name}: ${paths.sort().join(", ")}`,
				);
		}
	}
	const graphifyOwners = new Map(
		discovered
			.filter((skill) => skill.name.toLowerCase() === "graphify")
			.map((skill) => [`${skill.agent}:${skill.path}`, skill]),
	);
	if (graphifyEnabled)
		for (const [agent, path] of [
			["claude", ".claude/skills/graphify/SKILL.md"],
			["codex", ".codex/skills/graphify/SKILL.md"],
			["gemini", ".gemini/skills/graphify/SKILL.md"],
		] as const) {
			if (!graphifyOwners.has(`${agent}:${path}`))
				errors.push(`agents: ${agent} Graphify skill must be owned by ${path}`);
		}
	else if (graphifyOwners.size > 0)
		errors.push("agents: disabled Graphify leaves skill discovery residue");
	if (
		discovered.some((skill) =>
			skill.path.startsWith(".agents/skills/graphify/"),
		)
	)
		errors.push(
			"agents: shared .agents/skills/graphify duplicates agent-specific discovery",
		);
	return errors;
}

function argValues(source: string): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (const match of source.matchAll(/^ARG\s+([A-Z0-9_]+)=([^\s#]+)\s*$/gm)) {
		if (!match[1] || !match[2]) continue;
		values.set(match[1], [...(values.get(match[1]) ?? []), match[2]]);
	}
	return values;
}

function hasStage(source: string, stage: string): boolean {
	return new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage}\\s*$`, "m").test(source);
}

function oneArg(
	args: Map<string, string[]>,
	name: string,
	pattern: RegExp,
	errors: string[],
): string {
	const values = args.get(name) ?? [];
	if (values.length !== 1 || !pattern.test(values[0] ?? "")) {
		errors.push(`agents: ${name} must have one immutable Docker authority`);
		return "";
	}
	return values[0] ?? "";
}

async function validateGeminiWatchdogContract(
	root: string,
	dockerfile: string,
): Promise<string[]> {
	const errors: string[] = [];
	const setupPath = resolve(root, ".devcontainer/on-create/setup-gemini.sh");
	const watchdogPath = resolve(root, ".devcontainer/configs/gemini-watchdog");
	const enabled = await Bun.file(setupPath).exists();
	const watchdogExists = await Bun.file(watchdogPath).exists();
	if (!enabled) {
		if (watchdogExists)
			errors.push("agents: disabled Gemini leaves its watchdog source");
		return errors;
	}
	if (!watchdogExists) {
		errors.push("agents: enabled Gemini omits its watchdog source");
		return errors;
	}

	const watchdog = await Bun.file(watchdogPath).text();
	if (!watchdog.startsWith("#!/home/vscode/.proto/shims/bun\n"))
		errors.push("agents: Gemini watchdog must use the Proto-managed Bun shim");
	for (const [token, label] of [
		["/home/vscode/.payloads/gemini/bin/gemini", "absolute real payload"],
		["GEMINI_WATCHDOG_BYPASS", "explicit bypass"],
		["GEMINI_WATCHDOG_IDLE_SECONDS", "configurable idle bound"],
		["GEMINI_WATCHDOG_TERM_GRACE_SECONDS", "configurable TERM grace bound"],
		["GEMINI_WATCHDOG_MAX_PARTIAL_BYTES", "bounded partial-line memory"],
		['"--output-format", "stream-json"', "stream-json headless mode"],
		["detached: true", "dedicated child process group"],
		["process.kill(-pid", "full process-group signalling"],
		['"SIGTERM"', "TERM escalation"],
		['"SIGKILL"', "KILL escalation"],
		["return 124", "timeout exit 124"],
		["errorCode: 127", "missing-binary exit 127"],
		["pending.length >= maxPartialBytes", "bounded partial-line decoder"],
	] as const) {
		if (!watchdog.includes(token))
			errors.push(`agents: Gemini watchdog omits ${label}`);
	}
	if (
		!watchdog.includes("hasExplicitOutputFormat") ||
		!watchdog.includes("hasInteractivePrompt") ||
		!watchdog.includes("hasHeadlessPrompt") ||
		!watchdog.includes("process.stdin.isTTY === true")
	)
		errors.push("agents: Gemini watchdog omits pass-through classification");
	if (watchdog.includes("GEMINI_WATCHDOG_REAL_BINARY"))
		errors.push("agents: Gemini watchdog must not permit payload substitution");
	if (!watchdog.includes('sanitizeText(event["content"]'))
		errors.push("agents: Gemini watchdog omits assistant-output sanitization");

	const wrapperCopy =
		"COPY --link --chown=1000:1000 --chmod=0755 .devcontainer/configs/gemini-watchdog /home/vscode/.local/bin/gemini";
	if (!dockerfile.split("\n").includes(wrapperCopy))
		errors.push(
			"agents: Dockerfile must install the Gemini watchdog at /home/vscode/.local/bin/gemini",
		);
	if (
		/ln\s+-s[^\n]*\.payloads\/gemini\/bin\/gemini[^\n]*\.local\/bin\/gemini/.test(
			dockerfile,
		)
	)
		errors.push("agents: real Gemini payload must not shadow its watchdog");

	const setup = await Bun.file(setupPath).text();
	for (const token of [
		'gemini_wrapper="$HOME/.local/bin/gemini"',
		'gemini_binary="$HOME/.payloads/gemini/bin/gemini"',
		'cmp -s "$gemini_wrapper_source" "$gemini_wrapper"',
		'"$gemini_wrapper" --version',
	]) {
		if (!setup.includes(token))
			errors.push("agents: setup-gemini must verify watchdog and real payload");
	}

	const ownershipPath = resolve(
		root,
		"docs/devcontainer-upgrade/stage-0/template-ownership.json",
	);
	if (await Bun.file(ownershipPath).exists()) {
		const ownership = await readJson(ownershipPath);
		const artifactRules = Array.isArray(ownership["artifactRules"])
			? ownership["artifactRules"]
			: [];
		const watchdogRule = artifactRules.find(
			(rule) =>
				isRecord(rule) &&
				rule["pattern"] === ".devcontainer/configs/gemini-watchdog",
		);
		if (
			!isRecord(watchdogRule) ||
			!Array.isArray(watchdogRule["requiresAll"]) ||
			JSON.stringify(watchdogRule["requiresAll"]) !== '["gemini"]'
		)
			errors.push("agents: Gemini watchdog ownership must require Gemini");
	}

	return errors;
}

// capability:start context7
async function validateMcpConfig(
	root: string,
	path: string,
	context7Enabled: boolean,
	errors: string[],
): Promise<void> {
	const settings = await readJson(resolve(root, path));
	const servers = isRecord(settings["mcpServers"])
		? settings["mcpServers"]
		: {};
	const context7 = isRecord(servers["context7"])
		? servers["context7"]
		: undefined;
	if (!context7Enabled) {
		if (context7) errors.push(`agents: disabled Context7 remains in ${path}`);
		return;
	}
	if (!context7) {
		errors.push(`agents: enabled Context7 is missing from ${path}`);
		return;
	}
	if (
		context7["command"] !== "context7-mcp" ||
		!Array.isArray(context7["args"]) ||
		context7["args"].length !== 0
	)
		errors.push(
			`agents: ${path} must invoke the image-owned Context7 launcher`,
		);
}
// capability:end context7

export async function validateAgentShellPaths(root: string): Promise<string[]> {
	const errors: string[] = [];
	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const shellCommon = await Bun.file(
		resolve(root, ".devcontainer/configs/.shell_common"),
	).text();
	const setupCommon = await Bun.file(
		resolve(root, ".devcontainer/on-create/setup-common.sh"),
	).text();
	const devcontainer = await readJson(
		resolve(root, ".devcontainer/devcontainer.json"),
	);
	const homePrefix =
		"/workspace/node_modules/.bin:$HOME/.proto/shims:$HOME/.proto/bin:$HOME/.local/bin:$PATH";
	const absolutePrefix =
		"/workspace/node_modules/.bin:/home/vscode/.proto/shims:/home/vscode/.proto/bin:/home/vscode/.local/bin:";
	for (const [shellCase, source] of [
		["bash login", dockerfile],
		["zsh login", dockerfile],
		["bash non-login", shellCommon],
		["zsh non-login", shellCommon],
		["on-create", setupCommon],
	] as const) {
		if (!source.includes(homePrefix))
			errors.push(
				`agents: ${shellCase} PATH must prefer workspace and Proto before image launchers`,
			);
	}
	const remoteEnv = isRecord(devcontainer["remoteEnv"])
		? devcontainer["remoteEnv"]
		: {};
	if (
		typeof remoteEnv["PATH"] !== "string" ||
		!remoteEnv["PATH"].startsWith(absolutePrefix)
	)
		errors.push(
			"agents: editor PATH must prefer workspace and Proto before image launchers",
		);
	return errors;
}

export async function validateAgentPayloadContract(
	root: string,
): Promise<string[]> {
	const dockerfile = await Bun.file(
		resolve(root, ".devcontainer/Dockerfile"),
	).text();
	const graphifyEnabled = await Bun.file(
		resolve(root, ".devcontainer/on-create/setup-graphify.sh"),
	).exists();
	const errors = await validateSkillDiscovery(root, graphifyEnabled);
	errors.push(...(await validateAgentShellPaths(root)));
	const args = argValues(dockerfile);
	errors.push(...(await validateGeminiWatchdogContract(root, dockerfile)));
	const capabilities = [
		{
			capability: "codex",
			stage: "codex_payload",
			version: "CODEX_VERSION",
			launcher: "codex",
		},
		{
			capability: "gemini",
			stage: "gemini_payload",
			version: "GEMINI_VERSION",
			launcher: "gemini",
		},
		{
			capability: "graphify",
			stage: "graphify_payload",
			version: "GRAPHIFY_VERSION",
			launcher: "graphify",
		},
		{
			capability: "ccstatusline",
			stage: "ccstatusline_payload",
			version: "CCSTATUSLINE_VERSION",
			launcher: "ccstatusline",
		},
		{
			capability: "claude",
			stage: "claude_payload",
			version: "CLAUDE_VERSION",
			launcher: "claude",
		},
		// capability:start context7
		{
			capability: "context7",
			stage: "context7_payload",
			version: "CONTEXT7_VERSION",
			launcher: "context7-mcp",
		},
		// capability:end context7
	] as const;
	for (const payload of capabilities) {
		const setup = resolve(
			root,
			`.devcontainer/on-create/setup-${payload.capability}.sh`,
		);
		const enabled = await Bun.file(setup).exists();
		if (!enabled) {
			if (hasStage(dockerfile, payload.stage))
				errors.push(
					`agents: disabled ${payload.capability} leaves image stage ${payload.stage}`,
				);
			continue;
		}
		if (!hasStage(dockerfile, payload.stage))
			errors.push(
				`agents: enabled ${payload.capability} omits image stage ${payload.stage}`,
			);
		oneArg(args, payload.version, EXACT_VERSION, errors);
		if (!dockerfile.includes(`/bin/${payload.launcher}`))
			errors.push(
				`agents: enabled ${payload.capability} omits launcher ${payload.launcher}`,
			);
	}

	for (const sourcePayload of [
		// capability:start claude_octopus
		{
			capability: "claude-octopus",
			setup: "setup-claude-octopus.sh",
			stage: "octopus_payload",
			owner: "OCTOPUS",
			requiresSkillCollisionGuard: true,
		},
		// capability:end claude_octopus
		// capability:start claude_warp
		{
			capability: "claude-warp",
			setup: "setup-claude-warp.sh",
			stage: "warp_payload",
			owner: "WARP",
			requiresSkillCollisionGuard: false,
		},
		// capability:end claude_warp
	] as const) {
		const setupPath = resolve(
			root,
			".devcontainer/on-create",
			sourcePayload.setup,
		);
		const enabled = await Bun.file(setupPath).exists();
		if (!enabled) {
			if (hasStage(dockerfile, sourcePayload.stage))
				errors.push(
					`agents: disabled ${sourcePayload.capability} leaves image stage ${sourcePayload.stage}`,
				);
			continue;
		}
		if (!hasStage(dockerfile, sourcePayload.stage))
			errors.push(
				`agents: enabled ${sourcePayload.capability} omits image stage ${sourcePayload.stage}`,
			);
		oneArg(args, `${sourcePayload.owner}_COMMIT`, COMMIT, errors);
		oneArg(args, `${sourcePayload.owner}_SHA256`, SHA256, errors);
		if (
			!dockerfile.includes(
				`archive/\${${sourcePayload.owner}_COMMIT}.tar.gz`,
			) ||
			!dockerfile.includes(`"$${sourcePayload.owner}_SHA256"`)
		)
			errors.push(
				`agents: ${sourcePayload.owner} download must use its commit and checksum authorities`,
			);
		const setup = await Bun.file(setupPath).text();
		if (/https?:\/\/|\bgit\s+clone\b|\bbunx?\s+(?:add|install)\b/.test(setup))
			errors.push(
				`agents: ${sourcePayload.setup} contains a floating runtime fetch`,
			);
		if (!setup.includes("timeout 30s claude plugin"))
			errors.push(
				`agents: ${sourcePayload.setup} must bound local plugin registration`,
			);
		if (/^\s*timeout 30s claude plugin/m.test(setup))
			errors.push(
				`agents: ${sourcePayload.setup} must fail closed on registration errors`,
			);
		if (
			!setup.includes('.source == "directory"') ||
			!setup.includes(".path == $path") ||
			!setup.includes("cmp -s") ||
			!setup.includes("$install_path/.devenv-source")
		)
			errors.push(
				`agents: ${sourcePayload.setup} must verify local marketplace and installed source authorities`,
			);
		if (
			sourcePayload.requiresSkillCollisionGuard &&
			(!setup.includes("/workspace/.codex/skills") ||
				!setup.includes("/workspace/.agents/skills") ||
				!setup.includes("$HOME/.agents/skills"))
		)
			errors.push(
				`agents: ${sourcePayload.setup} must reject project/shared skill collisions`,
			);
		if (sourcePayload.requiresSkillCollisionGuard) {
			const legacyIndex = setup.indexOf(
				'legacy_skills="$HOME/.agents/skills/claude-octopus"',
			);
			const collisionIndex = setup.indexOf(
				'for skill_file in "$OCTOPUS_DIR"/skills/*/SKILL.md',
			);
			if (legacyIndex < 0 || collisionIndex < 0 || legacyIndex > collisionIndex)
				errors.push(
					`agents: ${sourcePayload.setup} must remove the exact legacy link before collision checks`,
				);
		}
	}

	// capability:start context7
	const context7Enabled = hasStage(dockerfile, "context7_payload");
	await validateMcpConfig(
		root,
		".claude/settings.json",
		context7Enabled,
		errors,
	);
	await validateMcpConfig(root, ".cursor/mcp.json", context7Enabled, errors);
	// capability:end context7
	for (const path of [
		".devcontainer/on-create/setup-claude.sh",
		// capability:start context7
		".devcontainer/on-create/setup-context7.sh",
		// capability:end context7
	]) {
		const file = Bun.file(resolve(root, path));
		if (!(await file.exists())) continue;
		// capability:start context7
		if (
			/\bbunx\s+@upstash\/context7-mcp|\bclaude\s+mcp\s+add\b/.test(
				await file.text(),
			)
		)
			errors.push(`agents: ${path} retains floating Context7 registration`);
		// capability:end context7
	}

	const devcontainer = await readJson(
		resolve(root, ".devcontainer/devcontainer.json"),
	);
	const containerEnv = isRecord(devcontainer["containerEnv"])
		? devcontainer["containerEnv"]
		: {};
	for (const name of [
		"DISABLE_AUTOUPDATER",
		"DISABLE_ERROR_REPORTING",
		"DISABLE_NON_ESSENTIAL_MODEL_CALLS",
		"DISABLE_TELEMETRY",
		"DO_NOT_TRACK",
	]) {
		if (containerEnv[name] !== "1")
			errors.push(`agents: unattended environment must set ${name}=1`);
	}

	const renovate = await readJson(resolve(root, "renovate.json"));
	const managers = Array.isArray(renovate["customManagers"])
		? renovate["customManagers"]
		: [];
	const matchStrings = managers.flatMap((manager) =>
		isRecord(manager) && Array.isArray(manager["matchStrings"])
			? manager["matchStrings"].filter(
					(pattern): pattern is string => typeof pattern === "string",
				)
			: [],
	);
	for (const owner of [
		// capability:start context7
		{
			name: "CONTEXT7_VERSION",
			stage: "context7_payload",
			snippet:
				/# renovate: datasource=npm depName=@upstash\/context7-mcp\nARG CONTEXT7_VERSION=\S+\n/.exec(
					dockerfile,
				)?.[0] ?? "",
		},
		// capability:end context7
		// capability:start claude_octopus
		{
			name: "OCTOPUS_COMMIT",
			stage: "octopus_payload",
			snippet:
				/# renovate: datasource=git-refs depName=nyldn\/claude-octopus packageName=https:\/\/github.com\/nyldn\/claude-octopus.git\nARG OCTOPUS_COMMIT=\S+\n/.exec(
					dockerfile,
				)?.[0] ?? "",
		},
		// capability:end claude_octopus
		// capability:start claude_warp
		{
			name: "WARP_COMMIT",
			stage: "warp_payload",
			snippet:
				/# renovate: datasource=git-refs depName=warpdotdev\/claude-code-warp packageName=https:\/\/github.com\/warpdotdev\/claude-code-warp.git\nARG WARP_COMMIT=\S+\n/.exec(
					dockerfile,
				)?.[0] ?? "",
		},
		// capability:end claude_warp
	]) {
		if (!hasStage(dockerfile, owner.stage)) continue;
		if (
			!matchStrings.some((pattern) =>
				new RegExp(pattern, "m").test(owner.snippet),
			)
		)
			errors.push(`agents: Renovate does not own ${owner.name}`);
	}

	return [...new Set(errors)].sort();
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const errors = await validateAgentPayloadContract(root);
	if (errors.length > 0) {
		for (const error of errors) console.error(error);
		process.exit(1);
	}
	console.log(
		"Validated exact agent payloads, bounded local registration, shell PATHs, and unique effective skill discovery.",
	);
}
