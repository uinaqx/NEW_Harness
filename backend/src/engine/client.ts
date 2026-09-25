/**
 * Harness backend — the single place where OpenCode SDK calls happen.
 *
 * Every call goes through `call()` so that timeouts, the workspace directory
 * and error classification are handled identically everywhere. The frontend
 * never sees raw engine types or messages.
 */
import { createOpencodeClient, type OpencodeClient } from "../../../vendor/opencode/sdk/dist/client.js";
import { ENGINE_CALL_TIMEOUT_MS, LOOPBACK } from "../config";
import { classifyEngineError, engineError } from "./errors";
import { PROVIDER_ID } from "./provider";

export type { OpencodeClient };

export interface ClientOptions {
	url: string;
	directory: string;
	username: string;
	password: string;
}

export function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

const clients = new Map<string, OpencodeClient>();

export function engineClient({ url, directory, username, password }: ClientOptions): OpencodeClient {
	const key = `${url}|${directory}`;
	const cached = clients.get(key);
	if (cached) return cached;
	const client = createOpencodeClient({
		baseUrl: url,
		headers: { authorization: basicAuth(username, password) },
	});
	clients.set(key, client);
	return client;
}

export function forgetClients(): void {
	clients.clear();
}

/** Wrap a promise with a deadline; the engine never gets to hang us forever. */
export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms}ms`)), ms);
	try {
		return await work(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

interface SdkResult<T> {
	data?: T;
	error?: unknown;
	response?: Response;
}

/**
 * Unwrap a hey-api result tuple into `data`, converting any failure into a
 * classified engine error. `throwOnError` is deliberately left off so the whole
 * error body is available for classification.
 */
export async function call<T>(
	label: string,
	invoke: (signal: AbortSignal) => Promise<SdkResult<T>>,
	options: { timeoutMs?: number } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? ENGINE_CALL_TIMEOUT_MS;
	try {
		const result = await withTimeout((signal) => invoke(signal), timeoutMs, label);
		if (result && typeof result === "object") {
			const status = result.response?.status ?? 0;
			if (status >= 400 || result.error) {
				const detail =
					typeof result.error === "string"
						? result.error
						: JSON.stringify(result.error ?? `HTTP ${status}`).slice(0, 900);
				throw new Error(`[${label}] HTTP ${status}: ${detail}`);
			}
			return result.data as T;
		}
		return result as unknown as T;
	} catch (error) {
		const failure = classifyEngineError(error);
		if (failure.kind === "unknown" || failure.kind === "aborted") {
			const wrapped = engineError(error);
			wrapped.message = `[${label}] ${wrapped.message}`;
			throw wrapped;
		}
		throw engineError(error);
	}
}

/** Build the standard `query` object so the workspace is always explicit. */
export function dirQuery(directory: string): { directory: string } {
	return { directory };
}

export function healthCheckUrl(url: string): string {
	return new URL(`${url}/path`).toString();
}

/** Confirm the thing listening on the port really is our engine instance. */
export async function verifyInstanceIdentity(
	url: string,
	directory: string,
	username: string,
	password: string,
): Promise<{ ok: boolean; detail: string }> {
	try {
		const client = engineClient({ url, directory, username, password });
		const data = await call(
			"identity",
			(signal) => client.path.get({ query: dirQuery(directory), signal }) as Promise<SdkResult<Record<string, unknown>>>,
			{ timeoutMs: 8000 },
		);
		const reported = String((data as Record<string, unknown>)?.directory ?? "").replace(/\\/g, "/").toLowerCase();
		const expected = directory.replace(/\\/g, "/").toLowerCase();
		if (reported !== expected) {
			return { ok: false, detail: `引擎上报的工作目录 ${reported} 与期望 ${expected} 不一致` };
		}
		return { ok: true, detail: `instance verified on ${url} (host=${LOOPBACK})` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export { PROVIDER_ID };
