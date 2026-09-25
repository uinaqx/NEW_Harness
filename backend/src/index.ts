/**
 * Harness backend — entry point.
 *
 * Boot order matters:
 *   1. data dirs, legacy migration (idempotent)
 *   2. settings + DPAPI credential
 *   3. HTTP/WS server on an OS-assigned port, then publish the handshake file
 *      (the shell waits for it, so it must appear only once the port is live)
 *   4. start the OpenCode engine (non-blocking; a failure surfaces in the UI
 *      instead of preventing the window from opening)
 */
import { APP_VERSION, IS_DEV, paths } from "./config";
import { ensureDirs } from "./sessions";
import { loadSettings } from "./app-settings";
import { loadCredential } from "./secrets";
import { loadProfileKeys } from "./profile-credentials";
import { migrateLegacyData } from "./legacy";
import { startServer } from "./server";
import { bindEngine, broadcastEvent } from "./transport";
import { HarnessEngine } from "./engine";
import { newInstanceId, clearHandshake, writeHandshake } from "./runtime";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { applySystemProxy } from "./network-proxy";

function logLine(text: string): void {
	const line = `${new Date().toISOString()} ${text}\n`;
	process.stdout.write(line);
	try {
		mkdirSync(paths.logs(), { recursive: true });
		appendFileSync(paths.backendLog(), line, "utf8");
	} catch {}
}

async function main() {
	applySystemProxy();
	await ensureDirs();
	const migration = await migrateLegacyData();
	const settings = await loadSettings();
	const apiKey = loadCredential(paths.credentials()) ?? "";

	const profileKeys = loadProfileKeys(settings);
	const engine = new HarnessEngine(settings, apiKey, profileKeys);
	bindEngine(engine);

	const server = startServer();
	const handshake = writeHandshake({
		port: server.port,
		host: "127.0.0.1",
		instanceId: newInstanceId(),
	});

	logLine(`harness backend v${APP_VERSION} ready`);
	logLine(`  ws        : ws://127.0.0.1:${server.port}/transport (token required)`);
	logLine(`  http      : http://127.0.0.1:${server.port}`);
	logLine(`  data dir  : ${paths.root()}`);
	logLine(`  instance  : ${handshake.instanceId}`);
	logLine(`  credential: ${apiKey ? "present (protected store)" : "not configured"}`);
	logLine(`  migration : ${migration.alreadyDone ? "already done" : `ran (${migration.legacySessions} legacy sessions)`}`);
	logLine(`  dev mode  : ${IS_DEV}`);
	logLine(`  home      : ${homedir()}`);

	// Start the engine in the background: a startup failure must render an error
	// card in the UI, not block the window. Without a credential there is nothing
	// to start, so we wait for the user (the UI starts it lazily on first use).
	if (!Object.values(profileKeys).some(Boolean) && !apiKey) {
		logLine("  engine    : not started (no API key configured yet)");
	} else {
		void engine
			.ensureStarted()
			.then((status) => {
				logLine(`  engine    : running at ${status.url} (pid ${status.pid})`);
				broadcastEvent("engine_state", status);
			})
			.catch((error: unknown) => {
				logLine(`  engine    : FAILED — ${error instanceof Error ? error.message : String(error)}`);
				broadcastEvent("engine_state", { ...engine.status(), lastError: error instanceof Error ? error.message : String(error) });
			});
	}

	const shutdown = async (signal: string) => {
		logLine(`received ${signal}; stopping engine and exiting`);
		try {
			await engine.stop(true);
		} catch {}
		clearHandshake();
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("uncaughtException", (error) => {
		logLine(`uncaught exception: ${error.stack ?? error.message}`);
	});
	process.on("unhandledRejection", (reason) => {
		logLine(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	});
}

main().catch((error) => {
	logLine(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exit(1);
});
