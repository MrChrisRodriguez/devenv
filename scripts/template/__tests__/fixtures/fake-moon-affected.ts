// biome-ignore-all lint/complexity/useLiteralKeys: process.env is an index signature.
// A stand-in for the moon binary, so the affected reconciliation leg can be
// proved hermetically.
//
// The leg is only worth having if its FAILURE paths are executed, and every one
// of them is a property of what the binary does — a non-zero exit, silence,
// output that is not JSON, output that is JSON in an unexpected shape, a set
// narrower than ours, and a set wider than ours. None can be produced by
// running the real moon against a healthy workspace, so they are produced here
// and injected through MOON_BIN.
//
// This file also asserts the pinned argv and the two things the leg promises
// about HOW it calls moon: a non-empty file list on stdin (empty stdin makes
// the real binary answer from the working tree instead), and MOON_BASE/MOON_HEAD
// carrying the resolved merge base and head so a stacked pull request is never
// diffed against the default branch.

export {};

const argv = process.argv.slice(2);
if (argv.join(" ") !== "query projects --affected --downstream deep --quiet") {
	console.error(`fake-moon-affected: unexpected argv ${JSON.stringify(argv)}`);
	process.exit(2);
}

const stdin = await Bun.stdin.text();
const files = stdin.split("\n").filter((line) => line !== "");
if (files.length === 0) {
	console.error("fake-moon-affected: refused an empty changed-file list");
	process.exit(3);
}

// Recorded rather than asserted, so a test can make an assertion about the
// invocation without this file having to know which one.
const record = process.env["FAKE_MOON_RECORD"];
if (record)
	await Bun.write(
		record,
		`${JSON.stringify({
			argv,
			files,
			base: process.env["MOON_BASE"] ?? null,
			head: process.env["MOON_HEAD"] ?? null,
		})}\n`,
	);

// The project each seed file belongs to, derived the way moon does it: the
// deepest declared source containing the path. The list mirrors the synthetic
// workspace the tests build.
const SOURCES: Array<{ id: string; source: string }> = [
	{ id: "root", source: "." },
	{ id: "base", source: "libs/base" },
	{ id: "ui", source: "libs/ui" },
	{ id: "web", source: "apps/web" },
	{ id: "admin", source: "apps/admin" },
];
const DEPENDENTS: Record<string, string[]> = {
	base: ["ui", "web"],
	ui: ["web"],
};

function affected(): string[] {
	const found = new Set<string>();
	for (const file of files) {
		let best: { id: string; source: string } | undefined;
		for (const entry of SOURCES) {
			const contains =
				entry.source === "." ||
				file === entry.source ||
				file.startsWith(`${entry.source}/`);
			if (!contains) continue;
			if (!best || entry.source.length > best.source.length) best = entry;
		}
		if (!best) continue;
		found.add(best.id);
		for (const dependent of DEPENDENTS[best.id] ?? []) found.add(dependent);
	}
	// Moon reports the repository-wide project for every change; the leg is
	// required to exclude it, and it can only prove that if it is here.
	found.add("root");
	return [...found].sort();
}

function emit(ids: string[]): void {
	console.log(
		JSON.stringify({
			projects: ids.map((id) => ({
				id,
				source: SOURCES.find((entry) => entry.id === id)?.source ?? id,
			})),
			options: { affected: {} },
		}),
	);
}

const mode = process.env["FAKE_MOON_AFFECTED_MODE"] ?? "agree";

// An if-chain rather than a switch: several arms end in process.exit, and a
// `switch` case that exits is either unreachable-after-break or a fallthrough.
if (mode === "agree") emit(affected());
else if (mode === "failure") {
	console.error("fake-moon-affected: the workspace could not be loaded");
	process.exit(1);
} else if (mode === "silent") {
	// Exit 0 having printed nothing at all.
} else if (mode === "not-json") console.log("moon is thinking about it");
else if (mode === "unexpected-shape")
	console.log(JSON.stringify({ projects: [{ source: "libs/ui" }] }));
else if (mode === "no-projects-key")
	console.log(JSON.stringify({ options: {} }));
else if (mode === "narrower")
	emit(affected().filter((id) => id === "root" || id === affected()[0]));
else if (mode === "wider") emit([...affected(), "admin"].sort());
else if (mode === "only-root") emit(["root"]);
else {
	console.error(`fake-moon-affected: unknown mode ${mode}`);
	process.exit(4);
}
