/**
 * Harness webview — minimal WebSocket transport client.
 *
 * The backend binds an OS-assigned port on every launch, so the endpoint is not
 * hard-coded: the Tauri shell injects `window.__HARNESS__` with the port and the
 * one-time token after it has verified the backend's health + instance identity.
 * In headless dev mode the client fetches the token from the dev-only endpoint.
 */
import type {
	DesktopTransportRequest,
	DesktopTransportResponse,
	DesktopTransportEvent,
	DesktopTransportState,
} from "@/lib/desktop-transport";

const REQUEST_TIMEOUT_MS = 120_000;
const RECONNECT_BASE_DELAY_MS = 400;
const RECONNECT_MAX_DELAY_MS = 4_000;
/** Where the backend lives in headless dev mode (overridable for tests). */
const DEV_BACKEND = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
	? window.location.origin
	: "http://127.0.0.1:3126";

interface InjectedEndpoint {
	port?: number;
	host?: string;
	token?: string;
	path?: string;
	instanceId?: string;
}

function injected(): InjectedEndpoint | null {
	if (typeof window === "undefined") return null;
	const value = (window as unknown as Record<string, unknown>).__HARNESS__;
	return value && typeof value === "object" ? (value as InjectedEndpoint) : null;
}

/** Reports why the endpoint could not be resolved, for the error panel. */
export type EndpointFailure = { kind: "unavailable"; detail: string } | null;

class DesktopClient {
	private socket: WebSocket | null = null;
	private connectPromise: Promise<void> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private requestCounter = 0;
	private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId?: ReturnType<typeof setTimeout> }>();
	private handlers = new Map<string, Set<(payload: unknown) => void>>();
	private transportStateHandlers = new Set<(state: DesktopTransportState) => void>();
	private transportState: DesktopTransportState = "connecting";
	private hasConnectedOnce = false;
	private resolved: { url: string } | null = null;
	private failure: EndpointFailure = null;

	constructor() {
		if (typeof window !== "undefined") window.addEventListener("harness-endpoint-changed", () => {
			this.resolved = null;
			this.socket?.close();
			this.scheduleReconnect();
		});
	}

	getTransportState(): DesktopTransportState {
		return this.transportState;
	}

	getFailure(): EndpointFailure {
		return this.failure;
	}

	private setState(next: DesktopTransportState) {
		this.transportState = next;
		for (const handler of this.transportStateHandlers) handler(next);
	}

	subscribeTransportState(handler: (state: DesktopTransportState) => void): () => void {
		this.transportStateHandlers.add(handler);
		handler(this.transportState);
		void this.ensureConnected(true).catch(() => {});
		return () => this.transportStateHandlers.delete(handler);
	}

	/** Resolve the websocket URL: injected endpoint first, dev handshake second. */
	private async resolveUrl(): Promise<string> {
		if (this.resolved) return this.resolved.url;
		const endpoint = injected();
		if (endpoint?.port && endpoint.token) {
			const host = endpoint.host ?? "127.0.0.1";
			const path = endpoint.path ?? "/transport";
			this.resolved = { url: `ws://${host}:${endpoint.port}${path}?token=${encodeURIComponent(endpoint.token)}` };
			return this.resolved.url;
		}
		// Headless dev: the backend advertises its token on a dev-only endpoint.
		try {
			const response = await fetch(`${DEV_BACKEND}/transport-token`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { token?: string; port?: number };
			if (!body.token || !body.port) throw new Error("dev handshake missing token");
			this.resolved = { url: `ws://127.0.0.1:${body.port}/transport?token=${encodeURIComponent(body.token)}` };
			this.failure = null;
			return this.resolved.url;
		} catch (error) {
			this.failure = {
				kind: "unavailable",
				detail:
					`无法获取后端地址。桌面版应由外壳注入启动握手；开发模式需要后端以 HARNESS_DEV=1 运行在 ${DEV_BACKEND}。` +
					`（${error instanceof Error ? error.message : String(error)}）`,
			};
			throw new Error(this.failure.detail);
		}
	}

	private scheduleReconnect() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		const attempt = Math.max(this.pending.size, 1);
		const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 4), RECONNECT_MAX_DELAY_MS);
		this.reconnectTimer = setTimeout(() => {
			void this.ensureConnected(true).catch(() => {});
		}, delay);
	}

	private handleMessage(raw: string) {
		let parsed: DesktopTransportResponse | DesktopTransportEvent;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (parsed.type === "event") {
			const handlers = this.handlers.get(parsed.event.name);
			if (handlers) for (const handler of handlers) handler(parsed.event.payload);
			return;
		}
		const response = parsed as DesktopTransportResponse;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		if (pending.timeoutId) clearTimeout(pending.timeoutId);
		this.pending.delete(response.id);
		if (!response.ok) {
			pending.reject(new Error(response.error || "命令执行失败"));
			return;
		}
		pending.resolve(response.result);
	}

	private async ensureConnected(isReconnect = false): Promise<void> {
		if (this.connectPromise) return this.connectPromise;
		if (this.socket?.readyState === WebSocket.OPEN) return;
		this.setState(this.hasConnectedOnce || isReconnect ? "reconnecting" : "connecting");
		this.connectPromise = (async () => {
			const endpoint = await this.resolveUrl();
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(endpoint);
				this.socket = socket;
				socket.onopen = () => {
					this.hasConnectedOnce = true;
					this.failure = null;
					this.setState("connected");
					resolve();
				};
				socket.onmessage = (event) => this.handleMessage(String(event.data));
				socket.onclose = () => {
					if (this.socket === socket) this.socket = null;
					if (this.transportState !== "connected") {
						reject(new Error("后端连接不可用"));
						return;
					}
					this.setState("reconnecting");
					for (const id of [...this.pending.keys()]) {
						const pending = this.pending.get(id);
						if (!pending) continue;
						if (pending.timeoutId) clearTimeout(pending.timeoutId);
						this.pending.delete(id);
						pending.reject(new Error("连接已断开，当前任务未自动重发"));
					}
					this.scheduleReconnect();
				};
			});
		})()
			.catch((error) => {
				if (!this.hasConnectedOnce) this.setState("unavailable");
				this.scheduleReconnect();
				throw error;
			})
			.finally(() => {
				this.connectPromise = null;
			});
		return this.connectPromise;
	}

	async invoke<T>(command: string, args?: Record<string, unknown>, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
		await this.ensureConnected();
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error(this.failure?.detail ?? "后端连接不可用");
		}
		const id = `desktop_${Date.now()}_${this.requestCounter++}`;
		const request: DesktopTransportRequest = { type: "command", id, command, args };
		return new Promise<T>((resolve, reject) => {
			const timeoutId =
				timeoutMs === null
					? undefined
					: setTimeout(() => {
							const pending = this.pending.get(id);
							if (!pending) return;
							this.pending.delete(id);
							pending.reject(new Error(`命令超时：${command}`));
						}, timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeoutId });
			try {
				socket.send(JSON.stringify(request));
			} catch (error) {
				if (timeoutId) clearTimeout(timeoutId);
				this.pending.delete(id);
				throw error;
			}
		});
	}

	subscribe(eventName: string, handler: (payload: unknown) => void): () => void {
		void this.ensureConnected(true).catch(() => {});
		const set = this.handlers.get(eventName) ?? new Set();
		set.add(handler);
		this.handlers.set(eventName, set);
		return () => {
			const existing = this.handlers.get(eventName);
			if (!existing) return;
			existing.delete(handler);
			if (existing.size === 0) this.handlers.delete(eventName);
		};
	}
}

export const desktopClient = new DesktopClient();
