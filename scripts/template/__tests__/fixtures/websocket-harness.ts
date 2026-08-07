import type { ProxyRoute } from "../../proxy-contract";

/**
 * An executed WebSocket and HMR harness, built out of `Bun.serve` primitives
 * and never out of `node:http`.
 *
 * The reference implementation measured why. Under Bun's `node:http`
 * compatibility layer a proxied upgrade fires the upgrade event and then never
 * flushes a byte back to the real client connection: identical handshakes that
 * answer 101 under Node dead-air under Bun, so its own browser harness is
 * bundled for Node and launched under Node. This repository is Bun-only, so the
 * harness uses the native upgrade path — `server.upgrade()` plus a real
 * `WebSocket` to the upstream — which was verified end to end before a line of
 * the suite was written.
 *
 * Four properties are designed in rather than added later:
 *
 *  - **Every listener binds `127.0.0.1:0` and its port is injected.** A harness
 *    that assumed a port would pass on a laptop and collide in a worktree, and
 *    the reference has exactly that defect: its own harness ports bypass its
 *    offset registry, so two worktrees fight over them.
 *  - **Every wait is bounded.** The failure mode this whole file exists for is a
 *    HANG, not an error, so an unbounded `await` would turn a regression into a
 *    suite that never finishes rather than a suite that fails.
 *  - **Every counter is read immediately after the case and before teardown.**
 *    "The proxy saw nothing" and "the proxy was already gone" produce the same
 *    empty array.
 *  - **Every socket pair is destroyed in both directions.** A close on one side
 *    does not destroy its peer, so a matrix of cases would otherwise accumulate
 *    half-open pairs — and with `:0` binding, a leaked listener is silent.
 */

/** A bounded wait, so a hang presents as a failed assertion and not as a hang. */
export function deadline<T>(
	promise: Promise<T>,
	milliseconds: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timed out waiting for ${label}`)),
			milliseconds,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

export const WAIT = 4000;

/**
 * The port a `:0` bind was actually given, asserted rather than assumed.
 *
 * Every listener here binds an ephemeral port and injects it, so the one thing
 * that must never be silently absent is the number itself.
 */
function boundPort(server: { port?: number | undefined }): number {
	const port = server.port;
	if (port === undefined || port === 0)
		throw new Error("a harness listener did not report the port it was given");
	return port;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export interface UpstreamCounts {
	requests: string[];
	upgrades: string[];
	frames: string[];
	openSockets: number;
}

export interface Listener {
	port: number;
	stop: () => void;
}

export interface Upstream extends Listener {
	counts: () => UpstreamCounts;
}

/**
 * The service behind the proxy: a canned body on the HTTP path and an echo on
 * the socket.
 */
export function startUpstream(): Upstream {
	const requests: string[] = [];
	const upgrades: string[] = [];
	const frames: string[] = [];
	let openSockets = 0;
	const server = Bun.serve<{ id: number }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, target) {
			const url = new URL(request.url);
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				upgrades.push(url.pathname);
				if (target.upgrade(request, { data: { id: upgrades.length } }))
					return undefined;
				return new Response("upstream refused the upgrade", { status: 400 });
			}
			requests.push(url.pathname);
			return new Response(`upstream:${url.pathname}`, { status: 200 });
		},
		websocket: {
			open() {
				openSockets += 1;
			},
			message(socket, message) {
				frames.push(String(message));
				socket.send(`echo:${String(message)}`);
			},
			close() {
				openSockets -= 1;
			},
		},
	});
	return {
		port: boundPort(server),
		counts: () => ({
			requests: [...requests],
			upgrades: [...upgrades],
			frames: [...frames],
			openSockets,
		}),
		stop: () => server.stop(true),
	};
}

/**
 * Hop-by-hop headers, and the one that must be restored.
 *
 * `Connection` is hop-by-hop, so any forwarder that strips it correctly breaks
 * every upgrade while leaving the HTTP path perfectly green — the reference
 * restores it explicitly for exactly this reason, in a comment that says so. A
 * forwarder that keeps `Upgrade` and drops `Connection` is the shape that looks
 * right in review and cannot complete a handshake.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export function buildProxyForwardHeaders(
	source: Headers,
	options: { restoreConnection?: boolean } = {},
): Headers {
	const headers = new Headers();
	for (const [name, value] of source.entries()) {
		if (HOP_BY_HOP.has(name.toLowerCase())) continue;
		headers.set(name, value);
	}
	const upgrade = source.get("upgrade");
	if (upgrade === null) return headers;
	headers.set("upgrade", upgrade);
	// The restore is optional ONLY so the suite can execute the naive stripper
	// and watch the handshake die. Nothing ships with it off.
	if (options.restoreConnection !== false) headers.set("connection", "Upgrade");
	return headers;
}

export interface ProxyCounts {
	requests: string[];
	upgrades: string[];
	refusedUpgrades: string[];
	refusedHosts: string[];
	openPairs: number;
}

export interface Proxy extends Listener {
	counts: () => ProxyCounts;
}

export interface ProxyOptions {
	/** The RENDERED route table, parsed back out of the generated config. */
	routes: ProxyRoute[];
	/** The upstream's injected port; the declared target's port is never used. */
	upstreamPort: number;
	/** The host allowlist this server enforces on every upgrade. */
	allowedHosts?: string[];
	/** Off only so the suite can execute the naive hop-by-hop stripper. */
	restoreConnection?: boolean;
}

interface PairData {
	upstream: WebSocket | null;
	queue: string[];
	closed: boolean;
}

function hostAllowed(host: string, allowed: string[]): boolean {
	const name = host.split(":")[0] ?? "";
	return allowed.some((entry) =>
		entry.startsWith(".")
			? name.endsWith(entry) || name === entry.slice(1)
			: name === entry,
	);
}

function routeFor(
	routes: ProxyRoute[],
	pathname: string,
): ProxyRoute | undefined {
	return routes.find((route) => pathname.startsWith(route.path));
}

/**
 * The development server, driven by the rendered route table.
 *
 * A route whose `ws` is true calls `server.upgrade()`; a route whose `ws` is
 * false or absent never does, so the client's `new WebSocket()` simply fails.
 * That is the missing-`ws` mutation EXECUTED rather than asserted about.
 */
export function startProxy(options: ProxyOptions): Proxy {
	const requests: string[] = [];
	const upgrades: string[] = [];
	const refusedUpgrades: string[] = [];
	const refusedHosts: string[] = [];
	const pairs = new Set<PairData>();
	const allowed = options.allowedHosts;
	const server = Bun.serve<PairData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, target) {
			const url = new URL(request.url);
			const route = routeFor(options.routes, url.pathname);
			const wantsUpgrade =
				request.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (wantsUpgrade) {
				// The host check comes first and it is not a convenience: a WebSocket
				// handshake is not subject to CORS, so a cross-site page can open an
				// authenticated socket unless the server checks the host itself.
				if (
					allowed &&
					!hostAllowed(request.headers.get("host") ?? "", allowed)
				) {
					refusedHosts.push(request.headers.get("host") ?? "");
					return new Response("host not allowed", { status: 403 });
				}
				if (!route || route.ws !== true) {
					refusedUpgrades.push(url.pathname);
					return new Response("this route does not forward the upgrade", {
						status: 400,
					});
				}
				upgrades.push(url.pathname);
				const data: PairData = { upstream: null, queue: [], closed: false };
				if (target.upgrade(request, { data })) return undefined;
				return new Response("upgrade refused", { status: 400 });
			}
			requests.push(url.pathname);
			if (!route) return new Response("no route", { status: 404 });
			return await fetch(
				`http://127.0.0.1:${options.upstreamPort}${url.pathname}${url.search}`,
				{
					method: request.method,
					headers: buildProxyForwardHeaders(request.headers, {
						restoreConnection: options.restoreConnection !== false,
					}),
				},
			);
		},
		websocket: {
			open(socket) {
				pairs.add(socket.data);
				const upstream = new WebSocket(
					`ws://127.0.0.1:${options.upstreamPort}/socket`,
				);
				socket.data.upstream = upstream;
				upstream.addEventListener("open", () => {
					for (const pending of socket.data.queue.splice(0))
						upstream.send(pending);
				});
				upstream.addEventListener("message", (event) => {
					socket.send(String(event.data));
				});
				upstream.addEventListener("close", () => {
					if (!socket.data.closed) socket.close();
				});
			},
			message(socket, message) {
				const upstream = socket.data.upstream;
				const text = String(message);
				if (upstream && upstream.readyState === WebSocket.OPEN)
					upstream.send(text);
				else socket.data.queue.push(text);
			},
			close(socket) {
				// Both directions, always. A close on one side does not destroy its
				// peer, so a matrix of cases would otherwise accumulate half-open
				// pairs — and with `:0` binding a leak is silent.
				socket.data.closed = true;
				try {
					socket.data.upstream?.close();
				} finally {
					pairs.delete(socket.data);
				}
			},
		},
	});
	return {
		port: boundPort(server),
		counts: () => ({
			requests: [...requests],
			upgrades: [...upgrades],
			refusedUpgrades: [...refusedUpgrades],
			refusedHosts: [...refusedHosts],
			openPairs: pairs.size,
		}),
		stop: () => {
			for (const pair of pairs) pair.upstream?.close();
			pairs.clear();
			server.stop(true);
		},
	};
}

export interface PortMap extends Listener {
	counts: () => { forwarded: string[] };
}

/**
 * The published boundary: one port that crosses it, forwarding to an internal
 * port the browser never sees.
 *
 * This is what makes the HMR cases executable rather than argued. The map
 * rewrites `Host` to a value the internal server's allowlist accepts, so a
 * client that dials the internal port DIRECTLY — which is exactly what a pinned
 * client port makes it do — presents a host the server refuses.
 */
export function startPortMap(options: {
	targetPort: number;
	hostHeader: string;
}): PortMap {
	const forwarded: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			forwarded.push(url.pathname);
			const headers = new Headers(request.headers);
			headers.set("host", options.hostHeader);
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				// The upgrade crosses the boundary as a real client socket, so the
				// rewritten host is the one the internal server checks.
				return await proxyUpgrade(
					`ws://127.0.0.1:${options.targetPort}${url.pathname}`,
					options.hostHeader,
				);
			}
			return await fetch(
				`http://127.0.0.1:${options.targetPort}${url.pathname}${url.search}`,
				{ method: request.method, headers },
			);
		},
	});
	return {
		port: boundPort(server),
		counts: () => ({ forwarded: [...forwarded] }),
		stop: () => server.stop(true),
	};
}

async function proxyUpgrade(url: string, host: string): Promise<Response> {
	// A bounded probe, then a redirect-free relay is unnecessary: the map exists
	// to prove reachability, so answering 101-or-not is the whole signal.
	const opened = deferred<boolean>();
	const socket = new WebSocket(url, { headers: { host } });
	socket.addEventListener("open", () => opened.resolve(true));
	socket.addEventListener("error", () => opened.resolve(false));
	socket.addEventListener("close", () => opened.resolve(false));
	const reachable = await deadline(opened.promise, WAIT, "boundary upgrade");
	socket.close();
	return new Response(reachable ? "reachable" : "unreachable", {
		status: reachable ? 101 : 502,
	});
}

export interface HandshakeResult {
	opened: boolean;
	echoed: string | undefined;
	readyState: number;
	failure: string | undefined;
}

/**
 * One real client handshake, bounded, with both outcomes reported rather than
 * thrown.
 *
 * The caller asserts on the result, which is what lets one function serve both
 * the case that must open and the case that must not.
 */
export async function handshake(
	url: string,
	options: { frame?: string; headers?: Record<string, string> } = {},
): Promise<HandshakeResult> {
	const settled = deferred<HandshakeResult>();
	const socket = options.headers
		? new WebSocket(url, { headers: options.headers })
		: new WebSocket(url);
	let opened = false;
	socket.addEventListener("open", () => {
		opened = true;
		socket.send(options.frame ?? "ping");
	});
	socket.addEventListener("message", (event) => {
		settled.resolve({
			opened: true,
			echoed: String(event.data),
			readyState: socket.readyState,
			failure: undefined,
		});
	});
	socket.addEventListener("error", () => {
		settled.resolve({
			opened,
			echoed: undefined,
			readyState: socket.readyState,
			failure: "error",
		});
	});
	socket.addEventListener("close", (event) => {
		settled.resolve({
			opened,
			echoed: undefined,
			readyState: socket.readyState,
			failure: `close ${event.code}`,
		});
	});
	try {
		return await deadline(settled.promise, WAIT, `handshake to ${url}`);
	} finally {
		socket.close();
	}
}
