/**
 * Harness backend — non-secret application settings.
 *
 * Strictly no credentials here. The API key lives in the DPAPI-protected
 * credential store (`secrets.ts`) and is never written to this file, to a
 * session record, to a log line or to an error message.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { maskSecret } from "./secrets";
import {
	DEFAULT_BASE_URLS,
	DEFAULT_MODELS,
	DEFAULT_PROVIDER_PROTOCOL,
	type ProviderProtocol,
	paths,
} from "./config";

export interface AppSettings {
	version: 1;
	/** Which wire protocol the user picked. Chat Completions is the default. */
	protocol: ProviderProtocol;
	baseUrl: string;
	/** Explicit model id supplied by the user; we never force a remote list. */
	model: string;
	/** Named API configurations. The original single API becomes `default`. */
	profiles: ApiProfile[];
	defaultProfileId: string;
	/** Last workspace used, so the new-session dialog can prefill it. */
	lastWorkspace: string;
	/** Permission posture. "ask" keeps the approval flow on. */
	autoApproveEdits: boolean;
	autoApproveCommands: boolean;
	/** UI preference, mirrored to the backend so it survives a reinstall. */
	theme: "dark" | "light";
	/** Set once legacy data has been migrated, so migration stays idempotent. */
	legacyMigratedAt?: number;
}

export interface ApiProfile {
	id: string;
	name: string;
	protocol: ProviderProtocol;
	baseUrl: string;
	models: string[];
}

export function newProfileId(): string {
	return `api_${randomBytes(6).toString("hex")}`;
}

export function validProfileId(id: string): boolean {
	return id === "default" || /^api_[a-f0-9]{12}$/.test(id);
}

export function normalizeModels(value: unknown): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
	return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
}

function normalizeProfiles(settings: AppSettings): AppSettings {
	const profiles = (Array.isArray(settings.profiles) ? settings.profiles : [])
		.filter((item) => item && validProfileId(String(item.id ?? "")))
		.map((item) => ({
			id: item.id,
			name: String(item.name || item.id).trim().slice(0, 80),
			protocol: item.protocol === "anthropic" ? "anthropic" as const : "openai-compatible" as const,
			baseUrl: normalizeBaseUrl(String(item.baseUrl || "")),
			models: normalizeModels(item.models),
		}))
		.filter((item) => item.baseUrl && item.models.length);
	if (!profiles.length) profiles.push({ id: "default", name: "默认 API", protocol: settings.protocol, baseUrl: normalizeBaseUrl(settings.baseUrl), models: [settings.model] });
	settings.profiles = profiles;
	if (!profiles.some((item) => item.id === settings.defaultProfileId)) settings.defaultProfileId = profiles[0].id;
	const primary = profiles.find((item) => item.id === settings.defaultProfileId)!;
	settings.protocol = primary.protocol;
	settings.baseUrl = primary.baseUrl;
	settings.model = primary.models[0];
	return settings;
}

export function defaultSettings(): AppSettings {
	return {
		version: 1,
		protocol: DEFAULT_PROVIDER_PROTOCOL,
		baseUrl: DEFAULT_BASE_URLS[DEFAULT_PROVIDER_PROTOCOL],
		model: DEFAULT_MODELS[DEFAULT_PROVIDER_PROTOCOL],
		profiles: [{ id: "default", name: "默认 API", protocol: DEFAULT_PROVIDER_PROTOCOL, baseUrl: DEFAULT_BASE_URLS[DEFAULT_PROVIDER_PROTOCOL], models: [DEFAULT_MODELS[DEFAULT_PROVIDER_PROTOCOL]] }],
		defaultProfileId: "default",
		lastWorkspace: "",
		autoApproveEdits: false,
		autoApproveCommands: false,
		theme: "dark",
	};
}

let cached: AppSettings | null = null;

export async function loadSettings(): Promise<AppSettings> {
	if (cached) return cached;
	try {
		const raw = await readFile(paths.settings(), "utf8");
		const parsed = JSON.parse(raw) as Partial<AppSettings>;
		cached = normalizeProfiles({ ...defaultSettings(), ...parsed, profiles: parsed.profiles ?? [], version: 1 });
	} catch {
		cached = defaultSettings();
	}
	return cached;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
	const current = await loadSettings();
	if (!patch.profiles && (patch.protocol !== undefined || patch.baseUrl !== undefined || patch.model !== undefined)) {
		const primary = current.profiles.find((item) => item.id === current.defaultProfileId) ?? current.profiles[0];
		patch = {
			...patch,
			profiles: current.profiles.map((item) => item.id === primary.id ? {
				...item,
				protocol: patch.protocol ?? item.protocol,
				baseUrl: patch.baseUrl ?? item.baseUrl,
				models: patch.model ? [patch.model, ...item.models.filter((model) => model !== patch.model)] : item.models,
			} : item),
		};
	}
	const merged: AppSettings = normalizeProfiles({ ...current, ...patch, version: 1 });
	await mkdir(dirname(paths.settings()), { recursive: true });
	const tmp = `${paths.settings()}.tmp`;
	await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
	await rename(tmp, paths.settings());
	cached = merged;
	return merged;
}

/**
 * Trim the meaningless trailing slash(es) but never touch a user-supplied path
 * prefix: `https://host/v1` stays `https://host/v1`, `https://host/v1/` becomes
 * `https://host/v1`.
 */
export function normalizeBaseUrl(value: string): string {
	const trimmed = (value || "").trim();
	if (!trimmed) return trimmed;
	return trimmed.replace(/\/+$/, "");
}

export function maskSettings(settings: AppSettings, hasApiKey: boolean, apiKeyMask: string | null, profileKeys: Record<string, string> = {}) {
	const { protocol, baseUrl, model, profiles, defaultProfileId, lastWorkspace, autoApproveEdits, autoApproveCommands, theme, legacyMigratedAt } = settings;
	return {
		protocol,
		baseUrl,
		model,
		profiles: profiles.map((profile) => ({ ...profile, hasApiKey: !!profileKeys[profile.id] || (profile.id === defaultProfileId && hasApiKey), apiKeyMask: profileKeys[profile.id] ? maskSecret(profileKeys[profile.id]) : profile.id === defaultProfileId ? apiKeyMask : null })),
		defaultProfileId,
		lastWorkspace,
		autoApproveEdits,
		autoApproveCommands,
		theme,
		legacyMigratedAt,
		hasApiKey,
		apiKeyMask,
		/** Never the key itself. */
		apiKey: "",
	};
}
