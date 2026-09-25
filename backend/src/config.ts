/**
 * Harness backend — runtime configuration: paths, defaults, app identity.
 *
 * Everything the app writes lives under a single data directory so that
 * uninstall / diagnostics are straightforward:
 *
 *   %LOCALAPPDATA%\Harness\data\
 *     app-settings.json     non-secret settings (protocol, base URL, model, ...)
 *     credentials.bin       DPAPI-protected provider API key (never plaintext)
 *     runtime.json          startup handshake: port, token, instance id
 *     sessions\             harness session index + read-only legacy history
 *     opencode\             isolated XDG dirs for the bundled engine
 *     logs\                 redacted engine + backend logs
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "Harness";
export const APP_VERSION = "0.5.0";
/** Bumped whenever the on-disk layout changes. */
export const DATA_LAYOUT_VERSION = 2;

/** Only loopback. The engine and the backend must never listen publicly. */
export const LOOPBACK = "127.0.0.1";

export function appDataRoot(): string {
	// Tests and portable runs may redirect the whole data directory.
	const override = process.env.HARNESS_DATA_DIR;
	if (override && override.trim()) return override.trim();
	const local =
		process.env.LOCALAPPDATA ||
		process.env.XDG_DATA_HOME ||
		join(homedir(), ".local", "share");
	return join(local, APP_NAME, "data");
}

export const paths = {
	root: () => appDataRoot(),
	settings: () => join(appDataRoot(), "app-settings.json"),
	credentials: () => join(appDataRoot(), "credentials.bin"),
	runtime: () => join(appDataRoot(), "runtime.json"),
	sessions: () => join(appDataRoot(), "sessions"),
	/** Harness-owned session index (maps harness session <-> engine session). */
	index: () => join(appDataRoot(), "sessions", "index.json"),
	/** Read-only history written by the previous hand-written agent. */
	legacySessions: () => join(appDataRoot(), "sessions", "legacy"),
	chatWorkspace: () => join(appDataRoot(), "chat-workspace"),
	opencode: () => join(appDataRoot(), "opencode"),
	opencodeConfig: () => join(appDataRoot(), "opencode", "config"),
	opencodeData: () => join(appDataRoot(), "opencode", "data"),
	opencodeState: () => join(appDataRoot(), "opencode", "state"),
	opencodeCache: () => join(appDataRoot(), "opencode", "cache"),
	logs: () => join(appDataRoot(), "logs"),
	engineLog: () => join(appDataRoot(), "logs", "engine.log"),
	backendLog: () => join(appDataRoot(), "logs", "backend.log"),
	binaryStamp: () => join(appDataRoot(), "opencode", "binary.verified.json"),
};

/**
 * Dev mode relaxes the WebSocket origin check so a plain Vite dev server and
 * the headless `dev:web` workflow keep working. It never disables auth.
 */
export const IS_DEV = process.env.HARNESS_DEV === "1";

/** Extra origins allowed in dev mode (the bundled UI uses tauri:// or http://tauri.localhost). */
export const DEV_ORIGINS = ["http://127.0.0.1:3125", "http://localhost:3125"];

export const DEFAULT_PROVIDER_PROTOCOL = "openai-compatible" as const;
export type ProviderProtocol = "openai-compatible" | "anthropic";

export const DEFAULT_BASE_URLS: Record<ProviderProtocol, string> = {
	"openai-compatible": "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com",
};

export const DEFAULT_MODELS: Record<ProviderProtocol, string> = {
	"openai-compatible": "gpt-4.1",
	anthropic: "claude-sonnet-4-5",
};

/** How long a single engine call may take before we surface a timeout. */
export const ENGINE_CALL_TIMEOUT_MS = 30_000;
/** Prompt calls stay open for the whole turn, but not forever. */
export const ENGINE_PROMPT_TIMEOUT_MS = 30 * 60_000;
/** Startup handshake budget. */
export const ENGINE_START_TIMEOUT_MS = 60_000;
