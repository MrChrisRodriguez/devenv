import { chromium } from "@playwright/test";

const unknownArgument = process.argv
	.slice(2)
	.find((argument) => argument !== "--quiet");
if (unknownArgument) {
	console.error(`Usage: bun scripts/browser-preflight.ts [--quiet]`);
	process.exit(2);
}

const quiet = process.argv.includes("--quiet");
const startedAt = performance.now();
const expectedTitle = "devenv-browser-preflight";
const expectedBody = "repository browser payload is healthy";
const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
	`<!doctype html><html><head><title>${expectedTitle}</title></head><body><main>${expectedBody}</main></body></html>`,
)}`;

try {
	const payloadRoot = process.env.PLAYWRIGHT_BROWSERS_PATH?.replace(/\/+$/, "");
	let executablePath = chromium.executablePath();
	if (payloadRoot) {
		const candidates: string[] = [];
		for (const pattern of [
			"chromium_headless_shell-*/**/headless_shell",
			"chromium_headless_shell-*/**/chrome-headless-shell",
		]) {
			for await (const path of new Bun.Glob(pattern).scan({
				cwd: payloadRoot,
				onlyFiles: true,
			})) {
				candidates.push(`${payloadRoot}/${path}`);
			}
		}
		if (candidates.length !== 1 || !candidates[0]) {
			throw new Error(
				`expected one image-owned headless shell in ${payloadRoot}, found ${candidates.length}`,
			);
		}
		executablePath = candidates[0];
	}
	if (!(await Bun.file(executablePath).exists())) {
		throw new Error(
			`Playwright browser executable is missing: ${executablePath}`,
		);
	}

	const browser = await chromium.launch({ executablePath, headless: true });
	try {
		const page = await browser.newPage();
		try {
			await page.goto(documentUrl, { timeout: 15_000, waitUntil: "load" });
			const title = await page.title();
			const body = await page.locator("main").textContent();
			if (title !== expectedTitle || body !== expectedBody) {
				throw new Error(
					`unexpected document (title=${JSON.stringify(title)}, body=${JSON.stringify(body)})`,
				);
			}
		} finally {
			await page.close();
		}
	} finally {
		await browser.close();
	}

	if (!quiet) {
		console.log(
			`Browser preflight passed with the repository-pinned headless shell (${Math.round(performance.now() - startedAt)}ms).`,
		);
	}
} catch (error) {
	console.error(
		"Browser preflight failed: the repository-pinned headless shell could not launch and verify a local page.",
	);
	console.error(
		"Rebuild/recreate the browser-enabled environment; do not install a system browser or use an unpinned fallback.",
	);
	console.error(error);
	process.exit(1);
}
