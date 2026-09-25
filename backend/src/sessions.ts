/**
 * Harness backend — the Harness-owned session index.
 *
 * The engine owns conversations, messages and tool records. Harness only keeps
 * the minimum needed for navigation: which workspace a session belongs to, its
 * last known title and a short preview. There is deliberately no second message
 * database and no history synchronisation between the two.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { paths } from "./config";

export interface ProjectEntry {
	id: string;
	workspaceRoot: string;
	lastOpenedAt: number;
	name?: string;
}

export interface SessionIndexEntry {
	/** The engine session id — Harness does not mint its own for engine sessions. */
	id: string;
	workspaceRoot: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	lastMessage?: string;
	lastStatus: string;
	model: string;
	profileId?: string;
	kind?: "work" | "chat";
	mode?: "act" | "plan";
	goal?: string;
	/** User title wins over the engine's generated title. */
	customTitle?: string;
	pinned?: boolean;
	/** Legacy sessions are read-only history produced by the previous agent loop. */
	legacy?: boolean;
	legacyFile?: string;
}

export interface SessionIndex {
	version: 2;
	projects: ProjectEntry[];
	sessions: SessionIndexEntry[];
}

const EMPTY: SessionIndex = { version: 2, projects: [], sessions: [] };

let cache: SessionIndex | null = null;

export function newId(prefix = "id"): string {
	return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export async function ensureDirs(): Promise<void> {
	await mkdir(paths.sessions(), { recursive: true });
	await mkdir(paths.chatWorkspace(), { recursive: true });
	await mkdir(paths.legacySessions(), { recursive: true });
	await mkdir(paths.logs(), { recursive: true });
	await mkdir(paths.opencode(), { recursive: true });
}

export function projectIdFor(workspaceRoot: string): string {
	// Stable, readable id derived from the path (not a hash of file contents).
	const normalized = workspaceRoot.replace(/[\\/]+$/, "").toLowerCase();
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
	}
	return `proj_${(hash >>> 0).toString(36)}`;
}

export async function loadIndex(): Promise<SessionIndex> {
	if (cache) return cache;
	try {
		const raw = await readFile(paths.index(), "utf8");
		const parsed = JSON.parse(raw) as SessionIndex;
		cache = {
			version: 2,
			projects: Array.isArray(parsed.projects) ? parsed.projects : [],
			sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
		};
	} catch {
		cache = { ...EMPTY, projects: [], sessions: [] };
	}
	return cache;
}

/**
 * Serialises index writes.
 *
 * Two callers may update the index at the same time (e.g. a session title
 * arriving while a tool run patches the same session). With a shared temp name
 * they race: the first `rename` moves the file away, the second then renames a
 * path that no longer exists and throws ENOENT — losing whichever write lost
 * the race. A promise chain turns them into successive writes.
 */
let writeQueue: Promise<void> = Promise.resolve();

async function writeSnapshot(next: SessionIndex): Promise<void> {
	await mkdir(dirname(paths.index()), { recursive: true });
	const tmp = `${paths.index()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
		await rename(tmp, paths.index());
	} catch (error) {
		// Never leave a stray temp file behind after a failed write.
		await unlink(tmp).catch(() => {});
		throw error;
	}
}

export async function saveIndex(next: SessionIndex): Promise<void> {
	cache = next;
	writeQueue = writeQueue.then(() => writeSnapshot(next)).catch((error) => {
		console.warn(`[sessions] failed to write the session index: ${error instanceof Error ? error.message : String(error)}`);
	});
	await writeQueue;
}

export async function upsertProject(workspaceRoot: string): Promise<ProjectEntry> {
	const index = await loadIndex();
	const id = projectIdFor(workspaceRoot);
	const existing = index.projects.find((p) => p.id === id);
	if (existing) {
		existing.lastOpenedAt = Date.now();
		existing.workspaceRoot = workspaceRoot;
		await saveIndex(index);
		return existing;
	}
	const entry: ProjectEntry = { id, workspaceRoot, lastOpenedAt: Date.now() };
	index.projects.push(entry);
	await saveIndex(index);
	return entry;
}

export async function listProjects(): Promise<ProjectEntry[]> {
	const index = await loadIndex();
	// Older indexes may contain sessions without a project record.
	let changed = false;
	for (const session of index.sessions) {
		if (!session.workspaceRoot || session.kind === "chat") continue;
		const id = projectIdFor(session.workspaceRoot);
		if (!index.projects.some((project) => project.id === id)) {
			index.projects.push({ id, workspaceRoot: session.workspaceRoot, lastOpenedAt: session.updatedAt });
			changed = true;
		}
	}
	if (changed) await saveIndex(index);
	return [...index.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function renameProject(id: string, name: string): Promise<ProjectEntry | undefined> {
	const index = await loadIndex();
	const project = index.projects.find((item) => item.id === id);
	if (!project) return undefined;
	project.name = name;
	await saveIndex(index);
	return project;
}

export async function upsertSession(entry: SessionIndexEntry): Promise<void> {
	const index = await loadIndex();
	const at = index.sessions.findIndex((s) => s.id === entry.id);
	if (at >= 0) index.sessions[at] = { ...index.sessions[at], ...entry };
	else index.sessions.push(entry);
	await saveIndex(index);
}

export async function patchSession(id: string, patch: Partial<SessionIndexEntry>): Promise<SessionIndexEntry | undefined> {
	const index = await loadIndex();
	const entry = index.sessions.find((s) => s.id === id);
	if (!entry) return undefined;
	Object.assign(entry, patch);
	await saveIndex(index);
	return entry;
}

export async function removeSession(id: string): Promise<boolean> {
	const index = await loadIndex();
	const before = index.sessions.length;
	index.sessions = index.sessions.filter((s) => s.id !== id);
	if (index.sessions.length === before) return false;
	await saveIndex(index);
	return true;
}

export async function getSession(id: string): Promise<SessionIndexEntry | undefined> {
	const index = await loadIndex();
	return index.sessions.find((s) => s.id === id);
}

export async function listSessions(): Promise<SessionIndexEntry[]> {
	const index = await loadIndex();
	return [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function indexFileExists(): boolean {
	return existsSync(paths.index());
}
