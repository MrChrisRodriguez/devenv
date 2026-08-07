export interface RecordedRequest {
	method: string;
	host: string;
	path: string;
}

export interface Recorder {
	/** The origin an injected uploader is pointed at. */
	origin: string;
	port: number;
	/**
	 * Every request the recorder observed, including ones no allowlist permits.
	 *
	 * Read this BEFORE teardown. A probe that reads its facts after a later step
	 * has undone them reports a completely correct run as a failure, or worse —
	 * and "the recorder saw nothing" and "the recorder was already gone" produce
	 * the same empty array.
	 */
	requests: () => RecordedRequest[];
	/** What a readback finds. Empty is a 404, which is a failed final state. */
	finalState: (value: string) => void;
	stop: () => Promise<void>;
}

/**
 * A loopback request recorder, invented rather than ported.
 *
 * The reference implementation has no recorder, no interceptor and no fetch
 * wrapper of any kind — verified across its whole tree — so the spec's "the
 * request-recorder test observes zero calls" has nothing to copy. Two
 * properties are designed in rather than added later.
 *
 * It binds `127.0.0.1:0` and the ephemeral port is INJECTED into whatever it is
 * testing, so no run ever races a fixed port. Environment assumptions pass on a
 * laptop and fail inside a container, and this repository has paid for that
 * lesson once already.
 *
 * And it records EVERY request, including ones to hosts no allowlist permits.
 * That is what lets one fixture assert both halves of the allowlist rule: that
 * a permitted write reached its host, and that a refused one never opened a
 * socket at all.
 */
export async function startRecorder(
	options: { finalState?: string } = {},
): Promise<Recorder> {
	const seen: RecordedRequest[] = [];
	let state = options.finalState ?? "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			seen.push({
				method: request.method,
				host: url.host,
				path: url.pathname,
			});
			if (request.method === "GET")
				return new Response(state, { status: state === "" ? 404 : 200 });
			return new Response("", { status: 201 });
		},
	});
	// The bound port, read back from the server rather than assumed. Binding
	// `:0` and then injecting what the kernel handed out is what keeps two runs
	// on one machine from racing each other for a fixed number.
	const port = server.port ?? 0;
	if (port === 0) throw new Error("the recorder did not bind a port");
	return {
		origin: `http://127.0.0.1:${port}`,
		port,
		requests: () => [...seen],
		finalState: (value) => {
			state = value;
		},
		stop: async () => {
			await server.stop(true);
		},
	};
}
