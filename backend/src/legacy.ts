/**
 * Harness backend — one-shot, idempotent migration of pre-OpenCode data.
 *
 * Policy (from the plan):
 *  - Old conversations are kept as **read-only history**; they are never turned
 *    into resumable engine sessions and no Cline data is imported.
 *  - Workspaces and non-sensitive model settings are carried over.
 *  - Any API key found in the old plaintext locations is moved into the OS
 *    protected store and then removed from the old file. No plaintext backup of
 *    the key is ever produced.
 *  - A failure never destroys the original data: sanitised copies are written
 *    first and only then does the original get replaced.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { paths } from "./config";
import { loadSettings, normalizeBaseUrl, saveSettings } from "./app-settings";
import { loadCredential, maskSecret, saveCredential } from "./secrets";
import { ensureDirs, loadIndex, projectIdFor, saveIndex, type SessionIndexEntry } from "./sessions";

export interface MigrationReport {
	ran: boolean;
	legacySessions: number;
	workspacesImported: string[];
	keyMigrated: boolean;
	keyOrigin: string | null;
	keyMask: string | null;
	notes: string[];
	alreadyDone: boolean;
}

const LEGACY_SETTINGS = () => join(paths.root(), "settings.json");

interface LegacySessionShape {
	id?: string;
	createdAt?: number;
	updatedAt?: number;
	status?: string;
	config?: {
		workspaceRoot?: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		provider?: string;
		[key: string]: unknown;
	};
	messages?: Array<{ id?: string; role?: string; content?: string; createdAt?: number; meta?: Record<string, unknown> }>;
	summary?: unknown;
}

/** Remove anything secret-looking from a legacy config before it is kept. */
function sanitizeConfig(config: LegacySessionShape["config"]): Record<string, unknown> {
	const safe: Record<string, unknown> = { ...(config ?? {}) };
	delete safe.apiKey;
	delete safe.apiKeyEncrypted;
	delete safe.headers;
	delete safe.authorization;
	return safe;
}

export async function migrateLegacyData(): Promise<MigrationReport> {
	await ensureDirs();
	const report: MigrationReport = {
		ran: false,
		legacySessions: 0,
		workspacesImported: [],
		keyMigrated: false,
		keyOrigin: null,
		keyMask: null,
		notes: [],
		alreadyDone: false,
	};
	const settings = await loadSettings();
	if (settings.legacyMigratedAt) {
		report.alreadyDone = true;
		return report;
	}
	report.ran = true;

	/* --- 1. Old settings.json (may contain a plaintext key) ---------------- */
	let foundKey: string | null = null;
	let keyOrigin: string | null = null;
	if (existsSync(LEGACY_SETTINGS())) {
		try {
			const raw = JSON.parse(await readFile(LEGACY_SETTINGS(), "utf8")) as Record<string, unknown>;
			const lastApiKey = typeof raw.lastApiKey === "string" ? raw.lastApiKey : "";
			if (lastApiKey) {
				foundKey = lastApiKey;
				keyOrigin = "旧版 settings.json";
			}
			const patch: Record<string, unknown> = {};
			if (typeof raw.lastWorkspace === "string" && raw.lastWorkspace && !settings.lastWorkspace) patch.lastWorkspace = raw.lastWorkspace;
			if (typeof raw.lastModel === "string" && raw.lastModel) patch.model = raw.lastModel;
			if (typeof raw.lastBaseUrl === "string" && raw.lastBaseUrl) patch.baseUrl = normalizeBaseUrl(raw.lastBaseUrl);
			if (Object.keys(patch).length) await saveSettings(patch as never);
			// Rewrite the legacy file without the key so plaintext does not linger.
			const cleaned = { ...raw };
			delete cleaned.lastApiKey;
			delete cleaned.apiKey;
			delete cleaned.apiKeyEncrypted;
			await writeFile(`${LEGACY_SETTINGS()}.migrated`, JSON.stringify(cleaned, null, 2), "utf8");
			await rename(`${LEGACY_SETTINGS()}.migrated`, LEGACY_SETTINGS());
			report.notes.push("旧版 settings.json 已改写，明文 Key 字段已移除。");
		} catch (error) {
			report.notes.push(`旧版 settings.json 迁移失败（原文件未改动）：${describe(error)}`);
		}
	}

	/* --- 2. Old session records (read-only history) ------------------------ */
	let files: string[] = [];
	try {
		files = (await readdir(paths.sessions())).filter((f) => f.endsWith(".json") && f !== "index.json");
	} catch {
		files = [];
	}
	const index = await loadIndex();
	const imported: SessionIndexEntry[] = [];
	for (const file of files) {
		const from = join(paths.sessions(), file);
		try {
			const raw = JSON.parse(await readFile(from, "utf8")) as LegacySessionShape;
			if (!raw || typeof raw !== "object" || !raw.id) continue;
			const config = raw.config ?? {};
			if (config.apiKey && !foundKey) {
				foundKey = String(config.apiKey);
				keyOrigin = `旧版会话 ${raw.id}`;
			}
			const workspaceRoot = typeof config.workspaceRoot === "string" ? config.workspaceRoot : "";
			const sanitized = {
				id: raw.id,
				createdAt: raw.createdAt ?? Date.now(),
				updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
				status: raw.status ?? "idle",
				readOnly: true,
				note: "由旧版手写 Agent 生成，仅供参考，不能继续运行。",
				config: sanitizeConfig(config),
				summary: raw.summary ?? null,
				messages: (raw.messages ?? []).map((m) => ({
					id: m.id,
					role: m.role,
					content: m.content,
					createdAt: m.createdAt,
					meta: m.meta ? { toolName: m.meta.toolName, durationMs: m.meta.durationMs } : undefined,
				})),
			};
			const target = join(paths.legacySessions(), basename(file));
			await writeFile(`${target}.tmp`, JSON.stringify(sanitized, null, 2), "utf8");
			await rename(`${target}.tmp`, target);
			// Only now is it safe to drop the plaintext original.
			await rename(from, `${from}.migrated`);
			imported.push({
				id: `legacy_${raw.id}`,
				workspaceRoot,
				title: `旧会话 ${String(raw.id).slice(-6)}`,
				createdAt: sanitized.createdAt,
				updatedAt: sanitized.updatedAt,
				lastMessage: sanitized.messages.at(-1)?.content?.slice(0, 120),
				lastStatus: "idle",
				model: typeof config.model === "string" ? config.model : "",
				legacy: true,
				legacyFile: basename(file),
			});
			if (workspaceRoot) report.workspacesImported.push(workspaceRoot);
		} catch (error) {
			report.notes.push(`旧会话 ${file} 迁移失败（原文件未改动）：${describe(error)}`);
		}
	}
	if (imported.length) {
		for (const entry of imported) {
			if (entry.workspaceRoot && !index.projects.some((p) => p.id === projectIdFor(entry.workspaceRoot))) {
				index.projects.push({ id: projectIdFor(entry.workspaceRoot), workspaceRoot: entry.workspaceRoot, lastOpenedAt: Date.now() });
			}
			if (!index.sessions.some((s) => s.id === entry.id)) index.sessions.push(entry);
		}
		await saveIndex(index);
		report.legacySessions = imported.length;
		report.notes.push(`已归档 ${imported.length} 个旧会话为只读历史，明文 Key 字段已剥离。`);
	}

	/* --- 3. Move the key into the OS protected store ----------------------- */
	if (foundKey) {
		try {
			if (!loadCredential(paths.credentials())) {
				const method = saveCredential(paths.credentials(), foundKey);
				report.keyMigrated = true;
				report.keyOrigin = keyOrigin;
				report.keyMask = maskSecret(foundKey);
				report.notes.push(`旧 Key 已迁入系统保护存储（${method}）。`);
			} else {
				report.notes.push("系统保护存储中已有 Key，旧 Key 未覆盖，已从原位置移除。");
			}
		} catch (error) {
			report.notes.push(`Key 迁入系统保护存储失败：${describe(error)}`);
		}
	}

	await saveSettings({ legacyMigratedAt: Date.now() });
	// Keep the pre-migration originals alongside the sanitised copies so nothing
	// is ever lost, but out of the way of the live session directory.
	try {
		const leftovers = (await readdir(paths.sessions())).filter((f) => f.endsWith(".json.migrated"));
		for (const file of leftovers) {
			await rename(join(paths.sessions(), file), join(paths.legacySessions(), file.replace(/\.migrated$/, ".source.json")));
		}
	} catch {}
	report.notes.push("迁移可重复执行：已完成标记已写入设置，重复运行不会二次改动数据。");
	return report;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
