/**
 * Harness backend — HTTP + WebSocket server (Bun.serve, zero runtime deps).
 *
 *  - listens on 127.0.0.1 only, on an OS-assigned port (never a fixed one)
 *  - `/health` reports version *and* instance identity so the shell can prove it
 *    is talking to the process it started rather than something squatting the port
 *  - `/transport` requires the per-launch token and an allowed Origin
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { APP_VERSION, DEV_ORIGINS, IS_DEV, LOOPBACK } from "./config";
import { currentHandshake } from "./runtime";
import { handleMessage, registerClient, unregisterClient } from "./transport";

function resolveDistDir(): string {
	const fromEnv = process.env.HARNESS_WEB_DIST;
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	const exeAdjacent = join(dirname(process.execPath), "dist");
	if (existsSync(exeAdjacent)) return exeAdjacent;
	// Dev layout: backend/src -> harness/webview/dist
	return join(import.meta.dir, "..", "..", "webview", "dist");
}
const DIST_DIR = resolveDistDir();

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

/** Origins the webview may present. Tauri v2 uses tauri://localhost on Windows. */
const ALLOWED_ORIGINS = new Set([
	"tauri://localhost",
	"https://tauri.localhost",
	"http://tauri.localhost",
	`http://${LOOPBACK}`,
	`http://localhost`,
]);

export function originAllowed(origin: string | null): boolean {
	if (!origin) {
		// Non-browser clients (the Tauri shell's probes, the automated tests) send
		// no Origin header. They already had to present the per-launch token.
		return true;
	}
	if (ALLOWED_ORIGINS.has(origin)) return true;
	if (IS_DEV && DEV_ORIGINS.includes(origin)) return true;
	if (IS_DEV) {
		try {
			const source = new URL(origin);
			if (source.protocol === "http:" && source.hostname === LOOPBACK && Number(source.port) === currentHandshake()?.port) return true;
		} catch {}
	}
	// Any other http(s) page loaded in a browser must not reach the transport.
	return false;
}

function serveFile(file: string): Response {
	const type = MIME[extname(file)] || "application/octet-stream";
	return new Response(Bun.file(file), { headers: { "content-type": type, "cache-control": "no-store" } });
}

function tryStatic(urlPath: string): Response | null {
	if (!existsSync(DIST_DIR)) return null;
	const rel = urlPath === "/" ? "/index.html" : urlPath;
	const file = join(DIST_DIR, rel);
	if (!file.startsWith(DIST_DIR)) return null;
	if (!existsSync(file)) {
		const index = join(DIST_DIR, "index.html");
		return existsSync(index) ? serveFile(index) : null;
	}
	return serveFile(file);
}

export interface ServerHandle {
	port: number;
	stop: () => void;
}

export function startServer(): ServerHandle {
	const instanceId = currentHandshake()?.instanceId ?? "";
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: 0,
		development: false,
		async fetch(req, bunServer) {
			const url = new URL(req.url);

			// Identity + version probe. Deliberately unauthenticated but reveals
			// nothing sensitive; the shell compares both fields before trusting it.
			if (url.pathname === "/health") {
				const handshake = currentHandshake();
				return Response.json({
					ok: true,
					app: "harness-backend",
					appVersion: APP_VERSION,
					instanceId: handshake?.instanceId ?? instanceId,
					pid: process.pid,
					port: bunServer.port,
					webviewBundled: existsSync(DIST_DIR),
				});
			}

			// Dev-only convenience: the headless dev webview (a separate dev server
			// on another origin) cannot read runtime.json, so it may fetch the
			// launch token here. Never available in a production build.
			if (url.pathname === "/transport-token") {
				if (!IS_DEV) return new Response("Not found", { status: 404 });
				const handshake = currentHandshake();
				if (!handshake) return new Response("Not ready", { status: 503 });
				return Response.json({ token: handshake.token, port: bunServer.port });
			}

			if (url.pathname === "/transport") {
				if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
					return new Response("Expected websocket", { status: 426 });
				}
				const handshake = currentHandshake();
				const token = url.searchParams.get("token") ?? "";
				if (!handshake || token !== handshake.token) {
					return new Response("Unauthorized", { status: 401 });
				}
				if (!originAllowed(req.headers.get("origin"))) {
					return new Response("Forbidden origin", { status: 403 });
				}
				if (bunServer.upgrade(req)) return undefined;
				return new Response("WebSocket upgrade failed", { status: 426 });
			}

			const staticRes = tryStatic(url.pathname);
			if (staticRes) return staticRes;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			async message(ws, message) {
				const raw = typeof message === "string" ? message : new TextDecoder().decode(message as Uint8Array);
				const response = await handleMessage(raw);
				if (response) ws.send(JSON.stringify(response));
			},
			open(ws) {
				registerClient(ws as never);
			},
			close(ws) {
				unregisterClient(ws as never);
			},
		},
	});

	return {
		port: server.port ?? 0,
		stop: () => server.stop(true),
	};
}
