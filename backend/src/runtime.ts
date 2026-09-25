/**
 * Harness backend — startup handshake.
 *
 * The backend binds an OS-assigned port, so nothing may hard-code it. Instead it
 * writes `runtime.json` (pid, port, one-time token, instance id) into the data
 * directory; the Tauri shell reads that file, waits for the health probe to
 * confirm version + instance identity, and hands the endpoint to the webview.
 *
 * The same token authenticates the WebSocket upgrade, so a random local process
 * cannot attach to the transport just because it can reach the port.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { APP_VERSION, paths } from "./config";

export interface RuntimeHandshake {
	pid: number;
	port: number;
	host: string;
	/** WebSocket path for the webview transport. */
	path: string;
	/** One-time token minted per launch. */
	token: string;
	instanceId: string;
	appVersion: string;
	startedAt: number;
}

let current: RuntimeHandshake | null = null;

export function newInstanceId(): string {
	return `harness_${randomBytes(8).toString("hex")}`;
}

export function writeHandshake(input: Omit<RuntimeHandshake, "pid" | "appVersion" | "startedAt" | "token" | "path"> & { token?: string }): RuntimeHandshake {
	const handshake: RuntimeHandshake = {
		pid: process.pid,
		port: input.port,
		host: input.host,
		path: "/transport",
		token: input.token ?? randomBytes(24).toString("base64url"),
		instanceId: input.instanceId,
		appVersion: APP_VERSION,
		startedAt: Date.now(),
	};
	const file = paths.runtime();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(handshake, null, 2), "utf8");
	current = handshake;
	return handshake;
}

export function readHandshake(): RuntimeHandshake | null {
	try {
		return JSON.parse(readFileSync(paths.runtime(), "utf8")) as RuntimeHandshake;
	} catch {
		return null;
	}
}

export function clearHandshake(): void {
	try {
		if (existsSync(paths.runtime())) unlinkSync(paths.runtime());
	} catch {}
	current = null;
}

export function currentHandshake(): RuntimeHandshake | null {
	return current;
}

/**
 * Stale handshake files from a crashed instance would make the shell connect to
 * a dead port. Detect them by checking the recorded pid is still alive.
 */
export function isHandshakeLive(handshake: RuntimeHandshake | null): boolean {
	if (!handshake?.pid) return false;
	try {
		process.kill(handshake.pid, 0);
		return true;
	} catch {
		return false;
	}
}
