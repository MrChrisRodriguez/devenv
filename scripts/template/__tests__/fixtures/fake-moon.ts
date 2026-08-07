// biome-ignore-all lint/complexity/useLiteralKeys: process.env is an index signature.
// A stand-in for the moon binary, so the live reconciliation leg can be proved
// hermetically.
//
// The oracle's second leg only means something if its FAILURE paths are
// executed, and every one of them is a property of what the binary does — a
// non-zero exit, silence, output that is not JSON, output that is JSON but not
// the expected shape, and three kinds of disagreement with the committed graph.
// None of those can be produced by running the real moon, so they are produced
// here and injected through MOON_BIN.
//
// This file also asserts the pinned argv: if the guard ever stops calling
// `moon query projects` exactly, every case below fails loudly instead of
// quietly testing a command nobody runs.

interface FakeProject {
	id: string;
	source: string;
	dependencies?: Array<{ id: string; scope: string; source: string }>;
}

// The graph a workspace with libs/ui and apps/web (depending on ui) really has,
// in the shape moon 2.3.5 prints: `dependencies` is present only when the
// project has any, and the top-level object also carries an `options` key the
// guard ignores.
const HEALTHY: FakeProject[] = [
	{ id: "root", source: "." },
	{ id: "ui", source: "libs/ui" },
	{
		id: "web",
		source: "apps/web",
		dependencies: [{ id: "ui", scope: "production", source: "explicit" }],
	},
];

function emit(projects: FakeProject[]): void {
	console.log(JSON.stringify({ projects, options: { affected: null } }));
}

const mode = process.env["FAKE_MOON_MODE"] ?? "healthy";
const argv = process.argv.slice(2);
if (argv.join(" ") !== "query projects") {
	console.error(`fake-moon: unexpected argv ${JSON.stringify(argv)}`);
	process.exit(2);
}

// An if-chain rather than a switch: two of these arms end in process.exit, and
// a `switch` case that exits is either unreachable-after-break (which the
// compiler rejects) or a fallthrough (which the linter rejects). The chain has
// neither problem and reads the same.
if (mode === "healthy") emit(HEALTHY);
else if (mode === "failure") {
	console.error("fake-moon: the workspace could not be loaded");
	process.exit(1);
} else if (mode === "silent") {
	// Exit 0 having printed nothing at all.
} else if (mode === "not-json") console.log("moon is thinking about it");
else if (mode === "unexpected-shape")
	console.log(JSON.stringify({ projects: [{ source: "libs/ui" }] }));
else if (mode === "extra-project")
	emit([...HEALTHY, { id: "ghost", source: "apps/ghost" }]);
else if (mode === "missing-project")
	emit(HEALTHY.filter((project) => project.id !== "ui"));
else if (mode === "unknown-edge")
	emit(
		HEALTHY.map((project) =>
			project.id === "web"
				? {
						...project,
						dependencies: [
							...(project.dependencies ?? []),
							{ id: "root", scope: "production", source: "explicit" },
						],
					}
				: project,
		),
	);
else if (mode === "missing-edge")
	emit(
		HEALTHY.map((project) =>
			project.id === "web"
				? { id: project.id, source: project.source }
				: project,
		),
	);
else {
	console.error(`fake-moon: unknown mode ${mode}`);
	process.exit(3);
}
