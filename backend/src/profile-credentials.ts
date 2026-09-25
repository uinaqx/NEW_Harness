/** Per-provider credential files; every value is wrapped by the existing DPAPI store. */
import { join } from "node:path";
import { paths } from "./config";
import type { AppSettings } from "./app-settings";
import { validProfileId } from "./app-settings";
import { clearCredential, loadCredential, saveCredential } from "./secrets";

export function credentialPath(profileId: string): string {
	if (!validProfileId(profileId)) throw new Error("无效的 API 配置 ID");
	return profileId === "default" ? paths.credentials() : join(paths.root(), "credentials", `${profileId}.bin`);
}

export function loadProfileKey(profileId: string): string {
	return loadCredential(credentialPath(profileId)) ?? "";
}

export function saveProfileKey(profileId: string, apiKey: string): void {
	saveCredential(credentialPath(profileId), apiKey);
}

export function clearProfileKey(profileId: string): void {
	clearCredential(credentialPath(profileId));
}

export function loadProfileKeys(settings: AppSettings): Record<string, string> {
	return Object.fromEntries(settings.profiles.map((profile) => [profile.id, loadProfileKey(profile.id)]));
}
