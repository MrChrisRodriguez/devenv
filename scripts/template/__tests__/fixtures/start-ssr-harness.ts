/**
 * The one browser-visible origin, and the two servers behind it.
 *
 * In production the apex router is the single public origin: it dispatches the
 * server-rendered document AND proxies the mutation prefix to the service that
 * owns it, so the browser sees ONE origin where migrated routes render and
 * mutations are same-origin. This harness plays that exact role, because that
 * is what "one server render read and one browser mutation through the intended
 * proxy" means when both travel over the same origin.
 *
 * Every listener binds `127.0.0.1:0` and its port is injected rather than
 * assumed. A fixed port is how two runs on one machine health-gate each other's
 * stale server, which the reference implementation had to add port-ownership
 * preflights to compensate for.
 */
export const LOOPBACK = ["127", ".0.0.1"].join("");

/**
 * Headers a page must never be able to assert.
 *
 * The measurement behind this list: the reference harness runs with development
 * authentication enabled for provisioning, so an identity header a page
 * injected WOULD be honored — silently passing a path production rejects. The
 * proxy strips them on the way in, which is the only place that can be true for
 * every route at once.
 */
export const IDENTITY_HEADERS = [
	"x-user-id",
	"x-user-email",
	"x-user-role",
	"x-impersonate-user-id",
	"x-verified-user-id",
	"x-acting-user-id",
	"x-gateway-auth",
	"authorization",
] as const;

export const DOCUMENT_PATH = "/";
export const MUTATION_PREFIX = "/v1/";
export const CACHE_CONTROL = "private, no-store";
export const DOCUMENT_CONTENT_TYPE = "text/html; charset=utf-8";
export const ALLOW_HEADER = "GET, HEAD";
export const NONCE_MARKER = "<!--csp-nonce-->";

export interface HarnessCounters {
	/** Server-side document renders. Read AFTER the case and BEFORE teardown. */
	documentReads: number;
	mutations: number;
	methodRejections: number;
	lastMutationHeaders: Record<string, string>;
}

export interface HarnessRoute {
	id: string;
	path: string;
	ws: boolean;
}

/** The route table shape the development proxy registry declares, as data. */
export const ROUTE_TABLE: HarnessRoute[] = [
	{ id: "document", path: DOCUMENT_PATH, ws: false },
	{ id: "api", path: MUTATION_PREFIX, ws: false },
];

/** Which declared route a request path belongs to, longest prefix first. */
export function classifyProxyTarget(
	pathname: string,
	routes: HarnessRoute[] = ROUTE_TABLE,
): string | undefined {
	return [...routes]
		.sort((left, right) => right.path.length - left.path.length)
		.find((route) => pathname.startsWith(route.path))?.id;
}

/** Whether a response is a document, and therefore rewritable. */
export function isDocumentResponse(response: Response): boolean {
	return (response.headers.get("content-type") ?? "").startsWith("text/html");
}

/**
 * The headers a rewritten body may carry.
 *
 * Framing headers are RECOMPUTED and never copied. The upstream body arrives
 * already decompressed, and this proxy also rewrites documents, so reusing the
 * upstream `Content-Length` and `Content-Encoding` describes a body that no
 * longer exists — which in the reference implementation made every browser
 * fetch die with a content-length mismatch on the very first document.
 */
export function framingHeaders(
	upstream: Headers,
	body: string,
	mode: "recompute" | "copy",
): Headers {
	const headers = new Headers(upstream);
	if (mode === "copy") return headers;
	headers.delete("content-encoding");
	headers.set("content-length", String(new TextEncoder().encode(body).length));
	return headers;
}

/** The request headers the proxy forwards, with the identity set removed. */
export function buildProxyForwardHeaders(incoming: Headers): Headers {
	const headers = new Headers(incoming);
	for (const name of IDENTITY_HEADERS) headers.delete(name);
	// Hop-by-hop headers describe the connection this proxy terminated, not the
	// one it opens.
	for (const name of ["connection", "host", "content-length"])
		headers.delete(name);
	return headers;
}

export interface UpstreamHandle {
	origin: string;
	counters: HarnessCounters;
	stop(): Promise<void>;
}

/**
 * The server-rendered application, reduced to the response matrix the registry
 * declares.
 *
 * It counts server-side document renders, because that counter is what makes
 * "one server render read" a claim a machine can check: the read happened on
 * the server, and the zero-refetch property is the same counter not moving
 * again when the client mutates.
 */
export function startUpstream(): UpstreamHandle {
	const counters: HarnessCounters = {
		documentReads: 0,
		mutations: 0,
		methodRejections: 0,
		lastMutationHeaders: {},
	};
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith(MUTATION_PREFIX)) {
				counters.mutations += 1;
				counters.lastMutationHeaders = Object.fromEntries(
					request.headers.entries(),
				);
				return new Response(JSON.stringify({ accepted: true }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"cache-control": CACHE_CONTROL,
					},
				});
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				counters.methodRejections += 1;
				return new Response(null, {
					status: 405,
					headers: { allow: ALLOW_HEADER, "cache-control": CACHE_CONTROL },
				});
			}
			counters.documentReads += 1;
			const body = `<!doctype html><html><head>${NONCE_MARKER}</head><body><main>rendered on the server</main></body></html>`;
			const headers = {
				"content-type": DOCUMENT_CONTENT_TYPE,
				"cache-control": CACHE_CONTROL,
			};
			// HEAD is answered with GET semantics minus the body, which is why the
			// counter moves for it too: it is the same read.
			return request.method === "HEAD"
				? new Response(null, { status: 200, headers })
				: new Response(body, { status: 200, headers });
		},
	});
	return {
		origin: `http://${LOOPBACK}:${server.port}`,
		counters,
		async stop() {
			await server.stop(true);
		},
	};
}

export interface ProxyHandle {
	origin: string;
	/** Every path the proxy classified, in order, so a case can assert routing. */
	classified: string[];
	stop(): Promise<void>;
}

/**
 * The apex proxy: one origin, the declared route table, and the header policy.
 */
export function startProxy(options: {
	upstreamOrigin: string;
	framing?: "recompute" | "copy";
	routes?: HarnessRoute[];
}): ProxyHandle {
	const framing = options.framing ?? "recompute";
	const routes = options.routes ?? ROUTE_TABLE;
	const classified: string[] = [];
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const route = classifyProxyTarget(url.pathname, routes);
			if (route === undefined)
				return new Response(null, { status: 502, headers: {} });
			classified.push(route);
			const target = new URL(
				`${url.pathname}${url.search}`,
				options.upstreamOrigin,
			);
			const upstream = await fetch(target, {
				method: request.method,
				headers: buildProxyForwardHeaders(request.headers),
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: await request.arrayBuffer(),
				redirect: "manual",
			});
			if (!isDocumentResponse(upstream) || request.method === "HEAD")
				return new Response(request.method === "HEAD" ? null : upstream.body, {
					status: upstream.status,
					headers: new Headers(upstream.headers),
				});
			// The document is rewritten — a nonce is injected — so the framing
			// headers describe a body that no longer exists unless they are
			// recomputed. `copy` exists to make that failure observable.
			const original = await upstream.text();
			const rewritten = original.replace(
				NONCE_MARKER,
				'<meta name="csp-nonce" content="harness">',
			);
			return new Response(rewritten, {
				status: upstream.status,
				headers: framingHeaders(upstream.headers, rewritten, framing),
			});
		},
	});
	return {
		origin: `http://${LOOPBACK}:${server.port}`,
		classified,
		async stop() {
			await server.stop(true);
		},
	};
}

export interface HarnessHandle {
	/** The single browser-visible origin. Ephemeral, and injected never assumed. */
	origin: string;
	counters: HarnessCounters;
	classified: string[];
	upstreamOrigin: string;
}

/**
 * Both servers, torn down together.
 *
 * Every case runs inside `withHarness` so both listeners are stopped in a
 * `finally` whatever the assertion did. A listener leaked out of a failing case
 * is silent when the bind is ephemeral, which is exactly why the bind is
 * ephemeral and the teardown is not optional.
 */
export async function withHarness<T>(
	options: { framing?: "recompute" | "copy" },
	run: (handle: HarnessHandle) => Promise<T>,
): Promise<T> {
	const upstream = startUpstream();
	const proxy = startProxy({
		upstreamOrigin: upstream.origin,
		...(options.framing === undefined ? {} : { framing: options.framing }),
	});
	try {
		return await run({
			origin: proxy.origin,
			counters: upstream.counters,
			classified: proxy.classified,
			upstreamOrigin: upstream.origin,
		});
	} finally {
		await proxy.stop();
		await upstream.stop();
	}
}
